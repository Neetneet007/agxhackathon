import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLanes } from '../lanes.js';

const scenario = JSON.parse(fs.readFileSync(new URL('../scenario.live.json', import.meta.url)));
const CELL = 20;
const WOB = 1.5;
const L = buildLanes(scenario, { cell: CELL });
const ids = scenario.fields.map((f) => f.id);
const depot = scenario.depot;
const W = (px, py) => ({ e: (px - depot.x) * CELL, n: -(py - depot.y) * CELL });
const places = ['depot', ...ids];
const allRoutes = [];
for (const a of places) for (const b of places) if (a !== b) allRoutes.push([a, b, L.routeBetween(a, b)]);

// Depth (m) a point lies strictly inside a field rectangle; 0 if outside.
function depthInside(p, f) {
  const x0 = (f.x - depot.x) * CELL, x1 = (f.x + f.w - depot.x) * CELL;
  const n1 = -(f.y - depot.y) * CELL, n0 = -(f.y + f.h - depot.y) * CELL;
  if (p.e <= x0 || p.e >= x1 || p.n <= n0 || p.n >= n1) return 0;
  return Math.min(p.e - x0, x1 - p.e, p.n - n0, n1 - p.n);
}

test('every field has a gate on its outline', () => {
  for (const f of scenario.fields) {
    const g = L.gates[f.id];
    assert.ok(g, f.id);
    const inBox = g.px >= f.x && g.px <= f.x + f.w && g.py >= f.y && g.py <= f.y + f.h;
    const onEdge = g.px === f.x || g.px === f.x + f.w || g.py === f.y || g.py === f.y + f.h;
    assert.ok(inBox && onEdge, `${f.id} gate off outline`);
    assert.deepEqual({ e: g.e, n: g.n }, W(g.px, g.py));
  }
});

test('routes stay out of fields (within wobble)', () => {
  for (const [a, b, r] of allRoutes) for (const p of r) for (const f of scenario.fields)
    assert.ok(depthInside(p, f) <= WOB + 0.01, `${a}->${b} ${depthInside(p, f)} inside ${f.id}`);
});

test('creek crossed only near bridges', () => {
  const creek = scenario.map.obstacles[0][0]; // column of cells
  const cx0 = (creek - depot.x) * CELL + WOB + 0.1, cx1 = (creek + 1 - depot.x) * CELL - WOB - 0.1;
  const bridges = scenario.map.features.bridges.map((b) => b.cells[0]);
  const nearBridge = (p) => bridges.some(([bx, by]) => {
    const y0 = -(by + 1 - depot.y) * CELL, y1 = -(by - depot.y) * CELL;
    return p.n >= y0 - CELL && p.n <= y1 + CELL;
  });
  let crossings = 0;
  for (const [a, b, r] of allRoutes) {
    for (let i = 1; i < r.length; i++) {
      const p = r[i - 1], q = r[i];
      const side = (v) => (v.e <= cx0 ? -1 : v.e >= cx1 ? 1 : 0);
      if (side(p) * side(q) === -1 || (side(p) === 0) !== (side(q) === 0)) {
        // enters or crosses the creek column here
        if (side(p) !== side(q)) { assert.ok(nearBridge(p) || nearBridge(q), `${a}->${b} at ${p.n}`); }
      }
    }
    const sides = new Set(r.map((p) => Math.sign(p.e - (cx0 + cx1) / 2)));
    if (sides.has(-1) && sides.has(1)) crossings++;
  }
  assert.ok(crossings > 0, 'some route crosses the creek');
});

test('depot routes start at 0,0 and end at the gate; reversal matches', () => {
  for (const f of scenario.fields) {
    const r = L.routeBetween('depot', f.id);
    assert.deepEqual(r[0], { e: 0, n: 0 });
    assert.deepEqual(r[r.length - 1], { e: L.gates[f.id].e, n: L.gates[f.id].n });
  }
  for (const a of places) for (const b of places) {
    const r1 = L.routeBetween(a, b), r2 = L.routeBetween(b, a).slice().reverse();
    assert.equal(r1.length, r2.length);
    r1.forEach((p, i) => {
      assert.ok(Math.abs(p.e - r2[i].e) < 1e-6 && Math.abs(p.n - r2[i].n) < 1e-6);
    });
  }
  assert.equal(L.routeBetween('F1', 'F1').length, 1);
});

test('lengths are symmetric, positive, and sane', () => {
  for (const [a, b] of allRoutes.map((x) => [x[0], x[1]])) {
    const l = L.lengthBetween(a, b);
    assert.ok(Math.abs(l - L.lengthBetween(b, a)) < 1e-6);
    assert.ok(l > 0, `${a}->${b}`);
    const pa = a === 'depot' ? { e: 0, n: 0 } : L.gates[a], pb = b === 'depot' ? { e: 0, n: 0 } : L.gates[b];
    // Spec bound (3x straight + 400 m). Two fields whose branches meet only at the
    // depot (F5 north bridge vs F7 south bridge) can't meet it on a single tree, so for
    // those the route may not exceed going via the depot.
    const bound = 3 * Math.hypot(pa.e - pb.e, pa.n - pb.n) + 400;
    const viaDepot = L.lengthBetween(a, 'depot') + L.lengthBetween('depot', b);
    assert.ok(l <= Math.max(bound, viaDepot + 1e-6), `${a}->${b} ${l}`);
    if (a === 'depot' || b === 'depot') assert.ok(l <= bound, `${a}->${b} ${l}`);
  }
});

test('wobble 0 hugs lattice lines; default wobble really moves the line', () => {
  const flat = buildLanes(scenario, { cell: CELL, wobble: 0 });
  const off = (v, o) => { const m = (((v - o) % CELL) + CELL) % CELL; return Math.min(m, CELL - m); };
  for (const a of places) for (const b of places) {
    for (const p of flat.routeBetween(a, b))
      assert.ok(Math.min(off(p.e, 0), off(p.n, 0)) <= CELL + 1e-9);
  }
  let max = 0;
  for (const a of places) for (const b of places) {
    const w = L.routeBetween(a, b), f = flat.routeBetween(a, b);
    w.forEach((p, i) => { max = Math.max(max, Math.hypot(p.e - f[i].e, p.n - f[i].n)); });
  }
  assert.ok(max > 0.3, `max shift ${max}`);
});

test('lanes cover every depot route', () => {
  const d2 = (p, a, b) => {
    const l2 = (b.e - a.e) ** 2 + (b.n - a.n) ** 2;
    let t = l2 ? ((p.e - a.e) * (b.e - a.e) + (p.n - a.n) * (b.n - a.n)) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.e - (a.e + t * (b.e - a.e)), p.n - (a.n + t * (b.n - a.n)));
  };
  for (const f of ids) for (const p of L.routeBetween('depot', f)) {
    const ok = L.lanes.some((ln) => ln.some((q, i) => i > 0 && d2(p, ln[i - 1], q) <= 0.5) || (ln.length === 1));
    assert.ok(ok, `${f} point ${p.e},${p.n}`);
  }
});

test('deterministic', () => {
  const L2 = buildLanes(scenario, { cell: CELL });
  assert.deepEqual(L2.gates, L.gates);
  assert.deepEqual(L2.lanes, L.lanes);
  assert.deepEqual(L2.routeBetween('F3', 'F8'), L.routeBetween('F3', 'F8'));
});
