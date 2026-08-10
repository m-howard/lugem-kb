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

## Add an image

Screenshots, org charts, diagrams of a process — put them straight in the page.

1. Open the page you want the image on, and put the cursor where it should go.
2. Use the image button in the editor's toolbar.
3. Choose **Upload** and pick your file.

The image appears in the page as you write. It is saved when the page is saved, and it travels with
the page from then on: the same draft, the same review, the same moment of publication. Nobody sees
it on the live site before they see the page it belongs to.

| What                | Limit                                               |
| ------------------- | --------------------------------------------------- |
| Formats             | PNG, JPEG, GIF, WebP                                |
| Size, per image     | 2 MB by default — your deployment may allow more    |
| Where they are kept | One shared folder, so you can reuse one on any page |

Choosing **Upload** while a page is open is the way in. The media library on its own — reached from
the top of the editor rather than from inside a page — will show you every image already uploaded,
and you can insert one of those into your page, but it will not accept a _new_ upload. An image has
to arrive with a page, because that is what gets it reviewed.

Two things are worth knowing before you pick a file:

- **Write alternative text.** The editor asks for it. Readers using a screen reader get nothing else,
  and the assistant cannot describe a picture to somebody who asks about it.
- **A screenshot straight off a modern laptop is often several megabytes.** If yours is refused,
  crop it to the part that matters and export it again — that usually solves both the size and the
  readability.

SVG files are not accepted. They can contain code as well as pictures, and the documentation site is
not a safe place to run somebody's code. Export the diagram as PNG instead.

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

Two things behave differently in a preview than on the real site: the **Ask** page cannot answer
questions, and the light/dark choice is forgotten when you reload. A preview is walled off from the
rest of the site on purpose, and both of those need to reach out of the wall. Everything you are
there to check — your words, your headings, your links, your tables — renders exactly as it will
once the change is published.

The same link is posted as a comment on your change, so a reviewer can open it without going
through the editor.

If the button keeps saying **Check for preview**, the build is still running — it takes a couple of
minutes after a save. If it never resolves, the deployment may not have previews switched on; ask a
platform engineer.

## Being told what happened

You do not have to watch your submission. If your deployment has notifications switched on, you get
an email when it matters:

| When                                  | You get                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Your change is approved and published | A note that it is live, and answerable in chat within about 15 minutes |
| A reviewer asks for changes           | A note to open the page in the CMS and submit it again                 |

Reviewers get the matching email when a page they own is waiting for them, so a submission does not
sit unnoticed.

Nothing arrives while you are still drafting — saving is silent by design.

If you never receive these, notifications are not configured on your deployment. That is a setting,
not a fault with your submission; ask a platform engineer.

## Your name on your work

Every change records you as its author — your name and your email, from the login you signed in
with. Colleagues can see who to ask about a page, permanently.

You cannot write a change under somebody else's name. There is no field for it.

## What it will not do

| You try to                                | What happens                                                 |
| ----------------------------------------- | ------------------------------------------------------------ |
| Upload from the media library on its own  | Refused. Add the image from inside a page instead.           |
| Upload anything that is not an image      | Refused. PNG, JPEG, GIF and WebP only.                       |
| Delete a page that is already published   | Refused. Ask a platform engineer.                            |
| Delete an image that is already published | Refused. Take it out of the page in a draft and submit that. |
| Edit anything outside the documentation   | Not offered. You will not see those files.                   |
| Publish your own change                   | Refused. Approval happens in the review step.                |

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

**"… is 4.2 MB, over the 2.1 MB limit for an image."** The image is too big. Crop or compress it and
add it again. The message names your file and both sizes, so you know how much to save. Nothing else
in your page was lost — the save was refused whole, so try again once the image is smaller.

**"… is not PNG data, whatever its name says."** The file's contents do not match its extension,
which usually means it was renamed rather than exported. Open it in whatever made it and export it
again as PNG or JPEG.

**"That save is larger than … this editor accepts at once."** Several large images in one save. Save
the page with a couple of them, then add the rest and save again.

**A comment saying the documentation checks failed.** Something on the page needs fixing before it
can be published — a missing owner, or a link pointing at a page that is not there. The comment
lists each one with the line it is on. Fix them and save again; the comment updates itself.

**Anything else.** The message the editor shows comes from the gateway and is written to be acted
on. If it is not, that is worth reporting: send it to a platform engineer with what you were doing.

## Trying it without touching anything real

If you have this repository checked out and want to see the editor before you use it in anger,
there is a sandbox: a copy of the documentation you can edit freely, on your own machine, wired to
nothing.

```bash
bun run dev:cms      # then open http://127.0.0.1:4300/admin/
```

It signs you in automatically, and everything on this page works — writing, images, saving,
submitting. Nothing leaves your machine, and `bun run dev:cms --reset` puts it all back.

## Related

- [The authoring gateway](./authoring-gateway.md) — how this works, for whoever operates it
- [Getting started](./getting-started.md#run-the-cms-at-admin) — running the sandbox above
- [ADR 0015](./adr/0015-decap-adapter-in-the-gateway.md) — why the editor works the way it does
- [ADR 0021](./adr/0021-images-travel-with-the-draft.md) — why an image is saved with its page
- [ADR 0022](./adr/0022-a-local-sandbox-for-the-editorial-surface.md) — how the sandbox works
- [Requirements](./requirements.md) — the user stories this page implements
