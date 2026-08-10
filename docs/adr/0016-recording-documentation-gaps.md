---
title: 0016 — Recording documentation gaps
sidebar_label: 0016 Recording gaps
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0016 — Recording documentation gaps

- **Date:** 2026-08-10
- **Status:** Accepted
- **Resolves:** open question Q11 — retention and access policy for question logs
- **Amends:** ADR 0012's blanket "question text is never recorded"

## Context

Requirement R23 asks for a gap feedback loop: readers can mark an answer unhelpful, questions
returning no confident answer are recorded and reported to the docs lead on a cadence, and a gap
that maps to a documentation area names the owning team so it arrives as an authoring task.

`requirements.md` calls this "the strongest argument for keeping answering in this project rather
than splitting it out". Without it the corpus has no demand signal. Chat answers the same gap forty
times, question volume looks excellent, nobody writes the page, and the answers degrade because
there is nothing better to retrieve.

The obstacle is Q11. `routes/ask.ts`, `routes/search.ts` and `audit.ts` all carry the same comment:
question text is deliberately not logged, because the corpus holds people-ops content and "how do I
report my manager" is a disclosure about the asker even though the page it retrieves is internally
public. `requirements.md` puts it plainly — settle retention and access before logging anything.

A gap report cannot be written from counts. "Fourteen questions found nothing last week" tells a
docs lead nothing they can act on. The report needs the questions, which means Q11 has to be
answered rather than routed around.

## Decision

Record the questions that name a gap, and only those.

1. **Two events reach storage.** A question that returned no confident answer, and an answer a
   reader explicitly marked unhelpful. Nothing else.
2. **An answered question is never recorded**, in any form. This is the boundary that makes the
   rest defensible, and it has a test whose failure means the promise here has quietly become
   untrue.
3. **No identity, ever.** No subject, no email, no address — and not conditionally on whether
   reader authentication (R22, ADR 0017) happens to be on. Storing the question makes a record
   sensitive; storing who asked makes it attributable to a person, and R23 needs only the former.
4. **Retention is an attribute, not a policy document.** Every item carries an `expiresAt` and
   DynamoDB deletes on it. `gapFeedbackRetentionDays` defaults to 90 — long enough to see a pattern
   across a quarter of reports, short enough that a question asked once does not sit in a table
   forever. A change applies to future writes only.
5. **Backups stay off.** Point-in-time recovery keeps a continuous 35-day backup that TTL deletion
   cannot reach, so enabling it would silently extend retention past what readers were told. It is
   set to `false` explicitly, with a comment, rather than left to the default.
6. **Access is split, and neither half can do the other's job.** The gateway task role holds
   `dynamodb:PutItem` and nothing else — no Query, no Scan, no GetItem. **The service that collects
   reader questions cannot read one back.** A separate role, in its own GitHub deployment
   environment, holds `dynamodb:Query` and nothing else.
7. **Partitioned by UTC day**, sorted by time within the day. The only query this store ever serves
   is "everything in the last N days", which becomes N bounded `Query` calls on known partitions.
   Never a `Scan`: its cost scales with what is retained rather than what is asked for, and TTL
   deletion lags by up to 48 hours, so a scan would read items the retention policy considers gone.
8. **Recording fails open.** A write failure logs a warning and is swallowed. A reader whose
   question the corpus cannot answer is already having a bad time; a throttled table must not also
   cost them their reply.
9. **Attribution comes from the near miss.** A no-coverage question has no citations, so retrieval
   now keeps the highest-scoring result that fell below the threshold. It names an area without
   claiming to answer anything.
10. **One rolling issue, updated in place.** A weekly pile of issues is a thing people stop reading
    by the third week. Owners are named in the body via CODEOWNERS rather than assigned, because one
    issue spans many areas.

## Consequences

- **Q11 is answered, and narrowly.** The answer is not "we log questions" but "we retain the
  questions that name a gap, for ninety days, in a store the service cannot read". That is a
  sentence a compliance owner can approve or reject on its merits.
- **Gap data is best-effort and is not an audit log.** Fail-open recording means the report is a
  lower bound. It must never be described as a complete record of what readers asked, because it
  is not one, by design.
- **The first database in the stack.** Previously the gateway held no durable state at all; its
  audit trail is structured logs. That property is now qualified rather than true, and the
  qualification is this table.
- **`/v1/search` writes on its no-coverage path.** It is unauthenticated and unrate-limited, so an
  anonymous loop of nonsense questions writes one small item each. Bounded by on-demand pricing and
  by TTL, and the real fix is R22. Named here rather than discovered later.
- **CODEOWNERS becomes load-bearing for something other than review.** A documentation area with no
  entry produces gaps attributed to `_unowned_`. That is actionable — it means the file has a hole —
  but it is a new way for a stale CODEOWNERS to cost something.
- **Reader text reaches a GitHub issue.** Questions are escaped before rendering: backticks would
  break the code span, a pipe would break the table row, and an unescaped `@everyone` would notify
  the organisation. This is the feature's real injection surface.
- **A retention change is not retroactive.** Shortening `gapFeedbackRetentionDays` does not expire
  what is already stored. If that ever matters, it needs a one-off backfill rather than a config
  change.

## Alternatives considered

- **Counts only, no question text.** Safest, and it makes the report useless — a docs lead cannot
  write a page from a tally. Rejected because it satisfies the letter of R23 and none of its point.
- **A dedicated CloudWatch log group with a retention setting.** No new resource type, and retention
  would be a property of the group. Rejected because it puts the most sensitive data in the system
  back into the logging pipeline that every existing comment says to keep it out of, and because
  per-item TTL is a stronger promise than a group-wide setting.
- **Store the reader's identity alongside the question.** Would allow a gap report that says which
  team keeps asking. Rejected: it converts a sensitive record into an attributable one, and the
  reporting value is not close to worth it.
- **Widen the corpus publishing role to read the table.** One fewer role. Rejected because that role
  exists to sync markdown, and giving the publish path read access to reader question text is
  exactly the kind of quiet widening this project's IAM comments exist to prevent.
