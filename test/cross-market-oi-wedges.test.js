"use strict";

// Zero-split wedges on the Cross-Market OI radar: each neighbour pair is
// filled between the zero band and the joining line, by the sign of OI change
// alone, split exactly where the line crosses zero, including last → first.
const test = require("node:test");
const assert = require("node:assert");

const { buildWedges } = require("../public/assets/js/oi-wedges");

const SCALE = 25;
// Same mapping as the page: −scale at the centre, 0 halfway, +scale outside.
const frac = (v, scale = SCALE) => (Math.max(-scale, Math.min(scale, v)) + scale) / (2 * scale);
const ZF = frac(0);

function axes(values, scale = SCALE) {
  const n = values.length;
  return values.map((v, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const at = (f) => [Math.cos(a) * f, Math.sin(a) * f];
    return {
      value: v,
      point: v == null ? null : at(frac(v, scale)),
      zero: at(frac(0, scale)),
      offset: v == null ? null : frac(v, scale) - frac(0, scale),
    };
  });
}

function directions(wedges) {
  return wedges.map((w) => w.direction);
}

/** Distance from p to the infinite line through a and b. */
function distToLine(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy);
}

/** Every wedge's vertices are on its own side of the zero baseline. */
function assertSides(values, wedges) {
  const ax = axes(values);
  for (const w of wedges) {
    const zi = ax[w.from].zero;
    const zj = ax[w.to].zero;
    // Signed side relative to the baseline chord; the centre is "down".
    const side = (p) => (zj[0] - zi[0]) * (p[1] - zi[1]) - (zj[1] - zi[1]) * (p[0] - zi[0]);
    const centre = Math.sign(side([0, 0]));
    for (const p of w.points) {
      const s = Math.sign(side(p)) * centre; // > 0: centre side (below zero)
      if (Math.abs(side(p)) < 1e-9) continue; // on the baseline
      assert.equal(s > 0 ? "down" : "up", w.direction, `vertex on the wrong side in ${w.from}→${w.to}`);
    }
  }
}

test("all positive: every segment is an increase wedge, none cut below zero", () => {
  const values = [2, 2, 2, 2, 2, 2];
  const w = buildWedges(axes(values));
  assert.equal(w.length, 6);
  assert.ok(directions(w).every((d) => d === "up"));
  assertSides(values, w);
});

test("all negative: every segment is a decrease wedge", () => {
  const values = [-3, -10, -1, -7, -20, -5];
  const w = buildWedges(axes(values));
  assert.equal(w.length, 6);
  assert.ok(directions(w).every((d) => d === "down"));
  assertSides(values, w);
});

test("alternating: every segment splits into an increase and a decrease triangle", () => {
  const values = [5, -5, 12, -3, 8, -20];
  const w = buildWedges(axes(values));
  assert.equal(w.length, 12);
  assert.ok(w.every((x) => x.points.length === 3), "triangles");
  assertSides(values, w);
});

test("the A→B split lands on the zero baseline at t = a / (a − b)", () => {
  // The example from the spec: +15.22 next to −1.47.
  const values = [15.22, -1.47, 4, 4, 4, 4];
  const ax = axes(values);
  const w = buildWedges(ax).filter((x) => x.from === 0);
  assert.deepEqual(directions(w), ["up", "down"]);
  assert.ok(Math.abs(w[0].crossing - 15.22 / (15.22 + 1.47)) < 1e-12);
  const x = w[0].points[2];
  assert.deepEqual(w[1].points[0], x, "the two parts meet at the same point");
  assert.ok(distToLine(x, ax[0].zero, ax[1].zero) < 1e-12, "on the zero baseline");
  assert.ok(distToLine(x, ax[0].point, ax[1].point) < 1e-12, "on the joining line");
});

test("the last → first segment is split too", () => {
  const values = [-4, 3, 3, 3, 3, 9];
  const w = buildWedges(axes(values)).filter((x) => x.from === 5 && x.to === 0);
  assert.deepEqual(directions(w), ["up", "down"]);
});

test("one positive and five negative; five positive and one negative", () => {
  const one = [6, -2, -3, -4, -5, -6];
  const w1 = buildWedges(axes(one));
  assert.equal(w1.filter((x) => x.direction === "up").length, 2, "one triangle each side of the lone increase");
  assert.equal(w1.length, 8);
  assertSides(one, w1);
  const five = [6, 2, 3, 4, 5, -6];
  const w5 = buildWedges(axes(five));
  assert.equal(w5.filter((x) => x.direction === "down").length, 2);
  assert.equal(w5.length, 8);
  assertSides(five, w5);
});

test("exactly zero: no fill between zeros, and a zero next to an increase is not a decrease", () => {
  assert.deepEqual(buildWedges(axes([0, 0, 0, 0, 0, 0])), []);
  const w = buildWedges(axes([0, 5, 0, -5, 0, 0]));
  assert.deepEqual(directions(w), ["up", "up", "down", "down"]);
});

test("values on the ±scale rings and beyond the default scale", () => {
  const edge = [25, -25, 25, -25, 25, -25];
  const w = buildWedges(axes(edge));
  assert.equal(w.length, 12);
  assertSides(edge, w);
  // The page widens the scale when a value exceeds it; geometry follows.
  const wide = [60, -40, 10, 10, 10, 10];
  const ax = axes(wide, 100);
  const ww = buildWedges(ax).filter((x) => x.from === 0);
  assert.ok(Math.abs(ww[0].crossing - 60 / 100) < 1e-12);
  assert.ok(distToLine(ww[0].points[2], ax[0].zero, ax[1].zero) < 1e-12);
});

test("a missing market leaves both neighbouring segments unfilled — never filled as 0", () => {
  const w = buildWedges(axes([5, null, 5, 5, 5, 5]));
  assert.equal(w.length, 4);
  assert.ok(w.every((x) => x.from !== 1 && x.to !== 1));
});

test("drawing never changes the data it is given", () => {
  const values = [15.22, -1.47, 3, -8, 0, 25];
  const ax = axes(values);
  const before = JSON.stringify(ax);
  buildWedges(ax);
  assert.equal(JSON.stringify(ax), before);
  assert.deepEqual(buildWedges(axes([1, 2])), [], "fewer than three axes: no shape");
});

test("a straight-sided zero band is required: two small increases would dip under a curved ring", () => {
  // Why the zero band is drawn through the axes: the midpoint of the line
  // joining +2 and +2 on neighbouring axes sits inside a circular zero ring.
  const ax = axes([2, 2, 2, 2, 2, 2]);
  const mid = [(ax[0].point[0] + ax[1].point[0]) / 2, (ax[0].point[1] + ax[1].point[1]) / 2];
  assert.ok(Math.hypot(mid[0], mid[1]) < ZF, "inside the circular zero ring");
  assertSides([2, 2, 2, 2, 2, 2], buildWedges(ax));
});
