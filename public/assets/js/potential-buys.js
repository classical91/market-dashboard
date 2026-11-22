(function () {
  "use strict";

  // Potential Buys: screenshots of stocks and tokens worth a closer look.
  // They stay on the server (DATA_DIR) until deleted here.

  var API = "/api/potential-buys";
  var ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var UI = window.MarketUI;
  var Crop = window.CropRect;
  var escapeHtml = UI.escapeHtml;

  // A ticker in a label files the screenshot in that folder: typing "btc"
  // saves "$BTC" and files it under BTC. Shared with the server's store.
  var Ticker = window.TickerLabel;
  var ALL = "__all";

  var state = { items: [], loading: true, error: "", uploading: 0, filter: "", viewing: null, folder: ALL };

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
    viewerCrop: document.getElementById("pbViewerCrop"),
    heading: document.getElementById("pbHeading"),
    back: document.getElementById("pbBack"),
    statTotal: document.getElementById("pbStatTotal"),
    statTotalSub: document.getElementById("pbStatTotalSub"),
    statTickers: document.getElementById("pbStatTickers"),
    statTickersSub: document.getElementById("pbStatTickersSub"),
    statWeek: document.getElementById("pbStatWeek"),
    crop: document.getElementById("pbCrop"),
    cropStage: document.getElementById("pbCropStage"),
    cropImg: document.getElementById("pbCropImg"),
    cropBox: document.getElementById("pbCropBox"),
    cropAspects: document.getElementById("pbCropAspects"),
    cropHint: document.getElementById("pbCropHint"),
    cropSize: document.getElementById("pbCropSize"),
    cropReset: document.getElementById("pbCropReset"),
    cropCancel: document.getElementById("pbCropCancel"),
    cropClose: document.getElementById("pbCropClose"),
    cropApply: document.getElementById("pbCropApply"),
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

  function tagsOf(item) {
    return Ticker.extractTags(item && item.label);
  }

  function touchedAt(item) {
    return item.updatedAt || item.createdAt || 0;
  }

  /** One folder per hashtag, with its count and newest change; newest first. */
  function buildFolders() {
    var byTag = {};
    var untagged = { count: 0, updatedAt: 0 };
    state.items.forEach(function (item) {
      var tags = tagsOf(item);
      if (!tags.length) {
        untagged.count += 1;
        untagged.updatedAt = Math.max(untagged.updatedAt, touchedAt(item));
      }
      tags.forEach(function (tag) {
        var folder = byTag[tag] || (byTag[tag] = { tag: tag, count: 0, updatedAt: 0 });
        folder.count += 1;
        folder.updatedAt = Math.max(folder.updatedAt, touchedAt(item));
      });
    });
    var folders = Object.keys(byTag).map(function (tag) { return byTag[tag]; });
    folders.sort(function (a, b) { return b.updatedAt - a.updatedAt || a.tag.localeCompare(b.tag); });
    return { folders: folders, untagged: untagged };
  }

  function inFolder(item) {
    if (state.folder === ALL) return true;
    var tags = tagsOf(item);
    return tags.indexOf(state.folder) !== -1;
  }

  function visibleItems() {
    var q = state.filter.trim().toLowerCase();
    return state.items.filter(function (item) {
      return inFolder(item) && (!q || (item.label || "").toLowerCase().indexOf(q) !== -1);
    });
  }

  /** Which ticker folder is open (from tapping a stack) and the heading for it. */
  function syncFolder() {
    // A folder whose last screenshot was relabelled or deleted is gone; fall
    // back to everything.
    if (state.folder !== ALL && !buildFolders().folders.some(function (f) { return f.tag === state.folder; })) {
      state.folder = ALL;
    }
    el.heading.textContent = state.folder === ALL ? "Watching" : "$" + state.folder;
    el.back.hidden = state.folder === ALL;
  }

  var BASE_TITLE = document.title;
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  /** Count tab: how many potential trades are on the page right now. */
  function renderStats(built) {
    var n = state.items.length;
    if (state.loading && !n) {
      el.statTotal.textContent = "–";
      el.statTotalSub.textContent = "Loading…";
      el.statTickers.textContent = "–";
      el.statWeek.textContent = "–";
      return;
    }
    var since = Date.now() - WEEK_MS;
    var week = state.items.filter(function (item) { return (item.createdAt || 0) >= since; }).length;
    var tickers = built.folders.length;
    el.statTotal.textContent = String(n);
    el.statTotalSub.textContent = built.untagged.count
      ? built.untagged.count + " untagged"
      : n ? "All tagged" : "Nothing saved yet";
    el.statTickers.textContent = String(tickers);
    el.statTickersSub.textContent = tickers
      ? built.folders.slice(0, 3).map(function (f) { return "$" + f.tag; }).join(" ") + (tickers > 3 ? " +" + (tickers - 3) : "")
      : "Distinct tickers";
    el.statWeek.textContent = String(week);
    document.title = (n ? "(" + n + ") " : "") + BASE_TITLE;
  }

  function render() {
    syncFolder();
    renderStats(buildFolders());
    var n = state.items.length;
    var shown = state.folder === ALL ? n : state.items.filter(inFolder).length;
    el.count.textContent = state.loading && !n ? "Loading…" : shown + (shown === 1 ? " screenshot" : " screenshots");

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
      el.grid.innerHTML = state.filter.trim()
        ? UI.emptyState("Nothing matches “" + state.filter.trim() + "”", "Clear the filter to see every screenshot.")
        : UI.emptyState("This folder is empty", "Choose All to see everything.");
      return;
    }

    el.grid.innerHTML = gridEntries(items).map(function (entry) {
      return entry.stack ? stackCard(entry.tag, entry.items) : itemCard(entry.item);
    }).join("");
  }

  /**
   * On the All view, screenshots of the same ticker stack into one folder
   * card, ranked by how many screenshots each holds (single screenshots
   * last); ties put the one with the newest screenshot first. Inside a folder, or
   * while filtering, every screenshot shows on its own, newest first.
   */
  function gridEntries(items) {
    if (state.folder !== ALL || state.filter.trim()) {
      return items.map(function (item) { return { item: item }; });
    }
    var groups = {};
    items.forEach(function (item) {
      var tag = tagsOf(item)[0];
      if (tag) (groups[tag] || (groups[tag] = [])).push(item);
    });
    var entries = [];
    var placed = {};
    items.forEach(function (item) {
      var tag = tagsOf(item)[0];
      if (!tag || groups[tag].length < 2) {
        entries.push({ item: item });
      } else if (!placed[tag]) {
        placed[tag] = true;
        entries.push({ stack: true, tag: tag, items: groups[tag] });
      }
    });
    // Array sort is stable, so equal sizes stay in newest-first order.
    return entries.sort(function (a, b) {
      return (b.stack ? b.items.length : 1) - (a.stack ? a.items.length : 1);
    });
  }

  function stackCard(tag, items) {
    // The folder's cover is its oldest screenshot,
    // with the next-oldest ones peeking out behind it.
    var byAge = items.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var top = byAge[0];
    var name = "$" + tag;
    var updated = items.reduce(function (max, item) { return Math.max(max, touchedAt(item)); }, 0);
    var peeks = byAge.slice(1, 3).map(function (item, i) {
      return '<img class="pb-stack-peek pb-stack-peek-' + (i + 1) + '" src="' + escapeHtml(item.url) + '" alt="" loading="lazy" />';
    }).join("");
    return (
      '<article class="pb-card pb-stack" data-folder="' + escapeHtml(tag) + '">' +
        '<button type="button" class="pb-thumb pb-stack-thumb" data-action="open-folder" ' +
          'aria-label="Open ' + escapeHtml(name) + " folder, " + items.length + ' screenshots">' +
          peeks +
          '<img class="pb-stack-top" src="' + escapeHtml(top.url) + '" alt="" loading="lazy" />' +
          '<span class="pb-stack-badge" aria-hidden="true">' + items.length + "</span>" +
        "</button>" +
        '<div class="pb-card-body">' +
          '<div class="pb-stack-name"><span class="pb-folder-icon" aria-hidden="true"></span>' + escapeHtml(name) + "</div>" +
          '<div class="pb-card-foot">' +
            '<span class="pb-when">' + items.length + " screenshots · " + escapeHtml(formatWhen(updated)) + "</span>" +
            '<button type="button" class="pb-btn" data-action="open-folder">Open</button>' +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  function itemCard(item) {
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
            'placeholder="Ticker (BTC) or note…" aria-label="Label" data-action="label" ' +
            'autocomplete="off" spellcheck="false" />' +
          '<div class="pb-card-foot">' +
            '<span class="pb-when" title="' + escapeHtml(formatSize(item.size)) + '">' + escapeHtml(formatWhen(item.createdAt)) + "</span>" +
            '<button type="button" class="pb-btn" data-action="crop">Crop</button>' +
            '<button type="button" class="pb-btn pb-btn-danger" data-action="delete">Delete</button>' +
          "</div>" +
        "</div>" +
      "</article>"
    );
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
    var label = Ticker.formatLabel(input.value);
    input.value = label;
    if (label === Ticker.formatLabel(item.label)) return;
    try {
      var data = await request(API + "/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label }),
      });
      var hadTags = tagsOf(item).join(",");
      Object.assign(item, data.item);
      input.value = item.label;
      var tags = tagsOf(item);
      if (tags.join(",") !== hadTags && tags.length) {
        toast("Label saved · filed in " + tags.map(function (t) { return "$" + t; }).join(", ") + ".");
      } else {
        toast("Label saved.");
      }
      render();
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

  // ── Crop editor (ported from farm-bot's components/ImageCropper.tsx) ──
  // A draggable, resizable box over the screenshot with aspect presets. Apply
  // draws the crop to a canvas and replaces the stored picture with it.

  var ASPECTS = [
    { id: "free", label: "Free", value: null },
    { id: "16:9", label: "16:9", value: 16 / 9 },
    { id: "4:3", label: "4:3", value: 4 / 3 },
    { id: "1:1", label: "1:1", value: 1 },
    { id: "4:5", label: "4:5", value: 4 / 5 },
  ];
  var MAX_OUTPUT_SIDE = 4096;
  var CORNERS = ["nw", "ne", "sw", "se"];
  var EDGES = ["n", "s", "e", "w"];

  var crop = { id: null, rect: Crop.FULL_CROP, aspectId: "free", natural: null, drag: null, applying: false };

  function cropAspect() {
    var found = ASPECTS.find(function (a) { return a.id === crop.aspectId; });
    return found ? found.value : null;
  }

  function cropImageAspect() {
    return crop.natural ? crop.natural.w / crop.natural.h : 1;
  }

  function renderCropAspects() {
    el.cropAspects.innerHTML = ASPECTS.map(function (a) {
      var active = a.id === crop.aspectId;
      return '<button type="button" class="pb-chip' + (active ? " is-active" : "") + '" data-aspect="' + a.id +
        '" aria-pressed="' + active + '">' + a.label + "</button>";
    }).join("");
  }

  function renderCropHandles() {
    var handles = cropAspect() ? CORNERS : CORNERS.concat(EDGES);
    Array.from(el.cropBox.querySelectorAll(".pb-crop-handle")).forEach(function (h) { h.remove(); });
    handles.forEach(function (h) {
      var span = document.createElement("span");
      span.className = "pb-crop-handle pb-crop-handle-" + h;
      span.setAttribute("data-handle", h);
      span.setAttribute("aria-hidden", "true");
      el.cropBox.appendChild(span);
    });
  }

  function renderCrop() {
    var r = crop.rect;
    el.cropBox.hidden = !crop.natural;
    el.cropBox.style.left = r.x * 100 + "%";
    el.cropBox.style.top = r.y * 100 + "%";
    el.cropBox.style.width = r.width * 100 + "%";
    el.cropBox.style.height = r.height * 100 + "%";
    el.cropReset.disabled = !crop.natural || (Crop.isFullCrop(r) && crop.aspectId === "free");
    el.cropApply.disabled = !crop.natural || crop.applying || Crop.isFullCrop(r);
    el.cropApply.textContent = crop.applying ? "Saving…" : "Apply crop";
    if (!crop.natural) return;
    var px = Crop.cropToPixels(r, crop.natural.w, crop.natural.h);
    var out = Crop.outputSize(px.sw, px.sh, MAX_OUTPUT_SIDE);
    el.cropSize.textContent = out.width + " × " + out.height + " px (from " + crop.natural.w + " × " + crop.natural.h + ")";
    el.cropBox.setAttribute("aria-label", "Crop area, " + px.sw + " by " + px.sh + " pixels — drag to move, arrow keys to nudge");
  }

  function openCrop(id) {
    var item = findItem(id);
    if (!item) return;
    if (typeof el.crop.showModal !== "function") {
      toast("This browser can't open the crop editor.", true);
      return;
    }
    crop.id = id;
    crop.rect = Crop.FULL_CROP;
    crop.aspectId = "free";
    crop.natural = null;
    crop.drag = null;
    crop.applying = false;
    el.cropHint.textContent = "Loading screenshot…";
    el.cropHint.classList.remove("is-error");
    el.cropSize.textContent = item.label || "Untitled screenshot";
    renderCropAspects();
    renderCropHandles();
    renderCrop();
    el.cropImg.removeAttribute("src");
    el.cropImg.src = item.url;
    if (el.viewer.open) el.viewer.close();
    el.crop.showModal();
  }

  function closeCrop() {
    crop.id = null;
    crop.drag = null;
    if (el.crop.open) el.crop.close();
  }

  function chooseAspect(id) {
    crop.aspectId = id;
    var value = cropAspect();
    if (value) crop.rect = Crop.fitAspect(value, cropImageAspect(), crop.rect);
    renderCropAspects();
    renderCropHandles();
    renderCrop();
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("Couldn't render the crop in this browser."));
      }, type, quality);
    });
  }

  async function applyCrop() {
    var item = findItem(crop.id);
    if (!item || !crop.natural || crop.applying) return;
    var px = Crop.cropToPixels(crop.rect, crop.natural.w, crop.natural.h);
    var out = Crop.outputSize(px.sw, px.sh, MAX_OUTPUT_SIDE);
    // PNG and GIF screenshots keep crisp text as PNG; photos go out as JPEG.
    var type = item.mimeType === "image/png" || item.mimeType === "image/gif" ? "image/png" : "image/jpeg";
    crop.applying = true;
    renderCrop();
    try {
      var canvas = document.createElement("canvas");
      canvas.width = out.width;
      canvas.height = out.height;
      var ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable in this browser.");
      if (type === "image/jpeg") {
        // JPEG has no transparency; give see-through pictures a white backing.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, out.width, out.height);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(el.cropImg, px.sx, px.sy, px.sw, px.sh, 0, 0, out.width, out.height);
      var blob = await canvasToBlob(canvas, type, 0.92);
      var data = await request(API + "/" + encodeURIComponent(item.id) + "/image", {
        method: "PUT",
        headers: { "Content-Type": type },
        body: blob,
      });
      Object.assign(item, data.item);
      crop.applying = false;
      closeCrop();
      render();
      toast("Screenshot cropped.");
    } catch (err) {
      crop.applying = false;
      renderCrop();
      el.cropHint.textContent = err.message;
      el.cropHint.classList.add("is-error");
    }
  }

  el.cropImg.addEventListener("load", function () {
    if (!crop.id) return;
    crop.natural = { w: el.cropImg.naturalWidth, h: el.cropImg.naturalHeight };
    el.cropHint.textContent = "Drag the box or its corners; arrow keys nudge it (Shift for bigger steps).";
    renderCrop();
  });
  el.cropImg.addEventListener("error", function () {
    if (!crop.id) return;
    el.cropHint.textContent = "This screenshot couldn't be opened for cropping.";
    el.cropHint.classList.add("is-error");
  });
  el.cropAspects.addEventListener("click", function (e) {
    var chip = e.target.closest("[data-aspect]");
    if (chip) chooseAspect(chip.getAttribute("data-aspect"));
  });
  el.cropBox.addEventListener("pointerdown", function (e) {
    if (!crop.natural) return;
    var handleEl = e.target.closest("[data-handle]");
    e.preventDefault();
    if (el.cropBox.setPointerCapture) el.cropBox.setPointerCapture(e.pointerId);
    crop.drag = {
      handle: handleEl ? handleEl.getAttribute("data-handle") : "move",
      startX: e.clientX,
      startY: e.clientY,
      start: crop.rect,
    };
  });
  el.cropBox.addEventListener("pointermove", function (e) {
    var drag = crop.drag;
    if (!drag) return;
    var box = el.cropStage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var dx = (e.clientX - drag.startX) / box.width;
    var dy = (e.clientY - drag.startY) / box.height;
    crop.rect = Crop.dragCrop(drag.start, drag.handle, dx, dy, cropAspect(), cropImageAspect());
    renderCrop();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (type) {
    el.cropBox.addEventListener(type, function () { crop.drag = null; });
  });
  el.cropBox.addEventListener("keydown", function (e) {
    var step = e.shiftKey ? 0.02 : 0.005;
    var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    var move = moves[e.key];
    if (!move || !crop.natural) return;
    e.preventDefault();
    crop.rect = Crop.dragCrop(crop.rect, "move", move[0], move[1], cropAspect(), cropImageAspect());
    renderCrop();
  });
  el.cropReset.addEventListener("click", function () {
    crop.aspectId = "free";
    crop.rect = Crop.FULL_CROP;
    renderCropAspects();
    renderCropHandles();
    renderCrop();
  });
  el.cropApply.addEventListener("click", applyCrop);
  el.cropCancel.addEventListener("click", closeCrop);
  el.cropClose.addEventListener("click", closeCrop);
  el.crop.addEventListener("close", function () { crop.id = null; crop.drag = null; });

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

  function openFolder(key) {
    state.folder = key;
    render();
    el.heading.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  el.grid.addEventListener("click", function (e) {
    var target = e.target.closest("[data-action]");
    var card = e.target.closest(".pb-card");
    if (!target || !card) return;
    var id = card.getAttribute("data-id");
    var action = target.getAttribute("data-action");
    if (action === "open-folder") { openFolder(card.getAttribute("data-folder")); return; }
    if (action === "view") openViewer(id);
    else if (action === "crop") openCrop(id);
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

  el.back.addEventListener("click", function () { openFolder(ALL); });
  el.viewerClose.addEventListener("click", closeViewer);
  el.viewerCrop.addEventListener("click", function () { if (state.viewing) openCrop(state.viewing); });

  el.viewerDelete.addEventListener("click", function () { if (state.viewing) remove(state.viewing); });
  el.viewer.addEventListener("close", function () { state.viewing = null; });
  // A click on the backdrop (outside the dialog box) closes it.
  el.viewer.addEventListener("click", function (e) { if (e.target === el.viewer) closeViewer(); });

  var uploadUrl = document.getElementById("pbUploadUrl");
  if (uploadUrl) uploadUrl.textContent = window.location.origin + API + "/upload";

  render();
  load();
})();
