#!/usr/bin/env node
// Stand-in for tractor-node.js when AgOpenWeb is not installed (e.g. on Windows, for UI work).
// Same command line, same HTTP interface on agPort+1000 (/telemetry, /command, /service, /release,
// /home, /fault/<f>), same faults typed into the terminal. Instead of steering an AgOpenWeb copy it
// simulates the vehicle itself: drive to a point, follow a pass with the implement on, stop.
// It also serves a small placeholder page on agPort, where the status page expects AgOpenWeb's view.
//
//   node agopen/mock-node.js T1 5175 [--bay 0] [--speed 1]      --speed 2 = everything twice as fast
//
// NOT the real thing: positions and worked area come from this simple model, not AgOpenWeb.
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './rig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes('--' + n) ? argv[argv.indexOf('--' + n) + 1] : d);
const id = argv[0] || 'T1', agPort = Number(argv[1] || 5175), port = agPort + 1000;
const bayIndex = Number(opt('bay', Math.max(0, Number(id.replace(/\D/g, '')) - 1)));
const SPEEDUP = Number(opt('speed', 1));

// Farm origin (the depot) and this machine's implements, as build-farm.js would have set them up in AgOpenWeb.
const farm = fs.existsSync(path.join(here, 'farm.json')) ? JSON.parse(fs.readFileSync(path.join(here, 'farm.json'), 'utf8')) : {};
const home = farm.home || { lat: 32.72, lon: -114.6741 };
const scen = JSON.parse(fs.readFileSync(path.join(here, 'scenario.live.json'), 'utf8'));
const spec = scen.tractors.find(t => t.id === id);
let activeTool = spec ? TOOLS[spec.mounted || spec.implements[0]]?.[0] ?? null : null;
const rig = () => spec && {
  source: 'mock-node (no AgOpenWeb)',
  tools: spec.implements.filter(k => TOOLS[k]).map(k => ({ profile: TOOLS[k][0], kind: k, widthM: TOOLS[k][1] })),
  activeTool,
  tool: activeTool && { profile: activeTool, widthM: Object.values(TOOLS).find(([n]) => n === activeTool)?.[1] ?? null },
  vehicle: { profile: 'Default', wheelbaseM: 3, maxSteerDeg: 35 },
};

const RAD = Math.PI / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * home.lat * RAD) + 1.175 * Math.cos(4 * home.lat * RAD);
const mLon = 111412.84 * Math.cos(home.lat * RAD) - 93.5 * Math.cos(3 * home.lat * RAD);
const bay = () => ({ e: (bayIndex - 1) * 10, n: 0 });

// Vehicle state, in metres from the depot. heading: radians clockwise from north.
const v = { ...bay(), heading: 0, speed: 0, painting: false, onLine: false, xt: null, areaM2: 0 };
let fault = 'ok', cmd = null, seq = 0, acked = 0, service = null;
const lockFile = path.join(here, 'out', `lock-${id}.json`);
const saveLock = () => { try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); service ? fs.writeFileSync(lockFile, JSON.stringify(service)) : fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ } };
try { service = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { service = null; }

// ---- the drive model: same targets as tractor.js pursue(), simpler physics
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const TICK = 0.1;
setInterval(() => {
  const dt = TICK * SPEEDUP;
  const tg = fault === 'ok' && !service && cmd?.type === 'goto' ? cmd : null;
  let want = 0, aim = null;
  v.painting = false;
  if (tg && tg.maxKph !== 0) {
    let top = (tg.maxKph ?? 20) / 3.6;
    const L = tg.from ? Math.hypot(tg.e - tg.from.e, tg.n - tg.from.n) : 0;
    if (tg.track && L > 0.5) {
      const de = (tg.e - tg.from.e) / L, dn = (tg.n - tg.from.n) / L;
      const along = (v.e - tg.from.e) * de + (v.n - tg.from.n) * dn;
      const xt = (v.e - tg.from.e) * dn - (v.n - tg.from.n) * de;
      if (along < L - 0.3) {
        const look = Math.min(L, Math.max(along, 0) + 5);          // aim 5 m ahead on the line
        aim = { e: tg.from.e + de * look, n: tg.from.n + dn * look };
        const err = wrap(Math.atan2(de, dn) - v.heading);
        v.onLine = Math.abs(xt) < 0.6 && Math.abs(err) < 0.25; v.xt = xt;
        v.painting = !!tg.paint && v.onLine && along >= -0.2 && along <= L + 0.2;
        if (!v.onLine) top = Math.min(top, 6 / 3.6);
        if (L - along < 4) top = Math.min(top, 7 / 3.6);
        want = top;
      }
    } else {
      const d = Math.hypot(tg.e - v.e, tg.n - v.n);
      v.onLine = false; v.xt = null;
      if (d >= 3.5) { aim = tg; want = d < 8 ? Math.min(top, 6 / 3.6) : top; }
    }
  }
  if (aim) {
    const err = wrap(Math.atan2(aim.e - v.e, aim.n - v.n) - v.heading);
    const maxTurn = 50 * RAD * dt;                                   // about a tractor's turning rate
    v.heading = wrap(v.heading + Math.max(-maxTurn, Math.min(maxTurn, err)));
    if (Math.abs(err) > 1.0) want = Math.min(want, 4 / 3.6); else if (Math.abs(err) > 0.5) want = Math.min(want, 7 / 3.6);
  } else v.onLine = false;
  if (fault === 'stuck') want = 0;                                   // acknowledges GO, wheels do not turn
  const acc = 2 * dt;
  v.speed += Math.max(-acc, Math.min(acc, want - v.speed));
  v.e += Math.sin(v.heading) * v.speed * dt;
  v.n += Math.cos(v.heading) * v.speed * dt;
  if (v.painting) v.areaM2 += v.speed * dt * (rig()?.tool?.widthM ?? 6);
}, TICK * 1000);

function telemetry() {
  return {
    id, seq: ++seq, ts: Date.now(), link: 'ok',
    lat: home.lat + v.n / mLat, lon: home.lon + v.e / mLon, e: +v.e.toFixed(1), n: +v.n.toFixed(1),
    headingDeg: Math.round(v.heading / RAD), speedKph: +(v.speed * 3.6 / SPEEDUP).toFixed(1),
    fault: undefined, ack: acked, command: cmd ? { type: cmd.type, label: cmd.label, e: cmd.e, n: cmd.n } : null,
    field: cmd?.field || null, job: cmd?.job || null, areaM2: Math.round(v.areaM2), line: v.onLine ? 'AB' : null,
    busy: null, rig: rig(),
    service: service ? { kind: service.kind, tool: service.tool, lockedForS: Math.round((Date.now() - service.since) / 1000) } : null,
    onLine: v.onLine, painting: v.painting, offLineM: v.xt == null ? null : +v.xt.toFixed(2),
    autosteer: false, crossTrackM: v.xt == null ? null : +v.xt.toFixed(2), mock: true,
  };
}

const body = (req, cb) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { let j = {}; try { j = JSON.parse(b || '{}'); } catch { j = null; } cb(j); }); };
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/fault/')) { setFault(req.url.slice(7), 'test script'); res.writeHead(200); return res.end('ok'); }
  if (fault === 'dead') { req.socket.destroy(); return; }
  if (req.method === 'POST' && req.url === '/home') {
    service = null; saveLock(); fault = 'ok'; cmd = null; Object.assign(v, bay(), { heading: 0, speed: 0, areaM2: 0 });
    console.log(`\n${id} ── back in its bay for a fresh start ──`); res.writeHead(200); return res.end('ok');
  }
  if (req.method === 'POST' && (req.url === '/service' || req.url === '/release')) return body(req, (b) => {
    b = b || {};
    if (req.url === '/service') { service = { kind: b.kind, tool: b.tool || null, since: Date.now() }; v.speed = 0; console.log(`\n${id} ── LOCKED at depot: ${b.kind === 'swap' ? `implement change to ${b.tool}` : 'refuelling'}. Waiting for "good to go". ──`); }
    else if (service) { if (service.tool) activeTool = service.tool; console.log(`\n${id} ── GOOD TO GO${service.tool ? `; implement is now ${service.tool}` : ''} ──`); service = null; }
    saveLock(); json(res, { ok: true, locked: !!service });
  });
  if (req.method === 'GET' && req.url === '/telemetry') return json(res, telemetry());
  if (req.method === 'POST' && req.url === '/command') return body(req, (b) => {
    if (!b) { res.writeHead(400); return res.end(); }
    cmd = b; acked = b.n_seq ?? acked + 1; json(res, { ok: true, ack: acked });
  });
  res.writeHead(404); res.end();
}).listen(port, () => console.log(`${id}: MOCK vehicle (no AgOpenWeb) → telemetry and commands on :${port}, placeholder view on :${agPort}. Type dead / stuck / ok.`));

// Placeholder where the status page embeds AgOpenWeb's own view.
http.createServer((req, res) => {
  if (req.url.startsWith('/telemetry')) return json(res, telemetry());
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${id} (mock)</title>
<body style="margin:0;font:13px system-ui;background:#1d2a22;color:#dfe;display:grid;place-items:center;height:100vh;text-align:center">
<div><b style="font-size:15px">${id} · AgOpenWeb not running</b><br><span style="opacity:.7">stand-in vehicle (agopen/mock-node.js)</span>
<pre id="t" style="text-align:left;margin-top:10px;font-size:12px;opacity:.9"></pre></div>
<script>setInterval(async()=>{try{const t=await (await fetch('/telemetry')).json();document.getElementById('t').textContent=
'speed   '+t.speedKph+' km/h\\nheading '+t.headingDeg+'°\\npos     e '+t.e+'  n '+t.n+'\\ntask    '+(t.command?.label||'holding')+(t.painting?'\\nimplement ON':'')+(t.service?'\\nLOCKED: '+t.service.kind:'')}catch{}},500)</script>`);
}).listen(agPort, () => {}).on('error', () => console.log(`${id}: port ${agPort} busy, so no placeholder view (is the real AgOpenWeb running?)`));

function setFault(f, why = 'operator') {
  if (!['ok', 'dead', 'stuck'].includes(f) || f === fault) return;
  fault = f; console.log(`\n${id} ── FAULT ${f.toUpperCase()} (${why}) ──`);
}
readline.createInterface({ input: process.stdin }).on('line', (l) => setFault(l.trim().toLowerCase()));
setInterval(() => {
  const m = telemetry();
  const what = service ? `LOCKED: ${service.kind}, waiting for good to go` : fault === 'dead' ? 'NOT RESPONDING' : fault === 'stuck' ? "GO ack'd, wheels stopped" : cmd?.type === 'goto' ? `→ ${cmd.label || 'target'}${m.painting ? '  [implement on]' : ''}` : 'holding';
  console.log(`${id} ${new Date().toTimeString().slice(0, 8)}  e ${String(m.e).padStart(7)} n ${String(m.n).padStart(7)}  ${String(m.speedKph).padStart(5)} km/h  hdg ${String(m.headingDeg).padStart(4)}°  ${what}`);
}, 1000);
