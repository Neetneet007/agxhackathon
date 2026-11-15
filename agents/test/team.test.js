// The agent team: the eight tests from the team brief, against the fake live runner.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBOOK, RISK, ruleById, authorized } from '../weather/playbook.js';
import { startFakeRunner, makeRuntime, runClock, tmpDir, toMin, toClock, ALL_AGENTS, CLEAR } from './helpers.js';

let fakes = [], runtimes = [];
afterEach(async () => {
  for (const f of fakes) assert.deepEqual(f.forbidden, [], `forbidden endpoints called: ${f.forbidden.join(', ')}`);
  for (const rt of runtimes) rt.stop();
  for (const f of fakes) await f.stop();
  fakes = []; runtimes = [];
});

const TRACTORS = ['T1', 'T2', 'T3'].map((id, i) => ({ id, name: id, state: { code: 'STANDBY' }, mounted: 'sprayer', fuelPct: 95, queue: [], tel: { lat: 32.72 + i * 0.003, lon: -114.674, speedKph: 0 }, heardAgoMs: 200, planGapM: 3 }));
const JOBS = [
  { id: 'J1', label: 'J1 Spray North Field', type: 'spray', field: 'North Field', status: 'pending', priority: 'medium', deadline: '16:00', pct: 0 },
  { id: 'J2', label: 'J2 Mow Creek Pasture', type: 'mow', field: 'Creek Pasture', status: 'pending', priority: 'medium', deadline: '16:00', pct: 0 },
];
async function setup({ day, script, agents = ALL_AGENTS, holds = [], dataDir } = {}) {
  const fake = await startFakeRunner({ tractors: structuredClone(TRACTORS), jobs: structuredClone(JOBS) });
  for (const h of holds) fake.holds.set(h.id, h);
  fakes.push(fake);
  const rt = await makeRuntime({ runnerUrl: fake.url, day, script, agents, dataDir });
  runtimes.push(rt);
  return { fake, rt };
}
// What the Weather Manager sent, apart from its words.
const weatherActions = fake => fake.writes().filter(c => c.url !== '/agent/say' && !(c.url === '/event' && c.body?.source === 'plan-manager'))
  .map(c => (c.method === 'DELETE' ? `DELETE ${c.url}` : `POST ${c.url}${c.body?.type ? ` ${c.body.type}` : ''}${c.body?.id ? ` ${c.body.id}` : ''}${c.body?.name ? ` ${c.body.name}` : ''}`));
async function clearInspections(rt) {
  for (const it of rt.memoryGet('depot.inspections')?.value || []) if (it.status !== 'done') await rt.person('depot', 'inspection_done', { id: it.id, by: 'Sam (farm hand)' });
}

test('1. a rule with verified:false produces a Caution and no hold, recall or event', async () => {
  // Creek gauge over the placeholder limit, shear and wet soil: all unverified; no official alert.
  const { fake } = await setup({ agents: ['weather'], script: [{ at: '06:00', ...CLEAR }, { at: '06:05', ...CLEAR, wind2Mph: 4, wind10Mph: 9.5, creekGaugeM: 2.4, soilMoisturePct: 48 }] });
  const rtW = runtimes[0];
  await runClock(rtW, fake, '06:00', '06:15');
  assert.equal(fake.holdPosts().length, 0);
  assert.equal(fake.recallPosts().length, 0);
  assert.equal(fake.events.length, 0);
  const says = fake.says().map(s => s.body);
  assert.equal(says.length, 1);
  assert.equal(says[0].type, 'caution');
  assert.match(says[0].text, /drift-shear \(no verified source, advice only\).*wet-soil|wet-soil.*no verified source/);
  for (const r of PLAYBOOK.rules.filter(r => !authorized(r))) assert.ok(r.verified === false || !r.source.length);
});

for (const [day, until, expected] of [
  ['calm', '15:00', ['POST /hold wm-spray', 'DELETE /hold/wm-spray', 'POST /hold wm-spray']],
  ['monsoon', '09:00', ['POST /hold wm-spray', 'POST /recall wm-recall', 'DELETE /hold/wm-spray', 'POST /hold wm-lowfields', 'POST /event block_route North bridge', 'POST /event block_route South bridge']],
  ['hurricane', '07:00', ['POST /hold wm-types', 'POST /hold wm-all', 'DELETE /hold/wm-types', 'POST /recall wm-recall', 'POST /hold wm-field-north-field', 'DELETE /hold/wm-all', 'POST /event block_route North bridge', 'POST /event block_route South bridge']],
]) {
  test(`2. ${day} day: the expected actions, in order, with no repeats`, async () => {
    const { fake, rt } = await setup({ day });
    await runClock(rt, fake, '06:00', until);
    assert.deepEqual(weatherActions(fake), expected);
    // No message repeated within a minute, and no hold or recall posted again without a lift in between.
    const says = fake.trail.map(s => `${s.clock}|${s.from}|${s.to}|${s.text}`);
    assert.equal(new Set(says).size, says.length, 'no message said twice');
    const live = new Set();
    for (const a of weatherActions(fake)) {
      const id = a.split(/[ /]/).pop();
      if (a.startsWith('POST /hold') || a.startsWith('POST /recall')) { assert.ok(!live.has(id), `${id} posted twice`); live.add(id); }
      if (a.startsWith('DELETE')) live.delete(id);
    }
  });
}

test('3. hurricane: after the warning only the depot; after the all-clear nothing resumes until a person clears the inspections', async () => {
  const { fake, rt } = await setup({ day: 'hurricane' });
  await runClock(rt, fake, '06:00', '06:15'); // warning at 06:15
  assert.equal(fake.recalls.size, 1);
  const before = fake.writes().length;
  await runClock(rt, fake, '06:16', '08:00'); // storm 06:25, all-clear 06:45, then 75 minutes with nobody inspecting
  const after = fake.writes().slice(before);
  assert.equal(after.filter(c => c.url === '/event' && c.body?.type === 'priority_change').length, 0, 'no job is sent anywhere');
  assert.equal(fake.recallDeletes().length, 0, 'the recall is not ended by the all-clear');
  assert.equal(fake.recalls.size, 1);
  assert.ok(fake.holds.size >= 1, 'field holds stay');
  const insp = rt.memoryGet('depot.inspections').value.filter(i => i.episode);
  assert.ok(insp.some(i => i.kind === 'machine') && insp.some(i => i.kind === 'lane') && insp.some(i => i.kind === 'bridge') && insp.some(i => i.kind === 'field'));
  // The model may not mark inspections done; only a person can.
  const depot = rt.agents.find(a => a.name === 'depot');
  assert.equal(depot.mod.tools.find(t => t.name === 'mark_inspection_done').modelMay, false);
  // Half the inspections done: still nothing resumes.
  for (const it of insp.slice(0, 3)) await rt.person('depot', 'inspection_done', { id: it.id, by: 'Sam' });
  await runClock(rt, fake, '08:01', '08:05');
  assert.equal(fake.recalls.size, 1);
  await clearInspections(rt);
  await runClock(rt, fake, '08:06', '08:10');
  assert.equal(fake.recalls.size, 0);
  assert.equal([...fake.holds.keys()].filter(k => k.startsWith('wm-')).length, 0);
  assert.equal(fake.blocked.size, 0);
});

test('4. flood warning: bridges blocked, fleet recalled, and only the low fields held', async () => {
  const { fake, rt } = await setup({ day: 'monsoon' });
  await runClock(rt, fake, '06:00', '07:20'); // flood warning from 07:10
  assert.deepEqual([...fake.blocked].sort(), ['North bridge', 'South bridge']);
  assert.ok(fake.recalls.has('wm-recall'));
  const hold = fake.holds.get('wm-lowfields');
  assert.deepEqual(hold.fields, RISK.lowFields);
  assert.deepEqual(hold.jobTypes, ['*']);
  assert.ok(!fake.holds.has('wm-all'), 'not every field is held');
  const block = fake.events.find(e => e.type === 'block_route' && e.name === 'South bridge');
  assert.deepEqual(block.cells, [[15, 15]]);
});

test('5. two rules in conflict: the more cautious action wins, and the message says so', async () => {
  // Gusts 60 mph: high-wind (hold spray + recall) and drift-wind (hold spray) fire together.
  const { fake, rt } = await setup({ agents: ['weather'], script: [{ at: '06:00', ...CLEAR }, { at: '06:05', t2C: 25, t10C: 24.5, wind2Mph: 22, wind10Mph: 30, gustMph: 60, sustainedMph: 30 }] });
  await runClock(rt, fake, '06:00', '06:08');
  assert.equal(fake.recallPosts().length, 1);
  const msg = fake.says().map(s => s.body).find(b => b.type === 'recall');
  assert.match(msg.text, /Rules drift-wind and high-wind both apply; the more cautious wins \(high-wind\)/);
});

test('6. the Weather Manager never lifts a hold or recall it did not place', async () => {
  const others = [{ id: 'safety-stop', jobTypes: ['*'], fields: null, reason: 'Safety stop', by: 'Safety Officer' }, { id: 'person-hold', jobTypes: ['spray'], fields: null, reason: 'Operator', by: 'operator' }];
  const { fake, rt } = await setup({ day: 'monsoon', holds: others });
  fake.recalls.set('person-recall', { id: 'person-recall', reason: 'operator', by: 'operator' });
  await runClock(rt, fake, '06:00', '09:00');
  await clearInspections(rt);
  await runClock(rt, fake, '09:01', '09:30');
  const lifted = [...fake.holdDeletes(), ...fake.recallDeletes()].map(c => decodeURIComponent(c.url.split('/').pop()));
  assert.ok(lifted.length > 0);
  assert.ok(lifted.every(id => id.startsWith('wm-')), `lifted ${lifted.join(', ')}`);
  assert.ok(fake.holds.has('safety-stop') && fake.holds.has('person-hold') && fake.recalls.has('person-recall'));
  // The tool refuses too, whoever asks.
  const weather = rt.agents.find(a => a.name === 'weather');
  const run = { id: 'test', toolSeq: 0, toolCalls: 0, sent: 0, caller: 'model' };
  const r = await rt.callTool(weather, rt.context(weather, run), 'lift_hold', { id: 'safety-stop' });
  assert.match(r.error, /not placed by the Weather Manager/);
});

test('7. restart mid-storm: the recall is still in force and not posted twice', async () => {
  const dataDir = tmpDir();
  const { fake, rt } = await setup({ day: 'hurricane', dataDir });
  await runClock(rt, fake, '06:00', '06:30');
  assert.equal(fake.recallPosts().length, 1);
  rt.log.close(); runtimes.pop(); // the process dies mid-storm
  const rt2 = await makeRuntime({ runnerUrl: fake.url, day: 'hurricane', agents: ALL_AGENTS, dataDir });
  runtimes.push(rt2);
  assert.equal(rt2.memoryGet('weather.actions').value.recall.id, 'wm-recall');
  await runClock(rt2, fake, '06:31', '06:44');
  assert.equal(fake.recallPosts().length, 1, 'not posted twice');
  assert.ok(fake.recalls.has('wm-recall'));
  assert.equal(fake.holdPosts().filter(c => c.body.id === 'wm-all').length, 1);
});

test('8. every action message names a rule id whose source is present in the playbook', async () => {
  for (const day of ['calm', 'monsoon', 'hurricane']) {
    const { fake, rt } = await setup({ day });
    await runClock(rt, fake, '06:00', day === 'calm' ? '15:00' : '09:00');
    await clearInspections(rt);
    await runClock(rt, fake, '09:01', '09:10');
    const weatherSays = fake.says().map(s => s.body).filter(b => b.from === 'Weather Manager');
    assert.ok(weatherSays.length > 0);
    for (const b of weatherSays) {
      const ids = [...b.text.matchAll(/\[rule ([^\]]+)\]/g)].flatMap(m => m[1].split(/,\s*(?![^(]*\))/)).map(s => s.trim().split(' ')[0]);
      assert.ok(ids.length, `no rule named in: ${b.text}`);
      for (const id of ids) {
        const r = ruleById(id);
        assert.ok(r, `unknown rule ${id}`);
        if (['stop', 'recall', 'go'].includes(b.type)) assert.ok(authorized(r) || b.type === 'go', `action message cites unverified rule ${id}`);
        if (authorized(r)) assert.ok(r.source.every(s => s.url && s.dateRead && s.publisher));
      }
    }
    for (const h of fake.holdPosts().map(c => c.body).filter(b => b.by === 'Weather Manager')) assert.ok(authorized(ruleById(h.ruleId)), `hold ${h.id} without a verified rule`);
    fakes.splice(fakes.indexOf(fake), 1); rt.stop(); runtimes.splice(runtimes.indexOf(rt), 1); await fake.stop();
  }
});
