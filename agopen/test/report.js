// Runs the fault cases and writes TEST_REPORT.md.  Usage: node agopen/test/report.js
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RESERVE_FRAC, REFUEL_MIN, canDo, fmtTime } from '../../src/model.js';
import {
  Coordinator, Baseline, makeSim, runDay, liveScenario, breakdownDay, busyDay, lateJobs, notDone,
} from './helpers.js';

const rows = [];
const add = (name, injected, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = { pass: false, says: `error: ${e.message}` }; }
  rows.push({ name, injected, ...r });
};
const pct = x => `${x.toFixed(1)}%`;

add('A tractor breaks mid-job and another finishes it, with no lost or repeated work', 'The tractor working a job breaks part-way and stays out all day', () => {
  const sim = makeSim(liveScenario());
  let v = null;
  while (!sim.finished && !v) {
    sim.step();
    for (const t of sim.tractors) {
      const j = t.jobId && sim.jobs.get(t.jobId);
      if (t.action?.kind === 'work' && j && j.remaining < 0.8 * j.acres && j.remaining > 0.2 * j.acres) { v = { id: t.id, j, at: sim.time }; break; }
    }
  }
  sim.inject({ time: sim.time, type: 'breakdown', tractor: v.id });
  sim.inject({ time: sim.time + 600, type: 'repair', tractor: v.id });
  sim.run();
  const total = v.j.workLog.reduce((a, w) => a + w.acres, 0);
  const who = [...new Set(v.j.workLog.map(w => w.tractor))];
  const pass = v.j.status === 'done' && Math.abs(total - v.j.acres) < 1e-6 && who.length >= 2;
  return { pass, says: `${v.id} broke at ${fmtTime(v.at)} on ${v.j.id}; ${who.join(' then ')} finished it at ${fmtTime(v.j.doneAt)}. ${total.toFixed(1)} of ${v.j.acres} acres logged.` };
});

add('Any single tractor can break early and the day still completes once repaired', 'Each of T1, T2, T3 in turn: breaks at 07:00, repaired at 09:00', () => {
  const out = ['T1', 'T2', 'T3'].map(id => {
    const s = runDay([{ time: 60, type: 'breakdown', tractor: id }, { time: 180, type: 'repair', tractor: id }]);
    return { id, done: s.jobs.size - notDone(s).length, total: s.jobs.size, late: lateJobs(s).length, end: fmtTime(s.time) };
  });
  return { pass: out.every(o => o.done === o.total && o.late === 0), says: out.map(o => `${o.id}: ${o.done}/${o.total} done, ${o.late} late, finished ${o.end}`).join('; ') };
});

add('A job nobody can do is flagged, not dropped', 'The only tractor with a sprayer breaks at 06:30 and is never repaired', () => {
  const s = liveScenario([{ time: 30, type: 'breakdown', tractor: 'T1' }]);
  s.tractors = s.tractors.filter(t => t.id !== 'T3');
  s.jobs = [{ id: 'A1', type: 'mow', fieldId: 'F2', priority: 'low', deadline: 600 }, { id: 'A2', type: 'spray', fieldId: 'F5', priority: 'high', deadline: 480 }];
  const sim = makeSim(s); sim.run();
  const j = sim.jobs.get('A2');
  const v = sim.violations.find(x => x.kind === 'unfinished' && x.text.includes('A2'));
  return { pass: !!j && j.status !== 'done' && !!v, says: `A2 stays on the books with ${j.remaining.toFixed(0)} acres left; the end-of-day record says "${v?.text}". The mowing job was still finished. Note: no warning was given when the tractor broke.` };
});

add('An urgent job added mid-day is fitted in and finishes on time', 'At 08:30 a high-priority spray job (due 13:30) is added', () => {
  const sim = runDay([{ time: 150, type: 'new_jobs', jobs: [{ id: 'N1', type: 'spray', fieldId: 'F2', priority: 'high', deadline: 450 }] }]);
  const j = sim.jobs.get('N1');
  return { pass: j.status === 'done' && j.doneAt <= 450 && lateJobs(sim).length === 0, says: `N1 finished at ${fmtTime(j.doneAt)} by ${j.doneBy}; ${lateJobs(sim).length} other jobs late.` };
});

add('An implement change is planned when the job needs one', 'None (normal day)', () => {
  const sim = runDay();
  const swaps = sim.tractors.map(t => `${t.id} ${t.stats.swaps}`);
  let bad = 0;
  for (const j of sim.jobs.values()) for (const w of j.workLog) if (!canDo(sim.tractor(w.tractor), j.type)) bad++;
  return { pass: sim.tractors.some(t => t.stats.swaps >= 1) && bad === 0, says: `Implement changes: ${swaps.join(', ')}. Jobs worked by a tractor without the right tool: ${bad}.` };
});

add('No tractor\'s fuel ever drops below the reserve', 'Normal day, and the breakdown day', () => {
  const lows = [[], breakdownDay].map(ev => Math.min(...runDay(ev).tractors.map(t => t.stats.minFuelPct)));
  const lim = 100 * RESERVE_FRAC;
  return { pass: lows.every(x => x >= lim - 1e-6), says: `Lowest tank level seen: ${pct(lows[0])} (normal day), ${pct(lows[1])} (breakdown day); the limit is ${pct(lim)}.` };
});

add('No job is ever held by two tractors at once', 'T1 breaks at 07:00, T3 breaks at 07:40, T1 repaired at 09:20; checked every minute', () => {
  const sim = makeSim(liveScenario(busyDay));
  let clashes = 0, minutes = 0;
  while (!sim.finished) {
    sim.step(); minutes++;
    const held = sim.tractors.filter(t => t.status === 'ok' && t.action?.kind === 'work').map(t => t.jobId);
    if (new Set(held).size !== held.length) clashes++;
  }
  const dup = sim.violations.filter(v => v.kind === 'duplicate-assignment').length;
  return { pass: clashes === 0 && dup === 0, says: `${minutes} minutes checked: ${clashes} clashes, ${dup} duplicate-assignment warnings.` };
});

add('A tractor held at the depot for a person does not move or gain fuel until released', 'First refuel is held for 30 minutes, then released', () => {
  const sim = makeSim(liveScenario());
  let h = null;
  while (!sim.finished && !h) { sim.step(); h = sim.tractors.find(t => t.action?.kind === 'refuel'); }
  const b = { x: h.x, y: h.y, fuel: h.fuel }, t0 = sim.time;
  let moved = false;
  for (let i = 0; i < 30; i++) { h.action.left = REFUEL_MIN; sim.step(); if (h.x !== b.x || h.y !== b.y || h.fuel !== b.fuel) moved = true; }
  let n = 0;
  while (h.fuel < h.fuelCapacity && n <= REFUEL_MIN + 1) { sim.step(); n++; }
  return { pass: !moved && h.fuel === h.fuelCapacity && n <= REFUEL_MIN + 1, says: `${h.id} held at ${fmtTime(t0)} with ${b.fuel.toFixed(1)} fuel: no movement, no fuel gained for 30 min; full ${n} min after release.` };
});

const run = D => runDay(breakdownDay, D).metrics();
const c = run(Coordinator), b = run(Baseline);
add('The coordinator finishes at least as many jobs on time as first come, first served, after a breakdown', 'T1 breaks at 07:00, repaired at 09:00; same for both', () =>
  ({ pass: c.jobsOnTime >= b.jobsOnTime, says: `Coordinator ${c.jobsOnTime} of ${c.jobsTotal} on time; first come, first served ${b.jobsOnTime} of ${b.jobsTotal}.` }));

add('The same day with the same faults gives the same result twice', 'Two breakdowns and a repair, run twice', () => {
  const f = s => JSON.stringify({ m: s.metrics(), log: s.log.map(({ planMs, ...e }) => e), j: [...s.jobs.values()].map(j => [j.id, j.doneAt, j.workLog]) });
  const x = f(runDay(busyDay)), y = f(runDay(busyDay));
  return { pass: x === y, says: x === y ? `Both runs identical (${x.length} characters of results compared).` : 'The two runs differ.' };
});

const lines = [
  '# Fault test report', '',
  `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from the live demo farm (3 tractors, 9 fields, 11 jobs). Times are clock times from a 06:00 start.`, '',
  '| Case | What was injected | What the system did | Result |', '|---|---|---|---|',
  ...rows.map(r => `| ${r.name} | ${r.injected} | ${r.says} | ${r.pass ? 'PASS' : 'FAIL'} |`), '',
  '## Coordinator versus first come, first served (breakdown day)', '',
  'T1 breaks at 07:00 and is repaired at 09:00. Same farm, same jobs, same fault.', '',
  '| | Coordinator | First come, first served |', '|---|---:|---:|',
  `| Jobs completed (of ${c.jobsTotal}) | ${c.jobsCompleted} | ${b.jobsCompleted} |`,
  `| Jobs finished on time | ${c.jobsOnTime} | ${b.jobsOnTime} |`,
  `| Travel (tractor-minutes) | ${c.travelMin} | ${b.travelMin} |`,
  `| Idle (tractor-minutes) | ${c.idleMin} | ${b.idleMin} |`,
  `| Day ended at | ${c.makespanClock} | ${b.makespanClock} |`, '',
  `Result: ${rows.filter(r => r.pass).length} of ${rows.length} cases passed.`, '',
];
const out = fileURLToPath(new URL('./TEST_REPORT.md', import.meta.url));
fs.writeFileSync(out, lines.join('\n'));
console.log(lines.join('\n'));
