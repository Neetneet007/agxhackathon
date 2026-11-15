// Agronomy Advisor (the "Agronomy Agent" in ATC's diagram): what the field and crop mean for a job.
// Advice only. It reads the farm plan (scenario.json) and, when `node gis/fetch.js` has been run, the
// real soil survey and elevation at each field (dashboard/gis/gis.json). It has no acting tool.
import fs from 'node:fs';

const read = rel => { try { return JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')); } catch { return null; } };
const scenario = read('../../scenario.json');
const gis = read('../../dashboard/gis/gis.json');
export const GUIDE = read('./guide.json') || { notes: [], topics: {} };

const TEXTURES = ['clay', 'sand', 'silt', 'loam'];
const elevations = (gis?.sources?.elevation?.points || []).filter(p => p.id !== 'depot');
const lowest = elevations.length ? Math.min(...elevations.map(p => p.metres)) : null;

export function fieldProfile(nameOrId) {
  const f = scenario?.fields.find(x => x.name === nameOrId || x.id === nameOrId);
  if (!f) return null;
  const soil = gis?.sources?.soil?.points.find(p => p.id === f.id) || null;
  const elev = elevations.find(p => p.id === f.id) || null;
  const unit = soil?.mapUnit || null;
  return {
    id: f.id, name: f.name, crop: f.crop, acres: f.acres,
    soil: unit, soilTexture: unit ? TEXTURES.filter(t => unit.toLowerCase().includes(t)) : [],
    drainage: soil?.drainage ?? null, slopePct: soil?.slopePct ?? null,
    elevationM: elev?.metres ?? null, lowest: elev != null && elev.metres === lowest,
    soilSource: unit ? gis.sources.soil.provider : null, elevationSource: elev ? gis.sources.elevation.provider : null,
    position: gis?.points?.find(p => p.id === f.id) ?? null,
  };
}

// A note with no checked source can only advise. None can act; this mirrors weather/playbook.js.
export const authorized = n => n?.verified === true && Array.isArray(n.source) && n.source.length > 0;

export function notesFor(profile, jobType) {
  if (!profile) return [];
  const fill = t => t.replace('{soil}', profile.soil ?? 'This soil').replace('{crop}', profile.crop).replace('{elevation}', profile.elevationM ?? '?').replace('{slope}', profile.slopePct ?? '?');
  return GUIDE.notes.filter(n => {
    const w = n.when || {};
    if (w.jobType && !w.jobType.includes(jobType)) return false;
    if (w.crop && !w.crop.includes(profile.crop)) return false;
    if (w.soilTexture && !w.soilTexture.some(t => profile.soilTexture.includes(t))) return false;
    if (w.lowest && !profile.lowest) return false;
    if (w.minSlopePct != null && !(profile.slopePct >= w.minSlopePct)) return false;
    return true;
  }).map(n => ({ id: n.id, topic: n.topic, text: fill(n.text), verified: authorized(n) }));
}

const tagFor = notes => `[agronomy note ${notes.map(n => n.id).join(', ')}; advice only, not checked against a source]`;
const describe = p => [p.soil && `soil ${p.soil}${p.drainage ? `, ${p.drainage.toLowerCase()}` : ''}`, p.elevationM != null && `${Math.round(p.elevationM)} m elevation`].filter(Boolean).join(', ');

// Rule-only answer to a farming question (used by POST /ask). Returns { lines, facts }.
export function answer(ctx, question) {
  const q = question.toLowerCase();
  const lines = [], facts = {};
  const fields = (scenario?.fields || []).filter(f => q.includes(f.name.toLowerCase()) || new RegExp(`\\b${f.id.toLowerCase()}\\b`).test(q));
  const jobType = ['spray', 'mow', 'till', 'seed'].find(t => q.includes(t)) || (q.includes('plant') ? 'seed' : q.includes('cut') ? 'mow' : null);
  for (const f of fields.slice(0, 3)) {
    const p = fieldProfile(f.id), notes = notesFor(p, jobType);
    facts[f.id] = { profile: p, notes };
    lines.push(`${p.name}: ${p.acres} acres of ${p.crop}${describe(p) ? `, ${describe(p)}` : ''}.${notes.length ? ` ${notes.map(n => n.text).join(' ')}` : ''}`);
  }
  const TOPIC_WORDS = { irrigation: ['irrigat', 'water'], fertiliser: ['fertili', 'nitrogen', 'nutrient', 'manure'], pests: ['pest', 'insect', 'aphid', 'disease', 'weed', 'fung'], harvest: ['harvest', 'bale', 'yield'], planting: ['plant', 'sow', 'variety', 'seed rate'], livestock: ['livestock', 'cattle', 'cow', 'sheep', 'graz'], soil: ['soil', 'clay', 'sand', 'drain', 'compact'], labour: ['labour', 'labor', 'worker', 'people', 'crew'] };
  for (const [topic, words] of Object.entries(TOPIC_WORDS)) {
    if (words.some(w => q.includes(w)) && GUIDE.topics[topic]) { lines.push(GUIDE.topics[topic]); (facts.topics ||= []).push(topic); }
  }
  if (!fields.length && jobType) {
    const general = GUIDE.notes.filter(n => n.when?.jobType?.includes(jobType) && !n.when.crop && !n.when.soilTexture).map(n => n.text.replace('{crop}', 'the crop'));
    if (general.length) lines.push(general.join(' '));
  }
  if (!lines.length) lines.push(`No field note covers that. This advisor knows each field's crop, acres, soil survey unit and elevation, and has notes on: ${[...new Set(GUIDE.notes.map(n => n.topic))].join(', ')}. Rates, products and dates are set by the product label, the supplier or a person.`);
  lines.push('Field notes are advice only and have not been checked against a cited source.');
  return { lines, facts };
}

export default {
  displayName: 'Agronomy Advisor',
  job: 'What the field and crop mean for a job (advice only)',
  answer,

  sense(ctx) {
    const seen = ctx.memory.get('agronomy.noted') || [];
    return (ctx.state?.jobs || []).some(j => j.status === 'active' && !seen.includes(j.id)) ? 'a job has started' : null;
  },

  plan(ctx) {
    const seen = ctx.memory.get('agronomy.noted') || [];
    const fresh = (ctx.state?.jobs || []).filter(j => j.status === 'active' && !seen.includes(j.id));
    return fresh.length ? { fresh, prompt: `Plan clock ${ctx.clock}. Jobs that just started: ${JSON.stringify(fresh.map(j => ({ id: j.id, type: j.type, field: j.field })))}.` } : null;
  },

  act(ctx, { fresh }) {
    const seen = [...(ctx.memory.get('agronomy.noted') || []), ...fresh.map(j => j.id)];
    const given = { ...(ctx.memory.get('agronomy.advice') || {}) };
    const statements = [];
    for (const j of fresh) {
      const p = fieldProfile(j.field), notes = notesFor(p, j.type);
      given[j.id] = { field: j.field, notes: notes.map(n => n.id) };
      // Speak only with something to add; advice goes to the operator and changes nothing.
      if (notes.length) statements.push({ to: 'operator', type: 'advice', template: `${j.id} on ${p.name} (${p.crop}${describe(p) ? `; ${describe(p)}` : ''}): ${notes.map(n => n.text).join(' ')}`, tag: tagFor(notes), facts: { job: j.id, type: j.type, profile: p, notes } });
    }
    ctx.commit({ memory: { 'agronomy.noted': seen, 'agronomy.advice': given } });
    return { statements, summary: `${statements.length} field note(s) for ${fresh.length} job(s)` };
  },

  tools: [
    {
      name: 'field_profile', kind: 'reads', description: 'A field\'s crop and acres from the farm plan, and its real soil survey unit, drainage, slope and elevation when the GIS files are present (null when not).',
      input_schema: { type: 'object', properties: { field: { type: 'string', description: 'field name or id' } }, required: ['field'], additionalProperties: false },
      handler: ({ field }) => fieldProfile(field) ?? { missing: field },
    },
    {
      name: 'notes_for', kind: 'reads', description: 'Code: the field notes that apply to a job type on a field. Every note says whether it is verified; unverified notes are advice only.',
      input_schema: { type: 'object', properties: { field: { type: 'string' }, jobType: { type: 'string', enum: ['spray', 'mow', 'till', 'seed'] } }, required: ['field', 'jobType'], additionalProperties: false },
      handler: ({ field, jobType }) => { const p = fieldProfile(field); return p ? notesFor(p, jobType) : { missing: field }; },
    },
    {
      name: 'list_fields', kind: 'reads', description: 'Every field with its profile.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => (scenario?.fields || []).map(f => fieldProfile(f.id)),
    },
    {
      name: 'topic', kind: 'reads', description: 'What this team does and does not know about a farming topic.',
      input_schema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(GUIDE.topics) } }, required: ['topic'], additionalProperties: false },
      handler: ({ topic }) => ({ topic, text: GUIDE.topics[topic] ?? null }),
    },
  ],
};
