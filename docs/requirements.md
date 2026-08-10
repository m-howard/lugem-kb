---
title: Requirements — docs authoring gateway
sidebar_label: Requirements
sidebar_position: 7
owner: platform
last_reviewed: 2026-08-08
---

<!--
    Provenance: this document was supplied as pasted text and committed here so that
    docs/reviews/requirements-review.md has a resolvable target. Notes:

    1. The source was supplied twice, identically. Only one copy is committed.
    2. The `Related:` line originally linked to project-brief.md and api-contract.md,
       neither of which exists here. They were demoted to plain text when this file joined
       the Docusaurus corpus: the site builds with onBrokenMarkdownLinks set to 'throw',
       because a broken link in the corpus becomes a broken citation once the page is
       indexed. Restore the links when the targets land.
    3. Frontmatter was added for the same reason — every corpus page carries `owner` and
       `last_reviewed`, and readers see the review date beside citations.
    4. This file is listed in .prettierignore. Prettier renumbers markdown ordered lists,
       which rewrites story 23 below into a duplicate of 15. Do not remove that entry.
    5. `sidebar_position` moved from 6 to 7 when docs/authoring-gateway.md joined the corpus.
       Frontmatter only; the document below is unchanged. In particular the §6 checkboxes are NOT
       ticked as phases land — see the README's status section for what is built.

    Otherwise verbatim. In particular the §5 user-story numbering is reproduced as
    supplied, including the out-of-sequence story 23 (see finding C2). Do not "fix" it
    here without also updating the review.
-->

# Requirements: docs authoring gateway

**Status:** draft for review
**Related:** `project-brief.md`, `api-contract.md` — not yet in this repository
**Last updated:** 2026-08-08

---

## 1. Problem statement

Subject-matter experts outside engineering own documentation they cannot publish,
because publishing requires either S3 write access or a git host account, and policy
grants them neither. Changes therefore queue behind engineering, arrive late, and
reach production without review. This affects roughly 25 authors continuously and
every internal reader indirectly, through documentation that is silently stale.

Readers face the mirror problem. Documentation that is current is still only useful
if it can be found, and finding it currently means knowing which page holds the
answer or knowing whom to ask. Questions that documentation already answers are
routed to people instead, which both costs their time and hides the gaps — a
question answered in a chat thread never becomes a page.

## 2. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Non-engineering authors publish without git host accounts | > 50% of merged docs changes authored outside engineering within 90 days |
| G2 | Every published change is reviewed by an accountable owner | 0 changes reach `main` unreviewed |
| G3 | Publishing is fast enough to be worth doing | Median submission-to-publication under 2 working days |
| G4 | Authorship is attributable for the life of the repository | 100% of CMS commits carry the human author in git metadata |
| G5 | The CMS credential cannot be used beyond documentation | 0 successful writes outside configured path prefixes, verified by test |
| G6 | Readers get answers from the documentation without knowing where it lives | > 70% of chat sessions return an answer with at least one citation; > 40% of those result in the reader opening the cited page |

## 3. Non-goals

See the project brief for full rationale. In summary: no review UI inside the CMS,
no per-page read authorisation, no non-markdown content migration, no real-time
collaborative editing, no wiki replacement.

For the answering capability specifically:

- **Chat does not author.** The answering service is read-only and holds no path to
  the gateway or the git host.
- **Not a general assistant.** Questions the corpus does not cover are declined, not
  answered from model background knowledge.
- **No cross-session memory or per-reader personalisation** in this phase.
- **Not a replacement for site search or navigation.**

## 4. Personas

| Persona | Description | Git host account |
|---|---|---|
| **Author** | SME in finance, people ops, support. Comfortable with a rich text editor. Does not know git. | No |
| **Reviewer** | Owns a documentation area. Technical enough to use a pull request. | Yes |
| **Docs lead** | Accountable for the corpus. Configures collections and ownership. | Yes |
| **Platform engineer** | Operates the gateway and pipeline. | Yes |
| **Reader** | Anyone internal. May never visit the docs site directly; arrives with a question, not a destination. | No |

## 5. User stories

### Author

1. As an author, I want to sign in to the docs CMS with my normal work login so that I do not need a new account or password.
2. As an author, I want to edit a page in a rich text editor so that I do not need to learn markdown syntax.
3. As an author, I want to save work in progress without publishing so that I can finish a draft over several days.
4. As an author, I want to preview my page as readers will see it so that I can check formatting before asking for review.
5. As an author, I want to submit a finished draft for review so that the right owner is asked to approve it.
6. As an author, I want to see whether my submission is awaiting review, approved, or published so that I do not have to ask.
7. As an author, I want a clear message when I try something that is not permitted so that I do not think the system is broken.
8. As an author, I want my name recorded on my changes so that colleagues know who to ask about a page.

### Reviewer

9. As a reviewer, I want to be notified when a page I own has a pending change so that reviews do not stall.
10. As a reviewer, I want to see the rendered page rather than a markdown diff so that I can judge the change quickly.
11. As a reviewer, I want to know who submitted a change so that I can discuss it with them.
12. As a reviewer, I want to approve and publish in one action so that review is not burdensome.

### Docs lead

13. As the docs lead, I want each page to carry an owning team so that reviews route automatically.
14. As the docs lead, I want to define what fields a page has so that documentation is structurally consistent.
23. As the docs lead, I want a regular report of questions the corpus could not answer, so that authoring effort goes where readers actually need it.

### Platform engineer

15. As a platform engineer, I want an audit record of who changed what so that I can answer governance questions the git host cannot.
16. As a platform engineer, I want the CMS credential confined to documentation paths so that a compromised frontend cannot alter CI or application code.
17. As a platform engineer, I want the service to fail closed on misconfiguration so that a bad deploy does not silently widen access.

### Reader

18. As a reader, I want to ask a question in plain language and get an answer drawn from our documentation, so that I do not need to know which page holds it.
19. As a reader, I want every answer to link to its source page, so that I can read the full context and check it myself.
20. As a reader, I want to see when the source page was last reviewed, so that I can judge whether to trust it.
21. As a reader, I want to be told plainly when nothing covers my question, so that I do not act on an invented answer.
22. As a reader, I want to flag an answer as wrong or missing, so that the gap reaches whoever owns the page.

---

## 6. Requirements

### P0 — Must have

#### R1. Authentication without git host accounts

Authors authenticate against the corporate IdP. No git host account is created,
requested or referenced at any point in the author's journey.

- [ ] Given an author with a corporate account and no git host account, when they open `/admin`, then they reach the editor without an account error
- [ ] Given an author already signed in to the intranet, when they open `/admin`, then the IdP redirect completes without a second credential prompt
- [ ] Given an expired session, when the CMS calls the gateway, then it receives HTTP 401 and prompts re-authentication rather than failing opaquely
- [ ] Given a request with no bearer token, when it reaches the gateway, then it is refused with 401 and no upstream call is made

#### R2. Single-credential git access

The gateway holds one GitHub App credential. No author credential ever reaches the
git host.

- [ ] Installation tokens are minted on demand and cached, refreshing at least 5 minutes before expiry
- [ ] Concurrent requests during refresh mint exactly one token
- [ ] A 401 from the git host invalidates the cache and retries once before surfacing an error
- [ ] The private key is supplied from a secret store, never baked into the image
- [ ] The task role holds no permissions beyond reading its own secret

#### R3. Write confinement

The gateway refuses any write outside configured documentation paths, regardless of
what the CMS requests.

- [ ] Writes to configured prefixes with permitted extensions succeed
- [ ] Writes outside those prefixes are refused with 403 — verified for `.github/workflows/`, repository root, and traversal via `..`
- [ ] Writes with non-permitted extensions are refused, including inside the docs tree
- [ ] Paths containing null bytes, backslashes or empty segments are refused
- [ ] Multi-file tree writes are refused if **any** entry violates policy
- [ ] Refusal happens before the upstream call, so a policy failure never partially applies

#### R4. Branch confinement

The CMS may only create, update and delete branches under a configured prefix.

- [ ] Creating `cms/<name>` succeeds
- [ ] Creating, updating or deleting the default branch is refused with 403
- [ ] Updating or deleting a branch outside the prefix is refused
- [ ] Pull requests targeting anything other than the default branch are refused

#### R5. Endpoint allowlisting

Only the git host API calls the editorial workflow requires are proxied.

- [ ] The documented allowlist succeeds
- [ ] Repository administration is refused: branch protection, collaborators, workflow dispatch, webhooks, deploy keys
- [ ] An unmatched method/path combination is refused with 403 and logged
- [ ] Adding an allowlist entry requires a code change and review

#### R6. Human attribution

Git history records the human author, not the service.

- [ ] Commit author name and email come from the verified token
- [ ] An author field supplied by the client is discarded and replaced
- [ ] The commit message carries a `Co-authored-by` trailer, added exactly once even on retry
- [ ] The pull request body names the submitter and their email
- [ ] Committer remains the app, so the record of what performed the write is accurate

#### R7. Editorial workflow

Saving creates a branch; submitting creates a pull request.

- [ ] Saving a draft creates or updates a branch and does not open a pull request
- [ ] Submitting for review opens a pull request against the default branch
- [ ] Workflow state is visible in the CMS and reflects the pull request state
- [ ] By default the gateway refuses merge requests from the CMS; approval happens in the git host

#### R8. Review routing

Changes reach the accountable owner.

- [ ] Each page carries an owning team in frontmatter
- [ ] A `CODEOWNERS` entry maps each documentation directory to a reviewing team
- [ ] Branch protection on the default branch requires at least one owner approval
- [ ] Direct pushes to the default branch are blocked for all principals including the app

#### R9. Audit logging

Every request produces a structured record.

- [ ] Each record carries subject, email, method, path, decision, upstream status and duration
- [ ] Refusals are logged at warning level so alarms key on level, not message text
- [ ] Bearer tokens and identity headers are redacted from logs
- [ ] Logs ship to CloudWatch with retention meeting the governance requirement

#### R10. Fail-closed configuration

- [ ] Missing required environment variables prevent start-up with a named error
- [ ] Readiness fails until an installation token can be minted, so a miscredentialed task never joins the target group
- [ ] Liveness does not depend on the git host, so an upstream outage does not cycle tasks

#### R11. Publication pipeline

- [ ] Merging to the default branch triggers a site build and deploy
- [ ] The same pipeline syncs markdown to the S3 prefix backing the AI assistant and triggers ingestion
- [ ] A failed build does not leave the live site in a partial state

### P1 — Should have

#### R12. Pull request previews

- [ ] Each pull request publishes a rendered preview to an isolated URL
- [ ] The preview link is visible on the CMS workflow card and as a pull request comment
- [ ] Preview artifacts are deleted on merge or close

#### R13. Content quality gates

- [ ] Frontmatter is schema-validated in CI; a missing owner fails the check
- [ ] Internal links are checked; a broken link fails the check
- [ ] Failures surface as a readable message, not a raw log

#### R14. Review notifications

- [ ] Owners are notified in chat when a pull request awaits their review
- [ ] Authors are notified when their submission is published or changes are requested

#### R15. Image handling

- [ ] Authors upload images through the CMS into the configured media folder
- [ ] Uploads over the size limit are rejected with a clear message

#### R20. Grounded answering

Readers ask questions in natural language and receive answers drawn from the
published corpus. Answers come from the corpus or not at all.

- [x] Answers are generated only from indexed documentation, not from model background knowledge
- [x] Every answer carries at least one citation resolving to a source page and section
- [x] When retrieval returns nothing above the relevance threshold, the reader is told no documentation covers the question rather than given a synthesised answer
- [x] Each citation displays the source page's `last_reviewed` date, so staleness is as visible in chat as it is on the page
- [ ] Where two indexed pages conflict, both are surfaced rather than one silently chosen — prompt-enforced and unverified; closing it needs an evaluation fixture with two deliberately contradictory pages (ADR 0012)

#### R21. Index scope and freshness

- [x] Only content merged to the default branch is indexed; `cms/*` branches and R12 preview builds are never ingested
- [x] A merged page is answerable within 15 minutes of the R11 pipeline completing
- [x] Deleting or unpublishing a page removes it from the index in the same pipeline run — retracted content must stop being answerable
- [x] A failed ingestion run leaves the previous index intact rather than partially updated, and alarms — the publish workflow fails loudly; a CloudWatch alarm is not yet wired

#### R22. Reader access and query handling

- [ ] The chat endpoint authenticates against the same IdP as `/admin` (R1); anonymous access is refused — **built, and off by default.** `READER_AUTH_REQUIRED` turns it on; until a deployment does, anonymous access is allowed and this is not met. Deliberate, and the reasoning is in [ADR 0016](adr/0016-reader-authentication.md)
- [x] The answering service holds no git host credential and no write path through the gateway
- [x] Paths excluded from the index by configuration never appear in an answer or citation
- [x] Question text retention and access are restricted per the governance requirement — readers will ask people-ops questions about their own circumstances, so query logs are more sensitive than the corpus they search — settled by [ADR 0015](adr/0015-recording-documentation-gaps.md)

#### R23. Gap feedback loop

- [x] Readers can mark an answer unhelpful, with an optional reason
- [x] Questions returning no confident answer are recorded and reported to the docs lead on a cadence
- [x] Where a question maps to an existing documentation area, the report names the owning team from `CODEOWNERS`, so a gap arrives as an authoring task rather than an undirected backlog item

R23 is the strongest argument for keeping answering in this project rather than
splitting it out. Authoring and retrieval share one artefact and one ownership
model; a gap report that already knows the owning team turns reader demand directly
into author work.

### P2 — Future considerations

Documented so that current design does not preclude them.

- **R16. Approval inside the CMS.** If reviewers also cannot hold git host accounts, approval moves into a gateway-owned review queue. Consequence: branch protection stops being the enforcement point, and the gateway becomes security-critical. The `POLICY_ALLOW_MERGE_FROM_CMS` flag exists so this is a configuration change plus a UI, not a rewrite.
- **R17. Scheduled review reminders.** Use the `last_reviewed` frontmatter field to prompt owners on a cadence.
- **R18. Per-area read restriction.** Would require abandoning a single static build. Note that this constrains R20–R22 identically: because every reader can read every page on the site, chat discloses nothing new. If R18 is ever adopted, the index must gain the same authorisation model on the same day, or retrieval becomes the bypass.
- **R19. Bulk operations.** Renaming a section across many pages currently requires an engineer.
- **R24. Draft-aware answering.** Letting authors query their own unpublished drafts. Excluded now because it breaks the clean R21 rule that only merged content is answerable.
- **R25. Answer-to-page promotion.** Turning a well-received chat answer into a draft page, prefilled through the CMS. Closes the loop R23 opens.

---

## 7. Success metrics

**Leading (days to weeks)**

| Metric | Success | Stretch | Method |
|---|---|---|---|
| Authors completing a change unaided in week 1 | 8 of 10 pilot users | 10 of 10 | Pilot observation |
| Submission-to-publication median | < 2 working days | < 4 hours | Pull request timestamps |
| Gateway 5xx rate | < 0.5% | < 0.1% | CloudWatch |
| Policy refusals hitting legitimate work | < 2/week after week 2 | 0 | Audit log review |
| Sessions returning a cited answer | > 70% | > 85% | Chat logs |
| Fabricated or unresolvable citations | 0 | 0 | Weekly spot-check of 50 answers |
| Index freshness after merge (p95) | < 15 min | < 5 min | Pipeline telemetry |

**Lagging (weeks to months)**

| Metric | Success | Method |
|---|---|---|
| Share of docs changes authored outside engineering | > 50% at 90 days | Commit author analysis |
| Engineering hours spent publishing for others | ~0/week at 60 days | Team survey |
| Pages with a review date under 12 months old | > 80% at 6 months | Frontmatter scan |
| Authors still using the CMS at 90 days | > 70% of onboarded | Audit log distinct subjects |
| Gap report items converted into published changes | > 50% within 30 days | Gap report vs. commit history |
| Distinct readers using chat weekly | > 40% of staff at 90 days | Chat logs |

Watch for the failure mode where volume looks healthy but a couple of engineers are
still doing the work through the CMS on others' behalf. Distinct author count, not
change count, is the honest signal.

The answering side has a mirror of that failure mode. If chat answers the same gap
forty times and no one ever writes the page, question volume looks excellent while
the corpus quietly rots — and the answers degrade with it, because there is nothing
better to retrieve. Gap-to-change conversion, not question volume, is the honest
signal there.

---

## 8. Open questions

| # | Question | Owner | Blocking |
|---|---|---|---|
| Q1 | Does the no-access constraint stem from policy or licence cost? | Security / IT | Yes |
| Q2 | Will reviewers hold git host accounts? Drives R16. | Docs lead | Yes |
| Q3 | Which IdP fronts this — Cognito federating to Entra, or Entra directly? | Platform | Yes, for R1 |
| Q4 | Does the IdP access token carry email and name claims, or must they come from the ALB header? | Platform | Yes, for R6 |
| Q5 | Audit log retention period? | Compliance | No |
| Q6 | Do any existing pages live outside the proposed writable prefixes? | Docs lead | No |
| Q7 | Chat platform for R14 notifications? | Docs lead | No |
| Q8 | Does the AI assistant referenced in R11 already exist? Is R20–R23 an integration contract or a new service? | Platform | **Resolved.** A new service, in this repository — `apps/gateway` answers over the corpus directly |
| Q9 | Model and inference hosting — Bedrock, or an existing internal endpoint? | Platform | **Resolved.** Bedrock, on S3 Vectors — [ADR 0005](adr/0005-bedrock-knowledge-base-on-s3-vectors.md), [ADR 0012](adr/0012-grounded-generation-behind-retrieval.md) |
| Q10 | Where does chat surface: docs site, chat platform, or both? Drives the R22 auth model. | Docs lead / Platform | **Resolved.** The docs site, served by the same gateway. A chat platform surface would reopen it |
| Q11 | Retention and access policy for question logs, given people-ops content | Compliance / People ops | **Resolved.** Gap questions only, 90-day TTL, write-only from the service — [ADR 0015](adr/0015-recording-documentation-gaps.md) |
| Q12 | Expected query volume and cost ceiling — does budget constrain the retrieval design? | Platform | No |
| Q13 | Any pages readable on the site that should nonetheless be excluded from the index? | Docs lead | No |

Q4 is easy to underestimate. Several IdPs omit email from the access token by
default, and the gateway refuses requests it cannot attribute. Confirm the claim
shape against a real token before build starts.

Q8 changed the shape of §6 rather than a detail within it, and it resolved the way
that keeps R20–R23 as this project's own requirements rather than acceptance
criteria imposed on somebody else's service.

Q11 deserved the same warning as Q4, and it is now settled. Query logs from a corpus
containing HR and finance content are personal data in a way the corpus itself is
not — "how do I report my manager" is a disclosure even though the page it retrieves
is public internally.

The answer, in [ADR 0015](adr/0015-recording-documentation-gaps.md), is narrow on
purpose. Only two things are stored: a question the corpus could not answer, and an
answer a reader marked unhelpful. An answered question is never stored, no record
carries who asked, retention is a per-item TTL defaulting to ninety days, and the
service that writes the table holds no permission to read it back. R23 needs the
questions to be useful at all; nothing beyond them is kept.

---

## 9. Phasing

**Phase 1 — Foundation.** Migrate S3 markdown to the repository, add frontmatter
and `CODEOWNERS`, enable branch protection, stand up build and deploy. No CMS.
Engineers can publish; nothing has regressed. _Exit: site builds from the repo._

**Phase 2 — Gateway.** Build and deploy the gateway. Verify with a scripted client
before any human uses it. _Exit: R1–R6, R9, R10 pass._

**Phase 3 — Pilot.** Decap at `/admin`, previews, quality gates. Three to five
authors from one department. _Exit: 8 of 10 pilot tasks completed unaided._

**Phase 4 — Rollout.** Remaining departments, notifications, S3 sync for the AI
assistant. _Exit: leading metrics on target._

**Phase 5 — Answering.** Index the published corpus, ship chat to one department
alongside the docs site, run the first gap reports. _Exit: R20–R23 pass;
cited-answer rate above 70%; first gap report converted into published changes._

Phase 1 delivers value on its own and de-risks everything after it. If the project
is cancelled after Phase 1, the documentation is still in better shape than today.

Phase 5 depends only on Phase 1, not on the gateway. Once the corpus is in git with
frontmatter and building, retrieval has everything it needs. Given capacity it can
run in parallel with Phases 2–4 rather than after them — and if the gateway slips,
readers still get the benefit.

**Dependencies:** GitHub App creation and installation (needs org admin); IdP
application registration (needs identity team); ALB and ECS cluster from the
hosting workstream; model and inference access approval; index or vector store
provisioning; query-log retention sign-off from compliance.
