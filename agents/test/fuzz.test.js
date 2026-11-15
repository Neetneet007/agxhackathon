// Randomised days for the whole team (the eight agents plus the Agronomy Advisor) against the fake
// live runner. Each seed builds a different day: random weather (including missing and impossible
// readings and alerts nobody has heard of), tractors that crowd each other, run low on fuel, go
// silent or report nothing at all, jobs that start and finish, a runner that sometimes answers 404,
// restarts from the durable log, people clearing inspections, and questions put to the team.
// After every day the same invariants must hold.
//   FUZZ_RUNS=200 FUZZ_SEED=1 node --test agents/test/fuzz.test.js      (default 12 days from seed 1)
// A failure prints its seed; FUZZ_RUNS=1 FUZZ_SEED=<seed> replays exactly that day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ruleById, authorized } from '../weather/playbook.js';
import { ask, route } from '../runtime/ask.js';
import { startFakeRunner, makeRuntime, tmpDir, toClock, ALL_AGENTS } from './helpers.js';

const RUNS = Number(process.env.FUZZ_RUNS || 12), SEED0 = Number(process.env.FUZZ_SEED || 1), TICKS = Number(process.env.FUZZ_TICKS || 90);
const TEAM = [...ALL_AGENTS, 'agronomy'];
const scenario = JSON.parse(fs.readFileSync(new URL('../../scenario.json', import.meta.url), 'utf8'));

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ALERTS = ['Flash Flood Warning', 'Flash Flood Watch', 'Flood Watch', 'Flood Warning', 'Freeze Warning', 'Frost Advisory', 'High Wind Warning', 'Wind Advisory', 'Dust Storm Warning', 'Severe Thunderstorm Warning', 'Hurricane Watch', 'Hurricane Warning', 'Tropical Storm Warning', 'Evacuation Order', 'Excessive Heat Warning', 'Zombie Advisory', ''];
const CODES = ['WORKING', 'WORKING', 'WORKING', 'STANDBY', 'DRIVING', 'NO_RESPONSE', 'GO_NOT_MOVING', 'AT_DEPOT'];
const QUESTIONS = ['Can I spray North Field right now?', 'Which tractor is low on fuel?', 'Is anything broken down?', 'What soil is Bottomland on?', 'Why is the fleet stopped?', 'Which jobs are running late?', 'What got done today?', 'Who is waiting at the depot?', 'How should I irrigate the alfalfa?', 'When do I harvest the wheat?', 'What fertiliser rate for corn?', 'Are the bridges open?', 'Tell me about cattle', 'asdf qwerty', '', 'Is it safe to mow East Meadow before the rain?', 'What is the wind?', 'How far is the route for J1?'];

function buildDay(r) {
  const pick = a => a[Math.floor(r() * a.length)], chance = p => r() < p, between = (a, b) => a + r() * (b - a);
  const junk = () => pick([null, undefined, NaN, -999, 9999, 'n/a', {}, Infinity]);
  const reading = () => {
    const t2 = between(-6, 46), w = between(0, 45);
    const o = { t2C: +t2.toFixed(1), t10C: +(t2 + between(-3, 4)).toFixed(1), wind2Mph: +w.toFixed(1), wind10Mph: +(w * between(1, 1.5)).toFixed(1), gustMph: +(w * between(1, 2)).toFixed(1), sustainedMph: +w.toFixed(1) };
    if (chance(0.25)) o.lightningMi = +between(0, 30).toFixed(1);
    if (chance(0.25)) o.creekGaugeM = +between(0, 3).toFixed(2);
    if (chance(0.2)) o.visibilityMi = +between(0, 10).toFixed(1);
    if (chance(0.2)) o.heatIndexF = Math.round(between(60, 125));
    if (chance(0.2)) o.soilMoisturePct = Math.round(between(0, 60));
    if (chance(0.15)) o.aqiPm25 = Math.round(between(0, 400));
    if (chance(0.2)) o.forecast = { rainWithinHours: chance(0.5) ? +between(0, 12).toFixed(1) : null };
    if (chance(0.5)) o.alerts = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(ALERTS));
    if (chance(0.18)) for (const k of Object.keys(o)) if (chance(0.3) && k !== 'alerts' && k !== 'forecast') o[k] = junk();   // a broken station
    if (chance(0.06)) for (const k of ['t2C', 't10C', 'wind2Mph', 'wind10Mph']) delete o[k];
    return o;
  };
  const times = [...new Set([0, ...Array.from({ length: 3 + Math.floor(r() * 7) }, () => Math.floor(r() * TICKS))])].sort((a, b) => a - b);
  const script = times.map(m => ({ at: toClock(360 + m), ...reading() }));
  const tractor = (id, i) => ({ id, name: id, state: { code: 'STANDBY' }, mounted: pick(['sprayer', 'mower', 'tiller', 'seeder']), fuelPct: Math.round(between(8, 100)), queue: [], tel: { lat: 32.72 + i * 0.003, lon: -114.674, speedKph: 0 }, heardAgoMs: 200, planGapM: 3 });
  const tractors = ['T1', 'T2', 'T3'].map(tractor);
  const jobs = Array.from({ length: 3 + Math.floor(r() * 6) }, (_, i) => {
    const f = pick(scenario.fields), type = pick(['spray', 'mow', 'till', 'seed']);
    return { id: `J${i + 1}`, label: `J${i + 1} ${type} ${f.name}`, type, field: f.name, status: 'pending', priority: pick(['high', 'medium', 'low']), deadline: toClock(360 + Math.floor(between(20, 600))), pct: 0, tractor: '' };
  });
  return { script, tractors, jobs, pick, chance, between };
}

for (let n = 0; n < RUNS; n++) {
  const seed = SEED0 + n;
  test(`random day, seed ${seed}: the team's invariants hold`, async () => {
    const r = rng(seed * 7919 + 13);
    const day = buildDay(r), { pick, chance, between } = day;
    const fake = await startFakeRunner({ tractors: day.tractors, jobs: day.jobs });
    // Things a person placed. No agent may lift them.
    fake.holds.set('operator-hold', { id: 'operator-hold', jobTypes: ['till'], by: 'Operator', reason: 'placed by a person' });
    fake.recalls.set('operator-recall', { id: 'operator-recall', by: 'Operator', reason: 'placed by a person' });
    const dataDir = tmpDir();
    const boot = () => makeRuntime({ runnerUrl: fake.url, agents: TEAM, script: day.script, dataDir });
    let rt = await boot(), restarts = 0, asked = 0;
    const where = () => `seed ${seed} at ${fake.clock}`;
    try {
      for (let m = 0; m <= TICKS; m++) {
        fake.clock = toClock(360 + m);
        // --- the world moves
        for (const [i, t] of fake.tractors.entries()) {
          if (chance(0.12)) t.state = { code: pick(CODES) };
          if (chance(0.3)) t.fuelPct = Math.max(0, Math.min(100, t.fuelPct + (chance(0.08) ? 60 : -between(0, 4))));
          if (chance(0.15)) t.tel = { lat: 32.72 + (chance(0.25) ? 0 : i * 0.003) + between(-0.00005, 0.00005), lon: -114.674, speedKph: +between(0, 12).toFixed(1) };
          if (chance(0.1)) t.heardAgoMs = Math.round(between(100, 9000));
          if (chance(0.1)) t.planGapM = +between(0, 80).toFixed(1);
          if (chance(0.02)) t.tel = null;                    // a tractor that reports nothing at all
          if (chance(0.02)) delete t.fuelPct; else if (t.fuelPct == null) t.fuelPct = 50;
        }
        for (const j of fake.jobs) {
          if (j.status === 'pending' && chance(0.06)) { j.status = 'active'; j.tractor = pick(['T1', 'T2', 'T3']); }
          else if (j.status === 'active') { j.pct = Math.min(100, j.pct + Math.round(between(0, 9))); if (j.pct >= 100) j.status = 'done'; }
        }
        if (chance(0.05)) fake.tasks = chance(0.5) ? [] : [{ id: `K${m}`, tractor: pick(['T1', 'T2', 'T3']), kind: pick(['refuel', 'implement']), text: 'at the depot', state: 'waiting', since: toClock(360 + Math.max(0, m - Math.floor(between(0, 40)))) }];
        if (chance(0.04)) fake.hold = fake.hold === 'ok' ? '404' : 'ok';       // a runner that loses an endpoint for a while
        if (chance(0.04)) fake.say = fake.say === 'ok' ? '404' : 'ok';
        // --- a restart from the durable log
        if (chance(0.03)) { rt.stop(); rt = await boot(); restarts++; }
        // --- the team takes its turn; nothing may throw
        await assert.doesNotReject(() => rt.tick(), `tick threw, ${where()}`);
        // --- a person clears an inspection now and then
        const open = (rt.memory.get('depot.inspections')?.value || []).filter(i => i.status !== 'done');
        if (open.length && chance(0.15)) await rt.person('depot', 'inspection_done', { id: pick(open).id, by: 'Sam' });
        // --- someone asks the team a question: always an answer, never an action
        if (chance(0.08)) {
          const before = fake.writes().length, q = pick(QUESTIONS), who = chance(0.3) ? pick(TEAM) : undefined;
          const a = await ask(rt, { question: q, agent: who });
          asked++;
          if (q.trim()) { assert.equal(a.ok, true, `${where()}: ask failed for "${q}"`); assert.ok(a.text.length > 10, `${where()}: empty answer to "${q}"`); assert.ok(!/undefined|NaN|\[object/.test(a.text), `${where()}: leaked a raw value answering "${q}": ${a.text}`); }
          else assert.equal(a.ok, false);
          assert.equal(fake.writes().length, before, `${where()}: asking "${q}" sent something to the runner`);
        }
      }
      // let anything held back by the 404s go out
      fake.hold = 'ok'; fake.say = 'ok';
      for (let i = 0; i < 6; i++) { fake.clock = toClock(360 + TICKS + 1 + i); await rt.tick(); await new Promise(res => setTimeout(res, 5)); }

      const ctx = `seed ${seed} (${restarts} restart(s), ${asked} question(s), ${fake.writes().length} writes)`;
      // 1. Nothing off the allowlist was ever called.
      assert.deepEqual(fake.forbidden, [], `${ctx}: forbidden calls`);
      const unknown = fake.writes().filter(c => !(/^\/(hold|recall|agent\/say|event)$/.test(c.url) || /^\/(hold|recall)\/.+/.test(c.url)));
      assert.deepEqual(unknown.map(c => `${c.method} ${c.url}`), [], `${ctx}: calls outside the allowlist`);
      // 2. Only the four allowed event types.
      for (const c of fake.writes().filter(c => c.url === '/event')) assert.ok(['priority_change', 'cancel_job', 'block_route', 'unblock_route'].includes(c.body?.type), `${ctx}: event ${c.body?.type}`);
      // 3. What a person placed is still there, and every lift is of something an agent placed itself.
      assert.ok(fake.holds.has('operator-hold'), `${ctx}: a person's hold was lifted`);
      assert.ok(fake.recalls.has('operator-recall'), `${ctx}: a person's recall was lifted`);
      const placed = new Map();
      for (const c of fake.calls) {
        if (c.method === 'POST' && (c.url === '/hold' || c.url === '/recall')) placed.set(`${c.url}/${c.body.id}`, c.body.by);
        if (c.method === 'DELETE') assert.ok(placed.has(decodeURIComponent(c.url)), `${ctx}: lifted ${c.url}, which no agent placed`);
      }
      // 4. The Agronomy Advisor only ever advises.
      for (const c of fake.writes()) {
        if (c.body?.by === 'Agronomy Advisor') assert.fail(`${ctx}: the Agronomy Advisor placed ${c.url}`);
        if (c.url === '/agent/say' && c.body.from === 'Agronomy Advisor') { assert.equal(c.body.type, 'advice'); assert.match(c.body.text, /advice only, not checked against a source\]$/); }
      }
      // 5. Every weather stop or recall names rules that exist, are verified and carry a source.
      for (const b of fake.says().map(s => s.body).filter(b => b.from === 'Weather Manager' && ['stop', 'recall'].includes(b.type))) {
        const ids = [...b.text.matchAll(/\[rule ([^\]]+)\]/g)].flatMap(x => x[1].split(/,\s*(?![^(]*\))/)).map(s => s.trim().split(' ')[0]);
        assert.ok(ids.length, `${ctx}: weather ${b.type} names no rule: ${b.text}`);
        for (const id of ids) { assert.ok(ruleById(id), `${ctx}: unknown rule ${id}`); assert.ok(authorized(ruleById(id)), `${ctx}: ${b.type} cites unverified rule ${id}`); }
      }
      // 6. Words fit the runner's 400-character line.
      for (const s of fake.says()) assert.ok(s.body.text.length <= 400, `${ctx}: a ${s.body.text.length}-character line`);
      // 7. No side effect was sent twice, across 404s and restarts: one success per effect, one effect per success.
      const done = new Map();
      for (const e of rt.log.entries) if (e.kind === 'effect_done') done.set(e.id, (done.get(e.id) || 0) + 1);
      assert.deepEqual([...done].filter(([, k]) => k > 1), [], `${ctx}: effects recorded done more than once`);
      assert.equal(fake.writes().filter(c => c.status === 200).length, done.size, `${ctx}: successful runner calls and finished effects differ`);
      // 8. Each agent wrote only its own part of shared memory.
      for (const [k, v] of rt.memory) assert.ok(k.startsWith(`${v.by}.`), `${ctx}: ${v.by} wrote ${k}`);
    } finally { rt.stop(); await fake.stop(); }
  });
}

test('questions reach the agent whose job it is', () => {
  const to = q => route(q, TEAM)[0];
  assert.equal(to('Is there lightning nearby?'), 'weather');
  assert.equal(to('Which tractor has the mower on?'), 'fleet');
  assert.equal(to('Is T2 stuck or out of service?'), 'fault');
  assert.equal(to('How many inspections are open at the depot?'), 'depot');
  assert.equal(to('What soil is under South Flats and how does it drain?'), 'agronomy');
  assert.equal(to('What did the record show was finished?'), 'records');
  assert.equal(to('xyzzy'), undefined);
});
