# YouTube Intelligence architecture

## Previous flow

The static channel catalogue seeded `youtube-channels.json`. Each channel stored a
free-text `category` value, while `youtube-themes.js` separately derived the filter
choices. The browser fetched intelligence for every channel and then narrowed the
returned cards to the chosen theme. Channel management exposed category text but
there was no canonical category store or category CRUD.

## Current flow

```text
youtube-channels.json (version 2)
  categories: stable id, name, slug, createdAt
       ↓ categoryId
  channels: handle, label, channelId, addedAt
       ↓ category-scoped API query
YouTube service ingestion
       ↓
YouTube Intelligence results
```

`YoutubeChannelRegistry` is the only persisted source of truth for both categories
and channels. The JSON file remains protected by the existing exclusive lock and
atomic-write mechanism; no second database or browser-side configuration store was
introduced. Browser storage remembers only the selected category ID.

`GET /api/youtube/channels?categoryId=<id>` filters the registry before passing
channels to the YouTube service. `all` selects every channel. Unknown IDs are
rejected, while deleted remembered IDs fall back to `all` when the page next loads
the current category catalogue.

Authenticated `/api/youtube/channels/config` and
`/api/youtube/categories/config` mutations provide channel and category CRUD.
Renaming a category changes only its canonical category record. Deleting a category
with assigned channels requires a destination category or the virtual
`uncategorized` destination; channels are never deleted as a side effect.
The virtual fallback is hidden from page and manager lists while unused. If it
contains channels, both lists expose it with the same count and the Categories tab
marks it read-only, keeping the available categories aligned without displaying an
empty pseudo-category.

## Manage YouTube Sources panel

The panel is one dialog with two tabs, `Channels` and `Categories`, so channel
management and category management stay related without being the same job. The
tab strip is a `tablist`: only the selected tab is in the tab order and
Left/Right/Home/End move between them.

The Channels tab searches and filters an otherwise unadorned list — display
name, `@handle`, category badge, Edit and Delete. The Add Channel form is hidden
until requested. Its category field is a select, never free text, and its
`+ Create new category` choice reveals a name field inline rather than sending
the user to the Categories tab: leaving mid-form would discard the handle they
had already typed. On submit the category is created first and the channel is
saved against the returned ID, so a channel never references a category by name.

Empty states name the view that is empty — no channels at all, none in the
selected category, or none matching the search — and each offers Add a channel.

Deletes are confirmed in an in-panel dialog rather than `window.confirm`, and
every mutation disables its own control while it runs.

Searching or filtering the channel list updates only its rows, keeping keyboard
focus, the search caret, and any open channel draft intact. Failed saves keep
the entered fields available for retry. If an inline category was created
before the channel save failed, the form keeps that category's returned ID so
retrying does not attempt to create it again.

The manager makes the underlying page inert while open. A delete confirmation
also makes the manager's background controls inert, traps focus within its own
controls, and returns focus to the invoking Delete button on cancel. Escape
cancels the confirmation before it can close the manager. Once a deletion is
submitted its confirmation stays busy until the result arrives.

## Feed recovery and freshness

`Refresh feeds` reloads the category catalogue and the selected feed without a
full page reload. It also provides a retry after either request fails. Expired
sessions expose a login link. Loading state uses `aria-busy`; the status line
announces search match counts, the response's check time, partial failures, and
channels served from last-known-good cached uploads. A check time is not a
promise that cached uploads are current. Refresh retains the selected category
and search query, and uses the service's existing caches and quota protection.

`test/youtube-v2-browser.test.js` exercises these flows against local fixture
APIs, including inline playback, category recovery, failed saves, keyboard
navigation, and layouts from 320 to 1440 pixels. Install Chromium with
`npx playwright install chromium` if it is missing; that browser suite skips
when the executable is unavailable.

## Recovering from a stale selection

A category deleted in another tab leaves the page holding an ID the registry no
longer knows. `GET /api/youtube/channels?categoryId=<id>` answers 400 for it, and
the page treats that specific response as recoverable: it reselects
`All Categories` and refetches instead of rendering a failed-request message.

## Categories are independent of themes

Categories are created deliberately in the manage panel. The app constructs
`YoutubeChannelRegistry` with no `categorySeed`, so a first boot gets exactly the
categories its seeded channels are filed under and nothing else.

It used to pass `categorySeed: themeSections()`, which turned every section the
theme catalogue names — Archaeology, AI Labs, Apple & iOS — into a YouTube
category holding no channels, making the filter read as a list of things to fix
rather than a list of what is tracked. `themeSections()` still reports what the
catalogue names; it no longer feeds category creation.

The change is not retroactive. A category is not marked with where it came from,
and once persisted it is user data: an install that already has those empty
categories keeps them, and can delete them from the Categories tab. Only future
fresh registries differ. A registry file at version 2 is not rewritten on boot.

`categorySeed` remains a registry constructor option, defaulting to none, so a
deployment can still ask for categories beyond its channels deliberately.

## Migration

Version 1 files and legacy channel arrays are migrated in memory by collecting and
case-insensitively deduplicating their category strings, generating stable category
IDs, and assigning each valid channel to the corresponding ID. Custom categories,
including a category named `Test`, are treated as ordinary user data. The migrated
version 2 document is written on the next registry mutation, preserving existing
channels and their timestamps.

## The Live Now feed

`GET /api/youtube/live` serves Main Hub's Media page the live and upcoming
subsets of the same ingestion `/api/youtube/channels` uses. It makes no
additional YouTube call: both routes go through one `getIntelligence` pass over
the tracked channels and share its caches, so the widget costs no extra quota.

The response is narrowed in `src/services/youtube-live-feed.js` rather than
spread from the feed payload. Each field is named there on purpose, so a field
added to the feed cannot start travelling to another origin by accident. Video
IDs, titles, channel names, thumbnails, start times and viewer counts go; the
API key, per-channel failure reasons, quota state and the wider video feed stay.

`categories` also travels — `{ id, name, channelCount }` per category, nothing
about the channels in them — for the Live Now card's YouTube Intelligence
picker, which opens `youtube-v2.html?category=<id>`. Category names and counts
become public with this route; channel handles and notes do not.

`meta.liveDetection` travels because the widget's empty state depends on it:
`api` means we checked and nothing is live, `degraded` means the status lookup
failed so an empty list proves nothing, and `unavailable` means there is no API
key and live state was never knowable. A widget that cannot tell those apart
will confidently claim an empty sky.

The route is exempt from site auth via `isPublicYoutubeLiveRequest` in
`src/middleware/site-auth.js`, scoped exactly as the `/api/market-session` and
`/api/decision` bypasses are: GET and HEAD only, that one path, nothing beneath
it. Main Hub reads it from its Node process with no browser session to present;
the alternative was Main Hub holding this site's password to read which public
YouTube streams are live. `/api/youtube/channels` and every channel and category
mutation stay behind the session cookie and `ADMIN_API_KEY`.
