// Depot Manager: the work people do at the depot (fuelling, implement changes, inspections).
// There is deliberately no "release tractor" tool: only a person pressing Good to go can do that.
// Inspections are marked done only through the person endpoint POST /people/depot/inspection_done.

export const KEYS = { inspections: 'depot.inspections', requests: 'depot.requests', paused: 'depot.paused', reminded: 'depot.reminded' };
const REMIND_EVERY_MIN = 10; // plan minutes between reminders for one waiting task (farm choice)

const waitedMin = (since, clock) => {
  const m = c => { const [h, mm] = String(c || '').split(':').map(Number); return h * 60 + mm; };
  return since && clock ? m(clock) - m(since) : null;
};

function dueReminders(ctx) {
  const reminded = ctx.memory.get(KEYS.reminded) || {};
  return (ctx.state?.tasks || []).filter(t => t.state === 'waiting' || t.state === 'parked')
    .map(t => ({ ...t, waited: waitedMin(t.since, ctx.clock) }))
    .filter(t => t.waited != null && t.waited >= REMIND_EVERY_MIN && (reminded[t.id] == null || ctx.minute - reminded[t.id] >= REMIND_EVERY_MIN));
}

export default {
  displayName: 'Depot Manager',
  job: 'The work people do: fuelling, implement changes, inspections',

  sense(ctx) {
    return dueReminders(ctx).length ? 'a depot task has waited too long' : null;
  },

  plan(ctx, { inbox }) {
    const due = dueReminders(ctx);
    if (!inbox.length && !due.length) return null;
    return { inbox, due, prompt: `Plan clock ${ctx.clock}. ${inbox.length} request(s) arrived; ${due.length} task(s) waiting for a person.` };
  },

  act(ctx, { inbox, due }) {
    const statements = [];
    const insp = [...(ctx.memory.get(KEYS.inspections) || [])];
    const requests = [...(ctx.memory.get(KEYS.requests) || [])];
    let paused = ctx.memory.get(KEYS.paused) || null;
    for (const m of inbox) {
      const d = m.data || {};
      if (d.kind === 'inspections') {
        const fresh = d.items.filter(it => !insp.some(x => x.key === it.key && x.status !== 'done'));
        for (const it of fresh) insp.push({ id: `I${insp.length + 1}`, ...it, status: 'open', episode: d.episode, why: `requested by ${m.from} (${m.type})`, opened: ctx.clock });
        if (fresh.length) statements.push({ to: 'operator', type: 'inspect', template: `${fresh.length} inspections are open for people: ${fresh.slice(0, 4).map(i => i.what).join('; ')}${fresh.length > 4 ? `; and ${fresh.length - 4} more` : ''}. Mark each done when checked; nothing restarts before that.`, tag: `[asked by ${m.from}]`, facts: { items: fresh } });
      } else if (d.kind === 'no_depot_tasks') {
        paused = { since: ctx.clock, rule: d.rule };
        statements.push({ to: 'operator', type: 'stop', template: 'Nobody should work at the depot now; fuelling, re-fitting and inspections wait until it is safe.', tag: `[asked by ${m.from}, rule ${d.rule}]`, facts: d });
      } else if (['refuel', 'implement', 'inspection', 'secure_depot', 'tell_depot', 'fuel_all'].includes(d.kind)) {
        requests.push({ id: `R${requests.length + 1}`, kind: d.kind, tractor: d.tractor ?? null, from: m.from, text: m.text, at: ctx.clock });
        if (d.kind === 'secure_depot') insp.push({ id: `I${insp.length + 1}`, key: `secure:${ctx.clock}`, kind: 'secure', what: 'Secure fuel and chemicals at the depot', where: 'depot', status: 'open', why: `requested by ${m.from}`, opened: ctx.clock });
      }
    }
    // Pause ends once no recall is in force any more (the weather that caused it has passed).
    if (paused && !(ctx.state?.recalls || []).length && !inbox.some(m => m.data?.kind === 'no_depot_tasks')) paused = null;
    const newReq = requests.slice((ctx.memory.get(KEYS.requests) || []).length);
    if (newReq.length) statements.push({ to: 'operator', type: 'request', template: `Depot work requested: ${newReq.map(r => `${r.kind.replace('_', ' ')}${r.tractor ? ` for ${r.tractor}` : ''} (from ${r.from})`).join('; ')}.${paused ? ' It waits until the depot is safe to work.' : ''}`, tag: '', facts: { requests: newReq } });
    const reminded = { ...(ctx.memory.get(KEYS.reminded) || {}) };
    for (const t of due) {
      reminded[t.id] = ctx.minute;
      statements.push({ to: 'operator', type: 'remind', template: `${t.tractor} has waited ${t.waited} minutes at the depot for ${t.kind}: ${t.text}. Press Good to go when it is done.`, tag: '', facts: t });
    }
    ctx.commit({ memory: { [KEYS.inspections]: insp, [KEYS.requests]: requests, [KEYS.paused]: paused, [KEYS.reminded]: reminded } });
    return { statements, summary: `${statements.length} statement(s)` };
  },

  // Things only a person can do, reported through the API. Logged before they change anything.
  people: {
    inspection_done(ctx, { id, key, by }) {
      const insp = [...(ctx.memory.get(KEYS.inspections) || [])];
      const it = insp.find(x => x.id === id || x.key === key);
      if (!it) return { error: `no inspection ${id ?? key}` };
      if (it.status === 'done') return { already: true };
      Object.assign(it, { status: 'done', by, doneAt: ctx.clock });
      ctx.commit({ memory: { [KEYS.inspections]: insp } });
      ctx.journal({ kind: 'inspection_done', id: it.id, key: it.key, by, clock: ctx.clock });
      const left = insp.filter(x => x.status !== 'done' && x.episode === it.episode).length;
      ctx.sendMessage('operator', 'inspected', `${it.what}: done by ${by}. ${left} inspection(s) still open.`);
      return { id: it.id, left };
    },
  },

  tools: [
    {
      name: 'list_tasks', kind: 'reads',
      description: 'Tasks waiting for a person at the depot, with how long each has waited (plan minutes).',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => (ctx.state?.tasks || []).map(t => ({ ...t, waitedMin: waitedMin(t.since, ctx.clock) })),
    },
    {
      name: 'list_requests', kind: 'reads',
      description: 'Requests other agents have sent (fuel, implement, inspection) and open inspections.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => ({ requests: ctx.memory.get(KEYS.requests) || [], inspections: ctx.memory.get(KEYS.inspections) || [], paused: ctx.memory.get(KEYS.paused) || null }),
    },
    {
      name: 'open_inspection', kind: 'acts',
      description: 'Add an inspection to the people\'s list and tell the operator.',
      input_schema: { type: 'object', properties: { what: { type: 'string' }, where: { type: 'string' }, why: { type: 'string' } }, required: ['what', 'where', 'why'], additionalProperties: false },
      handler: ({ what, where, why }, ctx) => {
        const insp = [...(ctx.memory.get(KEYS.inspections) || [])];
        const it = { id: `I${insp.length + 1}`, key: `manual:${insp.length + 1}`, kind: 'manual', what, where, why, status: 'open', opened: ctx.clock };
        insp.push(it);
        ctx.commit({ memory: { [KEYS.inspections]: insp } });
        return { ok: true, id: it.id };
      },
    },
    {
      name: 'remind_operator', kind: 'acts',
      description: 'Remind the operator about a waiting task; at most once every 10 plan minutes per task.',
      input_schema: { type: 'object', properties: { task: { type: 'string' }, text: { type: 'string' } }, required: ['task', 'text'], additionalProperties: false },
      handler: ({ task, text }, ctx) => {
        const reminded = { ...(ctx.memory.get(KEYS.reminded) || {}) };
        if (reminded[task] != null && ctx.minute - reminded[task] < REMIND_EVERY_MIN) throw new Error(`already reminded about ${task} in the last ${REMIND_EVERY_MIN} plan minutes`);
        reminded[task] = ctx.minute;
        ctx.commit({ memory: { [KEYS.reminded]: reminded } });
        return { ok: true, id: ctx.sendMessage('operator', 'remind', text) };
      },
    },
    {
      name: 'mark_inspection_done', kind: 'acts', modelMay: false,
      description: 'Only when a person reports it (POST /people/depot/inspection_done). Never from the model\'s own judgement.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' } }, required: ['id', 'by'], additionalProperties: false },
      handler: () => { throw new Error('only a person can mark an inspection done, through POST /people/depot/inspection_done'); },
    },
  ],
};
