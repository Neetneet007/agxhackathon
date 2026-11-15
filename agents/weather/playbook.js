// The playbook engine: plain code over agents/weather/playbook.json. It says which rules fire, and
// what the fleet must do. A rule with no source or verified:false can only advise.
import fs from 'node:fs';

export const PLAYBOOK = JSON.parse(fs.readFileSync(new URL('./playbook.json', import.meta.url), 'utf8'));
export const RISK = JSON.parse(fs.readFileSync(new URL('./farm-risk.json', import.meta.url), 'utf8'));
export const ruleById = id => PLAYBOOK.rules.find(r => r.id === id);
export const authorized = r => r?.verified === true && Array.isArray(r.source) && r.source.length > 0;

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const alertsIn = t => (t.alert || []).concat(...(t.any || []).map(alertsIn), ...(t.all || []).map(alertsIn));

export function test(t, inp) {
  if (t.any) return t.any.some(x => test(x, inp));
  if (t.all) return t.all.every(x => test(x, inp));
  if (t.alert) return (inp.alerts || []).some(a => t.alert.includes(a));
  const v = get(inp, t.path);
  if (v == null) return false;
  if ('lt' in t) return v < t.lt;
  if ('lte' in t) return v <= t.lte;
  if ('gt' in t) return v > t.gt;
  if ('gte' in t) return v >= t.gte;
  if ('eq' in t) return v === t.eq;
  return false;
}

export function fill(template, inp, rule) {
  const alert = (inp.alerts || []).find(a => alertsIn(rule.trigger).includes(a));
  return template.replace(/\{([\w.]+)\}/g, (_, p) => {
    if (p === 'alert') return alert ?? 'An official alert';
    const v = get(inp, p);
    return v == null ? 'unknown' : String(typeof v === 'number' ? Math.round(v * 10) / 10 : v);
  });
}

const NEEDED = ['t2C', 't10C', 'wind2Mph', 'wind10Mph'];
export function derive(reading, { minutesSinceLightning = null } = {}) {
  const why = [];
  for (const k of NEEDED) if (typeof reading?.[k] !== 'number' || Number.isNaN(reading[k])) why.push(`${k} missing`);
  for (const k of ['t2C', 't10C']) if (typeof reading?.[k] === 'number' && (reading[k] < -50 || reading[k] > 60)) why.push(`${k} ${reading[k]} out of range`);
  for (const k of ['wind2Mph', 'wind10Mph', 'gustMph']) if (typeof reading?.[k] === 'number' && (reading[k] < 0 || reading[k] > 200)) why.push(`${k} ${reading[k]} out of range`);
  return {
    inversionC: why.length ? null : Math.round((reading.t10C - reading.t2C) * 100) / 100,
    shearMph: why.length ? null : Math.round(Math.abs(reading.wind10Mph - reading.wind2Mph) * 100) / 100,
    implausible: why.length > 0, implausibleWhy: why.join(', ') || null,
    minutesSinceLightning,
  };
}

// inp: { reading, derived, forecast, alerts, history }
export function fire(inp) {
  return PLAYBOOK.rules.filter(r => test(r.trigger, inp)).map(r => ({ id: r.id, rule: r, authorized: authorized(r), text: fill(r.explain, inp, r) }));
}

const SEV = PLAYBOOK.severity;
export const actionSeverity = a => SEV[a] ?? (a === 'hold_low_fields' ? SEV.hold_fields : 0);
export const ruleSeverity = f => (f.authorized ? Math.max(0, ...f.rule.actions.map(actionSeverity)) : SEV.advise);

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// What the fleet must do now. `episode` is an open after-flood/after-storm inspection round.
export function decide(fired, { episode = null, inspections = [] } = {}) {
  const holds = {}, advisories = [], requests = [], depot = [];
  let recall = null, blocks = null, inspect = null;
  const addHold = (id, jobTypes, fields, f) => {
    const h = (holds[id] ||= { id, jobTypes, fields, rules: [], reason: f.text });
    if (!h.rules.includes(f.id)) h.rules.push(f.id);
  };
  const addRecall = (f) => { recall ||= { id: 'wm-recall', rules: [], reason: f.text }; if (!recall.rules.includes(f.id)) recall.rules.push(f.id); };
  const addBlocks = (f) => { blocks ||= { bridges: RISK.bridges, rules: [] }; if (!blocks.rules.includes(f.id)) blocks.rules.push(f.id); };
  for (const f of fired) {
    if (!f.authorized) { advisories.push(f); continue; } // advice only: no hold, recall or plan change
    for (const a of f.rule.actions) {
      switch (a) {
        case 'hold_spray': addHold('wm-spray', ['spray'], null, f); break;
        case 'hold_types': addHold('wm-types', f.rule.holdTypes, null, f); break;
        case 'hold_all': addHold('wm-all', ['*'], null, f); break;
        case 'hold_low_fields': addHold('wm-lowfields', ['*'], RISK.lowFields, f); break;
        case 'recall': addRecall(f); break;
        case 'block_bridges': addBlocks(f); break;
        case 'advise': case 'ask_person': advisories.push(f); break;
        case 'reprioritise': case 'reprioritise_low_fields': case 'reprioritise_harvest': case 'fuel_all': requests.push({ kind: a, rule: f.id, text: f.text }); break;
        case 'tell_depot': case 'secure_depot': case 'no_depot_tasks': depot.push({ kind: a, rule: f.id, text: f.text }); break;
        case 'inspections': inspect = f; break;
        default: break; // keep_holds: handled by the open episode below
      }
    }
  }
  // After a flood or storm nothing restarts by itself: keep what the open inspections cover.
  if (episode && !episode.closed) {
    const open = episode.items.filter(it => (inspections.find(x => x.key === it.key)?.status ?? 'open') !== 'done');
    const ep = { id: episode.rule, text: `Waiting for ${open.length} inspection(s) by a person after the ${episode.rule === 'after-flood' ? 'flood' : 'storm'}.` };
    if (open.some(it => ['machine', 'lane', 'bridge'].includes(it.kind))) addRecall(ep);
    if (open.some(it => it.kind === 'bridge')) addBlocks(ep);
    for (const it of open.filter(i => i.kind === 'field')) {
      if (episode.rule === 'after-flood') addHold('wm-lowfields', ['*'], RISK.lowFields, ep);
      else addHold(`wm-field-${slug(it.where)}`, ['*'], [it.where], ep);
    }
  }
  if (holds['wm-all']) for (const id of Object.keys(holds)) if (id !== 'wm-all') delete holds[id]; // all work held already
  // Two or more rules asking for different levels of action: the most cautious wins, and we say so.
  const acting = fired.filter(f => f.authorized && ruleSeverity(f) > SEV.advise);
  const levels = [...new Set(acting.map(ruleSeverity))];
  const conflict = levels.length > 1 ? { rules: acting.map(f => f.id), chosen: acting.reduce((a, b) => (ruleSeverity(b) > ruleSeverity(a) ? b : a)).id } : null;
  return { holds, recall, blocks, advisories, requests, depot, inspect, conflict };
}

export function sourceTag(ids) {
  return ids.map(id => {
    const r = ruleById(id);
    if (!r) return id;
    const pubs = [...new Set(r.source.map(s => s.publisher))];
    return authorized(r) ? `${id} (${pubs[0]}${pubs.length > 1 ? ` +${pubs.length - 1}` : ''})` : `${id} (no verified source, advice only)`;
  }).join(', ');
}
