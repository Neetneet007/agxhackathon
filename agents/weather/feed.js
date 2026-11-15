// Weather readings at 2 m and 10 m, one per plan minute.
//
// Default: a built-in simulated day driven by the live runner's plan clock (minute 0 = 06:00):
//   06:00  calm and a strong inversion          → Stop (inversion + wind below 3 mph)
//   06:32  wind at 2 m reaches 3 mph, inversion → Stop, although the 2 m reading alone looks fine
//   08:46  the inversion breaks                  → Go (the clear spraying window)
//   13:06  wind at 2 m passes 8 mph              → Caution
//   13:50  wind at 2 m passes 10 mph             → Stop for the rest of the day
//
// WEATHER_SCRIPT=<file.json>: an array of { "at": "HH:MM" | minute, "t2C", "t10C", "wind2Mph", "wind10Mph" };
//   each entry holds from its time until the next one (used by tests and for rehearsals).
// WEATHER_SOURCE=nws: the National Weather Service hourly forecast for the depot (from GET /farm).
//   NWS gives one height only (air temperature at 2 m, wind at 10 m); the other two values are
//   estimated and the reading says so in `estimated`. Off by default; needs the internet.
import fs from 'node:fs';
import { clockToMinute } from '../runtime/runner.js';

const SIM_DAY = [
  [0, 7.0, 9.5, 1.5, 2.5],
  [45, 9.0, 11.0, 3.6, 5.0],
  [150, 14.0, 14.6, 4.5, 6.0],
  [180, 15.5, 15.0, 5.0, 6.5],
  [390, 22.0, 20.5, 6.5, 8.5],
  [450, 24.0, 22.5, 9.0, 11.5],
  [510, 25.0, 23.5, 12.0, 15.0],
  [720, 23.0, 21.5, 13.0, 16.0],
];

const round = n => Math.round(n * 100) / 100;

export function simulated(minute) {
  const m = Math.max(0, Math.min(minute, SIM_DAY[SIM_DAY.length - 1][0]));
  let i = 0;
  while (i < SIM_DAY.length - 2 && SIM_DAY[i + 1][0] <= m) i++;
  const [a, b] = [SIM_DAY[i], SIM_DAY[i + 1]];
  const k = (m - a[0]) / (b[0] - a[0]);
  const lerp = j => round(a[j] + (b[j] - a[j]) * k);
  return { t2C: lerp(1), t10C: lerp(2), wind2Mph: lerp(3), wind10Mph: lerp(4), source: 'simulated' };
}

export function scripted(script) {
  const rows = script.map(r => ({ ...r, at: typeof r.at === 'number' ? r.at : clockToMinute(r.at) })).sort((x, y) => x.at - y.at);
  return minute => {
    let cur = rows[0];
    for (const r of rows) if (r.at <= minute) cur = r;
    return { t2C: cur.t2C, t10C: cur.t10C, wind2Mph: cur.wind2Mph, wind10Mph: cur.wind10Mph, source: 'script' };
  };
}

// NWS: hourly forecast, refreshed every 15 real minutes, cached between calls.
function nwsFeed() {
  let cache = null, fetchedAt = 0, pending = null;
  const UA = { 'User-Agent': 'fleet-weather-agent (hackathon demo)', Accept: 'application/geo+json' };
  async function refresh(home) {
    const pt = await (await fetch(`https://api.weather.gov/points/${home.lat.toFixed(4)},${home.lon.toFixed(4)}`, { headers: UA, signal: AbortSignal.timeout(8000) })).json();
    const fc = await (await fetch(pt.properties.forecastHourly, { headers: UA, signal: AbortSignal.timeout(8000) })).json();
    cache = fc.properties.periods; fetchedAt = Date.now();
  }
  return async (minute, ctx) => {
    const home = ctx.farm?.home;
    if (!home) return null;
    if (!cache || Date.now() - fetchedAt > 15 * 60_000) { pending ??= refresh(home).finally(() => { pending = null; }); await pending; }
    const p = cache[0];
    const t2C = p.temperatureUnit === 'F' ? (p.temperature - 32) * 5 / 9 : p.temperature;
    const wind10Mph = Number(String(p.windSpeed).match(/\d+/)?.[0] ?? 0);
    const wind2Mph = wind10Mph * Math.log(2 / 0.1) / Math.log(10 / 0.1); // log wind profile, 0.1 m roughness
    const calmNight = !p.isDaytime && wind10Mph < 6;
    const t10C = calmNight ? t2C + 1.5 : t2C - 0.08; // night-time calm → assume an inversion; otherwise a normal lapse
    return { t2C: round(t2C), t10C: round(t10C), wind2Mph: round(wind2Mph), wind10Mph: round(wind10Mph), source: 'nws', estimated: ['t10C', 'wind2Mph'], forecastFor: p.startTime };
  };
}

export function makeFeed(config = {}) {
  if (Array.isArray(config.weatherScript)) return scripted(config.weatherScript);
  if (typeof config.weatherScript === 'string') return scripted(JSON.parse(fs.readFileSync(config.weatherScript, 'utf8')));
  if (config.weatherSource === 'nws') return nwsFeed();
  return simulated;
}
