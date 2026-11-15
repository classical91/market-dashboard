/* Today's Top 10 — reads /api/daily-top-news and shows the day's Economics,
   Stocks and Crypto stories, one card per story. The phone's run comes
   first; a Reporter Room run is the backup. Run News writes the three desks
   through the Reporter Room API (admin key, OpenAI credits); nothing here
   broadcasts. */
(function () {
  "use strict";

  var md = window.BriefingMarkdown;
  var esc = md.esc;
  var inline = md.inline;
  var renderMarkdown = md.renderMarkdown;

  var timeZone = "";
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { timeZone = ""; }

  var els = {
    prev: document.getElementById("topNewsPrev"),
    next: document.getElementById("topNewsNext"),
    date: document.getElementById("topNewsDate"),
    today: document.getElementById("topNewsToday"),
    copyAll: document.getElementById("topNewsCopyAll"),
    run: document.getElementById("topNewsRun"),
    farmbot: document.getElementById("topNewsFarmbot"),
    slip: document.getElementById("topNewsSlip"),
    runMessage: document.getElementById("topNewsRunMessage"),
    desks: document.getElementById("topNewsDesks"),
    status: document.getElementById("topNewsStatus"),
    sections: document.getElementById("topNewsSections"),
  };

  var state = { data: null, picked: {}, running: false, sending: false, farmbot: null };
  var DESK_ICONS = { economics: "🏦", stocks: "📈", crypto: "₿" };

  // The Reporter Room's section for each desk; `markets` is Stocks.
  var RUN_DESKS = [
    { key: "economics", label: "Economics", section: "economics" },
    { key: "stocks", label: "Stocks", section: "markets" },
    { key: "crypto", label: "Crypto", section: "crypto", prompt: [
      "{date}",
      "TOP 10 CRYPTO NEWS BRIEF (LAST 24-48 HOURS)",
      "",
      "Search for current, verified cryptocurrency news from the last 24-48 hours and produce a TOP 10 report.",
      "This is news, not a list of trending tokens.",
      "",
      "PRIORITIZE:",
      "- Regulation, enforcement and policy (SEC, CFTC, EU MiCA, Asia)",
      "- ETF flows, approvals and institutional adoption",
      "- Major price moves in BTC, ETH and large caps, with the reason",
      "- Exchange, stablecoin and protocol news: hacks, launches, upgrades, listings",
      "- On-chain or macro developments that moved the market",
      "",
      "RULES:",
      "- Output exactly 10 stories.",
      "- Use a bold numbered heading: **#[N] [ASSET/TOPIC] — [HEADLINE]**",
      "- Add 2-3 short hyphen bullets: what happened, why it matters, and the source.",
      "- Separate confirmed facts from forecasts; no buy/sell advice.",
      "- Avoid duplicating the same event from multiple sources.",
    ].join("\n") },
  ];

  function queryDate() {
    var value = new URLSearchParams(window.location.search).get("date") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  }

  function shiftDate(key, days) {
    var d = new Date(key + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function longDate(key) {
    return new Date(key + "T12:00:00Z").toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
    });
  }

  function time(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function sourceLabel(run) {
    return (run.source === "phone" ? "📱 Phone" : "⚡ Reporter Room") + " · " + time(run.at);
  }

  function currentRun(desk) {
    var id = state.picked[desk.key];
    var match = desk.runs.filter(function (run) { return run.id === id; })[0];
    return match || desk.runs[0] || null;
  }

  /* Plain text for pasting into X, Telegram or FarmBot. */
  function plainText(desk, run) {
    var head = desk.label.toUpperCase() + " — TOP " + (run.stories.length || 10) + " · " + longDate(state.data.date);
    if (!run.stories.length) return head + "\n\n" + run.text;
    return head + "\n\n" + run.stories.map(function (story) {
      return story.number + ". " + story.title + (story.body ? "\n" + story.body : "");
    }).join("\n\n");
  }

  function copy(text, button, label) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = label; }, 1500);
    });
  }

  function renderDeskChips(desks) {
    els.desks.innerHTML = desks.map(function (desk) {
      var run = currentRun(desk);
      var meta = run
        ? (run.stories.length ? run.stories.length + " stories" : "full text") + " · " + sourceLabel(run)
        : "nothing made this day";
      return '<a class="briefing-desk' + (run ? (run.source === "phone" ? "" : " stale") : " empty") +
        '" href="#desk-' + desk.key + '">' +
        '<span class="briefing-desk-name">' + esc(desk.icon + " " + desk.label) + "</span>" +
        '<span class="briefing-desk-meta">' + esc(meta) + "</span></a>";
    }).join("");
  }

  function renderStories(run) {
    if (!run.stories.length) {
      return '<article class="briefing-body">' + renderMarkdown(run.text) + "</article>";
    }
    return '<ol class="topnews-stories">' + run.stories.map(function (story) {
      return '<li class="topnews-story">' +
        '<span class="briefing-rank">' + story.number + "</span>" +
        '<div class="topnews-story-main">' +
        '<h3 class="topnews-story-title">' + inline(story.title) + "</h3>" +
        (story.body ? '<div class="briefing-body">' + renderMarkdown(story.body) + "</div>" : "") +
        "</div></li>";
    }).join("") + "</ol>";
  }

  function renderSection(desk) {
    var run = currentRun(desk);
    var html = '<section class="briefing-card topnews-section" id="desk-' + desk.key + '" aria-labelledby="desk-' + desk.key + '-title">' +
      '<div class="briefing-toolbar">' +
      '<h2 class="topnews-desk-title" id="desk-' + desk.key + '-title">' + esc(desk.icon + " " + desk.label) + "</h2>";
    if (!run) {
      return html + "</div>" +
        '<p class="briefing-empty">Nothing was made for ' + esc(desk.label) + " on " + esc(longDate(state.data.date)) +
        '. Tap <strong>⚡ Run News</strong> above to write it now, or run the Shortcut on your phone (see <a href="/briefings/' +
        desk.key + '">' + esc(desk.label) + "</a>).</p></section>";
    }
    html += '<span class="briefing-age ' + (run.source === "phone" ? "fresh" : "") + '">' + esc(sourceLabel(run)) + "</span>";
    if (desk.runs.length > 1) {
      html += '<label class="briefing-run-picker"><span>Run</span><select data-desk="' + desk.key + '">' +
        desk.runs.map(function (option) {
          return '<option value="' + esc(option.id) + '"' + (option.id === run.id ? " selected" : "") + ">" +
            esc(sourceLabel(option)) + "</option>";
        }).join("") + "</select></label>";
    }
    html += '<button type="button" class="briefing-btn" data-copy="' + desk.key + '">Copy ' + esc(desk.label) + "</button></div>";
    if (run.stories.length && run.stories.length < 10) {
      html += '<p class="topnews-note">This run has ' + run.stories.length + " numbered stories.</p>";
    }
    return html + renderStories(run) + "</section>";
  }

  function render() {
    var data = state.data;
    var desks = data.desks || [];
    var made = desks.filter(function (desk) { return desk.runs.length; }).length;
    els.date.value = data.date;
    els.date.max = data.today;
    els.next.disabled = data.date >= data.today;
    els.today.hidden = data.date === data.today;
    els.status.className = "briefing-age" + (made ? " fresh" : "");
    els.status.textContent = longDate(data.date) + " · " + made + " of " + desks.length + " desks have news" +
      (data.timeZone ? " · day counted in " + data.timeZone : "");
    els.copyAll.disabled = !made;
    // Run News writes today's news; past days can only be read.
    els.run.hidden = data.date !== data.today;
    els.run.disabled = state.running || state.sending;
    els.farmbot.hidden = data.date !== data.today;
    els.farmbot.disabled = state.running || state.sending || !made;
    renderDeskChips(desks);
    els.sections.innerHTML = desks.map(renderSection).join("");
  }

  function load(date) {
    var params = new URLSearchParams();
    if (date) params.set("date", date);
    if (timeZone) params.set("tz", timeZone);
    els.status.className = "briefing-age";
    els.status.textContent = "Loading…";
    return fetch("/api/daily-top-news?" + params.toString(), {
      headers: { Accept: "application/json" }, credentials: "same-origin",
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      state.data = data;
      state.picked = {};
      var url = new URL(window.location.href);
      if (data.date === data.today) url.searchParams.delete("date");
      else url.searchParams.set("date", data.date);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      render();
      loadSlip();
    }).catch(function (err) {
      els.status.className = "briefing-age stale";
      els.status.textContent = "Could not load the day's news (" + err.message + ")";
      els.sections.innerHTML = "";
      els.desks.innerHTML = "";
    });
  }

  function setRunMessage(text, tone) {
    els.runMessage.hidden = !text;
    els.runMessage.textContent = text || "";
    els.runMessage.className = "topnews-run-message" + (tone ? " " + tone : "");
  }

  function readApiJson(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      return data;
    });
  }

  /* One desk at a time: the Reporter Room generates a section per request,
     and running them in order keeps each result readable. */
  function runDesk(desk) {
    return window.AdminKey.fetch("/api/daily-report/generate?section=" + desk.section, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desk.prompt ? { prompt: desk.prompt } : {}),
    }).then(readApiJson).then(function (data) {
      if (data.configured === false) throw new Error("the Reporter has no OPENAI_API_KEY on the server");
      if (data.rateLimited) return desk.label + ": OpenAI is rate-limited, try again later";
      if (data.generationSkippedReason) return desk.label + ": already written today";
      if (data.error) throw new Error(data.error);
      return desk.label + ": done";
    });
  }

  function runNews() {
    if (state.running || !window.AdminKey) return;
    state.running = true;
    els.run.disabled = true;
    els.run.textContent = "⚡ Running…";
    var results = [];
    var failed = false;
    var chain = Promise.resolve();
    RUN_DESKS.forEach(function (desk, index) {
      chain = chain.then(function () {
        setRunMessage("Writing " + desk.label + " (" + (index + 1) + " of " + RUN_DESKS.length +
          "). Each desk can take a minute; nothing is broadcast.", "");
        return runDesk(desk).then(function (line) {
          results.push(line);
        }, function (err) {
          failed = true;
          results.push(desk.label + ": failed (" + (err.message || "error") + ")");
        });
      });
    });
    chain.then(function () {
      setRunMessage(results.join(" · "), failed ? "error" : "ok");
      return load("");
    }).finally(function () {
      state.running = false;
      els.run.disabled = false;
      els.run.textContent = "⚡ Run News";
    });
  }

  els.run.addEventListener("click", runNews);

  // ── FarmBot Top 10 ────────────────────────────────────────────────────

  function when(iso) {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderSlip() {
    var info = state.farmbot;
    var slip = info && info.slip;
    if (!info || (!slip && info.configured)) { els.slip.hidden = true; return; }
    var html = "";
    if (!slip) {
      html = '<p class="briefing-empty">Sending to FarmBot needs these settings on the server: <strong>' +
        esc((info.missing || []).join(", ")) + "</strong>.</p>";
    } else {
      var title = slip.outcome === "sent" ? "✅ Sent to FarmBot · waiting for your approval"
        : slip.outcome === "already-sent" ? "📌 Today's Top 10 is already in FarmBot"
        : "⚠️ Not sent to FarmBot";
      html += '<div class="briefing-toolbar"><h2 class="topnews-desk-title">' + esc(title) + "</h2>" +
        '<span class="briefing-age">' + esc(when(slip.recordedAt)) + "</span>";
      if (slip.approvalUrl) {
        html += '<a class="briefing-btn topnews-approve" href="' + esc(slip.approvalUrl) + '" target="_blank" rel="noopener">Open in FarmBot to approve →</a>';
      }
      html += "</div>";
      if (slip.error) html += '<p class="topnews-slip-error">' + esc(slip.error) + "</p>";
      if (slip.clientBatchId) {
        html += '<p class="topnews-note">Batch <code>' + esc(slip.clientBatchId) + "</code>" +
          (slip.farmbotStatus ? " · FarmBot status: " + esc(slip.farmbotStatus) : "") +
          (slip.stories && slip.stories.length ? " · " + slip.stories.length + " stories" : "") +
          ". Nothing is posted until you approve it and start the timers in FarmBot.</p>";
      }
      if (slip.stories && slip.stories.length) {
        html += '<ol class="topnews-stories">' + slip.stories.map(function (story) {
          return '<li class="topnews-story"><span class="briefing-rank">' + story.number + "</span>" +
            '<div class="topnews-story-main">' +
            (story.headline ? '<h3 class="topnews-story-title">' + esc((DESK_ICONS[story.desk] || "") + " " + story.headline) + "</h3>" : "") +
            '<div class="briefing-body"><p>' + esc(story.post || "") + "</p>" +
            (story.url ? '<p class="topnews-source"><a href="' + esc(story.url) + '" target="_blank" rel="noopener noreferrer">' +
              esc(story.publisher || story.url) + "</a>" + (story.imageMatches === false ? " · image is generic" : "") + "</p>" : "") +
            "</div></div></li>";
        }).join("") + "</ol>";
      }
      if (slip.skipped && slip.skipped.length) {
        html += '<details class="briefing-help topnews-skipped"><summary>' + slip.skipped.length + " stories skipped</summary><ul>" +
          slip.skipped.map(function (item) {
            return "<li><strong>" + esc(item.ref || "") + "</strong> " + esc(item.headline || "") + " — " + esc(item.reason || "") + "</li>";
          }).join("") + "</ul></details>";
      }
    }
    els.slip.innerHTML = html;
    els.slip.hidden = false;
  }

  function loadSlip() {
    if (!state.data) return Promise.resolve();
    return fetch("/api/daily-top-news/farmbot?date=" + encodeURIComponent(state.data.date), {
      headers: { Accept: "application/json" }, credentials: "same-origin",
    }).then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) { state.farmbot = info; renderSlip(); })
      .catch(function () { /* the receipt is optional; the page still works */ });
  }

  function sendToFarmbot() {
    if (state.sending || !state.data || !window.AdminKey) return;
    if (!window.confirm("Merge today's Economics, Stocks and Crypto into a Top 10 and send it to FarmBot for your approval? " +
      "This uses OpenAI credits. Nothing is posted until you approve it in FarmBot.")) return;
    state.sending = true;
    els.farmbot.textContent = "📤 Sending…";
    render();
    setRunMessage("Ranking the day's stories, checking each source article and its image, then sending to FarmBot. " +
      "This can take a few minutes; keep this page open.", "");
    var runs = {};
    state.data.desks.forEach(function (desk) {
      var run = currentRun(desk);
      if (run) runs[desk.key] = run.id;
    });
    window.AdminKey.fetch("/api/daily-top-news/farmbot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tz: timeZone, runs: runs }),
    }).then(readApiJson).then(function (data) {
      var slip = data.slip || {};
      setRunMessage(slip.outcome === "sent"
        ? "Sent " + (slip.stories || []).length + " stories to FarmBot. Open the receipt link below to approve them."
        : slip.outcome === "already-sent" ? "Today's Top 10 was already in FarmBot; nothing new was sent."
        : "Not sent: " + (slip.error || "see the receipt below"), slip.outcome === "failed" ? "error" : "ok");
    }).catch(function (err) {
      setRunMessage("Not sent to FarmBot: " + (err.message || "error"), "error");
    }).finally(function () {
      state.sending = false;
      els.farmbot.textContent = "📤 Send to FarmBot";
      render();
      loadSlip();
    });
  }

  els.farmbot.addEventListener("click", sendToFarmbot);

  els.prev.addEventListener("click", function () {
    if (state.data) load(shiftDate(state.data.date, -1));
  });
  els.next.addEventListener("click", function () {
    if (state.data && state.data.date < state.data.today) load(shiftDate(state.data.date, 1));
  });
  els.today.addEventListener("click", function () { load(""); });
  els.date.addEventListener("change", function () {
    if (/^\d{4}-\d{2}-\d{2}$/.test(els.date.value)) load(els.date.value);
  });

  els.sections.addEventListener("change", function (event) {
    var select = event.target.closest("select[data-desk]");
    if (!select) return;
    state.picked[select.getAttribute("data-desk")] = select.value;
    render();
  });

  els.sections.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-copy]");
    if (!button || !state.data) return;
    var desk = state.data.desks.filter(function (d) { return d.key === button.getAttribute("data-copy"); })[0];
    var run = desk && currentRun(desk);
    if (run) copy(plainText(desk, run), button, "Copy " + desk.label);
  });

  els.copyAll.addEventListener("click", function () {
    if (!state.data) return;
    var text = state.data.desks.map(function (desk) {
      var run = currentRun(desk);
      return run ? plainText(desk, run) : "";
    }).filter(Boolean).join("\n\n————————\n\n");
    copy(text, els.copyAll, "Copy all");
  });

  load(queryDate());
})();
