"use strict";

// Developing Stories: deterministic keyword grouping of loaded X posts.
// What is pinned here is as much what must NOT group as what must.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Stories = require("../public/assets/js/x-stories");
const FeedView = require("../public/assets/js/x-feed-view");
const XFreshness = require("../public/assets/js/x-freshness");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

const HOUR = 3600e3;
const NOW = Date.parse("2026-11-09T12:00:00Z");

let seq = 0;
function post(handle, hoursAgo, text, extra) {
  seq += 1;
  return Object.assign({
    id: String(1000 + seq),
    handle,
    text,
    url: "https://x.com/" + handle + "/status/" + (1000 + seq),
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  }, extra || {});
}

const ids = (group) => group.posts.map((p) => p.id).sort();

function ecbPosts() {
  return [
    post("alpha", 1, "ECB raises rates by 50bps, Lagarde signals more hikes ahead https://t.co/abc123"),
    post("beta", 1.5, "BREAKING: ECB hikes 50bps; Lagarde says further tightening likely"),
    post("gamma", 2, "Lagarde press conference: ECB 50bps hike was unanimous, euro rallies"),
  ];
}

/* ── 1. Related posts group ────────────────────────────────────────────── */

test("genuinely related posts from different accounts form one group", () => {
  const posts = ecbPosts();
  const { groups } = Stories.groupStories(posts);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(ids(g), posts.map((p) => p.id).sort());
  assert.equal(g.postCount, 3);
  assert.equal(g.accountCount, 3);
  assert.deepEqual(g.handles, ["alpha", "beta", "gamma"]);
  assert.equal(g.earliestAt, posts[2].publishedAt);
  assert.equal(g.latestAt, posts[0].publishedAt);
  // Newest first, like the feed.
  assert.deepEqual(g.posts.map((p) => p.id), [posts[0].id, posts[1].id, posts[2].id]);
  assert.match(g.label, /ECB/);
  assert.match(g.label, /Lagarde/);
});

test("two posts from two accounts are enough, with tickers and figures as the evidence", () => {
  const posts = [
    post("alpha", 3, "Nvidia $NVDA beats earnings, data center revenue up 112% year over year"),
    post("beta", 3.2, "$NVDA earnings beat: data center revenue +112%, guidance strong"),
  ];
  const { groups } = Stories.groupStories(posts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].postCount, 2);
  assert.equal(groups[0].accountCount, 2);
  assert.ok(groups[0].terms.includes("$NVDA"));
});

/* ── 2. Unrelated posts stay apart ─────────────────────────────────────── */

test("unrelated posts remain ungrouped", () => {
  const posts = [
    post("alpha", 1, "Copper futures jump as Chile mine strike enters second week"),
    post("beta", 1.2, "Tesla recalls Cybertruck over accelerator pedal issue"),
    post("gamma", 1.4, "Japan election: LDP loses majority in lower house"),
    post("delta", 1.6, "Netflix shares slide after subscriber guidance cut"),
  ];
  assert.deepEqual(Stories.groupStories(posts).groups, []);
});

test("unrelated posts beside a real group are left out of it", () => {
  const story = ecbPosts();
  const noise = [
    post("delta", 1.1, "Netflix shares slide after subscriber guidance cut"),
    post("eps", 1.3, "Copper futures jump as Chile mine strike enters second week"),
  ];
  const { groups } = Stories.groupStories(story.concat(noise));
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), story.map((p) => p.id).sort());
});

/* ── 3. One account never makes a story ────────────────────────────────── */

test("multiple posts from one account do not form a group", () => {
  const posts = [
    post("alpha", 1, "ECB raises rates by 50bps, Lagarde signals more hikes ahead"),
    post("alpha", 1.2, "ECB 50bps hike: Lagarde says further tightening is likely"),
    post("ALPHA", 1.4, "Lagarde on the ECB 50bps move: inflation still too high"),
  ];
  assert.deepEqual(Stories.groupStories(posts).groups, []);
});

test("an account can add a second post to a group that already spans two accounts", () => {
  const posts = ecbPosts().concat([post("alpha", 0.5, "Lagarde follow-up: ECB 50bps decision, more hikes on the table")]);
  const { groups } = Stories.groupStories(posts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].postCount, 4);
  assert.equal(groups[0].accountCount, 3, "accounts are counted once each");
});

/* ── 4. Six-hour window ────────────────────────────────────────────────── */

test("posts further apart than six hours do not form a group", () => {
  const posts = [
    post("alpha", 1, "ECB raises rates by 50bps, Lagarde signals more hikes ahead"),
    post("beta", 7.5, "ECB hikes 50bps; Lagarde says further tightening likely"),
  ];
  assert.deepEqual(Stories.groupStories(posts).groups, []);
});

test("a whole group fits inside one six-hour window, not just neighbouring pairs", () => {
  // Each neighbour is 4h apart, so a chain would span 8h.
  const posts = [
    post("alpha", 1, "Suez Canal blocked: Ever Given container ship stuck, tugboats deployed"),
    post("beta", 5, "Suez Canal still blocked by Ever Given; tugboats try again"),
    post("gamma", 9, "Ever Given grounded in Suez Canal, tugboats cannot free it"),
  ];
  // Preconditions: each neighbouring pair groups on its own.
  assert.equal(Stories.groupStories([posts[0], posts[1]]).groups.length, 1);
  assert.equal(Stories.groupStories([posts[1], posts[2]]).groups.length, 1);

  const { groups } = Stories.groupStories(posts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].postCount, 2);
  for (const g of groups) {
    const span = Date.parse(g.latestAt) - Date.parse(g.earliestAt);
    assert.ok(span <= 6 * HOUR, "group spans " + span / HOUR + "h");
  }
});

/* ── 5. Generic terms ──────────────────────────────────────────────────── */

test("a shared generic name alone does not group unrelated events", () => {
  const cases = [
    ["Trump signs executive order on tariffs for Canadian lumber imports", "Trump rally in Ohio draws huge crowd as campaign heats up"],
    ["Bitcoin price falls below support today", "Bitcoin price falls after weak jobs data"],
    ["Ukraine receives new air defence systems from Germany", "Ukraine grain exports hit record through Odesa corridor"],
  ];
  for (const [a, b] of cases) {
    const posts = [post("alpha", 1, a), post("beta", 1.2, b)];
    assert.deepEqual(Stories.groupStories(posts).groups, [], a + " / " + b);
  }
});

test("a term spread across the whole feed is treated as background, not an event", () => {
  // "Solana" is not on the built-in list, but here it is in every post over
  // three days — this template's background vocabulary.
  const posts = [];
  const topics = ["validator outage", "ETF filing", "memecoin launch", "fee market", "Firedancer client",
    "DEX volume", "staking yield", "NFT mint", "wallet exploit", "airdrop rumour"];
  topics.forEach((topic, i) => {
    posts.push(post(i % 2 ? "alpha" : "beta", i * 7, "Solana " + topic + " discussion thread for Phantom users"));
  });
  const { groups } = Stories.groupStories(posts);
  assert.deepEqual(groups, []);
});

/* ── 6. Duplicates ─────────────────────────────────────────────────────── */

test("duplicate source posts do not inflate group counts", () => {
  const posts = ecbPosts();
  const dupById = Object.assign({}, posts[0]);
  const dupByUrl = Object.assign({}, posts[1], { id: undefined, url: posts[1].url + "?s=20" });
  const { groups } = Stories.groupStories(posts.concat([dupById, dupByUrl, posts[2]]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].postCount, 3);
  assert.equal(new Set(groups[0].posts.map((p) => p.url.replace(/\?.*$/, ""))).size, 3);
});

test("two duplicate copies of one post cannot form a group on their own", () => {
  const p = post("alpha", 1, "ECB raises rates by 50bps, Lagarde signals more hikes ahead");
  const copy = Object.assign({}, p, { handle: "beta" });
  assert.deepEqual(Stories.groupStories([p, copy]).groups, []);
});

/* ── 7. Missing timestamps and malformed posts ─────────────────────────── */

test("missing timestamps and malformed posts are skipped safely", () => {
  const posts = ecbPosts();
  const junk = [
    null,
    undefined,
    42,
    "a string",
    {},
    { id: "x1", handle: "delta", text: "ECB 50bps Lagarde hike again" },
    { id: "x2", handle: "eps", text: "ECB 50bps Lagarde hike again", publishedAt: "not a date" },
    { id: "x3", text: "ECB 50bps Lagarde hike", publishedAt: posts[0].publishedAt },
    { id: "x4", handle: "zeta", text: null, publishedAt: posts[0].publishedAt },
    { id: "x5", handle: "eta", text: { nested: true }, publishedAt: posts[0].publishedAt },
  ];
  let result;
  assert.doesNotThrow(() => { result = Stories.groupStories(junk.concat(posts)); });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(ids(result.groups[0]), posts.map((p) => p.id).sort());
  assert.ok(result.skipped >= junk.length);

  assert.deepEqual(Stories.groupStories(undefined).groups, []);
  assert.deepEqual(Stories.groupStories("nope").groups, []);
  assert.deepEqual(Stories.groupStories([{ handle: "a", text: "x" }]).groups, []);
});

/* ── 8. Transitive chains ──────────────────────────────────────────────── */

test("a post that mentions two events cannot chain them into one group", () => {
  const a = post("alpha", 1, "ECB raises rates by 50bps as Lagarde warns on inflation");
  const bridge = post("beta", 1.2, "ECB raises rates by 50bps, Lagarde warns on inflation; meanwhile Nvidia $NVDA earnings beat with data center revenue up 112%");
  const c = post("gamma", 1.4, "Nvidia $NVDA earnings beat, data center revenue up 112%");
  // Preconditions, so the test cannot pass vacuously: each neighbouring pair
  // groups on its own, and the two ends do not.
  assert.equal(Stories.groupStories([a, bridge]).groups.length, 1, "a ~ bridge");
  assert.equal(Stories.groupStories([bridge, c]).groups.length, 1, "bridge ~ c");
  assert.equal(Stories.groupStories([a, c]).groups.length, 0, "a and c are separate events");

  const { groups } = Stories.groupStories([a, bridge, c]);
  assert.ok(groups.length >= 1);
  for (const g of groups) {
    assert.ok(!(g.posts.includes(a) && g.posts.includes(c)), "events joined through a bridge post: " + g.label);
  }
});

test("a post joins a group only if it matches a majority of its members", () => {
  const story = ecbPosts();
  // Matches the third ECB post strongly and neither of the others.
  const fringe = post("delta", 2.1, "Euro rallies, Lagarde press conference unanimous");
  assert.equal(Stories.groupStories([story[2], fringe]).groups.length, 1, "precondition: fringe ~ third post");
  assert.equal(Stories.groupStories([story[0], fringe]).groups.length, 0, "precondition: fringe !~ first post");
  assert.equal(Stories.groupStories([story[1], fringe]).groups.length, 0, "precondition: fringe !~ second post");

  const { groups } = Stories.groupStories(story.concat([fringe]));
  for (const g of groups) {
    if (!g.posts.includes(fringe)) continue;
    assert.ok(!g.posts.includes(story[0]) && !g.posts.includes(story[1]),
      "fringe post sits in a group with posts it does not match");
  }
});

/* ── 9 (module level). Template scope ──────────────────────────────────── */

test("the cache never reuses one template's groups for another", () => {
  const cache = Stories.createStoryCache({ keyOf: FeedView.postKey });
  const marketPosts = ecbPosts();
  const first = cache.compute("markets", marketPosts);
  assert.equal(first.groups.length, 1);
  assert.equal(cache.compute("markets", marketPosts), first, "unchanged input is not recomputed");
  assert.equal(cache.compute("markets", marketPosts.slice()), first, "a new array of the same posts is not either");

  const worldPosts = [
    post("delta", 1, "Baltimore Key Bridge collapse: Dali cargo ship struck pier, Maryland officials respond"),
    post("eps", 1.3, "Key Bridge in Baltimore collapsed after Dali ship strike; Maryland closes Patapsco channel"),
  ];
  const second = cache.compute("world", worldPosts);
  assert.notEqual(second, first);
  assert.equal(second.groups.length, 1);
  const marketIds = new Set(marketPosts.map((p) => p.id));
  assert.ok(second.groups.every((g) => g.posts.every((p) => !marketIds.has(p.id))));

  // Same posts under a different template name is still a different scope.
  assert.notEqual(cache.compute("other", worldPosts), second);
});

/* ── 10 (module level). Filters decide the input ───────────────────────── */

test("groups follow the feed's own search, time and media filters", () => {
  const ecb = ecbPosts();
  const nvda = [
    post("alpha", 3, "Nvidia $NVDA beats earnings, data center revenue up 112% year over year", { image: "https://pbs.twimg.com/media/a.jpg" }),
    post("beta", 3.2, "$NVDA earnings beat: data center revenue +112%, guidance strong"),
  ];
  const all = ecb.concat(nvda);
  const groupsFor = (filters) => Stories.groupStories(FeedView.filterPosts(all, filters, NOW)).groups;

  assert.equal(groupsFor({}).length, 2);

  const search = groupsFor({ query: "lagarde" });
  assert.equal(search.length, 1);
  assert.match(search[0].label, /Lagarde/);

  const recent = groupsFor({ time: "1h" });
  assert.equal(recent.length, 0, "only one ECB post is inside 1h, and one post is not a group");
  const sixHours = groupsFor({ time: "6h" });
  assert.equal(sixHours.length, 2);

  assert.deepEqual(groupsFor({ media: true }), [], "one post with media cannot group with itself");
});

test("a single selected account never produces a multi-account group", () => {
  const posts = ecbPosts();
  const onlyAlpha = posts.concat([post("alpha", 1.1, "ECB 50bps: Lagarde hints at more hikes")]).filter((p) => p.handle === "alpha");
  assert.deepEqual(Stories.groupStories(onlyAlpha).groups, []);
});

/* ── 11. Originals are preserved ───────────────────────────────────────── */

test("groups hold the original posts unmodified, with their handles, text and links", () => {
  const posts = ecbPosts().map((p, i) => Object.assign(p, { image: i ? null : "https://pbs.twimg.com/media/b.jpg", label: "Label " + i }));
  const before = JSON.parse(JSON.stringify(posts));
  const frozen = posts.map((p) => Object.freeze(p));
  const { groups } = Stories.groupStories(Object.freeze(frozen.slice()));
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), before, "input not mutated");
  for (const p of groups[0].posts) {
    assert.ok(frozen.includes(p), "the very same object, not a rewritten copy");
  }
  const urls = groups[0].posts.map((p) => p.url).sort();
  assert.deepEqual(urls, before.map((p) => p.url).sort());
});

test("labels are keyword lists, never claims of confirmation", () => {
  const posts = [
    post("alpha", 1, "CONFIRMED: ECB raises rates by 50bps, Lagarde verified statement official"),
    post("beta", 1.5, "Officially confirmed: ECB hikes 50bps; Lagarde says further tightening, verified"),
  ];
  const { groups } = Stories.groupStories(posts);
  assert.equal(groups.length, 1);
  assert.doesNotMatch(groups[0].label, /confirm|verif|official|breaking|live/i);
  assert.ok(groups[0].terms.length <= 3);
});

/* ── 12. No automatic actions ──────────────────────────────────────────── */

test("the grouping module performs no network, broadcast or FarmClaw work", () => {
  const src = read("public/assets/js/x-stories.js");
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/);
  assert.doesNotMatch(src, /XBroadcast|farmclaw|broadcast/i);
});

test("cards inside a group carry no Broadcast or FarmClaw action", () => {
  const js = read("public/assets/js/x-intelligence.js");
  const at = js.indexOf("var storyCardOptions = {");
  assert.ok(at > 0);
  const block = js.slice(at, js.indexOf("};", at));
  assert.doesNotMatch(block, /onBroadcast|onFarmclaw/);
  assert.match(js, /renderPostCards\(postsBox, group\.posts, "", storyCardOptions\)/);
});

/* ── 13. Cached data is never presented as live ────────────────────────── */

test("the section says when it was built from cached or degraded data", () => {
  const rel = (iso) => XFreshness.formatRelativeTime(iso, NOW);
  const cached = Stories.freshnessCaveat({ level: "stale" }, { savedAtIso: new Date(NOW - 20 * 60e3).toISOString() }, rel);
  assert.match(cached, /browser-cached posts saved 20 minutes ago/);
  assert.match(cached, /not a live view/);

  const expired = Stories.freshnessCaveat({ level: "unavailable" }, { savedAtIso: new Date(NOW - 3 * HOUR).toISOString(), expired: true }, rel);
  assert.match(expired, /expired/);

  for (const level of ["stale", "degraded", "offline", "unavailable"]) {
    assert.match(Stories.freshnessCaveat({ level }, null, rel), /not fully successful/);
  }
  assert.equal(Stories.freshnessCaveat({ level: "live" }, null, rel), "");

  for (const text of [cached, expired, Stories.NOTE]) {
    assert.doesNotMatch(text, /\b(confirmed|verified)\b/i);
  }
  assert.match(Stories.NOTE, /not independent\s+confirmation/);
});

/* ── 14. Off by default; feed untouched when off ───────────────────────── */

test("the preference is off by default and remembered per browser", () => {
  const data = {};
  const storage = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
  assert.equal(Stories.readEnabled(storage), false);
  assert.equal(Stories.readEnabled(null), false);
  assert.equal(Stories.readEnabled({ getItem() { throw new Error("blocked"); } }), false);
  Stories.writeEnabled(storage, true);
  assert.equal(data[Stories.STORAGE_KEY], "on");
  assert.equal(Stories.readEnabled(storage), true);
  Stories.writeEnabled(storage, false);
  assert.equal(Stories.readEnabled(storage), false);
  assert.doesNotThrow(() => Stories.writeEnabled({ setItem() { throw new Error("quota"); } }, true));
});

test("with stories off the page renders the feed exactly as before", () => {
  const js = read("public/assets/js/x-intelligence.js");
  const html = read("public/x-intelligence.html");
  const fn = js.slice(js.indexOf("function renderStories("), js.indexOf("function timeHtml("));
  // The first thing it does when off is return — no grouping, no DOM.
  assert.match(fn, /if \(!Stories \|\| !state\.storiesEnabled \|\| !storyCache\) return;/);
  assert.match(js, /storiesEnabled: Stories \? Stories\.readEnabled\(store\(\)\) : false/);
  // The toggle lives in the existing settings panel, starting Off.
  const settings = html.slice(html.indexOf('id="xFeedSettings"'), html.indexOf('id="xFeedSummary"'));
  assert.match(settings, /id="xFeedStories" aria-pressed="false"/);
  assert.match(settings, />Developing Stories: Off</);
  // Loaded after the feed view helpers and before the page script.
  assert.ok(html.indexOf("x-feed-view.js") < html.indexOf("x-stories.js"));
  assert.ok(html.indexOf("x-stories.js") < html.indexOf("x-intelligence.js\""));
  // Masonry and the feed are scoped to the feed's own grid, never a story's.
  assert.match(js, /pane\.querySelector\(":scope > \.x-post-grid"\)/);
});

test("a feed response for a template the reader has left is dropped", () => {
  const js = read("public/assets/js/x-intelligence.js");
  const fn = js.slice(js.indexOf("function refresh() {"), js.indexOf("refresh();\n  }"));
  assert.match(fn, /var requestedTemplateId = state\.templateId;/);
  assert.match(fn, /if \(state\.templateId !== requestedTemplateId\) return;/);
});

/* ── Determinism and bounded work ──────────────────────────────────────── */

test("the same input gives the same groups regardless of input order", () => {
  const posts = ecbPosts().concat([
    post("alpha", 3, "Nvidia $NVDA beats earnings, data center revenue up 112% year over year"),
    post("beta", 3.2, "$NVDA earnings beat: data center revenue +112%, guidance strong"),
    post("delta", 1.1, "Netflix shares slide after subscriber guidance cut"),
  ]);
  const shape = (r) => r.groups.map((g) => ({ id: g.id, label: g.label, ids: ids(g) }));
  const forward = shape(Stories.groupStories(posts));
  const backward = shape(Stories.groupStories(posts.slice().reverse()));
  assert.deepEqual(backward, forward);
  assert.equal(forward.length, 2);
});

/* Synthetic feeds: a few planted stories among background chatter. The
   timings are reported, not asserted tightly — CI machines vary — but the
   work has to stay bounded and the planted stories have to come back. */
function syntheticFeed(size) {
  const handles = Array.from({ length: 25 }, (_, i) => "acct" + i);
  const filler = ["markets", "today", "traders", "watching", "levels", "volume", "chart", "breakout", "support",
    "resistance", "momentum", "sentiment", "liquidity", "rotation", "earnings", "season", "guidance", "macro"];
  const posts = [];
  let s = 7;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < size; i += 1) {
    const words = Array.from({ length: 10 }, () => filler[Math.floor(rand() * filler.length)]);
    // A unique name per post so chatter has distinctive tokens to compare.
    words.push("Topic" + i);
    posts.push(post(handles[i % handles.length], rand() * 72, words.join(" ")));
  }
  const planted = [
    ["Maersk halts Red Sea transits after Houthi missile strike on tanker", "Houthi strike on tanker: Maersk pauses Red Sea routes", "Red Sea shipping: Maersk suspends transits, Houthi attack on tanker"],
    ["Boeing 737 MAX door plug blowout, Alaska Airlines grounds fleet", "Alaska Airlines grounds Boeing 737 MAX 9 fleet after door plug failure"],
  ];
  planted.forEach((texts, g) => {
    texts.forEach((text, k) => posts.push(post("planted" + g + "_" + k, 2 + g * 10 + k * 0.3, text)));
  });
  return { posts, planted };
}

for (const size of [20, 200, 1000]) {
  test("synthetic feed of " + size + " posts: bounded work, planted stories found", () => {
    const { posts, planted } = syntheticFeed(size);
    const started = process.hrtime.bigint();
    const result = Stories.groupStories(posts);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log("# x-stories synthetic " + size + " posts: " + ms.toFixed(1) + " ms, " + result.groups.length + " groups, considered " + result.considered);
    assert.ok(result.considered <= Stories.DEFAULTS.maxPosts);
    // Generous ceiling: a regression to quadratic-plus work would blow past it.
    assert.ok(ms < 2000, "took " + ms + " ms");
    const sizes = planted.map((texts) => texts.length);
    for (const want of sizes) {
      assert.ok(result.groups.some((g) => g.postCount === want && g.handles.every((h) => h.startsWith("planted"))),
        "planted story of " + want + " posts found");
    }
    assert.ok(result.groups.every((g) => g.handles.every((h) => h.startsWith("planted"))),
      "random chatter does not form groups");
  });
}
