// weather.js - "Spray or Wait?" deterministic core.
// Reads temperature and wind at two heights, detects inversions, flags wind and
// shear problems, gives GO / CAUTION / STOP with a plain-language reason, and
// keeps a time-stamped log. No dependencies, no randomness.

export const LIMITS = { windLowMph: 3, windHighMph: 10, shearMph: 5, inversionC: 0.0, cautionBandMph: 1 };

// ---------- helpers ----------
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const num = (x) => String(Number(Number(x).toFixed(1)));
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export function clockOf(t) {
  const m = ((Math.floor(t) + 360) % 1440 + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ---------- assessment ----------
function groundOnly(reading, limits) {
  const w = reading.low.windMph;
  const h = reading.low.heightM;
  if (w < limits.windLowMph) {
    return { status: 'STOP', reason: `Stop: wind at ${h} m is only ${num(w)} mph, below the ${limits.windLowMph} mph minimum.` };
  }
  if (w > limits.windHighMph) {
    return { status: 'STOP', reason: `Stop: wind at ${h} m is ${num(w)} mph, above the ${limits.windHighMph} mph maximum.` };
  }
  return { status: 'GO', reason: `Go: wind at ${h} m is ${num(w)} mph, inside the ${limits.windLowMph} to ${limits.windHighMph} mph range.` };
}

export function assess(reading, limits = LIMITS) {
  const { low, high } = reading;
  const triggers = [];
  const diffT = round2(high.tempC - low.tempC);
  const shear = round2(Math.abs(high.windMph - low.windMph));
  const lw = low.windMph;

  if (diffT > limits.inversionC) {
    triggers.push({
      code: 'INVERSION', severity: 'stop',
      text: `The air at ${high.heightM} m is ${num(diffT)} °C warmer than at ${low.heightM} m, which is a temperature inversion.`,
    });
  }
  if (lw < limits.windLowMph) {
    triggers.push({
      code: 'WIND_LOW', severity: 'stop',
      text: `Wind at ${low.heightM} m is only ${num(lw)} mph, below the ${limits.windLowMph} mph minimum; very light air often means an inversion, so spray can hang and drift.`,
    });
  } else if (lw > limits.windHighMph) {
    triggers.push({
      code: 'WIND_HIGH', severity: 'stop',
      text: `Wind at ${low.heightM} m is ${num(lw)} mph, above the ${limits.windHighMph} mph maximum, so spray would blow off target.`,
    });
  }
  if (shear > limits.shearMph) {
    triggers.push({
      code: 'SHEAR', severity: 'stop',
      text: `Wind differs by ${num(shear)} mph between ${low.heightM} m (${num(lw)} mph) and ${high.heightM} m (${num(high.windMph)} mph), more than the ${limits.shearMph} mph allowed, so spray would be carried unpredictably.`,
    });
  }

  const hasStop = triggers.length > 0;
  if (!hasStop) {
    if (lw >= limits.windLowMph && lw < limits.windLowMph + limits.cautionBandMph) {
      triggers.push({
        code: 'NEAR_LIMIT', severity: 'caution',
        text: `Wind at ${low.heightM} m is ${num(lw)} mph, close to the ${limits.windLowMph} mph minimum.`,
      });
    } else if (lw <= limits.windHighMph && lw > limits.windHighMph - limits.cautionBandMph) {
      triggers.push({
        code: 'NEAR_LIMIT', severity: 'caution',
        text: `Wind at ${low.heightM} m is ${num(lw)} mph, close to the ${limits.windHighMph} mph maximum.`,
      });
    }
    if (shear <= limits.shearMph && shear > limits.shearMph - limits.cautionBandMph) {
      triggers.push({
        code: 'NEAR_LIMIT', severity: 'caution',
        text: `Wind differs by ${num(shear)} mph between ${low.heightM} m and ${high.heightM} m, close to the ${limits.shearMph} mph limit.`,
      });
    }
  }

  const stops = triggers.filter((t) => t.severity === 'stop');
  const status = stops.length ? 'STOP' : triggers.length ? 'CAUTION' : 'GO';
  const ground = groundOnly(reading, limits);

  let reason;
  if (status === 'STOP') {
    const [first, ...rest] = stops;
    reason = `Stop: ${lc(first.text)}`;
    if (first.code === 'INVERSION') {
      reason += ground.status === 'GO'
        ? ` Spray would hang in the air and drift, even though wind at ground level is a workable ${num(lw)} mph.`
        : ' Spray would hang in the air and drift.';
    }
    for (const r of rest) reason += ` Also, ${lc(r.text)}`;
  } else if (status === 'CAUTION') {
    reason = `Caution: ${lc(triggers[0].text)}`;
    for (const r of triggers.slice(1)) reason += ` Also, ${lc(r.text)}`;
    reason += ' Conditions are inside the limits for now but could change quickly, so check again before each pass.';
  } else {
    const air = diffT < 0
      ? `${num(Math.abs(diffT))} °C cooler than at ${low.heightM} m`
      : `the same temperature as at ${low.heightM} m`;
    reason = `Go: the air at ${high.heightM} m is ${air} (no inversion), wind at ${low.heightM} m is ${num(lw)} mph, and wind differs by only ${num(shear)} mph between heights.`;
  }

  return {
    status,
    triggers,
    reason,
    groundOnly: ground,
    caughtByTwoHeights: ground.status === 'GO' && status === 'STOP',
  };
}

// ---------- scripted days ----------
// Key rows: [minute, lowTempC, highMinusLowTempC, lowWindMph, highMinusLowWindMph]
const DAYS = {
  calm: [
    [0, 8.0, 1.8, 4.8, 1.2],
    [60, 9.5, 1.0, 4.6, 1.3],
    [80, 10.2, 0.4, 4.9, 1.4],
    [95, 11.0, -0.5, 5.2, 1.5],
    [150, 15.0, -0.9, 5.8, 1.6],
    [240, 20.0, -1.1, 6.4, 1.7],
    [300, 23.0, -1.2, 6.9, 1.8],
    [390, 26.0, -1.2, 7.5, 1.8],
    [420, 27.0, -1.1, 8.6, 2.0],
    [440, 27.5, -1.0, 9.6, 2.0],
    [455, 28.0, -1.0, 10.8, 2.1],
    [480, 28.5, -1.0, 11.5, 2.2],
    [540, 27.5, -0.9, 11.0, 2.2],
    [580, 26.5, -0.8, 10.2, 2.0],
    [600, 26.0, -0.8, 8.4, 1.8],
    [660, 24.5, -0.7, 6.5, 1.6],
    [720, 22.0, -0.6, 5.0, 1.4],
  ],
  windy: [
    [0, 9.0, -0.4, 11.5, 1.8],
    [150, 16.0, -0.8, 11.8, 2.0],
    [175, 17.5, -0.9, 7.5, 1.8],
    [200, 19.0, -1.0, 6.5, 1.8],
    [230, 20.5, -1.0, 7.0, 1.8],
    [255, 21.5, -1.0, 11.5, 2.0],
    [400, 27.0, -1.0, 12.0, 2.2],
    [425, 27.5, -1.0, 7.5, 1.8],
    [445, 27.5, -1.0, 7.0, 1.8],
    [470, 27.0, -0.9, 11.5, 2.0],
    [720, 21.0, -0.6, 12.0, 2.0],
  ],
  still: [
    [0, 7.0, 2.2, 1.2, 0.5],
    [120, 12.0, 2.0, 1.6, 0.6],
    [240, 17.0, 1.2, 2.0, 0.7],
    [280, 19.0, 0.4, 2.6, 0.9],
    [300, 20.5, -0.6, 4.2, 1.0],
    [360, 23.0, -1.0, 5.5, 1.5],
    [540, 26.0, -1.0, 6.5, 1.8],
    [720, 22.0, -0.7, 5.5, 1.6],
  ],
  // One compressed cycle of `calm`, repeated: inversion, Go, caution, wind stop, caution, Go.
  demo: [
    [0, 9.0, 1.8, 4.8, 1.3],
    [4, 9.2, 1.8, 4.8, 1.3],
    [8, 9.6, -0.6, 5.8, 1.3],
    [12, 10.0, -1.0, 7.0, 1.4],
    [14, 10.3, -1.0, 8.0, 1.5],
    [15, 10.5, -1.0, 9.0, 1.5],
    [21, 11.0, -1.0, 10.0, 1.8],
    [23, 11.3, -1.0, 11.0, 2.0],
    [29, 11.5, -1.0, 11.0, 2.0],
    [31, 11.3, -1.0, 10.0, 1.8],
    [37, 10.8, -1.0, 9.0, 1.6],
    [39, 10.5, -1.0, 7.0, 1.4],
    [42, 10.2, -1.0, 6.0, 1.3],
    [44, 9.8, -1.0, 5.2, 1.3],
    [49, 9.0, 1.8, 4.8, 1.3],
  ],
};
const DEMO_CYCLE = 49;

function interpolate(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last.slice(1);
  let i = 1;
  while (keys[i][0] < t) i++;
  const a = keys[i - 1];
  const b = keys[i];
  const f = (t - a[0]) / (b[0] - a[0]);
  return a.slice(1).map((v, k) => v + (b[k + 1] - v) * f);
}

// Deterministic hash in [-1, 1]
function hash(i, ch) {
  let x = (Math.imul(i | 0, 374761393) + Math.imul(ch + 1, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = x ^ (x >>> 16);
  return ((x >>> 0) / 4294967295) * 2 - 1;
}
// Smooth value noise on a 4-minute lattice
function wobble(t, ch) {
  const u = t / 4;
  const i = Math.floor(u);
  const f = u - i;
  const s = (1 - Math.cos(Math.PI * f)) / 2;
  return hash(i, ch) * (1 - s) + hash(i + 1, ch) * s;
}

function readingFor(day, t) {
  const keys = DAYS[day];
  const tt = day === 'demo' ? ((t % DEMO_CYCLE) + DEMO_CYCLE) % DEMO_CYCLE : t;
  const [lowT, dT, lowW, shear] = interpolate(keys, tt);
  const lt = lowT + 0.05 * wobble(t, 1);
  const ht = lowT + dT + 0.05 * wobble(t, 2);
  const lw = Math.max(0, lowW + 0.12 * wobble(t, 3));
  const hw = Math.max(0, lowW + shear + 0.12 * wobble(t, 4));
  return {
    t,
    clock: clockOf(t),
    low: { heightM: 2, tempC: round1(lt), windMph: round1(lw) },
    high: { heightM: 10, tempC: round1(ht), windMph: round1(hw) },
  };
}

// ---------- the weather source and log ----------
export function createWeather({ day = 'calm', limits = LIMITS } = {}) {
  if (!DAYS[day]) throw new Error(`Unknown day "${day}". Choose one of: ${Object.keys(DAYS).join(', ')}`);
  const entries = [];
  let last = null;

  const at = (t) => readingFor(day, t);

  function step(t) {
    const reading = at(t);
    const assessment = assess(reading, limits);
    const prev = entries.length ? entries[entries.length - 1].status : null;
    const changed = prev !== assessment.status;
    let note = '';
    if (changed) {
      const codes = assessment.triggers.map((x) => x.code);
      const what = assessment.triggers.length
        ? `${[...new Set(codes)].join(', ')}: ${assessment.triggers.map((x) => x.text).join(' ')}`
        : 'no limits exceeded';
      note = prev === null
        ? `First reading, ${assessment.status}. ${what}`
        : `Status changed from ${prev} to ${assessment.status}. ${what}`;
    }
    entries.push({
      t: reading.t,
      clock: reading.clock,
      low: { ...reading.low },
      high: { ...reading.high },
      status: assessment.status,
      triggers: assessment.triggers.map((x) => x.code),
      note,
    });
    last = { reading, assessment };
    return { reading, assessment, changed };
  }

  const logText = () => entries.map((e) => {
    const trig = e.triggers.length ? e.triggers.join(',') : '-';
    const line = `${e.clock}  ${e.status.padEnd(7)} ${e.low.heightM}m ${e.low.tempC.toFixed(1)}C ${e.low.windMph.toFixed(1)}mph | ${e.high.heightM}m ${e.high.tempC.toFixed(1)}C ${e.high.windMph.toFixed(1)}mph | triggers: ${trig}`;
    return e.note ? `${line} | ${e.note.replace(/\s+/g, ' ')}` : line;
  });

  return {
    day,
    limits,
    at,
    step,
    current: () => last,
    log: () => entries.map((e) => ({ ...e, triggers: [...e.triggers] })),
    logText: () => logText().join('\n') + (entries.length ? '\n' : ''),
    days: Object.keys(DAYS),
  };
}
