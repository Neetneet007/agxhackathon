// Weather agent + runtime against a fake live runner. Run: node --test agents/test/
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, THRESHOLDS } from '../weather/rules.js';
import { simulated } from '../weather/feed.js';
import { RunnerClient, ForbiddenCallError } from '../runtime/runner.js';
import { startApi } from '../runtime/http.js';
import { startFakeRunner, makeRuntime, runClock, tmpDir, CALM_INVERSION, CLEAR, WINDY } from './helpers.js';

let fakes = [];
let runtimes = [];
async function fakeRunner(opts) { const f = await startFakeRunner(opts); fakes.push(f); return f; }
async function runtime(opts) { const rt = await makeRuntime(opts); runtimes.push(rt); return rt; }

afterEach(async () => {
  // Test 7, applied to every test: the fake fails the test if a forbidden endpoint was ever called.
  for (const f of fakes) assert.deepEqual(f.forbidden, [], `forbidden endpoints called: ${f.forbidden.join(', ')}`);
  for (const rt of runtimes) rt.stop();
  for (const f of fakes) await f.stop();
  fakes = []; runtimes = [];
});

test('1. inversion with acceptable wind gives Stop and exactly one hold', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  // The 2 m reading alone is fine: wind 5 mph is inside 3–10 and below the caution band.
  assert.ok(CALM_INVERSION.wind2Mph >= THRESHOLDS.windLowMph && CALM_INVERSION.wind2Mph <= THRESHOLDS.windCautionMph);
  await runClock(rt, fake, '06:00', '06:10');
  assert.equal(fake.holdPosts().length, 1);
  const hold = fake.holdPosts()[0].body;
  assert.deepEqual(hold.jobTypes, ['spray']);
  assert.equal(hold.fields, null);
  assert.equal(hold.by, 'weather-agent');
  assert.match(hold.reason, /12\.5 °C at 10 m .* 10\.0 °C at 2 m/);
  const status = rt.memoryGet('weather.spray').value;
  assert.equal(status.status, 'Stop');
  assert.deepEqual(status.triggers.map(t => t.code), ['inversion']);
  assert.match(status.reason, /2 m reading alone looks fine/);
  assert.equal(rt.memoryGet('weather.hold').value.active, true);
  assert.equal(fake.says().length, 1);
  // Every reading and the trigger of the status change are journalled under the data dir.
  const journal = fs.readFileSync(path.join(rt.dataDir, 'weather.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(journal.filter(j => j.kind === 'reading').length, 11);
  assert.equal(journal.filter(j => j.kind === 'status_change').length, 1);
});

test('2. wind above 10 mph gives Stop; wind back in range lifts the hold', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '09:00', ...CLEAR }, { at: '09:05', ...WINDY }, { at: '09:10', ...CLEAR }] });
  await runClock(rt, fake, '09:00', '09:04');
  assert.equal(rt.memoryGet('weather.spray').value.status, 'Go');
  assert.equal(fake.says().length, 0, 'the first Go of the day is recorded, not announced');
  await runClock(rt, fake, '09:05', '09:09');
  assert.equal(fake.holdPosts().length, 1);
  assert.match(fake.holdPosts()[0].body.reason, /wind 12\.0 mph at 2 m is above 10 mph/);
  assert.ok(fake.holds.has('weather-agent-spray'));
  await runClock(rt, fake, '09:10', '09:15');
  assert.equal(fake.holdDeletes().length, 1);
  assert.equal(fake.holdDeletes()[0].url, '/hold/weather-agent-spray');
  assert.equal(fake.holds.size, 0);
  assert.equal(fake.holdPosts().length, 1);
  assert.equal(rt.memoryGet('weather.hold').value.active, false);
  assert.deepEqual(fake.says().map(s => s.body.type), ['stop', 'go']);
});

test('3. wind below 3 mph and shear are flagged as specified', async () => {
  const low = evaluate({ t2C: 15, t10C: 14.5, wind2Mph: 2.0, wind10Mph: 3.0 });
  assert.equal(low.status, 'Stop');
  assert.deepEqual(low.triggers.map(t => t.code), ['wind_low']);
  const shear = evaluate({ t2C: 15, t10C: 14.5, wind2Mph: 4.0, wind10Mph: 9.5 });
  assert.equal(shear.status, 'Caution');
  assert.deepEqual(shear.triggers.map(t => t.code), ['shear']);
  assert.match(shear.triggers[0].text, /9\.5 mph at 10 m vs 4\.0 mph at 2 m/);
  assert.equal(evaluate({ t2C: 15, t10C: 14.5, wind2Mph: 4.0, wind10Mph: 9.0 }).status, 'Go', 'a difference of exactly 5 mph is not shear');
  assert.equal(evaluate({ t2C: 15, t10C: 14.5, wind2Mph: 9.0, wind10Mph: 11 }).status, 'Caution');
  assert.equal(evaluate({ t2C: 15, t10C: 15.0, wind2Mph: 6, wind10Mph: 7 }).status, 'Go', 'equal temperatures are not an inversion');

  // Caution in the runtime: no hold, one message to the operator.
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '10:00', ...CLEAR }, { at: '10:03', t2C: 15, t10C: 14.5, wind2Mph: 4.0, wind10Mph: 9.5 }] });
  await runClock(rt, fake, '10:00', '10:08');
  assert.equal(fake.holdPosts().length, 0);
  assert.equal(fake.says().length, 1);
  assert.equal(fake.says()[0].body.to, 'operator');
  assert.equal(fake.says()[0].body.type, 'caution');
});

test('4. readings that stay the same produce no repeated messages', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '07:30'); // 91 readings, one hourly scheduled wake
  assert.equal(fake.holdPosts().length, 1);
  assert.equal(fake.says().length, 1);
  const c = rt.agentSummary(rt.agents[0]).counts;
  assert.equal(c.senses, 91);
  assert.equal(c.wakes, 2, 'one wake for the change, one scheduled');
  assert.equal(c.idleWakes, 1, 'the scheduled wake found nothing to decide');
  assert.equal(rt.messages.length, 1);
});

test('5a. restart after the hold was sent: no second hold, and the hold is still tracked', async () => {
  const fake = await fakeRunner();
  const dataDir = tmpDir();
  const script = [{ at: '06:00', ...CALM_INVERSION }];
  const rt1 = await makeRuntime({ dataDir, runnerUrl: fake.url, script });
  await runClock(rt1, fake, '06:00', '06:05');
  assert.equal(fake.holdPosts().length, 1);
  rt1.log.close(); // the process dies here: no shutdown handler, nothing flushed beyond what is on disk
  const rt2 = await runtime({ dataDir, runnerUrl: fake.url, script });
  assert.equal(rt2.memoryGet('weather.spray').value.status, 'Stop');
  assert.equal(rt2.memoryGet('weather.hold').value.active, true);
  assert.equal(rt2.effects.get('weather:t1:hold').status, 'done');
  await runClock(rt2, fake, '06:06', '06:20');
  assert.equal(fake.holdPosts().length, 1, 'no second hold after restart');
  assert.equal(fake.says().length, 1, 'no repeated message after restart');
});

test('6. no API key, and a failing model, take the same actions through the rule-only path', async () => {
  const script = [{ at: '06:00', ...CALM_INVERSION }, { at: '06:10', ...CLEAR }];
  const outcome = async model => {
    const fake = await fakeRunner();
    const rt = await runtime({ runnerUrl: fake.url, script, model });
    await runClock(rt, fake, '06:00', '06:15');
    const runs = rt.runs.get('weather').filter(r => r.path !== 'idle');
    return { fake, rt, runs, actions: fake.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.url} ${c.body?.type ?? c.body?.id ?? ''}`.trim()) };
  };
  const { Model } = await import('../runtime/model.js');
  const noKey = await outcome(new Model({ env: {} }));
  assert.equal(noKey.rt.model.available(), false);
  assert.deepEqual(noKey.runs.map(r => r.path), ['rules', 'rules']);

  const failing = await outcome(new Model({ client: { messages: { create: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { status: undefined }); } } } }));
  assert.deepEqual(failing.runs.map(r => r.path), ['rules-fallback', 'rules-fallback']);
  assert.equal(failing.rt.agentSummary(failing.rt.agents[0]).counts.modelErrors, 2);

  assert.deepEqual(failing.actions, noKey.actions);
  assert.deepEqual(noKey.actions, ['POST /hold weather-agent-spray', 'POST /agent/say stop', 'DELETE /hold/weather-agent-spray', 'POST /agent/say go']);
});

test('6b. with a working model: it calls the tools and writes the words; the rules still decide', async () => {
  const { Model } = await import('../runtime/model.js');
  const requests = [];
  const client = {
    messages: {
      create: async req => {
        requests.push(req);
        const last = req.messages[req.messages.length - 1];
        const results = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result') : [];
        if (!results.length) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'evaluate_spray_conditions', input: {} }] };
        const r = JSON.parse(results[0].content);
        if (r.status) {
          // First try to announce the wrong status (must be refused), then the right one.
          return { stop_reason: 'tool_use', content: [
            { type: 'tool_use', id: 'tu2', name: 'announce_spray_status', input: { status: r.status === 'Stop' ? 'Go' : 'Stop', explanation: 'wrong on purpose' } },
            { type: 'tool_use', id: 'tu3', name: 'announce_spray_status', input: { status: r.status, explanation: `Model says ${r.status}: ${r.triggers.map(t => t.text).join('; ') || 'conditions fine'}.` } },
          ] };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Announced.' }] };
      },
    },
  };
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }, { at: '06:10', ...CLEAR }], model: new Model({ client }) });
  await runClock(rt, fake, '06:00', '06:15');
  const runs = rt.runs.get('weather').filter(r => r.path !== 'idle');
  assert.deepEqual(runs.map(r => r.path), ['model', 'model']);
  assert.equal(fake.holdPosts().length, 1);
  assert.equal(fake.holdDeletes().length, 1);
  assert.deepEqual(fake.says().map(s => s.body.text.split(':')[0]), ['Model says Stop', 'Model says Go']);
  const refused = rt.log.entries.filter(e => e.kind === 'tool_result' && e.error?.startsWith('refused'));
  assert.equal(refused.length, 2, 'the wrong status was refused both times');
  assert.equal(requests[0].tools.some(t => t.name === 'announce_spray_status'), true);
  assert.match(requests[0].system, /weather agent/);
});

test('6c. a model that does nothing still cannot skip a Stop: the rule safety net places the hold', async () => {
  const { Model } = await import('../runtime/model.js');
  const lazy = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'All fine.' }] }) } };
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }], model: new Model({ client: lazy }) });
  await runClock(rt, fake, '06:00', '06:03');
  assert.equal(fake.holdPosts().length, 1);
  assert.ok(rt.log.entries.some(e => e.kind === 'note' && /safety net/.test(e.text)));
});

test('7. forbidden endpoints are refused before any network call', async () => {
  const fake = await fakeRunner();
  const c = new RunnerClient(fake.url);
  const attempts = [
    () => c.request('POST', '/human/H1/go'), () => c.request('POST', '/cmd/break T1'), () => c.request('POST', '/start'),
    () => c.request('POST', '/draft', {}), () => c.request('DELETE', '/draft/D1'),
    () => c.postEvent({ type: 'breakdown', tractor: 'T1' }), () => c.postEvent({ type: 'repair', tractor: 'T1' }),
    () => c.request('GET', '/replay'),
  ];
  for (const a of attempts) await assert.rejects(a, ForbiddenCallError);
  assert.equal(fake.calls.length, 0);
  await c.postEvent({ type: 'priority_change', job: 'J1', priority: 'low' });
  assert.equal(fake.calls.length, 1);
  assert.throws(() => new RunnerClient('http://example.com:5190'));
});

test('8. live runner down at start: no crash, and it recovers when the runner appears', async () => {
  const probe = await startFakeRunner();
  const port = probe.port;
  await probe.stop(); // nothing listens on this port now
  const rt = await runtime({ runnerUrl: `http://127.0.0.1:${port}`, script: [{ at: '06:00', ...CALM_INVERSION }] });
  for (let i = 0; i < 3; i++) await rt.tick();
  assert.equal(rt.runnerStatus.reachable, false);
  assert.equal(rt.log.entries.filter(e => e.kind === 'note' && /not reachable/.test(e.text)).length, 1, 'logged once, then quiet');
  const fake = await fakeRunner({ port });
  await runClock(rt, fake, '06:00', '06:02');
  assert.equal(rt.runnerStatus.reachable, true);
  assert.equal(fake.holdPosts().length, 1);
});

test('8b. hold endpoint not shipped yet (404): logged, kept, sent once it appears', async () => {
  const fake = await fakeRunner({ hold: '404' });
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '06:02');
  assert.equal(fake.holds.size, 0);
  assert.equal(rt.effects.get('weather:t1:hold').status, 'pending');
  assert.ok(rt.log.entries.some(e => e.kind === 'note' && /404/.test(e.text)));
  fake.hold = 'ok';
  for (const f of rt.effects.values()) f.nextTry = 0; // skip the retry back-off
  await runClock(rt, fake, '06:03', '06:03');
  assert.ok(fake.holds.has('weather-agent-spray'));
  assert.equal(rt.effects.get('weather:t1:hold').status, 'done');
});

test('simulated day: inversion Stop, then the spraying window, then wind Stop', async () => {
  const at = c => { const [h, m] = c.split(':').map(Number); return evaluate(simulated(h * 60 + m - 360)); };
  assert.equal(at('06:00').status, 'Stop');
  const morning = at('07:30');
  assert.equal(morning.status, 'Stop');
  assert.deepEqual(morning.triggers.map(t => t.code), ['inversion'], 'only the 10 m reading shows the problem');
  assert.equal(at('10:00').status, 'Go');
  assert.equal(at('13:20').status, 'Caution');
  assert.equal(at('15:00').status, 'Stop');
  assert.deepEqual(at('15:00').triggers.map(t => t.code), ['wind_high']);
});

test('API: health, agents, runs, messages, memory and wake', async () => {
  const fake = await fakeRunner();
  const rt = await runtime({ runnerUrl: fake.url, script: [{ at: '06:00', ...CALM_INVERSION }] });
  await runClock(rt, fake, '06:00', '06:02');
  const server = await startApi(rt, { port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async p => (await fetch(base + p)).json();
    assert.equal((await get('/health')).runner.reachable, true);
    const agents = (await get('/agents')).agents;
    assert.equal(agents[0].name, 'weather');
    assert.equal(agents[0].counts.wakes, 1);
    const runs = (await get('/agents/weather/runs')).runs;
    assert.ok(runs[0].steps.some(s => s.kind === 'tool_call' && s.tool === 'announce_spray_status') === false); // rule-only: no model tool calls
    assert.equal((await get('/messages?since=0')).messages.length, 1);
    assert.equal((await get('/messages?since=1')).messages.length, 0);
    assert.equal((await get('/memory')).memory['weather.spray'].value.status, 'Stop');
    assert.equal((await fetch(base + '/memory', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/agents/weather/wake', { method: 'POST' })).status, 202);
    await rt.tick();
    assert.equal(rt.runs.get('weather').at(-1).reason.includes('manual'), true);
  } finally {
    server.close();
  }
});
