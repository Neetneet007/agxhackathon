#!/usr/bin/env node
// Write the scenario's fields into AgOpenWeb's own field format, so every tractor's AgOpenWeb has the
// farm: one folder per field with its boundary and a guidance line. A farmer would normally create
// these in AgOpenGPS; this script stands in for that step.
//
//   node agopen/build-farm.js [scenario.json] [--home 32.7200,-114.6741] [--cell 100] [--dirs dirA,dirB,...]
//
// --home is where the depot sits. The default is a real block of farmland in the Yuma Valley, Arizona;
// the field shapes themselves come from the scenario, not from a survey.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS as TOOL, kindOf } from './rig.js';
import { fieldTruth } from './drone.js';

// Days from planting to harvest, by crop (typical figures; hay and alfalfa are days to the next cut).
const SEASON_DAYS = { corn: 120, soybeans: 110, wheat: 110, hay: 60, alfalfa: 45, orchard: 200 };
// A planting date for the field's record. It is set so the calendar roughly agrees with the crop the drone
// will find there, give or take a week or so: a record a farmer kept, not a measurement.
function plantedOn(name, crop) {
  const season = SEASON_DAYS[crop] || 100;
  const truth = fieldTruth(name, 'not plowed', 1, crop);
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  const days = Math.max(5, Math.round(truth.maturityPct / 100 * season) + (h % 15) - 7);
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const scenario = JSON.parse(fs.readFileSync(args.find(a => a.endsWith('.json')) || path.join(here, 'scenario.live.json'), 'utf8'));
const [homeLat, homeLon] = opt('home', '32.7200,-114.6741').split(',').map(Number);
const CELL = Number(opt('cell', 20));   // metres per plan grid cell; 20 gives fields of about 1.5 acres, small enough to finish in minutes at real speed
const multi = path.resolve(here, '../../agopen-multi');
const dirs = opt('dirs', [5175, 5176, 5177].map(p => path.join(multi, `data-${p}`, 'AgOpenWeb', 'Fields')).join(',')).split(',');

// Same flat-plane projection AgOpenWeb documents in Docs/FIELD_FILE_FORMATS.md.
const rad = Math.PI / 180;
const mLat = (lat0) => 111132.92 - 559.82 * Math.cos(2 * lat0 * rad) + 1.175 * Math.cos(4 * lat0 * rad) - 0.0023 * Math.cos(6 * lat0 * rad);
const mLon = (lat) => 111412.84 * Math.cos(lat * rad) - 93.5 * Math.cos(3 * lat * rad) + 0.118 * Math.cos(5 * lat * rad);
export function toLatLon(e, n, lat0 = homeLat, lon0 = homeLon) {
  const lat = lat0 + n / mLat(lat0);
  return { lat, lon: lon0 + e / mLon(lat) };
}
const dep = scenario.depot;
const cellToWorld = (x, y) => ({ e: (x - dep.x) * CELL, n: -(y - dep.y) * CELL });

const now = new Date().toISOString();
const farm = { home: { lat: homeLat, lon: homeLon }, cell: CELL, fields: [] };

for (const f of scenario.fields) {
  const a = cellToWorld(f.x, f.y), b = cellToWorld(f.x + f.w, f.y + f.h);
  // 3 m in from the grid lines on every side: the gap between neighbouring fields is the farm lane.
  const e0 = Math.min(a.e, b.e) + 3, e1 = Math.max(a.e, b.e) - 3, n0 = Math.min(a.n, b.n) + 3, n1 = Math.max(a.n, b.n) - 3;
  const centre = toLatLon((e0 + e1) / 2, (n0 + n1) / 2);
  const ringM = [[e0, n0], [e0, n1], [e1, n1], [e1, n0], [e0, n0]];
  const ring = ringM.map(([e, n], i) => {
    const [e2, n2] = ringM[(i + 1) % (ringM.length - 1)];
    const p = toLatLon(e, n);
    return [p.lon, p.lat, (Math.atan2(e2 - e, n2 - n) + 2 * Math.PI) % (2 * Math.PI)];
  });
  ring[ring.length - 1] = [...ring[0]];
  // One guidance line along the long side, one half-pass in from the edge.
  const alongE = (e1 - e0) >= (n1 - n0);
  const A = alongE ? toLatLon(e0, n1 - 6) : toLatLon(e0 + 6, n0);
  const B = alongE ? toLatLon(e1, n1 - 6) : toLatLon(e0 + 6, n1);
  const heading = alongE ? Math.PI / 2 : 0;
  const hectares = (e1 - e0) * (n1 - n0) / 10000;
  const geo = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [centre.lon, centre.lat] },
        properties: { role: 'metadata', formatVersion: 1, name: f.name, crop: f.crop || null, plantedOn: f.crop ? plantedOn(f.name, f.crop) : null, originLatitude: centre.lat, originLongitude: centre.lon, convergence: 0, areaHectares: hectares, createdDate: now, lastModifiedDate: now } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { role: 'outer-boundary', isDriveThrough: false, isHard: false, areaHectares: hectares } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[A.lon, A.lat, heading], [B.lon, B.lat, heading]] },
        properties: { role: 'track', name: `AB ${f.name}`, trackType: 2, isClosed: false, noPassOffset: false, nudgeDistance: 0, isVisible: true } },
    ],
  };
  for (const dir of dirs) {
    const folder = path.join(dir, f.name);
    fs.rmSync(folder, { recursive: true, force: true });   // a fresh field: no work sessions or coverage from earlier runs
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'field.geojson'), JSON.stringify(geo, null, 2));
    fs.writeFileSync(path.join(folder, 'field.origin'), `${centre.lat.toFixed(8)},${centre.lon.toFixed(8)}`);
  }
  farm.fields.push({ id: f.id, name: f.name, crop: f.crop, acres: f.acres, centre, drawnHectares: +hectares.toFixed(1) });
}
// Each tractor's implements become tool profiles in that tractor's own AgOpenWeb, as a farmer would set
// them up there. The coordinator later reads them back; it never keeps its own list.
scenario.tractors.forEach((t, i) => {
  const root = path.join(multi, `data-${5175 + i}`, 'AgOpenWeb');
  const base = path.join(root, 'Tools', 'Default.json');
  if (!fs.existsSync(base)) return;
  // Remove implement profiles from an earlier build so the tractor has exactly the ones listed.
  for (const f of fs.readdirSync(path.join(root, 'Tools'))) if (f !== 'Default.json' && kindOf(f)) fs.rmSync(path.join(root, 'Tools', f));
  for (const impl of t.implements) {
    const [name, w] = TOOL[impl];
    const d = JSON.parse(fs.readFileSync(base, 'utf8'));
    d.tool.width = w; d.tool.defaultSectionWidth = w * 100;
    d.sections.count = 1; d.sections.positions = [-w / 2, w / 2]; d.sections.widths = [w * 100];
    fs.writeFileSync(path.join(root, 'Tools', `${name}.json`), JSON.stringify(d, null, 2));
  }
  const settings = path.join(root, 'appsettings.json');
  if (fs.existsSync(settings)) {
    const a = JSON.parse(fs.readFileSync(settings, 'utf8'));
    a.lastUsedToolProfile = TOOL[t.mounted || t.implements[0]][0];
    fs.writeFileSync(settings, JSON.stringify(a, null, 2));
  }
  console.log(`${t.id}: tool profiles ${t.implements.map(k => TOOL[k][0]).join(', ')}; mounted ${TOOL[t.mounted || t.implements[0]][0]}`);
});
fs.writeFileSync(path.join(here, 'farm.json'), JSON.stringify(farm, null, 1));
console.log(`Wrote ${scenario.fields.length} fields into ${dirs.length} AgOpenWeb field folders. Depot at ${homeLat}, ${homeLon}.`);
