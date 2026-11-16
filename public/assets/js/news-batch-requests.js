(function () {
  "use strict";
  var form = document.getElementById("newsRequestForm");
  if (!form) return;
  var submit = document.getElementById("newsRequestSubmit");
  var message = document.getElementById("newsRequestMessage");
  var list = document.getElementById("newsRequestList");
  var windowInput = document.getElementById("newsRequestWindow");
  var instructions = document.getElementById("newsRequestInstructions");
  var esc = window.BriefingMarkdown.esc;
  var labels = { requested: "Requested", assigned: "Assigned", running: "Running", blocked: "Blocked", failed: "Failed", preview_ready: "Preview Ready" };
  var pending = null;
  var busy = false;
  var rows = [];
  try { pending = JSON.parse(sessionStorage.getItem("newsBatchPending") || "null"); } catch (e) { /* optional storage */ }

  function savePending(value) {
    pending = value;
    try { if (value) sessionStorage.setItem("newsBatchPending", JSON.stringify(value)); else sessionStorage.removeItem("newsBatchPending"); } catch (e) { /* optional storage */ }
  }
  function json(response) {
    return response.json().then(function (data) {
      if (!response.ok) {
        var error = new Error(data.error || "Could not check requests (HTTP " + response.status + ").");
        error.status = response.status;
        throw error;
      }
      return data;
    });
  }
  function render() {
    list.innerHTML = rows.map(function (row) {
      var ready = row.status === "preview_ready";
      return '<article class="news-request-receipt"><div class="briefing-toolbar"><strong>' + esc(labels[row.status] || row.status) + '</strong>' +
        '<span class="briefing-age">' + esc(new Date(row.createdAt).toLocaleString()) + '</span>' +
        (ready ? '<a class="briefing-btn" href="' + esc(row.preview.approvalUrl) + '" target="_blank" rel="noopener noreferrer">Review preview in FarmBot</a>' :
          '<button type="button" class="briefing-btn" data-request-check="' + esc(row.id) + '">Check progress</button>') + '</div>' +
        '<p class="topnews-note">Request <code>' + esc(row.id) + '</code> · Last ' + esc(row.options.windowHours) + ' hours · Penny → FarmClaw</p>' +
        (row.error ? '<p class="topnews-slip-error">' + esc(row.error) + '</p>' : '') +
        (row.execution ? '<p class="topnews-note">Penny claim receipt · attempt ' + esc(row.execution.attempt) + ' · ' + esc(new Date(row.execution.claimedAt).toLocaleString()) + '</p>' : '') +
        (ready ? '<p class="topnews-note">Saved and validated · revision ' + esc(row.preview.revision) + '. Waiting for your review and approval in FarmBot.</p>' : '') + '</article>';
    }).join("");
  }
  function load() {
    return window.AdminKey.fetchSilent("/api/news-batch-requests", { credentials: "same-origin" }).then(json).then(function (data) {
      rows = data.requests;
      render();
      message.textContent = data.configured ? (rows.length ? "Requests are saved. You can leave this page and return later." : "No requests yet.") : "The server integration needs setup. Requests will be saved as blocked until it is ready.";
    }).catch(function (error) { message.textContent = error.message; });
  }
  function check(id, interactive) {
    var request = interactive ? window.AdminKey.fetchOrSession : window.AdminKey.fetchSilent;
    return request("/api/news-batch-requests/" + encodeURIComponent(id) + "/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(json).then(function (data) {
        rows = rows.map(function (row) { return row.id === data.request.id ? data.request : row; });
        render();
      });
  }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (busy) return;
    var value = { windowHours: Number(windowInput.value), instructions: instructions.value.trim() };
    if (pending && JSON.stringify(pending.options) !== JSON.stringify(value)) {
      message.textContent = "A submission has an unknown result. Restore its options and retry to recover the original ticket.";
      windowInput.value = String(pending.options.windowHours);
      instructions.value = pending.options.instructions;
      return;
    }
    if (!pending) savePending({ key: crypto.randomUUID(), options: value });
    busy = true;
    submit.disabled = true;
    message.textContent = "Saving your request and checking Penny’s handoff…";
    window.AdminKey.fetchOrSession("/api/news-batch-requests", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: JSON.stringify(pending.options) })
      .then(json).then(function (data) {
        savePending(null);
        rows = [data.request].concat(rows.filter(function (row) { return row.id !== data.request.id; })).slice(0, 30);
        render();
        message.textContent = data.deduplicated ? "Your existing request is shown below." : "Request saved. Nothing will be published without your approval.";
      }).catch(function (error) {
        // A rejected request has a known outcome; allow corrected options.
        // Network and server errors may hide a saved ticket, so retain its key.
        if ([400, 409, 413, 422].includes(error.status)) savePending(null);
        message.textContent = error.message + (pending ? " Retry with the same options to recover your ticket." : "");
      })
      .finally(function () { busy = false; submit.disabled = false; });
  });
  list.addEventListener("click", function (event) {
    var button = event.target.closest("[data-request-check]");
    if (!button) return;
    button.disabled = true;
    check(button.getAttribute("data-request-check"), true).catch(function (error) { message.textContent = error.message; })
      .finally(function () { button.disabled = false; });
  });
  if (pending) { windowInput.value = String(pending.options.windowHours); instructions.value = pending.options.instructions; }
  load().then(function () {
    return rows.filter(function (row) { return !["failed", "preview_ready"].includes(row.status); }).reduce(function (chain, row) {
      return chain.then(function () { return check(row.id, false); });
    }, Promise.resolve());
  }).catch(function (error) { message.textContent = error.message; });
  // No overlapping polls; no key prompts from background work.
  function poll() {
    var active = rows.find(function (row) { return ["requested", "assigned", "running", "blocked"].includes(row.status); });
    var work = !document.hidden && !busy && active ? check(active.id, false).catch(function (error) { message.textContent = error.message; }) : Promise.resolve();
    work.finally(function () { setTimeout(poll, 15000); });
  }
  setTimeout(poll, 15000);
})();
