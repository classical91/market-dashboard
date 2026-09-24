/**
 * Zero-split wedges for the Cross-Market OI radar.
 *
 * Between each pair of adjacent axes (including last → first), the region
 * between the zero baseline and the line joining the two observations is
 * filled: "up" where OI increased, "down" where it decreased. When the two
 * observations have opposite signs the segment is split where it crosses
 * zero, so no single fill spans both regimes.
 *
 * Geometry: on axis i the observation is P_i and the zero point is Z_i, both
 * on the same ray. Z_i→Z_j is the zero baseline between the axes, P_i→P_j the
 * connecting line. The offset between them varies linearly along the segment,
 * so the two lines meet at t = d_i / (d_i − d_j), where d is each point's
 * radial offset from zero. That point X is on both lines: the positive part
 * ends and the negative part begins exactly on the baseline.
 *
 * Classification is by the value's sign alone (> 0 increase, < 0 decrease).
 * Nothing here reads price, so nothing here is bullish or bearish.
 *
 * The wedges are drawing only: values, dates and scale are never changed.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OiWedges = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  /**
   * axes: [{ value, point: [x, y] | null, zero: [x, y], offset }] in slot
   * order. `offset` is the observation's radial distance from zero in plot
   * units (same sign as value). A missing value (null point/value) leaves the
   * segments on either side of it unfilled — never filled as if 0.
   *
   * Returns [{ direction: "up" | "down", from, to, points: [[x, y], …] }].
   */
  function buildWedges(axes) {
    var n = axes.length;
    var out = [];
    if (n < 3) return out;
    for (var i = 0; i < n; i += 1) {
      var j = (i + 1) % n;
      var a = axes[i];
      var b = axes[j];
      if (!a.point || !b.point || !isNum(a.value) || !isNum(b.value)) continue;
      var sa = sign(a.value);
      var sb = sign(b.value);
      if (sa === 0 && sb === 0) continue;
      if (sa >= 0 && sb >= 0) {
        out.push({ direction: "up", from: i, to: j, points: [a.zero, a.point, b.point, b.zero] });
      } else if (sa <= 0 && sb <= 0) {
        out.push({ direction: "down", from: i, to: j, points: [a.zero, a.point, b.point, b.zero] });
      } else {
        // Opposite signs: split where the connecting line crosses zero.
        var t = a.offset / (a.offset - b.offset);
        var x = lerp(a.point, b.point, t);
        out.push({ direction: sa > 0 ? "up" : "down", from: i, to: j, crossing: t, points: [a.zero, a.point, x] });
        out.push({ direction: sb > 0 ? "up" : "down", from: i, to: j, crossing: t, points: [x, b.point, b.zero] });
      }
    }
    return out;
  }

  return { buildWedges: buildWedges };
});
