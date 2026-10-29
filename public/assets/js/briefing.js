/* Phone briefings — reads what the iOS Shortcut pushed to
   /api/phone-briefings and renders one desk at a time. Nothing here
   generates, spends or broadcasts: the phone already did the work. */
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
  };
  var current = null;

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Inline markdown on already-escaped text: **bold**, [label](url) and bare
     URLs. Only http(s) links are ever produced. */
  function inline(text) {
    var out = esc(text);
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, lead, url) {
      return lead + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    return out;
  }

  /* ChatGPT output is loose markdown: headings, numbered stories, hyphen or
     bullet points, bold, links. Anything else renders as a paragraph. */
  function renderMarkdown(text) {
    var html = [];
    var list = null;
    function closeList() {
      if (list) html.push("</" + list + ">");
      list = null;
    }
    function openList(type) {
      if (list === type) return;
      closeList();
      html.push("<" + type + ">");
      list = type;
    }
    String(text || "").split("\n").forEach(function (raw) {
      var line = raw.trim();
      var match;
      if (!line) { closeList(); return; }
      if (/^(-{3,}|\*{3,}|_{3,}|—{2,})$/.test(line)) { closeList(); html.push("<hr />"); return; }
      if ((match = line.match(/^(#{1,4})\s+(.*)$/))) {
        closeList();
        var level = Math.min(match[1].length + 2, 6);
        html.push("<h" + level + ">" + inline(match[2]) + "</h" + level + ">");
        return;
      }
      if ((match = line.match(/^[-*•▪◦·]\s+(.*)$/))) {
        openList("ul");
        html.push("<li>" + inline(match[1]) + "</li>");
        return;
      }
      if ((match = line.match(/^(\d{1,2})[.)]\s+(.*)$/))) {
        closeList();
        html.push('<p class="briefing-story"><span class="briefing-rank">' + match[1] + "</span>" + inline(match[2]) + "</p>");
        return;
      }
      closeList();
      html.push("<p>" + inline(line) + "</p>");
    });
    closeList();
    return html.join("");
  }

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
      var cls = "briefing-desk" + (cat.key === desk ? " active" : "") +
        (latest && isStale(latest.receivedAt) ? " stale" : "") + (latest ? "" : " empty");
      return '<a class="' + cls + '" href="/briefings/' + cat.key + '"' + (cat.key === desk ? ' aria-current="page"' : "") + ">" +
        '<span class="briefing-desk-name">' + esc(cat.icon + " " + cat.label) + "</span>" +
        '<span class="briefing-desk-meta">' + esc(meta) + "</span></a>";
    }).join("");
  }

  function showEmpty(message) {
    current = null;
    els.age.className = "briefing-age";
    els.age.textContent = message;
    els.heading.hidden = true;
    els.copy.hidden = true;
    els.picker.hidden = true;
    els.body.innerHTML = '<p class="briefing-empty">No briefing for this desk yet. Run the Shortcut on your phone, ' +
      "or add the step below so it sends here.</p>";
    els.help.open = true;
  }

  function loadRun(id) {
    els.body.classList.add("loading");
    return getJson("/api/phone-briefings/" + desk + "/" + encodeURIComponent(id)).then(function (entry) {
      els.body.classList.remove("loading");
      els.age.className = "briefing-age" + (isStale(entry.receivedAt) ? " stale" : " fresh");
      els.age.textContent = "Received " + stamp(entry.receivedAt) + " · " + ago(entry.receivedAt);
      els.heading.hidden = !entry.title;
      els.heading.textContent = entry.title || "";
      els.body.innerHTML = renderMarkdown(entry.text);
      els.copy.hidden = false;
      current = entry;
    });
  }

  function load() {
    els.endpoint.textContent = window.location.origin + "/api/phone-briefings/" + desk;
    Promise.all([getJson("/api/phone-briefings"), getJson("/api/phone-briefings/" + desk)])
      .then(function (results) {
        var categories = results[0].categories || [];
        var runs = results[1].runs || [];
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
          return '<option value="' + esc(run.id) + '">' + esc(stamp(run.receivedAt)) + (index === 0 ? " (latest)" : "") + "</option>";
        }).join("");
        els.picker.hidden = runs.length < 2;
        return loadRun(runs[0].id);
      })
      .catch(function (err) {
        showEmpty("Could not load briefings (" + err.message + ")");
      });
  }

  els.select.addEventListener("change", function () {
    loadRun(els.select.value).catch(function (err) {
      els.body.classList.remove("loading");
      els.age.textContent = "Could not load that run (" + err.message + ")";
    });
  });

  els.copy.addEventListener("click", function () {
    if (!current || !navigator.clipboard) return;
    navigator.clipboard.writeText(current.text).then(function () {
      els.copy.textContent = "Copied";
      setTimeout(function () { els.copy.textContent = "Copy text"; }, 1500);
    });
  });

  window.PhoneBriefing = { renderMarkdown: renderMarkdown };
  load();
})();
