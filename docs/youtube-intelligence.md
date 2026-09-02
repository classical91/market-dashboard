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

## Recovering from a stale selection

A category deleted in another tab leaves the page holding an ID the registry no
longer knows. `GET /api/youtube/channels?categoryId=<id>` answers 400 for it, and
the page treats that specific response as recoverable: it reselects
`All Categories` and refetches instead of rendering a failed-request message.

## Migration

Version 1 files and legacy channel arrays are migrated in memory by collecting and
case-insensitively deduplicating their category strings, generating stable category
IDs, and assigning each valid channel to the corresponding ID. Custom categories,
including a category named `Test`, are treated as ordinary user data. The migrated
version 2 document is written on the next registry mutation, preserving existing
channels and their timestamps.
