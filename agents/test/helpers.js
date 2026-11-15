// Test helpers: a small fake of the live runner (port 5190's contract) on an ephemeral port,
// and a runtime factory. The fake records every call and flags any forbidden one.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, loadAgent } from '../runtime/runtime.js';
import { Model } from '../runtime/model.js';

export const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  ['POST', /^\/human\/[^/]+\/go$/], ['POST', /^\/cmd\//], ['POST', /^\/start$/], ['POST', /^\/draft$/], ['DELETE', /^\/draft\//],
];

// opts.hold: 'ok' | '404' | 'hang'; opts.say: 'ok' | '404'
export async function startFakeRunner({ port = 0, clock = '06:00', hold = 'ok', say = 'ok' } = {}) {
  const fake = { calls: [], forbidden: [], holds: new Map(), trail: [], clock, hold, say, hanging: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
      fake.calls.push({ method: req.method, url, body: json });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj ?? { ok: code < 300 })); };
      if (FORBIDDEN.some(([m, re]) => m === req.method && re.test(url)) || (req.method === 'POST' && url === '/event' && ['breakdown', 'repair'].includes(json?.type))) {
        fake.forbidden.push(`${req.method} ${url}${json?.type ? ` (${json.type})` : ''}`);
        return send(403, { error: 'forbidden' });
      }
      if (req.method === 'GET' && url === '/state') {
        return send(200, { clock: fake.clock, secPerMin: 1, mode: 'running', tractors: [], jobs: [{ id: 'J1', type: 'spray', status: 'pending', field: 'North Field' }], holds: [...fake.holds.values()], trail: fake.trail.slice(0, 40) });
      }
      if (req.method === 'GET' && url === '/farm') return send(200, { home: { lat: 32.62, lon: -114.68 }, fields: [{ name: 'North Field', boundary: [] }] });
      if (req.method === 'POST' && url === '/hold') {
        if (fake.hold === '404') return send(404, { error: 'not found' });
        if (fake.hold === 'hang') { fake.hanging.push(res); return; }
        fake.holds.set(json.id, json);
        fake.trail.unshift({ clock: fake.clock, from: json.by, to: 'coordinator', type: 'hold', text: json.reason });
        return send(200);
      }
      const dm = req.method === 'DELETE' && url.match(/^\/hold\/(.+)$/);
      if (dm) { fake.holds.delete(decodeURIComponent(dm[1])); return send(200); }
      if (req.method === 'POST' && url === '/agent/say') {
        if (fake.say === '404') return send(404, { error: 'not found' });
        fake.trail.unshift({ clock: fake.clock, ...json });
        return send(200);
      }
      if (req.method === 'POST' && url === '/event') return send(200);
      return send(404, { error: 'not found' });
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.holdPosts = () => fake.calls.filter(c => c.method === 'POST' && c.url === '/hold');
  fake.holdDeletes = () => fake.calls.filter(c => c.method === 'DELETE' && c.url.startsWith('/hold/'));
  fake.says = () => fake.calls.filter(c => c.method === 'POST' && c.url === '/agent/say');
  fake.stop = () => new Promise(r => { for (const h of fake.hanging) h.destroy(); server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

export function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-')); }

export async function makeRuntime({ dataDir = tmpDir(), runnerUrl, script, model, env = {} }) {
  const weather = await loadAgent(path.join(AGENTS_DIR, 'weather'));
  return new Runtime({
    dataDir, agents: [weather], runnerUrl, quiet: true,
    model: model || new Model({ env }),       // env {} → no API key → rule-only
    config: { weatherScript: script },
  });
}

// Advance the fake's plan clock minute by minute and tick the runtime at each.
export async function runClock(rt, fake, from, to) {
  for (let m = toMin(from); m <= toMin(to); m++) { fake.clock = toClock(m); await rt.tick(); }
}
export const toMin = c => { const [h, m] = c.split(':').map(Number); return h * 60 + m; };
export const toClock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function waitFor(fn, { timeout = 8000, step = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, step));
  }
}

export const CALM_INVERSION = { t2C: 10, t10C: 12.5, wind2Mph: 5, wind10Mph: 6.5 };   // 2 m alone looks fine
export const CLEAR = { t2C: 16, t10C: 15.4, wind2Mph: 6, wind10Mph: 7.5 };
export const WINDY = { t2C: 22, t10C: 21.2, wind2Mph: 12, wind10Mph: 15 };
