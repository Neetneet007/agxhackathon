#!/usr/bin/env node
// One tractor, one terminal. Wraps a running AgOpenWeb instance and behaves like a machine on the
// network: it accepts commands from the coordinator, drives, and reports telemetry.
//
//   node agopen/tractor-node.js T1 5175            AgOpenWeb on :5175, this node listens on :6175
//   node agopen/tractor-node.js T2 5176 --chaos 90 also inject a random fault about every 90 s
//
// Type a fault into this terminal while it runs:
//   dead    stop responding (no telemetry, machine halts)
//   stuck   keep acknowledging GO, but the wheels do not turn (GPS position stays put)
//   ok      clear the fault
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tractor } from './tractor.js';
import { kindOf } from './rig.js';

const [id, agPort] = [process.argv[2] || 'T1', Number(process.argv[3] || 5175)];
const port = agPort + 1000;
const chaos = process.argv.includes('--chaos') ? Number(process.argv[process.argv.indexOf('--chaos') + 1]) : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const t = new Tractor(id, agPort);
let fault = 'ok', cmd = null, seq = 0, acked = 0, lastCmdAt = 0;
let bayHome = null;
// This tractor's own parking bay: 10 m apart along the depot front, so three machines never share a spot.
const bayIndex = process.argv.includes('--bay') ? Number(process.argv[process.argv.indexOf('--bay') + 1]) : Math.max(0, Number(id.replace(/\D/g, '')) - 1);
const bayLon = (home) => home.lon + ((bayIndex - 1) * 10) / (111412.84 * Math.cos(home.lat * Math.PI / 180) - 93.5 * Math.cos(3 * home.lat * Math.PI / 180));

await t.connect();
await sleep(1200);
if (!t.state.simEnabled) t.send('sim.toggleEnable');
if (t.state.sim10x) t.send('sim.toggle10x');   // real machine speed
await sleep(500);
// Every tractor measures position from the same home point (the depot), read from farm.json, so the fleet
// shares one map. A tractor that is not at the farm yet is placed at the depot.
const farmFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'farm.json');
if (fs.existsSync(farmFile)) {
  const { home } = JSON.parse(fs.readFileSync(farmFile, 'utf8'));
  t.setHome(home.lat, home.lon);
  const w = t.world();
  if (!w || Math.hypot(w.e, w.n) > 5000 || process.argv.includes('--depot')) { t.send('sim.stop');
    // Park in this tractor's own bay: 10 m apart along the depot front, so three machines never share a spot.
    t.send(`sim.setCoords|${home.lat},${bayLon(home)}`); await sleep(1200); }
  bayHome = home;
} else t.world();

// Drive towards the commanded target unless a fault says otherwise.
t.pursue(() => (fault === 'ok' && !service && cmd && cmd.type === 'goto' ? cmd : null));
// When the command names a field, open it in AgOpenWeb so its boundary, guidance line and coverage show.
setInterval(() => { if (fault === 'ok' && (cmd?.field || t.held)) t.useField(cmd?.field, cmd?.job); }, 300);

// Configuration is whatever the farmer set up in this tractor's AgOpenWeb: read it, do not redefine it.
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../agopen-multi/data-${agPort}/AgOpenWeb`);
let rig = null, rigAt = 0, activeTool = null;
// Service lock: while a person is fuelling this tractor or changing its implement it must not move.
// Only an explicit "good to go" from the web app releases it.
let service = null;
// The lock is written to disk so a tractor process that restarts mid-service is still locked.
const lockFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', `lock-${id}.json`);
const saveLock = () => { try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); service ? fs.writeFileSync(lockFile, JSON.stringify(service)) : fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ } };
try { service = JSON.parse(fs.readFileSync(lockFile, 'utf8')); console.log(`${id}: still LOCKED for ${service.kind} from before this restart.`); } catch { service = null; }
function readRig() {
  if (Date.now() - rigAt < 10000) return rig;
  rigAt = Date.now();
  const first = (dir) => { try { const f = fs.readdirSync(path.join(dataDir, dir)).filter(n => n.endsWith('.json') && !n.includes('.AutoSteer'))[0]; return f && { name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(dataDir, dir, f), 'utf8')) }; } catch { return null; } };
  const veh = first('Vehicles');
  let tools = [];
  try {
    tools = fs.readdirSync(path.join(dataDir, 'Tools')).filter(n => n.endsWith('.json')).map((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'Tools', f), 'utf8')), profile = f.replace(/\.json$/, '');
      return { profile, kind: kindOf(profile), widthM: d.tool?.width ?? null };
    });
  } catch { /* no tool folder */ }
  if (activeTool === null) { try { activeTool = JSON.parse(fs.readFileSync(path.join(dataDir, 'appsettings.json'), 'utf8')).lastUsedToolProfile || null; } catch { activeTool = null; } }
  const act = tools.find(x => x.profile === activeTool) || tools[0] || null;
  rig = {
    source: dataDir, tools, activeTool: act?.profile ?? null,
    tool: act && { profile: act.profile, widthM: act.widthM },
    vehicle: veh && { profile: veh.name, wheelbaseM: veh.data.vehicle?.wheelbase ?? null, maxSteerDeg: veh.data.vehicle?.maxSteerAngle ?? null },
  };
  return rig;
}

function telemetry() {
  const w = t.world() || { e: 0, n: 0 }, s = t.state;
  return {
    id, seq: ++seq, ts: Date.now(), link: s.connected ? 'ok' : 'agopen-lost',
    lat: t.held ? t.held.lat : s.lat, lon: t.held ? t.held.lon : s.lon, e: +w.e.toFixed(1), n: +w.n.toFixed(1),
    headingDeg: Math.round((s.heading || 0) * 180 / Math.PI), speedKph: +((s.speed || 0) * 3.6 / (s.sim10x ? 10 : 1)).toFixed(1),
    fault: undefined,
    ack: acked, command: cmd ? { type: cmd.type, label: cmd.label, e: cmd.e, n: cmd.n } : null,
    field: s.fieldName, job: s.jobName, areaM2: s.workedAreaSqM, line: s.guidanceActive ? s.lineLabel : null,
    busy: t.held ? 'opening field in AgOpenWeb' : null,
    rig: readRig(), service: service ? { kind: service.kind, tool: service.tool, lockedForS: Math.round((Date.now() - service.since) / 1000) } : null,
    onLine: !!t.onLine, painting: !!s.sectionManual, offLineM: t.xt == null ? null : +t.xt.toFixed(2),
    autosteer: !!s.autoSteer, crossTrackM: s.guidanceActive ? +(s.crossTrackError || 0).toFixed(2) : null,
  };
}

const server = http.createServer((req, res) => {
  // Test hook so a script can inject the same faults you can type into this terminal.
  if (req.method === 'POST' && req.url.startsWith('/fault/')) { setFault(req.url.slice(7), 'test script'); res.writeHead(200); return res.end('ok'); }
  if (fault === 'dead') { req.socket.destroy(); return; }            // a dead machine says nothing
  // Start over: back to the bay, unlocked, no fault, nothing to do.
  if (req.method === 'POST' && req.url === '/home') {
    service = null; saveLock(); fault = 'ok'; cmd = null; t.held = null; t.started = {}; t.paint(false);
    t.send('sim.stop'); t.send('sim.setSteer|0');
    if (bayHome) t.send(`sim.setCoords|${bayHome.lat},${bayLon(bayHome)}`);
    console.log(`\n${id} ── back in its bay for a fresh start ──`);
    res.writeHead(200); return res.end('ok');
  }
  if (req.method === 'POST' && (req.url === '/service' || req.url === '/release')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch { /* empty body is fine */ }
      if (req.url === '/service') {
        service = { kind: b.kind, tool: b.tool || null, since: Date.now() }; saveLock();
        t.send('sim.stop', true);
        console.log(`\n${id} ── LOCKED at depot: ${b.kind === 'swap' ? `implement change to ${b.tool}` : 'refuelling'}. Will not move until "good to go". ──`);
      } else if (service) {
        if (service.tool) {   // the person confirmed the new implement: record it in AgOpenWeb for the farmer
          t.send(`profile.load|${rig?.vehicle?.profile || 'Default'}\t${service.tool}`);
          activeTool = service.tool; rigAt = 0;
        }
        console.log(`\n${id} ── GOOD TO GO received${service.tool ? `; AgOpenWeb tool profile is now ${service.tool}` : ''}. ──`);
        service = null; saveLock();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, locked: !!service }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/telemetry') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(telemetry()));
  }
  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { cmd = JSON.parse(body); acked = cmd.n_seq ?? acked + 1; lastCmdAt = Date.now(); } catch { res.writeHead(400); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ack: acked }));               // a stuck machine still says "GO received"
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, () => console.log(`${id}: AgOpenWeb :${agPort} → telemetry and commands on :${port}. Type dead / stuck / ok.`));

function setFault(f, why = 'operator') {
  if (!['ok', 'dead', 'stuck'].includes(f) || f === fault) return;
  fault = f;
  console.log(`\n${id} ── FAULT ${f.toUpperCase()} (${why}) ──`);
}
readline.createInterface({ input: process.stdin }).on('line', (l) => setFault(l.trim().toLowerCase()));
if (chaos > 0) {
  const roll = () => setTimeout(() => {
    if (fault === 'ok') setFault(Math.random() < 0.5 ? 'dead' : 'stuck', 'random');
    roll();
  }, chaos * 1000 * (0.5 + Math.random()));
  roll();
}

setInterval(() => {
  const m = telemetry();
  const what = service ? `LOCKED: ${service.kind === 'swap' ? 'implement change' : 'refuelling'}, waiting for good to go` : fault === 'dead' ? 'NOT RESPONDING' : fault === 'stuck' ? `GO ack'd, wheels stopped` :
    cmd?.type === 'goto' ? `→ ${cmd.label || 'target'}${m.onLine ? `  [on line, off by ${m.offLineM} m${m.painting ? ', implement on' : ''}]` : ''}` : 'holding';
  console.log(`${id} ${new Date().toTimeString().slice(0, 8)}  ${m.lat?.toFixed(6)}, ${m.lon?.toFixed(6)}  e ${String(m.e).padStart(7)} n ${String(m.n).padStart(7)}  ` +
    `${String(m.speedKph).padStart(5)} km/h  hdg ${String(m.headingDeg).padStart(4)}°  ${what}`);
}, 1000);

process.on('SIGINT', () => { t.send('sim.stop'); t.close(); process.exit(0); });
