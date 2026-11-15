#!/usr/bin/env node
// Headless run: coordinator vs FCFS baseline on the same scenario and events.
// Usage: node cli.js [scenario.json] [--no-events] [--out out] [--why J3]

import fs from 'node:fs';
import path from 'node:path';
import { Simulator } from './src/simulator.js';
import { Coordinator } from './src/coordinator.js';
import { Baseline } from './src/baseline.js';
import { fmtTime } from './src/model.js';

const args = process.argv.slice(2);
const scenarioPath = args.find(a => a.endsWith('.json')) || 'scenario.json';
const scripted = !args.includes('--no-events');
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'out';
const whyIds = args.flatMap((a, i) => (a === '--why' ? [args[i + 1]] : []));
const quiet = args.includes('--quiet');

const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

function runOne(Dispatcher) {
  const d = new Dispatcher();
  const sim = new Simulator(scenario, d, { scriptedEvents: scripted });
  const m = sim.run();
  return { sim, d, m };
}

function formatLog(sim) {
  return sim.log.map(e => {
    let s = `[${e.clock}] ${e.type.toUpperCase().padEnd(6)} ${e.text}`;
    if (e.lines?.length) s += '\n' + e.lines.map(l => `                 • ${l}`).join('\n');
    if (e.footer) s += `\n                 ${e.footer}`;
    return s;
  }).join('\n');
}

const C = runOne(Coordinator);
const B = runOne(Baseline);

fs.writeFileSync(path.join(outDir, 'event_log.txt'), formatLog(C.sim) + '\n');
fs.writeFileSync(path.join(outDir, 'event_log_baseline.txt'), formatLog(B.sim) + '\n');
fs.writeFileSync(path.join(outDir, 'event_log.jsonl'), C.sim.log.map(e => JSON.stringify(e)).join('\n') + '\n');

const rows = [
  ['Jobs completed', 'jobsCompleted', 'hi'],
  ['…on time', 'jobsOnTime', 'hi'],
  ['…late (deadline missed)', 'jobsLate', 'lo'],
  ['Acres done on time', 'acresOnTime', 'hi'],
  ['Priority-weighted acres on time', 'priorityValueOnTime', 'hi'],
  ['Travel time (tractor-min)', 'travelMin', 'lo'],
  ['Idle time in the working day (tractor-min)', 'idleMin', 'lo'],
  ['Non-productive time: travel + idle (tractor-min)', 'nonProductiveMin', 'lo'],
  ['Spare capacity: tractor finished early (tractor-min)', 'spareMin', 'hi'],
  ['Refuel/recharge stops', 'fuelStops', 'lo'],
  ['Implement swaps', 'implementSwaps', 'lo'],
  ['Constraint violations (unannounced)', 'violations', 'lo'],
  ['Late jobs forecast & flagged at the event', 'lateFlagged', 'lo'],
];
const pct = (a, b) => (b === 0 ? (a === 0 ? '0%' : '—') : `${a - b > 0 ? '+' : ''}${Math.round(100 * (a - b) / b)}%`);
let md = `# Coordinator vs. FCFS baseline\n\nScenario: **${scenario.name}** (\`${scenarioPath}\`), ${scripted ? 'with' : 'without'} scripted events` +
  `${scripted ? ` (${(scenario.events || []).map(e => `${fmtTime(e.time)} ${e.type}`).join(', ')})` : ''}.\n\n` +
  `| Metric | Coordinator | FCFS baseline | Δ |\n|---|---:|---:|---:|\n`;
for (const [label, k] of rows) md += `| ${label} | ${C.m[k]} | ${B.m[k]} | ${pct(C.m[k], B.m[k])} |\n`;
md += `| All work finished at | ${C.m.makespanClock} | ${B.m.makespanClock} | |\n`;
md += `\n*Travel* = minutes driving, including depot trips. *Idle* = minutes a working tractor sat free (or waited for a busy field) while work it could do was still open, counted up to its last task of the day. Minutes after a tractor's last task are *spare capacity*: the tractor is released early and is free for new jobs. Broken-down minutes are excluded.\n`;
md += `\n**Coordinator re-plans:** ${C.d.replans} (avg ${(C.d.planMs.reduce((a, b) => a + b, 0) / C.d.planMs.length).toFixed(1)} ms, max ${Math.max(...C.d.planMs).toFixed(1)} ms)\n`;
md += `\n**Coordinator violations:** ${C.m.violationList.length ? C.m.violationList.map(v => `${fmtTime(v.time)} ${v.text}`).join('; ') : 'none'}\n`;
md += `\n**Baseline violations:** ${B.m.violationList.length ? B.m.violationList.map(v => `${fmtTime(v.time)} ${v.text}`).join('; ') : 'none'}\n`;
md += `\n## Per tractor (coordinator / baseline)\n\n| Tractor | Work | Travel | Idle+wait | Broken | Min fuel % |\n|---|---:|---:|---:|---:|---:|\n`;
for (const t of scenario.tractors) {
  const c = C.m.perTractor[t.id], b = B.m.perTractor[t.id];
  md += `| ${t.id} ${t.name} | ${c.work} / ${b.work} | ${c.travel} / ${b.travel} | ${c.idle + c.wait} / ${b.idle + b.wait} | ${c.broken} / ${b.broken} | ${c.minFuelPct} / ${b.minFuelPct} |\n`;
}
fs.writeFileSync(path.join(outDir, 'comparison.md'), md);
fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify({ coordinator: C.m, baseline: B.m }, null, 2));

if (!quiet) {
  console.log(formatLog(C.sim));
  console.log('\n' + md);
}
for (const id of whyIds) {
  console.log(`\nWHY ${id}?`);
  console.log(C.d.why(C.sim, id).join('\n'));
}
console.log(`\nWrote ${outDir}/event_log.txt, event_log_baseline.txt, event_log.jsonl, comparison.md, metrics.json`);
