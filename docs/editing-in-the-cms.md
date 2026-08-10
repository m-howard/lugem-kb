---
title: Editing in the CMS
sidebar_position: 7
owner: platform
last_reviewed: 2026-08-10
---

# Editing in the CMS

The documentation CMS lets you write and publish pages with your normal work login. You do not
need a GitHub account, and you do not need to know git or markdown.

This page is what to expect: how to sign in, what saving and submitting each do, and what the
messages mean when something is refused.

:::note

The CMS is part of the documentation site. If your deployment has not configured it, `/admin` says
so rather than showing an empty editor — ask a platform engineer to work through
[the authoring gateway](./authoring-gateway.md).

:::

## Sign in

Open **`/admin`** on the documentation site.

You are sent to your organisation's login page and straight back. If you are already signed in to
the intranet, you may not see it at all.

Then the editor shows a **Login** button. Click it. That button belongs to the editor rather than
to your organisation, and it asks for nothing — you have already signed in, and this is the
editor catching up.

Your session lasts until you close the tab.

## Write a page

**Contents** lists every page in the documentation. Click one to edit it, or use **New
Documentation** to add one.

Every page has four fields above the text:

| Field         | What it is                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Title         | The heading readers see, and the name in search results.                                                   |
| Owning team   | Who is accountable for the page. This is what routes your change to a reviewer.                            |
| Last reviewed | When someone last checked the page is still true. Readers see this date beside answers from the assistant. |
| Page          | The page itself, in a rich text editor.                                                                    |

Fill in the owning team even when it feels obvious. It is how a reviewer is found, and a page
without one cannot be published.

## Save, then submit

These are two separate actions, on purpose.

**Save** keeps your work without telling anybody. A draft you write over three days should not sit
in a reviewer's queue the whole time. You can leave and come back; your draft is waiting under
**Workflow**.

**Submit** — dragging your card from **Drafts** to **In review** — asks the owning team to look at
it. They are notified, they read the rendered page, and they approve it.

Publishing happens after that approval, outside the CMS. This is deliberate: it is what guarantees
nothing reaches the live documentation without an accountable person having read it. If you drag a
card to **Ready** the editor will accept it, but the card reads as **In review** again when you
reload — the third column has no meaning here.

To take a change back out of review, drag it to **Drafts**. Your work is kept; only the review
request is withdrawn.

## See it rendered before anybody else does

Once you have submitted a change, it gets its own copy of the whole documentation site with your
edit in it. Your card gains a **Check for preview** button; click it and the link appears.

The preview is rebuilt every time you save, so it always shows your latest draft. It is a normal
copy of the site, so you can click around it — your new page in the sidebar, the links you added,
the way a long table wraps. Nobody outside the review sees it, and it disappears when the change is
published or withdrawn.

The same link is posted as a comment on your change, so a reviewer can open it without going
through the editor.

If the button keeps saying **Check for preview**, the build is still running — it takes a couple of
minutes after a save. If it never resolves, the deployment may not have previews switched on; ask a
platform engineer.

## Your name on your work

Every change records you as its author — your name and your email, from the login you signed in
with. Colleagues can see who to ask about a page, permanently.

You cannot write a change under somebody else's name. There is no field for it.

## What it will not do

| You try to                              | What happens                                  |
| --------------------------------------- | --------------------------------------------- |
| Upload an image                         | Refused. The CMS holds markdown pages only.   |
| Delete a page that is already published | Refused. Ask a platform engineer.             |
| Edit anything outside the documentation | Not offered. You will not see those files.    |
| Publish your own change                 | Refused. Approval happens in the review step. |

None of these are faults to report. They are the boundaries the CMS was built with, so that a
documentation editor can never change anything but documentation.

## When something goes wrong

**"The authoring CMS is not configured on this deployment."** The site is running without the CMS
switched on. Nothing you can fix — ask a platform engineer.

**You are asked to sign in again.** Your session expired, or you opened the editor in a new tab.
Sign in again; your saved drafts are unaffected.

**"This draft moved since you opened it."** Somebody else saved the same page while you were
editing. Reload the page, check their change, and save again.

**A message about a path or a branch.** The change touched something outside the documentation.
Usually a page title that produced an unusable file name — try a simpler one, without punctuation.

**A comment saying the documentation checks failed.** Something on the page needs fixing before it
can be published — a missing owner, or a link pointing at a page that is not there. The comment
lists each one with the line it is on. Fix them and save again; the comment updates itself.

**Anything else.** The message the editor shows comes from the gateway and is written to be acted
on. If it is not, that is worth reporting: send it to a platform engineer with what you were doing.

## Related

- [The authoring gateway](./authoring-gateway.md) — how this works, for whoever operates it
- [ADR 0015](./adr/0015-decap-adapter-in-the-gateway.md) — why the editor works the way it does
- [Requirements](./requirements.md) — the user stories this page implements
