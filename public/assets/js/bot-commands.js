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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
