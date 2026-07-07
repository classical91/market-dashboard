(function () {
  "use strict";

  const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT"];
  const INTERVALS = ["1h", "4h", "1D"];
  const state = { loading: false };
  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    Object.assign(els, {
      card: $("strategy-engine"),
      symbol: $("strategySymbol"),
      interval: $("strategyInterval"),
      run: $("strategyRun"),
      status: $("strategyStatus"),
      signal: $("strategySignal"),
      metrics: $("strategyMetrics"),
      trades: $("strategyTrades"),
    });

    if (!els.card) return;
    hydrateControls();
    els.run.addEventListener("click", loadStrategy);
    els.symbol.addEventListener("change", loadStrategy);
    els.interval.addEventListener("change", loadStrategy);
    renderLoading();
    loadStrategy();
  }

  function hydrateControls() {
    els.symbol.innerHTML = SYMBOLS.map((symbol) => `<option value="${escapeAttr(symbol)}">${escapeHtml(symbol.replace("USDT", ""))}</option>`).join("");
    els.interval.innerHTML = INTERVALS.map((interval) => `<option value="${escapeAttr(interval)}">${escapeHtml(interval)}</option>`).join("");
    els.symbol.value = "BTCUSDT";
    els.interval.value = "4h";
  }

  async function loadStrategy() {
    if (state.loading) return;
    state.loading = true;
    els.run.disabled = true;
    els.status.textContent = "Running…";

    try {
      const params = new URLSearchParams({
        symbol: els.symbol.value,
        interval: els.interval.value,
        trendEmaLen: "100",
        entryEmaLen: "21",
        rsiLen: "14",
        atrLen: "14",
        atrMultSL: "1.2",
        rr: "2",
        useVwap: "true",
      });
      const response = await fetch(`/api/strategy-engine?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`API ${response.status}`);
      renderStrategy(await response.json());
    } catch (err) {
      els.status.textContent = "Error";
      els.signal.innerHTML = `<div class="strategy-empty">Strategy engine failed: ${escapeHtml(err.message)}</div>`;
      els.metrics.innerHTML = "";
      els.trades.innerHTML = "";
    } finally {
      state.loading = false;
      els.run.disabled = false;
    }
  }

  function renderLoading() {
    els.status.textContent = "Loading";
    els.signal.innerHTML = `<div class="strategy-empty">Preparing strategy backtest…</div>`;
    els.metrics.innerHTML = "";
    els.trades.innerHTML = "";
  }

  function renderStrategy(data) {
    if (data.error) {
      els.status.textContent = "Needs history";
      els.signal.innerHTML = `<div class="strategy-empty">${escapeHtml(data.error)}</div>`;
      els.metrics.innerHTML = "";
      els.trades.innerHTML = "";
      return;
    }

    const latest = data.latestSignal || {};
    const tone = signalTone(latest.signal);
    els.status.textContent = `${data.symbol} · ${data.interval}`;
    els.signal.innerHTML = `
      <div class="strategy-signal-card ${tone}">
        <span>Latest closed-candle read</span>
        <strong>${escapeHtml(latest.signal || "WAIT")}</strong>
        <small>${escapeHtml(latest.reason || data.strategy || "Strategy read")}</small>
      </div>
      <div class="strategy-level-grid">
        ${levelCard("Price", formatPrice(latest.price))}
        ${levelCard("Stop", formatPrice(latest.stop))}
        ${levelCard("Target", formatPrice(latest.target))}
        ${levelCard("RSI", latest.rsi == null ? "—" : String(latest.rsi))}
      </div>`;

    const summary = data.summary || {};
    els.metrics.innerHTML = [
      metricCard("Trades", summary.trades ?? 0, "closed"),
      metricCard("Win Rate", formatPercent(summary.winRate), "hit rate"),
      metricCard("Net", formatPercent(summary.netPct), "after fees"),
      metricCard("Profit Factor", summary.profitFactor == null ? "∞" : summary.profitFactor, "gross wins/losses"),
      metricCard("Max DD", formatPercent(summary.maxDrawdown), "equity curve"),
      metricCard("Avg Trade", formatPercent(summary.avgNetPct), "expectancy"),
    ].join("");

    renderTrades(data.trades || []);
  }

  function renderTrades(trades) {
    if (!trades.length) {
      els.trades.innerHTML = `<div class="strategy-empty">No closed trades yet under these rules. Try 1h or another symbol.</div>`;
      return;
    }

    els.trades.innerHTML = trades.map((trade) => {
      const cls = Number(trade.netPct) > 0 ? "up" : "down";
      return `<div class="strategy-trade-row">
        <span><strong>${escapeHtml(trade.side)}</strong><small>${escapeHtml(trade.exitReason)} · ${escapeHtml(String(trade.barsHeld))} bars</small></span>
        <span>${escapeHtml(formatPrice(trade.entry))} → ${escapeHtml(formatPrice(trade.exit))}</span>
        <em class="${cls}">${escapeHtml(formatPercent(trade.netPct))}</em>
      </div>`;
    }).join("");
  }

  function signalTone(signal) {
    if (/LONG/i.test(signal || "")) return "long";
    if (/SHORT/i.test(signal || "")) return "short";
    return "flat";
  }

  function levelCard(label, value) {
    return `<div class="strategy-level-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function metricCard(label, value, note) {
    return `<div class="strategy-metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "—"))}</strong><small>${escapeHtml(note)}</small></div>`;
  }

  function formatPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const digits = n >= 100 ? 2 : 4;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
