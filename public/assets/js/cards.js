/**
 * Render card grids from data arrays.
 * Each card: { badge, badgeColor, url, title, src }
 * badgeColor is a CSS variable name like "amber", "teal", etc.
 */
function renderCards(containerId, cards) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = cards.map(c => {
    const bg = `var(--${c.badgeColor}-bg)`;
    const fg = `var(--${c.badgeColor})`;
    return `<a class="card" href="${c.url}" target="_blank">
      <div class="card-top">
        <span class="badge" style="background:${bg};color:${fg}">${c.badge}</span>
        <span class="arrow">&#8599;</span>
      </div>
      <div class="card-title">${c.title}</div>
      <div class="card-src">${c.src}</div>
    </a>`;
  }).join('');
}

/**
 * Render all sections from a page config.
 * config: [{ id, label, cards: [...] }]
 * Inserts section headers + card grids into a target element.
 */
function renderPage(targetId, sections) {
  const target = document.getElementById(targetId);
  if (!target) return;

  let html = '';
  for (const s of sections) {
    html += `<div class="section-header" data-section="${s.id}">
      <span class="section-label section-label--accent">${s.label}</span>
      <span class="section-chevron section-chevron--accent">&#9660;</span>
    </div>
    <div class="cards" id="cards-${s.id}"></div>`;
  }
  target.innerHTML = html;

  for (const s of sections) {
    renderCards('cards-' + s.id, s.cards);
  }
}
