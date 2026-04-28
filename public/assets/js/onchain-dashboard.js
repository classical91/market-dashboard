// --- Config ----------------------------------------------------
// Point this at wherever you deploy the Express server.
// If this HTML is served BY the Express server, use "" (same origin).
const API_BASE = "";

// --- Helpers ---------------------------------------------------
function $(id) { return document.getElementById(id); }

function fmtUsd(v) {
  if (v == null || isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(0);
}

function fmtAddr(addr) {
  if (!addr || addr.length < 10) return addr || "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function fmtTime(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return ts; }
}

function valClass(v) {
  if (v > 0) return "val-positive";
  if (v < 0) return "val-negative";
  return "val-neutral";
}

function etherscanUrl(addr) {
  return `https://etherscan.io/address/${addr}`;
}

function etherscanTx(hash) {
  return `https://etherscan.io/tx/${hash}`;
}

function skeleton(rows = 5) {
  let html = "";
  for (let i = 0; i < rows; i++) {
    html += `<div class="loading-skeleton" style="width:${70 + Math.random()*30}%"></div>`;
  }
  return html;
}

function emptyState(msg) {
  return `<div class="empty-state"><div class="icon">📭</div>${msg}</div>`;
}

// --- Section Toggle --------------------------------------------
function toggleSection(id) {
  $(id).classList.toggle("collapsed");
}

// --- Render Tables ---------------------------------------------
function renderWalletTable(rows) {
  if (!rows || rows.length === 0) return emptyState("No data yet. Configure Dune query IDs in your .env");
  let html = `<table class="data-table"><thead><tr>
    <th>Wallet</th><th class="col-hide-mobile">Label</th>
    <th class="col-hide-mobile">Token</th><th>USD Value</th>
    <th class="col-hide-mobile">Txns</th></tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td class="mono"><a class="addr" href="${etherscanUrl(r.address)}" target="_blank" title="${r.address}">${fmtAddr(r.address)}</a></td>
      <td class="col-hide-mobile">${r.label ? `<span class="label-tag">${r.label}</span>` : "—"}</td>
      <td class="col-hide-mobile">${r.token || "—"}</td>
      <td class="mono ${valClass(r.usd)}">${fmtUsd(r.usd)}</td>
      <td class="col-hide-mobile">${r.txCount ?? "—"}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderTokenTable(rows) {
  if (!rows || rows.length === 0) return emptyState("No data yet. Configure Dune query IDs in your .env");
  let html = `<table class="data-table"><thead><tr>
    <th>Token</th><th>Contract</th>
    <th>USD Value</th><th class="col-hide-mobile">Wallets</th></tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td><strong>${r.symbol}</strong></td>
      <td class="mono"><a class="addr" href="${etherscanUrl(r.address)}" target="_blank" title="${r.address}">${fmtAddr(r.address)}</a></td>
      <td class="mono ${valClass(r.usd)}">${fmtUsd(r.usd)}</td>
      <td class="col-hide-mobile">${r.walletCount ?? "—"}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderTransferTable(rows) {
  if (!rows || rows.length === 0) return emptyState("No data yet. Configure Dune query IDs in your .env");
  let html = `<table class="data-table"><thead><tr>
    <th>Time</th><th>Wallet</th>
    <th>Token</th><th>USD Value</th>
    <th class="col-hide-mobile">Tx</th></tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td style="white-space:nowrap; font-size:11px; color:var(--text-muted);">${fmtTime(r.time)}</td>
      <td class="mono"><a class="addr" href="${etherscanUrl(r.address)}" target="_blank" title="${r.address}">${fmtAddr(r.address)}</a></td>
      <td>${r.token}</td>
      <td class="mono ${valClass(r.usd)}">${fmtUsd(r.usd)}</td>
      <td class="col-hide-mobile mono"><a class="addr" href="${etherscanTx(r.txHash)}" target="_blank">${fmtAddr(r.txHash)}</a></td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

// --- Load Overview ---------------------------------------------
let overviewData = null;

async function loadOverview() {
  const btn = $("refreshBtn");
  btn.classList.add("loading");
  btn.textContent = "Loading...";

  $("inflowsTable").innerHTML = skeleton(8);
  $("outflowsTable").innerHTML = skeleton(8);
  $("accumTable").innerHTML = skeleton(6);
  $("distTable").innerHTML = skeleton(6);
  $("transfersTable").innerHTML = skeleton(10);

  $("statusDot").className = "status-dot";
  $("statusText").textContent = "Fetching...";
  $("errorBanner").classList.remove("show");

  try {
    const res = await fetch(API_BASE + "/api/onchain/overview");

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    overviewData = data;

    // Metrics
    const m = data.metrics || {};
    const nf = m.stablecoinNetflow ?? 0;
    $("metricNetflow").textContent = fmtUsd(nf);
    $("metricNetflow").className = "value " + valClass(nf);

    $("metricInflows").textContent = fmtUsd(m.totalInflows ?? 0);
    $("metricInflows").className = "value val-positive";

    $("metricOutflows").textContent = fmtUsd(m.totalOutflows ?? 0);
    $("metricOutflows").className = "value val-negative";

    // Tables
    $("inflowsTable").innerHTML = renderWalletTable(data.topInflows);
    $("outflowsTable").innerHTML = renderWalletTable(data.topOutflows);
    $("accumTable").innerHTML = renderTokenTable(data.accumulatedTokens);
    $("distTable").innerHTML = renderTokenTable(data.distributedTokens);
    $("transfersTable").innerHTML = renderTransferTable(data.largeTransfers);

    $("statusDot").className = "status-dot live";
    $("statusText").textContent = "Live";
    $("statusTime").textContent = "Updated " + new Date(data.ts).toLocaleTimeString();

  } catch (err) {
    console.error("Overview load failed:", err);
    $("statusDot").className = "status-dot error";
    $("statusText").textContent = "Error";

    $("errorBanner").textContent = "⚠ " + err.message + " — Check /api/health to diagnose.";
    $("errorBanner").classList.add("show");

    const msg = emptyState("Failed to load. Is the API server running?");
    $("inflowsTable").innerHTML = msg;
    $("outflowsTable").innerHTML = msg;
    $("accumTable").innerHTML = msg;
    $("distTable").innerHTML = msg;
    $("transfersTable").innerHTML = msg;
  }

  btn.classList.remove("loading");
  btn.textContent = "Refresh";
}

// --- Search / Detail -------------------------------------------
async function handleSearch(mode = "wallet") {
  const input = $("searchInput").value.trim();
  if (!input) return;

  if (!input.startsWith("0x")) {
    $("errorBanner").textContent = "Enter a valid 0x address.";
    $("errorBanner").classList.add("show");
    setTimeout(() => $("errorBanner").classList.remove("show"), 4000);
    return;
  }

  if (input.length > 42) {
    window.open(etherscanTx(input), "_blank");
    return;
  }

  if (input.length !== 42) {
    $("errorBanner").textContent = "Wallets and token contracts should be 42 characters long.";
    $("errorBanner").classList.add("show");
    setTimeout(() => $("errorBanner").classList.remove("show"), 4000);
    return;
  }

  if (mode === "token") {
    await openTokenDetail(input);
    return;
  }

  await openWalletDetail(input);
}

$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch("wallet");
});

function openDetailPanel(html) {
  $("detailContent").innerHTML = html;
  $("detailOverlay").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeDetail(e) {
  if (e && e.target !== $("detailOverlay")) return;
  $("detailOverlay").classList.remove("open");
  document.body.style.overflow = "";
}

async function openWalletDetail(address) {
  openDetailPanel(`<div class="empty-state"><div class="icon">⛓</div>Loading wallet data...<br><small>This may take 10-30s (Dune execution queue)</small></div>`);

  try {
    const res = await fetch(`${API_BASE}/api/onchain/wallet/${address}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    let html = `<h3>🏦 Wallet: ${fmtAddr(address)}</h3>
      <div style="margin-bottom:4px;"><a class="addr" href="${etherscanUrl(address)}" target="_blank">${address}</a></div>`;

    if (data.label) html += `<span class="label-tag">${data.label}</span>`;

    html += `<div style="margin-top:16px;">
      <div class="stat-row"><span class="stat-label">Net Flow 24h</span><span class="mono ${valClass(data.netflow24h)}">${fmtUsd(data.netflow24h)}</span></div>
      <div class="stat-row"><span class="stat-label">Net Flow 7d</span><span class="mono ${valClass(data.netflow7d)}">${fmtUsd(data.netflow7d)}</span></div>
    </div>`;

    if (data.transfers?.length) {
      html += `<h3 style="margin-top:24px;">Recent Transfers</h3>` + renderTransferTable(data.transfers);
    }

    openDetailPanel(html);
  } catch (err) {
    openDetailPanel(`<div class="empty-state"><div class="icon">⚠️</div>${err.message}</div>`);
  }
}

async function openTokenDetail(address) {
  openDetailPanel(`<div class="empty-state"><div class="icon">⛓</div>Loading token data...<br><small>This may take 10-30s (Dune execution queue)</small></div>`);

  try {
    const res = await fetch(`${API_BASE}/api/onchain/token/${address}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    let html = `<h3>🪙 ${data.symbol} ${data.name ? `(${data.name})` : ""}</h3>
      <div style="margin-bottom:12px;"><a class="addr" href="${etherscanUrl(address)}" target="_blank">${address}</a></div>`;

    html += `<div>
      <div class="stat-row"><span class="stat-label">Whale Buys 24h</span><span class="mono val-positive">${fmtUsd(data.whaleBuys24h)}</span></div>
      <div class="stat-row"><span class="stat-label">Whale Sells 24h</span><span class="mono val-negative">${fmtUsd(data.whaleSells24h)}</span></div>
    </div>`;

    if (data.whaleActivity?.length) {
      html += `<h3 style="margin-top:24px;">Whale Activity</h3>` + renderWalletTable(data.whaleActivity);
    }

    openDetailPanel(html);
  } catch (err) {
    openDetailPanel(`<div class="empty-state"><div class="icon">⚠️</div>${err.message}</div>`);
  }
}

// --- Keyboard shortcut ----------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
  if (e.key === "/" && document.activeElement !== $("searchInput")) {
    e.preventDefault();
    $("searchInput").focus();
  }
});

// --- Init ------------------------------------------------------
loadOverview();

// Auto-refresh every 3 minutes
setInterval(loadOverview, 3 * 60 * 1000);

