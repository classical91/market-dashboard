/* ─────────────────────────────────────────────────────────
   Analysis Trader (GPT) hand-off for My Trades cards.

   Turns one card into a plain-text brief, copies it to the
   clipboard and opens the custom GPT with the brief pre-filled
   via ?q=. The clipboard copy is the fallback for when ChatGPT
   ignores the prefill or the brief is too long for a URL.
───────────────────────────────────────────────────────── */
(function (root) {
  "use strict";

  var GPT_URL = "https://chatgpt.com/g/g-6a3806b123748191b5bfa7c394c5dd66-analysis-trader";
  var GPT_NAME = "Analysis Trader (GPT)";
  // Long query strings get truncated or rejected; past this the brief only
  // travels via the clipboard.
  var MAX_PREFILL_CHARS = 6000;

  function num(value, digits) {
    if (value == null || !isFinite(value)) return "—";
    return Number(value).toFixed(digits == null ? 2 : digits);
  }

  function pct(value) {
    if (value == null || !isFinite(value)) return "—";
    return (value > 0 ? "+" : "") + Number(value).toFixed(2) + "%";
  }

  function price(px) {
    if (px == null || !isFinite(px)) return "—";
    if (px >= 1000) return Number(px).toFixed(2);
    if (px >= 1) return Number(px).toFixed(4);
    return Number(px).toFixed(6);
  }

  function biasLines(bias) {
    if (!bias) return ["- unavailable"];
    if (bias.error) return ["- unavailable: " + bias.error];
    var lines = ["- " + (bias.bias || "—") + " (score " + (bias.score == null ? "—" : bias.score) + "/100)"];
    if (bias.trendRegime) lines.push("- Trend regime: " + bias.trendRegime);
    if (bias.rsi != null || bias.adx != null) lines.push("- RSI " + num(bias.rsi, 1) + " · ADX " + num(bias.adx, 1));
    return lines;
  }

  function extremesLines(ex) {
    if (!ex) return ["- unavailable"];
    if (ex.error) return ["- unavailable: " + ex.error];
    var lines = [
      "- Bottom score " + (ex.bottomScore == null ? "—" : ex.bottomScore) + " · Top score " + (ex.topScore == null ? "—" : ex.topScore),
      "- State: " + (ex.dominant ? ex.dominant.toUpperCase() + " " : "") + (ex.state || "NONE"),
    ];
    if (ex.setupType && ex.setupType !== "none") lines.push("- Setup: " + ex.setupType);
    return lines;
  }

  function patternLines(p) {
    if (!p) return ["- unavailable"];
    if (p.error) return ["- unavailable: " + p.error];
    var lines = [];
    if (p.divergence) {
      lines.push("- " + (p.divergenceBias || "") + " " + p.divergence + " divergence" +
        (p.divergenceBarsAgo != null ? " (" + p.divergenceBarsAgo + " bars ago)" : ""));
    }
    if (p.pattern) {
      lines.push("- " + p.pattern + " (" + (p.patternBias || "neutral") + ") · status " + (p.status || "—") +
        (p.patternScore != null ? " · score " + p.patternScore : ""));
    }
    return lines.length ? lines : ["- No pattern or divergence detected"];
  }

  function oiLines(oi) {
    if (oi.error) return ["- unavailable: " + oi.error];
    var state = oi.state || {};
    var lines = ["- " + String(oi.horizon || "").toUpperCase() + ": " + (state.label || "—") +
      " · OI " + pct(oi.oiChangePct) + " · Price " + pct(oi.priceChangePct)];
    if (state.meaning) lines.push("- " + state.meaning);
    if (oi.horizons && oi.horizons.length) {
      lines.push("- Horizons: " + oi.horizons.map(function (h) { return String(h.key).toUpperCase() + " " + h.label; }).join(" | "));
    }
    if (oi.oiUsd != null) lines.push("- Open interest ≈ $" + Math.round(oi.oiUsd).toLocaleString("en-US") + (oi.oiUsdBasis === "estimated" ? " (est.)" : ""));
    if (oi.spike) lines.push("- OI spike " + (oi.spike.direction || "") + " " + pct(oi.spike.changePct));
    return lines;
  }

  function rsiLines(r) {
    if (r.error) return ["- unavailable: " + r.error];
    var cells = (r.cells || []).map(function (c) { return c.label + " " + num(c.value, 1); });
    var lines = cells.length ? ["- " + cells.join(" | ")] : [];
    if (r.average != null) lines.push("- Average " + num(r.average, 1) + (r.averageState ? " (" + r.averageState + ")" : ""));
    return lines.length ? lines : ["- unavailable"];
  }

  /* Plain text, one labelled block per engine, so the GPT sees the same
     separation the card draws and can't mistake one engine for the verdict. */
  function buildBrief(card) {
    card = card || {};
    var context = card.context || {};
    var freshness = card.freshness || {};
    var out = [
      "Analyse this tracked trade from my Market Command dashboard (My Trades).",
      "",
      "Pair: " + (card.symbol || "—") + " (Binance) · Timeframe: " + (card.interval || "—") + " · Price: " + price(card.price),
      "Data freshness: " + (freshness.state || "UNKNOWN") + (freshness.summary ? " — " + freshness.summary : "") +
        (freshness.staleReasons && freshness.staleReasons.length ? " (" + freshness.staleReasons.join("; ") + ")" : ""),
      "",
      "Directional bias:",
    ].concat(biasLines(card.directionalBias), ["", "Local extremes:"], extremesLines(card.extremes),
      ["", "Pattern scanner:"], patternLines(card.patterns));
    if (card.openInterest) out = out.concat(["", "Open interest (perps):"], oiLines(card.openInterest));
    if (card.rsi) out = out.concat(["", "RSI 14 multi-timeframe:"], rsiLines(card.rsi));
    if (card.evidence && card.evidence.length) {
      out = out.concat(["", "Evidence:"], card.evidence.map(function (line) { return "- " + line; }));
    }
    out.push("", "Context: " + (context.state || "—") + (context.summary ? " — " + context.summary : ""));
    if (card.errors && card.errors.length) out.push("Engine errors: " + card.errors.join("; "));
    out.push("", "Captured " + new Date().toISOString());
    return out.join("\n");
  }

  function gptUrl(brief) {
    if (!brief || brief.length > MAX_PREFILL_CHARS) return GPT_URL;
    return GPT_URL + "?q=" + encodeURIComponent(brief);
  }

  // execCommand fallback for non-secure contexts and browsers without the
  // async Clipboard API. Synchronous, so it runs inside the click gesture.
  function legacyCopy(text) {
    var doc = root.document;
    var area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = doc.execCommand("copy"); } catch (err) { ok = false; }
    doc.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    var nav = root.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function" && root.isSecureContext) {
      // Started before the GPT tab opens: Chrome refuses clipboard writes
      // once this document loses focus.
      return nav.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function flash(button, label, title) {
    var resting = button.getAttribute("data-label") || button.textContent;
    button.setAttribute("data-label", resting);
    button.textContent = label;
    if (title) button.title = title;
    clearTimeout(button._tgTimer);
    button._tgTimer = setTimeout(function () { button.textContent = resting; }, 2200);
  }

  /* Copy, then open the GPT with the brief prefilled. window.open stays in
     the same tick as the click so popup blockers allow it. */
  function sendToGpt(card, button) {
    var brief = buildBrief(card);
    var copied = copyText(brief);
    root.open(gptUrl(brief), "_blank", "noopener");
    if (button) {
      copied.then(function (ok) {
        flash(button, ok ? "Copied ✓ · opened GPT" : "Opened GPT",
          ok ? "Card copied — paste into Analysis Trader if the message isn't prefilled" : "Copy failed — use Copy to try again");
      });
    }
    return copied;
  }

  function copyOnly(card, button) {
    return copyText(buildBrief(card)).then(function (ok) {
      if (button) flash(button, ok ? "Copied ✓" : "Copy failed");
      return ok;
    });
  }

  var api = {
    GPT_URL: GPT_URL,
    GPT_NAME: GPT_NAME,
    MAX_PREFILL_CHARS: MAX_PREFILL_CHARS,
    buildBrief: buildBrief,
    gptUrl: gptUrl,
    sendToGpt: sendToGpt,
    copyOnly: copyOnly,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TradeGpt = api;
})(typeof window !== "undefined" ? window : globalThis);
