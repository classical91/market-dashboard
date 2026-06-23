/**
 * Collapsible sections with localStorage persistence.
 * Usage: initSections('mi_collapsed')
 */
function initSections(storeKey) {
  function getCollapsed() {
    try { return JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch { return []; }
  }
  function saveCollapsed(list) {
    localStorage.setItem(storeKey, JSON.stringify(list));
  }

  const stored = localStorage.getItem(storeKey);
  const headers = document.querySelectorAll('.section-header[data-section]');
  const allIds = Array.from(headers).map(h => h.dataset.section);
  const collapsed = stored ? JSON.parse(stored) : allIds;

  headers.forEach(header => {
    const id = header.dataset.section;
    const cards = document.getElementById('cards-' + id) || document.getElementById(id + '-cards') || document.getElementById(id);
    if (!cards) return;

    if (collapsed.includes(id)) {
      header.classList.add('collapsed');
      cards.classList.add('collapsed');
    }

    // "Open All" button — opens every link in this section in new tabs.
    const links = Array.from(cards.querySelectorAll('a[href]'));
    if (links.length) {
      const chevron = header.querySelector('.section-chevron');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'open-all-btn';
      btn.textContent = '⧉ Open All (' + links.length + ')';
      btn.setAttribute('aria-label', 'Open all ' + links.length + ' links in this section');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        links.forEach((a) => window.open(a.href, '_blank', 'noopener'));
      });
      if (chevron) header.insertBefore(btn, chevron);
      else header.appendChild(btn);
    }

    header.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isCollapsed = cards.classList.toggle('collapsed');
      header.classList.toggle('collapsed', isCollapsed);
      const list = getCollapsed();
      if (isCollapsed) { if (!list.includes(id)) list.push(id); }
      else { const i = list.indexOf(id); if (i > -1) list.splice(i, 1); }
      saveCollapsed(list);
    });
  });
}
