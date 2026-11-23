// Overview v2 "My notes" box: a personal scratch pad saved in this browser.
(function () {
  "use strict";

  var NOTES_KEY = "overviewV2.notes.v1";
  var EXPANDED_KEY = "overviewV2.notesExpanded.v1";

  var root = document.getElementById("ov2-notes");
  var input = document.getElementById("ov2-notes-input");
  var toggle = document.getElementById("ov2-notes-toggle");
  var status = document.getElementById("ov2-notes-status");
  if (!root || !input || !toggle) return;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function setStatus(text) { if (status) status.textContent = text; }

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

  input.value = read(NOTES_KEY) || "";
  setExpanded(read(EXPANDED_KEY) === "1");

  var saveTimer = null;
  input.addEventListener("input", function () {
    autoGrow();
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      setStatus(write(NOTES_KEY, input.value) ? "Saved" : "Not saved (browser storage unavailable)");
    }, 400);
  });

  toggle.addEventListener("click", function () {
    var next = !root.classList.contains("is-expanded");
    setExpanded(next);
    write(EXPANDED_KEY, next ? "1" : "0");
    if (next) input.focus();
  });
})();
