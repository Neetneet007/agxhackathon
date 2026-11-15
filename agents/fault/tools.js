// Fault Manager: decides whether a tractor is really in trouble, and how badly. It never declares
// a fault from one bad reading (a symptom must persist for PERSIST polls) and never repairs anything.
// The live runner's own detector takes a tractor out of service; this agent explains and advises.

const WINDOW_MS = 60_000;
const PERSIST = 3;       // consecutive polls a symptom must last before a verdict (farm choice)
const OFF_LINE_M = 60;   // planGapM above this = off its planned line (farm choice)
const STUCK_MOVED_M = 5; // moved less than this over the window while DRIVING = not moving

const RAD = Math.PI / 180;
const metres = (a, b) => {
  if (a?.lat == null || b?.lat == null) return null;
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD), y = (b.lat - a.lat) * RAD;
  return Math.hypot(x, y) * 6371000;
};

export function classify(window) {
  const last = window[window.length - 1];
  if (!last) return [];
  const out = [];
  if (last.code === 'NO_RESPONSE' || (last.heardAgoMs ?? 0) > 3000) out.push({ symptom: 'silent', evidence: `no telemetry for ${Math.round((last.heardAgoMs ?? 0) / 1000)} s (state ${last.code})` });
  if (last.code === 'GO_NOT_MOVING') out.push({ symptom: 'go_not_moving', evidence: 'the live runner reports GO acknowledged but not moving' });
  const driving = window.filter(w => w.code === 'DRIVING');
  if (driving.length >= PERSIST && driving.length === window.slice(-driving.length).length) {
    const moved = metres(driving[0], driving[driving.length - 1]);
    if (moved != null && moved < STUCK_MOVED_M) out.push({ symptom: 'go_not_moving', evidence: `told to drive but moved ${moved.toFixed(1)} m in ${((driving[driving.length - 1].t - driving[0].t) / 1000).toFixed(0)} s` });
  }
  if ((last.planGapM ?? 0) > OFF_LINE_M) out.push({ symptom: 'off_line', evidence: `${last.planGapM} m from where the plan expects it` });
  if (last.code === 'DRIVING' && last.speedKph != null && last.speedKph < 0.5 && !out.some(o => o.symptom === 'go_not_moving')) out.push({ symptom: 'speed_mismatch', evidence: `driving at ${last.speedKph} km/h` });
  return out;
}

export default {
  displayName: 'Fault Manager',
  job: 'Decides whether a tractor is really in trouble, and how badly',

  sense(ctx) {
    const v = ctx.volatile;
    v.windows ||= {}; v.streak ||= {};
    const now = Date.now();
    let changed = false;
    const verdicts = { ...(ctx.memory.get('fault.verdicts') || {}) };
    for (const t of ctx.state?.tractors || []) {
      const w = (v.windows[t.id] ||= []);
      w.push({ t: now, code: t.state?.code, lat: t.tel?.lat, lon: t.tel?.lon, speedKph: t.tel?.speedKph, heardAgoMs: t.heardAgoMs, planGapM: t.planGapM });
      while (w.length && now - w[0].t > WINDOW_MS) w.shift();
      const symptoms = classify(w);
      // Positive = consecutive bad checks, negative = consecutive clear checks.
      v.streak[t.id] = symptoms.length ? Math.max(0, v.streak[t.id] || 0) + 1 : Math.min(0, v.streak[t.id] || 0) - 1;
      const cur = verdicts[t.id]?.verdict || 'ok';
      if (symptoms.length && v.streak[t.id] >= PERSIST && cur !== 'out-of-service') { verdicts[t.id] = { verdict: 'out-of-service', evidence: symptoms, since: ctx.clock }; changed = true; }
      else if (!symptoms.length && -v.streak[t.id] >= PERSIST && cur === 'out-of-service') { verdicts[t.id] = { verdict: 'back-in-service', evidence: [], since: ctx.clock }; changed = true; }
      else if (symptoms.length && v.streak[t.id] === 1 && cur === 'ok') v.watch = { ...(v.watch || {}), [t.id]: symptoms }; // one bad reading: watch only, say nothing
    }
    if (changed) { ctx.commit({ memory: { 'fault.verdicts': verdicts } }); return 'a fault verdict changed'; }
    return null;
  },

  plan(ctx) {
    const verdicts = ctx.memory.get('fault.verdicts') || {};
    const spoken = ctx.memory.get('fault.spoken') || {};
    const fresh = Object.entries(verdicts).filter(([id, v]) => spoken[id] !== `${v.verdict}@${v.since}`);
    return fresh.length ? { fresh, prompt: `Plan clock ${ctx.clock}. New verdicts: ${JSON.stringify(fresh)}.` } : null;
  },

  act(ctx, { fresh }) {
    const spoken = { ...(ctx.memory.get('fault.spoken') || {}) };
    const history = [...(ctx.memory.get('fault.history') || [])];
    const statements = [];
    for (const [id, v] of fresh) {
      spoken[id] = `${v.verdict}@${v.since}`;
      history.push({ tractor: id, ...v });
      const ev = v.evidence.map(e => e.evidence).join('; ');
      statements.push({ to: 'plan', type: v.verdict, template: v.verdict === 'out-of-service' ? `${id} looks out of service: ${ev}. It has lasted ${PERSIST} checks in a row, not a single bad reading; its work should move to another tractor.` : `${id} looks back in service: its symptoms have cleared for ${PERSIST} checks in a row.`, tag: '', facts: { tractor: id, ...v } });
    }
    ctx.commit({ memory: { 'fault.spoken': spoken, 'fault.history': history } });
    return { statements, summary: `${fresh.length} verdict(s)` };
  },

  tools: [
    {
      name: 'telemetry_window', kind: 'reads', description: "The last N seconds of a tractor's position, speed and state, kept from /state polls.",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, seconds: { type: 'number' } }, required: ['id'], additionalProperties: false },
      handler: ({ id, seconds = 30 }, ctx) => (ctx.volatile.windows?.[id] || []).filter(w => Date.now() - w.t <= seconds * 1000),
    },
    {
      name: 'classify_symptoms', kind: 'reads', description: 'Code: silent, GO acknowledged but not moving, off its line, speed not matching; each with the evidence.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      handler: ({ id }, ctx) => classify(ctx.volatile.windows?.[id] || []),
    },
    {
      name: 'fault_history', kind: 'reads', description: 'Past verdicts (faults and recoveries) from shared memory.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      handler: ({ id }, ctx) => (ctx.memory.get('fault.history') || []).filter(h => !id || h.tractor === id),
    },
    {
      name: 'recommend', kind: 'acts', description: 'Advise the Plan Manager and operator: watch, out-of-service or back-in-service, with evidence. Does not take the tractor out of service itself.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['watch', 'out-of-service', 'back-in-service'] }, evidence: { type: 'string' } }, required: ['id', 'verdict', 'evidence'], additionalProperties: false },
      handler: ({ id, verdict, evidence }, ctx) => {
        const c = classify(ctx.volatile.windows?.[id] || []);
        if (verdict === 'out-of-service' && !c.length) throw new Error(`refused: ${id} shows no symptom now`);
        return { ok: true, id: ctx.sendMessage('plan', verdict, `${id}: ${verdict}. ${evidence}`) };
      },
    },
  ],
};
