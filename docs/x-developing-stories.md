# X Intelligence: Developing Stories (proposal)

Status: **design proposal only — not implemented.** Needs approval before any
code lands. Nothing here changes the feed, the freshness banner, Broadcast or
FarmClaw.

## What it is

An optional, collapsed-by-default section above the post grid on
`/x-intelligence.html` that groups posts already loaded for the selected
template when they appear to cover the same event, e.g.:

```
▸ Developing · "bridge crossing reopened"   4 posts · 3 accounts · first 06:10, latest 08:45
```

Expanding a group lists every original post in it, newest first, each with its
own handle, timestamp, permalink and the normal card actions (Open, Copy link).
The ungrouped feed below is unchanged: grouping is an extra view, not a
replacement, and a post can always be found in the main feed too.

## Ground rules

- **Grouping is not verification.** Several posts about one event are counted
  as posts, never as "sources confirming" it. The group header says
  "4 posts · 3 accounts", never "confirmed" or "verified". Accounts that
  repost or quote each other are not independent, and the UI must not imply
  they are.
- **No status is inferred.** The section has no LIVE/CONFIRMED/RUMOR badge of
  its own. If a post's text says "unconfirmed", that text is shown as written.
- **Every original stays visible**: source handle, original timestamp, original
  permalink. The group title is a label for scanning, not a summary that
  replaces the posts.
- **No automatic actions.** Groups never post, broadcast or queue for FarmClaw.
  Broadcast and FarmClaw remain per-post buttons that a person presses.
- **Basic browsing costs nothing.** Grouping runs in the browser on the loaded
  posts. No paid AI call is needed to open the page or read a group.

## Option A — client-side heuristic grouping (recommended first step)

Runs in a new pure module (`x-stories.js`, same UMD pattern as
`x-feed-view.js`) over the posts the page already has. No backend, no new
credentials, no extra requests.

1. Normalise each post's preview text (`cleanPreviewText`), lower-case, strip
   punctuation and stop words, keep tickers/cashtags, hashtags, capitalised
   multi-word names and numbers.
2. Candidate pairs: posts within a time window (default 6h) that share a
   distinctive token (a cashtag, hashtag, or a rare proper-noun bigram).
3. Score pairs with Jaccard similarity over the token sets (plus a bonus when
   both posts link to the same expanded URL, if the feed ever provides one).
4. Union-find over pairs above a threshold (start ~0.35); a group needs
   ≥ 2 posts from ≥ 2 different accounts — one account posting a thread is not
   a developing story.
5. Group label: the most frequent distinctive tokens, shown in quotes so it
   reads as a keyword label, not a headline.

Cost: zero runtime cost beyond a few milliseconds per render for a few hundred
posts (pairing is bounded by the time window).

Limitations, stated plainly in the UI's help text:

- It matches words, not meaning. Two posts about different events that share
  a ticker in the same hours will be grouped; the same event described with
  different words will not.
- Quote posts and reposts can make one claim look like several posts.
- Only loaded posts are considered: no history beyond the feed payload.
- Non-English posts group poorly.

Tests: deterministic fixtures for "groups", "does not group across the time
window", "single account never forms a group", "the label never contains
'confirmed'/'verified'", and that group rendering exposes every original
permalink.

## Option B — server-side clustering with embeddings or an LLM (later, if A is not enough)

A backend job would cluster recent posts per template using text embeddings
(or an LLM pass for titles) and expose `/api/x/stories?template=…`.

- **Cost:** embeddings for a few thousand short posts/day are cheap but not
  free; an LLM titling pass per group per refresh is the expensive part and
  should be cached per group hash. Needs a new API key and a budget cap.
- **Risks:** an LLM-written title can read as a factual claim. Titles would
  have to be framed as "Posts about …", carry "AI-generated label", and never
  assert an outcome. Model output must not decide verification state.
- **Work:** new service, cache, route, env vars (`.env.example` + README),
  failure behaviour when the provider is down (section hidden, feed
  unaffected), and tests.

Recommendation: ship Option A behind a toolbar toggle ("Developing stories:
Off/On", default Off), measure how often groups are wrong on real feeds, and
only consider Option B if keyword grouping is clearly insufficient.

## Open questions for approval

1. Default the section to Off (toggle) or On but collapsed?
2. Time window and minimum group size (6h / 2 posts / 2 accounts proposed).
3. Should the group header offer "Open all on X" (opens tabs), or only list
   links? Proposed: list only.
