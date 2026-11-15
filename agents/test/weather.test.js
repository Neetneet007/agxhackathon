// Runtime + Weather Manager drift rules against a fake live runner. Run: node --test agents/test/
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fire, derive, decide } from '../weather/playbook.js';
import { calm } from '../weather/feed.js';
import { RunnerClient, ForbiddenCallError } from '../runtime/runner.js';
import { startApi } from '../runtime/http.js';
import { Model } from '../runtime/model.js';
import { startFakeRunner, makeRuntime, runClock, tmpDir, CALM_INVERSION, CLEAR, WINDY } from './helpers.js';

let fakes = [];
let runtimes = [];
async function fakeRunner(opts) { const f = await startFakeRunner(opts); fakes.push(f); return f; }
async function runtime(opts) { const rt = await makeRuntime(opts); runtimes.push(rt); return rt; }
const actions = rt => rt.memoryGet('weather.actions')?.value;

afterEach(async () => {
  // Brief test 7 (first prompt), applied to every test: no forbidden endpoint is ever called.
  for (const f of fakes) assert.deepEqual(f.forbidden, [], `forbidden endpoints called: ${f.forbidden.join(', ')}`);
  for (const rt of runtimes) rt.stop();
  for (const f of fakes) await f.stop();
  fakes = []; runtimes = [];
});

const evalReading = r => fire({ reading: r, derived: derive(r), forecast: {}, alerts: [], history: {} });

test('drift: inversion with acceptable wind gives exactly one spray hold, naming the rule and its source', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '06:10');
  assert.equal(fake.holdPosts().length, 1);
  const hold = fake.holdPosts()[0].body;
  assert.deepEqual([hold.id, hold.jobTypes, hold.fields, hold.by], ['wm-spray', ['spray'], null, 'Weather Manager']);
  assert.match(hold.reason, /12\.5 °C, warmer than 10 °C at 2 m.*\[rule drift-inversion\]/);
  assert.deepEqual(rt.memoryGet('weather.status').value.fired, ['drift-inversion'], 'the 2 m reading alone (wind 5 mph) fires nothing else');
  const say = fake.says().map(s => s.body);
  assert.equal(say.length, 1);
  assert.match(say[0].text, /\[rule drift-inversion \(North Dakota State University Extension \+1\)\] \(simulated weather\)$/);
  const journal = fs.readFileSync(path.join(rt.dataDir, 'weather.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(journal.filter(j => j.kind === 'reading').length, 11);
});

test('drift: wind above 10 mph stops spraying; wind back in range lifts the hold', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '09:00', ...CLEAR }, { at: '09:05', ...WINDY }, { at: '09:10', ...CLEAR }] });
  await runClock(rt, fake, '09:00', '09:15');
  assert.equal(fake.holdPosts().length, 1);
  assert.match(fake.holdPosts()[0].body.reason, /wind at spray height is 12 mph/);
  assert.deepEqual(fake.holdDeletes().map(d => d.url), ['/hold/wm-spray']);
  assert.equal(fake.holds.size, 0);
  assert.deepEqual(fake.says().map(s => s.body.type), ['stop', 'go']);
});

test('drift: wind below 3 mph holds (verified); shear only advises (no verified source)', () => {
  assert.deepEqual(evalReading({ t2C: 15, t10C: 14.5, wind2Mph: 2, wind10Mph: 3 }).map(f => [f.id, f.authorized]), [['drift-wind', true]]);
  const shear = evalReading({ t2C: 15, t10C: 14.5, wind2Mph: 4, wind10Mph: 9.5 });
  assert.deepEqual(shear.map(f => [f.id, f.authorized]), [['drift-shear', false]]);
  assert.deepEqual(Object.keys(decide(shear).holds), []);
  assert.equal(evalReading({ t2C: 15, t10C: 14.5, wind2Mph: 4, wind10Mph: 9 }).length, 0, 'exactly 5 mph is not shear');
  assert.equal(evalReading({ t2C: 15, t10C: 15, wind2Mph: 6, wind10Mph: 7 }).length, 0, 'equal temperatures are not an inversion');
});

test('drift: readings that stay the same produce no repeated messages', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '07:30');
  assert.equal(fake.holdPosts().length, 1);
  assert.equal(fake.says().length, 1);
  const c = rt.agentSummary(rt.agents[0]).counts;
  assert.equal(c.senses, 91);
  assert.equal(c.wakes, 2, 'one for the change, one hourly');
  assert.equal(c.idleWakes, 1, 'the hourly wake had nothing to decide: no model call');
});

test('calm day: inversion Stop, the spraying window, then wind Stop', () => {
  const at = c => { const [h, m] = c.split(':').map(Number); const s = calm(h * 60 + m - 360); return evalReading(s.reading).map(f => f.id); };
  assert.deepEqual(at('06:00'), ['drift-wind', 'drift-inversion']);
  assert.deepEqual(at('07:30'), ['drift-inversion']);
  assert.deepEqual(at('10:00'), []);
  assert.deepEqual(at('13:20'), ['drift-wind-near-limit']);
  assert.deepEqual(at('15:00'), ['drift-wind']);
});

test('restart after the hold was sent: no second hold, still tracked', async () => {
  const fake = await fakeRunner();
  const dataDir = tmpDir();
  const script = [{ at: '06:00', ...CALM_INVERSION }];
  const rt1 = await makeRuntime({ dataDir, runnerUrl: fake.url, script });
  await runClock(rt1, fake, '06:00', '06:05');
  rt1.log.close(); // dies here
  const rt2 = await runtime({ dataDir, runnerUrl: fake.url, script });
  assert.deepEqual(Object.keys(actions(rt2).holds), ['wm-spray']);
  await runClock(rt2, fake, '06:06', '06:20');
  assert.equal(fake.holdPosts().length, 1);
  assert.equal(fake.says().length, 1);
});

test('no API key, and a failing model, take the same actions through the rule-only path', async () => {
  const script = [{ at: '06:00', ...CALM_INVERSION }, { at: '06:10', ...CLEAR }];
  const outcome = async model => {
    const fake = await fakeRunner();
    const rt = await runtime({ runnerUrl: fake.url, script, model });
    await runClock(rt, fake, '06:00', '06:15');
    return { rt, runs: rt.runs.get('weather').filter(r => r.path !== 'idle'), actions: fake.writes().map(c => `${c.method} ${c.url} ${c.body?.type ?? c.body?.id ?? ''}`.trim()) };
  };
  const noKey = await outcome(new Model({ env: {} }));
  assert.deepEqual(noKey.runs.map(r => r.path), ['rules', 'rules']);
  const failing = await outcome(new Model({ client: { messages: { create: async () => { throw new Error('connect ECONNREFUSED'); } } } }));
  assert.deepEqual(failing.runs.map(r => r.path), ['rules-fallback', 'rules-fallback']);
  assert.deepEqual(failing.actions, noKey.actions);
  assert.deepEqual(noKey.actions, ['POST /hold wm-spray', 'POST /agent/say stop', 'DELETE /hold/wm-spray', 'POST /agent/say go']);
  // The fast path never waited for the model.
  assert.ok(failing.runs.every(r => r.fastMs != null && r.fastMs < 1000));
});

test('with a model: the hold goes out before the model is asked; the model writes the words', async () => {
  const fake = await fakeRunner();
  let holdsWhenModelAsked = null;
  const client = { messages: { create: async req => {
    const last = req.messages[req.messages.length - 1];
    if (typeof last.content === 'string') {
      holdsWhenModelAsked = fake.holdPosts().length;
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u1', name: 'speak', input: { index: 0, text: 'Now: warm air at 10 m over cooler air at 2 m, so spraying waits.' } }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
  } } };
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }], model: new Model({ client }) });
  await runClock(rt, fake, '06:00', '06:02');
  assert.equal(holdsWhenModelAsked, 1, 'the hold was already sent when the model was called');
  assert.match(fake.says()[0].body.text, /^Now: warm air at 10 m.*\[rule drift-inversion \(/);
  assert.equal(rt.runs.get('weather')[0].path, 'model');
});

test('forbidden endpoints are refused before any network call', async () => {
  const fake = await fakeRunner();
  const c = new RunnerClient(fake.url);
  for (const a of [
    () => c.request('POST', '/human/H1/go'), () => c.request('POST', '/cmd/break T1'), () => c.request('POST', '/start'),
    () => c.request('POST', '/draft', {}), () => c.request('DELETE', '/draft/D1'), () => c.request('GET', '/replay'),
    () => c.postEvent({ type: 'breakdown', tractor: 'T1' }), () => c.postEvent({ type: 'repair', tractor: 'T1' }),
  ]) await assert.rejects(a, ForbiddenCallError);
  assert.equal(fake.calls.length, 0);
  await c.postEvent({ type: 'priority_change', job: 'J1', priority: 'low' });
  await c.postRecall({ id: 'x', reason: 'test', by: 'test' });
  assert.equal(fake.calls.length, 2);
  assert.throws(() => new RunnerClient('http://example.com:5190'));
});

test('live runner down at start: no crash, recovers when it appears', async () => {
  const probe = await startFakeRunner();
  const port = probe.port;
  await probe.stop();
  const rt = await runtime({ runnerUrl: `http://127.0.0.1:${port}`, script: [{ at: '06:00', ...CALM_INVERSION }] });
  for (let i = 0; i < 3; i++) await rt.tick();
  assert.equal(rt.runnerStatus.reachable, false);
  assert.equal(rt.log.entries.filter(e => e.kind === 'note' && /not reachable/.test(e.text)).length, 1);
  const fake = await fakeRunner({ port });
  await runClock(rt, fake, '06:00', '06:02');
  assert.equal(fake.holdPosts().length, 1);
});

test('hold endpoint not shipped yet (404): logged, kept, sent once it appears', async () => {
  const fake = await fakeRunner({ hold: '404' });
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '06:02');
  assert.equal(rt.effects.get('wm:t1:hold:wm-spray').status, 'pending');
  assert.ok(rt.log.entries.some(e => e.kind === 'note' && /404/.test(e.text)));
  fake.hold = 'ok';
  for (const f of rt.effects.values()) f.nextTry = 0;
  await runClock(rt, fake, '06:03', '06:03');
  assert.ok(fake.holds.has('wm-spray'));
});

test('API: health, agents, runs, messages, memory, wake, and the person endpoint', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }], agents: ['depot', 'weather'] });
  await runClock(rt, fake, '06:00', '06:02');
  const server = await startApi(rt, { port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async p => (await fetch(base + p)).json();
    assert.equal((await get('/health')).runner.reachable, true);
    assert.deepEqual((await get('/agents')).agents.map(a => a.displayName), ['Depot Manager', 'Weather Manager']);
    assert.ok((await get('/agents/weather/runs')).runs[0].steps.length > 0);
    assert.equal((await get('/messages?since=0')).messages.length, 1);
    assert.equal((await get('/memory')).memory['weather.status'].value.level, 'Stop');
    assert.equal((await fetch(base + '/memory', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/agents/weather/wake', { method: 'POST' })).status, 202);
    const bad = await fetch(base + '/people/depot/inspection_done', { method: 'POST', body: JSON.stringify({ id: 'I1' }) });
    assert.equal(bad.status, 400, 'a person action must say who did it');
  } finally {
    server.close();
  }
});
