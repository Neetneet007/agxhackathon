// Safety Officer: checks every plan and recall; watches tractor spacing. Cannot be overruled by
// another agent: its stop is lifted only by a person or by this agent when the cause is gone.

export const SPACING_M = 15;  // farm choice: two working tractors closer than this are too close
const DEPOT_RADIUS_M = 40;    // tractors parked in their depot bays are excluded from spacing
const PERSIST = 2;            // polls a problem must last before acting (one bad reading is not enough)
const CLEAR = 3;              // polls clear before this agent lifts its own stop
const STOP_ID = 'safety-stop';

const RAD = Math.PI / 180;
const metres = (a, b) => {
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD), y = (b.lat - a.lat) * RAD;
  return Math.hypot(x, y) * 6371000;
};

export function checkSpacing(state, home) {
  const ts = (state?.tractors || []).filter(t => t.tel?.lat != null && !['DOWN', 'NO_RESPONSE'].includes(t.state?.code));
  const out = [];
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const d = metres(ts[i].tel, ts[j].tel);
    const atDepot = home && metres(ts[i].tel, home) < DEPOT_RADIUS_M && metres(ts[j].tel, home) < DEPOT_RADIUS_M;
    if (d < SPACING_M && !atDepot) out.push({ pair: [ts[i].id, ts[j].id], metres: Math.round(d * 10) / 10 });
  }
  return out;
}

export function checkHoldsRespected(state) {
  const out = [];
  const jobs = new Map((state?.jobs || []).map(j => [j.id, j]));
  for (const t of state?.tractors || []) {
    if (t.state?.code !== 'WORKING') continue;
    if ((state.recalls || []).length) { out.push({ tractor: t.id, problem: `working while the fleet is recalled by ${state.recalls[0].by}` }); continue; }
    const job = jobs.get((t.queue || [])[0]) || [...jobs.values()].find(j => j.tractor === t.id && j.status === 'active');
    if (!job) continue;
    const h = (state.holds || []).find(h => (h.jobTypes.includes('*') || h.jobTypes.includes(job.type)) && (!h.fields || h.fields.includes(job.field)));
    if (h) out.push({ tractor: t.id, problem: `working on ${job.id} (${job.type}) despite the hold by ${h.by}` });
  }
  return out;
}

export function checkLocks(state) {
  return (state?.tasks || []).filter(k => ['waiting', 'parked', 'locked'].includes(k.state)).map(k => ({ k, t: (state.tractors || []).find(t => t.id === k.tractor) }))
    .filter(({ t }) => t && (t.tel?.speedKph ?? 0) > 0.5).map(({ k, t }) => ({ tractor: t.id, problem: `moving at ${t.tel.speedKph} km/h while locked for ${k.kind}` }));
}

export default {
  displayName: 'Safety Officer',
  job: 'Checks every plan and every recall; watches tractor spacing',

  sense(ctx) {
    const v = ctx.volatile;
    const spacing = checkSpacing(ctx.state, ctx.farm?.home);
    const others = [...checkHoldsRespected(ctx.state), ...checkLocks(ctx.state)];
    v.bad = spacing.length ? (v.bad || 0) + 1 : 0;
    v.clear = spacing.length ? 0 : (v.clear || 0) + 1;
    v.otherBad = others.length ? (v.otherBad || 0) + 1 : 0;
    const stopped = !!ctx.memory.get('safety.stop');
    v.findings = { spacing, others };
    if (spacing.length && v.bad >= PERSIST && !stopped) return 'two tractors too close';
    if (!spacing.length && stopped && v.clear >= CLEAR) return 'spacing restored';
    const sig = others.map(o => o.tractor + o.problem.split(' ')[0]).sort().join('|');
    if (others.length && v.otherBad >= PERSIST && sig !== ctx.memory.get('safety.objected')) return 'a tractor is not respecting a stop';
    return null;
  },

  plan(ctx) {
    const f = ctx.volatile.findings;
    return f ? { ...f, prompt: `Plan clock ${ctx.clock}. Findings: ${JSON.stringify(f)}.` } : null;
  },

  act(ctx, { spacing, others }) {
    const statements = [], effects = [];
    const memory = {};
    const stopped = ctx.memory.get('safety.stop');
    const n = (ctx.memory.get('safety.n') || 0) + 1;
    memory['safety.n'] = n;
    if (spacing.length && !stopped) {
      const reason = `${spacing[0].pair.join(' and ')} are ${spacing[0].metres} m apart, under the ${SPACING_M} m spacing limit`;
      effects.push({ id: `safety:${n}:stop`, spec: { kind: 'hold', key: `hold:${STOP_ID}`, body: { id: STOP_ID, jobTypes: ['*'], fields: null, reason: `Safety stop: ${reason}.`, by: 'Safety Officer' } } });
      memory['safety.stop'] = { id: STOP_ID, reason, since: ctx.clock };
      statements.push({ to: 'plan', type: 'stop', template: `All work stopped: ${reason}. Only a person, or this officer once they are apart, can lift it.`, tag: '', facts: { spacing } });
    } else if (!spacing.length && stopped && ctx.volatile.clear >= CLEAR) {
      effects.push({ id: `safety:${n}:lift`, spec: { kind: 'unhold', key: `hold:${STOP_ID}`, holdId: STOP_ID } });
      memory['safety.stop'] = null;
      statements.push({ to: 'plan', type: 'clear', template: `Spacing is back above ${SPACING_M} m; the safety stop is lifted.`, tag: '', facts: {} });
    }
    const sig = others.map(o => o.tractor + o.problem.split(' ')[0]).sort().join('|');
    if (others.length && sig !== ctx.memory.get('safety.objected')) {
      memory['safety.objected'] = sig;
      statements.push({ to: 'plan', type: 'object', template: `Objection: ${others.map(o => `${o.tractor} is ${o.problem}`).join('; ')}.`, tag: '', facts: { others } });
    }
    ctx.commit({ memory, effects });
    return { statements, summary: `${effects.length} action(s), ${statements.length} statement(s)` };
  },

  tools: [
    { name: 'check_spacing', kind: 'reads', description: `Code: distance between every pair of tractors; flags pairs closer than ${SPACING_M} m outside the depot.`, input_schema: { type: 'object', properties: {}, additionalProperties: false }, handler: (_, ctx) => checkSpacing(ctx.state, ctx.farm?.home) },
    { name: 'check_holds_respected', kind: 'reads', description: 'Code: any tractor working against a hold or recall.', input_schema: { type: 'object', properties: {}, additionalProperties: false }, handler: (_, ctx) => checkHoldsRespected(ctx.state) },
    { name: 'check_locks', kind: 'reads', description: 'Code: any tractor at the depot for service that is not stationary.', input_schema: { type: 'object', properties: {}, additionalProperties: false }, handler: (_, ctx) => checkLocks(ctx.state) },
    {
      name: 'object', kind: 'acts', description: 'Object to a plan or action: a message to the Plan Manager and the operator.',
      input_schema: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what', 'why'], additionalProperties: false },
      handler: ({ what, why }, ctx) => ({ ok: true, id: ctx.sendMessage('plan', 'object', `Objection to ${what}: ${why}`) }),
    },
    {
      name: 'stop_all', kind: 'acts', description: 'Stop all work (POST /hold for every job type). Only when a check above shows a danger now.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
      handler: ({ reason }, ctx) => {
        if (!checkSpacing(ctx.state, ctx.farm?.home).length && !checkHoldsRespected(ctx.state).length) throw new Error('refused: no check shows a danger now');
        const n = (ctx.memory.get('safety.n') || 0) + 1;
        ctx.commit({ memory: { 'safety.n': n, 'safety.stop': { id: STOP_ID, reason, since: ctx.clock } }, effects: [{ id: `safety:${n}:stop`, spec: { kind: 'hold', key: `hold:${STOP_ID}`, body: { id: STOP_ID, jobTypes: ['*'], fields: null, reason: `Safety stop: ${reason}`, by: 'Safety Officer' } } }] });
        return { ok: true };
      },
    },
  ],
};
