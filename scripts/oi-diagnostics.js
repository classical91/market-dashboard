#!/usr/bin/env node
"use strict";

// Cross-Market Open Interest — accuracy diagnostics.
//
// Prints, per market, every input behind the displayed number: source,
// contract code and reported name, scope, the two observations and their
// dates, the calculated change, roll and staleness flags. With --cftc it also
// fetches the raw CFTC rows independently, recomputes the change from them
// and reports any difference, so the page can be checked against the source
// rather than against a chart that measures something else.
//
//   node scripts/oi-diagnostics.js [--url <base>] [--timeframe W|D]
//                                  [--lookback 1w|4w|1d|5d] [--cftc] [--json]
//
// --url defaults to http://localhost:$PORT (PORT defaults to 3000).

const args = process.argv.slice(2);
function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = args[at + 1];
  return next && !next.startsWith("--") ? next : true;
}

const base = String(flag("url", `http://localhost:${process.env.PORT || 3000}`)).replace(/\/+$/, "");
const timeframe = flag("timeframe", "W") === "D" ? "D" : "W";
const lookback = String(flag("lookback", timeframe === "D" ? "1d" : "1w"));
const withCftc = flag("cftc", false) === true;
const asJson = flag("json", false) === true;

function pct(cur, prev) {
  return typeof cur === "number" && typeof prev === "number" && prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

function fmt(v, digits = 2) {
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "—";
  return typeof v === "number" ? (Number.isInteger(v) && digits === 0 ? v.toLocaleString("en-US") : v.toFixed(digits)) : String(v);
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function cftcRows(codes, sinceDate) {
  const quoted = codes.map((c) => `'${String(c).replace(/'/g, "")}'`).join(",");
  const params = new URLSearchParams({
    $select: "market_and_exchange_names,report_date_as_yyyy_mm_dd,cftc_contract_market_code,open_interest_all",
    $where: `cftc_contract_market_code in(${quoted}) AND report_date_as_yyyy_mm_dd >= '${sinceDate}T00:00:00'`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "5000",
  });
  const headers = process.env.CFTC_APP_TOKEN ? { "X-App-Token": process.env.CFTC_APP_TOKEN } : {};
  const rows = await fetchJson(`https://publicreporting.cftc.gov/resource/6dca-aqww.json?${params}`, headers);
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.cftc_contract_market_code}|${String(r.report_date_as_yyyy_mm_dd).slice(0, 10)}`, r);
  return byKey;
}

async function main() {
  const snap = await fetchJson(`${base}/api/cross-market-oi?timeframe=${timeframe}&lookback=${encodeURIComponent(lookback)}`);
  const selection = new Set(snap.defaultSelection || []);
  const rows = snap.rows.filter((r) => r.metricType === "OI" && (selection.size === 0 || selection.has(r.id)));

  let reference = null;
  if (withCftc && timeframe === "W") {
    const since = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
    try {
      reference = await cftcRows(rows.map((r) => r.contract), since);
    } catch (err) {
      console.error(`CFTC cross-check unavailable: ${err.message}`);
    }
  }

  const table = rows.map((r) => {
    const out = {
      instrument: `${r.marketName} (${r.symbol})`,
      source: r.source,
      contract: r.contract,
      reportName: r.reportName,
      identityVerified: r.identityVerified,
      scope: r.contractScope,
      expiration: r.expiration,
      oi: r.currentValue,
      observationDate: r.observationDate,
      previousOi: r.previousValue,
      comparisonDate: r.comparisonDate,
      changePct: r.changePct,
      recomputedPct: pct(r.currentValue, r.previousValue),
      valueStatus: r.valueStatus,
      statusReason: r.statusReason || r.error || null,
      rollWindow: r.rollWindow,
      rollExpiry: r.rollExpiry,
      isStale: r.isStale,
      isFallback: r.isFallback,
      isPreliminary: r.isPreliminary,
      retrievedAt: r.retrievedAt,
    };
    if (reference) {
      const cur = reference.get(`${r.contract}|${r.observationDate}`);
      const prev = reference.get(`${r.contract}|${r.comparisonDate}`);
      const refCur = cur ? Number(cur.open_interest_all) : null;
      const refPrev = prev ? Number(prev.open_interest_all) : null;
      out.referenceOi = refCur;
      out.referencePreviousOi = refPrev;
      out.referencePct = pct(refCur, refPrev);
      out.difference = out.referencePct != null && r.changePct != null ? r.changePct - out.referencePct : null;
      out.status = refCur == null
        ? "UNVERIFIED — no CFTC row for that date"
        : refCur === r.currentValue && (refPrev === r.previousValue || r.previousValue == null) ? "MATCH" : "MISMATCH";
    }
    return out;
  });

  if (asJson) {
    console.log(JSON.stringify({ fetchedFrom: base, timeframe: snap.timeframe, lookback: snap.lookback, source: snap.source, metric: snap.metrics.find((m) => m.type === "OI"), rows: table }, null, 2));
    return;
  }

  console.log(`Cross-Market OI diagnostics · ${base} · ${snap.timeframe} Δ${snap.lookback}`);
  console.log(`Source: ${snap.source.label} · status ${snap.source.status} · report ${snap.source.reportDate} · fetched ${snap.source.fetchedAt}`);
  const metric = snap.metrics.find((m) => m.type === "OI");
  console.log(`Metric: ${metric.label} — ${metric.plotted}\n`);
  for (const t of table) {
    console.log(`${t.instrument}`);
    console.log(`  contract ${t.contract} · "${fmt(t.reportName)}" · identity ${t.identityVerified === true ? "verified" : t.identityVerified === false ? "MISMATCH" : "unchecked"} · scope ${t.scope} · expiration ${fmt(t.expiration)}`);
    console.log(`  OI ${fmt(t.oi, 0)} on ${fmt(t.observationDate)} vs ${fmt(t.previousOi, 0)} on ${fmt(t.comparisonDate)} → ${fmt(t.changePct)}% (recomputed ${fmt(t.recomputedPct)}%) · ${t.valueStatus}${t.statusReason ? ` — ${t.statusReason}` : ""}`);
    console.log(`  roll ${t.rollWindow ? `yes (expiry ${t.rollExpiry})` : "no"} · stale ${t.isStale} · fallback ${t.isFallback} · preliminary ${t.isPreliminary == null ? "unknown" : t.isPreliminary} · retrieved ${fmt(t.retrievedAt)}`);
    if (reference) {
      console.log(`  CFTC direct: ${fmt(t.referenceOi, 0)} vs ${fmt(t.referencePreviousOi, 0)} → ${fmt(t.referencePct)}% · diff ${fmt(t.difference)} pp · ${t.status}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
