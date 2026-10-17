/* global document, fetch */
(function () {
  "use strict";
  const list = document.getElementById("farmclawPreviewList");
  const button = document.getElementById("farmclawPreviewRefresh");
  if (!list || !button) return;
  async function load() {
    button.disabled = true;
    list.textContent = "Loading saved previews…";
    try {
      const res = await fetch("/api/farmclaw/news-previews", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!Array.isArray(data.batches)) throw new Error();
      list.textContent = data.batches.length ? "" : "No persisted news previews yet.";
      data.batches.forEach(batch => {
        const row = document.createElement("p");
        const link = document.createElement("a");
        const url = new URL(batch.approvalUrl);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
        link.href = url.toString(); link.target = "_blank"; link.rel = "noreferrer";
        link.textContent = `${batch.clientBatchId} · revision ${batch.revision} · ${batch.status} → Review in FarmBot`;
        row.appendChild(link); list.appendChild(row);
      });
    } catch { list.textContent = "Saved previews unavailable. Check FarmBot access and preview configuration, then refresh."; }
    finally { button.disabled = false; }
  }
  button.addEventListener("click", load);
  load();
})();
