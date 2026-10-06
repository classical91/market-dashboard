"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const LEDGER_KEY = "test-ledger-key";
const ADMIN_KEY = "test-admin-key";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-news-log-routes-"));
process.env.BROADCAST_LEDGER_API_KEY = LEDGER_KEY;
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Site login ON so the machine-caller bypass is exercised.
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "site-password";

const { createApp } = require("../src/app");
const { ReporterNewsLogStore, dayKey } = require("../src/services/reporter-news-log");

function newStore() {
  return new ReporterNewsLogStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-news-log-")),
    logger: { error() {} },
  });
}

const baseItem = {
  url: "https://www.example.com/markets/fed-holds?utm_source=x&fbclid=abc",
  headline: "Fed holds rates steady as inflation cools",
  source: "Reuters",
  market: "Economics",
  symbols: ["$SPY", "dxy"],
  publishedAt: "2026-10-05T15:00:00Z",
  capturedAt: "2026-10-05T16:00:00Z",
  capturedBy: "sharebot67",
};

test("intake creates a verified record with Vancouver reporter date", () => {
  const store = newStore();
  const { record, created, deduplicated } = store.intake(baseItem);
  assert.equal(created, true);
  assert.equal(deduplicated, false);
  assert.equal(record.status, "verified");
  assert.equal(record.approval, "pending");
  assert.equal(record.canonicalUrl, "https://example.com/markets/fed-holds");
  assert.equal(record.market, "economics");
  assert.deepEqual(record.symbols, ["SPY", "DXY"]);
  assert.equal(record.reporterDate, "2026-10-05");
});

test("reporter date follows America/Vancouver, not UTC", () => {
  // 03:00 UTC on Oct 6 is still Oct 5 in Vancouver (PDT, UTC-7).
  assert.equal(dayKey("2026-10-06T03:00:00Z", "America/Vancouver"), "2026-10-05");
});

test("repeat submissions with tracking params dedupe onto one record", () => {
  const store = newStore();
  const first = store.intake(baseItem);
  const second = store.intake({
    ...baseItem,
    url: "http://example.com/markets/fed-holds/?utm_campaign=y",
    summary: "Policy unchanged.",
    symbols: ["TLT"],
  });
  assert.equal(second.created, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.intakeCount, 2);
  assert.equal(second.record.summary, "Policy unchanged.");
  assert.deepEqual(second.record.symbols, ["SPY", "DXY", "TLT"]);
  assert.equal(store.daily({ date: "2026-10-05" }).total, 1);
});

test("dedupes on source + sourceId when there is no URL", () => {
  const store = newStore();
  const a = store.intake({ headline: "Wire item", source: "Bloomberg", sourceId: "B-1" });
  const b = store.intake({ headline: "Wire item", source: "bloomberg", sourceId: "B-1" });
  assert.equal(a.record.id, b.record.id);
  assert.throws(() => store.intake({ headline: "No identity" }), /both source and sourceId/);
});

test("URL-less dedupe needs both source and sourceId", () => {
  const store = newStore();
  assert.throws(() => store.intake({ headline: "Orphan id", sourceId: "123" }), (err) => err.statusCode === 400);
  assert.throws(() => store.intake({ headline: "Orphan source", source: "Reuters" }), (err) => err.statusCode === 400);
  const a = store.intake({ headline: "Item 123", source: "Reuters", sourceId: "123" });
  const b = store.intake({ headline: "Item 123", source: "Bloomberg", sourceId: "123" });
  assert.notEqual(a.record.id, b.record.id, "same ID from different sources stays separate");
  assert.equal(store.find({ sourceId: "123" }), null);
});

test("intake cannot claim approved, queued or posted", () => {
  const store = newStore();
  for (const status of ["approved", "queued", "posted"]) {
    assert.throws(() => store.intake({ ...baseItem, status }), (err) => err.statusCode === 400);
  }
});

test("repeat intake never regresses a record's workflow", () => {
  const store = newStore();
  const { record } = store.intake(baseItem);
  store.update(record.id, { status: "approved" });
  const again = store.intake({ ...baseItem, status: "discovered" });
  assert.equal(again.record.status, "approved");
});

test("workflow requires evidence for queued, posted and failed", () => {
  const store = newStore();
  const { record } = store.intake(baseItem);
  assert.throws(() => store.update(record.id, { status: "queued" }), (err) => err.statusCode === 409);
  store.update(record.id, { status: "approved" });
  assert.throws(() => store.update(record.id, { status: "queued" }), /queueId/);
  const queued = store.update(record.id, { status: "queued", farmbot: { queueId: "fb_1", scheduledAt: "2026-10-05T18:00:00Z", status: "scheduled" } });
  assert.equal(queued.farmbot.queueId, "fb_1");
  assert.throws(() => store.update(record.id, { status: "posted", farmbot: { status: "ok" } }), /publication/);
  assert.throws(() => store.update(record.id, { status: "failed" }), /exact error/);
  const posted = store.update(record.id, { status: "posted", farmbot: { publication: { receiptId: "rcpt_9", postedAt: "2026-10-05T18:01:00Z" } } });
  assert.equal(posted.status, "posted");
  // Status-only patch keeps the queue ID recorded earlier.
  assert.equal(posted.farmbot.queueId, "fb_1");
  assert.throws(() => store.update(record.id, { status: "verified" }), (err) => err.statusCode === 409);
});

test("network failure stays failed with its exact error", () => {
  const store = newStore();
  const { record } = store.intake(baseItem);
  store.update(record.id, { status: "approved" });
  const failed = store.update(record.id, { status: "failed", error: "TLS handshake timeout to farmbot" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "TLS handshake timeout to farmbot");
  assert.equal(failed.farmbot.queueId, null);
});

test("daily view filters and counts", () => {
  const store = newStore();
  store.intake(baseItem);
  const btc = store.intake({ url: "https://coindesk.com/btc", headline: "Bitcoin ETF inflows hit record", source: "CoinDesk", market: "Crypto", symbols: ["BTC"], capturedAt: "2026-10-05T17:00:00Z" });
  store.update(btc.record.id, { status: "rejected" });
  store.intake({ url: "https://example.com/next-day", headline: "Next day story here", source: "Reuters", capturedAt: "2026-10-06T17:00:00Z" });

  const day = store.daily({ date: "2026-10-05" });
  assert.equal(day.total, 2);
  assert.equal(day.counts.verified, 1);
  assert.equal(day.counts.rejected, 1);
  assert.deepEqual(day.facets.sources, ["CoinDesk", "Reuters"]);
  assert.equal(store.daily({ date: "2026-10-05", market: "crypto" }).total, 1);
  assert.equal(store.daily({ date: "2026-10-05", symbol: "btc" }).records.length, 1);
  assert.equal(store.daily({ date: "2026-10-05", source: "reuters" }).total, 1);
  const filtered = store.daily({ date: "2026-10-05", status: "verified" });
  assert.equal(filtered.records.length, 1);
  assert.equal(filtered.counts.rejected, 1, "counts describe the day, not the status filter");
  assert.deepEqual(store.days().map((d) => d.date), ["2026-10-06", "2026-10-05"]);
});

function advance(store, id, statuses) {
  const evidence = {
    queued: { farmbot: { queueId: "fb_1" } },
    posted: { farmbot: { publication: { receiptId: "rcpt_1" } } },
  };
  statuses.forEach((status) => store.update(id, { status, ...evidence[status] }));
}

test("a failure resumes only at the stage it failed from", () => {
  const store = newStore();
  const queue = { status: "queued", farmbot: { queueId: "fb_retry" } };
  const fail = { status: "failed", error: "ECONNRESET" };

  const discovered = store.intake({ ...baseItem, url: "https://example.com/a", status: "discovered" }).record;
  store.update(discovered.id, fail);
  assert.equal(store.get(discovered.id).failedFrom, "discovered");
  assert.throws(() => store.update(discovered.id, queue), (err) => err.statusCode === 409);
  assert.throws(() => store.update(discovered.id, { status: "approved" }), (err) => err.statusCode === 409);
  assert.equal(store.update(discovered.id, { status: "verified" }).status, "verified");

  const verified = store.intake({ ...baseItem, url: "https://example.com/b" }).record;
  store.update(verified.id, fail);
  assert.throws(() => store.update(verified.id, queue), (err) => err.statusCode === 409);
  assert.equal(store.update(verified.id, { status: "approved" }).status, "approved");

  const approved = store.intake({ ...baseItem, url: "https://example.com/c" }).record;
  advance(store, approved.id, ["approved"]);
  store.update(approved.id, fail);
  assert.throws(() => store.update(approved.id, { status: "queued" }), /queueId/);
  const requeued = store.update(approved.id, queue);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.error, null, "the stale error is cleared on recovery");
  assert.equal(requeued.failedFrom, undefined);

  const queued = store.intake({ ...baseItem, url: "https://example.com/d" }).record;
  advance(store, queued.id, ["approved", "queued"]);
  store.update(queued.id, fail);
  assert.equal(store.update(queued.id, queue).status, "queued");
});

test("legacy failed records without failedFrom cannot skip approval", () => {
  const store = newStore();
  const { record } = store.intake(baseItem);
  store.update(record.id, { status: "failed", error: "boom" });
  // Simulate a record written before failedFrom existed.
  const fs2 = require("node:fs");
  const doc = JSON.parse(fs2.readFileSync(store._file, "utf8"));
  delete doc.records[0].failedFrom;
  fs2.writeFileSync(store._file, JSON.stringify(doc));
  assert.throws(() => store.update(record.id, { status: "queued", farmbot: { queueId: "x" } }), (err) => err.statusCode === 409);
  assert.equal(store.update(record.id, { status: "approved" }).status, "approved");
});

test("receipt evidence cannot be erased after the status is set", () => {
  const store = newStore();
  const queued = store.intake({ ...baseItem, url: "https://example.com/q" }).record;
  advance(store, queued.id, ["approved", "queued"]);
  assert.throws(() => store.update(queued.id, { farmbot: { queueId: null } }), /queueId/);
  assert.throws(() => store.update(queued.id, { status: "queued", farmbot: { queueId: "" } }), /queueId/);
  assert.equal(store.get(queued.id).farmbot.queueId, "fb_1", "a refused patch changes nothing");

  const posted = store.intake({ ...baseItem, url: "https://example.com/p" }).record;
  advance(store, posted.id, ["approved", "queued", "posted"]);
  assert.throws(() => store.update(posted.id, { farmbot: { publication: null } }), /publication/);
  assert.throws(() => store.update(posted.id, { farmbot: { publication: {} } }), /publication/);
  assert.equal(store.get(posted.id).farmbot.publication.receiptId, "rcpt_1");
  // Metadata-only patches that keep the evidence still work.
  assert.equal(store.update(posted.id, { farmbot: { lastCheckedAt: "2026-10-05T20:00:00Z" } }).status, "posted");

  const failed = store.intake({ ...baseItem, url: "https://example.com/f" }).record;
  store.update(failed.id, { status: "failed", error: "TLS handshake timeout" });
  assert.throws(() => store.update(failed.id, { error: "" }), /exact error/);
  assert.throws(() => store.update(failed.id, { error: null, summary: "x" }), /exact error/);
  assert.equal(store.get(failed.id).error, "TLS handshake timeout");
  assert.equal(store.get(failed.id).summary, null, "a refused patch changes nothing");
});

test("reporterDate is always derived from capturedAt in Vancouver", () => {
  const store = newStore();
  const { record } = store.intake({ ...baseItem, capturedAt: "2026-10-05T16:00:00Z", reporterDate: "2026-10-06" });
  assert.equal(record.reporterDate, "2026-10-05", "a conflicting caller-supplied date is ignored");
  // Midnight rollover: 06:59Z is 23:59 PDT on the 5th, 07:00Z is 00:00 on the 6th.
  assert.equal(dayKey("2026-10-06T06:59:59Z", "America/Vancouver"), "2026-10-05");
  assert.equal(dayKey("2026-10-06T07:00:00Z", "America/Vancouver"), "2026-10-06");
  // DST end (Nov 1 2026, PDT -> PST): midnight moves from 07:00Z to 08:00Z.
  assert.equal(dayKey("2026-11-02T07:30:00Z", "America/Vancouver"), "2026-11-01");
  assert.equal(dayKey("2026-11-02T08:00:00Z", "America/Vancouver"), "2026-11-02");
  // DST start (Mar 8 2026, PST -> PDT).
  assert.equal(dayKey("2026-03-08T07:30:00Z", "America/Vancouver"), "2026-03-07");
  assert.equal(dayKey("2026-03-09T07:00:00Z", "America/Vancouver"), "2026-03-09");
});

test("caller attribution is kept apart from the trusted actor", () => {
  const store = newStore();
  const { record } = store.intake({ ...baseItem, capturedBy: "sharebot67" }, { actor: "shared-key" });
  const updated = store.update(record.id, { status: "approved" }, { actor: "shared-key", claimedBy: "penny" });
  const [logged, approved] = updated.history;
  assert.deepEqual([logged.actor, logged.claimedBy], ["shared-key", "sharebot67"]);
  assert.deepEqual([approved.actor, approved.claimedBy], ["shared-key", "penny"]);
});

test("a failed write is not reported as a durable receipt", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-news-log-ro-"));
  // A non-empty directory where the log file should be makes the atomic
  // rename fail, exactly like a full or read-only volume would.
  fs.mkdirSync(path.join(dataDir, "reporter-news-log.json", "blocker"), { recursive: true });
  const store = new ReporterNewsLogStore({ dataDir, logger: { error() {} } });
  assert.throws(() => store.intake(baseItem), (err) => err.statusCode === 503);
});

test("routes: intake receipt, dedupe, auth and daily view", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, pathname, body, key = LEDGER_KEY) => fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-broadcast-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const unauth = await send("POST", "/api/reporter-news/intake", baseItem, null);
    assert.equal(unauth.status, 401);
    const wrongKey = await send("POST", "/api/reporter-news/intake", baseItem, "wrong-key");
    assert.equal(wrongKey.status, 401);
    const unauthPatch = await send("PATCH", "/api/reporter-news/rnl_x", { status: "approved" }, null);
    assert.equal(unauthPatch.status, 401);

    const created = await send("POST", "/api/reporter-news/intake", baseItem);
    assert.equal(created.status, 201);
    const receipt = await created.json();
    assert.equal(receipt.created, true);
    assert.ok(receipt.id.startsWith("rnl_"));

    const repeat = await send("POST", "/api/reporter-news/intake", baseItem);
    assert.equal(repeat.status, 200);
    const repeatBody = await repeat.json();
    assert.equal(repeatBody.deduplicated, true);
    assert.equal(repeatBody.id, receipt.id);

    const bad = await send("PATCH", `/api/reporter-news/${receipt.id}`, { status: "posted" });
    assert.equal(bad.status, 409);

    const approved = await send("PATCH", `/api/reporter-news/${receipt.id}`, { status: "approved", actor: "penny" });
    assert.equal(approved.status, 200);
    const approvedEntry = (await approved.json()).record.history.at(-1);
    assert.equal(approvedEntry.actor, "shared-key", "the body cannot set the trusted actor");
    assert.equal(approvedEntry.claimedBy, "penny");

    const sourceless = await send("POST", "/api/reporter-news/intake", { headline: "No source", sourceId: "9" });
    assert.equal(sourceless.status, 400);

    // Concurrent duplicates collapse onto one record.
    const concurrent = await Promise.all([1, 2, 3, 4].map(() =>
      send("POST", "/api/reporter-news/intake", { ...baseItem, url: "https://example.com/race" }).then((r) => r.json())));
    assert.equal(new Set(concurrent.map((r) => r.id)).size, 1);
    assert.equal(concurrent.filter((r) => r.created).length, 1);

    const daily = await send("GET", `/api/reporter-news/daily?date=${receipt.reporterDate}`);
    assert.equal(daily.status, 200);
    const day = await daily.json();
    assert.equal(day.total, 2, "the approved record plus the one concurrent-race record");
    assert.equal(day.counts.approved, 1);

    const lookup = await (await send("GET", `/api/reporter-news/lookup?url=${encodeURIComponent("https://example.com/markets/fed-holds")}`)).json();
    assert.equal(lookup.found, true);

    const missing = await send("PATCH", "/api/reporter-news/rnl_missing", { status: "approved" });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
