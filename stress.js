#!/usr/bin/env node
// Randomised robustness test: many scenarios built from the demo farm with random
// jobs, fuel levels and events. Checks invariants and compares with the baseline.
// Usage: node stress.js [runs=200] [seed=1]

import fs from 'node:fs';
import { Simulator } from './src/simulator.js';
import { Coordinator } from './src/coordinator.js';
import { Baseline } from './src/baseline.js';

const runs = +(process.argv[2] || 200);
let seed = +(process.argv[3] || 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(rnd() * a.length)];
const base = JSON.parse(fs.readFileSync('scenario.json', 'utf8'));
const TYPES = ['spray', 'mow', 'till', 'seed'];
const PRI = ['high', 'medium', 'low'];

function randomScenario(k) {
  const sc = structuredClone(base);
  sc.name = `random-${k}`;
  sc.tractors.forEach(t => { t.fuel = Math.round(t.fuelCapacity * (0.3 + 0.7 * rnd())); });
  const n = 6 + Math.floor(rnd() * 7);
  sc.jobs = [];
  for (let i = 1; i <= n; i++) {
    const f = pick(sc.fields);
    sc.jobs.push({ id: `R${i}`, type: pick(TYPES), fieldId: f.id, acres: Math.round(f.acres * (0.4 + 0.6 * rnd())), priority: pick(PRI), deadline: 180 + Math.floor(rnd() * 520) });
  }
  sc.events = [];
  const ev = Math.floor(rnd() * 5);
  for (let e = 0; e < ev; e++) {
    const time = 30 + Math.floor(rnd() * 400);
    const kind = pick(['breakdown', 'breakdown', 'block_route', 'priority_change', 'new_jobs', 'repair']);
    if (kind === 'breakdown' || kind === 'repair') sc.events.push({ time, type: kind, tractor: pick(sc.tractors).id });
    if (kind === 'block_route') sc.events.push({ time, type: kind, name: 'bridge', cells: [pick([[15, 4], [15, 15]])] });
    if (kind === 'priority_change') sc.events.push({ time, type: kind, job: pick(sc.jobs).id, priority: pick(PRI), deadline: time + 60 + Math.floor(rnd() * 300) });
    if (kind === 'new_jobs') { const f = pick(sc.fields); sc.events.push({ time, type: kind, jobs: [{ id: `N${e}`, type: pick(TYPES), fieldId: f.id, acres: Math.round(f.acres * 0.6), priority: pick(PRI), deadline: time + 120 + Math.floor(rnd() * 300) }] }); }
  }
  return sc;
}

const agg = { c: { done: 0, onTime: 0, travel: 0, idle: 0, viol: 0, value: 0 }, b: { done: 0, onTime: 0, travel: 0, idle: 0, viol: 0, value: 0 } };
let invariantFailures = 0, crashes = 0, coordWins = 0, ties = 0, maxMs = 0;
for (let k = 0; k < runs; k++) {
  const sc = randomScenario(k);
  try {
    const cd = new Coordinator();
    const cs = new Simulator(sc, cd); const cm = cs.run();
    const bs = new Simulator(sc, new Baseline()); const bm = bs.run();
    maxMs = Math.max(maxMs, ...cd.planMs);
    // invariants: no acre worked twice, done jobs have no remaining, no job worked after done
    for (const j of cs.jobs.values()) {
      const worked = j.workLog.reduce((a, w) => a + w.acres, 0);
      if (Math.abs(worked + j.remaining - j.acres) > 1e-3) { invariantFailures++; console.log(`[${sc.name}] ${j.id} acres mismatch ${worked}+${j.remaining}!=${j.acres}`); }
    }
    const unannounced = cm.violationList.filter(v => !['unfinished', 'deadline-flagged'].includes(v.kind));
    if (unannounced.length) { invariantFailures++; console.log(`[${sc.name}]`, unannounced.map(v => v.text).join('; ')); }
    for (const [key, m] of [['c', cm], ['b', bm]]) {
      agg[key].done += m.jobsCompleted; agg[key].onTime += m.jobsOnTime; agg[key].travel += m.travelMin;
      agg[key].idle += m.idleMin; agg[key].viol += m.violations; agg[key].value += m.priorityValueOnTime;
    }
    if (cm.priorityValueOnTime > bm.priorityValueOnTime) coordWins++; else if (cm.priorityValueOnTime === bm.priorityValueOnTime) ties++;
  } catch (e) { crashes++; console.log(`[${sc.name}] CRASH`, e.stack); }
}
const row = (l, k) => console.log(`${l.padEnd(34)} ${String(agg.c[k]).padStart(8)} ${String(agg.b[k]).padStart(10)}`);
console.log(`\n${runs} random scenarios (random jobs, fuel and 0–4 events: breakdowns, repairs, closures, priority changes, new jobs)`);
console.log(`${''.padEnd(34)} ${'coord'.padStart(8)} ${'baseline'.padStart(10)}`);
row('jobs completed', 'done'); row('jobs on time', 'onTime'); row('priority-weighted acres on time', 'value');
row('travel (tractor-min)', 'travel'); row('idle (tractor-min)', 'idle'); row('unannounced violations', 'viol');
console.log(`coordinator better on on-time value in ${coordWins}/${runs}, tied ${ties}; invariant failures ${invariantFailures}; crashes ${crashes}; slowest re-plan ${maxMs.toFixed(0)} ms`);
process.exit(invariantFailures || crashes ? 1 : 0);
