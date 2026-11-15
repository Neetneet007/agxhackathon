// Named fault-injection cases. Run with: node --test agopen/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESERVE_FRAC, REFUEL_MIN, canDo } from '../../src/model.js';
import {
  Coordinator, Baseline, makeSim, runDay, liveScenario, breakdownDay, busyDay,
  lateJobs, notDone, stepTo,
} from './helpers.js';

const resv = 100 * RESERVE_FRAC - 1e-6;

test('A tractor breaks down mid-job and another finishes it, with no lost or repeated work', () => {
  const sim = makeSim(liveScenario());
  // Run until some tractor is part-way through a job (between 20% and 80% done), then break it.
  let victim = null;
  while (!sim.finished && !victim) {
    sim.step();
    for (const t of sim.tractors) {
      const j = t.jobId && sim.jobs.get(t.jobId);
      if (t.action?.kind === 'work' && j && j.remaining < 0.8 * j.acres && j.remaining > 0.2 * j.acres) { victim = { t, j }; break; }
    }
  }
  assert.ok(victim, 'found a tractor part-way through a job');
  const { j } = victim;
  const brokenId = victim.t.id;
  sim.inject({ time: sim.time, type: 'breakdown', tractor: brokenId });
  sim.inject({ time: sim.time + 600, type: 'repair', tractor: brokenId }); // not back for the rest of the day
  while (!sim.finished) sim.step();
  assert.equal(j.status, 'done', `${j.id} is completed`);
  const total = j.workLog.reduce((a, w) => a + w.acres, 0);
  assert.ok(Math.abs(total - j.acres) < 1e-6, `logged ${total} of ${j.acres} acres`);
  const who = new Set(j.workLog.map(w => w.tractor));
  assert.ok(who.size >= 2, `worked by ${[...who]}`);
  assert.ok(who.has(brokenId), 'the broken tractor did part of it before failing');
});

for (const id of ['T1', 'T2', 'T3']) {
  test(`Any single tractor can break early and the day still completes once it is repaired (${id})`, () => {
    const sim = runDay([{ time: 60, type: 'breakdown', tractor: id }, { time: 180, type: 'repair', tractor: id }]);
    assert.deepEqual(notDone(sim).map(j => j.id), [], 'every job is done');
    assert.deepEqual(lateJobs(sim).map(j => `${j.id} late by ${j.doneAt - j.deadline}`), [], 'no job finished after its deadline');
  });
}

// One tractor (T1) has the only sprayer; it breaks and is never repaired.
function stuckScenario() {
  const s = liveScenario([{ time: 30, type: 'breakdown', tractor: 'T1' }]);
  s.tractors = s.tractors.filter(t => t.id === 'T1' || t.id === 'T2'); // T2 has no sprayer
  s.jobs = [
    { id: 'A1', type: 'mow', fieldId: 'F2', priority: 'low', deadline: 600 },
    { id: 'A2', type: 'spray', fieldId: 'F5', priority: 'high', deadline: 480 },
  ];
  return s;
}

test('A job nobody can do is flagged, not dropped', () => {
  assert.ok(!canDo(liveScenario().tractors.find(t => t.id === 'T2'), 'spray'), 'T2 cannot spray');
  const sim = makeSim(stuckScenario());
  sim.run();
  const j = sim.jobs.get('A2');
  assert.ok(j, 'job still present');
  assert.notEqual(j.status, 'done');
  assert.ok(j.remaining > 0);
  assert.equal(sim.jobs.get('A1').status, 'done', 'the job T2 can do still gets done');
  const said = sim.violations.some(v => v.kind === 'unfinished' && v.text.includes('A2') && /not completed/.test(v.text));
  assert.ok(said, 'violations say A2 was not completed');
  const logged = sim.log.some(e => e.text.includes('A2') || /no further work/.test(e.text));
  assert.ok(logged, 'the log mentions it');
});

test('A job nobody can do is flagged to the operator at the moment of the breakdown, not only at end of day', { todo: 'Planner says "re-assigned" and stays silent about A2; the only warning is the end-of-day "not completed" entry' }, () => {
  const sim = makeSim(stuckScenario());
  while (sim.time <= 40) sim.step();
  const warned = sim.log.filter(e => e.time >= 30 && e.text.includes('A2') && /no tractor|nobody|cannot|can't|unassign|unscheduled|no one/i.test(e.text));
  assert.ok(warned.length > 0, 'a plain-language warning naming A2 as impossible');
});

test('An urgent job added mid-day is fitted in and finishes on time', () => {
  const sim = runDay([{ time: 150, type: 'new_jobs', jobs: [{ id: 'N1', type: 'spray', fieldId: 'F2', priority: 'high', deadline: 450 }] }]);
  const j = sim.jobs.get('N1');
  assert.ok(j, 'job exists');
  assert.equal(j.status, 'done');
  assert.ok(j.doneAt <= 450, `done at minute ${j.doneAt}, deadline 450`);
  assert.ok(j.workLog[0].start >= 150, 'work started after it was submitted');
  assert.deepEqual(lateJobs(sim).map(x => x.id), [], 'and nothing else was pushed late');
});

test('An implement change is planned when the job needs one', () => {
  const sim = runDay();
  const swaps = sim.tractors.map(t => t.stats.swaps);
  assert.ok(swaps.some(n => n >= 1), `swaps per tractor: ${swaps}`);
  for (const j of sim.jobs.values()) {
    for (const w of j.workLog) assert.ok(canDo(sim.tractor(w.tractor), j.type), `${w.tractor} has the implement for ${j.id}`);
  }
});

test('No tractor\'s fuel ever drops below the reserve (no faults, and with a breakdown)', () => {
  for (const events of [[], breakdownDay]) {
    const sim = runDay(events);
    for (const t of sim.tractors) assert.ok(t.stats.minFuelPct >= resv, `${t.id} low point ${t.stats.minFuelPct.toFixed(1)}% (events: ${events.length})`);
    assert.ok(!sim.violations.some(v => v.kind === 'fuel-reserve' || v.kind === 'out-of-fuel'));
  }
});

test('No job is ever held by two tractors at once', () => {
  const sim = makeSim(liveScenario(busyDay));
  while (!sim.finished) {
    sim.step();
    const held = sim.tractors.filter(t => t.status === 'ok' && t.action?.kind === 'work').map(t => t.jobId);
    assert.equal(new Set(held).size, held.length, `minute ${sim.time}: working jobs ${held}`);
  }
  assert.ok(!sim.violations.some(v => v.kind === 'duplicate-assignment'));
});

test('A tractor held at the depot for a person does not move and gains no fuel until released', () => {
  const sim = makeSim(liveScenario());
  let held = null;
  while (!sim.finished && !held) {
    sim.step();
    held = sim.tractors.find(t => t.action?.kind === 'refuel' && t.status === 'ok');
  }
  assert.ok(held, 'some tractor started refuelling');
  const before = { x: held.x, y: held.y, fuel: held.fuel };
  for (let i = 0; i < 30; i++) {
    assert.equal(held.action?.kind, 'refuel', `still refuelling at hold minute ${i}`);
    held.action.left = REFUEL_MIN;
    sim.step();
    assert.deepEqual({ x: held.x, y: held.y, fuel: held.fuel }, before, `unchanged at hold minute ${i}`);
  }
  let n = 0;
  while (held.fuel < held.fuelCapacity && n <= REFUEL_MIN + 1) { sim.step(); n++; }
  assert.equal(held.fuel, held.fuelCapacity, `full after ${n} minutes of release`);
  assert.ok(n <= REFUEL_MIN + 1);
});

test('The coordinator finishes at least as many jobs on time as first come, first served, after a breakdown', () => {
  const c = runDay(breakdownDay, Coordinator).metrics();
  const b = runDay(breakdownDay, Baseline).metrics();
  assert.ok(c.jobsOnTime >= b.jobsOnTime, `coordinator ${c.jobsOnTime} vs baseline ${b.jobsOnTime}`);
});

test('The same day with the same faults gives the same result twice', () => {
  const a = runDay(busyDay);
  const b = runDay(busyDay);
  const strip = s => JSON.stringify({ m: s.metrics(), log: s.log.map(({ planMs, ...e }) => e), // planMs is wall-clock timing, not part of the result
     jobs: [...s.jobs.values()].map(j => [j.id, j.doneAt, j.doneBy, j.workLog]) });
  assert.equal(strip(a), strip(b));
});
