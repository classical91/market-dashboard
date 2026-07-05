/**
 * Shared card/chart rendering for the Pattern Scanner and its "My Trades"
 * watchlist subpage, so the two pages don't duplicate ~150 lines of
 * identical card markup and canvas drawing logic.
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function biasClass(bias) {
    if (bias === "bullish") return "ps-bias ps-bias--bullish";
    if (bias === "bearish") return "ps-bias ps-bias--bearish";
    return "ps-bias";
  }

  var TV_INTERVALS = { "1h": "60", "4h": "240", "1D": "D" };

  function tvChartUrl(symbol, interval) {
    return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent("BINANCE:" + symbol) +
      "&interval=" + encodeURIComponent(TV_INTERVALS[interval] || "240");
  }

  // A plain (non-link) label plus an always-visible, clearly-a-button chart
  // link — a hover-tinted arrow next to plain text doesn't read as tappable
  // on mobile, where there's no hover state at all.
  function tickerLink(entry) {
    return (
      '<span class="ps-ticker-label">' + escapeHtml(entry.label) + "</span>" +
      '<a class="ps-chart-link" data-role="ticker-link" href="' + tvChartUrl(entry.symbol, entry.interval) + '" target="_blank" rel="noopener" title="Open ' +
      escapeHtml(entry.symbol) + " " + escapeHtml(entry.interval) + ' on TradingView">&#128200; Chart</a>'
    );
  }

  function patternBlock(pattern) {
    if (!pattern) return "";
    return (
      '<div class="ps-pattern-name">' + escapeHtml(pattern.pattern) + "</div>" +
      '<div class="ps-status ps-status--' + escapeHtml(pattern.status) + '">' + (pattern.status === "breakout" ? "&#9889; Breakout" : "&#8987; Forming") + "</div>" +
      '<div class="ps-metrics">' +
        '<div class="ps-metric"><span>Score</span><b>' + pattern.score + "</b></div>" +
        '<div class="ps-metric"><span>Width ratio</span><b>' + pattern.widthRatio + "</b></div>" +
        '<div class="ps-metric"><span>Impulse</span><b>' + pattern.impulseReturnPct + "%</b></div>" +
        '<div class="ps-metric"><span>Vol ratio</span><b>' + pattern.volumeRatio + "</b></div>" +
      "</div>"
    );
  }

  function divergenceBlock(div) {
    if (!div) return "";
    return (
      '<div class="ps-divergence">' +
        '<div class="ps-pattern-name">' + escapeHtml(div.type) + " Divergence</div>" +
        '<div class="ps-metrics">' +
          '<div class="ps-metric"><span>Indicator</span><b>' + escapeHtml(div.indicator) + "</b></div>" +
          '<div class="ps-metric"><span>Price &Delta;</span><b>' + div.priceDeltaPct + "%</b></div>" +
          '<div class="ps-metric"><span>RSI &Delta;</span><b>' + div.rsiDelta + "</b></div>" +
          '<div class="ps-metric"><span>Bars ago</span><b>' + div.barsAgo + "</b></div>" +
        "</div>" +
      "</div>"
    );
  }

  // `opts.collapsed` sets the initial collapsed state; `opts.tracked` shows
  // the star as filled. `index` keys the canvas back to its entry for
  // drawChart — pass -1 for entries with no chart (errors).
  function renderCard(entry, index, opts) {
    opts = opts || {};
    if (entry.error) {
      return (
        '<div class="ps-card ps-card--empty">' +
          '<div class="ps-card-symbol">' + escapeHtml(entry.label) + '<span class="ps-tf">' + escapeHtml(entry.interval) + "</span></div>" +
          '<div class="ps-empty">Scan failed: ' + escapeHtml(entry.error) + "</div>" +
        "</div>"
      );
    }
    var bias = (entry.pattern && entry.pattern.bias) || (entry.divergence && entry.divergence.bias) || "";
    var chartHtml = entry.chart ? '<canvas class="ps-chart" data-chart-index="' + index + '" width="640" height="280"></canvas>' : "";
    var trackBtn = (
      '<button class="ps-track-btn' + (opts.tracked ? " ps-track-btn--active" : "") + '" type="button" data-role="track-btn" ' +
      'data-symbol="' + escapeHtml(entry.symbol) + '" data-interval="' + escapeHtml(entry.interval) + '" data-label="' + escapeHtml(entry.label) + '" ' +
      'title="' + (opts.tracked ? "Remove from My Trades" : "Add to My Trades") + '">' +
      (opts.tracked ? "&#9733;" : "&#9734;") +
      "</button>"
    );
    return (
      '<div class="ps-card' + (opts.collapsed ? " collapsed" : "") + '">' +
        '<div class="ps-card-head" data-role="head">' +
          '<div class="ps-card-symbol">' + tickerLink(entry) + '<span class="ps-tf">' + escapeHtml(entry.interval) + "</span></div>" +
          '<div class="ps-card-actions">' +
            trackBtn +
            '<span class="' + biasClass(bias) + '">' + escapeHtml(bias) + "</span>" +
            '<span class="ps-chevron" aria-hidden="true">&#9660;</span>' +
          "</div>" +
        "</div>" +
        '<div class="ps-card-content" data-role="content">' +
          chartHtml +
          patternBlock(entry.pattern) +
          divergenceBlock(entry.divergence) +
        "</div>" +
      "</div>"
    );
  }

  // Minimal candlestick renderer with pattern trendlines and a dashed
  // divergence connector — geometry comes precomputed from the server.
  function drawChart(canvas, chart) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width;
    var H = canvas.height;
    var pad = { top: 10, right: 8, bottom: 8, left: 8 };
    var candles = chart.candles;
    var n = candles.length;
    if (!n) return;

    var min = Infinity;
    var max = -Infinity;
    candles.forEach(function (c) {
      if (c[3] < min) min = c[3];
      if (c[2] > max) max = c[2];
    });
    if (chart.pattern) {
      [chart.pattern.upper.y0, chart.pattern.upper.y1, chart.pattern.lower.y0, chart.pattern.lower.y1].forEach(function (y) {
        if (y < min) min = y;
        if (y > max) max = y;
      });
    }
    var span = max - min || 1;

    function x(i) { return pad.left + (i / Math.max(1, n - 1)) * (W - pad.left - pad.right); }
    function y(price) { return pad.top + (1 - (price - min) / span) * (H - pad.top - pad.bottom); }

    ctx.clearRect(0, 0, W, H);

    var bodyW = Math.max(2, ((W - pad.left - pad.right) / n) * 0.6);
    candles.forEach(function (c, i) {
      var open = c[1], high = c[2], low = c[3], close = c[4];
      var up = close >= open;
      ctx.strokeStyle = up ? "#26a69a" : "#ef5350";
      ctx.fillStyle = up ? "#26a69a" : "#ef5350";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), y(high));
      ctx.lineTo(x(i), y(low));
      ctx.stroke();
      var top = y(Math.max(open, close));
      var bottom = y(Math.min(open, close));
      ctx.fillRect(x(i) - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
    });

    if (chart.pattern) {
      ctx.strokeStyle = "#4da3ff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x(chart.pattern.x0), y(chart.pattern.upper.y0));
      ctx.lineTo(x(chart.pattern.x1), y(chart.pattern.upper.y1));
      ctx.moveTo(x(chart.pattern.x0), y(chart.pattern.lower.y0));
      ctx.lineTo(x(chart.pattern.x1), y(chart.pattern.lower.y1));
      ctx.stroke();
    }

    if (chart.divergence) {
      var p = chart.divergence.pivots;
      ctx.strokeStyle = "#f5c542";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x(p[0].x), y(p[0].price));
      ctx.lineTo(x(p[1].x), y(p[1].price));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f5c542";
      p.forEach(function (pt) {
        ctx.beginPath();
        ctx.arc(x(pt.x), y(pt.price), 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  global.PatternRender = {
    escapeHtml: escapeHtml,
    biasClass: biasClass,
    tvChartUrl: tvChartUrl,
    tickerLink: tickerLink,
    renderCard: renderCard,
    drawChart: drawChart,
  };
})(window);
