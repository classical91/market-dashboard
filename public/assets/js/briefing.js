/* Desk briefings — one desk at a time: what the iOS Shortcut pushed to
   /api/phone-briefings, plus the desk's Reporter Room runs. ⚡ Run writes
   the desk now through the Reporter Room (admin key, OpenAI credits).
   Nothing here broadcasts. */
(function () {
  "use strict";

  var freshness = window.BriefingFreshness;
  var categories = [];
  var generationsByDesk = {};
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
    telegram: document.getElementById("briefingTelegram"),
  };
  var telegramInfo = null;
  var sending = false;
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
      weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function renderDesks(categories) {
    els.desks.innerHTML = categories.map(function (cat) {
      var latestAt = cat.latest && cat.latest.receivedAt;
      // Every card checks both sources, regardless of the desk being read.
      var newest = (generationsByDesk[cat.key] || [])[0];
      var reporter = newest && (!latestAt || new Date(newest.generatedAt).getTime() > new Date(latestAt).getTime());
      if (reporter) latestAt = newest.generatedAt;
      var tone = freshness.state(latestAt);
      var meta = tone === "empty" ? "nothing yet" :
        (reporter ? "⚡ " : "📱 ") + ago(latestAt) + " · " + freshness.label(latestAt);
      var cls = "briefing-desk" + (cat.key === desk ? " active" : "") + " " + tone;
      return '<a class="' + cls + '" href="/briefings/' + cat.key + '"' + (cat.key === desk ? ' aria-current="page"' : "") + ">" +
        '<span class="briefing-desk-name">' + esc(cat.icon + " " + cat.label) + "</span>" +
        '<span class="briefing-desk-meta" title="' + esc(tone === "empty" ? meta : stamp(latestAt)) + '">' + esc(meta) + "</span>" +
        (tone === "empty" ? "" : '<time class="briefing-desk-time" datetime="' + esc(latestAt) + '">' + esc(stamp(latestAt)) + '</time>') + "</a>";
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

  function renderAge(entry) {
    var phone = entry.source === "phone";
    els.age.className = "briefing-age " + freshness.state(entry.at);
    els.age.textContent = (phone ? "📱 Received " : "⚡ Written by the Reporter Room ") + stamp(entry.at) + " · " + ago(entry.at) + " · " + freshness.label(entry.at);
  }

  function showRun(entry) {
    renderAge(entry);
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
    var reporterRuns = Promise.all(DESKS.map(function (key) {
      return getJson("/api/daily-report/generations?section=" + SECTIONS[key] + "&limit=" + (key === desk ? 10 : 1))
        .then(function (data) { return data.generations || []; }, function () { return []; })
        .then(function (generations) { return { key: key, generations: generations }; });
    }));
    return Promise.all([getJson("/api/phone-briefings"), getJson("/api/phone-briefings/" + desk), reporterRuns])
      .then(function (results) {
        categories = results[0].categories || [];
        results[2].forEach(function (result) { generationsByDesk[result.key] = result.generations; });
        runs = (results[1].runs || []).map(function (run) {
          return { source: "phone", id: run.id, at: run.receivedAt };
        }).concat(generationsByDesk[desk].map(function (gen) {
          return { source: "reporter", id: "reporter-" + gen.generatedAt, at: gen.generatedAt, text: gen.content, title: null };
        })).filter(function (run) { return isFinite(new Date(run.at).getTime()); })
          .sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
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

  /* 📣 Send to Telegram: only on desks switched on in Settings → Telegram →
     News Category Routing. The server looks the run up itself and sends it
     to that desk's groups and topics, once per run. */
  function loadTelegram() {
    return getJson("/api/desk-telegram").then(function (info) {
      telegramInfo = info;
      var mine = info.desks && info.desks[desk];
      els.telegram.hidden = !(info.telegramConfigured && mine && mine.telegram);
    }, function () { els.telegram.hidden = true; });
  }

  function sendTelegram() {
    if (sending || !window.AdminKey || !telegramInfo) return;
    if (!current) {
      setRunMessage("Nothing to send yet: tap ⚡ Run " + LABELS[desk] + " first, or run the phone Shortcut.", "error");
      return;
    }
    var mine = telegramInfo.desks[desk];
    var where = mine.destinations + (mine.destinations === 1 ? " Telegram group/topic" : " Telegram groups/topics");
    if (!window.confirm("Send this " + LABELS[desk] + " run (" + stamp(current.at) + ") to " + where + "?")) return;
    sending = true;
    els.telegram.disabled = true;
    els.telegram.textContent = "📣 Sending…";
    window.AdminKey.fetch("/api/desk-telegram/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desk: desk, runId: current.id }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      });
    }).then(function (data) {
      if (data.alreadySent) setRunMessage("This run was already sent to Telegram; nothing was sent again.", "ok");
      else if (data.failed) setRunMessage("Sent to " + data.posted + " of " + data.destinations + " Telegram destinations; " + data.failed + " failed. See the Broadcast Ledger.", "error");
      else setRunMessage("Sent to " + data.posted + " Telegram destination" + (data.posted === 1 ? "" : "s") + ". Receipt is in the Broadcast Ledger.", "ok");
    }).catch(function (err) {
      setRunMessage("Not sent to Telegram: " + (err.message || "error"), "error");
    }).finally(function () {
      sending = false;
      els.telegram.disabled = false;
      els.telegram.textContent = "📣 Send to Telegram";
    });
  }

  els.telegram.addEventListener("click", sendTelegram);

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

  // Keep ages and colors current even if the page stays open for days.
  window.setInterval(function () {
    if (categories.length) renderDesks(categories);
    if (current) renderAge(current);
  }, 60000);
  window.addEventListener("focus", function () { if (!running) load(); });
  load();
  loadTelegram();
})();
