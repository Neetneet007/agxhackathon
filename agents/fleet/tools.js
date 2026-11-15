// Fleet Manager: knows every tractor (position, fuel, implement, state). Asks the Depot Manager for
// fuel or an implement change; never moves or releases a tractor.
import fs from 'node:fs';

const FUEL_MARGIN_PCT = 25; // farm choice: below this a tractor is sent for fuel at its next stop
const FUEL_FULL_PCT = 90;   // "fuel everything" asks only for tractors below this
let IMPLEMENTS = {};
try {
  const sc = JSON.parse(fs.readFileSync(new URL('../../scenario.json', import.meta.url), 'utf8'));
  IMPLEMENTS = Object.fromEntries(sc.tractors.map(t => [t.id, t.implements]));
} catch { /* scenario not found: who_can_do falls back to the mounted implement */ }
const IMPLEMENT_FOR = { spray: 'sprayer', mow: 'mower', till: 'tiller', seed: 'seeder' };

const brief = t => ({ id: t.id, name: t.name, state: t.state?.code, task: t.task, mounted: t.mounted, fuelPct: t.fuelPct, speedKph: t.tel?.speedKph ?? null, lat: t.tel?.lat ?? null, lon: t.tel?.lon ?? null, field: t.tel?.field ?? null, queue: t.queue || [] });

export default {
  displayName: 'Fleet Manager',
  job: 'Knows every tractor: position, fuel, implement, state',

  sense(ctx) {
    const tractors = ctx.state?.tractors || [];
    const snap = tractors.map(t => `${t.id}:${t.state?.code}:${t.mounted}:${Math.floor((t.fuelPct ?? 0) / 10)}`).join('|');
    if (snap !== ctx.memory.get('fleet.sig')) ctx.commit({ memory: { 'fleet.sig': snap, 'fleet.tractors': tractors.map(brief) } });
    const asked = ctx.memory.get('fleet.fuelAsked') || [];
    return tractors.some(t => (t.fuelPct ?? 100) < FUEL_MARGIN_PCT && !asked.includes(t.id)) ? 'a tractor is below the fuel margin' : null;
  },

  plan(ctx, { inbox }) {
    const asked = ctx.memory.get('fleet.fuelAsked') || [];
    const low = (ctx.state?.tractors || []).filter(t => (t.fuelPct ?? 100) < FUEL_MARGIN_PCT && !asked.includes(t.id));
    const fuelAll = inbox.filter(m => m.data?.kind === 'fuel_all');
    if (!low.length && !fuelAll.length) return null;
    return { low, fuelAll, prompt: `Plan clock ${ctx.clock}. Tractors: ${JSON.stringify((ctx.state?.tractors || []).map(brief))}.` };
  },

  act(ctx, { low, fuelAll }) {
    const tractors = ctx.state?.tractors || [];
    let asked = [...(ctx.memory.get('fleet.fuelAsked') || [])];
    // Tractors back above the margin can be asked again later.
    asked = asked.filter(id => (tractors.find(t => t.id === id)?.fuelPct ?? 0) < FUEL_FULL_PCT);
    const want = new Map(low.map(t => [t.id, `fuel ${t.fuelPct}% is below the ${FUEL_MARGIN_PCT}% margin`]));
    if (fuelAll.length) for (const t of tractors) if ((t.fuelPct ?? 0) < FUEL_FULL_PCT && !want.has(t.id)) want.set(t.id, `fuel ${t.fuelPct}%, topping up as the ${fuelAll[0].from} asked`);
    const statements = [];
    for (const id of want.keys()) if (!asked.includes(id)) asked.push(id);
    if (want.size) statements.push({ to: 'depot', type: 'request', template: `Refuelling needed: ${[...want].map(([id, why]) => `${id} (${why})`).join('; ')}.`, tag: fuelAll[0]?.data?.rule ? `[rule ${fuelAll[0].data.rule}]` : '', data: { kind: 'refuel', tractors: [...want.keys()] }, facts: Object.fromEntries(want) });
    if (fuelAll.length && !want.size) statements.push({ to: fuelAll[0].from, type: 'reply', template: `Every tractor is already above ${FUEL_FULL_PCT}% fuel.`, tag: '', facts: {} });
    ctx.commit({ memory: { 'fleet.fuelAsked': asked } });
    return { statements, summary: `${want.size} refuel request(s)` };
  },

  tools: [
    { name: 'list_tractors', kind: 'reads', description: 'Every tractor: state, task, implement, fuel, speed, position, queue.', input_schema: { type: 'object', properties: {}, additionalProperties: false }, handler: (_, ctx) => (ctx.state?.tractors || []).map(brief) },
    {
      name: 'get_tractor', kind: 'reads', description: 'One tractor in full, as the live runner reports it.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      handler: ({ id }, ctx) => (ctx.state?.tractors || []).find(t => t.id === id) ?? { missing: id },
    },
    {
      name: 'fuel_outlook', kind: 'reads', description: `Code: fuel now, queued jobs, and whether it is below the ${FUEL_MARGIN_PCT}% margin. Burn per job is not reported by the live runner, so whether the queue fits is unknown.`,
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      handler: ({ id }, ctx) => { const t = (ctx.state?.tractors || []).find(x => x.id === id); return t ? { id, fuelPct: t.fuelPct, queued: (t.queue || []).length, belowMargin: t.fuelPct < FUEL_MARGIN_PCT, queueFits: 'unknown' } : { missing: id }; },
    },
    {
      name: 'who_can_do', kind: 'reads', description: 'Code: tractors that have the implement for a job type, and which have it mounted now.',
      input_schema: { type: 'object', properties: { jobType: { type: 'string', enum: ['spray', 'mow', 'till', 'seed'] } }, required: ['jobType'], additionalProperties: false },
      handler: ({ jobType }, ctx) => (ctx.state?.tractors || []).filter(t => (IMPLEMENTS[t.id] || [t.mounted]).includes(IMPLEMENT_FOR[jobType])).map(t => ({ id: t.id, mountedNow: t.mounted === IMPLEMENT_FOR[jobType] })),
    },
    {
      name: 'request_depot_task', kind: 'acts', description: 'Ask the Depot Manager for fuel, an implement change or an inspection. Does not move the tractor.',
      input_schema: { type: 'object', properties: { tractor: { type: 'string' }, kind: { type: 'string', enum: ['refuel', 'implement', 'inspection'] }, reason: { type: 'string' } }, required: ['tractor', 'kind', 'reason'], additionalProperties: false },
      handler: ({ tractor, kind, reason }, ctx) => ({ ok: true, id: ctx.sendMessage('depot', 'request', `${tractor} needs ${kind}: ${reason}`, { data: { kind, tractor } }) }),
    },
  ],
};
