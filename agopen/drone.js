// Simulated scout drone: a pure state machine. Everything it "senses" is
// simulated and labelled `simulated: true`. Call tick(dtSec) repeatedly.
// Coordinates: metres, { e, n } (east, north of the depot). No dependencies.

const CLIMB_M = 15; // climb/descent distance at each end of a flight
const CHARGE_PCT_PER_SEC = 5;
const START_MIN_PCT = 30;
const ABORT_PCT = 20;
const HOVER_INVESTIGATE_S = 14;   // time spent circling a faulted tractor: one full orbit
const ORBIT_RADIUS_M = 22, ORBIT_ALT_M = 24;
const ESCORT_ALTS_M = [10, 30, 50], ESCORT_DWELL_S = 7, ESCORT_OFFSET_M = 12;   // wind is sampled at each height in turn
const HOVER_SPRAY_S = 4;
const EPS = 1e-9;

// ---------- deterministic helpers ----------

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (x) => Math.round(x * 10) / 10;
const dist = (a, b) => Math.hypot(b.e - a.e, b.n - a.n);

function bbox(poly) {
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const p of poly) {
    minE = Math.min(minE, p.e); maxE = Math.max(maxE, p.e);
    minN = Math.min(minN, p.n); maxN = Math.max(maxN, p.n);
  }
  return { minE, maxE, minN, maxN };
}

function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

// ---------- scan path ----------

/** Lawn-mower flight lines (east-west) over the polygon's bounding box, clipped to the polygon. */
export function scanPath(boundary, swathM = 30) {
  if (!Array.isArray(boundary) || boundary.length < 3) return [];
  const { minN, maxN } = bbox(boundary);
  const height = maxN - minN;
  const count = Math.max(1, Math.ceil(height / swathM - 1e-9));
  const pts = [];
  let used = 0;
  for (let k = 0; k < count; k++) {
    const y = minN + ((k + 0.5) * height) / count;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i], b = boundary[(i + 1) % boundary.length];
      if ((a.n <= y && y < b.n) || (b.n <= y && y < a.n)) {
        const e = a.e + ((y - a.n) * (b.e - a.e)) / (b.n - a.n);
        lo = Math.min(lo, e); hi = Math.max(hi, e);
      }
    }
    if (lo === Infinity) continue;
    if (used % 2 === 0) pts.push({ e: lo, n: y }, { e: hi, n: y });
    else pts.push({ e: hi, n: y }, { e: lo, n: y });
    used++;
  }
  return pts;
}

// ---------- simulated field truth ----------

/**
 * Deterministic simulated truth for a field. `crop` (optional 4th arg) turns an unploughed
 * field into a standing crop. Pest spot positions are fractions (fx, fy) of the bounding box.
 */
export function fieldTruth(fieldName, ground, seed = 1, crop) {
  const rnd = rng(hash32(`${fieldName}|${seed}`));
  const rr = (a, b) => a + rnd() * (b - a);
  // Fixed draw order so moisture is the same for every ground state of one field.
  const moisturePct = round1(rr(8, 45));
  const trafficable = moisturePct < 32;
  const uPests = rnd();
  const uA = rnd(), uB = rnd(), uC = rnd();
  const makeSpots = (n) => {
    const spots = [];
    for (let i = 0; i < n; i++) {
      spots.push({
        fx: round1(rr(0.1, 0.9) * 100) / 100,
        fy: round1(rr(0.1, 0.9) * 100) / 100,
        radiusM: round1(rr(6, 14)),
        severity: ['low', 'medium', 'high'][Math.min(2, Math.floor(rnd() * 3))],
      });
    }
    return spots;
  };
  const out = { moisturePct, trafficable, standPct: 0, maturityPct: 0, harvestReady: false, pestSpots: [], weedsPct: 0 };

  if (ground === 'plowed') {
    out.weedsPct = round1(uA * 3);
  } else if (ground === 'sown') {
    out.standPct = Math.round(70 + uA * 28);
    out.maturityPct = Math.round(5 + uB * 15);
    out.weedsPct = round1(uC * 8);
    out.pestSpots = makeSpots(Math.min(3, Math.floor(uPests * 4)));
  } else if (crop) {
    // standing crop in a field not yet plowed
    out.standPct = Math.round(80 + uA * 18);
    out.maturityPct = Math.round(40 + uB * 60);
    out.harvestReady = out.maturityPct >= 85;
    out.weedsPct = round1(uC * 10);
    out.pestSpots = makeSpots(Math.min(3, Math.floor(uPests * 4)));
  } else {
    // 'not plowed': stubble after harvest
    out.weedsPct = round1(5 + uA * 20);
    out.pestSpots = makeSpots(uPests < 0.1 ? 1 : 0);
  }
  return out;
}

/** Scan-report recommendations from a truth object and field area. */
export function recommendFor(truth, areaM2) {
  const recs = [];
  const spots = truth.pestSpots || [];
  if (spots.length) {
    const covered = spots.reduce((s, p) => s + Math.PI * p.radiusM * p.radiusM, 0);
    const pct = areaM2 > 0 ? (covered / areaM2) * 100 : 100;
    const reason = `${spots.length} pest spot${spots.length > 1 ? 's' : ''} covering about ${round1(pct)}% of the field`;
    recs.push({ action: pct < 15 ? 'spot-spray' : 'spray-field', reason });
  }
  if (!truth.trafficable) {
    recs.push({ action: 'hold-machines', reason: `ground too wet (${truth.moisturePct}% moisture) for machines` });
  }
  if (truth.harvestReady) {
    recs.push({ action: 'harvest', reason: `crop ${truth.maturityPct}% mature` });
  }
  if (!recs.length) recs.push({ action: 'none', reason: 'nothing needs attention' });
  return recs;
}

// ---------- reports ----------

const GNM_CAUSES = [
  { finding: 'Rear wheel appears bogged in soft ground', assessment: 'The tractor looks stuck because a rear wheel has sunk into soft ground.', recommend: 'send a person' },
  { finding: 'A rock is visible under the front axle', assessment: 'The tractor looks blocked by a rock under the front axle.', recommend: 'send a person' },
  { finding: 'The implement appears snagged', assessment: 'The implement looks snagged, which is probably holding the tractor back.', recommend: 'send a person' },
  { finding: 'Nothing visibly wrong', assessment: 'Nothing is visibly wrong from above, so this may be a software stall.', recommend: 'safe to restart remotely' },
];

function inspectionReport(m, seed) {
  const { subject, symptom, target } = m.spec;
  const h = hash32(`${subject}|${seed}`);
  let findings, assessment, recommend;
  if (symptom === 'GO_NOT_MOVING') {
    const c = GNM_CAUSES[h % GNM_CAUSES.length];
    findings = ['Tractor is stationary', 'Engine appears to be running', 'No obstruction visible ahead', c.finding];
    assessment = c.assessment;
    recommend = c.recommend;
  } else if (symptom === 'NO_RESPONSE') {
    const damaged = h % 2 === 1;
    findings = [
      'Tractor is stationary',
      'No lights or movement visible',
      damaged ? 'Antenna mast appears damaged' : 'Antenna mast appears intact',
    ];
    assessment = damaged
      ? 'The tractor is silent and its antenna mast looks damaged, which would explain the lost link.'
      : 'The tractor is silent but its antenna looks fine, so it may have lost power.';
    recommend = damaged ? 'keep out of service' : 'send a person';
  } else {
    findings = [`Reported symptom: ${symptom}`, 'Tractor seen from above at the reported position', 'No obvious external damage visible'];
    assessment = 'The cause could not be determined from the air.';
    recommend = 'send a person';
  }
  return { kind: 'fault-inspection', simulated: true, subject, symptom, at: { e: target.e, n: target.n }, findings, assessment, recommend };
}

function scanReport(m, seed) {
  const f = m.spec.field;
  const box = m.box;
  const t = fieldTruth(f.name, f.ground, seed, f.crop);
  const pests = t.pestSpots.map((p) => ({
    e: round1(box.minE + p.fx * (box.maxE - box.minE)),
    n: round1(box.minN + p.fy * (box.maxN - box.minN)),
    radiusM: p.radiusM,
    severity: p.severity,
  }));
  const recommend = recommendFor(t, m.areaM2);
  const standing = f.ground === 'not plowed' && f.crop;
  const s1 = standing
    ? `Simulated scan of ${f.name}: standing ${f.crop}, ${t.maturityPct}% mature, ${t.standPct}% stand.`
    : `Simulated scan of ${f.name}: ground is ${f.ground}${f.ground === 'sown' ? `, ${t.standPct}% emerged` : ''}.`;
  const s2 = `Soil moisture ${t.moisturePct}% so machines ${t.trafficable ? 'can' : 'should not'} work it${pests.length ? `, ${pests.length} pest spot${pests.length > 1 ? 's' : ''} found` : ''}.`;
  return {
    kind: 'field-scan',
    simulated: true,
    field: f.name,
    areaM2: Math.round(m.areaM2),
    ground: f.ground,
    moisturePct: t.moisturePct,
    trafficable: t.trafficable,
    standPct: t.standPct,
    maturityPct: t.maturityPct,
    harvestReady: t.harvestReady,
    pests,
    weedsPct: t.weedsPct,
    summary: `${s1} ${s2}`,
    recommend,
  };
}

// ---------- the drone ----------

export function createDrone({ home = { e: 0, n: 0 }, speedMps = 12, altitudeM = 40, batteryMin = 25, seed = 1 } = {}) {
  const HOME = { e: home.e, n: home.n };
  const drainPerSec = 100 / (batteryMin * 60);

  let pos = { ...HOME };
  let heading = 0;
  let battery = 100;
  let status = 'docked';
  let mode = 'docked'; // 'docked' | 'mission' | 'returning'
  let mustFull = false; // charge to 100 before next launch (after a battery-low return)
  let cur = null;
  let queue = [];
  let nextId = 1;
  let pending = [];

  const resetPhase = (m) => {
    m.phase = 'go';
    m.hoverLeft = m.type === 'investigate' ? HOVER_INVESTIGATE_S : HOVER_SPRAY_S;
    if (m.type === 'scan') m.onPath = false;
    if (m.type === 'investigate') m.theta = null;
  };

  function airborne(sec) {
    battery = Math.max(0, battery - drainPerSec * sec);
  }

  /** Move toward pt using up to t seconds. Returns { t: remaining, arrived }. */
  function flyTo(pt, t, st) {
    status = st;
    const d = dist(pos, pt);
    if (d < EPS) return { t, arrived: true };
    heading = ((Math.atan2(pt.e - pos.e, pt.n - pos.n) * 180) / Math.PI + 360) % 360;
    const maxd = speedMps * t;
    if (d <= maxd) {
      const used = d / speedMps;
      pos = { e: pt.e, n: pt.n };
      airborne(used);
      return { t: t - used, arrived: true };
    }
    pos = { e: pos.e + ((pt.e - pos.e) * maxd) / d, n: pos.n + ((pt.n - pos.n) * maxd) / d };
    airborne(t);
    return { t: 0, arrived: false };
  }

  function startReturn(reason, ev) {
    mode = 'returning';
    status = 'returning';
    if (reason === 'battery low') mustFull = true;
    ev.push({ type: 'returning', reason });
  }

  function abort(ev) {
    if (cur) {
      resetPhase(cur);
      queue.unshift(cur);
      cur = null;
    }
    startReturn('battery low', ev);
  }

  function dockStatus() {
    status = battery >= 100 - EPS ? 'docked' : 'charging';
  }

  function reachedScanPoint(m, ev) {
    if (m.wp === 0) ev.push({ type: 'arrived', missionId: m.id, at: { ...pos } });
    m.done = m.cum[m.wp];
    m.wp++;
    m.onPath = true;
    if (m.wp >= m.path.length) {
      m.done = m.total;
      ev.push({ type: 'report', missionId: m.id, report: scanReport(m, seed) });
      cur = null;
      return;
    }
    m.phase = 'path';
  }

  function runMission(m, t, ev) {
    if (m.type === 'investigate') {
      if (m.phase === 'go') {
        // Join the circle at the point nearest to where the drone is coming from.
        const c = m.spec.target, d0 = dist(pos, c) || 1;
        if (m.theta == null) m.theta = d0 > ORBIT_RADIUS_M ? Math.atan2(pos.n - c.n, pos.e - c.e) : 0;
        const join = { e: c.e + ORBIT_RADIUS_M * Math.cos(m.theta), n: c.n + ORBIT_RADIUS_M * Math.sin(m.theta) };
        const r = flyTo(join, t, 'flying');
        if (r.arrived) {
          ev.push({ type: 'arrived', missionId: m.id, at: { ...pos } });
          m.phase = 'hover';
          status = 'hovering';
        }
        return r.t;
      }
      // One slow circle round the tractor, camera on it the whole way.
      status = 'hovering';
      const used = Math.min(t, m.hoverLeft);
      m.hoverLeft -= used;
      airborne(used);
      m.theta += Math.min(2 * Math.PI / HOVER_INVESTIGATE_S, speedMps / ORBIT_RADIUS_M) * used;   // never faster than the drone flies
      pos = { e: m.spec.target.e + ORBIT_RADIUS_M * Math.cos(m.theta), n: m.spec.target.n + ORBIT_RADIUS_M * Math.sin(m.theta) };
      heading = ((Math.atan2(-Math.sin(m.theta), Math.cos(m.theta)) * 180) / Math.PI + 360) % 360;
      if (m.hoverLeft <= EPS) {
        ev.push({ type: 'report', missionId: m.id, report: inspectionReport(m, seed) });
        cur = null;
      }
      return t - used;
    }

    if (m.type === 'escort') {
      // Stay just behind a tractor while it sprays, stepping through three heights and reporting each one, so
      // the wind can be read at more than the two fixed heights of the weather mast. Gives way to any other mission.
      const at = m.spec.follow();
      if (!at || m.spec.until() || queue.length) { ev.push({ type: 'escort-ended', missionId: m.id }); cur = null; return t; }
      const r = flyTo({ e: at.e - ESCORT_OFFSET_M, n: at.n - ESCORT_OFFSET_M }, t, m.phase === 'go' ? 'flying' : 'escorting');
      m.focus = { e: at.e, n: at.n };
      if (m.phase === 'go') { if (r.arrived) { m.phase = 'follow'; m.dwell = 0; m.step = 0; ev.push({ type: 'arrived', missionId: m.id, at: { ...pos } }); } return r.arrived ? r.t : 0; }
      if (r.t > 0) airborne(r.t);                     // holding station still uses the battery
      m.dwell += t;
      if (m.dwell >= ESCORT_DWELL_S) {
        ev.push({ type: 'wind-sample', missionId: m.id, subject: m.spec.subject, altM: ESCORT_ALTS_M[m.step % ESCORT_ALTS_M.length], lastOfCycle: m.step % ESCORT_ALTS_M.length === ESCORT_ALTS_M.length - 1 });
        m.step++; m.dwell = 0;
      }
      return 0;
    }

    if (m.type === 'scan') {
      const tgt = m.path[m.wp];
      const r = flyTo(tgt, t, m.phase === 'path' ? 'scanning' : 'flying');
      if (m.phase === 'path') {
        m.done = Math.max(m.done, m.cum[m.wp - 1] + dist(m.path[m.wp - 1], pos));
      }
      if (r.arrived) reachedScanPoint(m, ev);
      return r.t;
    }

    // spot-spray
    const spot = m.spec.spots[m.idx];
    if (m.phase === 'go') {
      const r = flyTo(spot, t, 'flying');
      if (r.arrived) {
        ev.push({ type: 'arrived', missionId: m.id, at: { ...pos } });
        m.phase = 'spray';
        status = 'spraying';
      }
      return r.t;
    }
    status = 'spraying';
    const used = Math.min(t, m.hoverLeft);
    m.hoverLeft -= used;
    airborne(used);
    if (m.hoverLeft <= EPS) {
      ev.push({ type: 'sprayed', missionId: m.id, field: m.spec.field, spot: { e: spot.e, n: spot.n, radiusM: spot.radiusM } });
      m.idx++;
      m.phase = 'go';
      m.hoverLeft = HOVER_SPRAY_S;
      if (m.idx >= m.spec.spots.length) cur = null;
    }
    return t - used;
  }

  function step(t, ev) {
    if (mode === 'docked') {
      if (!queue.length) {
        battery = Math.min(100, battery + CHARGE_PCT_PER_SEC * t);
        dockStatus();
        return 0;
      }
      const thr = mustFull ? 100 : START_MIN_PCT;
      if (battery >= thr - EPS) {
        mode = 'mission';
        mustFull = false;
        cur = null;
        status = 'flying';
        return t;
      }
      status = 'charging';
      const need = (thr - battery) / CHARGE_PCT_PER_SEC;
      if (need <= t) {
        battery = thr;
        return t - need;
      }
      battery += CHARGE_PCT_PER_SEC * t;
      return 0;
    }

    if (mode === 'returning') {
      const r = flyTo(HOME, t, 'returning');
      if (r.arrived) {
        pos = { ...HOME };
        mode = 'docked';
        dockStatus();
        ev.push({ type: 'docked' });
      }
      return r.t;
    }

    // mode === 'mission'
    if (battery < ABORT_PCT) {
      abort(ev);
      return t;
    }
    if (!cur) {
      if (!queue.length) {
        startReturn('missions done', ev);
        return t;
      }
      if (battery < START_MIN_PCT) {
        startReturn('battery low', ev);
        return t;
      }
      cur = queue.shift();
      resetPhase(cur);
      return t;
    }
    return runMission(cur, t, ev);
  }

  function missionView(m) {
    let progressPct = 0;
    if (m.type === 'scan') progressPct = m.total > 0 ? (100 * m.done) / m.total : 0;
    else if (m.type === 'spot-spray') progressPct = (100 * m.idx) / m.spec.spots.length;
    else progressPct = m.phase === 'hover' ? (100 * (HOVER_INVESTIGATE_S - m.hoverLeft)) / HOVER_INVESTIGATE_S : 0;
    return { id: m.id, type: m.type, label: m.label, progressPct: Math.max(0, Math.min(100, progressPct)) };
  }

  function remainingPath() {
    if (mode === 'returning') return [{ ...HOME }];
    if (mode !== 'mission' || !cur) return [];
    if (cur.type === 'investigate') return [{ ...cur.spec.target }];
    if (cur.type === 'escort') return [];
    if (cur.type === 'scan') return cur.path.slice(cur.wp).map((p) => ({ ...p }));
    return cur.spec.spots.slice(cur.idx).map((s) => ({ e: s.e, n: s.n }));
  }

  return {
    state() {
      let alt = mode === 'docked' ? 0 : altitudeM * Math.min(1, dist(pos, HOME) / CLIMB_M);
      let focus = null;
      if (mode === 'mission' && cur?.type === 'investigate') { focus = { ...cur.spec.target }; if (cur.phase === 'hover') alt = ORBIT_ALT_M; }
      if (mode === 'mission' && cur?.type === 'escort' && cur.phase === 'follow') { focus = cur.focus || null; alt = ESCORT_ALTS_M[cur.step % ESCORT_ALTS_M.length]; }
      return {
        focus,
        e: pos.e,
        n: pos.n,
        altM: alt,
        headingDeg: heading,
        batteryPct: battery,
        status,
        mission: mode === 'mission' && cur ? missionView(cur) : null,
        path: remainingPath(),
        queue: queue.length,
        simulated: true,
      };
    },

    assign(spec) {
      if (!spec || typeof spec !== 'object') throw new TypeError('mission must be an object');
      const id = `M${nextId++}`;
      const m = { id, type: spec.type, spec, phase: 'go', hoverLeft: 0 };
      if (spec.type === 'investigate') {
        if (!spec.target) throw new TypeError('investigate needs a target');
        m.label = `Inspect ${spec.subject}`;
        m.hoverLeft = HOVER_INVESTIGATE_S;
      } else if (spec.type === 'scan') {
        const f = spec.field;
        if (!f || !Array.isArray(f.boundary) || f.boundary.length < 3) throw new TypeError('scan needs a field boundary of 3+ points');
        m.label = `Scan ${f.name}`;
        m.path = scanPath(f.boundary);
        m.cum = [0];
        for (let i = 1; i < m.path.length; i++) m.cum.push(m.cum[i - 1] + dist(m.path[i - 1], m.path[i]));
        m.total = m.cum[m.cum.length - 1] || 0;
        m.areaM2 = polygonArea(f.boundary);
        m.box = bbox(f.boundary);
        m.wp = 0;
        m.done = 0;
        m.onPath = false;
        if (!m.path.length) throw new TypeError('scan boundary produced no flight path');
      } else if (spec.type === 'escort') {
        if (typeof spec.follow !== 'function' || typeof spec.until !== 'function') throw new TypeError('escort needs follow() and until()');
        m.label = `Wind watch above ${spec.subject}`;
      } else if (spec.type === 'spot-spray') {
        if (!Array.isArray(spec.spots) || !spec.spots.length) throw new TypeError('spot-spray needs spots');
        m.label = `Spot-spray ${spec.field} (${spec.spots.length} spot${spec.spots.length > 1 ? 's' : ''})`;
        m.idx = 0;
        m.hoverLeft = HOVER_SPRAY_S;
      } else {
        throw new TypeError(`unknown mission type: ${spec.type}`);
      }

      if (spec.type === 'investigate') {
        let at = 0;
        while (at < queue.length && queue[at].type === 'investigate') at++;
        queue.splice(at, 0, m);
        // preempt a running scan / spray: it goes right behind the new investigation
        if (mode === 'mission' && cur && cur.type !== 'investigate') {
          resetPhase(cur);
          queue.splice(at + 1, 0, cur);
          cur = null;
        }
      } else {
        queue.push(m);
      }
      return id;
    },

    tick(dtSec) {
      const ev = pending;
      pending = [];
      let t = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
      for (let i = 0; t > EPS && i < 1000; i++) t = step(t, ev);
      return ev;
    },

    cancelAll() {
      queue = [];
      cur = null;
      if (mode === 'mission') {
        mode = 'returning';
        status = 'returning';
        pending.push({ type: 'returning', reason: 'missions done' });
      }
    },
  };
}
