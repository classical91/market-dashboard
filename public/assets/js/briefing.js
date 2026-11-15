/* Desk briefings — one desk at a time: what the iOS Shortcut pushed to
   /api/phone-briefings, plus the desk's Reporter Room runs. ⚡ Run writes
   the desk now through the Reporter Room (admin key, OpenAI credits).
   Nothing here broadcasts. */
(function () {
  "use strict";

  var STALE_MS = 48 * 60 * 60 * 1000; // the Shortcut runs every two days
  var DESKS = ["geopolitics", "economics", "stocks", "crypto"];
  var desk = (window.location.pathname.split("/")[2] || "").toLowerCase();
  if (DESKS.indexOf(desk) === -1) desk = DESKS[0];

  var els = {
    title: document.getElementById("briefingTitle"),
    desks: document.getElementById("briefingDesks"),
    age: document.getElementById("briefingAge"),
    picker: document.getElementById("briefingRunPicker"),
    select: document.getElementById("briefingRunSelect"),
    copy: document.getElementById("briefingCopy"),
    heading: document.getElementById("briefingHeading"),
    body: document.getElementById("briefingBody"),
    help: document.getElementById("briefingHelp"),
    endpoint: document.getElementById("briefingEndpoint"),
    run: document.getElementById("briefingRun"),
    runMessage: document.getElementById("briefingRunMessage"),
  };
  var current = null;
  var runs = [];
  var running = false;
  // The Reporter Room's section for each desk; `markets` is Stocks.
  var SECTIONS = { geopolitics: "geopolitics", economics: "economics", stocks: "markets", crypto: "crypto" };
  var LABELS = { geopolitics: "Geopolitics", economics: "Economics", stocks: "Stocks", crypto: "Crypto" };

  var md = window.BriefingMarkdown;
  var esc = md.esc;
  var renderMarkdown = md.renderMarkdown;

  function ago(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "";
    if (ms < 60 * 1000) return "just now";
    var mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 48) return hours + "h ago";
    var days = Math.floor(hours / 24);
    return days + "d " + (hours % 24) + "h ago";
  }

  function stamp(iso) {
    var d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  function isStale(iso) {
    return Date.now() - new Date(iso).getTime() > STALE_MS;
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function renderDesks(categories) {
    els.desks.innerHTML = categories.map(function (cat) {
      var latest = cat.latest;
      var meta = latest ? ago(latest.receivedAt) : "nothing yet";
      // This desk also counts its Reporter Room runs when they are newer.
      var newest = cat.key === desk && runs[0];
      if (newest && newest.source === "reporter" && (!latest || newest.at > latest.receivedAt)) {
        latest = { receivedAt: newest.at };
        meta = "⚡ " + ago(newest.at);
      }
      var cls = "briefing-desk" + (cat.key === desk ? " active" : "") +
        (latest && isStale(latest.receivedAt) ? " stale" : "") + (latest ? "" : " empty");
      return '<a class="' + cls + '" href="/briefings/' + cat.key + '"' + (cat.key === desk ? ' aria-current="page"' : "") + ">" +
        '<span class="briefing-desk-name">' + esc(cat.icon + " " + cat.label) + "</span>" +
        '<span class="briefing-desk-meta">' + esc(meta) + "</span></a>";
    }).join("") +
      '<a class="briefing-desk briefing-desk--top10" href="/briefings/top-10">' +
      '<span class="briefing-desk-name">📰 Today\'s Top 10</span>' +
      '<span class="briefing-desk-meta">Economics · Stocks · Crypto</span></a>';
  }

  function showEmpty(message) {
    current = null;
    els.age.className = "briefing-age";
    els.age.textContent = message;
    els.heading.hidden = true;
    els.copy.hidden = true;
    els.picker.hidden = true;
    els.body.innerHTML = '<p class="briefing-empty">No briefing for this desk yet. Tap <strong>⚡ Run</strong> to write one now, ' +
      "or run the Shortcut on your phone (the steps are below).</p>";
    els.help.open = true;
  }

  function showRun(entry) {
    var phone = entry.source === "phone";
    els.age.className = "briefing-age" + (isStale(entry.at) ? " stale" : " fresh");
    els.age.textContent = (phone ? "📱 Received " : "⚡ Written by the Reporter Room ") + stamp(entry.at) + " · " + ago(entry.at);
    els.heading.hidden = !entry.title;
    els.heading.textContent = entry.title || "";
    els.body.innerHTML = renderMarkdown(entry.text);
    els.copy.hidden = false;
    current = entry;
  }

  function loadRun(id) {
    var run = runs.filter(function (r) { return r.id === id; })[0];
    if (run && run.source === "reporter") {
      showRun(run);
      return Promise.resolve();
    }
    els.body.classList.add("loading");
    return getJson("/api/phone-briefings/" + desk + "/" + encodeURIComponent(id)).then(function (entry) {
      els.body.classList.remove("loading");
      showRun({ source: "phone", id: entry.id, at: entry.receivedAt, title: entry.title, text: entry.text });
    });
  }

  function load() {
    els.endpoint.textContent = window.location.origin + "/api/phone-briefings/" + desk;
    // The Reporter Room's runs are optional: a desk page still works without them.
    var reporterRuns = getJson("/api/daily-report/generations?section=" + SECTIONS[desk] + "&limit=10")
      .then(function (data) { return data.generations || []; }, function () { return []; });
    return Promise.all([getJson("/api/phone-briefings"), getJson("/api/phone-briefings/" + desk), reporterRuns])
      .then(function (results) {
        var categories = results[0].categories || [];
        runs = (results[1].runs || []).map(function (run) {
          return { source: "phone", id: run.id, at: run.receivedAt };
        }).concat(results[2].map(function (gen) {
          return { source: "reporter", id: "reporter-" + gen.generatedAt, at: gen.generatedAt, text: gen.content, title: null };
        })).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
        var mine = categories.filter(function (cat) { return cat.key === desk; })[0];
        if (mine) {
          els.title.textContent = mine.icon + " " + mine.label;
          document.title = mine.label + " Briefing · Market Command";
        }
        renderDesks(categories);
        if (!runs.length) {
          showEmpty("Nothing received yet");
          return null;
        }
        els.select.innerHTML = runs.map(function (run, index) {
          return '<option value="' + esc(run.id) + '">' + (run.source === "phone" ? "📱 " : "⚡ ") +
            esc(stamp(run.at)) + (index === 0 ? " (latest)" : "") + "</option>";
        }).join("");
        els.picker.hidden = runs.length < 2;
        return loadRun(runs[0].id);
      })
      .catch(function (err) {
        showEmpty("Could not load briefings (" + err.message + ")");
      });
  }

  function setRunMessage(text, tone) {
    els.runMessage.hidden = !text;
    els.runMessage.textContent = text || "";
    els.runMessage.className = "topnews-run-message" + (tone ? " " + tone : "");
  }

  /* ⚡ Run: write this desk now through the Reporter Room. Crypto sends the
     crypto-news prompt; the Reporter Room's own one lists trending tokens. */
  function runDesk() {
    if (running || !window.AdminKey) return;
    running = true;
    els.run.disabled = true;
    els.run.textContent = "⚡ Running…";
    setRunMessage("Writing " + LABELS[desk] + " with web search. This can take a minute; nothing is broadcast.", "");
    var prompt = desk === "crypto" && window.DeskPrompts ? window.DeskPrompts.crypto : "";
    window.AdminKey.fetch("/api/daily-report/generate?section=" + SECTIONS[desk], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt ? { prompt: prompt } : {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      });
    }).then(function (data) {
      if (data.configured === false) throw new Error("the Reporter has no OPENAI_API_KEY on the server");
      if (data.rateLimited) throw new Error("OpenAI is rate-limited; try again later");
      setRunMessage(data.generationSkippedReason
        ? LABELS[desk] + " was already written today; showing that run."
        : LABELS[desk] + " written. Showing the new run.", "ok");
      return load();
    }).catch(function (err) {
      setRunMessage("Could not write " + LABELS[desk] + ": " + (err.message || "error"), "error");
    }).finally(function () {
      running = false;
      els.run.disabled = false;
      els.run.textContent = "⚡ Run " + LABELS[desk];
    });
  }

  els.run.textContent = "⚡ Run " + LABELS[desk];
  els.run.addEventListener("click", runDesk);

  els.select.addEventListener("change", function () {
    loadRun(els.select.value).catch(function (err) {
      els.body.classList.remove("loading");
      els.age.textContent = "Could not load that run (" + err.message + ")";
    });
  });

  els.copy.addEventListener("click", function () {
    if (!current || !navigator.clipboard) return;
    navigator.clipboard.writeText(current.text || "").then(function () {
      els.copy.textContent = "Copied";
      setTimeout(function () { els.copy.textContent = "Copy text"; }, 1500);
    });
  });

  load();
})();
