"use strict";

// X Intelligence 2.0: client-side filters, display and motion preferences,
// new-post tracking, and the card renderer's preview and expand behaviour.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FeedView = require("../public/assets/js/x-feed-view");
const XPosts = require("../public/assets/js/x-posts");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

const HOUR = 3600e3;
const NOW = Date.parse("2026-10-19T12:00:00Z");

function post(id, hoursAgo, extra) {
  return Object.assign({
    id: String(id),
    handle: "alpha",
    text: "post " + id,
    url: "https://x.com/alpha/status/" + id,
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  }, extra || {});
}

function memoryStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

/* ── Filters ───────────────────────────────────────────────────────────── */

test("filters work over the loaded posts only, by text, handle, time and media", () => {
  const posts = [
    post(1, 0.5, { text: "BTC breaks out", image: "https://pbs.twimg.com/a.jpg" }),
    post(2, 3, { text: "ETH lagging", handle: "beta" }),
    post(3, 30, { text: "Weekly BTC recap" }),
    post(4, 200, { text: "old" }),
  ];
  const ids = (list) => list.map((p) => p.id);

  assert.deepEqual(ids(FeedView.filterPosts(posts, {}, NOW)), ["1", "2", "3", "4"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { query: "btc" }, NOW)), ["1", "3"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { query: "@beta" }, NOW)), ["2"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { time: "1h" }, NOW)), ["1"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { time: "6h" }, NOW)), ["1", "2"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { time: "24h" }, NOW)), ["1", "2"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { time: "7d" }, NOW)), ["1", "2", "3"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { media: true }, NOW)), ["1"]);
  assert.deepEqual(ids(FeedView.filterPosts(posts, { query: "btc", time: "24h" }, NOW)), ["1"]);
  // The input is never mutated: filtering is a view, not a change to the feed.
  assert.equal(posts.length, 4);
});

test("a post with no usable timestamp is not treated as recent", () => {
  const undated = post(9, 0, { publishedAt: null });
  assert.equal(FeedView.filterPosts([undated], { time: "all" }, NOW).length, 1);
  assert.equal(FeedView.filterPosts([undated], { time: "1h" }, NOW).length, 0);
});

test("unknown filter values fall back to the defaults", () => {
  assert.deepEqual(FeedView.normalizeFilters({ time: "3y", media: "yes", query: 4 }), { query: "", time: "all", media: false });
  assert.equal(FeedView.isDefaultFilters({ query: "  " }), true);
  assert.equal(FeedView.isDefaultFilters({ time: "6h" }), false);
});

test("time and media filters are remembered per template, the search box is not", () => {
  const storage = memoryStorage();
  FeedView.writeFilters(storage, "war", { query: "drone", time: "6h", media: true });
  assert.deepEqual(FeedView.readFilters(storage, "war"), { query: "", time: "6h", media: true });
  assert.deepEqual(FeedView.readFilters(storage, "markets"), { query: "", time: "all", media: false });
  assert.ok(Object.keys(storage.data).every((k) => k.startsWith("xIntelligence:feedFilters:v1:")));
});

/* ── Preferences ──────────────────────────────────────────────────────── */

test("Compact is the default view, and a chosen view is persisted", () => {
  const storage = memoryStorage();
  assert.equal(FeedView.readView(storage), "compact");
  FeedView.writeView(storage, "focus");
  assert.equal(FeedView.readView(storage), "focus");
  storage.setItem(FeedView.KEYS.view, "masonry");
  assert.equal(FeedView.readView(storage), "compact", "an unknown value is not trusted");
  assert.equal(FeedView.readView(null), "compact", "no storage still renders");
  assert.deepEqual(FeedView.VIEW_MODES, ["compact", "cards", "focus"]);
});

test("background motion follows the OS until the reader chooses", () => {
  assert.equal(FeedView.resolveMotion(null, false), "on");
  assert.equal(FeedView.resolveMotion(null, true), "off", "reduced motion is the default when the OS asks");
  assert.equal(FeedView.resolveMotion("on", true), "on", "an explicit opt-in wins");
  assert.equal(FeedView.resolveMotion("off", false), "off");
  assert.equal(FeedView.resolveMotion("sometimes", true), "off");

  const storage = memoryStorage();
  FeedView.writeMotion(storage, "off");
  assert.equal(FeedView.readMotion(storage, false), "off");
});

/* ── New-post awareness ───────────────────────────────────────────────── */

test("a first visit flags nothing as new", () => {
  assert.deepEqual(FeedView.findNewPosts(null, [post(1, 1), post(2, 2)]), {});
});

test("only identifiers missing from the last visit are new", () => {
  const seen = FeedView.mergeSeen(null, [post(1, 1), post(2, 2)]);
  const fresh = FeedView.findNewPosts(seen, [post(3, 0.1), post(1, 1), post(2, 2)]);
  assert.deepEqual(fresh, { "id:3": true });
  // The same payload again — a successful refresh with nothing new in it.
  assert.deepEqual(FeedView.findNewPosts(FeedView.mergeSeen(seen, [post(3, 0.1)]), [post(3, 0.1), post(1, 1)]), {});
});

test("a post that aged out of the bounded record is not flagged again", () => {
  let record = null;
  for (let i = 0; i < 10; i += 1) record = FeedView.mergeSeen(record, [post(i, i)], 5);
  assert.equal(record.entries.length, 5, "the record is bounded");
  // post 9 (oldest) was evicted, but it is older than anything remembered.
  assert.deepEqual(FeedView.findNewPosts(record, [post(9, 9), post(0, 0)]), {});
  assert.deepEqual(FeedView.findNewPosts(record, [post(42, 0.01)]), { "id:42": true });
});

test("the seen record round-trips through storage per template", () => {
  const storage = memoryStorage();
  FeedView.writeSeen(storage, "war", FeedView.mergeSeen(null, [post(1, 1)]));
  assert.deepEqual(FeedView.readSeen(storage, "war").entries.map((e) => e[0]), ["id:1"]);
  assert.equal(FeedView.readSeen(storage, "markets"), null);
  storage.setItem("xIntelligence:seenPosts:v1:war", "{not json");
  assert.equal(FeedView.readSeen(storage, "war"), null);
});

test("post identity prefers the X id and falls back to the permalink", () => {
  assert.equal(FeedView.postKey({ id: "17", url: "u" }), "id:17");
  assert.equal(FeedView.postKey({ url: "https://x.com/a/status/1" }), "url:https://x.com/a/status/1");
  assert.equal(FeedView.postKey(null), "");
});

/* ── Preview text ─────────────────────────────────────────────────────── */

test("the preview drops trailing attachment links and self-links only", () => {
  const p = { url: "https://x.com/alpha/status/1" };
  assert.equal(XPosts.cleanPreviewText("Chart https://t.co/abc https://t.co/def", p), "Chart");
  assert.equal(
    XPosts.cleanPreviewText("Read https://t.co/art first. Then https://t.co/m", p),
    "Read https://t.co/art first. Then",
    "an inline link may be the only pointer to the article",
  );
  assert.equal(XPosts.cleanPreviewText("See https://twitter.com/alpha/status/1/photo/1 now", p), "See now");
  assert.equal(XPosts.cleanPreviewText("Docs: https://example.com/a", p), "Docs: https://example.com/a");
  assert.equal(XPosts.cleanPreviewText("a\n\n\n\nb", p), "a\n\nb");
});

/* ── Rendered card ───────────────────────────────────────────────────── */

function makeElement(tag) {
  const el = {
    tagName: tag, children: [], parentNode: null, className: "", innerHTML: "", textContent: "",
    attributes: {}, handlers: {}, classes: {}, style: {}, hidden: false,
    classList: { toggle(name, on) { el.classes[name] = on === undefined ? !el.classes[name] : !!on; } },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) { el.children.splice(el.children.indexOf(child), 1); return child; },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    click() { (el.handlers.click || []).forEach((fn) => fn()); },
  };
  return el;
}

function withDocument(run) {
  const original = globalThis.document;
  globalThis.document = { createElement: makeElement };
  try { return run(); } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
}

function findByClass(el, className, found = []) {
  if (el.className === className) found.push(el);
  el.children.forEach((child) => findByClass(child, className, found));
  return found;
}

const LONG = "Thread on liquidity: the TGA rebuild is mostly done, RRP is near zero, and reserves are " +
  "drifting lower, which historically coincides with funding stress around quarter end. https://t.co/Photo555";

test("long posts get a Read more control wired to the text it expands", () => withDocument(() => {
  const root = makeElement("div");
  const expanded = {};
  const opts = { expanded, keyOf: FeedView.postKey };
  XPosts.renderPostCards(root, [post(1, 1, { text: LONG }), post(2, 2, { text: "Short one." })], "", opts);

  const toggles = findByClass(root, "x-post-expand");
  assert.equal(toggles.length, 1, "a short post gets no control");
  const toggle = toggles[0];
  const text = findByClass(root, "x-post-text")[0];
  assert.equal(toggle.tagName, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.attributes["aria-controls"], text.id);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(toggle.textContent, "Read more");

  toggle.click();
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(toggle.textContent, "Show less");
  assert.equal(text.classes["is-expanded"], true);
  assert.deepEqual(expanded, { "id:1": true });

  // A re-render (refresh, filter change) keeps the post open.
  XPosts.renderPostCards(root, [post(1, 1, { text: LONG })], "", opts);
  const again = findByClass(root, "x-post-expand")[0];
  assert.equal(again.attributes["aria-expanded"], "true");

  again.click();
  assert.deepEqual(expanded, {});
}));

test("the card shows the cleaned preview while every action keeps the original post", () => withDocument(() => {
  const root = makeElement("div");
  const original = post(1, 1, { text: LONG });
  const handed = [];
  XPosts.renderPostCards(root, [original], "", {
    onBroadcast: (p) => handed.push(["broadcast", p]),
    onFarmclaw: (p) => handed.push(["farmclaw", p]),
  });
  const text = findByClass(root, "x-post-text")[0];
  assert.doesNotMatch(text.textContent, /t\.co/);
  assert.equal(handed.length, 2);
  for (const [, p] of handed) {
    assert.equal(p, original, "the same object, untouched");
    assert.match(p.text, /https:\/\/t\.co\/Photo555$/);
  }
  for (const cls of ["x-post-open", "x-post-copy", "x-post-link", "x-post-farmclaw", "x-post-broadcast"]) {
    assert.equal(findByClass(root, cls).length, 1, cls + " is still on the card");
  }
  assert.equal(findByClass(root, "x-post-link")[0].textContent, "x.com/alpha/status/1");
}));

test("a NEW post is marked on the card and in its meta line", () => withDocument(() => {
  const root = makeElement("div");
  XPosts.renderPostCards(root, [post(1, 1), post(2, 2)], "", {
    isNew: (p) => p.id === "2",
  });
  const cards = findByClass(root, "x-post-card");
  assert.equal(cards[0].attributes["data-new"], undefined);
  assert.equal(cards[1].attributes["data-new"], "true");
  assert.match(findByClass(cards[1], "x-post-meta")[0].innerHTML, /class="x-post-new"/);
  assert.doesNotMatch(findByClass(cards[0], "x-post-meta")[0].innerHTML, /x-post-new/);
}));

test("the meta line keeps the handle, the template tag and a machine-readable time", () => withDocument(() => {
  const root = makeElement("div");
  XPosts.renderPostCards(root, [post(1, 2, { category: "War <b>" })], "");
  const meta = findByClass(root, "x-post-meta")[0].innerHTML;
  assert.match(meta, /<span class="x-tag">@alpha<\/span>/);
  assert.match(meta, /<span class="x-post-category">War &lt;b&gt;<\/span>/);
  assert.match(meta, /<time class="x-post-time" datetime="2026-10-19T10:00:00.000Z"/);
}));

test("a post that was only its own link still shows something", () => withDocument(() => {
  const root = makeElement("div");
  XPosts.renderPostCards(root, [post(1, 1, { text: "https://x.com/alpha/status/1" })], "");
  assert.equal(findByClass(root, "x-post-text")[0].textContent, "https://x.com/alpha/status/1");
}));

/* ── Page wiring ──────────────────────────────────────────────────────── */

test("the toolbar is static markup above the feed, and its script loads first", () => {
  const html = read("public/x-intelligence.html");
  for (const id of ["xFeedSearch", "xFeedAccount", "xFeedTime", "xFeedMedia", "xFeedView", "xFeedMotion", "xFeedReset", "xFeedSummary"]) {
    assert.ok(html.includes('id="' + id + '"'), id + " is in the markup");
  }
  assert.ok(html.indexOf('id="xFeedToolbar"') < html.indexOf('id="xTimelinePane"'));
  for (const t of FeedView.TIME_KEYS) assert.ok(html.includes('data-time="' + t + '"'));
  for (const v of FeedView.VIEW_MODES) assert.ok(html.includes('data-view="' + v + '"'));
  assert.match(html, /<label class="x-feed-search">\s*<span class="x-visually-hidden">Search loaded posts<\/span>/);
  // Everything but search and the summary folds behind the settings button.
  assert.match(html, /id="xFeedSettingsToggle"[^>]*aria-expanded="false"[^>]*aria-controls="xFeedSettings"/);
  const panel = html.slice(html.indexOf('id="xFeedSettings"'), html.indexOf('id="xFeedSummary"'));
  assert.match(html, /id="xFeedSettings" hidden/);
  for (const id of ["xFeedAccount", "xFeedTime", "xFeedView", "xFeedMedia", "xFeedMotion", "xFeedReset"]) {
    assert.ok(panel.includes('id="' + id + '"'), id + " is inside the settings panel");
  }
  assert.ok(html.indexOf('id="xFeedSearch"') < html.indexOf('id="xFeedSettings"'));
  const viewAt = html.indexOf("/assets/js/x-feed-view.js");
  assert.ok(viewAt > html.indexOf("/assets/js/x-posts.js") && viewAt < html.indexOf("/assets/js/x-intelligence.js"));
});

test("filtering never fetches: the page filters in the render path only", () => {
  const js = read("public/assets/js/x-intelligence.js");
  assert.equal((js.match(/fetch\(/g) || []).length, 2, "still only the templates and accounts requests");
  assert.match(js, /FeedView\.filterPosts\(posts, state\.filters\)/);
  assert.doesNotMatch(js, /setInterval\(/, "no polling was added");
});

test("new posts are recorded only from an authoritative server response", () => {
  const js = read("public/assets/js/x-intelligence.js");
  assert.match(js, /writeCachedFeed\(state\.templateId, payload\);\s*markNewPosts\(state\.templateId, payload\.posts, true\);/);
  assert.match(js, /markNewPosts\(templateId, state\.feedData\.posts, false\)/);
});

test("the post grid keeps chronological order: no dense packing, no CSS columns", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  const js = read("public/assets/js/x-intelligence.js");
  assert.doesNotMatch(css, /grid-auto-flow:\s*[^;]*dense/);
  assert.doesNotMatch(css, /column-count|(?<![-\w])columns:/);
  assert.match(css.match(/\.x-post-grid \{[^}]*\}/s)[0], /align-items: start;/, "short posts are not stretched");
  // Masonry is row spans on the same sparse auto-placement, off in Focus view.
  assert.match(js, /card\.style\.gridRowEnd = "span "/);
  assert.match(js, /state\.view !== "focus"/);
});

test("each display mode is styled, and Focus shows the full text", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  for (const v of FeedView.VIEW_MODES.filter((v) => v !== "cards")) {
    assert.ok(css.includes('.x-timeline-frame[data-x-view="' + v + '"] .x-post-grid'), v);
  }
  assert.match(css, /\[data-x-view="focus"\] \.x-post-text \{[^}]*-webkit-line-clamp: unset;/s);
  assert.match(css, /\.x-post-text\.is-expanded \{[^}]*-webkit-line-clamp: unset;/s);
});

test("decorative highlights follow the template accent; health colours do not", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  assert.match(css, /--x-hl: var\(--x-accent, var\(--blue\)\)/);
  const health = css.match(/\.x-feed-status--[a-z]+[^{]*\{[^}]*\}/g).join("\n");
  assert.doesNotMatch(health, /--x-hl|--x-accent/);
  assert.match(css, /\.x-feed-status--live \{\s*border-left-color: var\(--green/);
});
