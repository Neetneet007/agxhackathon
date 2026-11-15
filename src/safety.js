// Safety Agent: independently checks a plan before it is released to tractors.
// Hard violations block the plan; warnings are surfaced to the operator.

import { canDo, IMPLEMENT_FOR, RESERVE_FRAC, fmtTime } from './model.js';

export function checkPlan(plan, sim) {
  const violations = [], warnings = [];
  const seen = new Map();
  let checks = 0;
  const lateIds = new Set((plan.late || []).map(l => l.id));
  for (const [tid, ids] of Object.entries(plan.assign)) {
    const t = sim.tractor(tid);
    const ev = plan.evals[tid];
    checks++;
    if (ids.length && t.status !== 'ok') violations.push(`${tid} is out of service but has ${ids.length} job(s)`);
    if (ids.length && !ev.feasible) violations.push(`${tid}'s route is not executable (${ev.reason} on ${ev.jobId})`);
    for (const id of ids) {
      checks += 4;
      const job = sim.jobs.get(id);
      if (seen.has(id)) violations.push(`${id} assigned to both ${seen.get(id)} and ${tid}`);
      seen.set(id, tid);
      if (!job) { violations.push(`${id} does not exist`); continue; }
      if (job.status === 'done') violations.push(`${id} is already complete but still scheduled`);
      if (!canDo(t, job.type)) violations.push(`${tid} has no ${IMPLEMENT_FOR[job.type]} for ${id}`);
      const s = plan.schedule[id];
      if (s && s.late && !job.allowLate && !lateIds.has(id)) violations.push(`${id} would finish ${fmtTime(s.end)}, after its ${fmtTime(job.deadline)} deadline`);
      if (s && s.late && (job.allowLate || lateIds.has(id))) warnings.push(`${id} will finish ${Math.round(s.lateness)} min after its deadline — ${job.allowLate ? 'approved by operator' : 'needs operator sign-off'}`);
    }
    if (ev.feasible && ev.minFuelPct < RESERVE_FRAC * 100 - 0.5) violations.push(`${tid} would dip to ${ev.minFuelPct.toFixed(0)}% fuel (reserve is ${RESERVE_FRAC * 100}%)`);
  }
  // Two tractors on one field at the same time
  const evs = Object.entries(plan.evals).filter(([, e]) => e.feasible);
  for (let a = 0; a < evs.length; a++) for (let b = a + 1; b < evs.length; b++) {
    for (const ja of evs[a][1].jobs) for (const jb of evs[b][1].jobs) {
      if (ja.fieldId !== jb.fieldId) continue;
      checks++;
      for (const [s1, e1] of ja.intervals) for (const [s2, e2] of jb.intervals) {
        if (Math.min(e1, e2) > Math.max(s1, s2)) warnings.push(`${evs[a][0]} and ${evs[b][0]} both planned on field ${ja.fieldId} around ${fmtTime(Math.max(s1, s2))} — field interlock will hold one back`);
      }
    }
  }
  // No lost work: every open job is either scheduled or explicitly flagged
  const flagged = new Set(plan.unassigned.map(u => u.id));
  for (const job of sim.openJobs()) {
    checks++;
    if (!seen.has(job.id) && !flagged.has(job.id)) violations.push(`${job.id} is open but neither scheduled nor flagged`);
  }
  return { ok: violations.length === 0, violations, warnings: [...new Set(warnings)], checks };
}
