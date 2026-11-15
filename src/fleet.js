// Fleet Agent: assigns jobs to tractors and orders each tractor's queue.
//
// 1. evaluateSequence() predicts a tractor's day for a given job order, using the
//    same action rule the simulator executes (drive, swap implement, refuel, work).
// 2. FleetPlanner builds a plan by priority-first regret insertion, then improves
//    it with relocate / swap / eject-and-insert local search.
//    Hard constraints (never violated): implement on board, fuel reserve on every
//    leg, reachable route, fits in the shift, one tractor per job.
//    Objective: do the most valuable work on time (value = priority x acres);
//    a deadline miss costs 60% of the job's value, so it only happens when an
//    event makes it unavoidable, and is flagged. Then: less driving, earlier
//    completion of high-priority work, no field conflicts, stable assignments.

import { nextAction, ratePerMin, reserve, canDo, IMPLEMENT_FOR, PRIORITY_WEIGHT, SWAP_MIN, REFUEL_MIN } from './model.js';

const EPS = 1e-6;
const CHANGE_PENALTY = 4;      // keep assignments stable across re-plans
const OVERLAP_PENALTY = 300;   // two tractors planned on one field at once
const VALUE_M = 40;            // cost per (priority weight x acre) of work left undone
const LATE_FRACTION = 0.6;
const COMPLETION_BONUS_ACRES = 20;     // a deadline miss forfeits 60% of the job's value

// ---------------------------------------------------------------------------
export function evaluateSequence(spec, start, seq, ctx) {
  const { nav, depot } = ctx;
  const st = { x: start.x, y: start.y, fuel: start.fuel, mounted: start.mounted };
  let t = start.t0;
  let travel = 0, minFuel = st.fuel, refuels = 0, swaps = 0;
  const jobs = [], legs = [];
  if (start.busy) legs.push({ kind: start.busy, start: ctx.now, end: start.t0 });
  for (const job of seq) {
    let rem = job.remaining, first = null, arrive = null;
    const intervals = [];
    const view = { type: job.type, field: job.field, remaining: rem };
    let fuelAtStart = null;
    for (let guard = 0; rem > 1e-4; guard++) {
      if (guard > 40) return { feasible: false, reason: 'loop', jobId: job.id };
      view.remaining = rem;
      const a = nextAction(spec, st, view, nav, depot);
      if (a.kind === 'infeasible') return { feasible: false, reason: a.reason, jobId: job.id };
      if (a.kind === 'goto') {
        const d = nav.distance(st, a.target);
        const dt = d * spec.ticksPerCell;
        legs.push({ kind: a.purpose === 'job' ? 'travel' : 'travel-depot', start: t, end: t + dt, jobId: job.id });
        t += dt; travel += dt; st.fuel -= d * spec.burnPerCell; st.x = a.target.x; st.y = a.target.y;
        if (a.purpose === 'job' && arrive == null) arrive = t;
      } else if (a.kind === 'swap') {
        legs.push({ kind: 'swap', start: t, end: t + SWAP_MIN, impl: a.impl });
        t += SWAP_MIN; st.mounted = a.impl; swaps++;
      } else if (a.kind === 'refuel') {
        legs.push({ kind: 'refuel', start: t, end: t + REFUEL_MIN });
        t += REFUEL_MIN; st.fuel = spec.fuelCapacity; refuels++;
      } else {
        if (arrive == null) arrive = t;
        if (fuelAtStart == null) fuelAtStart = st.fuel;
        const budget = st.fuel - reserve(spec) - nav.distance(job.field, depot) * spec.burnPerCell;
        const acres = Math.min(rem, Math.max(0, budget / spec.burnPerAcre));
        if (acres <= EPS) return { feasible: false, reason: 'fuel', jobId: job.id };
        // simulator works in whole minutes
        const dt = Math.ceil(acres / ratePerMin(spec, job.type) - 1e-9);
        if (first == null) first = t;
        intervals.push([t, t + dt]);
        legs.push({ kind: 'work', start: t, end: t + dt, jobId: job.id });
        t += dt; st.fuel -= acres * spec.burnPerAcre; rem -= acres;
      }
      minFuel = Math.min(minFuel, st.fuel);
    }
    if (first == null) first = t;
    if (ctx.shiftEnd != null && t > ctx.shiftEnd && !job.pinned) return { feasible: false, reason: 'shift', jobId: job.id, end: t, jobs };
    const late = t > job.deadline;
    jobs.push({ id: job.id, fieldId: job.fieldId, arrive: arrive ?? t, start: first, end: t, late, lateness: Math.max(0, t - job.deadline), intervals, fuelAtStartPct: fuelAtStart != null ? 100 * fuelAtStart / spec.fuelCapacity : null });
    if (late && ctx.hardDeadlines && !job.allowLate) return { feasible: false, reason: 'deadline', jobId: job.id, end: t, deadline: job.deadline, jobs };
  }
  return { feasible: true, jobs, legs, travel, end: t, minFuel, minFuelPct: 100 * minFuel / spec.fuelCapacity, refuels, swaps };
}

// ---------------------------------------------------------------------------
export class FleetPlanner {
  // units: [{spec, start:{x,y,fuel,mounted,t0,busy}, pinned: jobId|null}]
  // jobs: Map id -> {id, type, fieldId, field, remaining, deadline, priority, allowLate}
  constructor({ units, jobs, nav, depot, now, prevAssign = {}, lateWork = 'schedule', shiftEnd = null }) {
    this.units = units;
    this.jobs = jobs;
    this.ctx = { nav, depot, now, shiftEnd, hardDeadlines: lateWork === 'hold' };
    this.now = now;
    this.prevOwner = {};
    for (const [tid, ids] of Object.entries(prevAssign)) for (const id of ids) this.prevOwner[id] = tid;
    this.cache = new Map();
    this.evals = 0;
    this.totalValue = 0;
    for (const j of jobs.values()) this.totalValue += this.value(j);
  }

  // A job's value: priority x (acres left + a fixed bonus for finishing it at all),
  // so a nearly-finished job is never abandoned to save a short drive.
  value(job) { return (PRIORITY_WEIGHT[job.priority] ?? 1) * (job.remaining + COMPLETION_BONUS_ACRES); }

  evalUnit(u, ids) {
    const key = u.spec.id + '|' + ids.join(',');
    let r = this.cache.get(key);
    if (r) return r;
    this.evals++;
    r = evaluateSequence(u.spec, u.start, ids.map(id => this.jobs.get(id)), this.ctx);
    if (r.feasible) {
      let cost = r.travel + 0.25 * Math.max(0, r.end - this.now);
      let value = 0;
      for (const j of r.jobs) {
        const job = this.jobs.get(j.id);
        const w = PRIORITY_WEIGHT[job.priority] ?? 1;
        cost += 0.15 * w * (j.end - this.now);
        value += this.value(job);
        if (j.late) {
          // late work is always worth more than no work: cost capped at 90% of value
          const v = VALUE_M * this.value(job);
          cost += job.allowLate ? Math.min(0.5 * w * j.lateness, 0.3 * v) : v * (LATE_FRACTION + 0.3 * Math.min(1, j.lateness / 240));
        }
        if (this.prevOwner[j.id] && this.prevOwner[j.id] !== u.spec.id) cost += CHANGE_PENALTY;
      }
      r.cost = cost; r.value = value;
    } else r.cost = Infinity;
    this.cache.set(key, r);
    return r;
  }

  overlapCost(evals) {
    let c = 0;
    for (let a = 0; a < evals.length; a++) for (let b = a + 1; b < evals.length; b++) {
      for (const ja of evals[a].jobs) for (const jb of evals[b].jobs) {
        if (ja.fieldId !== jb.fieldId) continue;
        for (const [s1, e1] of ja.intervals) for (const [s2, e2] of jb.intervals) {
          const ov = Math.min(e1, e2) - Math.max(s1, s2);
          if (ov > 0) c += OVERLAP_PENALTY + 25 * ov;
        }
      }
    }
    return c;
  }

  totalCost(seqs) {
    const evals = this.units.map((u, i) => this.evalUnit(u, seqs[i]));
    let c = 0, v = 0;
    for (const e of evals) { if (!e.feasible) return Infinity; c += e.cost; v += e.value; }
    return c + this.overlapCost(evals) + VALUE_M * (this.totalValue - v); // undone work
  }

  // Best place to put job into unit i (positions after any pinned job).
  bestInsertion(seqs, i, id) {
    const u = this.units[i];
    const job = this.jobs.get(id);
    if (!canDo(u.spec, job.type)) return { cost: Infinity, reason: 'no-implement' };
    const lo = u.pinned ? 1 : 0;
    let best = { cost: Infinity, reason: null };
    const base = seqs[i];
    for (let p = lo; p <= base.length; p++) {
      const cand = [...base.slice(0, p), id, ...base.slice(p)];
      const trial = seqs.slice(); trial[i] = cand;
      const c = this.totalCost(trial);
      if (c < best.cost) best = { ...best, cost: c, pos: p, seq: cand };
      else if (!isFinite(c) && !best.reason) {
        const e = this.evalUnit(u, cand);
        best.reason = e.reason; best.blame = e.jobId; best.lateEnd = e.end;
      }
    }
    return best;
  }

  _bestAnywhere(seqs, id) {
    let best = null;
    for (let i = 0; i < this.units.length; i++) {
      const b = this.bestInsertion(seqs, i, id);
      if (isFinite(b.cost) && (!best || b.cost < best.cost)) best = { ...b, i };
    }
    return best;
  }

  plan() {
    const seqs = this.units.map(u => (u.pinned ? [u.pinned] : []));
    const assigned = new Set(this.units.map(u => u.pinned).filter(Boolean));
    let open = [...this.jobs.keys()].filter(id => !assigned.has(id));
    const unassigned = new Set();

    // --- construction: highest priority first, then earliest deadline / largest regret ---
    while (open.length) {
      const base = this.totalCost(seqs);
      let pick = null;
      for (const id of open) {
        const feas = this.units.map((_, i) => ({ ...this.bestInsertion(seqs, i, id), i }))
          .filter(o => isFinite(o.cost) && o.cost < base).sort((a, b) => a.cost - b.cost);
        if (!feas.length) { unassigned.add(id); continue; }
        const regret = feas.length > 1 ? feas[1].cost - feas[0].cost : 1e5;
        const job = this.jobs.get(id);
        const score = (PRIORITY_WEIGHT[job.priority] ?? 1) * 1e7 - job.deadline * 100 + Math.min(regret, 1e5) / 100;
        if (!pick || score > pick.score) pick = { id, score, best: feas[0] };
      }
      open = open.filter(id => !unassigned.has(id));
      if (!pick) break;
      seqs[pick.best.i] = pick.best.seq;
      open = open.filter(id => id !== pick.id);
    }

    // --- improvement: relocate, swap, eject-and-insert, insert ---
    const apply = t => { seqs.splice(0, seqs.length, ...t); };
    let cur = this.totalCost(seqs);
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      // relocate one job anywhere
      outerR: for (let i = 0; i < seqs.length; i++) {
        for (let p = this.units[i].pinned ? 1 : 0; p < seqs[i].length; p++) {
          const id = seqs[i][p];
          const removed = seqs.slice(); removed[i] = seqs[i].filter((_, k) => k !== p);
          const b = this._bestAnywhere(removed, id);
          if (b && b.cost < cur - 0.01) { removed[b.i] = b.seq; apply(removed); cur = b.cost; improved = true; break outerR; }
        }
      }
      if (improved) continue;
      // swap two jobs between tractors
      outerS: for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) {
        for (let a = this.units[i].pinned ? 1 : 0; a < seqs[i].length; a++) for (let b = this.units[j].pinned ? 1 : 0; b < seqs[j].length; b++) {
          const t = seqs.slice();
          t[i] = seqs[i].slice(); t[j] = seqs[j].slice();
          [t[i][a], t[j][b]] = [seqs[j][b], seqs[i][a]];
          const c = this.totalCost(t);
          if (c < cur - 0.01) { apply(t); cur = c; improved = true; break outerS; }
        }
      }
      if (improved) continue;
      // insert left-over work, or eject a job to make room for more valuable work
      outerE: for (const u of [...unassigned]) {
        const b = this._bestAnywhere(seqs, u);
        if (b && b.cost < cur - 0.01) { seqs[b.i] = b.seq; cur = b.cost; unassigned.delete(u); improved = true; break; }
        for (let i = 0; i < seqs.length; i++) for (let p = this.units[i].pinned ? 1 : 0; p < seqs[i].length; p++) {
          const out = seqs[i][p];
          const removed = seqs.slice(); removed[i] = seqs[i].filter((_, k) => k !== p);
          const bu = this._bestAnywhere(removed, u);
          if (!bu) continue;
          removed[bu.i] = bu.seq;
          const back = this._bestAnywhere(removed, out);
          let c = this.totalCost(removed);
          if (back && back.cost < c) { removed[back.i] = back.seq; c = back.cost; }
          if (c < cur - 0.01) {
            apply(removed); cur = c; unassigned.delete(u);
            if (!seqs.some(s => s.includes(out))) unassigned.add(out);
            improved = true; break outerE;
          }
        }
      }
      if (!improved) break;
    }

    const evals = this.units.map((u, i) => this.evalUnit(u, seqs[i]));
    const assign = Object.fromEntries(this.units.map((u, i) => [u.spec.id, seqs[i]]));
    const schedule = {};
    for (const e of evals) for (const j of e.jobs) schedule[j.id] = j;
    const lateIds = Object.values(schedule).filter(j => j.late).map(j => j.id);
    const late = lateIds.map(id => ({
      id, end: schedule[id].end, lateness: schedule[id].lateness,
      tractor: Object.keys(assign).find(t => assign[t].includes(id)),
      approved: !!this.jobs.get(id).allowLate,
      why: this.whyLate(seqs, id, new Set(lateIds)),
    }));
    return {
      assign, evals: Object.fromEntries(this.units.map((u, i) => [u.spec.id, evals[i]])), schedule,
      unassigned: [...unassigned].map(id => ({ id, why: this.whyNot(seqs, id) })), late, cost: cur,
      travel: evals.reduce((a, e) => a + e.travel, 0),
      finish: Math.max(this.now, ...evals.map(e => e.end)),
      evalCount: this.evals,
    };
  }

  // Driving minutes of a given assignment under current conditions (open jobs only).
  totalTravelOf(assign) {
    const out = {};
    for (const u of this.units) {
      const ids = (assign[u.spec.id] || []).filter(id => this.jobs.has(id));
      if (u.pinned && !ids.includes(u.pinned)) ids.unshift(u.pinned);
      const e = this.evalUnit(u, ids);
      out[u.spec.id] = e.feasible ? e.travel : null;
    }
    return out;
  }

  // Per-tractor reasons a job could not be placed at all.
  whyNot(seqs, id) {
    return this.units.map((u, i) => {
      const b = this.bestInsertion(seqs, i, id);
      return { tractor: u.spec.id, reason: b.reason || 'no-capacity', blame: b.blame, lateEnd: b.lateEnd };
    });
  }

  // Per-tractor reasons a scheduled job cannot be on time.
  whyLate(seqs, id, lateSet) {
    const removed = seqs.map(s => s.filter(x => x !== id));
    return this.units.map((u, i) => {
      const job = this.jobs.get(id);
      if (!canDo(u.spec, job.type)) return { tractor: u.spec.id, reason: 'no-implement' };
      let earliest = Infinity, blame = null;
      for (let p = u.pinned ? 1 : 0; p <= removed[i].length; p++) {
        const cand = [...removed[i].slice(0, p), id, ...removed[i].slice(p)];
        const ev = this.evalUnit(u, cand);
        if (!ev.feasible) continue;
        const je = ev.jobs.find(j => j.id === id);
        if (je.late) { earliest = Math.min(earliest, je.end); continue; }
        const newly = ev.jobs.find(j => j.late && j.id !== id && !lateSet.has(j.id));
        if (newly && !blame) blame = newly.id;
      }
      if (blame) return { tractor: u.spec.id, reason: 'deadline', blame };
      return { tractor: u.spec.id, reason: 'deadline', lateEnd: isFinite(earliest) ? earliest : null };
    });
  }

  // Force a job onto another tractor and report the consequences (for "why?").
  alternatives(assign, id) {
    const seqs = this.units.map(u => assign[u.spec.id].slice());
    const cur = this.totalCost(seqs);
    const owner = seqs.findIndex(s => s.includes(id));
    const removed = seqs.map((s, i) => (i === owner ? s.filter(x => x !== id) : s));
    const curTravel = this.units.map((uu, k) => this.evalUnit(uu, seqs[k])).reduce((a, e) => a + e.travel, 0);
    const curLate = new Set(this.units.flatMap((uu, k) => this.evalUnit(uu, seqs[k]).jobs.filter(j => j.late).map(j => j.id)));
    return this.units.map((u, i) => {
      if (i === owner) return { tractor: u.spec.id, current: true };
      const b = this.bestInsertion(removed, i, id);
      if (!isFinite(b.cost)) return { tractor: u.spec.id, feasible: false, reason: b.reason, blame: b.blame, lateEnd: b.lateEnd };
      const trial = removed.slice(); trial[i] = b.seq;
      const evals = this.units.map((uu, k) => this.evalUnit(uu, trial[k]));
      const travel = evals.reduce((a, e) => a + e.travel, 0);
      const jobEval = evals[i].jobs.find(j => j.id === id);
      const newlyLate = evals.flatMap(e => e.jobs.filter(j => j.late && !curLate.has(j.id)).map(j => j.id));
      return { tractor: u.spec.id, feasible: true, costDelta: b.cost - cur, travelDelta: travel - curTravel, end: jobEval.end, position: b.pos, newlyLate };
    });
  }
}

export { IMPLEMENT_FOR };
