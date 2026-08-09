---
title: 0012 — Grounded generation behind the retrieval threshold
sidebar_label: 0012 Grounded generation
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0012 — Grounded generation behind the retrieval threshold

- **Date:** 2026-08-09
- **Status:** Accepted
- **Supersedes:** the retrieval-only stance recorded in the README and in `kb/retrieve.ts`

## Context

`POST /v1/search` returns passages. A reader gets five excerpts and an `s3://` URI, and has to
assemble the answer themselves — which is most of the work they came to avoid. Requirements R20
and goal G6 ask for something else: an answer in plain language, drawn from the documentation,
carrying a citation to the page it came from.

Until now this project shipped retrieval and stopped there, on the grounds that synthesis
"would introduce text that no document contains". That reasoning is half right. The failure R20
forbids is an answer the corpus does not support — not generation as such. R20's own wording is
"answers are **generated** only from indexed documentation", which describes grounded generation
rather than prohibiting it.

The real question is what stops a model answering from background knowledge when the corpus is
silent. A prompt instruction is not an answer to that: it is a request, and a request can be
declined.

## Decision

Generation, with retrieval as the gate.

1. **Retrieval runs first, always.** `Answerer.answer()` calls the existing `Retriever` and
   returns as soon as it resolves. On `covered: false` no command is constructed and nothing is
   sent to the generation service.
2. **The refusal is structural, not prompted.** The model call lives inside a lazy async
   generator, which does not execute until something iterates it. "No model call on the
   no-coverage path" is therefore a property of the type, directly assertable as _the runtime
   client's `send` was never called_ — not a convention a later edit can quietly break.
   `RETRIEVAL_SCORE_THRESHOLD` remains the one place that decides answerability.
3. **`RetrieveAndGenerate` is still not used.** Bedrock's combined call would move the threshold
   inside a service we do not control and return citations we did not choose. Composing
   `Retrieve` with `Converse` keeps both in this repository, where they are tested.
4. **Passages are data, not instruction.** They go in the Converse system block as numbered
   `<source>` elements, with an explicit rule that any instruction appearing inside one is to be
   ignored.
5. **Citations are computed, never parsed.** They come from the retrieval results and are fixed
   before generation starts. A fabricated citation is not an available failure mode; the worst
   the model can do is put a marker against the wrong source, with the verbatim passage beside it
   for the reader to check.
6. **Citations are streamed first.** `POST /v1/ask` emits its `citations` frame before the first
   token, so "every answer carries at least one citation" holds by construction.
7. **No server-side conversation state.** History is held by the client and posted with each
   question, bounded to ten messages.

## Consequences

- **Answering now costs money per question.** It is the first line in the cost table that scales
  with reader traffic rather than sitting idle. The threshold gate is also the cost control: a
  question the corpus does not cover costs one retrieval and no generation.
- **A new IAM action and a new prerequisite.** The task role gains `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream` on one model ARN. Model access is per-account and
  per-region and off by default — without it the stack deploys clean, `/healthz` stays green, and
  every question fails.
- **A cross-region inference profile needs two kinds of ARN**: the profile, and the underlying
  foundation model in each region it can route to. `answerModelRegions` exists for this;
  granting only the profile produces an AccessDenied naming the profile, which is a misleading
  place to start debugging.
- **Grounding is reduced risk, not a guarantee.** The model can still misread a passage it was
  given. That is why the passage ships next to the answer rather than behind it.
- **Prompt injection becomes a live concern the day R1 ships.** Every corpus page arrives through
  a reviewed pull request today. Once a CMS lets non-engineers author pages, "sources are data"
  stops being belt-and-braces. The CMS work inherits this.
- **The endpoint is unauthenticated, and R22 is not met.** There is no IdP anywhere in this
  project. The per-client rate limit added with this change is a cost guard against an
  internet-facing ALB — it holds state in memory, per task, so with `desiredCount: n` the real
  ceiling is `n × limit` and it resets on deploy. It is not access control, and a real global
  limit needs a WAF rate-based rule or a shared store.
- **R20's conflicting-pages rule is prompt-enforced and not unit-testable.** The prompt requires
  both sources to be cited when they disagree; nothing verifies the model complies. Closing that
  needs an evaluation fixture with two deliberately contradictory pages.
- **The answer renders as plain text.** No markdown, no HTML. Model output derived from retrieved
  documents is a direct path into the site's DOM, and rich formatting is not worth owning that
  surface. The system prompt asks for plain prose to match.

## Alternatives considered

- **Keep retrieval only.** Honest, and it leaves the reader doing the work G6 exists to remove.
- **`RetrieveAndGenerate`.** Fewer moving parts, at the cost of moving the threshold and the
  citation set into a managed service, where neither can be tested here.
- **Generation with a runtime off-switch.** A flag degrading to verbatim passages. Rejected as
  two behaviours to test and two UIs to keep working, to avoid a prerequisite that is a single
  console checkbox.
