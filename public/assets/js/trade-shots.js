(function () {
  "use strict";

  // Active Trades → Trade notes: your own marked-up screenshots, kept beside
  // the cards. Drop (or paste) one or more images on the grey box and they
  // become one entry with a timestamp and a ticker; images dropped together
  // sit side by side in that entry. Once a ticker has two or more entries
  // they collapse into a folder for that ticker.
  //
  // Same store and ticker rules as Potential Buys (ticker-label.js), kept in
  // its own collection: /api/active-trade-shots.

  var API = "/api/active-trade-shots";
  var ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var MAX_BYTES = 15 * 1024 * 1024;
  var Ticker = window.TickerLabel;

  var panel = document.getElementById("ts-panel");
  if (!panel || !Ticker) return;

  var el = {
    list: document.getElementById("ts-list"),
    count: document.getElementById("ts-count"),
    drop: document.getElementById("ts-drop"),
    dropTitle: document.getElementById("ts-drop-title"),
    file: document.getElementById("ts-file"),
    ticker: document.getElementById("ts-ticker"),
    note: document.getElementById("ts-note"),
    tickers: document.getElementById("ts-tickers"),
    status: document.getElementById("ts-status"),
    grid: document.getElementById("tc-grid"),
  };

  var state = {
    items: [],
    loading: true,
    error: "",
    uploading: 0,
    open: {},        // folder tag → true when expanded
    editing: null,   // entry key being relabelled
    draft: null,     // unsaved note text while editing, kept across re-renders
    active: [],      // base tickers of the tracked pairs, e.g. ["BTC", "XRP"]
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var statusTimer = null;
  function setStatus(message, isError) {
    el.status.textContent = message || "";
    el.status.classList.toggle("is-error", Boolean(isError));
    clearTimeout(statusTimer);
    if (message && !isError) statusTimer = setTimeout(function () { el.status.textContent = ""; }, 4000);
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
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today " + time;
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday " + time;
    var opts = d.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
    return d.toLocaleDateString([], opts) + " " + time;
  }

  /** "BTCUSDT" → "BTC"; other symbols are left as they are. */
  function baseOf(symbol) {
    var s = String(symbol || "").toUpperCase();
    return s.replace(/(USDT|USDC|BUSD|USD)$/, "") || s;
  }

  function newBatchId() {
    var rand = Math.floor(Math.random() * 0xffffffff).toString(16);
    return (Date.now().toString(36) + "-" + rand).toLowerCase();
  }

  // ---- grouping -------------------------------------------------------------

  /** Screenshots sent together (same batch) are one entry; oldest image first. */
  function buildEntries() {
    var byKey = {};
    var order = [];
    state.items.forEach(function (item) {
      var key = item.batch || item.id;
      if (!byKey[key]) {
        byKey[key] = { key: key, batch: item.batch || "", items: [] };
        order.push(key);
      }
      byKey[key].items.push(item);
    });
    return order.map(function (key) {
      var entry = byKey[key];
      entry.items.sort(function (a, b) { return a.createdAt - b.createdAt; });
      var first = entry.items[0];
      entry.label = first.label || "";
      entry.tag = Ticker.extractTags(entry.label)[0] || "";
      entry.createdAt = first.createdAt;
      entry.updatedAt = entry.items.reduce(function (max, item) {
        return Math.max(max, item.updatedAt || item.createdAt || 0);
      }, 0);
      return entry;
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /** A note without its ticker, so the ticker isn't shown twice. */
  function noteOf(entry) {
    if (!entry.tag) return entry.label;
    var re = new RegExp("(^|\\s)[$#]" + entry.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)", "i");
    return entry.label.replace(re, " ").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  }

  function isActive(tag) {
    return Boolean(tag) && state.active.indexOf(tag) !== -1;
  }

  // ---- render ---------------------------------------------------------------

  function tickerChip(tag) {
    if (!tag) return '<span class="ts-ticker ts-ticker--none">No ticker</span>';
    var active = isActive(tag);
    return '<span class="ts-ticker' + (active ? " ts-ticker--active" : "") + '"' +
      (active ? ' title="$' + escapeHtml(tag) + ' is in Active Trades"' : "") + ">" +
      (active ? '<span class="ts-live" aria-hidden="true"></span>' : "") +
      "$" + escapeHtml(tag) + (active ? '<span class="ts-sr"> (active trade)</span>' : "") + "</span>";
  }

  function thumbs(entry) {
    var many = entry.items.length > 1;
    return '<div class="ts-thumbs' + (many ? " ts-thumbs--many" : "") + '">' +
      entry.items.map(function (item, i) {
        return '<figure class="ts-thumb">' +
          '<img src="' + escapeHtml(item.url) + '" alt="' + escapeHtml((entry.label || "Screenshot") + " — image " + (i + 1)) +
            '" loading="lazy" decoding="async" data-zoomable />' +
          (many
            ? '<button class="ts-thumb-x" type="button" data-role="remove-image" data-id="' + escapeHtml(item.id) +
              '" aria-label="Delete image ' + (i + 1) + ' of this entry" title="Delete this image">&times;</button>'
            : "") +
        "</figure>";
      }).join("") +
    "</div>";
  }

  function renderEntry(entry) {
    var note = noteOf(entry);
    var editing = state.editing === entry.key;
    var count = entry.items.length;
    return '<article class="ts-entry" data-entry="' + escapeHtml(entry.key) + '">' +
      '<div class="ts-entry-head">' +
        tickerChip(entry.tag) +
        '<time class="ts-when" datetime="' + new Date(entry.createdAt).toISOString() + '">' + escapeHtml(formatWhen(entry.createdAt)) + "</time>" +
        (count > 1 ? '<span class="ts-n">' + count + " images</span>" : "") +
        '<span class="ts-entry-tools">' +
          '<button class="ts-icon" type="button" data-role="edit" aria-label="Edit ticker and note" title="Edit ticker / note">&#9998;</button>' +
          '<button class="ts-icon ts-icon--danger" type="button" data-role="remove-entry" aria-label="Delete this entry" title="Delete entry">&#128465;</button>' +
        "</span>" +
      "</div>" +
      (editing
        ? '<form class="ts-edit" data-role="edit-form">' +
            '<textarea class="ts-input ts-input--note" name="label" rows="5" maxlength="1000" ' +
              'aria-label="Ticker and note" placeholder="$BTC entry, stop under range low">' +
              escapeHtml(state.draft != null ? state.draft : entry.label) + "</textarea>" +
            '<span class="ts-edit-hint">Enter for a new line &middot; Ctrl+Enter to save</span>' +
            '<div class="ts-edit-actions">' +
              (entry.batch
                ? '<input class="ts-edit-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />' +
                  '<button class="ts-btn" type="button" data-role="edit-add" title="Add more screenshots to this entry (or paste one)">&#43; Add photos</button>'
                : "") +
              '<button class="ts-btn ts-btn--primary" type="submit">Save</button>' +
              '<button class="ts-btn" type="button" data-role="edit-cancel">Cancel</button>' +
            "</div>" +
          "</form>"
        : note ? '<p class="ts-note">' + escapeHtml(note) + "</p>" : "") +
      thumbs(entry) +
    "</article>";
  }

  function renderFolder(tag, entries) {
    var open = Boolean(state.open[tag]);
    var images = entries.reduce(function (n, e) { return n + e.items.length; }, 0);
    var latest = entries[0].createdAt;
    return '<section class="ts-folder' + (open ? " is-open" : "") + '" data-folder="' + escapeHtml(tag) + '">' +
      '<button class="ts-folder-head" type="button" data-role="toggle" aria-expanded="' + open + '">' +
        '<span class="ts-folder-icon" aria-hidden="true">' + (open ? "&#128194;" : "&#128193;") + "</span>" +
        tickerChip(tag) +
        '<span class="ts-folder-meta">' + entries.length + " entries · " + images + " image" + (images === 1 ? "" : "s") +
          " · " + escapeHtml(formatWhen(latest)) + "</span>" +
        '<span class="ts-chevron" aria-hidden="true">&#9662;</span>' +
      "</button>" +
      (open
        ? '<div class="ts-folder-body">' + entries.map(renderEntry).join("") + "</div>"
        : '<div class="ts-folder-peek" aria-hidden="true">' +
            entries.slice(0, 4).map(function (e) {
              return '<img src="' + escapeHtml(e.items[0].url) + '" alt="" loading="lazy" decoding="async" />';
            }).join("") +
          "</div>") +
    "</section>";
  }

  function render() {
    var entries = buildEntries();
    var images = state.items.length;
    el.count.textContent = state.loading ? "Loading…"
      : entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + (images > entries.length ? " · " + images + " images" : "");

    if (state.loading && !state.items.length) {
      el.list.innerHTML = '<div class="ts-skeleton"></div><div class="ts-skeleton"></div>';
      return;
    }
    if (state.error && !state.items.length) {
      el.list.innerHTML = '<div class="ts-empty ts-empty--error">&#9888;&#65039; ' + escapeHtml(state.error) +
        ' <button class="ts-btn" type="button" data-role="retry">Retry</button></div>';
      return;
    }
    if (!entries.length) {
      el.list.innerHTML = '<div class="ts-empty">No trade notes yet. Drop a marked-up chart above &mdash; ' +
        "or drop it straight onto a trade card to file it under that ticker.</div>";
      return;
    }

    // One folder per ticker that has two or more entries; everything else
    // (single entries, untagged) stays loose. Newest activity first.
    var byTag = {};
    entries.forEach(function (entry) {
      if (entry.tag) (byTag[entry.tag] = byTag[entry.tag] || []).push(entry);
    });
    var blocks = [];
    var placed = {};
    entries.forEach(function (entry) {
      var group = entry.tag ? byTag[entry.tag] : null;
      if (group && group.length > 1) {
        if (placed[entry.tag]) return;
        placed[entry.tag] = true;
        blocks.push(renderFolder(entry.tag, group));
      } else {
        blocks.push(renderEntry(entry));
      }
    });
    el.list.innerHTML = blocks.join("");
  }

  function renderTickerOptions() {
    el.tickers.innerHTML = state.active.map(function (tag) {
      return '<option value="' + escapeHtml(tag) + '"></option>';
    }).join("");
  }

  // ---- data -----------------------------------------------------------------

  async function load() {
    state.loading = true;
    render();
    try {
      var data = await request(API);
      state.items = Array.isArray(data.items) ? data.items : [];
      state.error = "";
    } catch (err) {
      state.error = "Couldn't load trade notes: " + err.message;
    }
    state.loading = false;
    render();
  }

  function imageFiles(list) {
    return Array.prototype.filter.call(list || [], function (file) {
      return file && ACCEPTED.indexOf(file.type) !== -1;
    });
  }

  /**
   * Upload files as one entry. `target` adds them to an existing entry
   * (same batch and label); otherwise the ticker and note fields label it.
   */
  async function upload(files, target) {
    files = imageFiles(files);
    if (!files.length) {
      setStatus("Only PNG, JPEG, WebP or GIF images can be added.", true);
      return;
    }
    var tooBig = files.filter(function (f) { return f.size > MAX_BYTES; });
    files = files.filter(function (f) { return f.size <= MAX_BYTES; });
    if (!files.length) {
      setStatus("Images must be 15 MB or smaller.", true);
      return;
    }

    var label = target ? target.label : Ticker.withTicker(el.ticker.value, el.note.value);
    if (!target && el.ticker.value.trim() && Ticker.tickerSymbol(el.ticker.value) === null) {
      setStatus('"' + el.ticker.value.trim() + '" isn\'t a ticker. Use one symbol like BTC or SOL.', true);
      el.ticker.focus();
      return;
    }
    var batch = target ? (target.batch || "") : newBatchId();

    state.uploading += files.length;
    panel.classList.add("is-uploading");
    el.dropTitle.textContent = "Uploading " + files.length + " image" + (files.length === 1 ? "" : "s") + "…";
    var saved = 0;
    var failed = [];
    for (var i = 0; i < files.length; i += 1) {
      var params = new URLSearchParams();
      if (label) params.set("label", label);
      if (batch) params.set("batch", batch);
      try {
        var data = await request(API + "?" + params.toString(), {
          method: "POST",
          headers: { "Content-Type": files[i].type },
          body: files[i],
        });
        if (data.item) {
          state.items.unshift(data.item);
          saved += 1;
          render();
        }
      } catch (err) {
        failed.push(err.message);
      }
    }
    state.uploading -= files.length;
    panel.classList.toggle("is-uploading", state.uploading > 0);
    el.dropTitle.textContent = DROP_TITLE;

    if (!target && saved) el.note.value = "";
    var tag = Ticker.extractTags(label)[0];
    if (tooBig.length) failed.push(tooBig.length + " image(s) over 15 MB skipped");
    if (failed.length) {
      setStatus((saved ? "Saved " + saved + ". " : "") + failed[0], true);
    } else {
      setStatus("Saved " + saved + " image" + (saved === 1 ? "" : "s") + (tag ? " to $" + tag : " (no ticker — edit to add one)") + ".");
    }
    if (tag) state.open[tag] = true;
    render();
  }

  // Every entry made here carries a batch id; one without (none exist today)
  // couldn't take more images without splitting into a second entry.
  async function addToEntry(entry, files) {
    if (!entry.batch) {
      setStatus("Drop more images on the grey box with the same ticker to add them.", true);
      return;
    }
    await upload(files, entry);
  }

  function entryByKey(key) {
    return buildEntries().filter(function (e) { return e.key === key; })[0] || null;
  }

  async function relabel(entry, label) {
    try {
      for (var i = 0; i < entry.items.length; i += 1) {
        var data = await request(API + "/" + encodeURIComponent(entry.items[i].id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label }),
        });
        replaceItem(data.item);
      }
      state.editing = null;
      state.draft = null;
      var tag = Ticker.extractTags(label)[0];
      if (tag) state.open[tag] = true;
      setStatus("Saved.");
    } catch (err) {
      setStatus("Couldn't save: " + err.message, true);
    }
    render();
  }

  function replaceItem(item) {
    if (!item) return;
    state.items = state.items.map(function (existing) { return existing.id === item.id ? item : existing; });
  }

  async function removeIds(ids) {
    var removed = 0;
    for (var i = 0; i < ids.length; i += 1) {
      try {
        await request(API + "/" + encodeURIComponent(ids[i]), { method: "DELETE" });
        removed += 1;
        state.items = state.items.filter(function (item) { return item.id !== ids[i]; });
      } catch (err) {
        setStatus("Couldn't delete: " + err.message, true);
        break;
      }
    }
    render();
    if (removed === ids.length) setStatus("Deleted.");
  }

  // ---- events ---------------------------------------------------------------

  var DROP_TITLE = el.dropTitle.textContent;

  function hasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return Boolean(types) && Array.prototype.indexOf.call(types, "Files") !== -1;
  }

  // The grey box: drop, click, or Enter/Space to choose files.
  ["dragenter", "dragover"].forEach(function (type) {
    el.drop.addEventListener(type, function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.drop.classList.add("is-over");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    el.drop.addEventListener(type, function () { el.drop.classList.remove("is-over"); });
  });
  el.drop.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    upload(e.dataTransfer.files);
  });
  el.drop.addEventListener("click", function () { el.file.click(); });
  el.drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.file.click();
    }
  });
  el.file.addEventListener("change", function () {
    var files = Array.prototype.slice.call(el.file.files || []);
    el.file.value = "";
    if (files.length) upload(files);
  });

  // Drop onto an existing entry: the images join it, side by side.
  el.list.addEventListener("dragover", function (e) {
    var entryEl = hasFiles(e) && e.target.closest(".ts-entry");
    if (!entryEl) return;
    e.preventDefault();
    entryEl.classList.add("is-over");
  });
  el.list.addEventListener("dragleave", function (e) {
    var entryEl = e.target.closest(".ts-entry");
    if (entryEl && !entryEl.contains(e.relatedTarget)) entryEl.classList.remove("is-over");
  });
  el.list.addEventListener("drop", function (e) {
    var entryEl = hasFiles(e) && e.target.closest(".ts-entry");
    if (!entryEl) return;
    e.preventDefault();
    entryEl.classList.remove("is-over");
    var entry = entryByKey(entryEl.getAttribute("data-entry"));
    if (entry) addToEntry(entry, e.dataTransfer.files);
  });

  // Drop onto a trade card: filed under that card's ticker.
  if (el.grid) {
    el.grid.addEventListener("dragover", function (e) {
      var cardEl = hasFiles(e) && e.target.closest(".tc-card[data-symbol]");
      if (!cardEl) return;
      e.preventDefault();
      cardEl.classList.add("ts-card-over");
    });
    el.grid.addEventListener("dragleave", function (e) {
      var cardEl = e.target.closest(".tc-card");
      if (cardEl && !cardEl.contains(e.relatedTarget)) cardEl.classList.remove("ts-card-over");
    });
    el.grid.addEventListener("drop", function (e) {
      var cardEl = hasFiles(e) && e.target.closest(".tc-card[data-symbol]");
      if (!cardEl) return;
      e.preventDefault();
      cardEl.classList.remove("ts-card-over");
      el.ticker.value = baseOf(cardEl.getAttribute("data-symbol"));
      upload(e.dataTransfer.files);
    });
  }

  // Paste a screenshot anywhere on the page (Cmd/Ctrl+V after a capture).
  document.addEventListener("paste", function (e) {
    var files = imageFiles(e.clipboardData && e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    // While an entry is open for editing, a pasted screenshot joins it.
    var editingEntry = state.editing && entryByKey(state.editing);
    if (editingEntry) addToEntry(editingEntry, files);
    else upload(files);
  });

  el.list.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-role]");
    if (!btn) return;
    var role = btn.getAttribute("data-role");
    if (role === "retry") { load(); return; }
    if (role === "toggle") {
      var tag = btn.closest("[data-folder]").getAttribute("data-folder");
      state.open[tag] = !state.open[tag];
      render();
      return;
    }
    var entryEl = btn.closest(".ts-entry");
    var entry = entryEl && entryByKey(entryEl.getAttribute("data-entry"));
    if (!entry) return;
    if (role === "edit") {
      state.editing = entry.key;
      state.draft = null;
      render();
      var input = el.list.querySelector('[data-role="edit-form"] textarea');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    } else if (role === "edit-cancel") {
      state.editing = null;
      state.draft = null;
      render();
    } else if (role === "edit-add") {
      var picker = entryEl.querySelector(".ts-edit-file");
      if (picker) picker.click();
    } else if (role === "remove-entry") {
      var n = entry.items.length;
      if (window.confirm("Delete this " + (entry.tag ? "$" + entry.tag + " " : "") + "entry" +
        (n > 1 ? " and its " + n + " images" : "") + "? This can't be undone.")) {
        removeIds(entry.items.map(function (item) { return item.id; }));
      }
    } else if (role === "remove-image") {
      if (window.confirm("Delete this image from the entry?")) removeIds([btn.getAttribute("data-id")]);
    }
  });

  el.list.addEventListener("submit", function (e) {
    var form = e.target.closest('[data-role="edit-form"]');
    if (!form) return;
    e.preventDefault();
    var entryEl = form.closest(".ts-entry");
    var entry = entryEl && entryByKey(entryEl.getAttribute("data-entry"));
    if (entry) relabel(entry, Ticker.formatLabel(form.elements.label.value));
  });

  // Keep the half-typed note when an upload re-renders the list.
  el.list.addEventListener("input", function (e) {
    if (e.target.name === "label" && e.target.closest('[data-role="edit-form"]')) state.draft = e.target.value;
  });

  // "+ Add photos" in the edit form: the chosen images join this entry.
  el.list.addEventListener("change", function (e) {
    if (!e.target.classList.contains("ts-edit-file")) return;
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";
    var entryEl = e.target.closest(".ts-entry");
    var entry = entryEl && entryByKey(entryEl.getAttribute("data-entry"));
    if (entry && files.length) addToEntry(entry, files);
  });

  el.list.addEventListener("keydown", function (e) {
    var form = e.target.closest('[data-role="edit-form"]');
    if (!form) return;
    if (e.key === "Escape") {
      state.editing = null;
      state.draft = null;
      render();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      // Plain Enter starts a new line in the note; Ctrl/Cmd+Enter saves.
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // The page script announces the tracked pairs after each load, so the
  // ticker field suggests them and their entries are marked active.
  document.addEventListener("activetrades:cards", function (e) {
    var seen = {};
    state.active = ((e.detail && e.detail.symbols) || []).map(baseOf).filter(function (tag) {
      if (!tag || seen[tag]) return false;
      seen[tag] = true;
      return true;
    });
    renderTickerOptions();
    render();
  });

  load();
})();
