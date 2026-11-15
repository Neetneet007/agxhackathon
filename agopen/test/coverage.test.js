import test from 'node:test';
import assert from 'node:assert/strict';
import { planCoverage, coverageOf, routeProgress } from '../coverage.js';

const rect = (w = 200, h = 120) => [
  { e: 0, n: 0 }, { e: w, n: 0 }, { e: w, n: h }, { e: 0, n: h },
];
const rot = (p, deg) => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return { e: p.e * c - p.n * s, n: p.e * s + p.n * c };
};
// AB along the long side, 15 m in from the south edge.
const ab = { a: { e: 0, n: 15 }, b: { e: 200, n: 15 } };
const rotAb = deg => ({ a: rot(ab.a, deg), b: rot(ab.b, deg) });

const distToBoundary = (p, poly) => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const de = b.e - a.e, dn = b.n - a.n;
    const t = Math.max(0, Math.min(1, ((p.e - a.e) * de + (p.n - a.n) * dn) / (de * de + dn * dn)));
    best = Math.min(best, Math.hypot(p.e - a.e - de * t, p.n - a.n - dn * t));
  }
  return best;
};
const inside = (p, poly) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.n > p.n) !== (b.n > p.n) && p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) r = !r;
  }
  return r;
};

for (const width of [24, 12, 9, 8]) {
  test(`rectangle covered at width ${width}`, () => {
    const plan = planCoverage({ boundary: rect(), abLine: ab, width });
    console.log(`rect width ${width}: ${plan.coveredPct.toFixed(2)}% route ${plan.lengthM.toFixed(0)} m work ${plan.workLengthM.toFixed(0)} m`);
    assert.ok(plan.coveredPct >= 99.5, String(plan.coveredPct));
  });
}

test('rotated rectangle covered', () => {
  const boundary = rect().map(p => rot(p, 30));
  const plan = planCoverage({ boundary, abLine: rotAb(30), width: 12 });
  console.log(`rotated: ${plan.coveredPct.toFixed(2)}%`);
  assert.ok(plan.coveredPct >= 99.5, String(plan.coveredPct));
});

test('convex trapezoid covered', () => {
  const boundary = [{ e: 0, n: 0 }, { e: 200, n: 0 }, { e: 160, n: 120 }, { e: 30, n: 120 }];
  const plan = planCoverage({ boundary, abLine: { a: { e: 0, n: 15 }, b: { e: 200, n: 15 } }, width: 12 });
  console.log(`trapezoid: ${plan.coveredPct.toFixed(2)}%`);
  assert.ok(plan.coveredPct >= 98, String(plan.coveredPct));
});

test('AB line outside the field still works', () => {
  const plan = planCoverage({ boundary: rect(), abLine: { a: { e: -50, n: -300 }, b: { e: 250, n: -280 } }, width: 12 });
  assert.ok(plan.coveredPct >= 98, String(plan.coveredPct));
});

test('passes are parallel to AB and exactly width apart', () => {
  const width = 12, theta = 30;
  const plan = planCoverage({ boundary: rect().map(p => rot(p, theta)), abLine: rotAb(theta), width });
  const L = rotAb(theta);
  const len = Math.hypot(L.b.e - L.a.e, L.b.n - L.a.n);
  const u = { e: (L.b.e - L.a.e) / len, n: (L.b.n - L.a.n) / len };
  const offs = plan.swaths.map(s => {
    assert.ok(Math.abs((s.b.e - s.a.e) * -u.n + (s.b.n - s.a.n) * u.e) < 1e-6, 'parallel');
    return (s.a.e - L.a.e) * -u.n + (s.a.n - L.a.n) * u.e;
  });
  assert.ok(offs.length > 3);
  for (let i = 1; i < offs.length; i++) assert.ok(Math.abs(Math.abs(offs[i] - offs[i - 1]) - width) < 1e-6);
  for (const o of offs) assert.ok(Math.abs(o / width - Math.round(o / width)) < 1e-6, 'snapped to AB multiples');
});

test('waypoints inside boundary or within 0.5 m', () => {
  const boundary = rect();
  for (const hp of [1, 2]) {
    const plan = planCoverage({ boundary, abLine: ab, width: 9, headlandPasses: hp });
    for (const p of plan.route) assert.ok(inside(p, boundary) || distToBoundary(p, boundary) <= 0.5, JSON.stringify(p));
  }
});

test('direction alternates pass to pass', () => {
  const plan = planCoverage({ boundary: rect(), abLine: ab, width: 12 });
  const dirs = plan.swaths.map(s => Math.sign(s.b.e - s.a.e));
  assert.ok(dirs.every(d => d !== 0));
  for (let i = 1; i < dirs.length; i++) assert.equal(dirs[i], -dirs[i - 1]);
});

test('start picks the nearest pass end', () => {
  const plan = planCoverage({ boundary: rect(), abLine: ab, width: 12, start: { e: 200, n: 130 } });
  const f = plan.swaths[0].a;
  assert.ok(f.n > 100 && f.e > 150, JSON.stringify(f));
});

test('work length and progress', () => {
  const plan = planCoverage({ boundary: rect(), abLine: ab, width: 12 });
  assert.ok(plan.workLengthM > 0);
  assert.equal(routeProgress(plan, 0).fractionWorked, 0);
  assert.ok(Math.abs(routeProgress(plan, plan.lengthM).fractionWorked - 1) < 1e-9);
  let prev = 0;
  for (let d = 0; d <= plan.lengthM; d += 5) {
    const f = routeProgress(plan, d).fractionWorked;
    assert.ok(f >= prev); prev = f;
  }
});

test('two headland laps still cover', () => {
  const plan = planCoverage({ boundary: rect(), abLine: ab, width: 12, headlandPasses: 2 });
  console.log(`2 laps: ${plan.coveredPct.toFixed(2)}%`);
  assert.equal(plan.headland.length, 2);
  assert.ok(plan.coveredPct >= 99.5, String(plan.coveredPct));
});

test('winding direction does not matter', () => {
  const ccw = rect(), cw = rect().reverse();
  const a = planCoverage({ boundary: ccw, abLine: ab, width: 12 });
  const b = planCoverage({ boundary: cw, abLine: ab, width: 12 });
  assert.ok(Math.abs(a.coveredPct - b.coveredPct) < 0.2);
  assert.ok(Math.abs(coverageOf(a, cw) - a.coveredPct) < 0.2);
});
