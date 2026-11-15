#!/usr/bin/env node
// Preflight: is everything the live demo needs actually up and in a clean state?  node agopen/preflight.js
// Prints one line per check and exits 1 if any fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.live.json'), 'utf8'));
const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; };
const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok, detail });

check('Node 18 or later', Number(process.versions.node.split('.')[0]) >= 18, `found ${process.versions.node}`);
check('Dependency installed (ws)', fs.existsSync(path.join(here, '..', 'node_modules', 'ws')), 'run: npm install');
check('Patched AgOpenWeb build present', fs.existsSync(path.resolve(here, '../../agopen-multi/bin/AgOpenWeb.Desktop')), 'see agopen/README.md, Set up once');

for (let i = 0; i < scenario.tractors.length; i++) {
  const id = scenario.tractors[i].id, ag = 5175 + i, node = 6175 + i;
  try { await get(`http://127.0.0.1:${ag}/`); check(`${id}: AgOpenWeb answering on :${ag}`, true); }
  catch (e) { check(`${id}: AgOpenWeb answering on :${ag}`, false, e.message); }
  let m = null;
  try { m = await (await get(`http://127.0.0.1:${node}/telemetry`)).json(); check(`${id}: tractor process reporting on :${node}`, true); }
  catch (e) { check(`${id}: tractor process reporting on :${node}`, false, e.message); }
  if (!m) continue;
  check(`${id}: linked to its AgOpenWeb`, m.link === 'ok', m.link);
  check(`${id}: GPS at the farm`, m.lat != null && Math.hypot(m.e, m.n) < 6000, `${m.lat}, ${m.lon}`);
  const tools = (m.rig?.tools || []).filter(t => t.kind);
  check(`${id}: implement profiles in AgOpenWeb`, tools.length > 0, tools.map(t => t.profile).join(', ') || 'none found: run node agopen/build-farm.js');
  check(`${id}: not locked or faulted from an earlier run`, !m.service, m.service ? `locked for ${m.service.kind}` : '');
}
let state = null;
try { state = await (await get('http://127.0.0.1:5190/state')).json(); check('Coordinator and status page on :5190', true, `plan clock ${state.clock}`); }
catch (e) { check('Coordinator and status page on :5190', false, e.message); }
try { const farm = await (await get('http://127.0.0.1:5190/farm')).json(); check('Fields read from AgOpenWeb', farm.fields.length > 0, `${farm.fields.length} fields`); }
catch (e) { check('Fields read from AgOpenWeb', false, e.message); }
if (state) {
  const bad = state.tractors.filter(t => ['NO_RESPONSE', 'GO_NOT_MOVING', 'DOWN'].includes(t.state.code));
  check('No tractor in a fault state', bad.length === 0, bad.map(t => `${t.id} ${t.state.code}`).join(', '));
}
const w = Math.max(...rows.map(r => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = rows.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed. Ready to demo.');
process.exit(failed ? 1 : 0);
