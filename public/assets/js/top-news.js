/* Today's Top 10 — reads /api/daily-top-news and shows the day's Economics,
   Stocks and Crypto stories, one card per story. The phone's run comes
   first; a Reporter Room run is the backup. Nothing here generates,
   spends or broadcasts. */
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
    desks: document.getElementById("topNewsDesks"),
    status: document.getElementById("topNewsStatus"),
    sections: document.getElementById("topNewsSections"),
  };

  var state = { data: null, picked: {} };

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
        '. Run the Shortcut on your phone (see <a href="/briefings/' + desk.key + '">' + esc(desk.label) + "</a>), " +
        'or tap <strong>Run Now</strong> in the <a href="/reporter.html">Reporter Room</a>.</p></section>';
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
    }).catch(function (err) {
      els.status.className = "briefing-age stale";
      els.status.textContent = "Could not load the day's news (" + err.message + ")";
      els.sections.innerHTML = "";
      els.desks.innerHTML = "";
    });
  }

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
