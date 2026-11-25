/* Overview v2 watchlist card — a TradingView-style list of saved tickers.

   Read-only apart from switching watchlists and collapsing subtitles:
   tickers, subtitles, watchlists and bookmark colours are edited under
   Settings → Watchlists. (Internally a watchlist is a "folder" and a
   subtitle a "section"; the saved format is unchanged.) No prices are fetched; each row links to the symbol's
   TradingView chart. */
(function () {
  'use strict';

  var W = window.Watchlists;
  var card = document.getElementById('ov2-watchlist');
  if (!W || !card) return;

  var esc = W.escapeHtml;
  var titleBtn = card.querySelector('.wl-title-btn');
  var titleName = card.querySelector('.wl-title-name');
  var titleFlag = card.querySelector('.wl-title-flag');
  var menu = card.querySelector('.wl-menu');
  var pins = card.querySelector('.wl-pins');
  var list = card.querySelector('.wl-list');
  var count = card.querySelector('.wl-count');
  var addLink = card.querySelector('.wl-add');
  var state = W.read();

  /* Collapsed sections are a per-browser view preference, kept apart from
     the watchlists themselves: { folderId: ["###Name", ...] }. */
  var COLLAPSE_KEY = 'mc_watchlists_collapsed_v1';
  var collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch (err) { collapsed = {}; }

  function isCollapsed(folder, section) {
    var list = collapsed[folder.id];
    return Array.isArray(list) && list.indexOf(section) !== -1;
  }

  function setCollapsed(folder, section, value) {
    var list = (Array.isArray(collapsed[folder.id]) ? collapsed[folder.id] : []).filter(function (s) {
      return s !== section && folder.tickers.indexOf(s) !== -1;
    });
    if (value) list.push(section);
    if (list.length) collapsed[folder.id] = list; else delete collapsed[folder.id];
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (err) {}
  }

  function settingsHref(folder) {
    return '/settings.html' + (folder ? '?watchlist=' + encodeURIComponent(folder.id) : '') + '#watchlists';
  }

  function folderChip(f) {
    var color = W.colorHex(f.bookmark);
    return '<span class="wl-chip"' + (color ? ' style="--wl-c:' + color + '"' : '') + '>' +
      (f.bookmark ? W.flagSvg(f.bookmark, 10) : '<span class="wl-chip-dot" aria-hidden="true"></span>') +
      esc(f.name) + '</span>';
  }

  function renderRows(folder) {
    if (!folder) {
      list.innerHTML = '<li class="wl-empty">No watchlists yet. <a href="' + settingsHref() + '">Create one in Settings</a>.</li>';
      return;
    }
    if (!folder.tickers.length) {
      list.innerHTML = '<li class="wl-empty">This watchlist is empty. <a href="' + settingsHref(folder) + '">Add symbols in Settings</a>.</li>';
      return;
    }
    list.innerHTML = W.groupsOf(folder).map(function (group, gi) {
      var rows = group.symbols.map(function (symbol) { return rowHtml(folder, symbol); }).join('');
      if (!group.section) return rows;
      var shut = isCollapsed(folder, group.section);
      var bodyId = 'wl-sec-' + gi;
      return '<li class="wl-group' + (shut ? ' is-collapsed' : '') + '">' +
        '<button type="button" class="wl-section" data-section="' + esc(group.section) + '" aria-expanded="' + !shut + '" aria-controls="' + bodyId + '">' +
        '<svg class="wl-section-chev" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="wl-section-name">' + esc(group.name) + '</span>' +
        '<span class="wl-section-count">' + group.symbols.length + '</span></button>' +
        '<ul class="wl-group-rows" id="' + bodyId + '"' + (shut ? ' hidden' : '') + '>' +
        (rows || '<li class="wl-group-empty">No symbols under this subtitle.</li>') + '</ul></li>';
    }).join('');
  }

  function rowHtml(folder, symbol) {
    var parts = W.tickerParts(symbol);
    var inFolders = W.foldersFor(state, symbol);
    var flagged = inFolders.filter(function (f) { return f.bookmark; })[0];
    var assigned = inFolders.filter(function (f) { return f.id !== folder.id; });
    var shown = assigned.slice(0, 2).map(folderChip).join('');
    var more = assigned.length > 2 ? '<span class="wl-chip wl-chip-more">+' + (assigned.length - 2) + '</span>' : '';
    var names = assigned.map(function (f) { return f.name; }).join(', ');
    return '<li><a class="wl-row" href="' + esc(W.tradingViewUrl(symbol)) + '" target="_blank" rel="noopener noreferrer"' +
      ' title="Open ' + esc(symbol) + ' on TradingView"' +
      (flagged ? ' style="--wl-flag:' + W.colorHex(flagged.bookmark) + '"' : '') + '>' +
      '<span class="wl-icon" style="--wl-tint:' + W.iconTint(symbol) + '" aria-hidden="true">' + esc(parts.ticker.charAt(0)) + '</span>' +
      '<span class="wl-sym"><strong>' + esc(parts.ticker) + '</strong>' +
      (parts.exchange ? '<em>' + esc(parts.exchange) + '</em>' : '') + '</span>' +
      (assigned.length ? '<span class="wl-folders" aria-label="Also in: ' + esc(names) + '">' + shown + more + '</span>' : '<span class="wl-folders"></span>') +
      '</a></li>';
  }

  function renderPins(active) {
    var marked = W.ordered(state).filter(function (f) { return f.bookmark; });
    pins.hidden = !marked.length;
    pins.innerHTML = marked.map(function (f) {
      var on = active && f.id === active.id;
      return '<button type="button" class="wl-pin' + (on ? ' is-active' : '') + '" data-folder="' + esc(f.id) + '"' +
        ' aria-pressed="' + on + '" style="--wl-c:' + W.colorHex(f.bookmark) + '">' +
        W.flagSvg(f.bookmark, 11) + '<span>' + esc(f.name) + '</span></button>';
    }).join('');
  }

  function renderMenu(active) {
    var folders = W.ordered(state);
    var marked = folders.filter(function (f) { return f.bookmark; });
    var plain = folders.filter(function (f) { return !f.bookmark; });
    function item(f) {
      var on = active && f.id === active.id;
      return '<button type="button" role="menuitemradio" class="wl-menu-item" aria-checked="' + on + '" data-folder="' + esc(f.id) + '" tabindex="-1">' +
        (f.bookmark ? W.flagSvg(f.bookmark, 12) : '<span class="wl-menu-noflag" aria-hidden="true"></span>') +
        '<span class="wl-menu-name">' + esc(f.name) + '</span>' +
        '<span class="wl-menu-count">' + W.symbolsOf(f).length + '</span></button>';
    }
    var html = '';
    if (marked.length) html += '<div class="wl-menu-group" role="presentation">Bookmarked</div>' + marked.map(item).join('');
    if (plain.length) html += '<div class="wl-menu-group" role="presentation">' + (marked.length ? 'Watchlists' : 'All watchlists') + '</div>' + plain.map(item).join('');
    if (!folders.length) html += '<div class="wl-menu-group" role="presentation">No watchlists yet</div>';
    html += '<a class="wl-menu-manage" role="menuitem" tabindex="-1" href="' + settingsHref(active) + '">Manage watchlists in Settings</a>';
    menu.innerHTML = html;
  }

  function render() {
    var active = W.activeFolder(state);
    titleName.textContent = active ? active.name : 'Watchlist';
    titleFlag.innerHTML = active && active.bookmark ? W.flagSvg(active.bookmark, 13) : '';
    var n = active ? W.symbolsOf(active).length : 0;
    count.textContent = active ? n + (n === 1 ? ' symbol' : ' symbols') : '';
    addLink.href = settingsHref(active);
    renderPins(active);
    renderMenu(active);
    renderRows(active);
  }

  function choose(id) {
    state = W.write(W.setActive(state, id));
  }

  /* ── Watchlist menu ── */
  function menuItems() { return Array.prototype.slice.call(menu.querySelectorAll('[role^="menuitem"]')); }

  function openMenu() {
    menu.hidden = false;
    titleBtn.setAttribute('aria-expanded', 'true');
    var items = menuItems();
    var current = menu.querySelector('[aria-checked="true"]') || items[0];
    if (current) current.focus();
    document.addEventListener('pointerdown', onOutside, true);
  }

  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    titleBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) titleBtn.focus();
  }

  function onOutside(e) {
    if (!card.querySelector('.wl-switch').contains(e.target)) closeMenu(false);
  }

  titleBtn.addEventListener('click', function () {
    if (menu.hidden) openMenu(); else closeMenu(true);
  });
  titleBtn.addEventListener('keydown', function (e) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) { e.preventDefault(); openMenu(); }
  });

  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-folder]');
    if (!btn) return;
    closeMenu(true);
    choose(btn.getAttribute('data-folder'));
  });

  menu.addEventListener('keydown', function (e) {
    var items = menuItems();
    var i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });

  list.addEventListener('click', function (e) {
    var btn = e.target.closest('.wl-section');
    if (!btn) return;
    var folder = W.activeFolder(state);
    if (!folder) return;
    var open = btn.getAttribute('aria-expanded') === 'true';
    var group = btn.parentNode;
    setCollapsed(folder, btn.getAttribute('data-section'), open);
    btn.setAttribute('aria-expanded', String(!open));
    group.classList.toggle('is-collapsed', open);
    group.querySelector('.wl-group-rows').hidden = open;
  });

  pins.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-folder]');
    if (btn) choose(btn.getAttribute('data-folder'));
  });

  W.subscribe(function (next) {
    state = next;
    var wasOpen = !menu.hidden;
    render();
    if (wasOpen) closeMenu(false);
  });

  render();
})();
