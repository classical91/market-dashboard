/**
 * Market Q&A page (/qa.html): search, category and level filters, bookmarks,
 * recently viewed and a question of the day over the catalogue in qa-data.js.
 *
 * Deep links: #q=<question id> opens a question, #c=<category id> filters to
 * a category. Bookmarks and recently viewed live in this browser only.
 */
(function () {
  "use strict";

  var DATA = window.MarketQA || { CATEGORIES: [], ANSWERS: {} };
  var esc = (window.MarketUI && window.MarketUI.escapeHtml) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var BOOKMARKS_KEY = "market_qa_bookmarks";
  var RECENT_KEY = "market_qa_recent";
  var RECENT_LIMIT = 8;

  function slug(text) {
    return String(text).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }

  function humanize(id) {
    var label = String(id).replace(/-/g, " ");
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ── Build the flat index ─────────────────────────────────────────────
  var ENTRIES = [];
  var BY_ID = {};
  var BY_TEXT = {};
  DATA.CATEGORIES.forEach(function (cat) {
    cat.questions.forEach(function (q) {
      var answer = DATA.ANSWERS[q] || null;
      var entry = {
        id: slug(q),
        question: q,
        category: cat,
        level: (answer && answer.level) || cat.level || "Intermediate",
        answer: answer,
      };
      entry.haystack = (q + " " + cat.name + " " + (answer ? [answer.definition, answer.application, answer.limitation].join(" ") : "")).toLowerCase();
      ENTRIES.push(entry);
      BY_ID[entry.id] = entry;
      BY_TEXT[q] = entry;
    });
  });

  // ── Per-browser storage (optional) ───────────────────────────────────
  function load(key) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value.filter(function (id) { return BY_ID[id]; }) : [];
    } catch (_) {
      return [];
    }
  }
  function save(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) {}
  }

  var state = {
    query: "",
    category: "all",
    level: "all",
    answeredOnly: false,
    bookmarkedOnly: false,
    selected: null,
    bookmarks: load(BOOKMARKS_KEY),
    recent: load(RECENT_KEY),
  };

  var els = {};

  // ── Filtering ────────────────────────────────────────────────────────
  function matches(entry) {
    if (state.category !== "all" && entry.category.id !== state.category) return false;
    if (state.level !== "all" && entry.level !== state.level) return false;
    if (state.answeredOnly && !entry.answer) return false;
    if (state.bookmarkedOnly && state.bookmarks.indexOf(entry.id) === -1) return false;
    if (state.query) {
      var terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < terms.length; i++) {
        if (entry.haystack.indexOf(terms[i]) === -1) return false;
      }
    }
    return true;
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function renderStats() {
    var answered = ENTRIES.filter(function (e) { return e.answer; }).length;
    els.stats.innerHTML =
      stat("Questions", ENTRIES.length) +
      stat("Categories", DATA.CATEGORIES.length) +
      stat("Answered", answered) +
      stat("Bookmarked", state.bookmarks.length);
  }
  function stat(label, value) {
    return '<div class="qa-stat"><span class="qa-stat-value">' + esc(value) + '</span><span class="qa-stat-label">' + esc(label) + "</span></div>";
  }

  function renderCategories() {
    var counts = {};
    ENTRIES.forEach(function (e) {
      var saved = state.category;
      state.category = "all";
      if (matches(e)) counts[e.category.id] = (counts[e.category.id] || 0) + 1;
      state.category = saved;
    });
    var total = Object.keys(counts).reduce(function (sum, k) { return sum + counts[k]; }, 0);
    var html = catButton("all", "All categories", total, null);
    DATA.CATEGORIES.forEach(function (cat) {
      html += catButton(cat.id, cat.name, counts[cat.id] || 0, cat);
    });
    els.categories.innerHTML = html;
  }
  function catButton(id, name, count, cat) {
    var active = state.category === id;
    var tags = "";
    if (cat && cat.priority) tags += '<span class="qa-cat-rank" title="Start-here priority">#' + cat.priority + "</span>";
    if (cat && cat.suggested) tags += '<span class="qa-cat-flag" title="Suggested additions, not past questions">new</span>';
    return '<button type="button" class="qa-cat' + (active ? " active" : "") + (count ? "" : " empty") + '" data-cat="' + esc(id) + '" aria-pressed="' + active + '">' +
      '<span class="qa-cat-name">' + esc(name) + tags + "</span>" +
      '<span class="qa-cat-count">' + count + "</span></button>";
  }

  function renderList() {
    var list = ENTRIES.filter(matches);
    els.count.textContent = list.length + (list.length === 1 ? " question" : " questions");
    if (!list.length) {
      els.list.innerHTML = window.MarketUI
        ? window.MarketUI.emptyState("No questions match", "Try a different search, category or level.")
        : '<p class="qa-empty">No questions match.</p>';
      return;
    }
    var html = "";
    var lastCat = null;
    list.forEach(function (entry) {
      if (state.category === "all" && entry.category !== lastCat) {
        lastCat = entry.category;
        html += '<h3 class="qa-group">' + esc(entry.category.name) + "</h3>";
      }
      html += questionRow(entry);
    });
    els.list.innerHTML = html;
  }
  function questionRow(entry) {
    var selected = state.selected === entry.id;
    var saved = state.bookmarks.indexOf(entry.id) !== -1;
    return '<button type="button" class="qa-row' + (selected ? " active" : "") + '" data-q="' + esc(entry.id) + '" aria-current="' + (selected ? "true" : "false") + '">' +
      '<span class="qa-row-q">' + esc(entry.question) + "</span>" +
      '<span class="qa-row-meta">' +
      (saved ? '<span class="qa-row-saved" aria-label="Bookmarked">★</span>' : "") +
      levelBadge(entry.level) +
      (entry.answer ? '<span class="qa-badge qa-badge--answered">Answered</span>' : '<span class="qa-badge qa-badge--pending">Open</span>') +
      "</span></button>";
  }
  function levelBadge(level) {
    return '<span class="qa-badge qa-badge--' + esc(level.toLowerCase()) + '">' + esc(level) + "</span>";
  }

  function renderDetail() {
    var entry = state.selected && BY_ID[state.selected];
    if (!entry) {
      els.detail.innerHTML = renderHome();
      return;
    }
    var a = entry.answer;
    var saved = state.bookmarks.indexOf(entry.id) !== -1;
    var html =
      '<div class="qa-detail-tags"><span class="qa-detail-cat">' + esc(entry.category.name) + "</span>" + levelBadge(entry.level) + "</div>" +
      '<h2 class="qa-detail-q" id="qaDetailTitle" tabindex="-1">' + esc(entry.question) + "</h2>" +
      '<div class="qa-detail-actions">' +
      '<button type="button" class="qa-btn" data-action="bookmark" aria-pressed="' + saved + '">' + (saved ? "★ Bookmarked" : "☆ Bookmark") + "</button>" +
      '<button type="button" class="qa-btn" data-action="copy-link">Copy link</button>' +
      '<button type="button" class="qa-btn" data-action="close">Back to overview</button>' +
      "</div>";

    if (!a) {
      html += '<div class="qa-pending"><strong>Not answered yet.</strong> This question is in the catalogue so it can be found and linked; its written answer is still to come.' +
        (entry.category.suggested ? " It belongs to a category of suggested additions rather than questions asked before." : "") +
        "</div>";
      html += relatedSection(sameCategory(entry), "More in " + entry.category.name);
    } else {
      html += section("Definition", "<p>" + esc(a.definition) + "</p>");
      if (a.table) html += section("Typical relationships", tableHtml(a.table));
      html += section("Trading application", "<p>" + esc(a.application) + "</p>");
      html += section("Important limitation", "<p>" + esc(a.limitation) + "</p>", "qa-limit");
      html += relatedSection((a.related || []).map(function (t) { return BY_TEXT[t]; }).filter(Boolean), "Related questions");
      if (a.widgets && a.widgets.length) {
        html += section("See it live on the dashboard", '<div class="qa-links">' + a.widgets.map(function (w) {
          return '<a class="qa-link qa-link--widget" href="' + esc(w.href) + '">' + esc(w.label) + " →</a>";
        }).join("") + "</div>");
      }
      if (a.glossary && a.glossary.length) {
        html += section("Glossary", '<div class="qa-links">' + a.glossary.map(function (id) {
          return '<a class="qa-link" href="/concept.html?id=' + encodeURIComponent(id) + '">' + esc(humanize(id)) + "</a>";
        }).join("") + "</div>");
      }
    }
    els.detail.innerHTML = html;
  }
  function section(title, body, cls) {
    return '<section class="qa-section' + (cls ? " " + cls : "") + '"><h3>' + esc(title) + "</h3>" + body + "</section>";
  }
  function tableHtml(table) {
    return '<div class="qa-table-wrap"><table class="qa-table"><thead><tr>' +
      table.head.map(function (h) { return "<th scope=\"col\">" + esc(h) + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      table.rows.map(function (row) {
        return "<tr>" + row.map(function (cell, i) { return i === 0 ? "<th scope=\"row\">" + esc(cell) + "</th>" : "<td>" + esc(cell) + "</td>"; }).join("") + "</tr>";
      }).join("") +
      "</tbody></table></div>";
  }
  function relatedSection(entries, title) {
    if (!entries.length) return "";
    return section(title, '<div class="qa-related">' + entries.map(function (e) {
      return '<button type="button" class="qa-related-item" data-q="' + esc(e.id) + '">' + esc(e.question) + "</button>";
    }).join("") + "</div>");
  }
  function sameCategory(entry) {
    var list = ENTRIES.filter(function (e) { return e.category === entry.category && e !== entry; });
    var answered = list.filter(function (e) { return e.answer; });
    return answered.concat(list.filter(function (e) { return !e.answer; })).slice(0, 4);
  }

  // The overview shown when no question is open.
  function questionOfTheDay() {
    var pool = ENTRIES.filter(function (e) { return e.answer; });
    if (!pool.length) pool = ENTRIES;
    var d = new Date();
    var day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    return pool[day % pool.length];
  }
  function renderHome() {
    var qotd = questionOfTheDay();
    var html = "";
    if (qotd) {
      html += '<div class="qa-qotd"><div class="qa-kicker">Question of the day</div>' +
        '<button type="button" class="qa-qotd-q" data-q="' + esc(qotd.id) + '">' + esc(qotd.question) + "</button>" +
        '<div class="qa-qotd-cat">' + esc(qotd.category.name) + "</div></div>";
    }
    var start = DATA.CATEGORIES.filter(function (c) { return c.priority; }).sort(function (a, b) { return a.priority - b.priority; });
    if (start.length) {
      html += section("Where to start", '<ol class="qa-start">' + start.map(function (c) {
        return '<li><button type="button" class="qa-link-btn" data-cat="' + esc(c.id) + '">' + esc(c.name) + "</button></li>";
      }).join("") + "</ol>");
    }
    var recent = state.recent.map(function (id) { return BY_ID[id]; }).filter(Boolean);
    if (recent.length) html += relatedSection(recent, "Recently viewed");
    var saved = state.bookmarks.map(function (id) { return BY_ID[id]; }).filter(Boolean);
    if (saved.length) html += relatedSection(saved, "Bookmarks");
    html += '<p class="qa-note">The catalogue was rebuilt from past research questions and expanded to round out each topic, so not every entry was asked word for word. Trading Psychology holds suggested additions. Answers are education, not financial advice.</p>';
    return html;
  }

  function renderAll() {
    renderStats();
    renderCategories();
    renderList();
    renderDetail();
  }

  // ── Actions ──────────────────────────────────────────────────────────
  function select(id, opts) {
    if (id && !BY_ID[id]) id = null;
    state.selected = id;
    if (id) {
      state.recent = [id].concat(state.recent.filter(function (r) { return r !== id; })).slice(0, RECENT_LIMIT);
      save(RECENT_KEY, state.recent);
    }
    if (!opts || !opts.fromHash) writeHash();
    renderList();
    renderDetail();
    if (id && (!opts || opts.focus !== false)) {
      var title = document.getElementById("qaDetailTitle");
      if (title) {
        title.focus({ preventScroll: true });
        if (window.matchMedia("(max-width: 1100px)").matches) els.detail.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }
  }
  function setCategory(id) {
    state.category = id;
    writeHash();
    renderCategories();
    renderList();
  }
  function toggleBookmark(id) {
    var i = state.bookmarks.indexOf(id);
    if (i === -1) state.bookmarks.unshift(id);
    else state.bookmarks.splice(i, 1);
    save(BOOKMARKS_KEY, state.bookmarks);
    renderStats();
    renderCategories();
    renderList();
    renderDetail();
  }

  function writeHash() {
    var hash = state.selected ? "#q=" + state.selected : state.category !== "all" ? "#c=" + state.category : "";
    if (window.location.hash !== hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    }
  }
  function readHash() {
    var params = new URLSearchParams((window.location.hash || "").slice(1));
    var cat = params.get("c");
    if (cat && DATA.CATEGORIES.some(function (c) { return c.id === cat; })) state.category = cat;
    var q = params.get("q");
    state.selected = q && BY_ID[q] ? q : null;
  }

  function copyLink(button) {
    var url = window.location.href;
    var done = function (ok) {
      button.textContent = ok ? "Link copied" : "Copy failed";
      setTimeout(function () { button.textContent = "Copy link"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  function bind() {
    var searchTimer = 0;
    els.search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = els.search.value.trim();
        renderCategories();
        renderList();
      }, 80);
    });
    els.level.addEventListener("change", function () {
      state.level = els.level.value;
      renderCategories();
      renderList();
    });
    els.answered.addEventListener("change", function () {
      state.answeredOnly = els.answered.checked;
      renderCategories();
      renderList();
    });
    els.bookmarked.addEventListener("change", function () {
      state.bookmarkedOnly = els.bookmarked.checked;
      renderCategories();
      renderList();
    });
    els.random.addEventListener("click", function () {
      var pool = ENTRIES.filter(matches);
      if (!pool.length) pool = ENTRIES;
      select(pool[Math.floor(Math.random() * pool.length)].id);
    });

    document.addEventListener("click", function (event) {
      var target = event.target.closest("[data-q], [data-cat], [data-action]");
      if (!target || !document.querySelector(".qa-layout").contains(target)) return;
      if (target.hasAttribute("data-q")) select(target.getAttribute("data-q"));
      else if (target.hasAttribute("data-cat")) setCategory(target.getAttribute("data-cat"));
      else {
        var action = target.getAttribute("data-action");
        if (action === "bookmark" && state.selected) toggleBookmark(state.selected);
        else if (action === "copy-link") copyLink(target);
        else if (action === "close") select(null);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "/" && document.activeElement !== els.search && !/input|textarea|select/i.test((document.activeElement || {}).tagName || "")) {
        event.preventDefault();
        els.search.focus();
      }
    });

    window.addEventListener("hashchange", function () {
      readHash();
      renderCategories();
      renderList();
      renderDetail();
    });
  }

  function init() {
    els.stats = document.getElementById("qaStats");
    els.search = document.getElementById("qaSearch");
    els.level = document.getElementById("qaLevel");
    els.answered = document.getElementById("qaAnswered");
    els.bookmarked = document.getElementById("qaBookmarked");
    els.random = document.getElementById("qaRandom");
    els.categories = document.getElementById("qaCategories");
    els.list = document.getElementById("qaList");
    els.count = document.getElementById("qaCount");
    els.detail = document.getElementById("qaDetail");
    if (!els.list) return;
    if (!ENTRIES.length) {
      els.list.innerHTML = window.MarketUI ? window.MarketUI.errorState("Q&A catalogue failed to load", "qa-data.js did not load.") : "Q&A catalogue failed to load.";
      return;
    }
    readHash();
    bind();
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
