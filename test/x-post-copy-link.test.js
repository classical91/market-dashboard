"use strict";

/* The copy-link path on X Intelligence, exercised as the browser runs it.
 *
 * This file exists because of a bug an iPhone found and no test could: the
 * button disabled itself, awaited navigator.clipboard.writeText(), and put
 * its label back in .then(). On iOS Safari that promise can reject oddly or
 * never settle at all, and when it never settled the button stayed disabled
 * on "Copying link..." until the page was reloaded.
 *
 * So the property under test is not "copying works". It is that the button
 * comes back — after success, after rejection, after an absent Clipboard API,
 * after the fallback fails, and above all after a promise that never settles.
 *
 * The browser is faked rather than emulated: a controllable clock, a
 * scriptable clipboard, and a document just real enough for the execCommand
 * fallback and for renderPostCards. That keeps the never-settles case
 * testable at all — with real timers it would either hang or take seconds. */

const test = require("node:test");
const assert = require("node:assert");

const XPosts = require("../public/assets/js/x-posts");

const URL = "https://x.com/alpha/status/1234567890";

/* ── Test doubles ──────────────────────────────────────────────────────── */

// A clock the test drives. Timers fire in due order when time is advanced.
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();

  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < timers.get(due).at)) due = id;
        }
        if (due === null) break;
        const timer = timers.get(due);
        timers.delete(due);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

// Lets queued promise callbacks run before the next assertion.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// `writeText` decides the case under test: resolve, reject, throw, or — the
// iOS failure — return a promise that is never settled by anyone.
function makeClipboard(writeText) {
  const calls = [];
  return {
    calls,
    navigator: {
      clipboard: {
        writeText(text) {
          calls.push(text);
          return writeText(text);
        },
      },
    },
  };
}

function makeElement(doc, tag) {
  const el = {
    tagName: tag,
    children: [],
    parentNode: null,
    className: "",
    innerHTML: "",
    textContent: "",
    value: "",
    type: "",
    title: "",
    disabled: false,
    style: {},
    attributes: {},
    handlers: {},
    classList: { toggle() {} },
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      if (doc) doc.appended.push(child);
      return child;
    },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      if (doc) doc.removed.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (el.handlers[type] = el.handlers[type] || []).push(fn);
    },
    click() {
      return Promise.all((el.handlers.click || []).map((fn) => fn()));
    },
    focus() {},
    select() {},
    setSelectionRange() {},
  };
  return el;
}

// `execCommand` is the fallback's verdict: true, false, or a thrown error.
function makeDocument(execCommand) {
  const doc = {
    appended: [],
    removed: [],
    copiedValues: [],
    createElement: (tag) => makeElement(doc, tag),
    execCommand(command) {
      const field = doc.body.children[doc.body.children.length - 1];
      doc.copiedValues.push(field ? field.value : null);
      if (typeof execCommand === "function") return execCommand(command);
      return execCommand;
    },
  };
  doc.body = makeElement(doc, "body");
  return doc;
}

function makeButton(label) {
  const button = makeElement(null, "button");
  button.textContent = label;
  return button;
}

// One place to assemble the environment a bound button runs in.
function harness({ writeText, execCommand = false, label = "Copy link", url = URL, overrides = {} } = {}) {
  const clock = makeClock();
  const clipboard = writeText ? makeClipboard(writeText) : { calls: [], navigator: {} };
  const doc = makeDocument(execCommand);
  const button = makeButton(label);

  const attempt = XPosts.bindCopyLinkButton(button, url, label, {
    navigator: clipboard.navigator,
    document: doc,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  });

  return { clock, clipboard, doc, button, attempt, label };
}

function assertResting(button, label) {
  assert.equal(button.textContent, label, "the button did not return to its resting label");
  assert.equal(button.disabled, false, "the button was left disabled");
}

/* ── The Clipboard API paths ───────────────────────────────────────────── */

test("a successful clipboard write copies the exact URL and says so", async () => {
  const { clock, clipboard, button } = harness({ writeText: () => Promise.resolve() });

  await button.click();
  await flush();

  assert.deepEqual(clipboard.calls, [URL], "the exact post URL must be what is copied");
  assert.equal(button.textContent, "Link copied");
  assert.equal(button.disabled, true, "the button stays disabled for the length of the confirmation");

  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("a rejected clipboard write falls back, and a successful fallback still reads as copied", async () => {
  const { clock, doc, button } = harness({
    writeText: () => Promise.reject(new Error("NotAllowedError")),
    execCommand: true,
  });

  await button.click();
  await flush();

  assert.deepEqual(doc.copiedValues, [URL], "the fallback must copy the same exact URL");
  assert.equal(button.textContent, "Link copied");

  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("a clipboard write that throws synchronously is treated as a failed attempt, not a crash", async () => {
  const { clock, button } = harness({
    writeText: () => { throw new Error("clipboard blew up"); },
    execCommand: false,
  });

  await button.click();
  await flush();

  assert.equal(button.textContent, "Copy failed");
  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("an absent Clipboard API goes straight to the fallback", async () => {
  // navigator with no .clipboard at all — an older iOS Safari, or an
  // insecure-context page.
  const { clock, doc, button } = harness({ execCommand: true });

  await button.click();
  await flush();

  assert.deepEqual(doc.copiedValues, [URL]);
  assert.equal(button.textContent, "Link copied");
  clock.advance(1800);
  assertResting(button, "Copy link");
});

/* ── The fallback's own failures ───────────────────────────────────────── */

test("a fallback that reports failure surfaces it, and still restores the button", async () => {
  const { clock, doc, button } = harness({
    writeText: () => Promise.reject(new Error("denied")),
    execCommand: false,
  });

  await button.click();
  await flush();

  assert.equal(button.textContent, "Copy failed");
  clock.advance(1800);
  assertResting(button, "Copy link");
  assert.equal(doc.body.children.length, 0);
});

test("a fallback that throws is still a failure the button recovers from", async () => {
  const { clock, button } = harness({
    writeText: () => Promise.reject(new Error("denied")),
    execCommand: () => { throw new Error("execCommand is not supported"); },
  });

  await button.click();
  await flush();

  assert.equal(button.textContent, "Copy failed");
  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("the temporary field is removed from the document on every path", async () => {
  for (const execCommand of [true, false, () => { throw new Error("nope"); }]) {
    const { doc, button } = harness({
      writeText: () => Promise.reject(new Error("denied")),
      execCommand,
    });

    await button.click();
    await flush();

    assert.equal(doc.body.children.length, 0, "a temporary copy field was left in the page");
    assert.equal(doc.removed.length, 1, "the temporary copy field was never removed");
    assert.equal(doc.appended.length, 1, "exactly one temporary field should have been added");
  }
});

/* ── The bug: a promise that never settles ─────────────────────────────── */

test("a clipboard promise that never settles does not strand the button", async () => {
  // This is the iPhone case, reproduced exactly: writeText returns a promise
  // that nothing will ever resolve or reject. Under the old implementation
  // the button stayed disabled on "Copying link..." forever.
  const { clock, button } = harness({
    writeText: () => new Promise(() => {}),
    execCommand: false,
  });

  button.click();
  await flush();

  assert.equal(button.textContent, "Copying link...", "the attempt should be visibly in flight");
  assert.equal(button.disabled, true);

  // The clipboard race gives up, the fallback is tried and declines...
  clock.advance(2500);
  await flush();
  assert.equal(button.textContent, "Copy failed");

  // ...and the button comes back on its own.
  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("a never-settling clipboard promise still copies when the fallback can", async () => {
  const { clock, doc, button } = harness({
    writeText: () => new Promise(() => {}),
    execCommand: true,
  });

  button.click();
  await flush();
  clock.advance(2500);
  await flush();

  assert.deepEqual(doc.copiedValues, [URL]);
  assert.equal(button.textContent, "Link copied");
  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("the button's watchdog restores it even if the copy helper itself never settles", async () => {
  // Belt and braces: the helper above is written so that it always settles,
  // but the button does not take that on trust. Here the clipboard race is
  // set beyond the watchdog, so nothing settles the attempt except the
  // watchdog itself.
  const { clock, button } = harness({
    writeText: () => new Promise(() => {}),
    overrides: { clipboardTimeoutMs: 120000, watchdogMs: 4000 },
  });

  button.click();
  await flush();
  assert.equal(button.textContent, "Copying link...");

  clock.advance(4000);
  await flush();
  assert.equal(button.textContent, "Copy failed");

  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("no copy attempt leaves a timer behind once the button is back", async () => {
  const cases = [
    { writeText: () => Promise.resolve() },
    { writeText: () => Promise.reject(new Error("denied")), execCommand: true },
    { writeText: () => new Promise(() => {}), execCommand: false },
  ];

  for (const options of cases) {
    const { clock, button } = harness(options);
    button.click();
    await flush();
    clock.advance(2500);
    await flush();
    clock.advance(1800);
    await flush();

    assertResting(button, "Copy link");
    assert.equal(clock.pending, 0, "a copy attempt left a timer running");
  }
});

/* ── Repeated taps ─────────────────────────────────────────────────────── */

test("tapping repeatedly during an attempt does not start a second copy", async () => {
  const { clock, clipboard, button } = harness({ writeText: () => new Promise(() => {}) });

  button.click();
  await flush();
  button.click();
  button.click();
  await flush();

  assert.equal(clipboard.calls.length, 1, "an in-flight attempt must not be joined by others");
  assert.equal(button.textContent, "Copying link...");

  clock.advance(2500);
  await flush();
  clock.advance(1800);
  assertResting(button, "Copy link");
});

test("the button works again after an attempt finishes", async () => {
  const { clock, clipboard, button } = harness({ writeText: () => Promise.resolve() });

  await button.click();
  await flush();
  clock.advance(1800);
  assertResting(button, "Copy link");

  await button.click();
  await flush();

  assert.equal(clipboard.calls.length, 2, "a restored button must accept another copy");
  assert.equal(button.textContent, "Link copied");
  clock.advance(1800);
  assertResting(button, "Copy link");
});

/* ── The helper on its own ─────────────────────────────────────────────── */

test("copyPostLinkToClipboard reports which path copied, and rejects only when both fail", async () => {
  const viaApi = await XPosts.copyPostLinkToClipboard(URL, {
    navigator: makeClipboard(() => Promise.resolve()).navigator,
    document: makeDocument(false),
  });
  assert.equal(viaApi, "clipboard");

  const viaFallback = await XPosts.copyPostLinkToClipboard(URL, {
    navigator: {},
    document: makeDocument(true),
  });
  assert.equal(viaFallback, "fallback");

  await assert.rejects(
    XPosts.copyPostLinkToClipboard(URL, { navigator: {}, document: makeDocument(false) }),
    /Copy failed/,
  );
});

test("copyPostLinkToClipboard copies the URL and nothing else", async () => {
  const clipboard = makeClipboard(() => Promise.resolve());
  await XPosts.copyPostLinkToClipboard(URL, { navigator: clipboard.navigator, document: makeDocument(false) });

  assert.deepEqual(clipboard.calls, [URL]);
  // No handle, no post text, no trailing newline — the permalink alone.
  assert.equal(clipboard.calls[0], "https://x.com/alpha/status/1234567890");
});

test("an empty URL is refused rather than copied as an empty string", async () => {
  await assert.rejects(
    XPosts.copyPostLinkToClipboard("", { navigator: {}, document: makeDocument(true) }),
    /No link to copy/,
  );
});

/* ── The rendered card ─────────────────────────────────────────────────── */

// Both copy affordances on a card are rendered by renderPostCards, so the
// only honest way to check they share the protection is to render one.
function withFakeBrowser(doc, navigatorValue, clock, run) {
  const originals = {
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  globalThis.document = doc;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  Object.defineProperty(globalThis, "navigator", { value: navigatorValue, configurable: true, writable: true });

  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.setTimeout = originals.setTimeout;
      globalThis.clearTimeout = originals.clearTimeout;
      if (originals.document === undefined) delete globalThis.document;
      else globalThis.document = originals.document;
      if (originals.navigator) Object.defineProperty(globalThis, "navigator", originals.navigator);
      else delete globalThis.navigator;
    });
}

function findByClass(el, className, found = []) {
  if (el.className === className) found.push(el);
  (el.children || []).forEach((child) => findByClass(child, className, found));
  return found;
}

test("the visible permalink and the Copy link button share the same protection", async () => {
  const doc = makeDocument(false);
  const clock = makeClock();
  // The iOS failure again, this time through the real rendering path.
  const clipboard = makeClipboard(() => new Promise(() => {}));

  await withFakeBrowser(doc, clipboard.navigator, clock, async () => {
    const root = makeElement(doc, "div");
    XPosts.renderPostCards(root, [
      { id: "1", handle: "alpha", text: "hello", url: URL, publishedAt: "2026-08-27T10:00:00Z" },
    ]);

    const permalink = findByClass(root, "x-post-link")[0];
    const copyButton = findByClass(root, "x-post-copy")[0];
    assert.ok(permalink, "the card should still show the permalink");
    assert.ok(copyButton, "the card should still offer Copy link");

    const restingPermalink = permalink.textContent;
    assert.equal(restingPermalink, "x.com/alpha/status/1234567890");
    assert.equal(copyButton.textContent, "Copy link");

    for (const [button, resting] of [[permalink, restingPermalink], [copyButton, "Copy link"]]) {
      button.click();
      await flush();
      assert.equal(button.textContent, "Copying link...");
      assert.equal(button.disabled, true);

      clock.advance(2500);
      await flush();
      assert.equal(button.textContent, "Copy failed");

      clock.advance(1800);
      assertResting(button, resting);
    }

    assert.deepEqual(clipboard.calls, [URL, URL], "both affordances copy the exact post URL");
  });
});

test("the page's own setTimeout is called the way WebKit demands", async () => {
  // window.setTimeout throws "Illegal invocation" in WebKit and Blink when it
  // is stored and then called with any other receiver — which is precisely
  // what a card's button does with the page's clock. A clock that throws is
  // the stuck button all over again, so the global is modelled strictly here.
  const clock = makeClock();
  const strictClock = {
    setTimeout: function (fn, ms) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return clock.setTimeout(fn, ms);
    },
    clearTimeout: function (id) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return clock.clearTimeout(id);
    },
  };

  const doc = makeDocument(true);
  const clipboard = makeClipboard(() => Promise.reject(new Error("denied")));

  await withFakeBrowser(doc, clipboard.navigator, strictClock, async () => {
    const root = makeElement(doc, "div");
    XPosts.renderPostCards(root, [{ id: "1", handle: "alpha", text: "hi", url: URL }]);
    const copyButton = findByClass(root, "x-post-copy")[0];

    await copyButton.click();
    await flush();
    assert.equal(copyButton.textContent, "Link copied");

    clock.advance(1800);
    assertResting(copyButton, "Copy link");
  });
});

test("the Open button is untouched by the copy path", async () => {
  const doc = makeDocument(false);
  const clock = makeClock();

  await withFakeBrowser(doc, {}, clock, () => {
    const root = makeElement(doc, "div");
    XPosts.renderPostCards(root, [{ id: "1", handle: "alpha", text: "hi", url: URL }]);

    const open = findByClass(root, "x-post-open")[0];
    assert.equal(open.tagName, "a");
    assert.equal(open.href, URL);
    assert.equal(open.target, "_blank");
    assert.equal(open.rel, "noopener");
    assert.equal(open.textContent, "Open");
    assert.deepEqual(open.handlers.click, undefined, "Open must remain a plain link");
  });
});

test("the module keeps its browser global and its existing exports", () => {
  // x-intelligence.js reads window.XPosts.*; the UMD wrapper must not have
  // quietly changed what that object offers.
  for (const name of [
    "esc",
    "formatRelativeDate",
    "formatRelativeTime",
    "sortByPublishedDesc",
    "copyPostToClipboard",
    "copyPostLinkToClipboard",
    "renderPostCards",
    "renderFeedError",
    "renderStaleNotice",
    "renderFeedStatus",
  ]) {
    assert.equal(typeof XPosts[name], "function", `XPosts.${name} is missing`);
  }

  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/x-posts.js"), "utf8");
  assert.match(source, /root\.XPosts = api/, "the page still loads this file as a plain script");

  // And the two copy affordances go through one implementation, not two.
  assert.equal(source.match(/bindCopyLinkButton\(/g).length, 3, "both buttons must bind the shared helper");
  assert.doesNotMatch(source, /textContent = "Copying link\.\.\."[\s\S]{0,400}navigator\.clipboard/);
});

test("the copy labels are the ones the acceptance criteria name", () => {
  assert.deepEqual(XPosts.COPY_LINK_LABELS, {
    busy: "Copying link...",
    success: "Link copied",
    failure: "Copy failed",
  });
});
