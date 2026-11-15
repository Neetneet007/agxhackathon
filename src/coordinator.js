// AI Farm Orchestrator: wires the Fleet, Navigation and Safety agents together,
// re-plans on every event, and explains each new plan in plain language.

import { FleetPlanner } from './fleet.js';
import { checkPlan } from './safety.js';
import { explainReplan, whyJob } from './explain.js';

export class Coordinator {
  constructor() { this.name = 'Coordinator'; this.plan = null; this.planner = null; this.replans = 0; this.planMs = []; this.flaggedLate = new Map(); }

  init(sim) { this.replan(sim, { type: 'initial' }); }

  _units(sim) {
    return sim.tractors.filter(t => t.status === 'ok').map(t => {
      const start = { x: t.x, y: t.y, fuel: t.fuel, mounted: t.mounted, t0: sim.time, busy: null };
      if (t.action?.kind === 'refuel') { start.fuel = t.fuelCapacity; start.t0 = sim.time + t.action.left; start.busy = 'refuel'; }
      if (t.action?.kind === 'swap') { start.mounted = t.action.impl; start.t0 = sim.time + t.action.left; start.busy = 'swap'; }
      const pinned = t.action?.kind === 'work' && t.jobId && sim.jobs.get(t.jobId)?.status !== 'done' ? t.jobId : null;
      return { spec: t, start, pinned };
    });
  }

  _jobs(sim) {
    return new Map(sim.openJobs().map(j => [j.id, {
      id: j.id, type: j.type, fieldId: j.fieldId, field: sim.jobField(j), remaining: j.remaining,
      deadline: j.deadline, priority: j.priority, allowLate: j.allowLate,
    }]));
  }

  replan(sim, cause) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const prev = this.plan;
    const planner = new FleetPlanner({
      units: this._units(sim), jobs: this._jobs(sim), nav: sim.nav, depot: sim.depot, now: sim.time,
      prevAssign: prev?.assign, lateWork: sim.scenario.policy?.lateWork ?? 'schedule', shiftEnd: sim.horizon,
    });
    // Detour cost of the *old* plan: same positions, with and without the closure.
    this._prevForDetour = null;
    if (prev && cause.type === 'block_route') {
      sim.nav.unblock(cause.cells); planner.cache.clear();
      const open = planner.totalTravelOf(prev.assign);
      sim.nav.block(cause.cells, cause.name || 'route'); planner.cache.clear();
      this._prevForDetour = { open, closed: planner.totalTravelOf(prev.assign) };
    }
    // A job already being worked can't be un-started: never let it make the plan infeasible.
    for (const u of planner.units) if (u.pinned) planner.jobs.get(u.pinned).pinned = true;
    const plan = planner.plan();
    for (const l of plan.late) if (!this.flaggedLate.has(l.id)) this.flaggedLate.set(l.id, { time: sim.time, cause: cause.type });
    for (const t of sim.tractors) if (!(t.id in plan.assign)) plan.assign[t.id] = [];
    for (const t of sim.tractors) if (!(t.id in plan.evals)) plan.evals[t.id] = { feasible: true, jobs: [], legs: [], travel: 0, end: sim.time, minFuelPct: 100 };
    plan.time = sim.time;
    const safety = checkPlan(plan, sim);
    if (!safety.ok) {
      // Never release an unsafe plan: hold affected tractors and alert.
      sim.emit('safety', `SAFETY HOLD: ${safety.violations.join('; ')}`, { violations: safety.violations });
      for (const v of safety.violations) sim.violations.push({ time: sim.time, kind: 'plan-safety', text: v });
    }
    const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    this.planMs.push(ms);
    this.plan = plan; this.planner = planner; this.safety = safety; this.replans++;
    const ex = explainReplan(prev, plan, cause, sim, planner, safety, this._prevForDetour);
    if (ex.changed) {
      sim.emit('plan', ex.headline, { lines: ex.lines, footer: ex.footer, cause: cause.type, planMs: Math.round(ms), warnings: safety.warnings });
    }
    // Redirect any tractor driving toward a job that is no longer its next one.
    for (const t of sim.tractors) {
      if (!t.jobId || t.jobId === this.head(t) || t.action?.kind === 'work') continue;
      if (t.action?.kind === 'goto' && t.action.purpose === 'job') t.action = null;
      t.jobId = null; // release the claim; a refuel/swap in progress just finishes
    }
    return ex;
  }

  head(t) { return (this.plan?.assign[t.id] || [])[0] ?? null; }

  onEvent(e, sim) { this.replan(sim, e); }

  onJobDone(job, t, sim) {
    for (const ids of Object.values(this.plan.assign)) { const i = ids.indexOf(job.id); if (i >= 0) ids.splice(i, 1); }
    // Re-optimise against reality (actual vs planned durations); only logged if something moves.
    this.replan(sim, { type: 'job_done', job: job.id });
  }

  onInfeasible(t, job, reason, sim) {
    if (!job) return;
    const ids = this.plan.assign[t.id];
    const i = ids.indexOf(job.id); if (i >= 0) ids.splice(i, 1);
    if (reason !== 'done') this.replan(sim, { type: 'infeasible', tractor: t.id, job: job.id, reason });
  }

  nextJob(t, sim) {
    if (!this.safety?.ok && this.safety?.violations.some(v => v.startsWith(t.id))) return null;
    const ids = this.plan.assign[t.id] || [];
    while (ids.length && ['done', 'cancelled'].includes(sim.jobs.get(ids[0])?.status)) ids.shift();
    return ids[0] ?? null;
  }

  why(sim, id) { return whyJob(sim, this.planner, this.plan, id); }
}
