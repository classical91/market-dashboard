// Overview v2 "My notes" box: a personal scratch pad saved in this browser.
// Notes are grouped into folders shown as a row of chips. "Home" always
// exists (it cannot be renamed or deleted) and holds notes saved before
// folders existed.
(function () {
  "use strict";

  var LEGACY_NOTES_KEY = "overviewV2.notes.v1";
  var STORE_KEY = "overviewV2.notesFolders.v1";
  var EXPANDED_KEY = "overviewV2.notesExpanded.v1";
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

  // ── Folder state ──
  function loadState() {
    var state = null;
    try { state = JSON.parse(read(STORE_KEY) || "null"); } catch (e) { state = null; }
    var folders = state && Array.isArray(state.folders) ? state.folders.filter(function (f) {
      return f && typeof f.id === "string" && typeof f.name === "string";
    }).map(function (f) {
      return { id: f.id, name: f.name.slice(0, MAX_NAME), text: typeof f.text === "string" ? f.text : "" };
    }) : [];
    var home = folders.filter(function (f) { return f.id === HOME_ID; })[0];
    if (!home) {
      // First run with folders: carry the old single note into Home.
      home = { id: HOME_ID, name: "Home", text: state ? "" : (read(LEGACY_NOTES_KEY) || "") };
      folders.unshift(home);
    }
    home.name = "Home";
    var active = state && folders.some(function (f) { return f.id === state.active; }) ? state.active : HOME_ID;
    return { active: active, folders: folders };
  }

  var state = loadState();

  function persist() {
    return write(STORE_KEY, JSON.stringify(state));
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
    setStatus(persist() ? "Saved" : "Not saved (browser storage unavailable)");
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
    setStatus(persist() ? "Saved" : "Not saved (browser storage unavailable)");
    render();
    if (mode === "add") input.focus();
  }

  function selectFolder(id) {
    if (id === state.active) return;
    flushSave();
    state.active = id;
    persist();
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

  // ── Wire up ──
  showActive();
  render();
  setExpanded(read(EXPANDED_KEY) === "1");

  input.addEventListener("input", function () {
    autoGrow();
    var folder = activeFolder();
    var hadNotes = !!folder.text.trim();
    folder.text = input.value;
    if (hadNotes !== !!folder.text.trim()) render();
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      setStatus(persist() ? "Saved" : "Not saved (browser storage unavailable)");
    }, 400);
  });

  window.addEventListener("pagehide", flushSave);

  toggle.addEventListener("click", function () {
    var next = !root.classList.contains("is-expanded");
    setExpanded(next);
    write(EXPANDED_KEY, next ? "1" : "0");
    if (next) input.focus();
  });
})();
