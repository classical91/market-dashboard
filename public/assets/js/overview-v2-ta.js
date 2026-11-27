// Overview v2 · Technical Ratings ticker picker.
// "All" shows every ticker on 1H (the page's static default). Tapping a
// ticker — a chip or a card's symbol label — rebuilds the grid as that one
// ticker across every timeframe. Ratings are TradingView's own widgets.
(function () {
  "use strict";

  const SRC = "https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js";
  const STORE_KEY = "ov2.ta.ticker";
  const TICKERS = [
    { id: "BTC", label: "BTCUSDT", symbol: "BINANCE:BTCUSDT" },
    { id: "ETH", label: "ETHUSDT", symbol: "BINANCE:ETHUSDT" },
    { id: "SOL", label: "SOLUSDT", symbol: "BINANCE:SOLUSDT" },
    { id: "SPY", label: "SPY", symbol: "AMEX:SPY" },
    { id: "QQQ", label: "QQQ", symbol: "NASDAQ:QQQ" },
    { id: "NDX", label: "NASDAQ 100", symbol: "NASDAQ:NDX" },
    { id: "DXY", label: "DXY", symbol: "TVC:DXY" },
  ];
  const TIMEFRAMES = [
    { interval: "15m", label: "15 MIN" },
    { interval: "30m", label: "30 MIN" },
    { interval: "1h", label: "1 HOUR" },
    { interval: "2h", label: "2 HOURS" },
    { interval: "4h", label: "4 HOURS" },
    { interval: "1D", label: "1 DAY" },
    { interval: "1W", label: "1 WEEK" },
    { interval: "1M", label: "1 MONTH" },
  ];

  const grid = document.getElementById("ov-ta-grid");
  const picker = document.getElementById("ov-ta-picker");
  const note = document.getElementById("ov-ta-picker-note");
  if (!grid || !picker) return;

  function widget(symbol, interval, showTabs) {
    const box = document.createElement("div");
    box.className = "tradingview-widget-container";
    const target = document.createElement("div");
    target.className = "tradingview-widget-container__widget";
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = SRC;
    script.async = true;
    script.textContent = JSON.stringify({
      interval, width: "100%", isTransparent: false, height: "100%", symbol,
      showIntervalTabs: showTabs, displayMode: "single", locale: "en", colorTheme: "dark",
    });
    box.append(target, script);
    return box;
  }

  function item(labelNode, symbol, interval, showTabs) {
    const cell = document.createElement("div");
    cell.className = "ov-ta-item";
    const body = document.createElement("div");
    body.className = "ov-ta-body";
    body.appendChild(widget(symbol, interval, showTabs));
    cell.append(labelNode, body);
    return cell;
  }

  function symbolButton(t) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ov-ta-symbol ov-ta-symbol-btn";
    btn.dataset.taTicker = t.id;
    btn.textContent = t.label;
    btn.setAttribute("aria-label", `${t.label}: show every timeframe`);
    return btn;
  }

  function symbolLabel(text) {
    const div = document.createElement("div");
    div.className = "ov-ta-symbol";
    div.textContent = text;
    return div;
  }

  function render(id) {
    const ticker = TICKERS.find((t) => t.id === id);
    const cells = ticker
      ? TIMEFRAMES.map((tf) => item(symbolLabel(`${ticker.label} · ${tf.label}`), ticker.symbol, tf.interval, false))
      : TICKERS.map((t) => item(symbolButton(t), t.symbol, "1h", true));
    grid.replaceChildren(...cells);
    grid.setAttribute("aria-label", ticker ? `${ticker.label} technical ratings on every timeframe` : "All tickers on 1H");
    for (const btn of picker.querySelectorAll("button[data-ta-ticker]")) {
      const on = btn.dataset.taTicker === (ticker ? ticker.id : "all");
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    if (note) {
      note.textContent = ticker
        ? `${ticker.label} on ${TIMEFRAMES.map((tf) => tf.interval).join(" / ")}.`
        : "Tap a ticker to see it on every timeframe.";
    }
    try { localStorage.setItem(STORE_KEY, ticker ? ticker.id : "all"); } catch (_) { /* storage blocked */ }
  }

  function select(id, focusPicker) {
    render(id);
    if (focusPicker) {
      const chip = picker.querySelector(`button[data-ta-ticker="${id}"]`);
      if (chip) chip.focus();
    }
  }

  picker.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-ta-ticker]");
    if (btn) select(btn.dataset.taTicker, false);
  });
  grid.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-ta-ticker]");
    if (btn) select(btn.dataset.taTicker, true);
  });

  // The static HTML already shows "All"; only rebuild when a ticker was saved.
  // Until then, upgrade the static symbol labels into tappable buttons.
  let saved = "all";
  try { saved = localStorage.getItem(STORE_KEY) || "all"; } catch (_) { /* storage blocked */ }
  if (TICKERS.some((t) => t.id === saved)) {
    render(saved);
  } else {
    grid.querySelectorAll(".ov-ta-item > .ov-ta-symbol").forEach((label, i) => {
      if (TICKERS[i]) label.replaceWith(symbolButton(TICKERS[i]));
    });
  }
})();
