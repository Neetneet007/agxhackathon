// Shared helpers for the fault tests and the report script.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulator } from '../../src/simulator.js';
import { Coordinator } from '../../src/coordinator.js';
import { Baseline } from '../../src/baseline.js';
import { TOOLS, applyTools } from '../rig.js';

export { Simulator, Coordinator, Baseline };

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Same set-up as the live demo: implements and work rates come from the tool profiles.
export function rig(scenario) {
  for (const t of scenario.tractors) {
    applyTools(t, t.implements.map(k => ({ profile: TOOLS[k][0], widthM: TOOLS[k][1] })), TOOLS[t.mounted][0]);
  }
  return scenario;
}

export function liveScenario(events = [], extra = {}) {
  const s = JSON.parse(fs.readFileSync(here('../scenario.live.json'), 'utf8'));
  rig(s);
  s.events = events.map(e => JSON.parse(JSON.stringify(e)));
  return Object.assign(s, extra);
}

export const makeSim = (scenario, Dispatcher = Coordinator) =>
  new Simulator(scenario, new Dispatcher(), { scriptedEvents: true });

export function runDay(events = [], Dispatcher = Coordinator, extra = {}) {
  const sim = makeSim(liveScenario(events, extra), Dispatcher);
  sim.run();
  return sim;
}

export const breakdownDay = [
  { time: 60, type: 'breakdown', tractor: 'T1' },
  { time: 180, type: 'repair', tractor: 'T1' },
];

// Two breakdowns and a repair (used for the "never two at once" case).
export const busyDay = [
  { time: 60, type: 'breakdown', tractor: 'T1' },
  { time: 100, type: 'breakdown', tractor: 'T3' },
  { time: 200, type: 'repair', tractor: 'T1' },
];

export const lateJobs = sim => [...sim.jobs.values()].filter(j => j.status === 'done' && j.doneAt > j.deadline);
export const notDone = sim => [...sim.jobs.values()].filter(j => j.status !== 'done');

// A job that was being worked at `minute` by whom: first tractor with an active work action.
export function stepTo(sim, minute) { while (!sim.finished && sim.time < minute) sim.step(); }
