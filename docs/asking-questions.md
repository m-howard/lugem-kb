---
title: Asking questions
sidebar_position: 2
owner: platform
last_reviewed: 2026-08-09
---

# Asking questions

Ask the documentation a question in plain language and get a short answer back, with links to the
pages it came from. You do not need to know which page holds the answer, or what it is called.

## Where to find it

There are two ways in, and they share one conversation:

- **Ask the docs** — the button in the bottom-right corner of every page. Use this when you are
  already reading something and have a question about it.
- **Ask** in the top navigation — a full page at `/ask`, with a URL you can share or bookmark.

Type your question and press `Enter`. `Shift+Enter` gives you a new line instead. Press `Escape`
to close the panel.

## Reading an answer

An answer arrives as it is written, with a **Sources** list beneath it. Numbers in the answer, like
`[1]`, point at entries in that list.

Each source shows three things:

- **The page it came from**, as a link. Click it to read the full context — the panel stays open,
  so you keep your conversation.
- **When the page was last reviewed.** An answer drawn from a page nobody has looked at in two
  years is worth treating differently from one reviewed last month.
- **Show the passage** — the exact text the answer was built from, word for word. Open it when you
  want to check the answer against the source rather than take it on trust.

If two pages disagree, the answer says so and cites both rather than quietly picking one.

## When nothing covers your question

Sometimes you will get this instead of an answer:

> No documentation covers this question.

That is the intended behaviour, not a failure. Answers come from the published documentation or
they do not come at all — nothing is invented to fill a gap. If you see this, the corpus genuinely
has nothing relevant, and the honest answer is worth more than a plausible one.

When it happens, it is worth asking whether the page ought to exist. A question the documentation
cannot answer is usually a documentation gap, not a search problem — and you do not have to report
it yourself. The question is recorded and reaches the people who own that area of the
documentation. See [What is recorded](#what-is-recorded) below.

## Telling us an answer did not help

Under a finished answer there is a **This did not help** link. Use it when the answer was wrong,
out of date, or about the wrong thing.

You can add a line saying what you were actually looking for. It is optional, and short is fine —
"this is about the old expenses tool" is more useful than nothing.

There is no thumbs-up, deliberately. Nobody clicks to say an answer worked, so a score built from
that would say more about who clicks than about the documentation. The complaint is the useful
signal.

What happens next: your question and what you said go into a weekly report for the docs lead,
grouped with anyone else who asked something similar and labelled with the team that owns the
nearest page. A gap arrives as a task with an owner, rather than a note nobody picks up.

## What it can and cannot answer

It knows about pages that have been merged and indexed. That means:

- **Drafts and open pull requests are invisible to it.** A page becomes answerable after it merges
  and the next indexing run finishes.
- **Deleted pages stop being answerable** in the same run that removes them, so a retracted page
  cannot keep turning up in answers.
- **It has no knowledge outside the corpus.** It will not answer from general background
  knowledge, even when it could — see
  [ADR 0012](./adr/0012-grounded-generation-behind-retrieval.md) for how that is enforced.
- **It does not remember you.** Each conversation lives in your browser and disappears when you
  close the tab. Nothing carries over to the next one.

## Asking well

The assistant matches your question against the text of the documentation, so questions that sound
like the documentation work best:

- **Ask in full sentences.** "How do I deploy into an existing VPC?" finds more than "vpc".
- **Include the words you would expect on the page.** Product and feature names help; internal
  shorthand usually does not.
- **Ask follow-up questions.** The conversation carries context, so "and the subnets?" works after
  the question above.
- **Start a new conversation when you change topic.** Use **Clear**. Unrelated earlier turns make
  the next answer worse, not better.

## What is recorded

Your questions are not written to any log — not the question, not the conversation, not the answer.
Only counts and timings are logged, so operators can see how the service is behaving without seeing
what anyone asked.

Two things are stored, and only these two:

- **A question nothing could answer.** If you get "No documentation covers this question", the
  question is kept so it can reach the docs lead.
- **An answer you marked as unhelpful**, with your optional note.

**A question that was answered is never stored.** Neither is your name, your email, or anything
else identifying you — the report says what was asked, not who asked it. What is stored is deleted
automatically after ninety days, and the service that writes it has no permission to read it back;
only the weekly report job can.

This matters because the corpus covers people operations as well as engineering, and "how do I
report my manager" says something about the person asking even though the page it finds is one
anyone can read. That is why the line is drawn at gaps: a question the documentation failed to
answer is the only kind worth keeping, and it is kept for as short a time as is useful.

## Related

- **[Getting started](./getting-started.md)** — run the site and the service locally.
- **[ADR 0012](./adr/0012-grounded-generation-behind-retrieval.md)** — why answers are generated
  only from retrieved passages, and what that costs.
- **[ADR 0016](./adr/0016-recording-documentation-gaps.md)** — exactly what is recorded when the
  documentation cannot answer you, and for how long.
