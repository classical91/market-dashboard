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
    staged: document.getElementById("ts-staged"),
    post: document.getElementById("ts-post"),
    clear: document.getElementById("ts-clear"),
    composeHint: document.getElementById("ts-compose-hint"),
    tickers: document.getElementById("ts-tickers"),
    status: document.getElementById("ts-status"),
    grid: document.getElementById("tc-grid"),
  };

  /** Longest URL-encoded label sent in the upload's query string. */
  var MAX_QUERY_LABEL = 1500;

  var state = {
    items: [],
    loading: true,
    error: "",
    uploading: 0,
    open: {},        // folder tag → true when expanded
    editing: null,   // entry key being relabelled
    picking: null,   // entry key whose TP / SL / liquidated picker is open
    draft: null,     // unsaved note text while editing, kept across re-renders
    staged: [],      // composer screenshots not posted yet: { id, file, url }
    composeBatch: "",// batch of a part-posted composer, so a retry joins it
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
      entry.outcome = OUTCOMES[first.outcome] ? first.outcome : "";
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

  /** How a trade ended: a sticker beside its ticker. Stored per image as `outcome`. */
  var OUTCOMES = {
    tp: { icon: "\uD83C\uDFAF", text: "TP hit", title: "Took profit" },
    sl: { icon: "\uD83D\uDED1", text: "SL hit", title: "Stopped out" },
    liquidated: { icon: "\uD83D\uDC80", text: "Liquidated", title: "Liquidated" },
  };
  var OUTCOME_ORDER = ["tp", "sl", "liquidated"];

  function outcomeSticker(outcome, count) {
    var o = OUTCOMES[outcome];
    if (!o) return "";
    var times = count > 1 ? " \u00d7" + count : "";
    return '<span class="ts-sticker ts-sticker--' + outcome + '" title="' + escapeHtml(o.title + (count > 1 ? " on " + count + " entries" : "")) + '">' +
      '<span aria-hidden="true">' + o.icon + "</span>" + escapeHtml(o.text + times) + "</span>";
  }

  /** The picker under an entry's head: one tap marks the trade TP / SL / liquidated. */
  function outcomeMenu(entry) {
    return '<div class="ts-outcome-menu" role="group" aria-label="How did this trade end?">' +
      OUTCOME_ORDER.map(function (key) {
        var on = entry.outcome === key;
        return '<button class="ts-outcome-opt ts-outcome-opt--' + key + '" type="button" data-role="set-outcome" data-outcome="' + key +
          '" aria-pressed="' + on + '"><span aria-hidden="true">' + OUTCOMES[key].icon + "</span>" + OUTCOMES[key].text + "</button>";
      }).join("") +
      (entry.outcome ? '<button class="ts-outcome-opt" type="button" data-role="set-outcome" data-outcome="">Clear</button>' : "") +
    "</div>";
  }

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

  var Markdown = window.BriefingMarkdown || null;
  /** A note is longer than the card shows in full past this many characters or lines. */
  var NOTE_PREVIEW_CHARS = 320;
  var NOTE_PREVIEW_LINES = 6;

  /** Markdown (headings, bold, lists, tables) as HTML; plain escaped text without the renderer. */
  function noteHtml(note) {
    return Markdown ? Markdown.renderMarkdown(note) : '<p class="ts-plain">' + escapeHtml(note) + "</p>";
  }

  function isLongNote(note) {
    return note.length > NOTE_PREVIEW_CHARS || note.split("\n").length > NOTE_PREVIEW_LINES;
  }

  /** The note on its card: formatted, and cut short with "Read full note" when it's a long post. */
  function noteBlock(note) {
    var long = isLongNote(note);
    return '<div class="ts-note ts-md' + (long ? " ts-note--clamped" : "") + '">' + noteHtml(note) + "</div>" +
      (long ? '<button class="ts-more" type="button" data-role="read">Read full note &rarr;</button>' : "");
  }

  function renderEntry(entry) {
    var note = noteOf(entry);
    var editing = state.editing === entry.key;
    var count = entry.items.length;
    var picking = state.picking === entry.key;
    return '<article class="ts-entry" data-entry="' + escapeHtml(entry.key) + '">' +
      '<div class="ts-entry-head">' +
        tickerChip(entry.tag) +
        outcomeSticker(entry.outcome) +
        '<time class="ts-when" datetime="' + new Date(entry.createdAt).toISOString() + '">' + escapeHtml(formatWhen(entry.createdAt)) + "</time>" +
        (count > 1 ? '<span class="ts-n">' + count + " images</span>" : "") +
        '<span class="ts-entry-tools">' +
          '<button class="ts-icon' + (picking ? " is-on" : "") + '" type="button" data-role="outcome" aria-expanded="' + picking +
            '" aria-label="Mark how this trade ended" title="TP / SL / liquidated">&#127937;</button>' +
          '<button class="ts-icon" type="button" data-role="edit" aria-label="Edit ticker and note" title="Edit ticker / note">&#9998;</button>' +
          '<button class="ts-icon ts-icon--danger" type="button" data-role="remove-entry" aria-label="Delete this entry" title="Delete entry">&#128465;</button>' +
        "</span>" +
      "</div>" +
      (picking ? outcomeMenu(entry) : "") +
      thumbs(entry) +
      (editing
        ? '<form class="ts-edit" data-role="edit-form">' +
            '<input class="ts-input ts-input--ticker" name="ticker" list="ts-tickers" maxlength="24" autocomplete="off" ' +
              'placeholder="Ticker (none)" aria-label="Ticker for this entry" value="' +
              escapeHtml(state.draft ? state.draft.ticker : entry.tag) + '" />' +
            '<textarea class="ts-input ts-input--note" name="note" rows="8" maxlength="20000" ' +
              'aria-label="Note for this entry" placeholder="Entry, stop under range low…">' +
              escapeHtml(state.draft ? state.draft.note : note) + "</textarea>" +
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
        : note ? noteBlock(note) : "") +
    "</article>";
  }

  function renderFolder(tag, entries) {
    var open = Boolean(state.open[tag]);
    var images = entries.reduce(function (n, e) { return n + e.items.length; }, 0);
    var latest = entries[0].createdAt;
    var outcomes = {};
    entries.forEach(function (e) { if (e.outcome) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1; });
    return '<section class="ts-folder' + (open ? " is-open" : "") + '" data-folder="' + escapeHtml(tag) + '">' +
      '<button class="ts-folder-head" type="button" data-role="toggle" aria-expanded="' + open + '">' +
        '<span class="ts-folder-icon" aria-hidden="true">' + (open ? "&#128194;" : "&#128193;") + "</span>" +
        tickerChip(tag) +
        OUTCOME_ORDER.map(function (key) { return outcomes[key] ? outcomeSticker(key, outcomes[key]) : ""; }).join("") +
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
  async function upload(files, target, batchId) {
    var result = { saved: 0, failedFiles: [] };
    files = imageFiles(files);
    if (!files.length) {
      setStatus("Only PNG, JPEG, WebP or GIF images can be added.", true);
      return result;
    }
    var tooBig = files.filter(function (f) { return f.size > MAX_BYTES; });
    files = files.filter(function (f) { return f.size <= MAX_BYTES; });
    if (!files.length) {
      setStatus("Images must be 15 MB or smaller.", true);
      return result;
    }

    var label = target ? target.label : Ticker.withTicker(el.ticker.value, el.note.value);
    if (!target && el.ticker.value.trim() && Ticker.tickerSymbol(el.ticker.value) === null) {
      setStatus('"' + el.ticker.value.trim() + '" isn\'t a ticker. Use one symbol like BTC or SOL.', true);
      el.ticker.focus();
      return result;
    }
    var batch = target ? (target.batch || "") : (batchId || newBatchId());

    state.uploading += files.length;
    panel.classList.add("is-uploading");
    el.dropTitle.textContent = "Uploading " + files.length + " image" + (files.length === 1 ? "" : "s") + "…";
    var saved = 0;
    var failed = [];
    // A long write-up won't fit in the upload's query string: the images go
    // up under the ticker alone, then the full note is set on them.
    var longLabel = encodeURIComponent(label).length > MAX_QUERY_LABEL;
    var uploadLabel = longLabel ? tagLabel(label) : label;
    var savedIds = [];
    for (var i = 0; i < files.length; i += 1) {
      var params = new URLSearchParams();
      if (uploadLabel) params.set("label", uploadLabel);
      if (batch) params.set("batch", batch);
      try {
        var data = await request(API + "?" + params.toString(), {
          method: "POST",
          headers: { "Content-Type": files[i].type },
          body: files[i],
        });
        if (data.item) {
          state.items.unshift(data.item);
          savedIds.push(data.item.id);
          saved += 1;
          render();
        }
      } catch (err) {
        failed.push(err.message);
        result.failedFiles.push(files[i]);
      }
    }
    if (longLabel && savedIds.length) {
      try {
        await patchLabels(savedIds, label);
      } catch (err) {
        result.noteFailed = true;
        failed.push("Images saved, but the note wasn't: " + err.message + " Use \u270E to add it again.");
      }
    }
    state.uploading -= files.length;
    panel.classList.toggle("is-uploading", state.uploading > 0);
    el.dropTitle.textContent = DROP_TITLE;

    var tag = Ticker.extractTags(label)[0];
    if (tooBig.length) failed.push(tooBig.length + " image(s) over 15 MB skipped");
    if (failed.length) {
      setStatus((saved ? "Saved " + saved + ". " : "") + failed[0], true);
    } else {
      setStatus("Saved " + saved + " image" + (saved === 1 ? "" : "s") + (tag ? " to $" + tag : " (no ticker — edit to add one)") + ".");
    }
    if (tag) state.open[tag] = true;
    render();
    result.saved = saved;
    return result;
  }

  // ---- composer ----------------------------------------------------------------
  // Screenshots dropped, pasted or chosen collect here as a grid; the note is
  // written under them, and Post saves them all as one entry.

  var stagedSeq = 0;

  function stage(list) {
    var files = imageFiles(list);
    if (!files.length) {
      setStatus("Only PNG, JPEG, WebP or GIF images can be added.", true);
      return;
    }
    var tooBig = files.filter(function (f) { return f.size > MAX_BYTES; }).length;
    files.filter(function (f) { return f.size <= MAX_BYTES; }).forEach(function (file) {
      stagedSeq += 1;
      state.staged.push({ id: "s" + stagedSeq, file: file, url: URL.createObjectURL(file) });
    });
    setStatus(tooBig ? tooBig + " image(s) over 15 MB skipped." : "", Boolean(tooBig));
    renderComposer();
  }

  function unstage(id) {
    state.staged = state.staged.filter(function (shot) {
      if (shot.id === id) URL.revokeObjectURL(shot.url);
      return shot.id !== id;
    });
    renderComposer();
  }

  function clearComposer() {
    state.staged.forEach(function (shot) { URL.revokeObjectURL(shot.url); });
    state.staged = [];
    state.composeBatch = "";
    el.note.value = "";
    renderComposer();
  }

  function renderComposer() {
    var n = state.staged.length;
    el.staged.hidden = !n;
    el.staged.classList.toggle("ts-staged--many", n > 1);
    el.staged.innerHTML = state.staged.map(function (shot, i) {
      return '<figure class="ts-thumb">' +
        '<img src="' + escapeHtml(shot.url) + '" alt="' + escapeHtml("Screenshot " + (i + 1) + " for this note") + '" data-zoomable />' +
        '<button class="ts-thumb-x" type="button" data-unstage="' + escapeHtml(shot.id) + '" aria-label="Remove screenshot ' + (i + 1) +
          ' from this note" title="Remove">&times;</button>' +
      "</figure>";
    }).join("");
    var busy = state.uploading > 0;
    el.post.disabled = !n || busy;
    el.post.textContent = n > 1 ? "Post note (" + n + " images)" : "Post note";
    el.clear.hidden = !n && !el.note.value.trim();
    el.composeHint.textContent = n ? "Ctrl+Enter posts" : "Add a screenshot to post.";
    el.dropTitle.textContent = busy ? el.dropTitle.textContent : n ? "Add more screenshots" : DROP_TITLE;
  }

  async function post() {
    if (!state.staged.length || state.uploading) return;
    var shots = state.staged.slice();
    state.composeBatch = state.composeBatch || newBatchId();
    el.post.disabled = true;
    var result = await upload(shots.map(function (shot) { return shot.file; }), null, state.composeBatch);
    if (!result.saved && !result.failedFiles.length) { renderComposer(); return; } // refused before upload (bad ticker)
    // Keep only what didn't upload, so Post again finishes the same entry.
    state.staged = shots.filter(function (shot) {
      var keep = result.failedFiles.indexOf(shot.file) !== -1;
      if (!keep) URL.revokeObjectURL(shot.url);
      return keep;
    });
    if (!state.staged.length && !result.noteFailed) {
      state.composeBatch = "";
      el.note.value = "";
    }
    renderComposer();
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

  /** Set one label on several images (JSON body, so a long write-up fits). */
  async function patchLabels(ids, label) {
    for (var i = 0; i < ids.length; i += 1) {
      var data = await request(API + "/" + encodeURIComponent(ids[i]), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label }),
      });
      replaceItem(data.item);
    }
  }

  /** Just the ticker of a label ("$BTC"), or "" when it has none. */
  function tagLabel(label) {
    var tag = Ticker.extractTags(label)[0];
    return tag ? "$" + tag : "";
  }

  async function relabel(entry, label) {
    try {
      await patchLabels(entry.items.map(function (item) { return item.id; }), label);
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

  /** Mark (or clear) how the trade in this entry ended, on every image in it. */
  async function setOutcome(entry, outcome) {
    try {
      var ids = entry.items.map(function (item) { return item.id; });
      for (var i = 0; i < ids.length; i += 1) {
        var data = await request(API + "/" + encodeURIComponent(ids[i]), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: outcome }),
        });
        replaceItem(data.item);
      }
      state.picking = null;
      setStatus(outcome ? "Marked " + (entry.tag ? "$" + entry.tag + " " : "") + OUTCOMES[outcome].text + "." : "Outcome cleared.");
    } catch (err) {
      setStatus("Couldn't save the outcome: " + err.message, true);
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
    stage(e.dataTransfer.files);
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
    if (files.length) stage(files);
  });

  el.staged.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-unstage]");
    if (btn) unstage(btn.getAttribute("data-unstage"));
  });
  el.post.addEventListener("click", post);
  el.clear.addEventListener("click", function () {
    if (state.staged.length && !window.confirm("Clear these screenshots and the note without posting?")) return;
    clearComposer();
  });
  el.note.addEventListener("input", function () { el.clear.hidden = !state.staged.length && !el.note.value.trim(); });
  el.note.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      post();
    }
  });
  // Unposted screenshots live only in this tab.
  window.addEventListener("beforeunload", function (e) {
    if (!state.staged.length) return;
    e.preventDefault();
    e.returnValue = "";
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
      stage(e.dataTransfer.files);
      el.note.focus();
    });
  }

  // Paste a screenshot anywhere on the page (Cmd/Ctrl+V after a capture).
  document.addEventListener("paste", function (e) {
    if (e.defaultPrevented) return;
    var files = imageFiles(e.clipboardData && e.clipboardData.files);
    if (!files.length) return;
    // Text copied with an image attached still goes into the note being typed.
    if (isNoteBox(e.target) && hasText(e.clipboardData)) return;
    e.preventDefault();
    // While an entry is open for editing, a pasted screenshot joins it.
    var editingEntry = state.editing && entryByKey(state.editing);
    if (editingEntry) addToEntry(editingEntry, files);
    else stage(files);
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
    if (role === "outcome") {
      state.picking = state.picking === entry.key ? null : entry.key;
      render();
      var first = el.list.querySelector('[data-entry="' + entry.key + '"] [data-role="set-outcome"]');
      if (state.picking && first) first.focus();
    } else if (role === "set-outcome") {
      setOutcome(entry, btn.getAttribute("data-outcome"));
    } else if (role === "edit") {
      startEdit(entry.key);
    } else if (role === "edit-cancel") {
      state.editing = null;
      state.draft = null;
      render();
    } else if (role === "read") {
      openReader(entry);
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
    if (!entry) return;
    var ticker = form.elements.ticker.value;
    if (ticker.trim() && Ticker.tickerSymbol(ticker) === null) {
      setStatus('"' + ticker.trim() + '" isn\'t a ticker. Use one symbol like BTC or SOL, or leave it empty.', true);
      form.elements.ticker.focus();
      return;
    }
    // The ticker field files the entry; any other $tags in the note stay as written.
    relabel(entry, Ticker.withTicker(ticker, form.elements.note.value));
  });

  // Keep the half-typed note when an upload re-renders the list.
  el.list.addEventListener("input", function (e) {
    var form = e.target.closest('[data-role="edit-form"]');
    if (form) state.draft = { ticker: form.elements.ticker.value, note: form.elements.note.value };
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

  // ---- reader -----------------------------------------------------------------
  // A long note opens as a post: the charts, then the whole write-up, at a
  // readable width.

  // A plain overlay rather than a modal <dialog>: the image zoom viewer
  // (image-zoom.js) has to open on top of it, and nothing stacks above a
  // modal dialog's top layer.
  var reader = null;
  var readerReturn = null;

  function buildReader() {
    var shade = document.createElement("div");
    shade.className = "ts-reader-shade";
    shade.hidden = true;
    shade.innerHTML =
      '<div class="ts-reader" role="dialog" aria-modal="true" aria-label="Trade note">' +
        '<div class="ts-reader-head">' +
          '<span class="ts-reader-meta"></span>' +
          '<button class="ts-btn" type="button" data-reader="edit">&#9998; Edit</button>' +
          '<button class="ts-icon" type="button" data-reader="close" aria-label="Close note" title="Close (Esc)">&times;</button>' +
        "</div>" +
        '<div class="ts-reader-scroll">' +
          '<div class="ts-reader-shots"></div>' +
          '<article class="ts-reader-body ts-md"></article>' +
        "</div>" +
      "</div>";
    shade.addEventListener("click", function (e) {
      if (e.target === shade) { closeReader(); return; }
      var btn = e.target.closest("[data-reader]");
      if (!btn) return;
      var action = btn.getAttribute("data-reader");
      closeReader(action === "edit");
      if (action === "edit" && shade.dataset.entry) startEdit(shade.dataset.entry);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || shade.hidden) return;
      var zoom = document.querySelector(".img-zoom-overlay");
      if (zoom && !zoom.hidden) return; // Esc closes the zoomed image first
      closeReader();
    });
    document.body.appendChild(shade);
    return shade;
  }

  function openReader(entry) {
    reader = reader || buildReader();
    readerReturn = document.activeElement;
    reader.dataset.entry = entry.key;
    reader.querySelector(".ts-reader-meta").innerHTML = tickerChip(entry.tag) + outcomeSticker(entry.outcome) +
      '<time class="ts-when" datetime="' + new Date(entry.createdAt).toISOString() + '">' + escapeHtml(formatWhen(entry.createdAt)) + "</time>";
    reader.querySelector(".ts-reader-shots").innerHTML = entry.items.map(function (item, i) {
      return '<img src="' + escapeHtml(item.url) + '" alt="' + escapeHtml("Chart " + (i + 1) + " of this note") +
        '" loading="lazy" decoding="async" data-zoomable />';
    }).join("");
    reader.querySelector(".ts-reader-body").innerHTML = noteHtml(noteOf(entry));
    reader.hidden = false;
    document.documentElement.classList.add("ts-reader-lock");
    reader.querySelector(".ts-reader-scroll").scrollTop = 0;
    reader.querySelector('[data-reader="close"]').focus();
  }

  function closeReader(keepFocus) {
    if (!reader || reader.hidden) return;
    reader.hidden = true;
    document.documentElement.classList.remove("ts-reader-lock");
    if (!keepFocus && readerReturn && document.contains(readerReturn)) readerReturn.focus();
    readerReturn = null;
  }

  function startEdit(key) {
    state.editing = key;
    state.draft = null;
    var entry = entryByKey(key);
    if (entry && entry.tag) state.open[entry.tag] = true;
    render();
    var input = el.list.querySelector('[data-role="edit-form"] textarea');
    if (input) {
      input.scrollIntoView({ block: "nearest" });
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // ---- pasting a formatted answer --------------------------------------------
  // Text selected and copied from ChatGPT (or any page) arrives as HTML; it is
  // turned back into the markdown the note renders, so headings, bold, lists
  // and tables survive. A paste from ChatGPT's own copy button is already
  // markdown and goes in untouched.

  function isNoteBox(node) {
    return Boolean(node && node.tagName === "TEXTAREA" && (node === el.note || node.closest('[data-role="edit-form"]')));
  }

  function hasText(data) {
    return Boolean(data && (data.getData("text/plain") || data.getData("text/html")));
  }

  var SKIP_TAGS = { script: 1, style: 1, svg: 1, button: 1, noscript: 1, canvas: 1, template: 1, head: 1, title: 1, meta: 1 };
  var BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,ul,ol,li,table,div,pre,blockquote,hr,section,article,header,footer";

  function squash(text) {
    return text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  }

  function inlineMarkdown(node) {
    var out = "";
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, " "); return; }
      if (child.nodeType !== 1) return;
      var tag = child.tagName.toLowerCase();
      if (SKIP_TAGS[tag] || tag === "ul" || tag === "ol") return;
      if (tag === "br") { out += "\n"; return; }
      var inner = inlineMarkdown(child);
      var parts = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if ((tag === "strong" || tag === "b") && parts[2]) out += parts[1] + "**" + parts[2] + "**" + parts[3];
      else if (tag === "a" && parts[2] && /^https?:\/\//i.test(child.getAttribute("href") || "")) {
        out += parts[1] + "[" + parts[2] + "](" + child.getAttribute("href") + ")" + parts[3];
      } else if (tag === "img") out += child.getAttribute("alt") || "";
      else out += inner;
    });
    return out;
  }

  /** Blocks as { text, kind }; list items and table rows join without a blank line. */
  function blockMarkdown(node, out) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        var text = squash(child.nodeValue);
        if (text) out.push({ text: text, kind: "p" });
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName.toLowerCase();
      if (SKIP_TAGS[tag]) return;
      var heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        var title = squash(inlineMarkdown(child)).replace(/\n/g, " ");
        if (title) out.push({ text: new Array(Math.min(Number(heading[1]), 4) + 1).join("#") + " " + title, kind: "h" });
      } else if (tag === "ul" || tag === "ol") {
        var n = 0;
        Array.prototype.forEach.call(child.children, function (li) {
          if (li.tagName.toLowerCase() !== "li") return;
          n += 1;
          var item = squash(inlineMarkdown(li)).replace(/\n/g, " ");
          if (item) out.push({ text: (tag === "ol" ? n + ". " : "- ") + item, kind: "li" });
          Array.prototype.forEach.call(li.querySelectorAll(":scope > ul, :scope > ol"), function (nested) {
            var wrap = document.createElement("div");
            wrap.appendChild(nested.cloneNode(true));
            blockMarkdown(wrap, out);
          });
        });
      } else if (tag === "table") {
        var first = true;
        Array.prototype.forEach.call(child.querySelectorAll("tr"), function (tr) {
          var row = Array.prototype.map.call(tr.querySelectorAll("th, td"), function (cell) {
            return squash(inlineMarkdown(cell)).replace(/\n/g, " ").replace(/\|/g, "/");
          });
          if (!row.length) return;
          out.push({ text: "| " + row.join(" | ") + " |", kind: "tr" });
          if (first) out.push({ text: "|" + row.map(function () { return " --- "; }).join("|") + "|", kind: "tr" });
          first = false;
        });
      } else if (tag === "hr") {
        out.push({ text: "---", kind: "p" });
      } else if (tag === "pre") {
        var code = child.textContent.trim();
        if (code) out.push({ text: code, kind: "p" });
      } else if (tag === "p" || !child.querySelector(BLOCK_SELECTOR)) {
        var para = squash(inlineMarkdown(child));
        if (para) out.push({ text: para, kind: "p" });
      } else {
        blockMarkdown(child, out);
      }
    });
    return out;
  }

  function htmlToMarkdown(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var blocks = blockMarkdown(doc.body, []);
    return blocks.map(function (block, i) {
      var prev = blocks[i - 1];
      var tight = prev && prev.kind === block.kind && (block.kind === "li" || block.kind === "tr");
      return (i === 0 ? "" : tight ? "\n" : "\n\n") + block.text;
    }).join("");
  }

  /** Paste into a note box: formatted HTML becomes markdown at the cursor. */
  function pasteFormatted(e) {
    var box = e.target;
    if (!isNoteBox(box) || !e.clipboardData) return;
    if (imageFiles(e.clipboardData.files).length && !hasText(e.clipboardData)) return; // a screenshot: the page uploads it
    var html = e.clipboardData.getData("text/html");
    if (!html || !/<(h[1-6]|table|ul|ol|li|strong|b)\b/i.test(html)) return;
    var markdown = htmlToMarkdown(html);
    if (!markdown) return;
    e.preventDefault();
    box.setRangeText(markdown, box.selectionStart, box.selectionEnd, "end");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  el.note.addEventListener("paste", pasteFormatted);
  el.list.addEventListener("paste", pasteFormatted);

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
