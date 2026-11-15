// lanes.js - a lane network for the simulated farm.
//
// Tractors used to drive straight from the depot to a field, cutting across
// other fields. Here we lay out lanes along the lattice of cell CORNERS
// (the lines between cells), pick a gate on every field, and route along one
// shared network, like a real farm with a main lane and branches.
//
// Coordinates: lattice point (px, py), px 0..width, py 0..height. World metres:
//   e = (px - depot.x) * cell,  n = -(py - depot.y) * cell   (north is up).

/**
 * Build the lane network.
 * @param scenario  parsed scenario JSON (map, depot, fields)
 * @param opts      cell = metres per cell, wobble = max sideways meander (m)
 * @returns { gates, lanes, routeBetween(from,to), lengthBetween(from,to) }
 */
export function buildLanes(scenario, { cell = 20, wobble = 1.5 } = {}) {
  const W = scenario.map.width;
  const H = scenario.map.height;
  const depot = scenario.depot;
  const fields = scenario.fields;
  const key = (px, py) => py * (W + 1) + px;
  const unkey = (k) => [k % (W + 1), Math.floor(k / (W + 1))];

  // ---- Creek: obstacle cells cannot be crossed except along bridge rows. ----
  // A step east-west between px=cx and px=cx+1 crosses obstacle cell (cx, cy)
  // when it runs along row py=cy or py=cy+1 (the two lattice rows that bound
  // that cell). It is allowed only if that row also bounds a bridge cell in the
  // same column, i.e. the row is cy' or cy'+1 for a bridge cell (cx, cy').
  // Rows bounding an obstacle cell and not a bridge cell are blocked. Rows
  // touching no obstacle cell at all (open ground) are free.
  const obst = new Set((scenario.map.obstacles || []).map(([x, y]) => x + ',' + y));
  const bridgeRows = new Set(); // "cx,py"
  for (const b of scenario.map.features?.bridges || []) {
    for (const [bx, by] of b.cells) {
      bridgeRows.add(bx + ',' + by);
      bridgeRows.add(bx + ',' + (by + 1));
    }
  }
  function creekBlocks(cx, py) {
    // step from (cx,py) to (cx+1,py)
    const touches = obst.has(cx + ',' + py) || obst.has(cx + ',' + (py - 1));
    if (!touches) return false;
    return !bridgeRows.has(cx + ',' + py);
  }

  // ---- Fields: a step is forbidden if its midpoint is strictly inside one. ----
  function insideField(mx, my) {
    for (const f of fields) {
      if (mx > f.x && mx < f.x + f.w && my > f.y && my < f.y + f.h) return true;
    }
    return false;
  }
  function stepAllowed(ax, ay, bx, by) {
    if (bx < 0 || by < 0 || bx > W || by > H) return false;
    if (insideField((ax + bx) / 2, (ay + by) / 2)) return false;
    if (ay === by) {
      const cx = Math.min(ax, bx);
      if (creekBlocks(cx, ay)) return false;
    }
    return true;
  }

  // ---- Breadth-first shortest-path tree from the depot (fixed neighbour order). ----
  const DIRS = [[0, -1], [-1, 0], [1, 0], [0, 1]]; // N, W, E, S
  const dist = new Map();
  const parent = new Map();
  const start = key(depot.x, depot.y);
  dist.set(start, 0);
  parent.set(start, -1);
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    const [px, py] = unkey(k);
    for (const [dx, dy] of DIRS) {
      const nx = px + dx, ny = py + dy;
      if (!stepAllowed(px, py, nx, ny)) continue;
      const nk = key(nx, ny);
      if (dist.has(nk)) continue;
      dist.set(nk, dist.get(k) + 1);
      parent.set(nk, k);
      queue.push(nk);
    }
  }

  const toWorld = (px, py) => ({ e: (px - depot.x) * cell, n: -(py - depot.y) * cell + 0 });

  // ---- Gates: closest reachable outline point; scan order top row left->right, ----
  // then down the right side, bottom row right->left, up the left side. First wins ties.
  function outline(f) {
    const pts = [];
    for (let x = f.x; x <= f.x + f.w; x++) pts.push([x, f.y]);
    for (let y = f.y + 1; y <= f.y + f.h; y++) pts.push([f.x + f.w, y]);
    for (let x = f.x + f.w - 1; x >= f.x; x--) pts.push([x, f.y + f.h]);
    for (let y = f.y + f.h - 1; y > f.y; y--) pts.push([f.x, y]);
    return pts;
  }
  const gates = {};
  const gateKey = {};
  const laneSteps = {}; // fieldId -> lattice steps from depot
  for (const f of fields) {
    let best = null, bestD = Infinity;
    for (const [px, py] of outline(f)) {
      const d = dist.get(key(px, py));
      if (d !== undefined && d < bestD) { bestD = d; best = [px, py]; }
    }
    if (best) {
      const w = toWorld(best[0], best[1]);
      gates[f.id] = { px: best[0], py: best[1], e: w.e, n: w.n };
      gateKey[f.id] = key(best[0], best[1]);
      laneSteps[f.id] = bestD;
    }
  }

  // Path of lattice keys from the depot to k.
  function treePath(k) {
    const p = [];
    for (let c = k; c !== -1; c = parent.get(c)) p.push(c);
    return p.reverse();
  }
  const pathCache = new Map();
  function pathTo(id) {
    if (id === 'depot') return [start];
    if (!(id in gateKey)) return null;
    if (!pathCache.has(id)) pathCache.set(id, treePath(gateKey[id]));
    return pathCache.get(id);
  }

  // ---- Smoothing ----
  // Chaikin corner cutting, two rounds, endpoints kept.
  function chaikin(pts) {
    for (let r = 0; r < 2; r++) {
      if (pts.length < 3) return pts;
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const q = { e: 0.75 * a.e + 0.25 * b.e, n: 0.75 * a.n + 0.25 * b.n };
        const s = { e: 0.25 * a.e + 0.75 * b.e, n: 0.25 * a.n + 0.75 * b.n };
        if (i > 0) out.push(q);
        if (i < pts.length - 2) out.push(s);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  // Deterministic wobble depending only on position, so shared stretches wobble
  // identically and direction does not matter. Smooth sines in e and n.
  function offsetAt(e, n) {
    return [
      Math.sin(e * 0.21 + n * 0.13 + 1.3) * 0.6 + Math.sin(e * 0.07 - n * 0.17 + 0.4) * 0.4,
      Math.sin(n * 0.19 - e * 0.11 + 2.1) * 0.6 + Math.sin(n * 0.08 + e * 0.15 + 0.9) * 0.4,
    ];
  }
  function wobbled(pts) {
    if (!wobble) return pts;
    return pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const [oe, on] = offsetAt(p.e, p.n);
      // |(oe,on)| <= sqrt(2) so scale to keep within `wobble` metres
      return { e: p.e + (oe * wobble) / Math.SQRT2, n: p.n + (on * wobble) / Math.SQRT2 };
    });
  }
  // Corner cutting can swing a curve a little into a field that the lane hugs.
  // Move any such point straight out to the nearest field edge (a function of
  // position only, so shared stretches stay identical).
  function pushOut(pts) {
    return pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const px = p.e / cell + depot.x, py = -p.n / cell + depot.y;
      for (const f of fields) {
        if (px > f.x && px < f.x + f.w && py > f.y && py < f.y + f.h) {
          const d = [px - f.x, f.x + f.w - px, py - f.y, f.y + f.h - py];
          const m = d.indexOf(Math.min(...d));
          if (m === 0) return { e: (f.x - depot.x) * cell, n: p.n };
          if (m === 1) return { e: (f.x + f.w - depot.x) * cell, n: p.n };
          if (m === 2) return { e: p.e, n: -(f.y - depot.y) * cell };
          return { e: p.e, n: -(f.y + f.h - depot.y) * cell };
        }
      }
      return p;
    });
  }
  // Smooth a run of lattice keys into a world polyline.
  function smooth(keys) {
    const raw = keys.map((k) => { const [px, py] = unkey(k); return toWorld(px, py); });
    return wobbled(pushOut(chaikin(raw)));
  }
  // ---- Routes ----
  // To make the same stretch of lane look identical in every route, smoothing
  // runs on fixed pieces: the tree is cut at its branching points and at
  // gates/depot, and each piece (between two such "nodes") is smoothed on its
  // own. A route is the concatenation of the pieces it uses.
  const childCount = new Map();
  const usedKeys = new Set();
  for (const id of Object.keys(gateKey)) {
    for (const k of pathTo(id)) usedKeys.add(k);
  }
  for (const k of usedKeys) {
    const p = parent.get(k);
    if (p !== -1) childCount.set(p, (childCount.get(p) || 0) + 1);
  }
  const nodeKeys = new Set([start, ...Object.values(gateKey)]);
  for (const [k, c] of childCount) if (c > 1) nodeKeys.add(k);

  // piece ending at node k (walking up to the previous node), as keys from upper node down to k
  const pieceCache = new Map();
  function pieceEndingAt(k) {
    if (pieceCache.has(k)) return pieceCache.get(k);
    const keys = [k];
    let c = parent.get(k);
    while (true) {
      keys.push(c);
      if (nodeKeys.has(c) || c === -1) break;
      c = parent.get(c);
    }
    keys.reverse();
    const pts = smooth(keys); // upper node -> k
    pieceCache.set(k, pts);
    return pts;
  }

  // Route from the depot to path (list of keys), as pieces.
  // Returns array of pieces (each a polyline running away from the depot) for the
  // path portion from node `fromNode` (an ancestor on the path) down to the end.
  function piecesAlong(path, fromIdx) {
    const pieces = [];
    for (let i = fromIdx + 1; i < path.length; i++) {
      if (nodeKeys.has(path[i])) pieces.push(pieceEndingAt(path[i]));
    }
    return pieces;
  }
  const joinPieces = (pieces) => {
    const out = [];
    for (const p of pieces) for (let i = out.length ? 1 : 0; i < p.length; i++) out.push(p[i]);
    return out;
  };

  function routeBetween(from, to) {
    const pa = pathTo(from), pb = pathTo(to);
    if (!pa || !pb) return null;
    // last shared point of the two tree paths
    let s = 0;
    while (s + 1 < pa.length && s + 1 < pb.length && pa[s + 1] === pb[s + 1]) s++;
    // The shared point may be mid-piece only if it is a branching point or an end,
    // and those are nodes, so the split falls on a piece boundary. If a path simply
    // ends inside the other (one gate on the way to another) that gate is a node too.
    const down = piecesAlong(pb, s);
    const up = piecesAlong(pa, s).reverse().map((p) => p.slice().reverse());
    const pts = joinPieces([...up, ...down]);
    if (pts.length === 0) return [toWorld(...unkey(pa[s]))];
    return pts.map((p) => ({ e: p.e, n: p.n }));
  }

  function lengthBetween(from, to) {
    const r = routeBetween(from, to);
    if (!r) return null;
    let L = 0;
    for (let i = 1; i < r.length; i++) L += Math.hypot(r[i].e - r[i - 1].e, r[i].n - r[i - 1].n);
    return L;
  }

  // ---- Lanes for drawing: every piece once. ----
  const lanes = [];
  for (const k of [...nodeKeys].sort((a, b) => a - b)) {
    if (k === start) continue;
    if (!usedKeys.has(k)) continue;
    lanes.push(pieceEndingAt(k).map((p) => ({ e: p.e, n: p.n })));
  }

  return { gates, lanes, routeBetween, lengthBetween, laneSteps };
}
