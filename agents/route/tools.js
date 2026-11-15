// Route Manager: field coverage routes and lane routes. Uses the live runner's own planners
// (agopen/coverage.js, agopen/lanes.js) through read-only imports when this checkout has them.
// It speaks once when a job starts, with the route facts; it never sends a tractor anywhere.
import fs from 'node:fs';

let coverage = null, lanes = null, scenario = null;
try { scenario = JSON.parse(fs.readFileSync(new URL('../../scenario.json', import.meta.url), 'utf8')); } catch { /* none */ }
try { coverage = await import('../../agopen/coverage.js'); } catch { /* not on this checkout */ }
try { const L = await import('../../agopen/lanes.js'); lanes = scenario ? L.buildLanes(scenario) : null; } catch { /* not on this checkout */ }

const fieldByName = name => scenario?.fields.find(f => f.name === name || f.id === name) || null;
function laneLength(from, to) {
  if (!lanes) return null;
  for (const [a, b] of [[from, to], [fieldByName(from)?.id ?? from, fieldByName(to)?.id ?? to]]) {
    try { const L = lanes.lengthBetween(a, b); if (L != null) return Math.round(L); } catch { /* try next form */ }
  }
  return null;
}

export default {
  displayName: 'Route Manager',
  job: 'Field coverage routes and lane routes',

  sense(ctx) {
    const seen = ctx.memory.get('route.started') || [];
    return (ctx.state?.jobs || []).some(j => j.status === 'active' && !seen.includes(j.id)) ? 'a job has started' : null;
  },

  plan(ctx) {
    const seen = ctx.memory.get('route.started') || [];
    const fresh = (ctx.state?.jobs || []).filter(j => j.status === 'active' && !seen.includes(j.id));
    return fresh.length ? { fresh, prompt: `Plan clock ${ctx.clock}. Jobs that just started: ${JSON.stringify(fresh)}.` } : null;
  },

  act(ctx, { fresh }) {
    const seen = [...(ctx.memory.get('route.started') || []), ...fresh.map(j => j.id)];
    const routes = { ...(ctx.memory.get('route.jobs') || {}) };
    const statements = [];
    for (const j of fresh) {
      routes[j.id] = { field: j.field, route: j.route ?? null, laneFromDepotM: laneLength('depot', j.field) };
      // Speak only with new facts: the route the live runner planned for this job.
      if (j.route) statements.push({ to: 'operator', type: 'route', template: `${j.id} on ${j.field}: ${j.route.passes} passes ${j.route.widthM} m apart, about ${(j.route.lengthM / 1000).toFixed(1)} km to drive in the field.`, tag: '', facts: { job: j.id, ...routes[j.id] } });
    }
    ctx.commit({ memory: { 'route.started': seen, 'route.jobs': routes } });
    return { statements, summary: `${fresh.length} job(s) started` };
  },

  tools: [
    {
      name: 'get_field', kind: 'reads', description: 'Outline, area and position for a field, from the live runner farm and the scenario.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      handler: ({ name }, ctx) => ({ farm: ctx.farm?.fields?.find(f => f.name === name) ?? null, scenario: fieldByName(name) }),
    },
    {
      name: 'plan_coverage', kind: 'reads', description: 'Code (agopen/coverage.js): passes, headland lap and length to drive for a field outline and implement width.',
      input_schema: { type: 'object', properties: { field: { type: 'string' }, widthM: { type: 'number' } }, required: ['field', 'widthM'], additionalProperties: false },
      handler: ({ field, widthM }, ctx) => {
        if (!coverage) return { unavailable: 'agopen/coverage.js is not in this checkout' };
        const f = ctx.farm?.fields?.find(x => x.name === field);
        if (!f?.boundary?.length) return { unavailable: `no outline for ${field} from GET /farm` };
        const home = ctx.farm.home, RAD = Math.PI / 180;
        const pts = f.boundary.map(([lon, lat]) => ({ e: (lon - home.lon) * 111320 * Math.cos(home.lat * RAD), n: (lat - home.lat) * 110574 }));
        const plan = coverage.planCoverage({ boundary: pts, abLine: { a: pts[0], b: pts[1] }, width: widthM });
        return { passes: plan.swaths?.length ?? null, lengthM: Math.round(plan.lengthM ?? 0), workLengthM: Math.round(plan.workLengthM ?? 0) };
      },
    },
    {
      name: 'plan_lane_route', kind: 'reads', description: 'Code (agopen/lanes.js): lane route length between the depot and a field, or two fields.',
      input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
      handler: ({ from, to }) => { const L = laneLength(from, to); return L == null ? { unavailable: lanes ? 'no lane route between those points' : 'agopen/lanes.js is not in this checkout' } : { lengthM: L }; },
    },
    {
      name: 'drive_time', kind: 'reads', description: 'Code: minutes along the lanes at a given speed.',
      input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, kph: { type: 'number' } }, required: ['from', 'to', 'kph'], additionalProperties: false },
      handler: ({ from, to, kph }) => { const L = laneLength(from, to); return L == null || !(kph > 0) ? { unavailable: true } : { minutes: Math.round((L / 1000) / kph * 60 * 10) / 10, lengthM: L }; },
    },
    {
      name: 'close_route', kind: 'acts', description: 'Close a lane or bridge (POST /event block_route).',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, cells: { type: 'array' }, reason: { type: 'string' } }, required: ['name', 'cells', 'reason'], additionalProperties: false },
      handler: ({ name, cells, reason }, ctx) => { ctx.commit({ effects: [{ id: `route:${ctx.clock}:block:${name}`, spec: { kind: 'event', key: `route:${name}`, body: { type: 'block_route', name, cells, note: reason, source: 'route-manager' } } }] }); return { ok: true }; },
    },
    {
      name: 'open_route', kind: 'acts', description: 'Reopen a lane or bridge (POST /event unblock_route).',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, cells: { type: 'array' } }, required: ['name', 'cells'], additionalProperties: false },
      handler: ({ name, cells }, ctx) => { ctx.commit({ effects: [{ id: `route:${ctx.clock}:unblock:${name}`, spec: { kind: 'event', key: `route:${name}`, body: { type: 'unblock_route', name, cells, source: 'route-manager' } } }] }); return { ok: true }; },
    },
  ],
};
