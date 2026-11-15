#!/usr/bin/env node
// Live run. The team's coordinator plans the day; each tractor is a separate process (tractor-node.js)
// wrapping its own AgOpenWeb instance. This runner sends each tractor where the plan says, watches the
// telemetry that comes back, and turns real symptoms into events the coordinator re-plans around:
//   - a tractor that stops answering               → NO_RESPONSE
//   - a tractor that acknowledges GO but stays put → GO_NOT_MOVING
//
//   node agopen/live.js [scenario.json] [--nodes 6175,6176,6177] [--cell 100] [--sec 1] [--until 240]
//                       [--script "40:fault T1 stuck;120:fault T2 dead"]   (sim-minute:command, for test cases)
// While it runs, type:  break T1 | repair T1 | fault T2 stuck|dead|ok | quit
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Simulator } from '../src/simulator.js';
import { Coordinator } from '../src/coordinator.js';
import { fmtTime } from '../src/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : def);
const scenarioPath = args.find(a => a.endsWith('.json')) || path.join(here, 'scenario.live.json');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const CELL = Number(opt('cell', 100));          // metres per grid cell
const SEC = Number(opt('sec', 9));              // real seconds per simulated minute: 9 makes a 100 m cell in 2 plan-minutes = 20 km/h, a real tractor speed
const UNTIL = Number(opt('until', scenario.horizonMinutes ?? 720));
const nodePorts = opt('nodes', scenario.tractors.map((_, i) => 6175 + i).join(',')).split(',').map(Number);
const script = String(opt('script', '')).split(';').filter(Boolean).map(s => ({ at: Number(s.split(':')[0]), cmd: s.slice(s.indexOf(':') + 1).trim(), done: false }));

const STALE_MS = 3000;      // no telemetry for this long → NO_RESPONSE
const STUCK_MS = 6000;      // told to go, far from target, not moving for this long → GO_NOT_MOVING
const FAR_M = 40, MOVED_M = 5;

// ---- The farm comes from AgOpenWeb's own field folders (one folder per field, field.geojson inside).
const FIELDS_DIR = opt('fields', path.resolve(here, '../../agopen-multi/data-5175/AgOpenWeb/Fields'));
const farmFile = path.join(here, 'farm.json');
const HOME = fs.existsSync(farmFile) ? JSON.parse(fs.readFileSync(farmFile, 'utf8')).home : null;
const RAD = Math.PI / 180;
const toWorld = (lat, lon) => {
  const mLat = 111132.92 - 559.82 * Math.cos(2 * HOME.lat * RAD) + 1.175 * Math.cos(4 * HOME.lat * RAD);
  const mLon = 111412.84 * Math.cos(lat * RAD) - 93.5 * Math.cos(3 * lat * RAD);
  return { e: (lon - HOME.lon) * mLon, n: (lat - HOME.lat) * mLat };
};
function readAgFields() {
  if (!fs.existsSync(FIELDS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(FIELDS_DIR)) {
    const file = path.join(FIELDS_DIR, name, 'field.geojson');
    if (!fs.existsSync(file)) continue;
    try {
      const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
      const role = (r) => geo.features.filter(f => f.properties?.role === r);
      const outer = role('outer-boundary')[0];
      out.push({
        name: role('metadata')[0]?.properties?.name || name,
        boundary: outer ? outer.geometry.coordinates[0].map(([lon, lat]) => [lon, lat]) : [],
        tracks: role('track').map(t => ({ name: t.properties.name, line: t.geometry.coordinates.map(([lon, lat]) => [lon, lat]) })),
      });
    } catch { /* skip a field file we cannot read */ }
  }
  return out;
}
const agFields = readAgFields();
if (HOME) {
  let added = 0;
  for (const af of agFields) {
    if (scenario.fields.some(f => f.name === af.name) || af.boundary.length < 4) continue;
    const pts = af.boundary.map(([lon, lat]) => toWorld(lat, lon));
    const e0 = Math.min(...pts.map(p => p.e)), e1 = Math.max(...pts.map(p => p.e)), n0 = Math.min(...pts.map(p => p.n)), n1 = Math.max(...pts.map(p => p.n));
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i].e * pts[i + 1].n - pts[i + 1].e * pts[i].n;
    scenario.fields.push({
      id: `A${++added}`, name: af.name, crop: 'not set', acres: Math.max(1, Math.round(Math.abs(area) / 2 / 4047)),
      x: scenario.depot.x + Math.round(e0 / CELL), y: scenario.depot.y - Math.round(n1 / CELL),
      w: Math.max(1, Math.round((e1 - e0) / CELL)), h: Math.max(1, Math.round((n1 - n0) / CELL)),
    });
  }
  console.log(`AgOpenWeb fields: ${agFields.length} found in ${FIELDS_DIR}${added ? `, ${added} not in the scenario and added` : ''}.`);
}

// ---- Each tractor's implements are the tool profiles in its own AgOpenWeb; the mounted one is its active profile.
const SPEED_MPH = { sprayer: 8, mower: 6, tiller: 5, seeder: 5 };
const rigs = await Promise.all(nodePorts.map(async (p) => {
  try { return (await (await fetch(`http://127.0.0.1:${p}/telemetry`, { signal: AbortSignal.timeout(1500) })).json()).rig; } catch { return null; }
}));
scenario.tractors.forEach((t, i) => {
  const tools = (rigs[i]?.tools || []).filter(x => x.kind && x.widthM);
  if (!tools.length) return;
  t.implements = tools.map(x => x.kind);
  // acres per hour = width (ft) x speed (mph) x field efficiency / 8.25
  t.workRates = Object.fromEntries(tools.map(x => [x.kind, Math.max(1, Math.round(x.widthM * 3.281 * SPEED_MPH[x.kind] * 0.8 / 8.25))]));
  t.mounted = tools.find(x => x.profile === rigs[i].activeTool)?.kind || tools[0].kind;
  console.log(`${t.id} from AgOpenWeb: ${tools.map(x => `${x.profile} = ${x.kind}, ${x.widthM} m, ${t.workRates[x.kind]} ac/h`).join('; ')}; mounted: ${t.mounted}`);
});

const sim = new Simulator({ ...scenario, events: [] }, new Coordinator(), { scriptedEvents: false });
// Everything that changes the plan's world is recorded, so the 3D view can replay exactly the same day.
const replay = [];
const _inject = sim.inject.bind(sim);
sim.inject = (e) => { const ev = { ...e, time: Math.max(e.time ?? sim.time, sim.time) }; replay.push({ t: ev.time, kind: 'event', event: ev }); return _inject(ev); };
const dep = sim.depot;
const world = (c) => ({ e: (c.x - dep.x) * CELL, n: -(c.y - dep.y) * CELL });

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
const trailFile = path.join(here, 'out', 'trail.jsonl');
fs.writeFileSync(trailFile, '');
let trail = function (from, to, type, text, data = {}) {
  const row = { wall: new Date().toISOString(), clock: fmtTime(sim.time), from, to, type, text, ...data };
  fs.appendFileSync(trailFile, JSON.stringify(row) + '\n');
  console.log(`[${row.clock}] ${from} → ${to}  ${type}: ${text}`);
};
sim.listeners.push((e) => {
  if (!['plan', 'event', 'done', 'end'].includes(e.type)) return;
  const who = e.type === 'plan' ? ['planner', 'executor'] : e.type === 'done' ? ['executor', 'planner'] : ['world', 'planner'];
  trail(who[0], who[1], e.type, e.text);
  for (const l of e.lines || []) console.log(`           ${l}`);
});
console.log(`Scenario: ${scenario.name}\nInitial plan:`);
for (const e of sim.log.filter(e => e.type === 'plan')) { console.log(`[${e.clock}] ${e.text}`); for (const l of e.lines || []) console.log(`           ${l}`); }

const units = sim.tractors.map((t, i) => ({
  id: t.id, twin: t, url: `http://127.0.0.1:${nodePorts[i]}`,
  tel: null, lastSeen: 0, fault: null, lane: null, cmd: null, stuckSince: 0, anchor: null,
}));

async function call(u, method, pathname, body) {
  const res = await fetch(u.url + pathname, {
    method, signal: AbortSignal.timeout(700),
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return method === 'GET' ? res.json() : res.text();
}

// Back-and-forth passes across a field, parallel to its guidance line (the field's long side), so that
// AgOpenWeb's own autosteer can hold each pass and "working" shows as coverage in AgOpenWeb.
function lanes(f, W) { // W = implement width in metres, read from that tractor's AgOpenWeb tool profile
  const a = world({ x: f.x, y: f.y }), b = world({ x: f.x + f.w, y: f.y + f.h });
  const e0 = Math.min(a.e, b.e), e1 = Math.max(a.e, b.e), n0 = Math.min(a.n, b.n), n1 = Math.max(a.n, b.n);
  const pts = [], in_ = 14; // start and end each pass a little inside the boundary
  if (f.w >= f.h) for (let n = n1 - W / 2 - 9, k = 0; n >= n0 + W / 2; n -= W, k++) pts.push(k % 2 ? { e: e1 - in_, n } : { e: e0 + in_, n }, k % 2 ? { e: e0 + in_, n } : { e: e1 - in_, n });
  else for (let e = e0 + W / 2 + 9, k = 0; e <= e1 - W / 2; e += W, k++) pts.push(k % 2 ? { e, n: n1 - in_ } : { e, n: n0 + in_ }, k % 2 ? { e, n: n0 + in_ } : { e, n: n1 - in_ });
  return pts;
}

function targetFor(u) {
  const t = u.twin;
  if (t.status !== 'ok') return null;
  if (tasks.some(x => x.tractor === u.id && x.state !== 'done')) return { e: 0, n: 0, label: `depot: ${tasks.find(x => x.tractor === u.id && x.state !== 'done').text.toLowerCase()} (waiting for a person)`, maxKph: 20 };
  if (t.action?.kind === 'work' && t.jobId) {
    const job = sim.jobs.get(t.jobId), f = sim.fields.get(job.fieldId);
    if (!u.lane || u.lane.jobId !== job.id) u.lane = { jobId: job.id, pts: lanes(f, u.tel?.rig?.tool?.widthM || 12), i: 0 };
    const p = u.lane.pts[u.lane.i];
    if (u.tel && Math.hypot(p.e - u.tel.e, p.n - u.tel.n) < 6 && u.lane.i < u.lane.pts.length - 1) u.lane.i++;
    // Odd points are pass ends: on the way there the tractor is driving along a pass, so let AgOpenWeb hold the line.
    return { ...u.lane.pts[u.lane.i], label: `${sim.label(job)} (pass ${Math.floor(u.lane.i / 2) + 1})`, maxKph: u.lane.i % 2 === 1 ? 14 : (u.tel && Math.hypot(u.lane.pts[u.lane.i].e - u.tel.e, u.lane.pts[u.lane.i].n - u.tel.n) > 45 ? 20 : 8), field: f.name, follow: u.lane.i % 2 === 1, paint: u.lane.i % 2 === 1,
      job: { task: `${job.id}-${job.type}`, workType: job.type, notes: `Assigned by fleet coordinator, priority ${job.priority}, due ${fmtTime(job.deadline)}` } };
  }
  u.lane = null;
  const w = world(t);
  const label = t.action?.kind === 'goto' ? (t.action.purpose === 'job' && t.jobId ? `drive to ${sim.label(sim.jobs.get(t.jobId))}` : `drive to depot (${t.action.purpose})`) :
    t.action?.kind === 'swap' ? 'depot: changing implement' : t.action?.kind === 'refuel' ? 'depot: refuelling' : 'standing by';
  return { ...w, label, maxKph: 22 };
}

async function dispatch() {
  for (const u of units) {
    const tg = targetFor(u);
    const cmd = tg ? { type: 'goto', e: Math.round(tg.e), n: Math.round(tg.n), label: tg.label, maxKph: tg.maxKph, field: tg.field || null, follow: !!tg.follow, paint: !!tg.paint, job: tg.job || null } : { type: 'stop', label: 'out of service' };
    const key = JSON.stringify(cmd);
    if (key === u.lastKey && Date.now() - (u.lastSent || 0) < 4000) continue;
    u.cmd = cmd; u.lastKey = key; u.lastSent = Date.now();
    call(u, 'POST', '/command', cmd).catch(() => {});
  }
}

function raise(u, kind, signal) {
  if (u.fault || u.twin.status !== 'ok') return;
  u.fault = kind;
  trail('fault-detector', 'planner', 'fault', `${u.id} ${kind}: ${signal}`, { tractor: u.id, kind });
  sim.inject({ type: 'breakdown', tractor: u.id, note: kind === 'NO_RESPONSE' ? 'stopped responding' : 'GO acknowledged but GPS position not changing', source: 'telematics', signal: `${kind} — ${signal}` });
}
function clear(u, why) {
  if (u.twin.status !== 'broken') { u.fault = null; return; }
  u.fault = null; u.stuckSince = 0; u.anchor = null;
  trail('fault-detector', 'planner', 'recovered', `${u.id} ${why}`, { tractor: u.id });
  sim.inject({ type: 'repair', tractor: u.id, note: why, source: 'telematics', signal: why });
}

async function poll() {
  const now = Date.now();
  await Promise.all(units.map(async (u) => {
    try { u.tel = await call(u, 'GET', '/telemetry'); u.lastSeen = now; } catch { /* silence is the signal */ }
    if (!u.lastSeen) return;                                   // never heard from it yet
    if (now - u.lastSeen > STALE_MS) { raise(u, 'NO_RESPONSE', `no telemetry for ${((now - u.lastSeen) / 1000).toFixed(1)} s`); u.wasSilent = true; return; }
    if (u.fault === 'NO_RESPONSE' && u.wasSilent && now - u.lastSeen < 500) { u.wasSilent = false; clear(u, 'is answering again'); }
    const c = u.cmd;
    if (c?.type === 'goto' && u.twin.status === 'ok') {
      const far = Math.hypot(c.e - u.tel.e, c.n - u.tel.n) > FAR_M;
      if (!u.anchor || Math.hypot(u.tel.e - u.anchor.e, u.tel.n - u.anchor.n) > MOVED_M || !far) { u.anchor = { e: u.tel.e, n: u.tel.n }; u.stuckSince = now; }
      else if (now - u.stuckSince > STUCK_MS) raise(u, 'GO_NOT_MOVING', `GO acknowledged (ack ${u.tel.ack}), ${Math.round(Math.hypot(c.e - u.tel.e, c.n - u.tel.n))} m from target, moved under ${MOVED_M} m in ${(STUCK_MS / 1000)} s`);
    } else { u.anchor = null; u.stuckSince = now; }
  }));
}

// ---- People in the loop. Fuelling and implement changes are done by a person at the depot. The plan
// holds that tractor there, its process is locked so it cannot move, and nothing continues until someone
// presses "Good to go" in the web app. An implement change is then written to that tractor's AgOpenWeb.
const tasks = [];
const AUTO_GO_S = Number(opt('auto-humans', 0));   // for unattended test runs only
function humanGate() {
  for (const u of units) {
    const a = u.twin.action;
    if (u.twin.status !== 'ok' || !a || (a.kind !== 'refuel' && a.kind !== 'swap')) continue;
    let k = tasks.find(x => x.tractor === u.id && x.state !== 'done');
    if (!k) {
      const tool = a.kind === 'swap' ? (u.tel?.rig?.tools || []).find(x => x.kind === a.impl)?.profile || a.impl : null;
      k = { id: `H${tasks.length + 1}`, tractor: u.id, kind: a.kind, impl: a.impl || null, tool, full: a.left, state: 'on-way', clock: fmtTime(sim.time), go: false };
      k.text = a.kind === 'swap' ? `Change ${u.id}'s implement to ${tool}` : `Refuel ${u.id}`;
      tasks.push(k);
      trail('planner', 'person at depot', 'request', `${k.text}. ${u.id} is heading to the depot.`, { task: k.id });
    }
    const parked = u.tel && Math.hypot(u.tel.e, u.tel.n) < 25 && u.tel.speedKph < 1;
    if (k.state === 'on-way' && parked) {
      k.state = 'waiting'; k.waitingSince = Date.now();
      call(u, 'POST', '/service', { kind: k.kind, tool: k.tool }).catch(() => {});
      trail('executor', 'person at depot', 'locked', `${u.id} is parked at the depot and locked. ${k.text}, then press Good to go.`, { task: k.id });
    }
    if (AUTO_GO_S && k.state === 'waiting' && Date.now() - k.waitingSince > AUTO_GO_S * 1000) k.go = true;
    if (k.go && k.state === 'waiting') {
      k.state = 'done'; a.left = 1;                          // the work is done: the plan moves on at the next minute
      replay.push({ t: sim.time, kind: 'release', tractor: u.id });
      call(u, 'POST', '/release', {}).catch(() => {});
      trail('person at depot', 'executor', 'good-to-go', `${k.text}: done. ${u.id} is released${k.tool ? ` and its AgOpenWeb tool profile is now ${k.tool}` : ''}.`, { task: k.id });
    } else {
      a.left = k.full;                                       // hold: no fuel gauge change, no new implement, no movement
      replay.push({ t: sim.time, kind: 'hold', tractor: u.id, left: k.full });
    }
  }
}

function command(line) {
  const [verb, id, mode] = line.trim().split(/\s+/);
  const u = units.find(x => x.id === id);
  if (verb === 'quit') return finish('operator quit');
  if (!u) return console.log('commands: break T1 | repair T1 | fault T2 stuck|dead|ok | quit');
  if (verb === 'break') sim.inject({ type: 'breakdown', tractor: id, note: 'reported by operator', source: 'operator', signal: 'operator report' });
  else if (verb === 'repair') clear(u, 'cleared by operator');
  else if (verb === 'fault') { trail('test', u.id, 'inject', `fault ${mode}`); fetch(`${u.url}/fault/${mode}`, { method: 'POST' }).catch(() => {}); }
}
readline.createInterface({ input: process.stdin }).on('line', command);

function status() {
  console.log('           ' + units.map(u => {
    const w = world(u.twin), lag = u.tel ? Math.round(Math.hypot(w.e - u.tel.e, w.n - u.tel.n)) : '?';
    return `${u.id} ${u.twin.status === 'ok' ? (u.twin.action?.kind || 'idle') : 'DOWN'} real(${u.tel ? `${Math.round(u.tel.e)},${Math.round(u.tel.n)} ${u.tel.speedKph}km/h` : 'no telemetry'}) plan-gap ${lag}m`;
  }).join(' | '));
}

let stopped = false;
function finish(why) {
  if (stopped) return; stopped = true;
  for (const u of units) call(u, 'POST', '/command', { type: 'stop', label: 'run ended' }).catch(() => {});
  const m = sim.metrics();
  fs.writeFileSync(path.join(here, 'out', 'live_metrics.json'), JSON.stringify(m, null, 1));
  console.log(`\nRun ended (${why}) at ${fmtTime(sim.time)}. Trail: agopen/out/trail.jsonl`);
  setTimeout(() => process.exit(0), 400);
}

// ---- Status page: every tractor's state, the job list, the message trail, and each AgOpenWeb view.
const recent = [];
let newJobSeq = 0;
const _trail = trail;
trail = function (from, to, type, text, data) { recent.push({ clock: fmtTime(sim.time), from, to, type, text }); if (recent.length > 60) recent.shift(); return _trail(from, to, type, text, data); };
function stateOf(u) {
  const t = u.twin, k = t.action?.kind;
  if (u.fault === 'NO_RESPONSE') return { code: 'NO_RESPONSE', text: 'Not responding' };
  if (u.fault === 'GO_NOT_MOVING') return { code: 'GO_NOT_MOVING', text: 'GO acknowledged, GPS not moving' };
  if (t.status !== 'ok') return { code: 'DOWN', text: 'Out of service' };
  if (k === 'work') return { code: 'WORKING', text: 'Working' };
  if (k === 'goto') return { code: 'DRIVING', text: 'Driving' };
  if (k === 'swap') return { code: 'SWAP', text: 'Changing implement' };
  if (k === 'refuel') return { code: 'REFUEL', text: 'Refuelling' };
  return { code: 'STANDBY', text: 'Standing by' };
}
function snapshot() {
  const assign = sim.dispatcher.plan?.assign || {};
  return {
    scenario: scenario.name, clock: fmtTime(sim.time), secPerMin: SEC, finished: sim.finished || stopped,
    tractors: units.map((u, i) => {
      const w = world(u.twin);
      return {
        id: u.id, name: u.twin.name, agopenPort: nodePorts[i] - 1000, state: stateOf(u), task: u.cmd?.label || '',
        mounted: u.twin.mounted, fuelPct: Math.round(100 * u.twin.fuel / u.twin.fuelCapacity),
        queue: (assign[u.id] || []).map(x => x?.id ?? x),
        tel: u.tel, heardAgoMs: u.lastSeen ? Date.now() - u.lastSeen : null,
        planGapM: u.tel ? Math.round(Math.hypot(w.e - u.tel.e, w.n - u.tel.n)) : null,
      };
    }),
    jobs: [...sim.jobs.values()].map(j => ({
      id: j.id, label: sim.label(j), field: sim.fields.get(j.fieldId)?.name, type: j.type, status: j.status, priority: j.priority, deadline: fmtTime(j.deadline),
      pct: Math.round(100 * (1 - j.remaining / j.acres)),
      tractor: Object.keys(assign).find(id => (assign[id] || []).some(x => (x?.id ?? x) === j.id)) || (sim.tractors.find(t => t.jobId === j.id)?.id ?? ''),
    })),
    tasks: tasks.filter(x => x.state !== 'done').map(x => ({ id: x.id, tractor: x.tractor, kind: x.kind, text: x.text, state: x.state, since: x.clock })),
    trail: recent.slice(-40).reverse(),
  };
}
const PAGE_PORT = Number(opt('page', 5190));
http.createServer((req, res) => {
  if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(snapshot())); }
  const m = req.method === 'POST' && req.url.match(/^\/human\/(H\d+)\/go$/);
  if (m) {
    const k = tasks.find(x => x.id === m[1]);
    if (!k || k.state !== 'waiting') { res.writeHead(409); return res.end(k ? 'The tractor is not parked at the depot yet.' : 'unknown task'); }
    k.go = true; res.writeHead(200); return res.end('ok');
  }
  // The 3D view replays this log against its own copy of the planner's world, so both show the same day.
  if (req.url === '/replay') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ time: sim.time, finished: sim.finished || stopped, entries: replay })); }
  if (req.url === '/scenario.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ...scenario, events: [] })); }
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { const e = JSON.parse(body); delete e.time; sim.inject(e); res.writeHead(200); res.end('ok'); } catch { res.writeHead(400); res.end(); } });
    return;
  }
  if (req.method === 'GET' && (req.url.startsWith('/dashboard/') || req.url.startsWith('/src/'))) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html');
    const file = path.join(repo, rel);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  if (req.url === '/farm') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ home: HOME, depot: scenario.depot.name, source: FIELDS_DIR, fields: readAgFields() }));
  }
  if (req.method === 'POST' && req.url === '/jobs') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const b = JSON.parse(body), [hh, mm] = String(b.deadline || '17:00').split(':').map(Number);
        const jobs = (b.fields || []).map((name) => {
          const f = scenario.fields.find(x => x.name === name);
          return f && { id: `N${++newJobSeq}`, type: b.type, fieldId: f.id, priority: b.priority || 'medium', deadline: hh * 60 + mm - 6 * 60, note: b.note || 'selected on the farm map' };
        }).filter(Boolean);
        if (!jobs.length) { res.writeHead(400); return res.end('no known fields selected'); }
        trail('operator', 'planner', 'jobs', `${jobs.length} job(s) requested: ${b.type} on ${b.fields.join(', ')}`);
        sim.inject({ type: 'new_jobs', jobs, source: 'operator', signal: `Operator selected ${b.fields.length} field(s) on the farm map` });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ added: jobs.map(j => j.id) }));
      } catch (err) { res.writeHead(400); res.end(String(err.message)); }
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/cmd/')) { command(decodeURIComponent(req.url.slice(5))); res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(path.join(here, 'live.html')));
}).listen(PAGE_PORT, () => console.log(`Status page → http://localhost:${PAGE_PORT}/`));

await poll();
const missing = units.filter(u => !u.tel).map(u => `${u.id} (${u.url})`);
if (missing.length) { console.log(`No telemetry from ${missing.join(', ')}. Start each with: node agopen/tractor-node.js <id> <agopen port>`); process.exit(1); }

setInterval(() => { if (!stopped) poll(); }, 250);
setInterval(() => { if (!stopped) dispatch(); }, 500);
setInterval(() => { if (!stopped) status(); }, 8000);
setInterval(() => {
  if (stopped) return;
  for (const s of script) if (!s.done && sim.time >= s.at) { s.done = true; command(s.cmd); }
  if (sim.finished || sim.time >= UNTIL) return finish(sim.finished ? 'all work complete' : `reached ${fmtTime(UNTIL)}`);
  humanGate();
  sim.step();
}, SEC * 1000);
