// Spray-weather rules, as plain code. The model never computes these; it only reads the result.
// A reading: { t2C, t10C, wind2Mph, wind10Mph } — temperature and wind at 2 m (boom height)
// and 10 m (standard mast height).

export const THRESHOLDS = {
  inversionC: 0,        // Stop when the 10 m temperature is higher than the 2 m temperature by more than this
  windLowMph: 3,        // Stop below this at 2 m: calm air lets fine droplets hang and drift
  windHighMph: 10,      // Stop above this at 2 m: physical drift off target
  windCautionMph: 8,    // Caution above this at 2 m: close to the limit
  shearMph: 5,          // Caution when |wind at 10 m − wind at 2 m| is larger than this
};

const LEVEL = { Go: 0, Caution: 1, Stop: 2 };
const f1 = n => Number(n).toFixed(1);

export function evaluate(r, th = THRESHOLDS) {
  if (!r) return { status: 'Stop', triggers: [{ code: 'no_reading', level: 'Stop', text: 'no weather reading available' }], reading: null, thresholds: th };
  const triggers = [];
  const inv = r.t10C - r.t2C;
  if (inv > th.inversionC) triggers.push({ code: 'inversion', level: 'Stop', text: `temperature inversion: ${f1(r.t10C)} °C at 10 m is warmer than ${f1(r.t2C)} °C at 2 m` });
  if (r.wind2Mph < th.windLowMph) triggers.push({ code: 'wind_low', level: 'Stop', text: `wind ${f1(r.wind2Mph)} mph at 2 m is below ${th.windLowMph} mph` });
  else if (r.wind2Mph > th.windHighMph) triggers.push({ code: 'wind_high', level: 'Stop', text: `wind ${f1(r.wind2Mph)} mph at 2 m is above ${th.windHighMph} mph` });
  else if (r.wind2Mph > th.windCautionMph) triggers.push({ code: 'wind_near_high', level: 'Caution', text: `wind ${f1(r.wind2Mph)} mph at 2 m is close to the ${th.windHighMph} mph limit` });
  const shear = Math.abs(r.wind10Mph - r.wind2Mph);
  if (shear > th.shearMph) triggers.push({ code: 'shear', level: 'Caution', text: `wind shear: ${f1(r.wind10Mph)} mph at 10 m vs ${f1(r.wind2Mph)} mph at 2 m (difference over ${th.shearMph} mph)` });
  const status = triggers.reduce((s, t) => (LEVEL[t.level] > LEVEL[s] ? t.level : s), 'Go');
  return { status, triggers, reading: r, thresholds: th };
}

// Does the 2 m reading on its own look fine? Used to show the value of the second height.
export function twoMetreAloneOk(r, th = THRESHOLDS) {
  return r.wind2Mph >= th.windLowMph && r.wind2Mph <= th.windCautionMph;
}

export function readingText(r) {
  return `2 m: ${f1(r.t2C)} °C, ${f1(r.wind2Mph)} mph; 10 m: ${f1(r.t10C)} °C, ${f1(r.wind10Mph)} mph`;
}

// One plain sentence for the hold, naming the readings that triggered it.
export function holdReason(ev) {
  const stops = ev.triggers.filter(t => t.level === 'Stop').map(t => t.text);
  return `Spraying stopped by the weather agent: ${stops.join('; ')}.`;
}

// Templated explanation used by the rule-only path (and as a fallback if the model writes none).
export function templateText(ev, previous) {
  const r = ev.reading;
  const why = ev.triggers.map(t => t.text).join('; ');
  if (ev.status === 'Stop') {
    const note = ev.triggers.some(t => t.code === 'inversion') && twoMetreAloneOk(r) ? ' The 2 m reading alone looks fine; the 10 m reading shows the inversion.' : '';
    return `Spraying on hold: ${why}.${note}`;
  }
  if (ev.status === 'Caution') return `Spraying may continue with care: ${why}.${previous === 'Stop' ? ' The spray hold is lifted.' : ''}`;
  return `Spraying can go ahead: ${readingText(r)}, no inversion and wind in range.${previous === 'Stop' ? ' The spray hold is lifted.' : ''}`;
}
