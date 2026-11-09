(function () {
  "use strict";

  // Potential Buys: screenshots of stocks and tokens worth a closer look.
  // They stay on the server (DATA_DIR) until deleted here.

  var API = "/api/potential-buys";
  var ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var UI = window.MarketUI;
  var escapeHtml = UI.escapeHtml;

  var state = { items: [], loading: true, error: "", uploading: 0, filter: "", viewing: null };

  var el = {
    grid: document.getElementById("pbGrid"),
    count: document.getElementById("pbCount"),
    search: document.getElementById("pbSearch"),
    dropzone: document.getElementById("pbDropzone"),
    dropzoneTitle: document.getElementById("pbDropzoneTitle"),
    file: document.getElementById("pbFile"),
    add: document.getElementById("pbAdd"),
    refresh: document.getElementById("pbRefresh"),
    toast: document.getElementById("pbToast"),
    viewer: document.getElementById("pbViewer"),
    viewerImg: document.getElementById("pbViewerImg"),
    viewerLabel: document.getElementById("pbViewerLabel"),
    viewerWhen: document.getElementById("pbViewerWhen"),
    viewerOpen: document.getElementById("pbViewerOpen"),
    viewerDelete: document.getElementById("pbViewerDelete"),
    viewerClose: document.getElementById("pbViewerClose"),
  };

  var toastTimer = null;
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle("is-error", Boolean(isError));
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, isError ? 6000 : 3000);
  }

  async function request(url, options) {
    var res = await fetch(url, Object.assign({ cache: "no-store", credentials: "same-origin" }, options || {}));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Request failed (HTTP " + res.status + ")");
    return data;
  }

  function formatWhen(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    var time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return "Today, " + time;
    var sameYear = d.getFullYear() === new Date().getFullYear();
    var date = d.toLocaleDateString([], sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" });
    return date + ", " + time;
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function visibleItems() {
    var q = state.filter.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter(function (item) { return (item.label || "").toLowerCase().indexOf(q) !== -1; });
  }

  function render() {
    var n = state.items.length;
    el.count.textContent = state.loading && !n ? "Loading…" : n + (n === 1 ? " screenshot" : " screenshots");

    el.dropzone.classList.toggle("is-uploading", state.uploading > 0);
    el.dropzoneTitle.textContent = state.uploading > 0
      ? "Saving " + state.uploading + " screenshot" + (state.uploading === 1 ? "" : "s") + "…"
      : "Paste, drag and drop, or tap to add screenshots";

    if (state.error && !n) {
      el.grid.innerHTML = UI.errorState("Couldn't load Potential Buys", state.error);
      return;
    }
    if (state.loading && !n) {
      el.grid.innerHTML = UI.skeletonCard(3) + UI.skeletonCard(3) + UI.skeletonCard(3);
      return;
    }
    if (!n) {
      el.grid.innerHTML = UI.emptyState(
        "No potential buys yet",
        "Screenshot a chart or a token you want to come back to, then paste it here."
      );
      return;
    }
    var items = visibleItems();
    if (!items.length) {
      el.grid.innerHTML = UI.emptyState("Nothing matches “" + state.filter.trim() + "”", "Clear the filter to see every screenshot.");
      return;
    }

    el.grid.innerHTML = items.map(function (item) {
      var id = escapeHtml(item.id);
      var label = escapeHtml(item.label || "");
      var alt = item.label ? "Screenshot: " + label : "Screenshot added " + escapeHtml(formatWhen(item.createdAt));
      return (
        '<article class="pb-card" data-id="' + id + '">' +
          '<button type="button" class="pb-thumb" data-action="view" aria-label="View full size">' +
            '<img src="' + escapeHtml(item.url) + '" alt="' + alt + '" loading="lazy" />' +
          "</button>" +
          '<div class="pb-card-body">' +
            '<input class="pb-label" type="text" maxlength="140" value="' + label + '" ' +
              'placeholder="Add ticker or note…" aria-label="Label" data-action="label" />' +
            '<div class="pb-card-foot">' +
              '<span class="pb-when" title="' + escapeHtml(formatSize(item.size)) + '">' + escapeHtml(formatWhen(item.createdAt)) + "</span>" +
              '<button type="button" class="pb-btn pb-btn-danger" data-action="delete">Delete</button>' +
            "</div>" +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  function findItem(id) {
    return state.items.find(function (item) { return item.id === id; }) || null;
  }

  async function load() {
    state.loading = true;
    el.refresh.disabled = true;
    render();
    try {
      var data = await request(API);
      state.items = Array.isArray(data.items) ? data.items : [];
      state.error = "";
    } catch (err) {
      state.error = err.message;
      if (state.items.length) toast(err.message, true);
    }
    state.loading = false;
    el.refresh.disabled = false;
    render();
  }

  async function uploadFiles(files) {
    var images = files.filter(function (f) { return f && f.type && f.type.indexOf("image/") === 0; });
    if (!images.length) {
      toast("That isn't an image — add a screenshot.", true);
      return;
    }
    state.uploading += images.length;
    render();
    var stored = 0;
    var lastError = "";
    for (var i = 0; i < images.length; i += 1) {
      var file = images[i];
      try {
        if (ACCEPTED.indexOf(file.type) === -1) {
          throw new Error(file.name + " is " + (file.type || "an unknown type") + "; use PNG, JPEG, WebP or GIF.");
        }
        var data = await request(API, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        state.items = [data.item].concat(state.items.filter(function (it) { return it.id !== data.item.id; }));
        stored += 1;
      } catch (err) {
        lastError = err.message;
      }
      state.uploading -= 1;
      render();
    }
    if (stored) toast(stored === 1 ? "Screenshot saved to Potential Buys." : stored + " screenshots saved to Potential Buys.");
    if (lastError) toast(lastError, true);
  }

  async function saveLabel(id, input) {
    var item = findItem(id);
    if (!item) return;
    var label = input.value.replace(/\s+/g, " ").trim();
    if (label === (item.label || "")) return;
    try {
      var data = await request(API + "/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label }),
      });
      item.label = data.item.label;
      input.value = item.label;
      toast("Label saved.");
    } catch (err) {
      input.value = item.label || "";
      toast(err.message, true);
    }
  }

  async function remove(id) {
    var item = findItem(id);
    if (!item) return;
    var name = item.label ? "“" + item.label + "”" : "this screenshot";
    if (!window.confirm("Delete " + name + " from Potential Buys? This can't be undone.")) return;
    try {
      await request(API + "/" + encodeURIComponent(id), { method: "DELETE" });
      state.items = state.items.filter(function (it) { return it.id !== id; });
      if (state.viewing === id) closeViewer();
      render();
      toast("Screenshot deleted.");
    } catch (err) {
      toast(err.message, true);
    }
  }

  function openViewer(id) {
    var item = findItem(id);
    if (!item) return;
    state.viewing = id;
    el.viewerImg.src = item.url;
    el.viewerImg.alt = item.label ? "Screenshot: " + item.label : "Screenshot";
    el.viewerLabel.textContent = item.label || "Untitled screenshot";
    el.viewerWhen.textContent = "Added " + formatWhen(item.createdAt) + (item.size ? " · " + formatSize(item.size) : "");
    el.viewerOpen.href = item.url;
    if (typeof el.viewer.showModal === "function") el.viewer.showModal();
    else window.open(item.url, "_blank", "noopener");
  }

  function closeViewer() {
    state.viewing = null;
    if (el.viewer.open) el.viewer.close();
  }

  // Events
  el.add.addEventListener("click", function () { el.file.click(); });
  el.refresh.addEventListener("click", function () { load(); });
  el.dropzone.addEventListener("click", function () { el.file.click(); });
  el.dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.file.click(); }
  });
  el.file.addEventListener("change", function () {
    var files = Array.from(el.file.files || []);
    el.file.value = "";
    if (files.length) uploadFiles(files);
  });
  el.dropzone.addEventListener("dragover", function (e) { e.preventDefault(); el.dropzone.classList.add("is-dragging"); });
  el.dropzone.addEventListener("dragleave", function () { el.dropzone.classList.remove("is-dragging"); });
  el.dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    el.dropzone.classList.remove("is-dragging");
    uploadFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || []));
  });
  // Paste anywhere on the page stores the screenshot — unless the paste is
  // text going into a field.
  document.addEventListener("paste", function (e) {
    var files = Array.from((e.clipboardData && e.clipboardData.items) || [])
      .filter(function (i) { return i.kind === "file" && i.type.indexOf("image/") === 0; })
      .map(function (i) { return i.getAsFile(); })
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    uploadFiles(files);
  });

  el.search.addEventListener("input", function () { state.filter = el.search.value; render(); });

  el.grid.addEventListener("click", function (e) {
    var target = e.target.closest("[data-action]");
    var card = e.target.closest(".pb-card");
    if (!target || !card) return;
    var id = card.getAttribute("data-id");
    var action = target.getAttribute("data-action");
    if (action === "view") openViewer(id);
    else if (action === "delete") remove(id);
  });
  el.grid.addEventListener("keydown", function (e) {
    if (e.target.matches(".pb-label") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.target.matches(".pb-label") && e.key === "Escape") {
      var item = findItem(e.target.closest(".pb-card").getAttribute("data-id"));
      e.target.value = (item && item.label) || "";
      e.target.blur();
    }
  });
  el.grid.addEventListener("focusout", function (e) {
    if (!e.target.matches(".pb-label")) return;
    saveLabel(e.target.closest(".pb-card").getAttribute("data-id"), e.target);
  });

  el.viewerClose.addEventListener("click", closeViewer);
  el.viewerDelete.addEventListener("click", function () { if (state.viewing) remove(state.viewing); });
  el.viewer.addEventListener("close", function () { state.viewing = null; });
  // A click on the backdrop (outside the dialog box) closes it.
  el.viewer.addEventListener("click", function (e) { if (e.target === el.viewer) closeViewer(); });

  var uploadUrl = document.getElementById("pbUploadUrl");
  if (uploadUrl) uploadUrl.textContent = window.location.origin + API + "/upload";

  render();
  load();
})();
