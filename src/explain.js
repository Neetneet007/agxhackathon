// Plain-language explanations: what changed in a re-plan, and "why?" for any job.

import { fmtTime, IMPLEMENT_FOR, canDo } from './model.js';

const owners = plan => {
  const m = {};
  if (plan) for (const [tid, ids] of Object.entries(plan.assign)) for (const id of ids) m[id] = tid;
  return m;
};

function reasonText(r, sim, job) {
  const impl = IMPLEMENT_FOR[job.type];
  switch (r.reason) {
    case 'no-implement': return `${r.tractor} has no ${impl}`;
    case 'deadline':
      if (r.blame && r.blame !== job.id) return `${r.tractor} could fit it only by pushing ${r.blame} past its deadline`;
      return `${r.tractor} could not finish before ${fmtTime(job.deadline)}${r.lateEnd ? ` (earliest ${fmtTime(r.lateEnd)})` : ''}`;
    case 'fuel': return `${r.tractor} lacks the fuel range`;
    case 'unreachable': return `${r.tractor} cannot reach the field with current route closures`;
    case 'shift': return r.blame && r.blame !== job.id ? `${r.tractor} could fit it only by pushing ${r.blame} past the end of the shift` : `${r.tractor} could not finish before the end of the shift`;
    default: return `${r.tractor} has no room`;
  }
}

function capableNames(sim, job) {
  return sim.tractors.filter(t => t.status === 'ok' && canDo(t, job.type)).map(t => t.id);
}

function choiceReason(sim, planner, plan, id, owner) {
  const job = sim.jobs.get(id);
  const capable = capableNames(sim, job);
  if (capable.length === 1) return `only working tractor with a ${IMPLEMENT_FOR[job.type]}`;
  const alts = planner.alternatives(plan.assign, id).filter(a => !a.current);
  const feas = alts.filter(a => a.feasible).sort((a, b) => a.costDelta - b.costDelta);
  if (!feas.length) {
    const why = alts.map(a => (a.feasible === false ? reasonText(a, sim, job) : null)).filter(Boolean);
    return why.length ? `no other option: ${why.join('; ')}` : 'best fit';
  }
  const b = feas[0];
  const parts = [];
  const others = (b.newlyLate || []).filter(x => x !== id);
  if (b.end > job.deadline && plan.schedule[id].end <= job.deadline) parts.push(`${b.tractor} would miss the deadline (${fmtTime(b.end)})`);
  else if (b.end > plan.schedule[id].end + 1) parts.push(`${b.tractor} would finish it ${Math.round(b.end - plan.schedule[id].end)} min later`);
  if (others.length) parts.push(`make ${others.join(', ')} late`);
  if (b.travelDelta > 1) parts.push(`add ${Math.round(b.travelDelta)} min of driving`);
  if (!parts.length) parts.push(`${b.tractor} would delay its other work`);
  return parts.join(', ');
}

export function queueLine(sim, plan, tid) {
  const ids = plan.assign[tid] || [];
  if (!ids.length) return `${tid}: no work`;
  return `${tid}: ` + ids.map(id => `${sim.label(sim.jobs.get(id))} (${fmtTime(plan.schedule[id].start)}–${fmtTime(plan.schedule[id].end)})`).join(' → ');
}

export function explainReplan(prev, next, cause, sim, planner, safety, oldTravelNow = null) {
  const lines = [];
  const po = owners(prev), no = owners(next);
  const L = id => sim.label(sim.jobs.get(id));
  const eta = id => next.schedule[id] ? fmtTime(next.schedule[id].end) : '—';
  const covered = new Set();
  let headline = '';

  const moveLine = (id, extra = '') => {
    const job = sim.jobs.get(id);
    covered.add(id);
    if (!no[id]) return null;
    const r = choiceReason(sim, planner, next, id, no[id]);
    return `${L(id)} → ${no[id]}, finish ${eta(id)} (deadline ${fmtTime(job.deadline)})${extra}; ${r}.`;
  };

  switch (cause.type) {
    case 'initial': {
      headline = `Initial plan: ${Object.keys(no).length} of ${sim.openJobs().length} jobs scheduled, fleet done by ${fmtTime(next.finish)}.`;
      for (const tid of Object.keys(next.assign)) lines.push(queueLine(sim, next, tid));
      Object.keys(no).forEach(id => covered.add(id));
      break;
    }
    case 'breakdown': {
      const lost = (prev?.assign[cause.tractor] || []).filter(id => sim.jobs.get(id).status !== 'done');
      const kept = [...sim.jobs.values()].filter(j => j.status === 'done');
      headline = `${cause.tractor} broke down: ${lost.length} unfinished job(s) re-assigned, ${kept.length} completed job(s) unaffected.`;
      for (const id of lost) {
        const j = sim.jobs.get(id);
        const partial = j.remaining < j.acres - 1e-6 ? ` — keeps ${(j.acres - j.remaining).toFixed(1)} ac already done, ${j.remaining.toFixed(1)} ac left` : '';
        const l = moveLine(id, partial);
        if (l) lines.push(l);
      }
      break;
    }
    case 'repair': {
      const gained = (next.assign[cause.tractor] || []);
      headline = `${cause.tractor} back in service: takes over ${gained.length} job(s); fleet finish ${fmtTime(prev?.finish ?? 0)} → ${fmtTime(next.finish)}.`;
      for (const id of gained) { const l = moveLine(id, po[id] ? ` (from ${po[id]})` : ''); if (l) lines.push(l); }
      break;
    }
    case 'block_route': {
      headline = `Navigation re-routed around ${cause.name || 'the blocked route'}.`;
      const d = oldTravelNow || { open: {}, closed: {} };
      let oldSum = 0, any = false;
      for (const tid of Object.keys(next.evals)) {
        const a = d.open[tid], b = d.closed[tid];
        if (a == null || b == null) continue;
        oldSum += b;
        if (b - a > 2) { any = true; lines.push(`${tid}'s remaining route would need +${Math.round(b - a)} min of driving to detour via the other crossing.`); }
      }
      if (!any) lines.push('No remaining route used the closed crossing — no tractor affected.');
      else {
        const saved = oldSum - next.travel;
        lines.push(saved > 2 ? `Re-planned around it: re-ordering the work saves ${Math.round(saved)} min of that driving.` : 'Best response is to keep the job order and take the detour.');
      }
      break;
    }
    case 'priority_change': {
      const id = cause.job;
      const j = sim.jobs.get(id);
      headline = cause.allowLate && !cause.priority ? `Operator approved a late finish for ${L(id)}.` : `${L(id)} is now ${j.priority} priority, due ${fmtTime(j.deadline)}.`;
      if (no[id]) {
        const pos = next.assign[no[id]].indexOf(id) + 1;
        const before = prev?.schedule[id] ? fmtTime(prev.schedule[id].end) : 'unscheduled';
        lines.push(`${L(id)}: ${po[id] || 'none'} → ${no[id]} (position ${pos}), finish ${before} → ${eta(id)}.`);
        covered.add(id);
      }
      break;
    }
    case 'new_jobs': {
      headline = `${cause.jobs.length} new job(s) slotted into the plan.`;
      for (const nj of cause.jobs) {
        if (!no[nj.id]) continue;
        const pos = next.assign[no[nj.id]].indexOf(nj.id) + 1;
        const l = moveLine(nj.id, `, position ${pos} in queue`);
        if (l) lines.push(l);
      }
      break;
    }
    case 'cancel_job':
      headline = `Operator dropped ${cause.job}; its time is given back to the fleet (finish ${fmtTime(prev?.finish ?? 0)} → ${fmtTime(next.finish)}).`;
      break;
    case 'unblock_route':
      headline = `${cause.name || 'Route'} reopened: routes shortened, planned driving ${Math.round(prev?.travel ?? 0)} → ${Math.round(next.travel)} min.`;
      break;
    case 'infeasible':
      headline = `${cause.tractor} could not carry out ${cause.job} (${cause.reason}); re-planned.`;
      break;
    case 'job_done':
      headline = `Re-optimised after ${cause.job} finished.`;
      break;
    default:
      headline = 'Plan updated.';
  }

  // Any other assignment changes
  for (const id of Object.keys(no)) {
    if (covered.has(id)) continue;
    if (po[id] && po[id] !== no[id]) lines.push(`${L(id)} moved ${po[id]} → ${no[id]}, finish ${eta(id)} (${choiceReason(sim, planner, next, id, no[id])}).`);
    else if (!po[id] && prev) lines.push(`${L(id)} now scheduled on ${no[id]}, finish ${eta(id)}.`);
    else if (prev?.schedule[id]) {
      const shift = next.schedule[id].end - prev.schedule[id].end;
      if (Math.abs(shift) >= 30 && cause.type !== 'job_done') lines.push(`${L(id)} now finishes ${fmtTime(next.schedule[id].end)} (${shift > 0 ? '+' : ''}${Math.round(shift)} min).`);
    }
  }
  // Work that cannot be done on time — needs the operator. Report only what is new.
  const prevLate = new Set([...(prev?.late || []), ...(prev?.unassigned || [])].map(x => x.id));
  for (const u of next.late || []) {
    if (prevLate.has(u.id)) continue;
    const job = sim.jobs.get(u.id);
    const broken = sim.tractors.filter(t => t.status !== 'ok' && canDo(t, job.type)).map(t => `${t.id} is out of service`);
    const why = [...broken, ...u.why.map(r => reasonText(r, sim, job))];
    lines.push(u.approved
      ? `${L(u.id)} runs late as approved by the operator: ${u.tractor} finishes ${fmtTime(u.end)} (${Math.round(u.lateness)} min after deadline).`
      : `⚠ ${L(u.id)} can no longer make ${fmtTime(job.deadline)}: ${why.join('; ')}. Best option: ${u.tractor} finishes ${fmtTime(u.end)} (${Math.round(u.lateness)} min late). Needs operator sign-off — approve, or drop it to free ${u.tractor}.`);
  }
  const prevUn = new Set((prev?.unassigned || []).map(x => x.id));
  for (const u of next.unassigned) {
    if (prevUn.has(u.id)) continue;
    const job = sim.jobs.get(u.id);
    const broken = sim.tractors.filter(t => t.status !== 'ok' && canDo(t, job.type)).map(t => `${t.id} is out of service`);
    const why = [...broken, ...u.why.map(r => reasonText(r, sim, job))];
    lines.push(`⚠ ${L(u.id)} does not fit in today's shift: ${why.join('; ')}. Carried over — operator can drop other work or extend the shift.`);
  }
  const changed = lines.length > 0 || cause.type !== 'job_done';
  if (cause.type === 'job_done' && lines.length) headline = `Re-optimised after ${cause.job} finished: ${lines.length} change(s).`;
  const footer = `Fleet finish ${prev ? fmtTime(prev.finish) + ' → ' : ''}${fmtTime(next.finish)} · planned driving ${Math.round(next.travel)} min · safety check ${safety.ok ? 'passed' : 'FAILED'} (${safety.checks} checks${safety.warnings.length ? `, ${safety.warnings.length} warning(s)` : ''}).`;
  return { headline, lines, footer, changed, text: [headline, ...lines.map(l => '  • ' + l), '  ' + footer].join('\n') };
}

export function whyJob(sim, planner, plan, id) {
  const job = sim.jobs.get(id);
  if (!job) return [`Unknown job ${id}.`];
  const L = sim.label(job);
  const out = [];
  if (job.status === 'done') {
    const shares = {};
    for (const w of job.workLog) shares[w.tractor] = (shares[w.tractor] || 0) + w.acres;
    out.push(`${L} was completed by ${job.doneBy} at ${fmtTime(job.doneAt)} (deadline ${fmtTime(job.deadline)}).`);
    if (Object.keys(shares).length > 1) out.push(`Work was shared after a re-plan: ${Object.entries(shares).map(([t, a]) => `${t} ${a.toFixed(1)} ac`).join(', ')} — no acre worked twice.`);
    return out;
  }
  const un = plan.unassigned.find(u => u.id === id);
  if (un) {
    out.push(`${L} is not scheduled: no tractor can fit it into today's shift without breaking another job's deadline:`);
    for (const t of sim.tractors.filter(t => t.status !== 'ok')) out.push(`• ${t.id} is out of service.`);
    for (const r of un.why) out.push(`• ${reasonText(r, sim, job)}.`);
    out.push('Approve a late finish (or move the deadline) and it will be planned immediately.');
    return out;
  }
  const owner = Object.keys(plan.assign).find(t => plan.assign[t].includes(id));
  const s = plan.schedule[id];
  const lateInfo = (plan.late || []).find(l => l.id === id);
  if (lateInfo) {
    out.push(`${L} cannot make its ${fmtTime(job.deadline)} deadline any more:`);
    for (const t of sim.tractors.filter(t => t.status !== 'ok' && canDo(t, job.type))) out.push(`• ${t.id} is out of service.`);
    for (const r of lateInfo.why) out.push(`• ${reasonText(r, sim, job)}.`);
    out.push(`So it is kept as late-recovery work: ${owner} does it after its on-time jobs, finishing ${fmtTime(s.end)} (${Math.round(s.lateness)} min late). No on-time job was delayed to make room.`);
    return out;
  }
  const queue = plan.assign[owner];
  const pos = queue.indexOf(id);
  const t = sim.tractor(owner);
  out.push(`${L} is assigned to ${owner} ${t.name} (job ${pos + 1} of ${queue.length} in its queue).`);
  out.push(`Planned ${fmtTime(s.start)}–${fmtTime(s.end)}; deadline ${fmtTime(job.deadline)} → ${Math.round(job.deadline - s.end)} min to spare.${s.fuelAtStartPct != null ? ` Starts the field with ${Math.round(s.fuelAtStartPct)}% fuel.` : ''}`);
  out.push(`${owner} carries a ${IMPLEMENT_FOR[job.type]}${t.mounted === IMPLEMENT_FOR[job.type] ? ' (already mounted)' : ' (swap at depot is planned)'}.`);
  if (pos > 0) out.push(`Before it in ${owner}'s queue: ${queue.slice(0, pos).map(x => { const j = sim.jobs.get(x); return `${x} (${j.priority}, due ${fmtTime(j.deadline)})`; }).join(', ')}.`);
  out.push('Alternatives considered:');
  for (const a of planner.alternatives(plan.assign, id)) {
    if (a.current) continue;
    const ot = sim.tractor(a.tractor);
    if (a.feasible === false) out.push(`• ${reasonText(a, sim, job)}.`);
    else {
      const bits = [];
      if (a.end > job.deadline) bits.push(`would finish ${fmtTime(a.end)}, ${Math.round(a.end - job.deadline)} min after the deadline`);
      else bits.push(`would finish ${fmtTime(a.end)}${s && a.end > s.end + 1 ? ` (${Math.round(a.end - s.end)} min later)` : ''}`);
      const others = (a.newlyLate || []).filter(x => x !== id);
      if (others.length) bits.push(`would make ${others.join(', ')} miss ${others.length > 1 ? 'their deadlines' : 'its deadline'}`);
      if (Math.abs(a.travelDelta) >= 1) bits.push(`${a.travelDelta > 0 ? 'adds' : 'saves'} ${Math.round(Math.abs(a.travelDelta))} min of fleet driving`);
      if (bits.length === 1 && a.end <= job.deadline) bits.push('pushes back other queued work');
      out.push(`• ${a.tractor} ${ot.name}: ${bits.join('; ')} — rejected.`);
    }
  }
  for (const bt of sim.tractors.filter(x => x.status !== 'ok')) out.push(`• ${bt.id} ${bt.name}: out of service.`);
  return out;
}
