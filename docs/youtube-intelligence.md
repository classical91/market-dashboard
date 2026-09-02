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

## Migration

Version 1 files and legacy channel arrays are migrated in memory by collecting and
case-insensitively deduplicating their category strings, generating stable category
IDs, and assigning each valid channel to the corresponding ID. Custom categories,
including a category named `Test`, are treated as ordinary user data. The migrated
version 2 document is written on the next registry mutation, preserving existing
channels and their timestamps.
