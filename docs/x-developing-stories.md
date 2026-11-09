# X Intelligence: Developing Stories

Status: **Option A implemented** (client-side keyword grouping, off by
default). Option B (server-side embeddings / LLM) remains a separate proposal
below and is **not** implemented. Nothing here changes the feed, the freshness
banner, Broadcast or FarmClaw.

## What it is

An optional section above the post grid on `/x-intelligence.html` that groups
posts already loaded (and already filtered) for the selected template when
they share distinctive keywords, e.g.:

```
▾ DEVELOPING STORIES  2 keyword groups
  KEYWORD GROUP  "50bps · ECB · Lagarde"
  4 posts · 3 accounts · first 55 minutes ago · latest 12 minutes ago
  @eurowatch, @macrodesk, @ratestrader
```

Expanding a group shows every original post in it, newest first, each with
its own handle, timestamp, permalink and the Open / Copy link actions. The
feed below is unchanged: grouping is an extra view, not a replacement, and
every grouped post is still in the main feed.

## Using it

- Toggle: **Developing Stories: Off/On** in the feed settings panel (gear).
  Off by default; remembered per browser in `localStorage`
  (`xIntelligence:developingStories:v1`).
- The section header folds the whole section; each group starts collapsed.
  Opened groups stay open across filter and view changes, and reset on a
  template switch or a reload.
- No group that meets the rules → no section at all (no empty box).

## Ground rules (as implemented)

- **Grouping is not verification.** The header says "4 posts · 3 accounts",
  never "confirmed" or "verified". A fixed note under the header says labels
  are keywords, not headlines, and that posts in a group are not independent
  confirmation.
- **No status of its own.** The section carries no LIVE/CONFIRMED badge. When
  the feed on screen comes from the browser cache, or the latest check was not
  fully successful, an amber caveat says so ("Built from browser-cached posts
  saved 22 minutes ago. This is not a live view…").
- **Originals stay visible and untouched.** Groups hold references to the
  original post objects; the input array and posts are never modified. Labels
  are lists of up to three shared terms in quotes, never sentences.
- **No automatic actions.** Cards inside a group have Open and Copy link only —
  no Broadcast or FarmClaw button. Those remain on the main feed's cards, as
  per-post buttons a person presses.
- **Costs nothing.** Runs in the browser over posts already on the page. No
  requests, no model, no new environment variables, no dependencies.

## How grouping works

Code: `public/assets/js/x-stories.js` (UMD, same pattern as `x-feed-view.js`).
Tests: `test/x-stories.test.js` (engine), `test/x-stories-ui.test.js`
(Playwright, skipped when Chromium cannot launch).

1. **Input** is exactly what the feed shows after the toolbar's search, time,
   media and account filters (`XFeedView.filterPosts`), for the selected
   template only.
2. **Eligible posts:** a post object with a stable id (X status id, else
   permalink), a handle, string text and a valid timestamp. Posts without a
   timestamp are skipped (their age is unknown, so they cannot be placed in a
   window). Duplicates by id or permalink count once. Posts with fewer than
   three content words are skipped. At most the newest 500 are considered.
3. **Tokens:** URLs and @mentions removed; stop words and filler ("breaking",
   "says", "update", "confirmed", "verified", …) dropped; plural "s" stemmed.
4. **Distinctive terms:** cashtags, hashtags, figures (`50bps`, `112%`,
   `4.6%`; not single digits or bare years), acronyms, and capitalised words
   that appear capitalised mid-sentence somewhere in the loaded posts. Title
   Case and ALL-CAPS posts only contribute names the rest of the feed agrees
   are names.
5. **Generic terms never count as distinctive:** a built-in list (Bitcoin,
   BTC, Trump, Ukraine, Russia, China, Fed, market, oil, gold, AI, …) plus any
   term found in ≥ 20% of the loaded posts (minimum 8) spread across more
   than 12 hours — the template's own background vocabulary.
6. **Pair rule:** two posts relate when they are within **6 hours** and share
   either ≥ 2 distinctive terms with word-overlap (Jaccard) ≥ 0.2, or ≥ 1
   distinctive term with Jaccard ≥ 0.4. Candidates come from an inverted
   index on distinctive terms, so unrelated posts are never compared; scoring
   is capped at 40,000 pairs.
7. **Grouping without transitive chaining:** strongest pairs merge first, but
   a merge is accepted only if the whole group still fits in one 6-hour span
   and **every post relates to a strict majority of the others** (in a group
   of three, each post must match both others). A post mentioning two events
   cannot chain them together. Groups stop at 24 posts.
8. **Output:** groups with ≥ 2 posts from ≥ 2 accounts, ordered by latest post.
   A single selected account therefore never produces a group.
9. **Recompute only on change:** results are memoised on template + the
   filtered posts' ids, timestamps and text lengths; view-mode changes and
   re-renders reuse them. A template switch clears the cache.

Measured on synthetic feeds in the test suite (Node 22, CI machines will
differ): 20 posts ≈ 1 ms, 200 posts ≈ 5 ms, 1,000 posts (500 considered)
≈ 16 ms.

## Limitations

Stated so nobody reads more into a group than it is:

- **It matches words, not meaning.** Different events that share two names or
  figures in the same six hours can be grouped (e.g. two separate ECB
  officials' comments that both mention "Lagarde" and "50bps"). The same event
  described in different words, or in another language, will not group.
- **False-positive risks:** recurring scheduled terms (CPI, FOMC, NFP) on a
  release day; ticker-heavy posts that list many cashtags; two accounts
  posting the same press-release wording about different subjects; a name that
  is not on the generic list but is background for one template.
- **Not independent:** quote posts, reposts and accounts copying each other
  look like several posts. Account count is not a confirmation count.
- **Greedy grouping can split one story** into two smaller groups when posts
  match different subsets of each other. Precision is preferred over recall.
- **Labels are raw terms.** Multi-word names are separate terms
  ("Key · Bridge · Maryland").
- Only loaded posts are considered: nothing beyond the feed payload.

## Related fix shipped with it

`refresh()` now drops a feed response for a template the reader has already
switched away from. Previously a slow response could put the old template's
posts (and their groups) on screen under the new template's name and write
them into the new template's browser cache.

## Recommended next steps (ranked by production value)

1. **Measure on real feeds.** Turn it on for a week and note wrong and missed
   groups per template; tune the generic list and thresholds from that rather
   than guessing.
2. **Per-template generic terms** in the template registry (e.g. "Solana" for a
   Solana template) instead of only the global list.
3. **Join adjacent label terms** into phrases ("Key Bridge") when they appear
   next to each other in most members.
4. **Use expanded URLs** if the feed ever provides them: two posts linking the
   same article are strong evidence.
5. Option B below, only if keyword grouping proves clearly insufficient.

## Option B — server-side clustering with embeddings or an LLM (proposal, not implemented)

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

Recommendation unchanged: keep Option A, measure how often groups are wrong on
real feeds, and only consider Option B if keyword grouping is clearly
insufficient.
