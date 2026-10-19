/* Decorative X Intelligence backgrounds. A visual skin is derived from a
   template's stable id (or its displayed name for admin-created templates).
   It never creates templates or changes accounts, persistence or feed requests. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XIntelligencePatterns = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function keyOf(value) {
    return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function patternForTemplate(template) {
    var id = keyOf(template && template.id);
    var name = keyOf(template && template.name);

    // The default template uses "markets" as its id, not its display name.
    if (id === "markets" || name === "crypto & stocks" || name === "crypto and stocks") return "markets";
    if (id === "war" || name === "war") return "war";
    if (id === "conspiracy" || name === "conspiracy") return "conspiracy";
    if (id === "positivity" || name === "positivity") return "positivity";
    return null; // All other templates retain their existing dashboard look.
  }

  function apply(element, template) {
    if (!element) return null;
    var pattern = patternForTemplate(template);
    if (pattern) element.setAttribute("data-x-pattern", pattern);
    else element.removeAttribute("data-x-pattern");
    return pattern;
  }

  return { patternForTemplate: patternForTemplate, apply: apply };
});
