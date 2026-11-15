// Navigation Agent: shortest routes on the farm grid (4-connected BFS),
// aware of permanent obstacles (river) and temporary blocks (flooded bridge).

export class Navigation {
  constructor(map) {
    this.w = map.width;
    this.h = map.height;
    this.obstacles = new Set((map.obstacles || []).map(([x, y]) => this.key(x, y)));
    this.blocked = new Map(); // cellKey -> block name
    this.cache = new Map();   // target cellKey -> {dist, next}
    this.version = 0;
  }

  key(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  passable(x, y) {
    const k = this.key(x, y);
    return this.inBounds(x, y) && !this.obstacles.has(k) && !this.blocked.has(k);
  }

  block(cells, name) {
    for (const [x, y] of cells) this.blocked.set(this.key(x, y), name);
    this.version++; this.cache.clear();
  }
  unblock(cells) {
    for (const [x, y] of cells) this.blocked.delete(this.key(x, y));
    this.version++; this.cache.clear();
  }
  blockedCells() {
    return [...this.blocked.entries()].map(([k, name]) => ({ x: k % this.w, y: Math.floor(k / this.w), name }));
  }

  // BFS outward from a target; next[c] = neighbour of c one step closer to target.
  _fromTarget(tx, ty) {
    const tk = this.key(tx, ty);
    let c = this.cache.get(tk);
    if (c) return c;
    const n = this.w * this.h;
    const dist = new Int32Array(n).fill(-1);
    const next = new Int32Array(n).fill(-1);
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    dist[tk] = 0; q[tail++] = tk;
    while (head < tail) {
      const cur = q[head++];
      const cx = cur % this.w, cy = (cur - cx) / this.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!this.passable(nx, ny)) continue;
        const nk = this.key(nx, ny);
        if (dist[nk] !== -1) continue;
        dist[nk] = dist[cur] + 1; next[nk] = cur; q[tail++] = nk;
      }
    }
    c = { dist, next };
    this.cache.set(tk, c);
    return c;
  }

  // Distance in cells (Infinity if unreachable). A start cell that has just been
  // blocked (tractor standing on it) is allowed: we step off to the best neighbour.
  distance(a, b) {
    if (a.x === b.x && a.y === b.y) return 0;
    const { dist } = this._fromTarget(b.x, b.y);
    const d = dist[this.key(a.x, a.y)];
    if (d >= 0) return d;
    let best = Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = a.x + dx, ny = a.y + dy;
      if (!this.inBounds(nx, ny)) continue;
      const nd = dist[this.key(nx, ny)];
      if (nd >= 0) best = Math.min(best, nd + 1);
    }
    return best;
  }

  // Cells to visit from a (exclusive) to b (inclusive).
  path(a, b) {
    if (a.x === b.x && a.y === b.y) return [];
    const { dist, next } = this._fromTarget(b.x, b.y);
    const out = [];
    let k = this.key(a.x, a.y);
    if (dist[k] < 0) {
      let best = -1, bd = Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = a.x + dx, ny = a.y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const nk = this.key(nx, ny);
        if (dist[nk] >= 0 && dist[nk] < bd) { bd = dist[nk]; best = nk; }
      }
      if (best < 0) return null;
      k = best; out.push({ x: k % this.w, y: Math.floor(k / this.w) });
    }
    const tk = this.key(b.x, b.y);
    while (k !== tk) {
      k = next[k];
      if (k < 0) return null;
      out.push({ x: k % this.w, y: Math.floor(k / this.w) });
    }
    return out;
  }

  // Which named blocks would the old straight route have used? (for explanations)
  routeUses(a, b, cells) {
    const p = this.path(a, b) || [];
    const set = new Set(cells.map(([x, y]) => this.key(x, y)));
    return p.some(c => set.has(this.key(c.x, c.y)));
  }
}
