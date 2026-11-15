// Test 5 with a real process kill: node agents/server.js is started as a child process and
// killed (SIGKILL, no shutdown handler) mid-run, then started again on the same data directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeRunner, tmpDir, waitFor, AGENTS_DIR, CALM_INVERSION } from './helpers.js';

const children = new Set();
after(() => { for (const c of children) c.kill('SIGKILL'); });

function startServer({ dataDir, runnerUrl, scriptFile }) {
  const child = spawn(process.execPath, [path.join(AGENTS_DIR, 'server.js')], {
    env: { ...process.env, AGENTS_PORT: '0', AGENTS_DATA: dataDir, RUNNER_URL: runnerUrl, POLL_MS: '100', WEATHER_SCRIPT: scriptFile, AGENT_MODEL: 'off', AGENTS: 'weather' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  child.apiUrl = () => out.match(/API listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  return child;
}
function kill(child) {
  return new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); children.delete(child); });
}
const logEntries = dataDir => !fs.existsSync(path.join(dataDir, 'runtime.jsonl')) ? [] : fs.readFileSync(path.join(dataDir, 'runtime.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });

test('5b. kill -9 mid-run after the hold: restart posts no second hold and still tracks it', async () => {
  const fake = await startFakeRunner();
  const dataDir = tmpDir();
  const scriptFile = path.join(dataDir, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify([{ at: '06:00', ...CALM_INVERSION }]));
  try {
    const a = startServer({ dataDir, runnerUrl: fake.url, scriptFile });
    await waitFor(() => logEntries(dataDir).some(e => e.kind === 'effect_done' && e.id === 'weather:t1:hold'), { what: 'hold sent' });
    fake.clock = '06:05';
    await kill(a);
    assert.equal(fake.holdPosts().length, 1);

    const b = startServer({ dataDir, runnerUrl: fake.url, scriptFile });
    const api = await waitFor(() => b.apiUrl(), { what: 'API up' });
    for (const c of ['06:06', '06:07', '06:08']) { fake.clock = c; await new Promise(r => setTimeout(r, 300)); }
    const mem = await (await fetch(`${api}/memory`)).json();
    assert.equal(mem.memory['weather.hold'].value.active, true);
    assert.equal(mem.memory['weather.spray'].value.status, 'Stop');
    assert.equal(fake.holdPosts().length, 1, 'no second hold');
    assert.equal(fake.says().length, 1, 'no second message');
    await kill(b);
    assert.deepEqual(fake.forbidden, []);
  } finally {
    await fake.stop();
  }
});

test('5c. killed while the hold call was in flight: on restart it is retried exactly once', async () => {
  const fake = await startFakeRunner({ hold: 'hang' }); // POST /hold is received but never answered
  const dataDir = tmpDir();
  const scriptFile = path.join(dataDir, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify([{ at: '06:00', ...CALM_INVERSION }]));
  try {
    const a = startServer({ dataDir, runnerUrl: fake.url, scriptFile });
    await waitFor(() => fake.holdPosts().length === 1, { what: 'hold call in flight' });
    await kill(a);
    const before = logEntries(dataDir);
    assert.ok(before.some(e => e.kind === 'effect_start' && e.id === 'weather:t1:hold'));
    assert.ok(!before.some(e => e.kind === 'effect_done' && e.id === 'weather:t1:hold'), 'recorded as started, not finished');

    fake.hold = 'ok';
    const b = startServer({ dataDir, runnerUrl: fake.url, scriptFile });
    await waitFor(() => logEntries(dataDir).some(e => e.kind === 'effect_done' && e.id === 'weather:t1:hold'), { what: 'hold retried' });
    await new Promise(r => setTimeout(r, 600));
    assert.equal(fake.holdPosts().length, 2, 'the interrupted call plus exactly one retry');
    assert.ok(fake.holds.has('weather-agent-spray'));
    await kill(b);
    assert.deepEqual(fake.forbidden, []);
  } finally {
    await fake.stop();
  }
});
