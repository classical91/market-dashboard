/* Settings → Watchlists: create watchlists, add/remove/reorder tickers,
   group them under subtitles and bookmark watchlists with a colour.
   (Internally a watchlist is a "folder" and a subtitle a "section".) Saved in this browser (watchlists.js);
   the Overview v2 watchlist card updates live, even in another tab. */
(function () {
  'use strict';

  var W = window.Watchlists;
  var rootEl = document.getElementById('wlSettings');
  if (!W || !rootEl) return;

  var esc = W.escapeHtml;
  var folderList = document.getElementById('wlsFolderList');
  var newForm = document.getElementById('wlsNewFolder');
  var newInput = document.getElementById('wlsNewFolderName');
  var editor = document.getElementById('wlsEditor');
  var state = W.read();
  var note = { text: '', tone: '' };

  /* ?watchlist=<id> (from the Overview card's "+") opens that watchlist. */
  try {
    var wanted = new URLSearchParams(window.location.search).get('watchlist');
    if (wanted && W.findFolder(state, wanted)) state = W.write(W.setActive(state, wanted));
  } catch (err) {}

  function toast() { if (typeof window.showToast === 'function') window.showToast(); }

  var saving = false;

  function save(next, focusSelector) {
    saving = true;
    try { state = W.write(next); } finally { saving = false; }
    render();
    if (focusSelector) {
      var el = rootEl.querySelector(focusSelector);
      if (el) el.focus();
    }
  }

  function renderFolders(active) {
    var folders = W.ordered(state);
    folderList.innerHTML = folders.length ? folders.map(function (f) {
      var on = active && f.id === active.id;
      return '<li><button type="button" class="wls-folder' + (on ? ' is-active' : '') + '" data-folder="' + esc(f.id) + '" aria-current="' + (on ? 'true' : 'false') + '">' +
        (f.bookmark ? W.flagSvg(f.bookmark, 12) : '<span class="wl-menu-noflag" aria-hidden="true"></span>') +
        '<span class="wls-folder-name">' + esc(f.name) + '</span>' +
        '<span class="wls-folder-count">' + W.symbolsOf(f).length + '</span></button></li>';
    }).join('') : '<li class="wls-muted">No watchlists yet.</li>';
  }

  function renderEditor(folder) {
    if (!folder) {
      editor.innerHTML = '<p class="wls-muted">Create a watchlist to start saving tickers.</p>';
      return;
    }
    var swatches = '<label class="wls-swatch wls-swatch-none" title="No bookmark">' +
      '<input type="radio" name="wlsBookmark" value=""' + (folder.bookmark ? '' : ' checked') + ' />' +
      '<span aria-hidden="true">×</span><span class="wl-sr">No bookmark</span></label>' +
      W.COLORS.map(function (c) {
        return '<label class="wls-swatch" title="' + c.label + '" style="--wl-c:' + c.hex + '">' +
          '<input type="radio" name="wlsBookmark" value="' + c.id + '"' + (folder.bookmark === c.id ? ' checked' : '') + ' />' +
          W.flagSvg(c.id, 14) + '<span class="wl-sr">' + c.label + '</span></label>';
      }).join('');

    function moveButtons(entry, i, last) {
      return '<button type="button" class="wls-mini" data-act="up" aria-label="Move ' + esc(entry) + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="wls-mini" data-act="down" aria-label="Move ' + esc(entry) + ' down"' + (last ? ' disabled' : '') + '>↓</button>';
    }

    var symbolCount = W.symbolsOf(folder).length;
    var sectionCount = folder.tickers.length - symbolCount;

    var rows = folder.tickers.length ? folder.tickers.map(function (symbol, i) {
      var last = i === folder.tickers.length - 1;
      if (W.isSection(symbol)) {
        var name = W.sectionName(symbol);
        return '<li class="wls-ticker wls-section" data-symbol="' + esc(symbol) + '">' +
          '<span class="wls-section-mark" aria-hidden="true">§</span>' +
          '<input class="wls-section-name" type="text" maxlength="' + W.MAX_NAME + '" value="' + esc(name) + '" aria-label="Subtitle" autocomplete="off" />' +
          '<span class="wls-ticker-actions">' + moveButtons('subtitle ' + name, i, last) +
          '<button type="button" class="wls-mini wls-mini-danger" data-act="remove" aria-label="Remove subtitle ' + esc(name) + ' (its symbols stay)">×</button>' +
          '</span></li>';
      }
      var parts = W.tickerParts(symbol);
      var others = W.foldersFor(state, symbol).filter(function (f) { return f.id !== folder.id; });
      var also = others.length ? '<span class="wls-also">also in ' + others.map(function (f) { return esc(f.name); }).join(', ') + '</span>' : '';
      return '<li class="wls-ticker" data-symbol="' + esc(symbol) + '">' +
        '<span class="wl-icon" style="--wl-tint:' + W.iconTint(symbol) + '" aria-hidden="true">' + esc(parts.ticker.charAt(0)) + '</span>' +
        '<span class="wl-sym"><strong>' + esc(parts.ticker) + '</strong>' + (parts.exchange ? '<em>' + esc(parts.exchange) + '</em>' : '') + also + '</span>' +
        '<span class="wls-ticker-actions">' + moveButtons(symbol, i, last) +
        '<button type="button" class="wls-mini wls-mini-danger" data-act="remove" aria-label="Remove ' + esc(symbol) + '">×</button>' +
        '</span></li>';
    }).join('') : '<li class="wls-muted">No symbols in this watchlist yet.</li>';

    editor.innerHTML =
      '<div class="wls-field"><label for="wlsName">Watchlist name</label>' +
      '<input id="wlsName" type="text" maxlength="' + W.MAX_NAME + '" value="' + esc(folder.name) + '" autocomplete="off" /></div>' +
      '<fieldset class="wls-field wls-bookmarks"><legend>Bookmark <span>Bookmarked watchlists are pinned to the top</span></legend>' +
      '<div class="wls-swatches">' + swatches + '</div></fieldset>' +
      '<div class="wls-field"><div class="wls-label">Symbols <span>' + symbolCount +
      (sectionCount ? ' · ' + sectionCount + (sectionCount === 1 ? ' subtitle' : ' subtitles') : '') + '</span></div>' +
      '<ul class="wls-tickers">' + rows + '</ul>' +
      '<form class="wls-add" id="wlsAddForm">' +
      '<input id="wlsAddInput" type="text" placeholder="BINANCE:BTCUSDT, NASDAQ:AAPL" aria-label="Add symbols, separated by commas or spaces" autocomplete="off" spellcheck="false" />' +
      '<button class="settings-action-btn primary" type="submit">Add</button></form>' +
      '<form class="wls-add wls-add-section" id="wlsSectionForm">' +
      '<input id="wlsSectionInput" type="text" maxlength="' + W.MAX_NAME + '" placeholder="Subtitle, e.g. Majors" aria-label="New subtitle" autocomplete="off" />' +
      '<button class="settings-action-btn" type="submit">Add subtitle</button></form>' +
      '<p class="wls-note' + (note.tone ? ' is-' + note.tone : '') + '" id="wlsNote" role="status">' +
      esc(note.text || 'Use TradingView symbols — EXCHANGE:TICKER opens the right chart. Several at once is fine. Subtitles group the list: symbols you add next go under the last subtitle, and ↑ ↓ move rows between subtitles.') + '</p></div>' +
      '<div class="wls-danger-row">' +
      '<a class="settings-action-btn primary wls-back" href="/overview-v2.html#ov2-watchlist" title="Open Overview v2 with this watchlist selected">&larr; Back to Overview</a>' +
      '<button class="settings-action-btn danger" type="button" id="wlsDelete">Delete watchlist</button></div>';
  }

  function render() {
    var active = W.activeFolder(state);
    renderFolders(active);
    renderEditor(active);
  }

  /* ── Events (delegated, the editor re-renders after each change) ── */
  folderList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-folder]');
    if (!btn) return;
    note = { text: '', tone: '' };
    save(W.setActive(state, btn.getAttribute('data-folder')), '.wls-folder.is-active');
  });

  newForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var res = W.createFolder(state, newInput.value);
    if (res.error) { note = { text: res.error, tone: 'warn' }; render(); return; }
    newInput.value = '';
    note = { text: '', tone: '' };
    save(res.state, '#wlsAddInput');
    toast();
  });

  /* ── Starter watchlists: one click adds a ready-made list ── */
  var presetsEl = document.getElementById('wlsPresets');
  if (presetsEl && W.PRESETS) {
    presetsEl.insertAdjacentHTML('beforeend', W.PRESETS.map(function (p) {
      var n = p.tickers.filter(function (t) { return !W.isSection(t); }).length;
      return '<button type="button" class="wls-preset" data-preset="' + esc(p.id) + '">' +
        W.flagSvg(p.bookmark, 12) + '<span class="wls-folder-name">+ ' + esc(p.name) + '</span>' +
        '<span class="wls-folder-count">' + n + '</span></button>';
    }).join(''));
    presetsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-preset]');
      if (!btn) return;
      var res = W.addPreset(state, btn.getAttribute('data-preset'));
      if (res.error) { note = { text: res.error, tone: 'warn' }; render(); return; }
      note = res.existed
        ? { text: 'You already have a watchlist called ' + res.folder.name + ' — opened it instead.', tone: 'warn' }
        : { text: 'Added ' + res.folder.name + '. Edit, reorder or remove anything below.', tone: 'ok' };
      save(res.state, '.wls-folder.is-active');
      if (!res.existed) toast();
    });
  }

  editor.addEventListener('change', function (e) {
    var folder = W.activeFolder(state);
    if (!folder) return;
    if (e.target.id === 'wlsName') {
      save(W.renameFolder(state, folder.id, e.target.value));
      toast();
    } else if (e.target.classList.contains('wls-section-name')) {
      var section = e.target.closest('[data-symbol]').getAttribute('data-symbol');
      var res = W.renameSection(state, folder.id, section, e.target.value);
      if (res.error) { note = { text: res.error, tone: 'warn' }; render(); return; }
      note = { text: '', tone: '' };
      save(res.state);
      if (res.section !== section) toast();
    } else if (e.target.name === 'wlsBookmark') {
      save(W.setBookmark(state, folder.id, e.target.value || null), 'input[name="wlsBookmark"]:checked');
      toast();
    }
  });

  editor.addEventListener('keydown', function (e) {
    if ((e.target.id === 'wlsName' || e.target.classList.contains('wls-section-name')) && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  editor.addEventListener('submit', function (e) {
    if (e.target.id === 'wlsSectionForm') {
      e.preventDefault();
      var current = W.activeFolder(state);
      var field = document.getElementById('wlsSectionInput');
      if (!current) return;
      var made = W.addSection(state, current.id, field.value);
      if (made.error) {
        var typed = field.value;
        note = { text: made.error, tone: 'warn' };
        render();
        field = document.getElementById('wlsSectionInput');
        field.value = typed;
        field.focus();
        return;
      }
      note = { text: 'Added subtitle ' + W.sectionName(made.section) + '. Symbols you add now go under it.', tone: 'ok' };
      save(made.state, '#wlsAddInput');
      toast();
      return;
    }
    if (e.target.id !== 'wlsAddForm') return;
    e.preventDefault();
    var folder = W.activeFolder(state);
    var input = document.getElementById('wlsAddInput');
    if (!folder || !input.value.trim()) return;
    var res = W.addTickers(state, folder.id, input.value);
    var parts = [];
    if (res.added.length) parts.push('Added ' + res.added.join(', ') + '.');
    if (res.duplicate.length) parts.push('Already here: ' + res.duplicate.join(', ') + '.');
    if (res.invalid.length) parts.push('Not a valid symbol: ' + res.invalid.join(', ') + '.');
    if (res.full) parts.push('Watchlist is full (' + W.MAX_TICKERS + ' symbols).');
    note = { text: parts.join(' '), tone: res.invalid.length || res.full ? 'warn' : 'ok' };
    save(res.state, '#wlsAddInput');
    if (res.added.length) toast();
  });

  editor.addEventListener('click', function (e) {
    var folder = W.activeFolder(state);
    if (!folder) return;
    if (e.target.id === 'wlsDelete') {
      if (!window.confirm('Delete the watchlist "' + folder.name + '" and its ' + W.symbolsOf(folder).length + ' symbols?')) return;
      note = { text: '', tone: '' };
      save(W.deleteFolder(state, folder.id), '.wls-folder.is-active');
      toast();
      return;
    }
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var symbol = btn.closest('[data-symbol]').getAttribute('data-symbol');
    var act = btn.getAttribute('data-act');
    var sel = '[data-symbol="' + symbol.replace(/["\\]/g, '\\$&') + '"] [data-act="' + act + '"]';
    note = { text: '', tone: '' };
    if (act === 'up') save(W.moveTicker(state, folder.id, symbol, -1), sel);
    else if (act === 'down') save(W.moveTicker(state, folder.id, symbol, 1), sel);
    else if (act === 'remove') {
      var i = folder.tickers.indexOf(symbol);
      var next = W.removeTicker(state, folder.id, symbol);
      var after = W.findFolder(next, folder.id).tickers;
      var focusSym = after[Math.min(i, after.length - 1)];
      save(next, focusSym ? '[data-symbol="' + focusSym.replace(/["\\]/g, '\\$&') + '"] [data-act="remove"]' : '#wlsAddInput');
      toast();
    }
  });

  W.subscribe(function (next) {
    if (saving) return;
    /* Another tab saved; re-render unless the user is typing here. */
    if (rootEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { state = next; return; }
    state = next;
    render();
  });

  render();
})();
