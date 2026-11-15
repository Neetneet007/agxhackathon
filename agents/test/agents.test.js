// The thin agents' own rules: fault persistence, safety spacing, records, plan decisions.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFakeRunner, makeRuntime, runClock } from './helpers.js';

let fakes = [], runtimes = [];
afterEach(async () => {
  for (const f of fakes) assert.deepEqual(f.forbidden, []);
  for (const rt of runtimes) rt.stop();
  for (const f of fakes) await f.stop();
  fakes = []; runtimes = [];
});
async function setup(agents, opts = {}) {
  const fake = await startFakeRunner(opts); fakes.push(fake);
  const rt = await makeRuntime({ runnerUrl: fake.url, agents, script: [{ at: '06:00', t2C: 20, t10C: 19, wind2Mph: 5, wind10Mph: 6 }] }); runtimes.push(rt);
  return { fake, rt };
}
const tractor = (id, lat, code = 'WORKING', extra = {}) => ({ id, name: id, state: { code }, mounted: 'sprayer', fuelPct: 80, queue: [], tel: { lat, lon: -114.674, speedKph: 8 }, heardAgoMs: 200, planGapM: 3, ...extra });

test('Fault Manager: one bad reading is only watched; a symptom that persists gets a recommendation', async () => {
  const { fake, rt } = await setup(['fault'], { tractors: [tractor('T1', 32.73), tractor('T2', 32.74)] });
  await rt.tick();
  fake.tractors[0] = tractor('T1', 32.73, 'NO_RESPONSE', { heardAgoMs: 4000 });
  await rt.tick();                                  // one bad reading
  fake.tractors[0] = tractor('T1', 32.73);
  await rt.tick(); await rt.tick();
  assert.equal(fake.says().length, 0, 'no verdict from a single bad reading');
  fake.tractors[0] = tractor('T1', 32.73, 'NO_RESPONSE', { heardAgoMs: 5000 });
  for (let i = 0; i < 3; i++) await rt.tick();
  assert.equal(fake.says().length, 1);
  assert.match(fake.says()[0].body.text, /T1 looks out of service: no telemetry for 5 s/);
  assert.equal(fake.events.length, 0, 'the Fault Manager never declares a breakdown itself');
  fake.tractors[0] = tractor('T1', 32.73);
  for (let i = 0; i < 3; i++) await rt.tick();
  assert.match(fake.says()[1].body.text, /T1 looks back in service/);
});

test('Safety Officer: tractors too close for two checks stop all work; it lifts only its own stop once they are apart', async () => {
  const { fake, rt } = await setup(['safety'], { tractors: [tractor('T1', 32.7300), tractor('T2', 32.7301)] }); // ~11 m apart
  fake.holds.set('wm-spray', { id: 'wm-spray', jobTypes: ['spray'], by: 'Weather Manager', reason: 'x' });
  await rt.tick();
  assert.equal(fake.holdPosts().length, 0, 'not from one check');
  await rt.tick();
  assert.equal(fake.holdPosts().length, 1);
  assert.deepEqual(fake.holdPosts()[0].body.jobTypes, ['*']);
  assert.match(fake.holdPosts()[0].body.reason, /T1 and T2 are 11\.\d m apart, under the 15 m spacing limit/);
  fake.tractors[1] = tractor('T2', 32.7400);
  for (let i = 0; i < 4; i++) await rt.tick();
  assert.deepEqual(fake.holdDeletes().map(d => d.url), ['/hold/safety-stop'], 'only its own stop, never the weather hold');
});

test('Record Keeper: records jobs and stops as they happen, writes the day summary at 18:00', async () => {
  const jobs = [{ id: 'J1', label: 'J1 Spray North Field', type: 'spray', field: 'North Field', status: 'active', priority: 'high', deadline: '12:00', pct: 50, tractor: 'T1' }];
  const { fake, rt } = await setup(['records'], { jobs });
  await runClock(rt, fake, '10:00', '10:01');
  fake.holds.set('wm-spray', { id: 'wm-spray', jobTypes: ['spray'], fields: null, by: 'Weather Manager', reason: 'inversion', since: '10:02' });
  await runClock(rt, fake, '10:02', '10:03');
  fake.holds.clear(); fake.jobs[0].status = 'done';
  await runClock(rt, fake, '10:04', '10:05');
  assert.equal(rt.memoryGet('records.jobs').value[0].job, 'J1');
  assert.deepEqual(rt.memoryGet('records.stops').value.map(s => [s.id, s.started, s.ended]), [['wm-spray', '10:02', '10:04']]);
  await runClock(rt, fake, '18:00', '18:01');
  const { file } = rt.memoryGet('records.summaryWritten').value;
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /J1 J1 Spray North Field by T1/);
  assert.match(text, /10:02–10:04 hold wm-spray by Weather Manager: inversion/);
  assert.equal(fake.says().filter(s => s.body.type === 'summary').length, 1);
});

test('Plan Manager: flags a late job once and never approves or defers it by itself', async () => {
  const jobs = [{ id: 'J9', label: 'J9 Mow East Meadow', type: 'mow', field: 'East Meadow', status: 'pending', priority: 'medium', deadline: '09:00', pct: 20 }];
  const { fake, rt } = await setup(['plan'], { jobs });
  await runClock(rt, fake, '09:05', '09:20');
  const late = fake.says().filter(s => s.body.type === 'late');
  assert.equal(late.length, 1);
  assert.match(late[0].body.text, /J9 .* past its 09:00 deadline at 20% done/);
  assert.equal(fake.events.length, 0);
});
