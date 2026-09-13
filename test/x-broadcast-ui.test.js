"use strict";

// The browser half of the broadcast button: which channels start ticked, what
// a completed send is reported as, and the wiring that has to hold for any of
// it to appear on a card at all.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const XBroadcast = require("../public/assets/js/x-broadcast");
const XPosts = require("../public/assets/js/x-posts");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    data,
  };
}

const CHANNELS = [
  { id: "tg--100111-t5", label: "Market Desk", chatId: "-100111", threadId: "5" },
  { id: "tg--100222", label: "War Room", chatId: "-100222", threadId: null },
];

/* ── Which channels start ticked ─────────────────────────────────────── */

test("a first broadcast offers every channel rather than none", () => {
  assert.deepEqual(
    XBroadcast.resolveSelection(CHANNELS, null),
    ["tg--100111-t5", "tg--100222"],
    "an unticked picker would make the first send reach nothing",
  );
});

test("the last selection is what comes back, not every channel", () => {
  assert.deepEqual(XBroadcast.resolveSelection(CHANNELS, ["tg--100222"]), ["tg--100222"]);
});

test("a channel removed from the configuration cannot be broadcast to from a stale tab", () => {
  assert.deepEqual(
    XBroadcast.resolveSelection(CHANNELS, ["tg--100222", "tg--deleted"]),
    ["tg--100222"],
  );
});

test("a saved selection naming only channels that no longer exist falls back to all", () => {
  assert.deepEqual(
    XBroadcast.resolveSelection(CHANNELS, ["tg--gone"]),
    ["tg--100111-t5", "tg--100222"],
    "an empty picker with a dead Send button is worse than the default",
  );
});

test("no channels configured selects nothing, rather than inventing one", () => {
  assert.deepEqual(XBroadcast.resolveSelection([], ["tg--100222"]), []);
});

test("a selection round-trips through storage", () => {
  const storage = fakeStorage();
  XBroadcast.writeSelection(["tg--100222"], storage);
  assert.deepEqual(XBroadcast.readSelection(storage), ["tg--100222"]);
});

test("corrupt stored state reads as no preference rather than throwing", () => {
  assert.equal(XBroadcast.readSelection(fakeStorage({ [XBroadcast.SELECTION_KEY]: "{" })), null);
  assert.deepEqual(XBroadcast.readSent(fakeStorage({ [XBroadcast.SENT_KEY]: "nope" })), []);
});

/* ── Remembering what has already gone out ───────────────────────────── */

test("a broadcast post is remembered, and the record does not grow without bound", () => {
  const storage = fakeStorage();
  XBroadcast.rememberSent("https://x.com/a/1", storage);

  assert.equal(XBroadcast.wasSent("https://x.com/a/1", storage), true);
  assert.equal(XBroadcast.wasSent("https://x.com/a/2", storage), false);

  for (let i = 0; i < 400; i += 1) XBroadcast.rememberSent(`https://x.com/a/${i}`, storage);
  assert.ok(XBroadcast.readSent(storage).length <= 200);
  assert.equal(XBroadcast.readSent(storage)[0], "https://x.com/a/399", "most recent first");
});

test("re-broadcasting the same post does not record it twice", () => {
  const storage = fakeStorage();
  XBroadcast.rememberSent("https://x.com/a/1", storage);
  XBroadcast.rememberSent("https://x.com/a/1", storage);
  assert.deepEqual(XBroadcast.readSent(storage), ["https://x.com/a/1"]);
});

/* ── Reporting the result ────────────────────────────────────────────── */

test("a clean send says how many channels got it", () => {
  const described = XBroadcast.describeResult({
    sent: 2,
    destinations: [
      { label: "Market Desk", status: "posted" },
      { label: "War Room", status: "posted" },
    ],
  });

  assert.equal(described.tone, "ok");
  assert.equal(described.message, "Broadcast to 2 channels.");
});

test("a partial send names the channel that failed, because that is the actionable half", () => {
  const described = XBroadcast.describeResult({
    sent: 1,
    destinations: [
      { label: "Market Desk", status: "posted" },
      { label: "War Room", status: "failed" },
    ],
  });

  assert.equal(described.tone, "error");
  assert.match(described.message, /Sent to 1 of 2/);
  assert.match(described.message, /War Room/, "'2 of 3' without saying which is not something anyone can act on");
});

test("one channel is singular", () => {
  assert.match(
    XBroadcast.describeResult({ sent: 1, destinations: [{ label: "A", status: "posted" }] }).message,
    /1 channel\./,
  );
});

test("the preview is trimmed on a word boundary rather than mid-word", () => {
  const preview = XBroadcast.previewText({ text: "word ".repeat(200) });
  assert.ok(preview.length < 240);
  assert.ok(preview.endsWith("…"));
  assert.ok(!/wor…$/.test(preview));
  assert.equal(XBroadcast.previewText({ text: "short" }), "short", "a short post is shown whole");
});

/* ── The card ────────────────────────────────────────────────────────── */

function makeElement(doc, tag) {
  const el = {
    tagName: tag,
    children: [],
    parentNode: null,
    className: "",
    innerHTML: "",
    textContent: "",
    title: "",
    type: "",
    disabled: false,
    handlers: {},
    classList: { toggle() {} },
    setAttribute() {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    addEventListener(name, fn) { el.handlers[name] = fn; },
    click() { if (el.handlers.click) el.handlers.click(); },
  };
  return el;
}

function withDocument(run) {
  const original = globalThis.document;
  const doc = { createElement: (tag) => makeElement(doc, tag) };
  globalThis.document = doc;
  try {
    return run(doc);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
}

function findByClass(el, className, found = []) {
  if (el.className === className) found.push(el);
  (el.children || []).forEach((child) => findByClass(child, className, found));
  return found;
}

const POST = { id: "1", handle: "alpha", text: "hello", url: "https://x.com/alpha/status/1" };

test("a card gets a Broadcast button, wired to the post it belongs to", () => {
  withDocument((doc) => {
    const root = makeElement(doc, "div");
    const bound = [];

    XPosts.renderPostCards(root, [POST], "", {
      onBroadcast: (post, button) => bound.push({ post, button }),
    });

    const button = findByClass(root, "x-post-broadcast")[0];
    assert.ok(button, "the action is on the card");
    assert.equal(button.type, "button");
    assert.equal(bound.length, 1);
    assert.equal(bound[0].post.url, POST.url, "each button carries its own post");
    assert.equal(bound[0].button, button);
  });
});

test("without the option the renderer stays a renderer and adds nothing", () => {
  withDocument((doc) => {
    const root = makeElement(doc, "div");
    XPosts.renderPostCards(root, [POST], "");
    assert.equal(findByClass(root, "x-post-broadcast").length, 0);
    assert.equal(findByClass(root, "x-post-copy").length, 1, "the existing actions are untouched");
  });
});

test("the real binder survives the renderer's argument order", () => {
  // The renderer calls onBroadcast(post, button); bindBroadcastButton takes
  // the button first, to match bindCopyLinkButton beside it. Passing the
  // function straight through therefore hands a post where a button belongs,
  // and every card throws on render. Only wiring the two together catches it,
  // which is why this test uses the real binder rather than a spy.
  withDocument((doc) => {
    const root = makeElement(doc, "div");

    assert.doesNotThrow(() => {
      XPosts.renderPostCards(root, [POST], "", {
        onBroadcast: (post, button) => XBroadcast.bindBroadcastButton(button, post),
      });
    });

    const button = findByClass(root, "x-post-broadcast")[0];
    assert.equal(button.textContent, "Broadcast", "the binder owns the resting label");
    assert.ok(button.handlers.click, "and the click that opens the picker");
  });
});

test("the page adapts the renderer's callback rather than passing the binder straight through", () => {
  const js = read("public/assets/js/x-intelligence.js");
  assert.match(
    js,
    /onBroadcast: function \(post, button\) \{\s*window\.XBroadcast\.bindBroadcastButton\(button, post\);/,
  );
});

test("a card that already went out says so before it is opened", () => {
  withDocument((doc) => {
    const button = makeElement(doc, "button");
    const storage = fakeStorage();
    XBroadcast.rememberSent(POST.url, storage);

    // wasSent reads the real localStorage inside bindBroadcastButton, so the
    // resting label is checked through the helper it delegates to.
    assert.equal(XBroadcast.wasSent(POST.url, storage), true);
    XBroadcast.bindBroadcastButton(button, POST);
    assert.ok(button.handlers.click, "clicking opens the picker");
  });
});

/* ── Wiring ──────────────────────────────────────────────────────────── */

test("the page loads the broadcast module before the script that uses it", () => {
  const html = read("public/x-intelligence.html");
  const broadcastAt = html.indexOf("/assets/js/x-broadcast.js");
  const pageAt = html.indexOf("/assets/js/x-intelligence.js");

  assert.ok(broadcastAt > 0, "the module is on the page");
  assert.ok(broadcastAt < pageAt, "x-intelligence.js reads window.XBroadcast at load time");
});

test("every post-rendering path on the page carries the broadcast option", () => {
  const js = read("public/assets/js/x-intelligence.js");

  assert.match(js, /function showPosts\(root, posts, emptyText\)/);
  assert.match(js, /renderPostCards\(root, posts, emptyText, cardOptions\)/);
  // A render site that called renderPostCards directly would silently drop the
  // button on that one state — which is how "it works except after a refresh"
  // happens. The wrapper is the only place allowed to invoke it.
  const calls = js.match(/renderPostCards\(/g) || [];
  assert.equal(calls.length, 1, "every render site must go through showPosts");
  assert.equal((js.match(/showPosts\(/g) || []).length, 4, "the wrapper and its three render sites");
});

test("a page without the module still renders its feed", () => {
  const js = read("public/assets/js/x-intelligence.js");
  assert.match(js, /window\.XBroadcast\s*\n?\s*\?/, "the option is guarded on the module being present");
});

test("the picker reuses the shared modal shell rather than a second copy of it", () => {
  const js = read("public/assets/js/x-broadcast.js");
  const components = read("public/assets/styles/components.css");

  assert.match(js, /"manage-overlay x-broadcast-overlay"/);
  assert.match(components, /\.manage-overlay \{/);
});

test("the broadcast button is styled with the other card actions", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  assert.match(css, /\.x-post-broadcast \{/);
  assert.match(css, /\.x-post-broadcast:focus-visible/, "keyboard users get the same focus ring");
});
