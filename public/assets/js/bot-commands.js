(function () {
  "use strict";

  var STORAGE_KEY = "market_command_bot_commands";
  var state = {
    commands: [],
    search: "",
  };

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.commands));
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
      .then(function (res) { return res.json(); })
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
        });
      })
      .catch(function () {
        // Offline or server unreachable — the localStorage cache already
        // rendered, so there's nothing more to do here.
      });
  }

  function formValue(id) {
    return ($(id).value || "").trim();
  }

  function resetForm() {
    $("botCommandId").value = "";
    $("botTitle").value = "";
    $("botPurpose").value = "";
    $("botCommand").value = "";
    $("botNotes").value = "";
    $("saveCommandBtn").textContent = "Save Command";
    $("botTitle").focus();
  }

  function upsertCommand(event) {
    event.preventDefault();
    var id = formValue("botCommandId") || String(Date.now());
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
    resetForm();
    render();

    // Best-effort background sync — the local save above already gives an
    // instant, offline-safe result regardless of whether this succeeds.
    fetch("/api/bot-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(function () {});
  }

  function editCommand(id) {
    var entry = state.commands.find(function (item) { return item.id === id; });
    if (!entry) return;
    $("botCommandId").value = entry.id;
    $("botTitle").value = entry.title || "";
    $("botPurpose").value = entry.purpose || "";
    $("botCommand").value = entry.command || "";
    $("botNotes").value = entry.notes || "";
    $("saveCommandBtn").textContent = "Update Command";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteCommand(id) {
    if (!window.confirm("Delete this saved bot command?")) return;
    state.commands = state.commands.filter(function (item) { return item.id !== id; });
    saveCommands();
    render();
    fetch("/api/bot-commands/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {});
  }

  function copyCommand(id) {
    var entry = state.commands.find(function (item) { return item.id === id; });
    if (!entry) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(entry.command || "");
      return;
    }
    var textarea = document.createElement("textarea");
    textarea.value = entry.command || "";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function exportCommands() {
    var data = JSON.stringify(state.commands, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "market-command-bot-commands.json";
    link.click();
    URL.revokeObjectURL(url);
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

  function cardHtml(entry) {
    return (
      '<article class="bot-card" data-id="' + escapeHtml(entry.id) + '">' +
      '<div class="bot-card-top">' +
      '<div><div class="bot-title">' + escapeHtml(entry.title) + '</div>' +
      '<div class="bot-purpose">' + escapeHtml(entry.purpose) + '</div></div>' +
      '<span class="bot-date">' + escapeHtml(new Date(entry.updatedAt).toLocaleDateString()) + '</span>' +
      '</div>' +
      '<pre class="bot-command"><code>' + escapeHtml(entry.command) + '</code></pre>' +
      (entry.notes ? '<div class="bot-notes">' + escapeHtml(entry.notes) + '</div>' : "") +
      '<div class="bot-card-actions">' +
      '<button type="button" data-action="copy">Copy</button>' +
      '<button type="button" data-action="edit">Edit</button>' +
      '<button type="button" data-action="delete">Delete</button>' +
      '</div>' +
      '</article>'
    );
  }

  function render() {
    var list = $("botCommandList");
    var commands = filteredCommands();
    $("botCount").textContent = state.commands.length + (state.commands.length === 1 ? " entry" : " entries");

    if (!commands.length) {
      list.innerHTML = window.MarketUI
        ? window.MarketUI.emptyState("No saved bot commands", "Save Telegram bot commands here with a title and purpose.")
        : '<div class="bot-empty">No saved bot commands.</div>';
      return;
    }

    list.innerHTML = commands.map(cardHtml).join("");
  }

  function handleListClick(event) {
    var button = event.target.closest("button[data-action]");
    if (!button) return;
    var card = event.target.closest(".bot-card");
    if (!card) return;
    var id = card.getAttribute("data-id");
    var action = button.getAttribute("data-action");
    if (action === "copy") copyCommand(id);
    if (action === "edit") editCommand(id);
    if (action === "delete") deleteCommand(id);
  }

  function init() {
    loadCommands();
    $("botCommandForm").addEventListener("submit", upsertCommand);
    $("resetCommandBtn").addEventListener("click", resetForm);
    $("exportCommandsBtn").addEventListener("click", exportCommands);
    $("botCommandList").addEventListener("click", handleListClick);
    $("botSearch").addEventListener("input", function (event) {
      state.search = event.target.value || "";
      render();
    });
    render();
    syncFromServer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
