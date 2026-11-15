// Coverage planner: works a convex field the way a skilled operator would.
// Parallel passes one implement-width apart along the guidance (AB) line,
// turning in the headland at each end, then laps around the boundary.
//
// All coordinates are metres on a flat plane: { e, n } = east, north.

const EPS = 1e-9;
const MIN_PASS_M = 2; // a pass shorter than this is not worth driving

// ---------- small geometry helpers ----------

const dist = (p, q) => Math.hypot(p.e - q.e, p.n - q.n);

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    s += p.e * q.n - q.e * p.n;
  }
  return s / 2;
}

// Drop a repeated closing point and force counter-clockwise order, so every
// later step can assume "inside is to the left of each edge".
function normalisePolygon(boundary) {
  let pts = boundary.map(p => ({ e: p.e, n: p.n }));
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
  if (pts.length < 3) throw new Error('boundary needs at least 3 distinct points');
  if (signedArea(pts) < 0) pts.reverse();
  return pts;
}

// Move every edge inward by d and intersect neighbouring edges (convex only).
// Returns null once the field is too thin to inset that far (the polygon would
// collapse or flip inside out).
function insetPolygon(poly, d) {
  if (d <= 0) return poly.map(p => ({ ...p }));
  const m = poly.length;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % m];
    const len = dist(p, q);
    const de = (q.e - p.e) / len, dn = (q.n - p.n) / len;
    // left normal = inward for a counter-clockwise polygon
    return { pe: p.e - dn * d, pn: p.n + de * d, de, dn };
  });
  const out = [];
  for (let i = 0; i < m; i++) {
    const A = lines[(i + m - 1) % m], B = lines[i];
    const cross = A.de * B.dn - A.dn * B.de;
    if (Math.abs(cross) < 1e-12) { out.push({ e: B.pe, n: B.pn }); continue; } // collinear edges
    // A.p + A.d * s  ==  B.p + B.d * t
    const s = ((B.pe - A.pe) * B.dn - (B.pn - A.pn) * B.de) / cross;
    out.push({ e: A.pe + A.de * s, n: A.pn + A.dn * s });
  }
  if (signedArea(out) <= 1e-6) return null;
  // An edge that reversed direction means the offset edges crossed over.
  for (let i = 0; i < m; i++) {
    const a = out[i], b = out[(i + 1) % m];
    const l = lines[i];
    if ((b.e - a.e) * l.de + (b.n - a.n) * l.dn <= 0) return null;
  }
  return out;
}

// Clip the infinite line p0 + u*s against a convex CCW polygon.
// Returns [sLo, sHi] or null if the line misses it.
function clipLine(poly, p0, u) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ee = b.e - a.e, en = b.n - a.n;
    const c0 = ee * (p0.n - a.n) - en * (p0.e - a.e); // >= 0 means inside
    const c1 = ee * u.n - en * u.e;
    if (Math.abs(c1) < EPS) { if (c0 < 0) return null; continue; }
    const s = -c0 / c1;
    if (c1 > 0) lo = Math.max(lo, s); else hi = Math.min(hi, s);
  }
  return hi > lo + EPS ? [lo, hi] : null;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.n > p.n) !== (b.n > p.n) &&
        p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
  }
  return inside;
}

// Is point (px,py) inside the strip an implement of this width sweeps along
// the leg a->b? The strip is a rectangle that runs half a width past each end,
// because the implement itself is a full width wide when the tractor reaches a
// waypoint or swings round a corner. (Round ends would leave a small hole in
// every square corner of the headland.)
function inStrip(px, py, a, b, halfW) {
  const de = b.e - a.e, dn = b.n - a.n;
  const len = Math.hypot(de, dn);
  if (len < EPS) return Math.hypot(px - a.e, py - a.n) <= halfW;
  const ue = de / len, un = dn / len;
  const s = (px - a.e) * ue + (py - a.n) * un;
  const t = -(px - a.e) * un + (py - a.n) * ue;
  return Math.abs(t) <= halfW && s >= -halfW && s <= len + halfW;
}

// ---------- planning ----------

export function planCoverage({
  boundary,
  abLine,
  width,
  headlandPasses = 1,
  start = null,
}) {
  if (!(width > 0)) throw new Error('width must be positive');
  const poly = normalisePolygon(boundary);
  const areaM2 = Math.abs(signedArea(poly));

  // Frame of the guidance line: u runs along it, v is 90 degrees to its left.
  // Pass k sits at across-offset k * width, so we always land on lines the
  // tractor's own autosteer can hold.
  const A = abLine.a;
  const abLen = dist(abLine.a, abLine.b);
  if (abLen < 1e-9) throw new Error('abLine needs two distinct points');
  const u = { e: (abLine.b.e - A.e) / abLen, n: (abLine.b.n - A.n) / abLen };
  const v = { e: -u.n, n: u.e };
  const along = p => (p.e - A.e) * u.e + (p.n - A.n) * u.n;
  const across = p => (p.e - A.e) * v.e + (p.n - A.n) * v.n;

  // The inner field is where passes live; the headland strip is left for turning.
  const insetAmount = headlandPasses * width;
  // Fallback insets (full, then smaller) for fields too narrow for a full headland.
  const fractions = [1, 0.75, 0.5, 0.25, 0];
  const insets = fractions.map(f => insetPolygon(poly, insetAmount * f));
  const inner = insets.find(Boolean) || poly;

  // Which pass numbers have a strip touching the inner field?
  let tMin = Infinity, tMax = -Infinity;
  for (const p of inner) { const t = across(p); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
  const kLo = Math.floor(tMin / width) - 1, kHi = Math.ceil(tMax / width) + 1;

  const passes = []; // { k, sLo, sHi }
  for (let k = kLo; k <= kHi; k++) {
    const t = k * width;
    if (t + width / 2 <= tMin + EPS || t - width / 2 >= tMax - EPS) continue; // strip misses inner field
    const p0 = { e: A.e + v.e * t, n: A.n + v.n * t };
    // Prefer the real headland-inset polygon; if the line misses it but its
    // strip still touches it, use progressively less inset so it keeps some length.
    let range = null;
    for (const ins of insets) {
      if (!ins) continue;
      range = clipLine(ins, p0, u);
      if (range) break;
    }
    if (!range || range[1] - range[0] < MIN_PASS_M) continue;
    passes.push({ k, sLo: range[0], sHi: range[1] });
  }

  // Order: start from whichever outermost pass has an end nearest the tractor.
  const ends = ps => {
    const p = { e: A.e + v.e * ps.k * width, n: A.n + v.n * ps.k * width };
    return [
      { e: p.e + u.e * ps.sLo, n: p.n + u.n * ps.sLo },
      { e: p.e + u.e * ps.sHi, n: p.n + u.n * ps.sHi },
    ];
  };
  let firstLow = true; // does the first pass enter at its low-along end?
  if (passes.length) {
    if (start) {
      const f = ends(passes[0]), l = ends(passes[passes.length - 1]);
      // Four ways to begin: low or high end of the first or last pass.
      const cand = [
        { rev: false, d: dist(f[0], start) },
        { rev: false, d: dist(f[1], start) },
        { rev: true, d: dist(l[0], start) },
        { rev: true, d: dist(l[1], start) },
      ];
      let best = cand[0], bi = 0;
      cand.forEach((c, i) => { if (c.d < best.d) { best = c; bi = i; } });
      if (best.rev) passes.reverse();
      firstLow = bi % 2 === 0; // even index = nearest end is the low-along end
    }
  }

  const swaths = passes.map((ps, i) => {
    const lowFirst = (i % 2 === 0) ? firstLow : !firstLow; // direction alternates
    const [lo, hi] = ends(ps);
    return {
      index: i,
      k: ps.k,
      a: lowFirst ? lo : hi,
      b: lowFirst ? hi : lo,
    };
  });

  // Route: pass-start (turn, implement up) then pass-end (working).
  const route = [];
  swaths.forEach((s, i) => {
    route.push({ ...s.a, kind: 'pass-start', paint: false, follow: false, swath: i });
    route.push({ ...s.b, kind: 'pass-end', paint: true, follow: true, swath: i });
  });

  // Headland laps, innermost first so the last lap leaves a clean outer edge.
  const headland = [];
  let last = route.length ? route[route.length - 1] : start;
  for (let j = headlandPasses - 1; j >= 0; j--) {
    const loopPoly = insetPolygon(poly, (j + 0.5) * width);
    if (!loopPoly) continue; // field too narrow for this lap
    // Begin at the vertex nearest where we are, to avoid a long dead run.
    let s0 = 0;
    if (last) {
      let bd = Infinity;
      loopPoly.forEach((p, i) => { const d = dist(p, last); if (d < bd) { bd = d; s0 = i; } });
    }
    const m = loopPoly.length;
    const loop = [];
    for (let i = 0; i <= m; i++) loop.push({ ...loopPoly[(s0 + i) % m] });
    headland.push(loop);
    loop.forEach((p, i) => {
      route.push({ ...p, kind: 'headland', paint: i > 0, follow: false, swath: null });
    });
    last = route[route.length - 1];
  }

  let lengthM = 0, workLengthM = 0;
  for (let i = 1; i < route.length; i++) {
    const d = dist(route[i - 1], route[i]);
    lengthM += d;
    if (route[i].paint) workLengthM += d;
  }

  const plan = { width, headlandPasses, swaths, headland, route, lengthM, workLengthM, areaM2, coveredPct: 0 };
  plan.coveredPct = coverageOf(plan, boundary, 1);
  return plan;
}

// ---------- measuring ----------

// Rasterise the field: a cell counts as covered if its centre is inside the
// boundary and inside the width-wide strip of any painted leg. Measuring on a grid keeps
// this honest for any shape without needing polygon-union maths.
export function coverageOf(plan, boundary, cell = 1) {
  const poly = normalisePolygon(boundary);
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (const p of poly) {
    e0 = Math.min(e0, p.e); e1 = Math.max(e1, p.e);
    n0 = Math.min(n0, p.n); n1 = Math.max(n1, p.n);
  }
  const nx = Math.max(1, Math.ceil((e1 - e0) / cell));
  const ny = Math.max(1, Math.ceil((n1 - n0) / cell));
  const inside = new Uint8Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  let total = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (pointInPolygon({ e: e0 + (i + 0.5) * cell, n: n0 + (j + 0.5) * cell }, poly)) {
      inside[j * nx + i] = 1; total++;
    }
  }
  if (!total) return 0;

  const r = plan.width / 2;
  const route = plan.route;
  for (let q = 1; q < route.length; q++) {
    if (!route[q].paint) continue;
    const a = route[q - 1], b = route[q];
    // Only test cells near this leg, not the whole grid.
    const iMin = Math.max(0, Math.floor((Math.min(a.e, b.e) - r - e0) / cell));
    const iMax = Math.min(nx - 1, Math.floor((Math.max(a.e, b.e) + r - e0) / cell));
    const jMin = Math.max(0, Math.floor((Math.min(a.n, b.n) - r - n0) / cell));
    const jMax = Math.min(ny - 1, Math.floor((Math.max(a.n, b.n) + r - n0) / cell));
    for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
      const idx = j * nx + i;
      if (!inside[idx] || covered[idx]) continue;
      if (inStrip(e0 + (i + 0.5) * cell, n0 + (j + 0.5) * cell, a, b, r)) covered[idx] = 1;
    }
  }
  let c = 0;
  for (let i = 0; i < covered.length; i++) c += covered[i];
  return (100 * c) / total;
}

// How much of the work is done once the tractor has driven this far along the route.
export function routeProgress(plan, distanceAlongRouteM) {
  if (!(plan.workLengthM > 0)) return { fractionWorked: 0 };
  let remaining = Math.max(0, distanceAlongRouteM);
  let worked = 0;
  for (let i = 1; i < plan.route.length && remaining > 0; i++) {
    const d = dist(plan.route[i - 1], plan.route[i]);
    const part = Math.min(d, remaining);
    if (plan.route[i].paint) worked += part;
    remaining -= part;
  }
  return { fractionWorked: Math.min(1, worked / plan.workLengthM) };
}
