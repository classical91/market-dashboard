"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const {
  BroadcastLedgerStore,
  canonicalizeUrl,
  hashText,
  deriveStatus,
} = require("../src/services/broadcast-ledger");

function freshStore(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-"));
  return new BroadcastLedgerStore({ dataDir, logger: { error() {} }, ...options });
}

/* ── URL canonicalization ── */

test("canonicalizeUrl collapses the variations of one article into one key", () => {
  const expected = "https://example.com/news/story";
  assert.equal(canonicalizeUrl("https://www.example.com/news/story"), expected);
  assert.equal(canonicalizeUrl("http://EXAMPLE.com/news/story/"), expected);
  assert.equal(canonicalizeUrl("https://example.com/news/story?utm_source=twitter&fbclid=abc"), expected);
  assert.equal(canonicalizeUrl("https://example.com/news/story#section-2"), expected);
  assert.equal(canonicalizeUrl("https://example.com:443/news/story"), expected);
});

test("canonicalizeUrl keeps meaningful query params and sorts them", () => {
  assert.equal(canonicalizeUrl("https://x.com/p?b=2&a=1"), "https://x.com/p?a=1&b=2");
});

test("canonicalizeUrl rejects non-http and unparseable input", () => {
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
  assert.equal(canonicalizeUrl("not a url"), null);
  assert.equal(canonicalizeUrl(""), null);
  assert.equal(canonicalizeUrl(null), null);
});

test("hashText ignores casing, emoji, links and spacing", () => {
  const a = hashText("🚨 BREAKING:  Fed  holds rates — https://ex.com/a");
  const b = hashText("breaking fed holds rates");
  assert.ok(a);
  assert.equal(a, b);
});

/* ── idempotency ── */

test("posting the same idempotency key twice creates exactly one receipt", () => {
  const store = freshStore();
  const payload = { source: "shortcut", title: "Fed holds rates", idempotencyKey: "shortcut-run-1" };

  const first = store.createReceipt(payload);
  const second = store.createReceipt(payload);
  const third = store.createReceipt(payload);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(third.created, false);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(store.count(), 1);
});

test("a repeat idempotency key advances the receipt instead of forking it", () => {
  const store = freshStore();
  store.createReceipt({ source: "shortcut", title: "Story", idempotencyKey: "k1", status: "pending" });
  const { receipt, created } = store.createReceipt({
    source: "shortcut",
    title: "Story",
    idempotencyKey: "k1",
    status: "posted",
  });

  assert.equal(created, false);
  assert.equal(receipt.status, "posted");
  assert.equal(store.count(), 1);
});

test("receipts without an idempotency key are never merged together", () => {
  const store = freshStore();
  store.createReceipt({ source: "manual", title: "One" });
  store.createReceipt({ source: "manual", title: "Two" });
  assert.equal(store.count(), 2);
});

/* ── dedupe tiers ── */

test("tier 1: a posted story is found again by its canonical URL", () => {
  const store = freshStore();
  store.createReceipt({
    source: "shortcut",
    title: "Fed holds rates",
    url: "https://www.example.com/news/fed?utm_source=x",
    status: "posted",
  });

  const result = store.lookup({ url: "http://example.com/news/fed/" });
  assert.equal(result.posted, true);
  assert.equal(result.match, "url");
  assert.equal(result.receipt.source, "shortcut");
});

test("tier 2: a URL-less story is found by its normalized content hash", () => {
  const store = freshStore();
  store.createReceipt({ source: "manual", title: "Fed holds rates", text: "Fed holds rates steady", status: "posted" });

  const result = store.lookup({ text: "FED HOLDS   RATES steady!!" });
  assert.equal(result.posted, true);
  assert.equal(result.match, "hash");
});

test("tier 3 is advisory only — a headline match never claims the story was posted", () => {
  const store = freshStore();
  store.createReceipt({
    source: "sharebot67",
    title: "Ethereum upgrade ships this week",
    url: "https://a.com/eth-upgrade",
    status: "posted",
  });

  const result = store.lookup({ headline: "Ethereum upgrade ships this week" });
  assert.equal(result.posted, false, "a headline match must not suppress a story on its own");
  assert.equal(result.match, "likely");
  assert.equal(result.candidates.length, 1);
});

test("tier 3 does not match outside its time window", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({
    source: "manual",
    title: "Ethereum upgrade ships this week",
    status: "posted",
  });

  // Age the stored receipt past the default 36h window. Yesterday's headline
  // must not suppress a genuinely new story that happens to be worded alike.
  const raw = JSON.parse(fs.readFileSync(store._file, "utf8"));
  raw.receipts.find((r) => r.id === receipt.id).createdAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(store._file, JSON.stringify(raw), "utf8");

  assert.equal(store.lookup({ headline: "Ethereum upgrade ships this week" }).match, "none");
});

test("an unposted story looks up clean", () => {
  const store = freshStore();
  store.createReceipt({ source: "manual", title: "Something else", url: "https://a.com/other", status: "posted" });

  const result = store.lookup({ url: "https://a.com/brand-new" });
  assert.equal(result.posted, false);
  assert.equal(result.match, "none");
  assert.equal(result.receipt, null);
});

test("a pending receipt is not evidence the story was broadcast", () => {
  const store = freshStore();
  store.createReceipt({ source: "sharebot67", title: "Pending story", url: "https://a.com/p", status: "pending" });

  assert.equal(store.lookup({ url: "https://a.com/p" }).posted, false);
});

/* ── partial delivery and retries ── */

test("deriveStatus reports partial when only some destinations landed", () => {
  assert.equal(deriveStatus([{ status: "posted" }, { status: "failed" }]), "partial");
  assert.equal(deriveStatus([{ status: "posted" }, { status: "posted" }]), "posted");
  assert.equal(deriveStatus([{ status: "failed" }, { status: "failed" }]), "failed");
  assert.equal(deriveStatus([]), null);
});

test("recording destination results one channel at a time yields a partial receipt", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({
    source: "sharebot67",
    title: "Story",
    url: "https://a.com/s",
    status: "pending",
    destinations: [
      { channel: "telegram", chatId: "-1001" },
      { channel: "telegram", chatId: "-1002" },
    ],
  });

  store.updateReceipt(receipt.id, {
    destinations: [{ channel: "telegram", chatId: "-1001", status: "posted", messageId: "55" }],
  });
  const updated = store.updateReceipt(receipt.id, {
    destinations: [{ channel: "telegram", chatId: "-1002", status: "failed", error: "chat not found" }],
  });

  assert.equal(updated.status, "partial");
  assert.equal(updated.destinations.length, 2, "destinations merge by channel+chat, they do not duplicate");
  assert.equal(updated.destinations.find((d) => d.chatId === "-1001").messageId, "55");
  assert.equal(updated.destinations.find((d) => d.chatId === "-1002").status, "failed");
});

test("a retry that succeeds flips the failed channel to posted", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({
    source: "sharebot67",
    title: "Story",
    status: "pending",
    destinations: [{ channel: "telegram", chatId: "-1002", status: "failed", error: "timeout" }],
  });
  assert.equal(receipt.status, "failed");

  const retried = store.updateReceipt(receipt.id, {
    destinations: [{ channel: "telegram", chatId: "-1002", status: "posted", messageId: "77" }],
    error: null,
    action: "retry",
  });

  assert.equal(retried.status, "posted");
  assert.equal(retried.destinations.length, 1);
  assert.equal(retried.error, null);
});

test("a posted receipt is never walked back to pending by a late result", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({ source: "shortcut", title: "Story", status: "posted" });
  const updated = store.updateReceipt(receipt.id, {
    destinations: [{ channel: "telegram", chatId: "-1", status: "pending" }],
  });
  assert.equal(updated.status, "posted");
});

test("every mutation appends to the audit trail", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({ source: "sharebot67", title: "Story", status: "pending" });
  store.updateReceipt(receipt.id, { status: "posted", action: "broadcast" }, { actor: "sharebot67" });
  const final = store.getReceipt(receipt.id);

  assert.equal(final.attempts.length, 2);
  assert.equal(final.attempts[0].action, "create");
  assert.equal(final.attempts[1].action, "broadcast");
  assert.equal(final.attempts[1].actor, "sharebot67");
  assert.equal(final.attempts[1].ok, true);
});

/* ── offline reconciliation ── */

test("reconcile resolves a pending agent receipt against a manual post of the same story", () => {
  const store = freshStore();
  // ShareBot67 started the story, then the gateway went down.
  const { receipt: pending } = store.createReceipt({
    source: "sharebot67",
    title: "Fed holds rates",
    url: "https://example.com/news/fed",
    status: "pending",
  });
  // Meanwhile it was posted by hand.
  const { receipt: manual } = store.createReceipt({
    source: "manual",
    title: "Fed holds rates",
    url: "https://www.example.com/news/fed?utm_source=telegram",
    status: "posted",
  });

  const result = store.reconcile({});

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.outstanding.length, 0);
  assert.equal(result.reconciled[0].id, pending.id);
  assert.equal(result.reconciled[0].reconciledWith, manual.id);
  assert.equal(store.getReceipt(pending.id).status, "reconciled");
});

test("reconcile reports genuinely unsent work as outstanding rather than resolving it", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({
    source: "sharebot67",
    title: "Never sent",
    url: "https://example.com/never",
    status: "failed",
  });

  const result = store.reconcile({});
  assert.equal(result.reconciled.length, 0);
  assert.equal(result.outstanding.length, 1);
  assert.equal(result.outstanding[0].id, receipt.id);
  assert.equal(store.getReceipt(receipt.id).status, "failed", "outstanding work keeps its status");
});

test("reconcile matches on content hash when no URL is available", () => {
  const store = freshStore();
  const { receipt: pending } = store.createReceipt({
    source: "sharebot67",
    title: "Rate decision",
    text: "Fed holds rates steady",
    status: "pending",
  });
  store.createReceipt({ source: "shortcut", title: "Rate decision", text: "FED HOLDS RATES STEADY", status: "posted" });

  const result = store.reconcile({});
  assert.equal(result.reconciled.length, 1);
  assert.equal(store.getReceipt(pending.id).status, "reconciled");
});

test("a reconciled receipt counts as posted, so the story is not broadcast again", () => {
  const store = freshStore();
  store.createReceipt({ source: "sharebot67", title: "S", url: "https://e.com/s", status: "pending" });
  store.createReceipt({ source: "manual", title: "S", url: "https://e.com/s", status: "posted" });
  store.reconcile({});

  const result = store.lookup({ url: "https://e.com/s" });
  assert.equal(result.posted, true);
});

test("reconcile can be scoped to explicit ids", () => {
  const store = freshStore();
  const { receipt: a } = store.createReceipt({ source: "sharebot67", title: "A", url: "https://e.com/a", status: "pending" });
  store.createReceipt({ source: "sharebot67", title: "B", url: "https://e.com/b", status: "pending" });
  store.createReceipt({ source: "manual", title: "A", url: "https://e.com/a", status: "posted" });

  const result = store.reconcile({ ids: [a.id] });
  assert.equal(result.checked, 1);
  assert.equal(result.reconciled.length, 1);
});

/* ── durability ── */

test("receipts survive a new store instance over the same directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-persist-"));
  const first = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  first.createReceipt({ source: "manual", title: "Survives", url: "https://e.com/x", status: "posted" });

  const second = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  assert.equal(second.count(), 1);
  assert.equal(second.lookup({ url: "https://e.com/x" }).posted, true);
});

test("the ledger file is capped so it cannot grow without bound", () => {
  const store = freshStore({ cap: 3 });
  for (let i = 0; i < 6; i += 1) store.createReceipt({ source: "manual", title: `Story ${i}` });
  assert.equal(store.count(), 3);
  assert.equal(store.list({ limit: 10 })[0].title, "Story 5", "newest receipts are the ones kept");
});

test("message bodies are hashed, never stored", () => {
  const store = freshStore();
  const { receipt } = store.createReceipt({
    source: "manual",
    title: "Private",
    text: "a private message body that must not be persisted",
    status: "posted",
  });
  const raw = fs.readFileSync(path.join(path.dirname(store._file), "broadcast-ledger.json"), "utf8");

  assert.ok(receipt.contentHash);
  assert.ok(!raw.includes("must not be persisted"));
});
