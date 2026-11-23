// Overview v2 "My notes" box: a personal scratch pad.
// Notes are grouped into folders shown as a row of chips. "Home" always
// exists (it cannot be renamed or deleted) and holds notes saved before
// folders existed.
//
// Notes save to this browser first (instant, works offline) and then sync to
// the server (/api/overview-notes) so every signed-in device sees the same
// notes. Each save names the server revision it built on; if another device
// saved in between, the two versions are merged instead of one overwriting
// the other: an edit that only adds to the other text is kept as is, and a
// genuinely different edit is kept as a "(this device)" copy of the folder.
(function () {
  "use strict";

  var LEGACY_NOTES_KEY = "overviewV2.notes.v1";
  var STORE_KEY = "overviewV2.notesFolders.v1";
  var EXPANDED_KEY = "overviewV2.notesExpanded.v1";
  var SYNC_KEY = "overviewV2.notesSync.v1";
  var API = "/api/overview-notes";
  var RETRY_MS = 15000;
  var HOME_ID = "home";
  var MAX_NAME = 40;

  var root = document.getElementById("ov2-notes");
  var input = document.getElementById("ov2-notes-input");
  var toggle = document.getElementById("ov2-notes-toggle");
  var status = document.getElementById("ov2-notes-status");
  var bar = document.getElementById("ov2-notes-folders");
  if (!root || !input || !toggle) return;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function setStatus(text) { if (status) status.textContent = text; }

  // ── Save status ──
  // syncMode: "pending" | "syncing" | "synced" | "merged" | "offline" | "signin" | "unavailable"
  var localOk = true;
  var syncMode = "pending";
  function showSaved() {
    if (!localOk && syncMode !== "synced") { setStatus("Not saved (browser storage unavailable)"); return; }
    var text = {
      pending: "Saved on this device",
      syncing: "Saved on this device · syncing…",
      synced: "Saved · synced across devices",
      merged: "Merged with notes from another device",
      offline: "Saved on this device · will sync when back online",
      signin: "Saved on this device only · sign in to sync across devices",
      unavailable: "Saved on this device only · server sync unavailable",
    }[syncMode];
    setStatus(text || "Saved");
  }
  function setSync(mode) {
    syncMode = mode;
    showSaved();
  }

  // ── Folder state ──
  function cleanFolders(list, legacyText) {
    var folders = Array.isArray(list) ? list.filter(function (f) {
      return f && typeof f.id === "string" && typeof f.name === "string";
    }).map(function (f) {
      return { id: f.id, name: f.name.slice(0, MAX_NAME), text: typeof f.text === "string" ? f.text : "" };
    }) : [];
    var home = folders.filter(function (f) { return f.id === HOME_ID; })[0];
    if (!home) {
      home = { id: HOME_ID, name: "Home", text: legacyText || "" };
      folders.unshift(home);
    }
    home.name = "Home";
    return folders;
  }

  function loadState() {
    var state = null;
    try { state = JSON.parse(read(STORE_KEY) || "null"); } catch (e) { state = null; }
    // First run with folders: carry the old single note into Home.
    var folders = cleanFolders(state && state.folders, state ? "" : read(LEGACY_NOTES_KEY));
    var active = state && folders.some(function (f) { return f.id === state.active; }) ? state.active : HOME_ID;
    return { active: active, folders: folders };
  }

  function hasContent(folders) {
    return folders.some(function (f) { return f.id !== HOME_ID || f.text.trim(); });
  }

  var state = loadState();

  // revision: the server revision this device last agreed with.
  // dirty: this device has edits the server hasn't accepted yet. A device that
  // has never synced counts its existing notes as unsynced, so the first sync
  // merges them in rather than replacing them with the server's copy.
  function loadSync() {
    var meta = null;
    try { meta = JSON.parse(read(SYNC_KEY) || "null"); } catch (e) { meta = null; }
    if (!meta || typeof meta !== "object") return { revision: 0, dirty: hasContent(state.folders) };
    return { revision: Number(meta.revision) || 0, dirty: !!meta.dirty };
  }

  var sync = loadSync();
  var editSeq = 0;

  function saveLocal() {
    return write(STORE_KEY, JSON.stringify(state));
  }
  function saveSyncMeta() {
    write(SYNC_KEY, JSON.stringify(sync));
  }
  // A content change: mark it unsynced at once (so a sync reply landing
  // mid-typing never replaces what is being typed), save it here, queue a push.
  function markEdited() {
    editSeq += 1;
    sync.dirty = true;
  }
  function persist() {
    markEdited();
    var ok = saveLocal();
    saveSyncMeta();
    localOk = ok;
    if (!syncOff && syncMode !== "offline") syncMode = "pending";
    schedulePush();
    return ok;
  }
  function activeFolder() {
    return state.folders.filter(function (f) { return f.id === state.active; })[0] || state.folders[0];
  }
  function newId() {
    return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function cleanName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  }
  function nameTaken(name, exceptId) {
    var lower = name.toLowerCase();
    return state.folders.some(function (f) { return f.id !== exceptId && f.name.toLowerCase() === lower; });
  }

  // ── Editor ──
  // Grow with the text (up to the CSS max-height) so short notes stay compact.
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + 2 + "px";
  }

  function setExpanded(expanded) {
    root.classList.toggle("is-expanded", expanded);
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? "Collapse" : "Expand";
    autoGrow();
  }

  var saveTimer = null;
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    persist(); showSaved();
  }

  function showActive() {
    var folder = activeFolder();
    input.value = folder.text;
    input.setAttribute("aria-label", "Notes in " + folder.name);
    autoGrow();
  }

  // ── Folder row ──
  // editing: null, { mode: "add" } or { mode: "rename", id }
  var editing = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function nameField(initial, label) {
    var field = el("input", "ov2-notes-folder-input");
    field.type = "text";
    field.maxLength = MAX_NAME;
    field.value = initial || "";
    field.placeholder = "Folder name";
    field.setAttribute("aria-label", label);
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (save) commitName(field.value); else { editing = null; render(); }
    }
    field.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    field.addEventListener("blur", function () { finish(true); });
    return field;
  }

  function commitName(raw) {
    var name = cleanName(raw);
    var mode = editing && editing.mode;
    var targetId = editing && editing.id;
    editing = null;
    if (!name) { render(); return; }
    if (nameTaken(name, targetId)) {
      setStatus("A folder named “" + name + "” already exists");
      render();
      return;
    }
    flushSave();
    if (mode === "add") {
      var folder = { id: newId(), name: name, text: "" };
      state.folders.push(folder);
      state.active = folder.id;
      showActive();
    } else if (mode === "rename") {
      var target = state.folders.filter(function (f) { return f.id === targetId; })[0];
      if (target && target.id !== HOME_ID) target.name = name;
    }
    persist(); showSaved();
    render();
    if (mode === "add") input.focus();
  }

  function selectFolder(id) {
    if (id === state.active) return;
    flushSave();
    state.active = id;
    saveLocal();
    showActive();
    render();
  }

  function deleteFolder(id) {
    var folder = state.folders.filter(function (f) { return f.id === id; })[0];
    if (!folder || folder.id === HOME_ID) return;
    if (folder.text.trim() && !window.confirm("Delete the folder “" + folder.name + "” and its notes?")) return;
    flushSave();
    state.folders = state.folders.filter(function (f) { return f.id !== id; });
    if (state.active === id) state.active = HOME_ID;
    setStatus(persist() ? "Folder deleted" : "Not saved (browser storage unavailable)");
    showActive();
    render();
    var current = bar.querySelector('[aria-pressed="true"]');
    if (current) current.focus();
  }

  function render() {
    if (!bar) return;
    bar.textContent = "";
    var focusTarget = null;

    state.folders.forEach(function (folder) {
      if (editing && editing.mode === "rename" && editing.id === folder.id) {
        focusTarget = nameField(folder.name, "Rename folder " + folder.name);
        bar.appendChild(focusTarget);
        return;
      }
      var chip = el("button", "ov2-notes-folder");
      chip.type = "button";
      chip.setAttribute("aria-pressed", folder.id === state.active ? "true" : "false");
      chip.title = folder.id === HOME_ID ? "Home (default folder)" : folder.name + " (double-click to rename)";
      if (folder.id === HOME_ID) chip.appendChild(el("span", "ov2-notes-folder-icon", "⌂"));
      chip.appendChild(el("span", "ov2-notes-folder-name", folder.name));
      if (folder.text.trim()) chip.classList.add("has-notes");
      chip.addEventListener("click", function () { selectFolder(folder.id); });
      if (folder.id !== HOME_ID) {
        chip.addEventListener("dblclick", function () { editing = { mode: "rename", id: folder.id }; render(); });
      }
      bar.appendChild(chip);
    });

    if (editing && editing.mode === "add") {
      focusTarget = nameField("", "New folder name");
      bar.appendChild(focusTarget);
    } else {
      var add = el("button", "ov2-notes-folder-add", "+ Folder");
      add.type = "button";
      add.setAttribute("aria-label", "Add folder");
      add.addEventListener("click", function () { editing = { mode: "add" }; render(); });
      bar.appendChild(add);
    }

    var current = activeFolder();
    if (current.id !== HOME_ID && !editing) {
      var actions = el("span", "ov2-notes-folder-actions");
      var rename = el("button", "ov2-notes-folder-action", "Rename");
      rename.type = "button";
      rename.setAttribute("aria-label", "Rename folder " + current.name);
      rename.addEventListener("click", function () { editing = { mode: "rename", id: current.id }; render(); });
      var remove = el("button", "ov2-notes-folder-action is-danger", "Delete");
      remove.type = "button";
      remove.setAttribute("aria-label", "Delete folder " + current.name);
      remove.addEventListener("click", function () { deleteFolder(current.id); });
      actions.appendChild(rename);
      actions.appendChild(remove);
      bar.appendChild(actions);
    }

    if (focusTarget) { focusTarget.focus(); focusTarget.select(); }
  }

  // ── Server sync ──
  var inflight = false;
  var again = false;
  var pushTimer = null;
  var syncOff = false;
  var announceMerge = false;

  function request(method, body) {
    if (!window.fetch) return Promise.resolve({ status: 0, body: null });
    var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
      // Lets a save started as the tab is hidden or closed still complete.
      if (opts.body.length < 60000) opts.keepalive = true;
    }
    return fetch(API, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        return { status: res.status, body: json };
      });
    }, function () { return { status: 0, body: null }; });
  }

  function payloadFolders() {
    return state.folders.map(function (f) { return { id: f.id, name: f.name, text: f.text }; });
  }

  function schedulePush(delay) {
    if (syncOff) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay == null ? 800 : delay);
  }

  // One request at a time; anything asked for meanwhile runs right after.
  function finish() {
    inflight = false;
    if (again) { again = false; if (sync.dirty) push(); }
  }

  function failed(res) {
    var message = res.body && typeof res.body.error === "string" ? res.body.error : "";
    if (res.status === 401 || res.status === 403) {
      syncOff = true;
      setSync("signin");
    } else if (res.status === 503 && /disabled/i.test(message)) {
      syncOff = true;
      setSync("unavailable");
    } else if (res.status === 400 || res.status === 413) {
      // The server refused these notes as they are; retrying won't change that.
      setStatus("Saved on this device only · " + (message || "server refused the notes"));
    } else {
      setSync("offline");
      if (sync.dirty) schedulePush(RETRY_MS);
    }
  }

  function push() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (syncOff || !sync.dirty) return;
    if (saveTimer) { schedulePush(); return; }
    if (inflight) { again = true; return; }
    inflight = true;
    var seq = editSeq;
    setSync("syncing");
    request("PUT", { baseRevision: sync.revision, folders: payloadFolders() }).then(function (res) {
      if (res.status === 200 && res.body && Number.isInteger(res.body.revision)) {
        sync.revision = res.body.revision;
        if (seq === editSeq) sync.dirty = false;
        saveSyncMeta();
        if (sync.dirty) { setSync("pending"); schedulePush(); } else setSync(announceMerge ? "merged" : "synced");
        announceMerge = false;
      } else if (res.status === 409 && res.body && res.body.current) {
        reconcile(res.body.current);
      } else {
        failed(res);
      }
      finish();
    });
  }

  function pull() {
    if (syncOff) return;
    if (inflight) { again = true; return; }
    inflight = true;
    request("GET").then(function (res) {
      if (res.status === 200 && res.body) reconcile(res.body);
      else failed(res);
      finish();
    });
  }

  function uniqueName(base, folders) {
    var suffix = " (this device)";
    var name = base.slice(0, MAX_NAME - suffix.length) + suffix;
    var n = 2;
    function taken(candidate) {
      var lower = candidate.toLowerCase();
      return folders.some(function (f) { return f.name.toLowerCase() === lower; });
    }
    while (taken(name)) {
      var tail = " (this device " + n + ")";
      name = base.slice(0, MAX_NAME - tail.length) + tail;
      n += 1;
    }
    return name;
  }

  // Server notes plus this device's unsynced edits, losing neither.
  function merge(remote, local) {
    var out = remote.map(function (f) { return { id: f.id, name: f.name, text: f.text }; });
    var changed = false;
    local.forEach(function (mine) {
      var theirs = out.filter(function (f) { return f.id === mine.id; })[0];
      if (!theirs) {
        out.push({ id: mine.id, name: nameTakenIn(mine.name, out) ? uniqueName(mine.name, out) : mine.name, text: mine.text });
        changed = true;
        return;
      }
      if (mine.id !== HOME_ID && mine.name !== theirs.name && !nameTakenIn(mine.name, out)) {
        theirs.name = mine.name;
        changed = true;
      }
      if (mine.text === theirs.text || !mine.text.trim()) return;
      if (!theirs.text.trim() || mine.text.indexOf(theirs.text) === 0) {
        theirs.text = mine.text; // this device only added to it
      } else if (theirs.text.indexOf(mine.text) !== 0) {
        out.push({ id: newId(), name: uniqueName(theirs.name, out), text: mine.text });
      } else {
        return; // the other device only added to it
      }
      changed = true;
    });
    return { folders: out, changed: changed };
  }

  function nameTakenIn(name, folders) {
    var lower = name.toLowerCase();
    return folders.some(function (f) { return f.name.toLowerCase() === lower; });
  }

  function adopt(folders) {
    var focused = document.activeElement === input;
    var start = input.selectionStart;
    var end = input.selectionEnd;
    var before = input.value;
    state.folders = cleanFolders(folders, "");
    if (!state.folders.some(function (f) { return f.id === state.active; })) state.active = HOME_ID;
    localOk = saveLocal();
    showActive();
    if (focused && input.value !== before) {
      try { input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length)); } catch (e) { /* ignore */ }
    }
    render();
  }

  function reconcile(remote) {
    var revision = Number.isInteger(remote.revision) ? remote.revision : 0;
    if (!Array.isArray(remote.folders)) {
      // Nothing on the server yet: this device's notes become the first copy.
      sync.revision = revision;
      if (hasContent(state.folders)) sync.dirty = true;
      saveSyncMeta();
      if (sync.dirty) schedulePush(0); else setSync("synced");
      return;
    }
    if (revision === sync.revision) {
      if (sync.dirty) schedulePush(0); else setSync("synced");
      return;
    }
    if (!sync.dirty) {
      sync.revision = revision;
      saveSyncMeta();
      adopt(remote.folders);
      setSync("synced");
      return;
    }
    // Both sides changed. Merge, then push the merge on top of the server copy.
    flushSave();
    var merged = merge(cleanFolders(remote.folders, ""), state.folders);
    sync.revision = revision;
    adopt(merged.folders);
    if (merged.changed) {
      markEdited();
      saveSyncMeta();
      announceMerge = true;
      setSync("merged");
      schedulePush(0);
    } else {
      sync.dirty = false;
      saveSyncMeta();
      setSync("synced");
    }
  }

  // Leaving the page: a last best-effort push that outlives the tab. Whatever
  // it doesn't deliver is still saved here and goes up on the next visit.
  function pushOnLeave() {
    if (syncOff || !sync.dirty || inflight || !window.fetch) return;
    try {
      fetch(API, {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ baseRevision: sync.revision, folders: payloadFolders() }),
      }).catch(function () {});
    } catch (e) { /* too large for keepalive; synced next visit */ }
  }

  // ── Wire up ──
  showActive();
  render();
  setExpanded(read(EXPANDED_KEY) === "1");

  input.addEventListener("input", function () {
    autoGrow();
    var folder = activeFolder();
    var hadNotes = !!folder.text.trim();
    folder.text = input.value;
    markEdited();
    clearTimeout(pushTimer);
    if (hadNotes !== !!folder.text.trim()) render();
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persist(); showSaved();
    }, 400);
  });

  window.addEventListener("pagehide", function () {
    flushSave();
    pushOnLeave();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") pull();
    else { flushSave(); push(); }
  });
  window.addEventListener("online", function () { if (sync.dirty) push(); else pull(); });

  if (sync.dirty) saveSyncMeta();
  pull();

  toggle.addEventListener("click", function () {
    var next = !root.classList.contains("is-expanded");
    setExpanded(next);
    write(EXPANDED_KEY, next ? "1" : "0");
    if (next) input.focus();
  });
})();
