/* ── Reporter: Top 10 X Drafts ────────────────────────────
   Engagement X posts FarmBot wrote, with its own Grok settings, for the Top 10
   batch sent from Today's Top 10. Review each draft here (edit, approve or
   reject), then apply the approved ones: they become a new revision of the
   same FarmBot batch, which still needs approval in FarmBot before anything
   is queued or posted. Reads /api/daily-top-news/farmbot/x-drafts. */
(function () {
  'use strict';

  var root = document.getElementById('xDrafts');
  if (!root) return;

  var listEl = document.getElementById('xDraftsList');
  var statusEl = document.getElementById('xDraftsStatus');
  var metaEl = document.getElementById('xDraftsMeta');
  var refreshBtn = document.getElementById('xDraftsRefresh');
  var rewriteBtn = document.getElementById('xDraftsRewrite');
  var applyBtn = document.getElementById('xDraftsApply');

  var API = '/api/daily-top-news/farmbot/x-drafts';
  var MAX_CHARS = 280;
  var STATE_LABELS = { pending: 'To review', approved: 'Approved', rejected: 'Rejected', failed: 'No draft', applied: 'In FarmBot' };
  var DESK_LABELS = { economics: '🏦 Economics', stocks: '📈 Stocks', crypto: '₿ Crypto', general: 'General' };
  var set = null;
  var busy = false;
  var available = false;

  /* Today's Top 10 counts the day in this browser's time zone. */
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeHref(value) {
    return /^https:\/\//i.test(String(value || '')) ? String(value) : '';
  }

  function chars(text) {
    return Array.from(String(text || '')).length;
  }

  function setStatus(html, tone) {
    statusEl.innerHTML = html;
    statusEl.className = 'x-drafts-status' + (tone ? ' is-' + tone : '');
  }

  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    });
  }

  function post(path, body) {
    return window.AdminKey.fetchOrSession(API + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(readJson);
  }

  function counts() {
    var c = { pending: 0, approved: 0, rejected: 0, failed: 0, applied: 0 };
    (set ? set.items : []).forEach(function (item) { c[item.state] = (c[item.state] || 0) + 1; });
    return c;
  }

  function renderItem(item) {
    var locked = set.status === 'applied' || item.state === 'applied';
    var href = safeHref(item.url);
    var text = item.draft || '';
    var over = chars(text) > MAX_CHARS;
    return '<article class="x-draft" data-state="' + esc(item.state) + '" data-item="' + esc(item.itemId) + '">' +
      '<div class="news-log-meta"><strong>#' + esc(item.number) + '</strong>' +
        '<span>' + esc(DESK_LABELS[item.category] || item.category || '') + '</span>' +
        '<span class="news-log-status" data-status="' + esc(item.state) + '">' + esc(STATE_LABELS[item.state] || item.state) + '</span>' +
        (item.edited ? '<span>edited</span>' : '') + '</div>' +
      '<div class="news-log-headline">' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(item.headline || href) + '</a>' : esc(item.headline || '')) +
        (item.publisher ? ' <span class="news-log-farmbot">· ' + esc(item.publisher) + '</span>' : '') + '</div>' +
      '<div class="x-draft-original"><strong>Batch text now:</strong> ' + esc(item.original || '') + '</div>' +
      (item.error ? '<div class="x-draft-error">' + esc(item.error) + '</div>' : '') +
      '<textarea aria-label="X post for story ' + esc(item.number) + '" data-text' + (locked ? ' readonly' : '') + ' placeholder="Write your own post to approve this story">' + esc(text) + '</textarea>' +
      '<div class="x-draft-actions"><span class="x-draft-count' + (over ? ' is-over' : '') + '" data-count>' + chars(text) + ' / ' + MAX_CHARS + '</span>' +
        (locked ? '' :
          '<button type="button" class="news-log-refresh" data-decision="approved">Approve</button>' +
          '<button type="button" class="news-log-refresh" data-decision="rejected"' + (item.state === 'failed' ? ' disabled' : '') + '>Reject</button>' +
          (item.state === 'approved' || item.state === 'rejected' ? '<button type="button" class="news-log-refresh" data-decision="pending">Undo</button>' : '')) +
        '<button type="button" class="news-log-refresh" data-copy>Copy</button></div>' +
      '</article>';
  }

  function render() {
    rewriteBtn.hidden = !available;
    rewriteBtn.textContent = set ? 'Write drafts again' : 'Write drafts for today';
    rewriteBtn.disabled = busy;
    applyBtn.hidden = !set || set.status === 'applied';
    if (!set) {
      metaEl.textContent = '';
      listEl.innerHTML = '';
      return;
    }
    var c = counts();
    metaEl.textContent = set.date + ' · ' + [set.provider, set.model].filter(Boolean).join(' ') + (set.style ? ' · ' + set.style : '');
    applyBtn.disabled = busy || !c.approved;
    applyBtn.textContent = c.approved ? 'Apply ' + c.approved + ' approved to FarmBot' : 'Apply approved to FarmBot';
    listEl.innerHTML = set.items.map(renderItem).join('');
  }

  function summary() {
    var c = counts();
    if (set.status === 'applied') {
      return 'Applied to FarmBot batch <code>' + esc(set.clientBatchId) + '</code> as revision ' + esc(set.appliedRevision) +
        '. Approve it in FarmBot; nothing posts until you do. <a href="/top-news.html">Open Today&rsquo;s Top 10</a>';
    }
    return c.pending + ' to review · ' + c.approved + ' approved · ' + c.rejected + ' rejected' + (c.failed ? ' · ' + c.failed + ' without a draft' : '') +
      ' · batch <code>' + esc(set.clientBatchId) + '</code> revision ' + esc(set.revision) +
      '. Approved drafts replace those stories&rsquo; text in FarmBot; the rest keep the batch text.';
  }

  function load() {
    setStatus('Loading drafts…');
    return fetch(API, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(readJson)
      .then(function (data) {
        set = data.drafts;
        available = Boolean(data.available);
        render();
        if (!data.available) setStatus('X drafts are not set up on this server.', 'error');
        else if (!set) setStatus('No X drafts yet. They are written after <strong>Send to FarmBot</strong> on <a href="/top-news.html">Today&rsquo;s Top 10</a>.');
        else setStatus(summary(), set.status === 'applied' ? 'ok' : '');
      })
      .catch(function (err) { set = null; render(); setStatus('Could not load X drafts (' + esc(err.message) + ').', 'error'); });
  }

  function run(promise, doneMessage) {
    busy = true;
    render();
    return promise.then(function (data) {
      set = data.drafts || set;
      busy = false;
      render();
      setStatus(doneMessage ? doneMessage(data) : summary(), doneMessage ? 'ok' : '');
    }).catch(function (err) {
      busy = false;
      render();
      setStatus(esc(err.message || 'Something went wrong.'), 'error');
    });
  }

  listEl.addEventListener('input', function (event) {
    var area = event.target.closest('textarea[data-text]');
    if (!area) return;
    var count = area.closest('.x-draft').querySelector('[data-count]');
    var n = chars(area.value);
    count.textContent = n + ' / ' + MAX_CHARS;
    count.classList.toggle('is-over', n > MAX_CHARS);
  });

  listEl.addEventListener('click', function (event) {
    var card = event.target.closest('.x-draft');
    if (!card || !set || busy) return;
    var area = card.querySelector('textarea[data-text]');
    if (event.target.closest('[data-copy]')) {
      if (navigator.clipboard) navigator.clipboard.writeText(area.value);
      return;
    }
    var button = event.target.closest('[data-decision]');
    if (!button) return;
    var decision = button.getAttribute('data-decision');
    var body = { date: set.date, itemId: card.getAttribute('data-item'), decision: decision };
    if (decision === 'approved') body.text = area.value;
    run(post('/review', body));
  });

  rewriteBtn.addEventListener('click', function () {
    if (busy) return;
    if (!window.confirm(set ? 'Ask FarmBot to write all drafts again? This uses FarmBot’s AI credits and replaces your reviews.'
      : 'Ask FarmBot to write X drafts for today’s Top 10 batch? This uses FarmBot’s AI credits.')) return;
    setStatus('FarmBot is writing drafts with its Grok settings…');
    run(post('', { date: set ? set.date : today() }));
  });

  applyBtn.addEventListener('click', function () {
    if (!set || busy) return;
    var c = counts();
    if (!window.confirm('Put ' + c.approved + ' approved draft(s) into a new revision of the FarmBot batch? You still approve it in FarmBot before anything posts.')) return;
    setStatus('Sending the new revision to FarmBot…');
    run(post('/apply', { date: set.date }), function (data) {
      var link = data.slip && safeHref(data.slip.approvalUrl);
      return 'FarmBot saved revision ' + esc(set.appliedRevision) + ' with your approved posts. ' +
        (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">Open in FarmBot to approve →</a>' : 'Approve it in FarmBot.');
    });
  });

  refreshBtn.addEventListener('click', load);
  load();
})();
