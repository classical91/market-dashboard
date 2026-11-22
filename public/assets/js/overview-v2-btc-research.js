/**
 * Overview v2 → BTC Research dropdown.
 *
 * Crypto Hub's Bitcoin Research section (/crypto.html#crypto-research) is the
 * single source of truth: this reads that section's links, including its
 * nested dropdowns (Long vs Short, Technical Analysis), and renders them
 * here. Adding or editing a card in crypto.html updates both pages.
 */
(function (root) {
  "use strict";

  var SOURCE_URL = "/crypto.html";
  var SECTION_ID = "crypto-research";
  var OPEN_KEY = "overviewV2.btcResearchOpen";
  var SUB_OPEN_KEY = "overviewV2.btcResearchSubOpen";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // Badge colours come from theme tokens only (background:var(--x-bg);color:var(--x)).
  function safeStyle(style) {
    var value = String(style || "").trim();
    return /^(?:\s*(?:background|color)\s*:\s*var\(--[a-z0-9-]+\)\s*;?)+$/i.test(value) ? value : "";
  }

  function safeHref(href) {
    var value = String(href || "").trim();
    return /^(?:https?:\/\/|\/)/i.test(value) ? value : "";
  }

  function text(node, selector) {
    var el = node.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function readLink(card) {
    var badge = card.querySelector(".badge");
    return {
      href: card.getAttribute("href") || "",
      badge: text(card, ".badge"),
      badgeStyle: badge ? badge.getAttribute("style") || "" : "",
      title: text(card, ".card-title"),
      src: text(card, ".card-src"),
    };
  }

  /** Read Crypto Hub's Bitcoin Research panel into { links, groups }. */
  function extract(panel) {
    var data = { links: [], groups: [] };
    var children = Array.prototype.slice.call(panel.children);
    children.forEach(function (child, index) {
      if (child.matches("a.card")) {
        data.links.push(readLink(child));
      } else if (child.matches(".section-header--sub[data-section]")) {
        var id = child.getAttribute("data-section");
        var list = panel.querySelector("#" + id) || children[index + 1];
        if (!list) return;
        data.groups.push({
          id: id,
          label: text(child, ".section-label"),
          links: Array.prototype.map.call(list.querySelectorAll("a.card"), readLink),
        });
      }
    });
    return data;
  }

  function linkHtml(link) {
    var href = safeHref(link.href);
    if (!href) return "";
    var external = /^https?:\/\//i.test(href);
    return '<a class="card" href="' + esc(href) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" +
      '<div class="card-top"><span class="badge" style="' + esc(safeStyle(link.badgeStyle)) + '">' + esc(link.badge) + "</span>" +
      '<span class="arrow" aria-hidden="true">&#8599;</span></div>' +
      '<div class="card-title">' + esc(link.title) + "</div>" +
      '<div class="card-src">' + esc(link.src) + "</div></a>";
  }

  function countLinks(data) {
    return data.groups.reduce(function (sum, group) { return sum + group.links.length; }, data.links.length);
  }

  /** HTML for the dropdown body; `openGroups` lists sub-dropdown ids to start open. */
  function render(data, openGroups) {
    var open = openGroups || [];
    if (!countLinks(data)) {
      return '<div class="ov2-empty"><strong>No Bitcoin Research links</strong>' +
        '<p>Crypto Hub’s Bitcoin Research section is empty. Add cards there and they appear here.</p></div>';
    }
    return '<div class="cards ov2-btc-cards">' + data.links.map(linkHtml).join("") +
      data.groups.map(function (group) {
        return '<details class="ov2-btc-sub" data-group="' + esc(group.id) + '"' + (open.indexOf(group.id) !== -1 ? " open" : "") + ">" +
          '<summary><span class="section-label section-label--btc">' + esc(group.label) + "</span>" +
          '<span class="ov2-btc-sub-count">' + group.links.length + "</span></summary>" +
          '<div class="ov2-btc-sublist">' + (group.links.length ? group.links.map(linkHtml).join("") : '<p class="ov2-note">No links yet.</p>') + "</div>" +
          "</details>";
      }).join("") + "</div>";
  }

  var api = { extract: extract, render: render, countLinks: countLinks, safeStyle: safeStyle, safeHref: safeHref };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  var details = document.getElementById("btc-research");
  var body = document.getElementById("ov2-btc-body");
  var countEl = document.getElementById("ov2-btc-count");
  if (!details || !body) return;

  function readStore(key, fallback) {
    try { var value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch (e) { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function openFromHash() {
    if (window.location.hash !== "#btc-research") return;
    details.open = true;
    details.scrollIntoView({ block: "start" });
  }

  if (readStore(OPEN_KEY, false) === true) details.open = true;
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
  details.addEventListener("toggle", function () { writeStore(OPEN_KEY, details.open); });

  // The sidebar's "BTC Research" link points here; the summary's own link
  // to Crypto Hub must navigate, not toggle the dropdown.
  var hubLink = details.querySelector(".ov2-news-link");
  if (hubLink) hubLink.addEventListener("click", function (event) { event.stopPropagation(); });

  body.addEventListener("toggle", function (event) {
    var sub = event.target;
    if (!sub.matches || !sub.matches(".ov2-btc-sub")) return;
    var open = Array.prototype.map.call(body.querySelectorAll(".ov2-btc-sub[open]"), function (el) {
      return el.getAttribute("data-group");
    });
    writeStore(SUB_OPEN_KEY, open);
  }, true);

  function showError(message) {
    countEl.textContent = "Unavailable";
    body.innerHTML = '<div class="ov2-empty"><strong class="ov2-warn">Bitcoin Research unavailable</strong>' +
      "<p>" + esc(message) + "</p>" +
      '<button class="ov2-button" type="button" data-btc-retry>Retry</button> ' +
      '<a class="ov2-news-link" href="/crypto.html#crypto-research">Open in Crypto Hub ↗</a></div>';
  }

  function load() {
    countEl.textContent = "Loading…";
    body.innerHTML = '<div class="ov2-loading">Loading Bitcoin Research…<div class="ov2-skeleton"></div><div class="ov2-skeleton"></div></div>';
    return fetch(SOURCE_URL, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var panel = doc.getElementById(SECTION_ID);
        if (!panel) throw new Error("Crypto Hub has no Bitcoin Research section.");
        var data = extract(panel);
        var total = countLinks(data);
        countEl.textContent = total + " link" + (total === 1 ? "" : "s") +
          (data.groups.length ? " · " + data.groups.map(function (g) { return g.label; }).join(" · ") : "");
        body.innerHTML = render(data, readStore(SUB_OPEN_KEY, []));
      })
      .catch(function (err) { showError(err && err.message ? err.message : "Request failed."); });
  }

  body.addEventListener("click", function (event) {
    if (event.target.closest("[data-btc-retry]")) load();
  });

  root.OverviewV2BtcResearch = api;
  load();
})(typeof window !== "undefined" ? window : globalThis);
