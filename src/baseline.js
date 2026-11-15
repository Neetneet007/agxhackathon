// Starter dispatcher (baseline): first come, first served.
// A free tractor takes the earliest-submitted unclaimed job it has an implement
// for. No look-ahead, ignores priority and deadlines, never re-orders. It uses
// the same simulator, routing and refuel rule, so the comparison is fair.

import { canDo } from './model.js';

export class Baseline {
  constructor() { this.name = 'FCFS baseline'; this.claim = new Map(); this.skip = new Set(); this.order = []; }
  init(sim) { this.order = [...sim.jobs.keys()]; }
  onEvent(e, sim) {
    if (e.type === 'new_jobs') for (const j of e.jobs) if (!this.order.includes(j.id)) this.order.push(j.id);
    if (e.type === 'breakdown') this.claim.delete(e.tractor);
  }
  onJobDone(job, t) { this.claim.delete(t.id); }
  onInfeasible(t, job) { this.claim.delete(t.id); if (job) this.skip.add(t.id + ':' + job.id); }
  nextJob(t, sim) {
    const mine = this.claim.get(t.id);
    if (mine && !['done', 'cancelled'].includes(sim.jobs.get(mine)?.status)) return mine;
    const taken = new Set(this.claim.values());
    for (const id of this.order) {
      const j = sim.jobs.get(id);
      if (j.status === 'done' || j.status === 'cancelled' || taken.has(id) || this.skip.has(t.id + ':' + id) || !canDo(t, j.type)) continue;
      this.claim.set(t.id, id);
      return id;
    }
    this.claim.delete(t.id);
    return null;
  }
}
