(function () {
  "use strict";

  var STORAGE_KEY = "market_command_bot_commands";
  var COLLAPSED_KEY = "market_command_bot_commands_collapsed";
  var UNGROUPED = "Untitled bot";
  var state = {
    commands: [],
    search: "",
    editingId: null,
    collapsed: {},
  };
  var toastTimer = null;
  var confirmResolve = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    if (window.MarketUI && window.MarketUI.escapeHtml) return window.MarketUI.escapeHtml(value);
    return String(value ?? "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function loadCommands() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      state.commands = Array.isArray(parsed) ? parsed : [];
    } catch {
      state.commands = [];
    }
  }

  function saveCommands() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.commands));
    } catch {
      // Storage full or blocked — the server copy still has it.
    }
  }

  function loadCollapsed() {
    try {
      var parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
      state.collapsed = {};
      (Array.isArray(parsed) ? parsed : []).forEach(function (name) { state.collapsed[name] = true; });
    } catch {
      state.collapsed = {};
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.keys(state.collapsed)));
    } catch {
      // Cosmetic preference only.
    }
  }

  function setSyncStatus(mode, text) {
    var pill = $("botSyncStatus");
    pill.className = "bot-status-pill " + mode;
    pill.lastElementChild.textContent = text;
  }

  // Server sync — no admin key, since this is a personal reference list, not
  // an action that spends credits. This is an additive UNION merge, never a
  // replace: a sync must never make this device's visible list shrink, even
  // if a previous upload partially failed or the server briefly has fewer
  // items (e.g. mid-deploy). Anything local the server doesn't have yet gets
  // (re-)posted; anything the server has that's missing locally gets pulled
  // in; the merged result — never a subset of what was already local — is
  // what gets saved back to localStorage.
  function syncFromServer() {
    return fetch("/api/bot-commands")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var serverItems = Array.isArray(data.items) ? data.items : [];
        var serverById = {};
        serverItems.forEach(function (item) { serverById[item.id] = item; });
        var localById = {};
        state.commands.forEach(function (item) { localById[item.id] = item; });

        var missingFromServer = state.commands.filter(function (item) { return !serverById[item.id]; });
        var uploadPromise = missingFromServer.length
          ? Promise.all(missingFromServer.map(function (entry) {
              return fetch("/api/bot-commands", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(entry),
              }).catch(function () { return null; });
            }))
          : Promise.resolve();

        return uploadPromise.then(function () {
          var mergedById = Object.assign({}, serverById, localById);
          // Same id on both sides (edited on one device, not yet synced to
          // the other) — keep whichever copy is actually newer.
          Object.keys(localById).forEach(function (id) {
            var serverEntry = serverById[id];
            if (serverEntry && new Date(serverEntry.updatedAt || 0) > new Date(localById[id].updatedAt || 0)) {
              mergedById[id] = serverEntry;
            }
          });
          state.commands = Object.keys(mergedById)
            .map(function (id) { return mergedById[id]; })
            .sort(function (a, b) { return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0); });
          saveCommands();
          render();
          setSyncStatus("online", "Command library synced");
        });
      })
      .catch(function () {
        // Offline or server unreachable — the localStorage cache already
        // rendered, so all that's left is to say so.
        setSyncStatus("offline", "Local library mode");
      });
  }

  function toast(message, type) {
    var element = $("botToast");
    element.textContent = message;
    element.className = "bot-toast show" + (type ? " " + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      element.className = "bot-toast" + (type ? " " + type : "");
    }, 2200);
  }

  function findCommand(id) {
    return state.commands.find(function (item) { return item.id === id; });
  }

  function formValue(id) {
    return ($(id).value || "").trim();
  }

  function updateEditingState() {
    var editing = state.editingId !== null;
    $("botEditingBadge").classList.toggle("show", editing);
    $("saveCommandBtn").lastElementChild.textContent = editing ? "Update command" : "Save command";
  }

  function clearForm() {
    $("botCommandId").value = "";
    $("botTitle").value = "";
    $("botPurpose").value = "";
    $("botCommand").value = "";
    $("botNotes").value = "";
    state.editingId = null;
    updateEditingState();
  }

  // The editor stays collapsed until it's needed, so the saved list is the
  // first thing visible (especially on mobile, where the form filled the
  // whole screen).
  function setFormOpen(open) {
    $("botCommandForm").hidden = !open;
    $("botEditorPanel").classList.toggle("is-collapsed", !open);
    $("botShell").classList.toggle("is-editing", open);
    $("newCommandBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      $("botEditorPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      $("botTitle").focus({ preventScroll: true });
    }
  }

  function openNewForm(botTitle) {
    clearForm();
    if (typeof botTitle === "string" && botTitle) $("botTitle").value = botTitle;
    setFormOpen(true);
    render();
    if (botTitle) $("botPurpose").focus({ preventScroll: true });
  }

  function closeForm() {
    clearForm();
    setFormOpen(false);
    render();
  }

  function upsertCommand(event) {
    if (event) event.preventDefault();
    var form = $("botCommandForm");
    if (form.hidden) return;
    if (!form.reportValidity()) return;

    var id = formValue("botCommandId") || String(Date.now());
    var editing = Boolean(findCommand(id));
    var entry = {
      id: id,
      title: formValue("botTitle"),
      purpose: formValue("botPurpose"),
      command: formValue("botCommand"),
      notes: formValue("botNotes"),
      updatedAt: new Date().toISOString(),
    };

    var index = state.commands.findIndex(function (item) { return item.id === id; });
    if (index >= 0) state.commands[index] = entry;
    else state.commands.unshift(entry);

    saveCommands();
    closeForm();
    toast(editing ? "Command updated." : "Command saved.", "success");

    // Best-effort background sync — the local save above already gives an
    // instant, offline-safe result regardless of whether this succeeds.
    fetch("/api/bot-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(function () {});
  }

  function editCommand(id) {
    var entry = findCommand(id);
    if (!entry) return;
    $("botCommandId").value = entry.id;
    $("botTitle").value = entry.title || "";
    $("botPurpose").value = entry.purpose || "";
    $("botCommand").value = entry.command || "";
    $("botNotes").value = entry.notes || "";
    state.editingId = entry.id;
    updateEditingState();
    setFormOpen(true);
    render();
  }

  // In-page replacement for window.confirm(). On iOS browsers the native
  // dialog offers "Suppress Alerts" — once tapped, confirm() returns false
  // forever and Delete silently stops working.
  function confirmDialog(title, text, okLabel) {
    if (confirmResolve) confirmResolve(false);
    $("botConfirmTitle").textContent = title;
    $("botConfirmText").textContent = text || "";
    $("botConfirmText").style.display = text ? "block" : "none";
    $("botConfirmOk").textContent = okLabel || "OK";
    $("botConfirmModal").classList.add("show");
    $("botConfirmCancel").focus();
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }

  function closeConfirm(result) {
    if (!confirmResolve) return;
    var resolve = confirmResolve;
    confirmResolve = null;
    $("botConfirmModal").classList.remove("show");
    resolve(result);
  }

  function deleteCommand(id) {
    var entry = findCommand(id);
    if (!entry) return;
    var label = entry.purpose || entry.title || "this command";
    confirmDialog('Delete "' + label + '"?', "It will be removed from all your devices. This can't be undone.", "Delete")
      .then(function (confirmed) {
        if (!confirmed) return;
        state.commands = state.commands.filter(function (item) { return item.id !== id; });
        if (state.editingId === id) closeForm();
        saveCommands();
        render();
        toast("Command deleted.", "success");
        fetch("/api/bot-commands/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {});
      });
  }

  // Copy through a hidden, selected textarea. It must run synchronously
  // inside the tap: iOS only allows copying during the user gesture. iOS also
  // ignores select() on its own, so the range is set explicitly, and the
  // textarea is readonly so the keyboard doesn't pop up.
  function copyWithSelection(text) {
    var active = document.activeElement;
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;top:0;left:-9999px;font-size:12pt;";
    document.body.appendChild(textarea);
    var copied = false;
    try {
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    if (window.getSelection) window.getSelection().removeAllRanges();
    if (active && typeof active.focus === "function") active.focus({ preventScroll: true });
    return copied;
  }

  function showModal(title, sub, command, notes) {
    $("botModalName").textContent = title;
    $("botModalSub").textContent = sub || "";
    $("botModalSub").style.display = sub ? "block" : "none";
    $("botModalCommand").textContent = command || "(No command.)";
    $("botModalNotes").textContent = notes || "";
    $("botViewModal").classList.add("show");
    $("botModalClose").focus({ preventScroll: true });
  }

  function closeModal() {
    $("botViewModal").classList.remove("show");
  }

  // Last resort when the browser refuses every copy path: show the text,
  // selected, so it can be copied by hand.
  function showForManualCopy(text) {
    showModal("Copy command", "Your browser blocked copying. Tap and hold the text, then choose Copy.", text, "");
    var range = document.createRange();
    range.selectNodeContents($("botModalCommand"));
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function copyText(text) {
    if (!String(text || "").trim()) {
      toast("Nothing to copy yet.", "error");
      return;
    }
    if (copyWithSelection(text)) {
      toast("Copied to clipboard.", "success");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { toast("Copied to clipboard.", "success"); })
        .catch(function () { showForManualCopy(text); });
      return;
    }
    showForManualCopy(text);
  }

  function viewCommand(id) {
    var entry = findCommand(id);
    if (!entry) return;
    var sub = [entry.purpose, entry.updatedAt ? "Updated " + new Date(entry.updatedAt).toLocaleDateString() : ""]
      .filter(Boolean)
      .join(" · ");
    showModal(entry.title || UNGROUPED, sub, entry.command, entry.notes);
  }

  function exportCommands() {
    if (!state.commands.length) {
      toast("No commands to export.", "error");
      return;
    }
    var data = JSON.stringify(state.commands, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "market-command-bot-commands.json";
    link.click();
    URL.revokeObjectURL(url);
    toast("Exported " + state.commands.length + " command(s).", "success");
  }

  function filteredCommands() {
    var q = state.search.toLowerCase();
    if (!q) return state.commands;
    return state.commands.filter(function (entry) {
      return [entry.title, entry.purpose, entry.command, entry.notes]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  function groupName(entry) {
    return String(entry.title || "").trim() || UNGROUPED;
  }

  function firstLine(text) {
    return String(text || "").split(/\r?\n/).find(function (line) { return line.trim(); }) || "";
  }

  var ICON_CHEVRON = '<svg class="bot-folder-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_EYE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></svg>';

  function cardHtml(entry) {
    var name = entry.purpose || firstLine(entry.command) || "Untitled command";
    var active = entry.id === state.editingId ? " active" : "";
    return (
      '<article class="bot-card' + active + '" data-id="' + escapeHtml(entry.id) + '">' +
      '<div class="bot-card-top">' +
      '<div class="bot-card-info">' +
      '<div class="bot-title">' + escapeHtml(name) + '</div>' +
      '<div class="bot-command-preview">' + escapeHtml(firstLine(entry.command)) + '</div>' +
      (entry.notes ? '<div class="bot-meta">' + escapeHtml(firstLine(entry.notes)) + '</div>' : "") +
      '</div>' +
      '<button class="bot-btn bot-btn-ghost bot-btn-icon bot-btn-small" type="button" data-action="view" title="View command" aria-label="View command">' + ICON_EYE + '</button>' +
      '</div>' +
      '<div class="bot-card-actions">' +
      '<button class="bot-btn bot-btn-secondary bot-btn-small" type="button" data-action="edit">Edit</button>' +
      '<button class="bot-btn bot-btn-ghost bot-btn-small" type="button" data-action="copy">Copy</button>' +
      '<button class="bot-btn bot-btn-danger bot-btn-small" type="button" data-action="delete">Delete</button>' +
      '</div>' +
      '</article>'
    );
  }

  function groupHtml(name, items) {
    var collapsed = state.collapsed[name] && !state.search;
    var addTitle = name === UNGROUPED ? "" : name;
    return (
      '<div class="bot-folder-group' + (collapsed ? " collapsed" : "") + '">' +
      '<div class="bot-folder-row">' +
      '<button class="bot-folder-head" type="button" data-folder="' + escapeHtml(name) + '" aria-expanded="' + (collapsed ? "false" : "true") + '">' +
      ICON_CHEVRON +
      '<span class="bot-folder-name">' + escapeHtml(name) + '</span>' +
      '<span class="bot-folder-count">' + items.length + '</span>' +
      '</button>' +
      '<button class="bot-folder-add" type="button" data-new-in-folder="' + escapeHtml(addTitle) + '" title="New command for ' + escapeHtml(name) + '" aria-label="New command for ' + escapeHtml(name) + '">' + ICON_PLUS + '</button>' +
      '</div>' +
      '<div class="bot-folder-items">' + items.map(cardHtml).join("") + '</div>' +
      '</div>'
    );
  }

  function render() {
    var list = $("botCommandList");
    var commands = filteredCommands();
    $("botCount").textContent = String(state.commands.length);

    if (!commands.length) {
      list.innerHTML = state.commands.length
        ? '<div class="bot-empty">No commands match your search.</div>'
        : '<div class="bot-empty">No saved bot commands yet.<br />Tap New command to save a Telegram bot command.</div>';
      return;
    }

    var groups = {};
    commands.forEach(function (entry) {
      var name = groupName(entry);
      (groups[name] = groups[name] || []).push(entry);
    });

    list.innerHTML = Object.keys(groups)
      .sort(function (a, b) {
        if (a === UNGROUPED) return 1;
        if (b === UNGROUPED) return -1;
        return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
      })
      .map(function (name) { return groupHtml(name, groups[name]); })
      .join("");
  }

  function toggleGroup(name) {
    if (state.collapsed[name]) delete state.collapsed[name];
    else state.collapsed[name] = true;
    saveCollapsed();
    render();
  }

  function handleListClick(event) {
    var addButton = event.target.closest("[data-new-in-folder]");
    if (addButton) {
      openNewForm(addButton.getAttribute("data-new-in-folder"));
      return;
    }
    var folderButton = event.target.closest("[data-folder]");
    if (folderButton) {
      toggleGroup(folderButton.getAttribute("data-folder"));
      return;
    }
    var button = event.target.closest("button[data-action]");
    if (!button) return;
    var card = event.target.closest(".bot-card");
    if (!card) return;
    var id = card.getAttribute("data-id");
    var action = button.getAttribute("data-action");
    if (action === "view") viewCommand(id);
    if (action === "copy") {
      var entry = findCommand(id);
      if (entry) copyText(entry.command);
    }
    if (action === "edit") editCommand(id);
    if (action === "delete") deleteCommand(id);
  }

  function init() {
    loadCommands();
    loadCollapsed();
    $("botCommandForm").addEventListener("submit", upsertCommand);
    $("newCommandBtn").addEventListener("click", function () { openNewForm(""); });
    $("resetCommandBtn").addEventListener("click", closeForm);
    $("copyCurrentBtn").addEventListener("click", function () { copyText($("botCommand").value); });
    $("exportCommandsBtn").addEventListener("click", exportCommands);
    $("botCommandList").addEventListener("click", handleListClick);
    $("botSearch").addEventListener("input", function (event) {
      state.search = event.target.value || "";
      render();
    });
    $("botModalClose").addEventListener("click", closeModal);
    $("botViewModal").addEventListener("click", function (event) {
      if (event.target === $("botViewModal")) closeModal();
    });
    $("botConfirmOk").addEventListener("click", function () { closeConfirm(true); });
    $("botConfirmCancel").addEventListener("click", function () { closeConfirm(false); });
    $("botConfirmModal").addEventListener("click", function (event) {
      if (event.target === $("botConfirmModal")) closeConfirm(false);
    });
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "s" && !$("botCommandForm").hidden) {
        event.preventDefault();
        upsertCommand();
      }
      if (event.key === "Escape") {
        closeConfirm(false);
        closeModal();
      }
    });
    setFormOpen(false);
    render();
    syncFromServer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
