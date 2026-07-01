(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function badge(label, tone) {
    return '<span class="ui-badge ui-badge--' + escapeHtml(tone || "neutral") + '">' + escapeHtml(label) + "</span>";
  }

  function emptyState(title, detail) {
    return (
      '<div class="ui-empty-state">' +
      '<div class="ui-empty-title">' + escapeHtml(title || "No data available") + "</div>" +
      (detail ? '<div class="ui-empty-detail">' + escapeHtml(detail) + "</div>" : "") +
      "</div>"
    );
  }

  function errorState(title, detail) {
    return (
      '<div class="ui-error-state" role="status">' +
      '<div class="ui-error-title">' + escapeHtml(title || "Something went wrong") + "</div>" +
      (detail ? '<div class="ui-error-detail">' + escapeHtml(detail) + "</div>" : "") +
      "</div>"
    );
  }

  function skeletonLine(width) {
    var style = width ? ' style="width:' + escapeHtml(width) + '"' : "";
    return '<span class="ui-skeleton-line"' + style + "></span>";
  }

  function skeletonCard(lines) {
    var count = Number(lines) || 3;
    return (
      '<article class="card ui-skeleton-card" aria-busy="true">' +
      Array.from({ length: count })
        .map(function (_, index) {
          return skeletonLine(index === 0 ? "46%" : index === count - 1 ? "62%" : "82%");
        })
        .join("") +
      "</article>"
    );
  }

  window.MarketUI = {
    badge: badge,
    emptyState: emptyState,
    errorState: errorState,
    escapeHtml: escapeHtml,
    skeletonCard: skeletonCard,
    skeletonLine: skeletonLine,
  };
})();
