/* Presentation-only summaries of the existing screener APIs. No indicator is re-scored. */
(function (root) {
  "use strict";
  function count(rows, predicate) { return rows.filter(predicate).length; }
  function num(value, digits) { return Number.isFinite(value) ? value.toFixed(digits == null ? 1 : digits) : "—"; }
  function pct(value) { return Number.isFinite(value) ? (value > 0 ? "+" : "") + num(value) + "%" : "—"; }
  function usd(value) {
    if (!Number.isFinite(value)) return "—";
    if (value >= 1e9) return "$" + num(value / 1e9, 2) + "B";
    if (value >= 1e6) return "$" + num(value / 1e6, 1) + "M";
    return "$" + num(value, 0);
  }
  function tone(value) { return value > 0 ? "bull" : value < 0 ? "bear" : "flat"; }
  function metric(label, value, color) { return { label: label, value: value, tone: color || "flat" }; }
  function reading(label, value, color) { return { label: label, value: value, tone: color || "flat" }; }
  function health(rows) {
    return {
      unavailable: count(rows, function (r) { return Boolean(r.error); }),
      notFresh: count(rows, function (r) { return !r.error && (!r.freshness || r.freshness.state !== "FRESH"); }),
    };
  }
  function lean(bullish, bearish) { return bullish > bearish ? "RISK ON" : bearish > bullish ? "RISK OFF" : "BALANCED"; }
  function directional(data) {
    var rows = data.results || [], usable = rows.filter(function (r) { return !r.error && r.bias; });
    var bull = count(usable, function (r) { return r.bias === "BULLISH"; });
    var bear = count(usable, function (r) { return r.bias === "BEARISH"; });
    return {
      lead: usable.length ? lean(bull, bear) : "UNAVAILABLE", tone: tone(bull - bear), health: health(rows),
      subtitle: (bull + bear) + " with a directional bias", total: usable.length,
      metrics: [metric("▲ Bullish", bull, "bull"), metric("▼ Bearish", bear, "bear"), metric("Neutral", count(usable, function (r) { return r.bias === "NEUTRAL"; }))],
      readings: usable.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).slice(0, 3).map(function (r) {
        return reading(r.symbol, r.bias + " · " + num(r.score, 0) + "% agreement", r.bias === "BULLISH" ? "bull" : r.bias === "BEARISH" ? "bear" : "flat");
      }),
      note: "RSI · MACD · VWAP · volume · EMA20/50 · EMA200. Score measures agreement, not an entry.",
    };
  }
  function extremes(data) {
    var rows = data.results || [], usable = rows.filter(function (r) { return !r.error; });
    var active = usable.filter(function (r) { return r.state && r.state !== "NONE"; });
    return {
      lead: usable.length ? active.length + " ACTIVE EXTREMES" : "UNAVAILABLE", tone: "flat", total: usable.length, health: health(rows),
      subtitle: "Location inside the move",
      metrics: [metric("↓ Bottom-led", count(usable, function (r) { return r.dominant === "bottom"; }), "bull"), metric("↑ Top-led", count(usable, function (r) { return r.dominant === "top"; }), "bear"), metric("Confirmed", count(usable, function (r) { return r.state === "CONFIRMED"; }), "warn")],
      readings: active.slice().sort(function (a, b) { return Math.max(b.bottomScore || 0, b.topScore || 0) - Math.max(a.bottomScore || 0, a.topScore || 0); }).slice(0, 3).map(function (r) {
        return reading(r.symbol, "Bottom " + num(r.bottomScore, 0) + " / Top " + num(r.topScore, 0) + " · " + r.state);
      }),
      empty: "No active extremes in this scan.", note: "Both sides stay visible. A confirmed extreme describes location; it does not imply a reversal or entry.",
    };
  }
  function patterns(data) {
    var rows = data.results || [], usable = rows.filter(function (r) { return !r.error; });
    var hits = usable.filter(function (r) { return r.pattern || r.divergence; });
    function bias(r) { return (r.pattern && r.pattern.bias) || (r.divergence && r.divergence.bias); }
    var bull = count(hits, function (r) { return bias(r) === "bullish"; });
    var bear = count(hits, function (r) { return bias(r) === "bearish"; });
    return {
      lead: usable.length ? lean(bull, bear) : "UNAVAILABLE", tone: tone(bull - bear), total: usable.length,
      health: { unavailable: rows.length - usable.length }, subtitle: hits.length + " patterns or divergences · " + rows.length + " token/timeframe scans",
      metrics: [metric("▲ Bullish hits", bull, "bull"), metric("▼ Bearish hits", bear, "bear"), metric("Neutral hits", hits.length - bull - bear)],
      readings: hits.slice(0, 3).map(function (r) { return reading(r.symbol + " · " + r.interval, (r.pattern && r.pattern.label) || (r.divergence && r.divergence.label) || "Divergence"); }),
      empty: "No patterns or divergences detected.", note: "Multi-timeframe structure scan. A token can appear on more than one timeframe; open the scanner for candle timestamps.",
    };
  }
  function cryptoOi(data) {
    var s = data.summary || {}, h = (s.horizons || {})["24h"] || {};
    var state = h.state || "UNKNOWN";
    return {
      lead: state === "UNKNOWN" ? "NO CHANGE HISTORY" : state, tone: state === "EXPANSION" ? "bull" : state === "CONTRACTION" ? "bear" : "flat", total: s.assetsWithOi || 0,
      health: { unavailable: s.errorRows || 0, notFresh: s.staleRows || 0 }, subtitle: (s.assetsWithOi || 0) + " / " + (s.assetsTracked || 0) + " assets with OI",
      metrics: [metric("Tracked OI", usd(s.totalOiUsd)), metric("24h OI change", pct(h.changePct), tone(h.changePct)), metric("Rising breadth", Number.isFinite(h.breadthPct) ? num(h.breadthPct, 0) + "%" : "—")],
      readings: [reading("BTC open interest", s.btc ? usd(s.btc.oiUsd) : "—"), reading("ETH open interest", s.eth ? usd(s.eth.oiUsd) : "—"), reading("24h participation", (h.rising || 0) + " rising / " + (h.falling || 0) + " falling · " + (h.covered || 0) + " with history")],
      note: "Sum of each asset’s serving venue, not whole-market OI. Rising OI measures participation and does not establish bullish direction.",
    };
  }
  function crossOi(data) {
    var rows = (data.rows || []).filter(function (r) { return r.metricType === "OI"; });
    var usable = rows.filter(function (r) { return !r.error && Number.isFinite(r.normalizedValue); });
    var spec = (data.rows || []).filter(function (r) { return r.metricType === "COT_NET_SPEC" && !r.error && Number.isFinite(r.normalizedValue); });
    var source = data.source || {};
    return {
      lead: usable.length ? "WEEKLY POSITIONING" : "UNAVAILABLE", tone: "flat", total: usable.length,
      health: { unavailable: rows.length - usable.length, notFresh: count(usable, function (r) { return !r.freshness || r.freshness.state !== "FRESH"; }) },
      subtitle: "CFTC · report " + (source.reportDate || "unavailable") + " · " + (source.status || "UNAVAILABLE"),
      metrics: [metric("OI rising", count(usable, function (r) { return r.normalizedValue > 0; })), metric("OI falling", count(usable, function (r) { return r.normalizedValue < 0; })), metric("Net-long specs", count(spec, function (r) { return r.normalizedValue > 0; }) + " / " + spec.length)],
      readings: usable.slice().sort(function (a, b) { return Math.abs(b.normalizedValue) - Math.abs(a.normalizedValue); }).slice(0, 3).map(function (r) { return reading(r.marketName || r.symbol, pct(r.normalizedValue) + " OI · " + (r.observationDate || "date unavailable")); }),
      note: "Weekly futures OI change and net speculator positioning are separate measures. Cross-asset OI is not a directional risk vote.",
    };
  }
  function rsi(data) {
    var rows = data.instruments || [], tfs = data.timeframes || [];
    var usable = rows.filter(function (r) { return Number.isFinite(r.average); });
    var unavailable = 0, behind = 0;
    rows.forEach(function (r) { tfs.forEach(function (tf) {
      if (!r.values || !Number.isFinite(r.values[tf])) unavailable++;
      else if (!r.freshness || !r.freshness[tf] || r.freshness[tf].barsBehind == null || r.freshness[tf].barsBehind > 1) behind++;
    }); });
    return {
      lead: usable.length ? "MULTI-TIMEFRAME MOMENTUM" : "AVERAGES UNAVAILABLE", tone: "flat", total: usable.length,
      health: { unavailable: unavailable, notFresh: behind, unit: "cells" }, subtitle: usable.length + " / " + rows.length + " complete averages · " + tfs.join(" / "),
      metrics: [metric("MTF overbought", count(usable, function (r) { return r.averageState === "mtf-overbought"; }), "bear"), metric("MTF oversold", count(usable, function (r) { return r.averageState === "mtf-oversold"; }), "bull"), metric("Incomplete AVG", rows.length - usable.length, "warn")],
      readings: usable.slice().sort(function (a, b) { return b.average - a.average; }).slice(0, 3).map(function (r) { return reading(r.label, "AVG RSI " + num(r.average, 2) + (r.averageState && r.averageState !== "normal" ? " · " + r.averageState.replace(/-/g, " ") : "")); }),
      note: "RSI 14 on closed bars. AVG requires every enabled timeframe. Feed lag or closed markets can leave a cell behind.",
    };
  }
  var api = { directional: directional, extremes: extremes, patterns: patterns, cryptoOi: cryptoOi, crossOi: crossOi, rsi: rsi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OverviewV2Model = api;
})(typeof window !== "undefined" ? window : this);
