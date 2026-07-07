(function () {
  "use strict";

  const state = { overview: null, patchQueued: false };
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  if (nativeFetch) {
    window.fetch = async function patchedFetch(input, init) {
      const response = await nativeFetch(input, init);
      const url = typeof input === "string" ? input : input?.url || "";

      if (url.includes("/api/overview")) {
        response
          .clone()
          .json()
          .then((payload) => {
            state.overview = payload;
            window.__terminalSuiteOverview = payload;
            schedulePatch();
          })
          .catch(() => {});
      }

      return response;
    };
  }

  function schedulePatch() {
    if (state.patchQueued) return;
    state.patchQueued = true;
    window.requestAnimationFrame(() => {
      state.patchQueued = false;
      patchTerminalUi();
    });
  }

  function patchTerminalUi() {
    const data = state.overview;
    if (!data) return;

    patchRangeCopy();
    patchMiniCards(data);
    patchMacroWatch(data);
    patchConfluenceRows(data);
    patchEngineNote();
  }

  function patchRangeCopy() {
    const range = document.querySelector(".terminal-range");
    if (!range) return;
    range.setAttribute("aria-label", "BTC chart range");
    range.title = "These buttons change the BTC market-pulse chart range. Confluence factors use the 24h feed.";

    if (!document.getElementById("terminalRangeNote")) {
      const note = document.createElement("small");
      note.id = "terminalRangeNote";
      note.className = "terminal-small-note";
      note.textContent = "Chart range only · confluence uses 24h asset moves";
      range.insertAdjacentElement("afterend", note);
    }
  }

  function patchMiniCards(data) {
    const dxy = getAsset(data, "DXY");
    const vix = getAsset(data, "VIX");
    const cards = document.querySelectorAll("#regimeMiniCards .terminal-micro-card");

    cards.forEach((card) => {
      const label = card.querySelector("span");
      const note = card.querySelector("small");
      const text = label?.textContent?.trim();

      if (text === "Confidence" && note) {
        note.title = "Confidence is confluence strength after data-quality penalties, not win probability.";
      }

      if (text === "Dollar" && dxy?.proxy) {
        label.textContent = "Dollar Proxy";
        if (note) note.textContent = "USD proxy 24h";
      }

      if (text === "Volatility" && vix?.proxy) {
        label.textContent = "VIX Proxy";
        if (note) note.textContent = "ETF proxy 24h";
      }
    });
  }

  function patchMacroWatch(data) {
    const dxy = getAsset(data, "DXY");
    const vix = getAsset(data, "VIX");
    const rows = document.querySelectorAll("#indicatorList .terminal-indicator-row");

    rows.forEach((row) => {
      const label = row.querySelector("strong");
      const note = row.querySelector("small");
      const text = label?.textContent?.trim();

      if (text === "Dollar Index" && dxy?.proxy) {
        label.textContent = "Dollar Proxy";
        if (note && !/proxy/i.test(note.textContent)) note.textContent = `${note.textContent} · proxy`;
      }

      if (text === "Volatility Index" && vix?.proxy) {
        label.textContent = "VIX Proxy";
        if (note && !/proxy/i.test(note.textContent)) note.textContent = `${note.textContent} · proxy`;
      }
    });
  }

  function patchConfluenceRows(data) {
    const dxy = getAsset(data, "DXY");
    const vix = getAsset(data, "VIX");

    const factorCount = document.getElementById("factorCount");
    if (factorCount && !/24h/i.test(factorCount.textContent)) {
      factorCount.textContent = `${factorCount.textContent} · 24h`;
    }

    document.querySelectorAll("#confluenceRows tr").forEach((row) => {
      const label = row.querySelector("td:first-child strong");
      const subLabel = row.querySelector("td:first-child small");
      const readingNote = row.querySelector("td:nth-child(2) small");
      const text = label?.textContent?.trim();

      if (text === "Dollar (DXY)" && dxy?.proxy) {
        label.textContent = "Dollar (DXY proxy)";
        if (subLabel) subLabel.textContent = "USD pressure proxy";
        if (readingNote) readingNote.textContent = readingNote.textContent.replace("Dollar", "Dollar proxy");
      }

      if (text === "Volatility (VIX)" && vix?.proxy) {
        label.textContent = "Volatility (VIX proxy)";
        if (subLabel) subLabel.textContent = "market stress ETF proxy";
      }
    });

    document.querySelectorAll(".terminal-section-label").forEach((label) => {
      if (label.textContent.trim() === "TraderClaw Macro Confluence") {
        label.textContent = "TraderClaw Macro Confluence · 24h factors";
      }
    });
  }

  function patchEngineNote() {
    const note = document.querySelector("#terminalThesis .terminal-small-note");
    if (!note) return;
    note.textContent = "Confluence uses 24h asset moves; range buttons change the BTC market-pulse chart only. Confirm structure on TradingView before acting.";
  }

  function getAsset(data, symbol) {
    const target = String(symbol || "").toUpperCase();
    const assets = Array.isArray(data.watchlist) && data.watchlist.length ? data.watchlist : data.ticker || [];
    return assets.find((asset) => String(asset.symbol || "").toUpperCase() === target) || null;
  }

  const observer = new MutationObserver(schedulePatch);
  window.addEventListener("DOMContentLoaded", () => {
    const root = document.querySelector(".terminal-page") || document.body;
    observer.observe(root, { childList: true, subtree: true });
    schedulePatch();
  });
})();
