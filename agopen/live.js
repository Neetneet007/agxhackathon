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
import { fmtTime, ratePerMin, IMPLEMENT_FOR } from '../src/model.js';
import { applyTools, passKph } from './rig.js';
import { planCoverage, routeProgress } from './coverage.js';
import { buildLanes } from './lanes.js';
import { createRoundtable } from './roundtable/roundtable.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : def);
const scenarioPath = args.find(a => a.endsWith('.json')) || path.join(here, 'scenario.live.json');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const farmMeta = fs.existsSync(path.join(here, 'farm.json')) ? JSON.parse(fs.readFileSync(path.join(here, 'farm.json'), 'utf8')) : {};
const CELL = Number(opt('cell', farmMeta.cell || 20));     // metres per plan grid cell; must match the farm that was built
// Real seconds per plan minute. The plan moves a tractor one cell every 2 plan-minutes, so this value makes
// that 20 km/h: tractors drive at real speed and the plan's clock keeps pace with them.
const SEC = Number(opt('sec', +(CELL * 0.09).toFixed(2)));
const UNTIL = args.includes('--until') ? Number(opt('until', 720)) : Infinity;
// --preset starts with the scenario's job list already submitted; otherwise the operator builds the list.
const PRESET = args.includes('--preset');
const nodePorts = opt('nodes', scenario.tractors.map((_, i) => 6175 + i).join(',')).split(',').map(Number);
const script = String(opt('script', '')).split(';').filter(Boolean).map(s => ({ at: Number(s.split(':')[0]), cmd: s.slice(s.indexOf(':') + 1).trim(), done: false }));

const STALE_MS = 3000;      // no telemetry for this long → NO_RESPONSE
const STUCK_MS = 8000;      // told to go, far from target, not moving for this long → GO_NOT_MOVING
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
const geom = {};   // field name → outline and guidance line in metres from the depot, as read from AgOpenWeb
if (HOME) {
  let added = 0;
  for (const af of agFields) {
    if (af.boundary.length < 4) continue;
    const pts = af.boundary.map(([lon, lat]) => toWorld(lat, lon));
    let a2 = 0;
    for (let i = 0; i < pts.length - 1; i++) a2 += pts[i].e * pts[i + 1].n - pts[i + 1].e * pts[i].n;
    const line = af.tracks[0]?.line.map(([lon, lat]) => toWorld(lat, lon));
    geom[af.name] = { boundary: pts, abLine: line && line.length >= 2 ? { a: line[0], b: line[line.length - 1] } : null, acres: Math.abs(a2) / 2 / 4047 };
    const known = scenario.fields.find(f => f.name === af.name);
    if (known) { known.acres = +geom[af.name].acres.toFixed(2); continue; }   // the outline in AgOpenWeb is the truth for area
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
const rigs = await Promise.all(nodePorts.map(async (p) => {
  try { return (await (await fetch(`http://127.0.0.1:${p}/telemetry`, { signal: AbortSignal.timeout(1500) })).json()).rig; } catch { return null; }
}));
scenario.tractors.forEach((t, i) => {
  const tools = applyTools(t, rigs[i]?.tools || [], rigs[i]?.activeTool);
  if (tools) console.log(`${t.id} from AgOpenWeb: ${tools.map(x => `${x.profile} = ${x.kind}, ${x.widthM} m, ${t.workRates[x.kind]} ac/h`).join('; ')}; mounted: ${t.mounted}`);
  else console.log(`${t.id}: no implement profiles found in AgOpenWeb; using the scenario's list.`);
  // The plan's clock runs faster than a wall clock (one plan minute = SEC real seconds), so a rate in acres
  // per real hour becomes this many acres per plan hour. Travel is already consistent by construction.
  for (const k of Object.keys(t.workRates)) t.workRates[k] = +(t.workRates[k] * SEC / 60).toFixed(3);
});
const presetJobs = scenario.jobs.map(({ acres, ...j }) => j);   // areas come from the field outlines
scenario.jobs = PRESET ? presetJobs : [];

const sim = new Simulator({ ...scenario, events: [] }, new Coordinator(), { scriptedEvents: false });
// Everything that changes the plan's world is recorded, so the 3D view can replay exactly the same day.
const replay = [];
const _inject = sim.inject.bind(sim);
sim.inject = (e) => { const ev = { ...e, time: Math.max(e.time ?? sim.time, sim.time) }; replay.push({ t: ev.time, kind: 'event', event: ev }); return _inject(ev); };
const dep = sim.depot;
const world = (c) => ({ e: (c.x - dep.x) * CELL, n: -(c.y - dep.y) * CELL });
// Each tractor has its own parking bay at the depot, 10 m apart, so parked machines never share a spot.
const bay = (i) => ({ e: (i - (scenario.tractors.length - 1) / 2) * 10, n: 0 });

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
const trailFile = path.join(here, 'out', 'trail.jsonl');
fs.writeFileSync(trailFile, '');
let trail = function (from, to, type, text, data = {}) {
  const row = { wall: new Date().toISOString(), clock: fmtTime(sim.time), from, to, type, text, ...data };
  fs.appendFileSync(trailFile, JSON.stringify(row) + '\n');
  console.log(`[${row.clock}] ${from} → ${to}  ${type}: ${text}`);
};
sim.listeners.push((e) => {
  if (!['plan', 'event', 'done'].includes(e.type)) return;
  const who = e.type === 'plan' ? ['planner', 'executor'] : e.type === 'done' ? ['executor', 'planner'] : ['world', 'planner'];
  trail(who[0], who[1], e.type, e.text);
  for (const l of e.lines || []) console.log(`           ${l}`);
});
console.log(`Scenario: ${scenario.name}`);
if (PRESET) for (const e of sim.log.filter(e => e.type === 'plan')) { console.log(`[${e.clock}] ${e.text}`); for (const l of e.lines || []) console.log(`           ${l}`); }
else console.log('All tractors at home. Build the job list on the status page, then start the day.');

const units = sim.tractors.map((t, i) => ({
  id: t.id, twin: t, bay: bay(i), url: `http://127.0.0.1:${nodePorts[i]}`,
  tel: null, lastSeen: 0, fault: null, cmd: null, stuckSince: 0, anchor: null, place: 'depot', trip: null,
}));

async function call(u, method, pathname, body) {
  const res = await fetch(u.url + pathname, {
    method, signal: AbortSignal.timeout(700),
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return method === 'GET' ? res.json() : res.text();
}

// ---- Field work. Each job gets one coverage route for its field: parallel passes one implement-width
// apart along the field's guidance line, turning in the headland, then a lap round the boundary. The route
// belongs to the job, not the tractor, so if another tractor takes the job over it carries on from the
// same waypoint: nothing is repeated and nothing is missed.
const routes = new Map();
function routeFor(job, u) {
  let r = routes.get(job.id);
  if (r) return r;
  const f = sim.fields.get(job.fieldId), kind = IMPLEMENT_FOR[job.type];
  const tools = u.tel?.rig?.tools || [];
  const width = tools.find(x => x.kind === kind)?.widthM || u.tel?.rig?.tool?.widthM || 12;
  let g = geom[f.name];
  if (!g) {   // no outline in AgOpenWeb: fall back to the plan's rectangle
    const a = world({ x: f.x, y: f.y }), b = world({ x: f.x + f.w, y: f.y + f.h });
    g = { boundary: [{ e: a.e, n: a.n }, { e: b.e, n: a.n }, { e: b.e, n: b.n }, { e: a.e, n: b.n }], abLine: null };
  }
  const abLine = g.abLine || { a: g.boundary[0], b: g.boundary[1] };
  const plan = planCoverage({ boundary: g.boundary, abLine, width, headlandPasses: 1, start: u.tel ? { e: u.tel.e, n: u.tel.n } : null });
  // Legs to drive. Before each pass there is a straight run-up in the headland so the tractor is lined up
  // before the implement goes on. Every working leg is driven as a line (from → to), not as a point to aim at.
  const pts = [];
  const runUp = Math.max(3, Math.min(7, width - 1));
  for (let i = 0; i < plan.route.length; i++) {
    const p = plan.route[i], prev = plan.route[i - 1];
    if (p.kind === 'pass-start') {
      const end = plan.route[i + 1], L = Math.hypot(end.e - p.e, end.n - p.n) || 1;
      const back = { e: p.e - (end.e - p.e) / L * runUp, n: p.n - (end.n - p.n) / L * runUp };
      pts.push({ ...back, kind: 'turn', swath: p.swath });                                   // turn in the headland
      pts.push({ e: p.e, n: p.n, from: back, track: true, kind: 'run-up', swath: p.swath }); // line up, implement off
    } else if (p.kind === 'pass-end') {
      pts.push({ e: p.e, n: p.n, from: { e: prev.e, n: prev.n }, track: true, paint: true, kind: 'pass', swath: p.swath });
    } else if (p.paint) {
      pts.push({ e: p.e, n: p.n, from: { e: prev.e, n: prev.n }, track: true, paint: true, kind: 'headland', swath: null });
    } else {
      pts.push({ e: p.e, n: p.n, kind: 'turn', swath: null });
    }
  }
  const len = (q) => (q.from ? Math.hypot(q.e - q.from.e, q.n - q.from.n) : 0);
  const paintLen = pts.reduce((acc, q) => acc + (q.paint ? len(q) : 0), 0);
  r = { plan, pts, i: 0, done: false, width, kind, field: f.name, fraction: 0, paintLen, painted: 0, fieldM2: plan.areaM2 };
  routes.set(job.id, r);
  trail('route-planner', 'executor', 'route', `${sim.label(job)}: ${plan.swaths.length} passes at ${width} m plus a headland lap, ${Math.round(plan.lengthM)} m to drive.`, { job: job.id });
  return r;
}
// Move along a job's legs as the tractor really completes them, and measure how much has been worked.
function advanceRoute(r, u) {
  if (!u.tel || r.done) return;
  const along = (q) => { const L = Math.hypot(q.e - q.from.e, q.n - q.from.n) || 1; return ((u.tel.e - q.from.e) * (q.e - q.from.e) + (u.tel.n - q.from.n) * (q.n - q.from.n)) / L; };
  const len = (q) => Math.hypot(q.e - q.from.e, q.n - q.from.n);
  for (let guard = 0; guard < 3; guard++) {
    const q = r.pts[r.i];
    const reached = q.track ? along(q) >= len(q) - 0.6 : Math.hypot(q.e - u.tel.e, q.n - u.tel.n) < 3.5;
    if (!reached) break;
    if (q.paint) r.painted += len(q);
    if (r.i >= r.pts.length - 1) { r.done = true; break; }
    r.i++;
  }
  const q = r.pts[r.i];
  const partial = !r.done && q.paint ? Math.max(0, Math.min(len(q), along(q))) : 0;
  r.fraction = r.done ? 1 : Math.max(r.fraction, (r.painted + partial) / (r.paintLen || 1));
}

// ---- Getting about. Tractors keep to the farm's lanes: a network that runs between the fields, crosses
// the creek only at the bridges, and reaches each field at a gate. They never cut across another field.
const laneNet = buildLanes(scenario, { cell: CELL });
function tripTarget(u, dest) {
  if (!u.trip || u.trip.dest !== dest) {
    const pts = (u.place !== dest && laneNet.routeBetween(u.place, dest)) || null;
    u.trip = { dest, pts: pts && pts.length ? pts : [dest === 'depot' ? { e: 0, n: 0 } : laneNet.gates[dest] || world(sim.fields.get(dest).entry)], i: 0 };
    // Join the lane at the nearest point rather than doubling back to its start.
    if (u.tel) { let best = Infinity; u.trip.pts.forEach((p, k) => { const d = Math.hypot(p.e - u.tel.e, p.n - u.tel.n); if (d < best - 1e-6) { best = d; u.trip.i = k; } }); }
  }
  const tr = u.trip;
  while (u.tel && tr.i < tr.pts.length - 1 && Math.hypot(tr.pts[tr.i].e - u.tel.e, tr.pts[tr.i].n - u.tel.n) < 6) tr.i++;
  const last = tr.i >= tr.pts.length - 1;
  if (last && u.tel && Math.hypot(tr.pts[tr.i].e - u.tel.e, tr.pts[tr.i].n - u.tel.n) < 6) u.place = dest;
  if (dest === 'depot' && (last || u.place === 'depot')) return { ...u.bay };       // off the lane and into its own bay
  return { ...tr.pts[tr.i] };
}

// Holds placed by an agent (for example the weather agent stopping spraying). A tractor on a held job
// stops where it is with the implement off; the job makes no progress until the hold is lifted.
const holds = new Map();
// A recall sends every tractor back to its depot bay along the lanes, and keeps it there, until it is lifted.
const recalls = new Map();
const heldBy = (job) => [...holds.values()].find(h => (h.jobTypes.includes('*') || h.jobTypes.includes(job.type)) && (!h.fields || h.fields.includes(sim.fields.get(job.fieldId)?.name)));

function targetFor(u) {
  const t = u.twin;
  if (t.status !== 'ok') return null;
  if (recalls.size) return { ...tripTarget(u, 'depot'), label: `recalled to the depot: ${[...recalls.values()][0].reason}`, maxKph: 20 };
  if (tasks.some(x => x.tractor === u.id && x.state !== 'done')) return { ...tripTarget(u, 'depot'), label: `depot: ${tasks.find(x => x.tractor === u.id && x.state !== 'done').text.toLowerCase()} (waiting for a person)`, maxKph: 20 };
  if (t.action?.kind === 'work' && t.jobId) {
    const job = sim.jobs.get(t.jobId), f = sim.fields.get(job.fieldId);
    // Still on the lane: reach this field's gate first. The field is only opened in AgOpenWeb once we are there.
    if (u.place !== job.fieldId) return { ...tripTarget(u, job.fieldId), label: `lane to ${sim.label(job)}`, maxKph: 20 };
    u.trip = null;
    const h = heldBy(job);
    if (h && u.tel) return { e: u.tel.e, n: u.tel.n, label: `${sim.label(job)}: on hold (${h.reason})`, maxKph: 0, field: f.name };
    const r = routeFor(job, u);
    advanceRoute(r, u);
    const p = r.pts[r.i];
    if (r.done) return { e: p.e, n: p.n, label: `${sim.label(job)}: field covered`, maxKph: 0, field: f.name };
    const what = p.kind === 'headland' ? 'headland lap' : p.kind === 'turn' && p.swath == null ? 'to the headland' : `pass ${p.swath + 1} of ${r.plan.swaths.length}${p.kind === 'pass' ? '' : ' (lining up)'}`;
    return {
      e: p.e, n: p.n, from: p.from || null, track: !!p.track, paint: !!p.paint,
      label: `${sim.label(job)}: ${what}, ${Math.round(r.fraction * 100)}% worked`,
      maxKph: p.paint ? Math.min(16, passKph(r.kind)) : p.track ? 7 : 9, field: f.name,
      job: { task: `${job.id}-${job.type}`, workType: job.type, notes: `Assigned by fleet coordinator, priority ${job.priority}, due ${fmtTime(job.deadline)}` },
    };
  }
  // Travelling: follow the lanes to wherever the plan is sending this tractor.
  const a = t.action;
  const dest = a?.kind === 'goto' ? (a.purpose === 'job' && t.jobId ? sim.jobs.get(t.jobId).fieldId : 'depot') :
    (a?.kind === 'swap' || a?.kind === 'refuel' || (t.x === dep.x && t.y === dep.y)) ? 'depot' : null;
  if (!dest) return u.tel ? { e: u.tel.e, n: u.tel.n, label: 'standing by', maxKph: 0 } : null;
  const label = a?.kind === 'goto' ? (dest === 'depot' ? `lane to the depot (${a.purpose})` : `lane to ${sim.label(sim.jobs.get(t.jobId))}`) :
    a?.kind === 'swap' ? 'depot: changing implement' : a?.kind === 'refuel' ? 'depot: refuelling' : 'standing by at the depot';
  return { ...tripTarget(u, dest), label, maxKph: 20 };
}

// The plan's idea of how much of a job is left is overwritten each minute with what the tractor has really
// covered, so a job finishes when the field is done, not when a timer runs out.
function syncProgress() {
  for (const u of units) {
    const t = u.twin;
    if (t.status !== 'ok' || t.action?.kind !== 'work' || !t.jobId) continue;
    const job = sim.jobs.get(t.jobId), r = routes.get(job.id);
    if (!r) continue;
    const perMin = ratePerMin(t, job.type);
    job.remaining = r.done ? Math.min(job.remaining, perMin * 0.5) : Math.max(job.acres * (1 - r.fraction), perMin * 1.5);
    replay.push({ t: sim.time, kind: 'progress', job: job.id, remaining: job.remaining });
  }
}

// Give way. If two moving tractors come within 9 m, the one doing less important work stops where it is
// until they are 13 m apart again. A tractor that is working a pass keeps going; otherwise the lower-numbered
// tractor has right of way.
function givingWayTo(u) {
  if (!u.tel) return null;
  for (const o of units) {
    if (o === u || !o.tel || o.twin.status !== 'ok') continue;
    const d = Math.hypot(u.tel.e - o.tel.e, u.tel.n - o.tel.n);
    const limit = u.yieldTo === o.id ? 13 : 9;
    if (d > limit) continue;
    const oMoving = o.tel.speedKph > 0.5, uWorking = u.cmd?.paint, oWorking = o.cmd?.paint;
    const iYield = oMoving && (oWorking && !uWorking ? true : uWorking && !oWorking ? false : units.indexOf(u) > units.indexOf(o));
    if (iYield) return o;
  }
  return null;
}

async function dispatch() {
  for (const u of units) {
    let tg = targetFor(u);
    const other = tg && tg.maxKph !== 0 ? givingWayTo(u) : null;
    u.yieldTo = other ? other.id : null;
    if (other) tg = { e: u.tel.e, n: u.tel.n, label: `giving way to ${other.id}`, maxKph: 0, field: tg.field };
    const cmd = tg ? { type: 'goto', e: +tg.e.toFixed(2), n: +tg.n.toFixed(2), label: tg.label, maxKph: tg.maxKph, field: tg.field || null, from: tg.from || null, track: !!tg.track, paint: !!tg.paint, job: tg.job || null } : { type: 'stop', label: 'out of service' };
    const key = JSON.stringify(cmd);
    if (key === u.lastKey && Date.now() - (u.lastSent || 0) < 4000) continue;
    u.cmd = cmd; u.lastKey = key; u.lastSent = Date.now();
    call(u, 'POST', '/command', cmd).catch(() => {});
  }
}

let lastFault = null;
function raise(u, kind, signal) {
  if (u.fault || u.twin.status !== 'ok') return;
  u.fault = kind; lastFault = { tractor: u.id, kind, signal };
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
    if (c?.type === 'goto' && u.twin.status === 'ok' && !u.tel.busy && c.maxKph !== 0) {
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
    const parked = u.tel && Math.hypot(u.tel.e - u.bay.e, u.tel.n - u.bay.n) < 8 && u.tel.speedKph < 1;
    if (k.state === 'on-way' && parked) {
      k.state = 'waiting'; k.waitingSince = Date.now();
      call(u, 'POST', '/service', { kind: k.kind, tool: k.tool }).catch(() => {});
      trail('executor', 'person at depot', 'locked', `${u.id} is parked at the depot and locked. ${k.text}, then press Good to go.`, { task: k.id });
      discuss('service-request', k.text, { tractor: u.id, work: k.text, state: 'parked at the depot and locked; waiting for a person to press Good to go' });
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

// ---- The operator's job list. Jobs are drafted, optionally in order within a field (plow, then sow), and
// handed to the planner when the day starts. A step that must follow another is held back until the
// earlier one is finished, then released.
let mode = PRESET ? 'running' : 'building';
const backlog = [];
let jobSeq = 0;
const labelOf = (b) => `${b.id} ${({ till: 'Till', seed: 'Seed', spray: 'Spray', mow: 'Mow' })[b.type]} ${b.field}`;
function draftJobs({ fields = [], steps = [], priority = 'medium', deadline = '17:00' }) {
  const [hh, mm] = String(deadline).split(':').map(Number);
  const due = hh * 60 + mm - 6 * 60;
  if (!fields.length) throw new Error('Pick at least one field.');
  if (!steps.length) throw new Error('Pick at least one operation.');
  for (const st of steps) if (!IMPLEMENT_FOR[st]) throw new Error(`Unknown operation: ${st}`);
  if (!(due > sim.time)) throw new Error('The finish time has already passed.');
  const added = [];
  for (const name of fields) {
    const f = scenario.fields.find(x => x.name === name);
    if (!f) throw new Error(`Unknown field: ${name}`);
    let prev = null;
    for (const type of steps) {
      const b = { id: `N${++jobSeq}`, field: f.name, fieldId: f.id, type, priority, deadline: due, waitsFor: prev, status: 'draft' };
      backlog.push(b); added.push(b.id); prev = b.id;
    }
  }
  trail('operator', 'planner', 'jobs', `${added.length} job(s) drafted: ${steps.join(' then ')} on ${fields.join(', ')}.`);
  if (mode === 'running') releaseReady();
  return added;
}
function releaseReady() {
  const ready = backlog.filter(b => b.status !== 'released' && (!b.waitsFor || sim.jobs.get(b.waitsFor)?.status === 'done'));
  for (const b of backlog) if (b.status === 'draft' && !ready.includes(b)) b.status = 'waiting';
  if (!ready.length) return;
  for (const b of ready) b.status = 'released';
  sim.finished = false;   // new work re-opens a day that had run out of jobs
  sim.inject({ type: 'new_jobs', jobs: ready.map(b => ({ id: b.id, type: b.type, fieldId: b.fieldId, priority: b.priority, deadline: b.deadline, note: b.waitsFor ? `follows ${b.waitsFor}` : 'from the job list' })), source: 'operator', signal: 'Job list on the status page' });
}
function removeDraft(id) {
  const b = backlog.find(x => x.id === id);
  if (!b) throw new Error('No such job.');
  const doomed = [b];
  for (let grew = true; grew;) { grew = false; for (const x of backlog) if (!doomed.includes(x) && doomed.some(d => d.id === x.waitsFor)) { doomed.push(x); grew = true; } }
  if (doomed.some(x => x.status === 'released')) throw new Error('That job, or one that follows it, is already with the planner.');
  for (const x of doomed) backlog.splice(backlog.indexOf(x), 1);
}
function startDay() {
  if (mode === 'running') throw new Error('The day is already running.');
  if (!backlog.length) throw new Error('Add at least one job first.');
  mode = 'running';
  trail('operator', 'planner', 'start', `Day started with ${backlog.length} job(s) on the list.`);
  releaseReady();
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

// ---- Roundtable. The rules above have already acted, in milliseconds. Here the managers talk it through
// where the operator can see it, and the Plan Manager may make the judgement calls through its tools.
// None of this can delay a tractor: discussions run on their own, and a slow or missing model just means
// a rule-written line appears instead.
const roundLines = [];
const fleetFacts = () => units.map(u => ({ id: u.id, state: stateOf(u).text, task: u.cmd?.label || '', implement: u.twin.mounted, fuelPct: Math.round(100 * u.twin.fuel / u.twin.fuelCapacity) }));
const jobFacts = () => [...sim.jobs.values()].filter(j => j.status !== 'done' && j.status !== 'cancelled').map(j => ({ id: j.id, label: sim.label(j), priority: j.priority, deadline: fmtTime(j.deadline), workedPct: Math.round(100 * (routes.get(j.id)?.fraction ?? 0)) }));
const rt = createRoundtable({
  say: (line) => {
    if (!rtTitles.has(line.topicId)) rtTitles.set(line.topicId, rtPending.shift() || '');   // discussions run one at a time, in order
    roundLines.push({ ...line, agent: line.role || line.agent, topic: rtTitles.get(line.topicId), clock: fmtTime(sim.time) });
    if (roundLines.length > 120) roundLines.shift();
  },
  tools: {
    change_priority: {
      description: 'Change a job\'s priority (high, medium or low) so the planner brings it forward or pushes it back.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['job', 'priority', 'reason'] },
      handler: async ({ job, priority, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'priority_change', job, priority, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} is now ${priority} priority.`; },
    },
    approve_late: {
      description: 'Accept that a job will finish after its deadline, so the planner keeps it in today\'s plan.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'] },
      handler: async ({ job, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'priority_change', job, allowLate: true, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} may finish late.`; },
    },
    defer_job: {
      description: 'Take a job out of today\'s plan and leave it for tomorrow. Use only when it cannot be done today.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'] },
      handler: async ({ job, reason }) => { if (!sim.jobs.get(job)) return `No job ${job}.`; sim.inject({ type: 'cancel_job', job, note: reason, source: 'plan-manager', signal: 'Plan Manager decision' }); return `${job} deferred to tomorrow.`; },
    },
  },
});
const rtTitles = new Map(), rtPending = [];
function discuss(type, title, facts) {
  rtPending.push(title);
  const full = { clock: fmtTime(sim.time), ...facts, fleet: fleetFacts(), openJobs: jobFacts() };
  rt.convene({ type, title, facts: full }).catch(() => {});
}
// Turn the planner's own log into topics for the table.
sim.listeners.push((e) => {
  if (e.type === 'plan') {
    const lines = (e.lines || []).slice(0, 6);
    const lf = lastFault;
    if (/broke down/i.test(e.text) && lf) discuss('fault', `${lf.tractor} out of service`, { tractor: lf.tractor, kind: lf.kind, signal: lf.signal, plan: e.text, changes: lines });
    else if (/back in service/i.test(e.text)) discuss('recovered', e.text, { tractor: (e.text.match(/T\d+/) || [''])[0], plan: e.text, changes: lines });
    else if (/new job/i.test(e.text)) discuss(sim.time < 2 ? 'day-start' : 'new-jobs', e.text, { plan: e.text, changes: lines });
  } else if (e.type === 'done') {
    discuss('job-done', e.text, { tractor: (e.text.match(/T\d+/) || [''])[0], job: e.text, state: 'job finished' });
  }
});

// ---- Status page: every tractor's state, the job list, the message trail, and each AgOpenWeb view.
const recent = [];
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
    scenario: scenario.name, clock: fmtTime(sim.time), secPerMin: SEC, finished: stopped, mode,
    backlog: backlog.map(b => ({ id: b.id, field: b.field, type: b.type, label: labelOf(b), priority: b.priority, deadline: fmtTime(b.deadline), waitsFor: b.waitsFor ? labelOf(backlog.find(x => x.id === b.waitsFor) || { id: b.waitsFor, type: 'till', field: '' }) : null, status: b.status })),
    holds: [...holds.values()], recalls: [...recalls.values()],
    roundtable: roundLines.slice(-30).reverse(), agents: rt.agents, roundtableStats: rt.stats(),
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
      pct: j.status === 'done' ? 100 : Math.round(100 * (routes.get(j.id)?.fraction ?? (1 - j.remaining / j.acres))),
      route: routes.get(j.id) ? { passes: routes.get(j.id).plan.swaths.length, widthM: routes.get(j.id).width, lengthM: Math.round(routes.get(j.id).plan.lengthM), fieldM2: Math.round(routes.get(j.id).fieldM2) } : null,
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
    return res.end(JSON.stringify({ home: HOME, depot: scenario.depot.name, source: FIELDS_DIR, fields: readAgFields(), lanes: laneNet.lanes, gates: Object.values(laneNet.gates).map(g => ({ e: g.e, n: g.n })), bays: units.map(u => ({ id: u.id, ...u.bay })) }));
  }
  const readBody = (cb) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { let b; try { b = JSON.parse(body || '{}'); } catch { res.writeHead(400); return res.end('The request was not valid JSON.'); } try { cb(b); } catch (err) { res.writeHead(409); res.end(String(err.message)); } }); };
  const ok = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj ?? { ok: true })); };
  // Job list
  if (req.method === 'POST' && req.url === '/draft') return readBody((b) => ok({ added: draftJobs(b) }));
  if (req.method === 'POST' && req.url === '/jobs') return readBody((b) => ok({ added: draftJobs({ fields: b.fields, steps: [b.type], priority: b.priority, deadline: b.deadline }) }));
  if (req.method === 'DELETE' && req.url.startsWith('/draft/')) { try { removeDraft(decodeURIComponent(req.url.slice(7))); return ok(); } catch (err) { res.writeHead(409); return res.end(String(err.message)); } }
  if (req.method === 'POST' && req.url === '/start') { try { startDay(); return ok(); } catch (err) { res.writeHead(409); return res.end(String(err.message)); } }
  // For agents: place or lift a hold on a kind of work, and speak on the message trail.
  if (req.method === 'POST' && req.url === '/hold') return readBody((b) => {
    if (!b.id || !Array.isArray(b.jobTypes) || !b.jobTypes.length) throw new Error('A hold needs an id and jobTypes.');
    const fresh = !holds.has(b.id);
    holds.set(b.id, { id: String(b.id), jobTypes: b.jobTypes, fields: Array.isArray(b.fields) && b.fields.length ? b.fields : null, reason: String(b.reason || 'no reason given'), by: String(b.by || 'agent'), since: fmtTime(sim.time) });
    if (fresh) { trail(String(b.by || 'agent'), 'executor', 'hold', `Hold on ${b.jobTypes.join(', ')} work${b.fields?.length ? ` in ${b.fields.join(', ')}` : ''}: ${b.reason || 'no reason given'}`); discuss('hold', `Hold on ${b.jobTypes.join(', ')} work`, { reason: b.reason, by: b.by, work: b.jobTypes.join(', '), fields: b.fields || 'all fields' }); }
    ok({ hold: b.id });
  });
  if (req.method === 'DELETE' && req.url.startsWith('/hold/')) {
    const h = holds.get(decodeURIComponent(req.url.slice(6)));
    if (h) { holds.delete(h.id); trail(h.by, 'executor', 'hold-lifted', `Hold on ${h.jobTypes.join(', ')} work lifted.`); discuss('hold-lifted', `Hold on ${h.jobTypes.join(', ')} work lifted`, { reason: h.reason, by: h.by, work: h.jobTypes.join(', ') }); }
    return ok();
  }
  if (req.method === 'POST' && req.url === '/recall') return readBody((b) => {
    if (!b.id) throw new Error('A recall needs an id.');
    const fresh = !recalls.has(b.id);
    recalls.set(b.id, { id: String(b.id), reason: String(b.reason || 'no reason given'), by: String(b.by || 'agent'), since: fmtTime(sim.time) });
    if (fresh) { trail(String(b.by || 'agent'), 'executor', 'recall', `Fleet recalled to the depot: ${b.reason || 'no reason given'}`); discuss('hold', `Fleet recalled: ${b.reason}`, { reason: b.reason, by: b.by, work: 'all work', state: 'recall' }); }
    ok({ recall: b.id });
  });
  if (req.method === 'DELETE' && req.url.startsWith('/recall/')) {
    const r0 = recalls.get(decodeURIComponent(req.url.slice(8)));
    if (r0) { recalls.delete(r0.id); trail(r0.by, 'executor', 'recall-ended', 'Recall ended. Tractors may leave the depot.'); discuss('hold-lifted', 'Recall ended', { reason: r0.reason, by: r0.by, work: 'all work' }); }
    return ok();
  }
  if (req.method === 'POST' && req.url === '/agent/say') return readBody((b) => { const text = String(b.text || '').slice(0, 400); trail(String(b.from || 'agent'), String(b.to || 'operator'), String(b.type || 'note'), text); roundLines.push({ id: `x${roundLines.length}`, topicId: 'outside', topic: 'From another agent', agent: String(b.from || 'agent'), role: '', text, kind: 'says', clock: fmtTime(sim.time) }); ok(); });
  if (req.method === 'POST' && req.url.startsWith('/cmd/')) { command(decodeURIComponent(req.url.slice(5))); res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(path.join(here, 'live.html')));
}).listen(PAGE_PORT, () => console.log(`Status page → http://localhost:${PAGE_PORT}/`));

await poll();
const missing = units.filter(u => !u.tel).map(u => `${u.id} (${u.url})`);
if (missing.length) { console.log(`No telemetry from ${missing.join(', ')}. Start each with: node agopen/tractor-node.js <id> <agopen port>`); process.exit(1); }

setInterval(() => { if (!stopped) poll(); }, 250);
setInterval(() => { if (!stopped) dispatch(); }, 250);
setInterval(() => { if (!stopped) status(); }, 8000);
setInterval(() => {
  if (stopped) return;
  for (const s of script) if (!s.done && sim.time >= s.at) { s.done = true; command(s.cmd); }
  if (sim.time >= UNTIL) return finish(`reached ${fmtTime(UNTIL)}`);
  if (mode !== 'running') return;                                   // tractors wait at home until the day is started
  releaseReady();
  const work = sim.openJobs().length > 0 || sim.pending.length > 0;
  if (!work) return;                                                // nothing to do: the clock waits with the fleet
  if (sim.finished) sim.finished = false;
  humanGate();
  syncProgress();
  sim.step();
}, SEC * 1000);
