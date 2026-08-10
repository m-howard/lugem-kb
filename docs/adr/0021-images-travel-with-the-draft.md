---
title: 0021 — Images travel with the draft
sidebar_label: 0021 Image handling
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0021 — Images travel with the draft

- **Date:** 2026-08-10
- **Status:** Accepted

## Context

[Requirements](../requirements.md) R15 asks for two things: authors upload images through the CMS
into the configured media folder, and uploads over the size limit are rejected with a clear message.

Until now the corpus held markdown and nothing else. `PERMITTED_EXTENSIONS` in
`apps/gateway/src/kb/key-policy.ts` is `['.md', '.mdx']`, every write runs through it, and
[ADR 0015](./0015-decap-adapter-in-the-gateway.md) recorded the consequence honestly:

> **Media is absent by construction.** `PERMITTED_EXTENSIONS` is markdown only, so the media
> library lists nothing and uploads are refused with an explanation. R15 is a separate change, and
> it touches the write confinement R3 rests on.

This is that change, and that last clause is the whole difficulty. R3 confines what the one CMS
credential may write; adding a second kind of writable file is the first widening of that rule since
it was written.

Two questions had to be answered before any of it: **when** an image reaches the repository, and
**where** it lands.

## Decision

### An image is committed with the page that shows it

Decap holds an upload client-side while an entry is open — `persistMedia` in its own
`mediaLibrary` actions takes the `editingDraft` branch and calls `addDraftEntryMediaFile` rather
than the backend — and then sends it with the entry, as `assets` on `persistEntry`. The gateway
takes that and writes the image into the **same commit, on the same draft branch**, as the markdown.

So R15's write path adds no write path. There is no upload endpoint, no second commit, and no moment
at which an image exists in the repository without the page that references it. An image is
submitted, reviewed, approved and published exactly as the words around it are, which is R7 and R8
applying to media for free rather than by a second mechanism.

This is **not** what Decap's own git backends do. They answer `persistMedia` by committing straight
to the default branch, so an image is published the moment it is picked, before anyone has read the
page it is on. Here that is refused twice over — branch policy forbids a direct write to the default
branch, and R8's branch protection forbids it for every principal including the App — so the
standalone media-library upload is refused with somewhere better to go:

> Add the image from inside the page that will show it, rather than from the media library. An image
> is reviewed and published with its page, so it has to travel with one.

### One configured folder, published as static assets

`CMS_MEDIA_FOLDER` defaults to `docs/assets/media/`, and `apps/docs/docusaurus.config.ts` publishes
`docs/assets/` as a static directory. Docusaurus copies a static directory's _contents_ to the site
root, so an image stored at `docs/assets/media/org-chart.png` is served at `/media/org-chart.png` —
and that is the `public_folder` the gateway hands the editor, derived from the folder's own name so
the two cannot drift.

The nesting is load-bearing rather than decorative. Pointing the static directory at the media
folder itself would publish images at the site root; pointing it at `../../docs` would copy every
page's markdown source into the build alongside its rendered page.

Confinement is to that **one folder**, not to R3's path prefixes. Those say where _pages_ may be
written, and an image is not a page. A single folder is also a rule an operator can check by looking
at one directory listing.

### What may be in it

`MEDIA_EXTENSIONS` is `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and the leading bytes of every upload
are checked against the extension it claims. Two exclusions are decisions:

- **No SVG.** An SVG is a script carrier, and the site is served from the same origin as `/admin`,
  where the author's access token lives in `sessionStorage`. An uploaded SVG would be stored
  cross-site scripting against the editor, triggered by anyone opening the page it is on. A
  screenshot is worth having; a scripting surface on the editor's own origin is not.
- **No AVIF.** `routes/content-types.ts` has no entry for it, so the site would offer it as a
  download rather than render it. An image the browser saves instead of showing is not an image.

The signature check is what keeps the folder honest. A `.png` holding HTML would otherwise be served
from the documentation origin as `image/png` — harmless in a browser, but it would make the media
folder a general file drop inside a repository whose whole purpose is that it contains only
documentation.

### Where the size limit is enforced

`CMS_MAX_UPLOAD_BYTES` defaults to 2 MiB, and every image is checked — path, payload, size,
signature — **before the first upstream call**. A save carrying one oversized image writes nothing:
not the page, not the other images. That is R3's "refused if any entry violates policy" applied to
media, and it is why an author gets one refusal to act on rather than a half-applied commit for
somebody to unpick.

The refusal names both numbers, because a limit an author cannot compare against is not a clear
message:

> org-chart.png is 4.2 MB, over the 2.1 MB limit for an image. Resize or compress it and add it
> again.

The proxy endpoint also carries a request-body limit, derived from the per-image limit rather than
chosen: a body over it never reaches a handler, so a middleware refusing a save the policy would
have accepted would give the author a worse message than the one R15 asks for.

## Consequences

- **The size refusal arrives on save, not on upload.** Decap has no client-side size limit for its
  default media library, and because it defers the upload to the entry save there is no earlier
  moment the gateway sees the file at all. Mitigated rather than solved: the markdown field carries a
  hint naming the limit and the formats before anybody picks a file.
- **A broken image reference fails the build.** Docusaurus resolves absolute image paths against the
  static directories and throws when one is missing, naming the file and line. That is the same
  guarantee R13 gives internal links, obtained without adding a check — and it is why
  `scripts/docs/links.ts` still has no opinion about images.
- **Images are not ingested, and that is right.** `scripts/docs/corpus-files.ts` walks markdown only,
  so nothing under the media folder is synced to S3 or indexed by Bedrock. R21 is untouched: an image
  is not answerable content, and a retrieval index of PNGs would be cost without capability.
- **`/media/x.png` does not render in GitHub's diff view.** An absolute site path cannot, and this is
  the real price of a single shared folder over per-page co-location. Reviewers read the R12 preview,
  which `editing-in-the-cms.md` already sends them to, and where the image renders exactly as it will
  once published.
- **Showing the media library costs a blob read per image.** Decap builds a blob URL per file from
  content it is given, so paths alone cannot answer it. Reads are chunked, as a collection listing
  already is. A media folder an order of magnitude larger would want paging, which Decap's protocol
  has no field for — the same shape of limit ADR 0015 recorded for collection listings.
- **The editorial board reads two listings per draft instead of one.** Decap derives an entry's media
  from the diffs, so images have to appear there; an image missing from that list is an image that
  vanishes from the editor while sitting on the branch all along.
- **Deleting a published image is not offered**, for the same reason deleting a published page is
  not: it is a change to the corpus and has to be reviewed like one.
- **Two places now know the media folder.** The gateway confines writes to it and the site publishes
  it, and nothing derives one from the other — they are different processes in different workspaces.
  Both default to the same path, `resolveMediaFolder` fails start-up and `pulumi preview` if the
  folder falls outside what the CMS may write, and the public path is derived from the folder name
  rather than configured twice. A deployment that changes one and not the other still gets images it
  cannot serve, and that is the sharpest edge this decision leaves.
