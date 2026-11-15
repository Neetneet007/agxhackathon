// Weather for the Weather Manager: readings, forecast and official alerts, one snapshot per plan minute.
//
// Built-in scripted days (WEATHER_DAY), all simulated and labelled so:
//   calm      the spray-window day: inversion at dawn, a clear window, wind rising after 13:00
//   monsoon   flash flood watch, a thunderstorm with lightning, a flash flood warning with the creek
//             over its banks, then the water going down and the days after
//   hurricane watch, warning, storm conditions and the all-clear, compressed into under an hour
// WEATHER_SCRIPT=<file.json>: [{ "at": "HH:MM" | minute, ...reading fields, "alerts": [], "forecast": {} }],
//   each entry holds from its time until the next (tests and rehearsals).
// WEATHER_SOURCE=nws: National Weather Service forecast + alerts for the depot (internet; off by default).
//
// A snapshot: { reading: { t2C, t10C, wind2Mph, wind10Mph, gustMph, sustainedMph, lightningMi,
//   visibilityMi, heatIndexF, creekGaugeM, soilMoisturePct, aqiPm25, source }, forecast: { rainWithinHours },
//   alerts: ["Flash Flood Warning", ...] }
import fs from 'node:fs';
import { clockToMinute } from '../runtime/runner.js';

const round = n => (n == null ? n : Math.round(n * 100) / 100);

const CALM_CURVE = [
  [0, 7.0, 9.5, 1.5, 2.5], [45, 9.0, 11.0, 3.6, 5.0], [150, 14.0, 14.6, 4.5, 6.0], [180, 15.5, 15.0, 5.0, 6.5],
  [390, 22.0, 20.5, 6.5, 8.5], [450, 24.0, 22.5, 9.0, 11.5], [510, 25.0, 23.5, 12.0, 15.0], [720, 23.0, 21.5, 13.0, 16.0],
];

export function calm(minute) {
  const m = Math.max(0, Math.min(minute, CALM_CURVE[CALM_CURVE.length - 1][0]));
  let i = 0;
  while (i < CALM_CURVE.length - 2 && CALM_CURVE[i + 1][0] <= m) i++;
  const [a, b] = [CALM_CURVE[i], CALM_CURVE[i + 1]];
  const k = (m - a[0]) / (b[0] - a[0]);
  const lerp = j => round(a[j] + (b[j] - a[j]) * k);
  const wind10Mph = lerp(4);
  return {
    reading: { t2C: lerp(1), t10C: lerp(2), wind2Mph: lerp(3), wind10Mph, gustMph: round(wind10Mph * 1.3), sustainedMph: wind10Mph, source: 'simulated' },
    forecast: { rainWithinHours: null }, alerts: [],
  };
}

const CLEAR = { t2C: 27, t10C: 26.2, wind2Mph: 5, wind10Mph: 6.5, gustMph: 9, sustainedMph: 6.5 };

export const DAYS = {
  monsoon: [
    { at: 0, ...CLEAR, forecast: { rainWithinHours: 30 } },
    { at: 20, ...CLEAR, alerts: ['Flash Flood Watch'], forecast: { rainWithinHours: 30 } },
    { at: 40, t2C: 24, t10C: 23.4, wind2Mph: 14, wind10Mph: 18, gustMph: 40, sustainedMph: 18, lightningMi: 8, alerts: ['Flash Flood Watch', 'Severe Thunderstorm Warning'], forecast: { rainWithinHours: 30 } },
    { at: 55, t2C: 23, t10C: 22.4, wind2Mph: 12, wind10Mph: 16, gustMph: 35, sustainedMph: 16, lightningMi: 4, alerts: ['Flash Flood Watch', 'Severe Thunderstorm Warning'], forecast: { rainWithinHours: 30 } },
    { at: 66, t2C: 23, t10C: 22.4, wind2Mph: 6, wind10Mph: 8, gustMph: 12, sustainedMph: 8, alerts: ['Flash Flood Watch'], forecast: { rainWithinHours: 30 } },
    { at: 70, t2C: 23, t10C: 22.4, wind2Mph: 6, wind10Mph: 8, gustMph: 12, sustainedMph: 8, creekGaugeM: 2.1, alerts: ['Flash Flood Warning'], forecast: { rainWithinHours: 30 } },
    { at: 120, t2C: 25, t10C: 24.4, wind2Mph: 5, wind10Mph: 6.5, gustMph: 9, sustainedMph: 6.5, creekGaugeM: 1.2, alerts: [], forecast: { rainWithinHours: 48 } },
    { at: 150, ...CLEAR, creekGaugeM: 0.8, forecast: { rainWithinHours: 48 } },
  ],
  hurricane: [
    { at: 0, ...CLEAR, forecast: { rainWithinHours: 30 } },
    { at: 5, ...CLEAR, alerts: ['Hurricane Watch'], forecast: { rainWithinHours: 30 } },
    { at: 15, t2C: 26, t10C: 25.4, wind2Mph: 18, wind10Mph: 25, gustMph: 35, sustainedMph: 25, alerts: ['Hurricane Warning'], forecast: { rainWithinHours: 30 } },
    { at: 25, t2C: 24, t10C: 23.4, wind2Mph: 45, wind10Mph: 60, gustMph: 80, sustainedMph: 55, alerts: ['Hurricane Warning'], forecast: { rainWithinHours: 30 } },
    { at: 45, t2C: 25, t10C: 24.4, wind2Mph: 8, wind10Mph: 11, gustMph: 15, sustainedMph: 11, alerts: ['All Clear'], forecast: { rainWithinHours: 48 } },
  ],
};

export function scripted(rows0, source = 'simulated') {
  const rows = rows0.map(r => ({ ...r, at: typeof r.at === 'number' ? r.at : clockToMinute(r.at) })).sort((x, y) => x.at - y.at);
  return minute => {
    let cur = rows[0];
    for (const r of rows) if (r.at <= minute) cur = r;
    const { at, alerts = [], forecast = { rainWithinHours: null }, ...reading } = cur;
    return { reading: { ...reading, source }, forecast, alerts };
  };
}

// NWS: hourly forecast + active alerts for the depot, refreshed every 15 real minutes.
function nwsFeed() {
  let cache = null, fetchedAt = 0, pending = null;
  const UA = { 'User-Agent': 'fleet-weather-agent (hackathon demo)', Accept: 'application/geo+json' };
  async function refresh(home) {
    const sig = { headers: UA, signal: AbortSignal.timeout(8000) };
    const pt = await (await fetch(`https://api.weather.gov/points/${home.lat.toFixed(4)},${home.lon.toFixed(4)}`, sig)).json();
    const fc = await (await fetch(pt.properties.forecastHourly, sig)).json();
    const al = await (await fetch(`https://api.weather.gov/alerts/active?point=${home.lat.toFixed(4)},${home.lon.toFixed(4)}`, sig)).json();
    cache = { periods: fc.properties.periods, alerts: (al.features || []).map(f => f.properties.event) };
    fetchedAt = Date.now();
  }
  return async (minute, ctx) => {
    const home = ctx.farm?.home;
    if (!home) return null;
    if (!cache || Date.now() - fetchedAt > 15 * 60_000) { pending ??= refresh(home).finally(() => { pending = null; }); await pending; }
    const p = cache.periods[0];
    const t2C = p.temperatureUnit === 'F' ? (p.temperature - 32) * 5 / 9 : p.temperature;
    const wind10Mph = Number(String(p.windSpeed).match(/\d+/)?.[0] ?? 0);
    const wind2Mph = wind10Mph * Math.log(2 / 0.1) / Math.log(10 / 0.1); // log wind profile, 0.1 m roughness
    const calmNight = !p.isDaytime && wind10Mph < 6;
    const rainIn = cache.periods.findIndex(q => (q.probabilityOfPrecipitation?.value ?? 0) >= 50);
    return {
      reading: { t2C: round(t2C), t10C: round(calmNight ? t2C + 1.5 : t2C - 0.08), wind2Mph: round(wind2Mph), wind10Mph: round(wind10Mph), source: 'nws', estimated: ['t10C', 'wind2Mph'] },
      forecast: { rainWithinHours: rainIn < 0 ? null : rainIn },
      alerts: cache.alerts,
    };
  };
}

export function makeFeed(config = {}) {
  if (Array.isArray(config.weatherScript)) return scripted(config.weatherScript, 'script');
  if (typeof config.weatherScript === 'string') return scripted(JSON.parse(fs.readFileSync(config.weatherScript, 'utf8')), 'script');
  if (config.weatherSource === 'nws') return nwsFeed();
  if (DAYS[config.weatherDay]) return scripted(DAYS[config.weatherDay]);
  return calm;
}
