#!/usr/bin/env node
// Pulls real GIS for the farm's real-world location and writes it to dashboard/gis/.
//   node gis/fetch.js [--home 32.6600,-114.7400] [--cell 100] [--margin 5]
//
// The depot sits at --home, 100 m per grid cell (the projection agopen/build-farm.js uses). The default is
// open farmland in the Yuma Valley, Arizona. It is 6 km south-west of build-farm.js's default home, whose
// 3 km x 2 km footprint runs into Yuma's city streets; pass the same --home to both to line them up.
// What is real: the aerial photo, canals/drains/roads, ground elevation and soil survey.
// What is not: the field rectangles, Mill Creek and its bridges come from scenario.json.
//
// Sources (all public, no key):
//   imagery    USDA NAIP aerial photography, served by USGS The National Map (public domain);
//              if that server is down, Esri World Imagery (credit: Esri, Maxar, Earthstar Geographics)
//   vectors    OpenStreetMap via the Overpass API (ODbL, (c) OpenStreetMap contributors)
//   elevation  USGS 3DEP Elevation Point Query Service (public domain)
//   soil       USDA NRCS Soil Data Access, SSURGO (public domain)
// Every source is optional: a failed one is recorded in gis.json under "failed" and the rest still write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dashboard', 'gis');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const [lat0, lon0] = arg('home', '32.6600,-114.7400').split(',').map(Number);
const CELL = Number(arg('cell', 100));
const MARGIN = Number(arg('margin', 5));           // grid cells of imagery around the farm
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
const { width: W, height: H } = scenario.map, dep = scenario.depot;

// Same flat-plane projection as agopen/build-farm.js.
const rad = Math.PI / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * rad) + 1.175 * Math.cos(4 * lat0 * rad) - 0.0023 * Math.cos(6 * lat0 * rad);
const mLon = 111412.84 * Math.cos(lat0 * rad) - 93.5 * Math.cos(3 * lat0 * rad) + 0.118 * Math.cos(5 * lat0 * rad);
const cellToLatLon = (x, y) => ({ lat: lat0 - (y - dep.y) * CELL / mLat, lon: lon0 + (x - dep.x) * CELL / mLon });
const latLonToCell = (lat, lon) => [+(dep.x + (lon - lon0) * mLon / CELL).toFixed(3), +(dep.y - (lat - lat0) * mLat / CELL).toFixed(3)];

const nw = cellToLatLon(-MARGIN, -MARGIN), se = cellToLatLon(W + MARGIN, H + MARGIN);
const bbox = { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
const get = async (url, opts = {}, ms = 45000) => {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'farm-gis-fetch/1.0', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r;
};

fs.mkdirSync(out, { recursive: true });
const gis = {
  fetchedAt: new Date().toISOString(), home: { lat: lat0, lon: lon0 }, cellMetres: CELL, bbox,
  extentCells: { x0: -MARGIN, y0: -MARGIN, x1: W + MARGIN, y1: H + MARGIN },
  note: 'Aerial photo, canals, roads, elevation and soil are real. Field rectangles, Mill Creek and its bridges are the scenario\'s.',
  sources: {}, failed: {},
};
let prev = null;
try { prev = JSON.parse(fs.readFileSync(path.join(out, 'gis.json'), 'utf8')); } catch { /* first run */ }
if (prev && (prev.home?.lat !== lat0 || prev.home?.lon !== lon0 || prev.cellMetres !== CELL || prev.extentCells?.x0 !== -MARGIN)) prev = null;
const step = async (name, fn) => {
  try { gis.sources[name] = { ...(await fn()), fetchedAt: gis.fetchedAt }; console.log(`ok    ${name}`); }
  catch (e) {
    gis.failed[name] = String(e.message || e);
    const kept = prev?.sources?.[name];                      // same site, fetched earlier: keep it, dated
    if (kept) gis.sources[name] = { ...kept, fetchedAt: kept.fetchedAt || prev.fetchedAt };
    console.log(`FAIL  ${name}: ${e.message}${kept ? ' (kept the earlier copy)' : ''}`);
  }
};

await step('imagery', async () => {
  const wPx = 2048, hPx = Math.round(wPx * (H + 2 * MARGIN) / (W + 2 * MARGIN));
  const q = new URLSearchParams({ bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`, bboxSR: '4326', imageSR: '4326', size: `${wPx},${hPx}`, format: 'jpg', f: 'image' });
  const servers = [
    { url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage', provider: 'USDA NAIP via USGS The National Map', licence: 'public domain', credit: 'USDA NAIP / USGS' },
    { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export', provider: 'Esri World Imagery', licence: 'Esri terms of use; attribution required', credit: 'Esri, Maxar, Earthstar Geographics' },
  ];
  for (const s of servers) {
    try {
      const buf = Buffer.from(await (await get(`${s.url}?${q}`, {}, 60000)).arrayBuffer());
      if (buf.length < 20000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a usable JPEG (${buf.length} bytes)`);
      fs.writeFileSync(path.join(out, 'imagery.jpg'), buf);
      return { file: 'imagery.jpg', bytes: buf.length, size: [wPx, hPx], provider: s.provider, licence: s.licence, credit: s.credit };
    } catch (e) { gis.failed[`imagery@${new URL(s.url).host}`] = e.message; }
  }
  throw new Error('no imagery server answered');
});

await step('osm', async () => {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const ql = `[out:json][timeout:40];(way["waterway"](${b});way["highway"](${b}););out geom tags;`;
  let data;
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { data = await (await get(host, { method: 'POST', body: `data=${encodeURIComponent(ql)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).json(); break; } catch (e) { data = null; gis.failed[`osm@${new URL(host).host}`] = e.message; }
  }
  if (!data) throw new Error('no Overpass server answered');
  const ways = data.elements.filter(e => e.type === 'way' && e.geometry?.length > 1).map(e => ({
    id: e.id, kind: e.tags.waterway ? 'water' : 'road', type: e.tags.waterway || e.tags.highway, name: e.tags.name || null,
    cells: e.geometry.map(p => latLonToCell(p.lat, p.lon)),
  }));
  fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ ways }));
  const count = k => ways.filter(w => w.kind === k).length;
  return { file: 'features.json', waterways: count('water'), roads: count('road'), named: [...new Set(ways.map(w => w.name).filter(Boolean))].slice(0, 40), provider: 'OpenStreetMap via Overpass API', licence: 'ODbL', credit: '© OpenStreetMap contributors' };
});

const points = [{ id: 'depot', name: scenario.depot.name, ...cellToLatLon(dep.x + 0.5, dep.y + 0.5) },
  ...scenario.fields.map(f => ({ id: f.id, name: f.name, ...cellToLatLon(f.x + f.w / 2, f.y + f.h / 2) }))];

await step('elevation', async () => {
  try {
    const res = [];
    for (const p of points) {
      const v = Number((await (await get(`https://epqs.nationalmap.gov/v1/json?x=${p.lon}&y=${p.lat}&units=Meters&wkid=4326&includeDate=false`, {}, 12000)).json()).value);
      if (!Number.isFinite(v)) throw new Error(`no elevation at ${p.id}`);
      res.push({ id: p.id, metres: +v.toFixed(2) });
    }
    return { points: res, provider: 'USGS 3DEP Elevation Point Query Service', licence: 'public domain', credit: 'USGS 3DEP' };
  } catch (e) {
    gis.failed['elevation@epqs.nationalmap.gov'] = e.message;
    const q = `latitude=${points.map(p => p.lat.toFixed(6)).join(',')}&longitude=${points.map(p => p.lon.toFixed(6)).join(',')}`;
    const j = await (await get(`https://api.open-meteo.com/v1/elevation?${q}`, {}, 20000)).json();
    if (j.elevation?.length !== points.length) throw new Error('no elevation from either service');
    return { points: points.map((p, i) => ({ id: p.id, metres: j.elevation[i] })), provider: 'Open-Meteo Elevation API (Copernicus DEM GLO-90)', licence: 'CC BY 4.0', credit: 'Open-Meteo, Copernicus DEM' };
  }
});

await step('soil', async () => {
  const res = [];
  for (const p of points) {
    const query = `SELECT mu.musym, mu.muname, c.compname, c.comppct_r, c.drainagecl, c.hydgrp, c.slope_r, c.taxorder
      FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${p.lon} ${p.lat})') k
      JOIN mapunit mu ON mu.mukey = k.mukey JOIN component c ON c.mukey = mu.mukey
      WHERE c.majcompflag = 'Yes' ORDER BY c.comppct_r DESC`;
    const j = await (await get('https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, format: 'JSON+COLUMNNAME' }) }, 30000)).json();
    const [cols, ...rows] = j.Table || [];
    if (!rows.length) { res.push({ id: p.id, mapUnit: null }); continue; }
    const r = Object.fromEntries(cols.map((c, i) => [c, rows[0][i]]));
    res.push({ id: p.id, mapUnit: r.muname, symbol: r.musym, component: r.compname, componentPct: Number(r.comppct_r), drainage: r.drainagecl, hydrologicGroup: r.hydgrp, slopePct: r.slope_r == null ? null : Number(r.slope_r), order: r.taxorder });
  }
  if (!res.some(r => r.mapUnit)) throw new Error('no soil map unit at any point');
  return { points: res, provider: 'USDA NRCS Soil Data Access (SSURGO)', licence: 'public domain', credit: 'USDA NRCS SSURGO' };
});

gis.points = points.map(p => ({ id: p.id, name: p.name, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
fs.writeFileSync(path.join(out, 'gis.json'), JSON.stringify(gis, null, 1));
console.log(`Wrote ${path.relative(root, out)}/gis.json  (${Object.keys(gis.sources).length} sources, ${Object.keys(gis.failed).length} failures)`);
