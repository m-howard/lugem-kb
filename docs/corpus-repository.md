---
title: The corpus repository
sidebar_position: 5
owner: platform
last_reviewed: 2026-08-09
---

# The corpus repository

The knowledge base is backed by a git repository. Merging to its default branch is what publishes a
page, and that makes the repository's own configuration part of the infrastructure: who may push to
it, what must pass before a merge, and what credentials the pipeline holds.

Pulumi configures all of it. This page is what you set, and the two things Pulumi cannot do for you.

## What Pulumi manages

| Component          | What it creates                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `CorpusRepository` | Branch ruleset, repository settings, issue labels, Dependabot security updates, Actions permissions. |
| `PublishPipeline`  | GitHub OIDC provider, the publish IAM role, the `publish` environment, and six Actions variables.    |
| `CmsCredential`    | The Secrets Manager secret for the CMS GitHub App key, and the App's installation on the repository. |

Everything is opt-in. With `corpusRepository` unset the stack manages no GitHub resources at all.

## Configure it

```bash
cd infra/pulumi
pulumi config set corpusRepository m-howard/lugem-kb
```

| Key                           | Required | Notes                                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `corpusRepository`            | no       | `owner/name`. The master switch — unset means no GitHub resources.                               |
| `corpusRepositoryDescription` | no       | Set this when adopting. GitHub clears a description the resource does not declare.               |
| `corpusDefaultBranch`         | no       | Default `main`. A branch name, not a ref.                                                        |
| `corpusRepositoryCreate`      | no       | Default `false`. Creates a new private repository and seeds `CODEOWNERS`.                        |
| `corpusRepositoryImportId`    | no       | Adopt an existing repository. Set for one `pulumi up`, then unset. Conflicts with the key above. |
| `requiredStatusChecks`        | no       | Defaults to `Lint`, `Typecheck`, `Test`, `Build`, `Playwright`. An empty list requires none.     |
| `githubOidcProviderArn`       | no       | Reuse an account-level GitHub identity provider instead of creating one.                         |
| `cmsGitHubAppId`              | no       | Numeric app id. Must be set together with the installation id.                                   |
| `cmsGitHubAppInstallationId`  | no       | Numeric installation id.                                                                         |

### The GitHub token

The provider needs administration rights on the corpus repository and nothing beyond it. In practice
that is a fine-grained personal access token scoped to that one repository, with **Administration**,
**Contents**, **Environments**, **Secrets** and **Variables** all set to read and write. A classic
token works too, but `repo` plus `admin:repo_hook` grants far more than this needs.

```bash
export GITHUB_TOKEN=github_pat_...      # or: pulumi config set --secret github:token ...
```

CI needs it too, once `corpusRepository` is set: `pulumi preview` has to read the repository's
current rules to diff them. Add it as a repository secret named `GH_ADMIN_TOKEN` —
`.github/workflows/infra.yml` maps it onto `GITHUB_TOKEN`, because GitHub refuses secrets whose name
starts with `GITHUB_`.

### Adopting a repository that already exists

`corpusRepository` on its own configures the rules and leaves the repository's own settings alone.
To bring the settings under Pulumi as well, adopt it once:

```bash
pulumi config set corpusRepositoryDescription "$(gh repo view --json description -q .description)"
pulumi config set corpusRepositoryImportId lugem-kb
pulumi up
pulumi config rm corpusRepositoryImportId
```

Read the preview before accepting it. Pulumi will show the repository's real settings against the
ones this stack declares — squash merges only, no merge commits, branches deleted after merge — and
that diff is the thing to check, because applying it changes the repository.

## What the rules enforce

The ruleset on the default branch is [requirements.md](./requirements.md) R8 expressed as code:
code-owner review, one approval, stale reviews dismissed on push, conversations resolved, linear
history, no force pushes and no deletion.

The field that matters most is `bypassActors: []`. No principal is exempt — not an administrator,
and pointedly not the CMS GitHub App, which is what "direct pushes to the default branch are blocked
for all principals including the app" actually requires. An administrator who needs to push directly
has to change infrastructure code and have it reviewed. That is the intent.

**R4 and R5 are not enforced here.** Branch confinement (`cms/*` only) and endpoint allowlisting are
the gateway's job — see [The authoring gateway](./authoring-gateway.md). GitHub rulesets cannot
express "this app may create refs only under `cms/`", and one that pretended to would be worse than
none.

## The publish pipeline

`PublishPipeline` creates an IAM role GitHub Actions assumes by OIDC. Its trust policy names one
repository and one environment:

```text
repo:<owner>/<name>:environment:publish
```

Environment-scoped rather than ref-scoped, so a workflow that skips the deployment gate cannot
assume the role at all, whatever branch it runs on. The `publish` environment itself only accepts
protected branches, which is R21 — only default-branch content is ever indexed.

The role's policy is exactly what `scripts/docs/sync-corpus.ts` calls: list and write under one
prefix of one bucket, and start and poll ingestion on one knowledge base. No wildcards.

Pulumi then publishes six repository variables — `AWS_PUBLISH_ROLE_ARN`, `AWS_REGION`,
`CORPUS_BUCKET`, `CORPUS_PREFIX`, `KNOWLEDGE_BASE_ID` and `DATA_SOURCE_ID` — straight from stack
outputs. `.github/workflows/publish.yml` reads them and runs the sync on every merge touching
`docs/`. Rebuilding the stack repoints the pipeline automatically; there is nothing to copy.

## The preview pipeline

`PreviewSite` is the same shape, for pull requests instead of merges. It creates a private,
disposable bucket and a second OIDC role whose trust subject is:

```text
repo:<owner>/<name>:pull_request
```

Not the `environment:` form the publish role uses — a deployment environment can be restricted to
protected branches, and a pull request head is not one. The confinement lives in the policy
instead: this role may write under `pr-*` in one bucket, and nowhere else. A fork cannot assume it
at all, because a fork's `pull_request` token carries the fork's own subject.

`.github/workflows/preview.yml` builds the site with `DOCUSAURUS_BASE_URL=/previews/pr-<n>/`, syncs
it to `s3://<bucket>/pr-<n>/`, and comments the link. `.github/workflows/preview-cleanup.yml`
deletes the prefix and rewrites the comment on `closed` — merged or abandoned, both. A 30-day
lifecycle rule catches the pull request nobody ever closes.

**Two workflows, not one, and only the first filters on `paths`.** A `paths` filter applies to
every event its trigger names. Were deletion in the same workflow, a pull request that published a
preview and then reverted its last documentation change would stop matching, never fire its
`closed` event, and leave the drafts in the bucket until the lifecycle rule expired them. Deleting
has to happen for every closed pull request, whatever the final diff touches.

**A separate bucket from the corpus, deliberately.** R21 says preview builds are never ingested,
and a bucket the knowledge base has never been pointed at cannot be. See
[ADR 0018](./adr/0018-previews-behind-the-gateway.md).

**The gateway serves previews sandboxed.** Every response under `/previews` carries
`Content-Security-Policy: sandbox allow-scripts allow-popups`. A pull request's pages are unreviewed
MDX — code, not just prose — and the sandbox is what keeps them from running on the origin that
holds `/admin` and the reader's session. The visible cost is that a preview cannot call the
gateway's API, so the **Ask** page does not answer inside one. ADR 0018 has the reasoning and the
caveat for ALB authentication mode.

## Content quality gates

`bun run docs:check` validates the corpus before it can merge: frontmatter carries `title`, `owner`
and a real `last_reviewed` date; every page matches a `CODEOWNERS` entry; every relative markdown
link and `#anchor` resolves. It runs as its own CI job on every pull request.

The failure is written for the person who caused it. The check emits `::error` annotations pinned to
the line in the diff, and posts a table as a comment on the pull request — which is where an author
working in the CMS at `/admin` will actually see it, having never opened an Actions log.
[ADR 0019](./adr/0019-content-quality-gates.md) records why this exists alongside the Docusaurus
build, which already throws on a broken link.

Run it locally before pushing:

```bash
bun run docs:check
```

## The CMS GitHub App

Pulumi cannot create a GitHub App. Create it once by hand, then hand Pulumi its ids.

1. **Create the App** under the account or organisation that owns the corpus repository. Repository
   permissions: **Contents: read and write**, **Pull requests: read and write**, **Metadata: read**.
   Nothing else — [requirements.md](./requirements.md) R5 refuses repository administration through
   the gateway, and an App that cannot administer is a stronger guarantee than one that is asked not
   to.
2. **Install it** on the corpus repository and note the installation id from the installation URL.
3. **Configure both ids**, which must be set together:

   ```bash
   pulumi config set cmsGitHubAppId 123456
   pulumi config set cmsGitHubAppInstallationId 78901234
   pulumi up
   ```

4. **Write the private key.** The stack creates the secret empty on purpose — the PEM never passes
   through Pulumi configuration, a state file, or a CI log.

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "$(pulumi -C infra/pulumi stack output cmsAppSecretArn)" \
     --secret-string "file://cms-app.private-key.pem"
   ```

Until step 4 the gateway's readiness probe fails with `cms-credential-unusable`, because no
installation token can be minted. Liveness stays green throughout, so the task is not killed and
restarted into the same problem. The task role can read that one secret and nothing else.

Authors get `503 {"error":"not_ready"}` from the gateway itself while that is true, and a deploy in
that state never stabilises, so ECS rolls it back. Readers are unaffected throughout — see
[The authoring gateway](./authoring-gateway.md#verify-a-deployment).

Both ids reach the container, along with the repository and the branch and path prefixes, so the
gateway can mint a token and confine what it does with one. Choosing how authors authenticate is the
remaining step — see **[The authoring gateway](./authoring-gateway.md)**.

## Troubleshooting

**`preview` fails with a GitHub 401 or 404.** The token is missing or too narrow. A fine-grained
token that lacks **Administration** returns 404 rather than 403 for rulesets, which reads like the
repository does not exist.

**`preview` wants to clear the repository description.** `corpusRepositoryDescription` is unset.
Set it to the current description rather than letting the apply empty it.

**Required checks leave pull requests pending forever.** Something in `requiredStatusChecks` names a
job that does not run on every pull request. The three `Infrastructure` checks are `paths`-filtered,
so they never report on a documentation-only change; that is why they are not in the default list.

**The publish workflow skips with a notice.** `AWS_PUBLISH_ROLE_ARN` or `CORPUS_BUCKET` is empty,
which means `pulumi up` has not run with `corpusRepository` set. The skip is deliberate — a fork has
no way to fix it.

**`AssumeRoleWithWebIdentity` is denied.** The job is missing `environment: publish`, or its
`id-token: write` permission. The trust policy matches the subject exactly, so both are required.

**A preview URL answers 500 rather than "no preview for pull request N".** The bucket refused the
gateway's read — a task role, bucket policy or encryption grant that does not match the bucket, not
a build that has not finished. The gateway's log names the bucket and the key. The two are
distinguishable only because the task role holds `s3:ListBucket` on the preview bucket: without it
S3 answers `AccessDenied` for a key that is simply absent, and every misconfiguration would read as
a missing preview forever.
