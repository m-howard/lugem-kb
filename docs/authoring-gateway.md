---
title: The authoring gateway
sidebar_position: 6
owner: platform
last_reviewed: 2026-08-09
---

# The authoring gateway

The gateway is how someone without a git host account publishes documentation. It holds one GitHub
App credential, confines what that credential can do, and records the human on every change.

This page is what you configure, what it refuses, and how to check it.

:::note

The gateway is **off unless you configure it**. With `CMS_REPOSITORY` unset the editorial routes are
never mounted, and the service behaves exactly as it did before — site, `/v1/documents`,
`/v1/search` and `/v1/ask` unchanged.

:::

## What it does

| Route                                  | Purpose                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/cms/config`                   | Repository, default branch, branch prefix, permitted extensions.             |
| `GET /v1/cms/identity`                 | Who the gateway thinks you are. Answered from your token, never from GitHub. |
| `GET /v1/cms/documents?branch=`        | Documents on a branch. Defaults to the default branch.                       |
| `GET /v1/cms/documents/{path}?branch=` | One document, with the blob sha.                                             |
| `PUT /v1/cms/drafts/{branch}`          | Save a draft. Creates or moves the branch; **does not** open a pull request. |
| `DELETE /v1/cms/drafts/{branch}`       | Discard a draft.                                                             |
| `POST /v1/cms/submissions`             | Open a pull request against the default branch.                              |
| `GET /v1/cms/submissions[/{number}]`   | Where a submission got to.                                                   |
| `POST /v1/cms/submissions/{n}/merge`   | Refused unless `POLICY_ALLOW_MERGE_FROM_CMS` is set.                         |

Saving and submitting are separate on purpose. A draft written over three days should not sit in a
reviewer's queue the whole time.

## Prerequisites

1. **A GitHub App**, created and installed on the corpus repository, with the private key written
   into Secrets Manager. That is four steps and Pulumi cannot do the first — see
   [The corpus repository](./corpus-repository.md#the-cms-github-app).
2. **An identity provider**, registered as described below.

## Configure it

```bash
cd infra/pulumi
pulumi config set cmsAuthMode bearer
pulumi config set cmsAuthIssuerUrl https://login.microsoftonline.com/<tenant>/v2.0
pulumi config set cmsAuthAudience api://lugem-cms
pulumi up
```

| Key                               | Required     | Notes                                                                                 |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `cmsGitHubAppId`                  | yes          | Enables everything below. See [the corpus repository](./corpus-repository.md).        |
| `cmsGitHubAppInstallationId`      | yes          | Must be set with the app id.                                                          |
| `cmsAuthMode`                     | yes          | `bearer` or `alb`. No default — the gateway will not guess how to identify an author. |
| `cmsAuthIssuerUrl`                | for `bearer` | OIDC issuer. Its discovery document names the key set.                                |
| `cmsAuthAudience`                 | for `bearer` | The audience tokens must carry.                                                       |
| `cmsAuthEmailClaim`               | no           | Default `email`. See the warning below.                                               |
| `cmsAuthNameClaim`                | no           | Default `name`. Falls back to the email when absent.                                  |
| `cmsOidcIssuer` and four siblings | for `alb`    | The endpoints the load balancer needs. All five, or none.                             |
| `cmsOidcClientSecret`             | for `alb`    | Set with `--secret`. Never written to a config file in plaintext.                     |
| `cmsBranchPrefix`                 | no           | Default `cms/`. The only branches the CMS may touch.                                  |
| `cmsPathPrefixes`                 | no           | Default `["docs/"]`. The only paths it may write.                                     |
| `cmsAllowMerge`                   | no           | Default `false`. See [merging](#merging), and requirements R16.                       |

:::warning Confirm the email claim against a real token

Several identity providers omit `email` from the access token by default, or release it under
another name — Entra commonly uses `upn`. The gateway refuses any request it cannot attribute to a
person, because R6 writes the author into git history for the life of the repository. A provider
that withholds the claim produces `401 {"reason":"missing-email"}` for every author, which looks
like a broken gateway and is a provider setting.

Decode a real token before you roll this out, and set `cmsAuthEmailClaim` to whatever it actually
carries.

:::

### Choosing an auth mode

**`bearer`** — the editor holds an OIDC access token and sends it as `Authorization: Bearer`. The
gateway verifies it against the issuer's key set. Nothing else in the deployment changes, it works
locally, and a script can hold a token. Start here.

**`alb`** — the load balancer runs `authenticate-oidc`, and the gateway verifies the JWT it signs.
This needs `certificateArn` set, because ALB authentication is an HTTPS listener action; the preview
fails if it is not. The action is attached as a rule matching `/v1/cms/*` only, so readers never
meet a login page.

In this mode, **`GET /v1/cms/identity` is where you sign in**. It is the one path whose rule
redirects to the identity provider: an ALB session cookie is only ever issued by a rule that
authenticates, so without a redirecting path a browser with no cookie would have no way to get one.
Send an author there first; they come back with a cookie and a JSON answer saying who the gateway
thinks they are, and every later `/v1/cms/*` call carries it.

Every other editorial path is set to `allow`, which sounds wrong and is not. The alternative,
`deny`, returns 401 only for a request carrying _no_ authentication — AWS
[redirects an **expired** session to the identity provider](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
instead. An editor whose session lapsed mid-draft would get a 302 into an HTML login page and their
client would try to parse it as JSON. With `allow`, the request reaches the gateway without
authentication information and the gateway answers `401` with a reason — reliably, in JSON, for
both the absent and the expired case. The load balancer rule was only ever defence in depth; the
verifier is the authority.

Both are described in [ADR 0013](./adr/0013-two-authentication-modes.md), including what carrying
both costs.

## What it refuses

Every refusal below happens **before any call to GitHub**, so a rejected change never partially
applies.

| Attempt                                                                                | Answer                             |
| -------------------------------------------------------------------------------------- | ---------------------------------- |
| No token, an expired token, or one for another audience                                | `401` with a distinct `reason`     |
| A verified token carrying no email claim                                               | `401 missing-email`                |
| Writing `.github/workflows/ci.yml`, `README.md`, or anything outside `cmsPathPrefixes` | `403`                              |
| Writing a `.sh`, `.yml` or any non-markdown file, even inside `docs/`                  | `403 extension`                    |
| A path containing `..`, a null byte, a backslash or an empty segment                   | `403`                              |
| A change set where **any** entry is bad                                                | `403`, and nothing is written      |
| Creating, updating or deleting the default branch                                      | `403 default-branch`               |
| Any branch outside `cmsBranchPrefix`                                                   | `403 outside-prefix`               |
| Branch protection, collaborators, webhooks, deploy keys, workflow dispatch             | not an editorial route             |
| An unknown `/v1/...` path                                                              | `404` JSON — never the site's HTML |

The last row matters more than it looks. The documentation site is a catch-all route, so without an
explicit terminator an unknown API path would answer **200 with HTML**, and a client would see a
success it cannot parse.

### Merging

By default the gateway refuses `POST /v1/cms/submissions/{n}/merge`. Approval happens in the git
host, where branch protection can require a code-owner review and no principal — including the CMS
App — can bypass it.

`POLICY_ALLOW_MERGE_FROM_CMS` (stack key `cmsAllowMerge`) exists so that
[requirements R16](./requirements.md) — approval moving into the CMS — is a configuration change
plus a UI rather than a rewrite. Turning it on makes the gateway security-critical: branch
protection stops being the enforcement point. Do not set it until reviewers genuinely cannot hold
git host accounts.

## Verify a deployment

```bash
bun run scripts/check/verify-gateway.ts \
  --base-url https://docs.internal \
  --token "$ACCESS_TOKEN" \
  --wait-ready 300
```

The script drives every acceptance criterion above against a running gateway and prints a pass/fail
table. It writes to a throwaway branch under the CMS prefix and deletes it afterwards; it never
touches the default branch, because if it could, the gateway would already have failed.

`--wait-ready` polls `/readyz` first and exits non-zero if it never reports ready. Useful in a
deploy script, and the fastest way to tell a credential problem apart from a slow rollout — though
the editorial target group now enforces the same thing without you remembering to run it.

Run the whole script before any human uses the gateway. That is the phase's stated exit condition,
not a suggestion.

## Run it locally

Local development can read the App key from a file instead of Secrets Manager:

```bash
CMS_REPOSITORY=acme/handbook \
GITHUB_APP_ID=123456 \
GITHUB_APP_INSTALLATION_ID=78901234 \
CMS_APP_PRIVATE_KEY_PATH=./cms-app.private-key.pem \
AUTH_MODE=bearer \
AUTH_ISSUER_URL=https://idp.example.com/realm \
AUTH_AUDIENCE=lugem-cms \
bun run dev
```

Setting both `CMS_APP_SECRET_ARN` and `CMS_APP_PRIVATE_KEY_PATH` is a start-up error: two key
sources means nobody can tell which one is in use. Keep the PEM out of the repository —
`.gitignore` does not know about your filename.

## Troubleshooting

**Start-up exits with code 78 naming a variable.** That is [ADR 0009](./adr/0009-fail-closed-configuration.md)
working. Setting `CMS_REPOSITORY` makes the whole CMS block required; the message lists every
variable that is missing, not just the first.

**`/readyz` returns `cms-credential-unusable` while `/healthz` stays green.** No installation token
can be minted. Almost always the private key has not been written yet — the stack creates the secret
empty on purpose. Run the `put-secret-value` step in
[the corpus repository](./corpus-repository.md#the-cms-github-app).

Two things keep an unusable credential from reaching authors, and they do different jobs.

**The gateway refuses the request.** Every `/v1/cms/*` call passes a readiness guard that answers
`503 {"error":"not_ready"}` when no installation token can be obtained. This is what turns traffic
away, and it is in the application because that is where the behaviour can be guaranteed.

**The editorial target group fails the deploy.** There are two target groups: the public one probes
`/healthz` and carries the site and the read APIs; the editorial one probes `/readyz` and carries
`/v1/cms/*`. ECS waits for health in every attached group, so a rollout with an unwritten App key
never stabilises and the circuit breaker rolls it back.

The target group is deliberately _not_ what refuses the request. An ALB
[fails open](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html):
when every target in a group is unhealthy it routes to them anyway — and that is precisely the
state a missing credential produces. The public group keeps `/healthz` so a git host outage cannot
drain the documentation site out from under readers.

**Every author gets `401 missing-email`.** The identity provider is not releasing the claim. See the
warning above.

**`403 outside-prefixes` on a path that looks right.** The prefix is a directory boundary, so
`docs-internal/` does not match `docs/`. Check `cmsPathPrefixes` for a stray comma too — a blank
entry is rejected at preview precisely because it would otherwise match every path in the
repository.

**`409` on save.** The git host refused the ref update, usually because the draft branch moved under
you. Re-read the branch and save again.

**`502` on any route.** The git host answered a 5xx. The gateway does not pass that through as its
own 500, so this one is safe to retry.

**Preview fails naming `cmsAuthMode` and `certificateArn` together.** ALB authentication needs an
HTTPS listener. Either set a certificate, or use `bearer`.

## Related

- [ADR 0013 — two authentication modes](./adr/0013-two-authentication-modes.md)
- [ADR 0014 — a purpose-built editorial API](./adr/0014-purpose-built-editorial-api.md)
- [The corpus repository](./corpus-repository.md) — the branch rules the gateway relies on
- [Requirements](./requirements.md) — R1–R6, R9 and R10 are what this page implements
