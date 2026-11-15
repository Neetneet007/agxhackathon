// Record Keeper: the day's record. Jobs done and who did them, every stop and why. Append-only:
// it never changes a record after the fact. Writes the daily summary under agents/data/.

const END_OF_DAY_MIN = 720; // 18:00 on the plan clock (the planner's shift end)

const stopKey = s => `${s.kind}:${s.id}`;

export default {
  displayName: 'Record Keeper',
  job: 'The day\'s record: jobs done, who did them, every stop and why',

  sense(ctx) {
    const st = ctx.state;
    if (!st) return null;
    const rec = ctx.memory.get('records.jobs') || [];
    const stops = ctx.memory.get('records.stops') || [];
    const newDone = (st.jobs || []).filter(j => j.status === 'done' && !rec.some(r => r.job === j.id));
    const live = [...(st.holds || []).map(h => ({ kind: 'hold', id: h.id, by: h.by, reason: h.reason, since: h.since, work: h.jobTypes.join(', '), fields: h.fields })), ...(st.recalls || []).map(r => ({ kind: 'recall', id: r.id, by: r.by, reason: r.reason, since: r.since }))];
    const openStops = stops.filter(s => !s.ended);
    const started = live.filter(s => !openStops.some(o => stopKey(o) === stopKey(s)));
    const ended = openStops.filter(o => !live.some(s => stopKey(s) === stopKey(o)));
    const memory = {};
    // Append-only: new entries are added; an ended stop gets an end time, nothing is rewritten.
    if (newDone.length) memory['records.jobs'] = [...rec, ...newDone.map(j => ({ job: j.id, label: j.label, field: j.field, type: j.type, tractor: j.tractor || null, doneAt: ctx.clock }))];
    if (started.length || ended.length) memory['records.stops'] = [...stops.map(s => (ended.some(e => stopKey(e) === stopKey(s)) && !s.ended ? { ...s, ended: ctx.clock } : s)), ...started.map(s => ({ ...s, started: ctx.clock }))];
    if (Object.keys(memory).length) ctx.commit({ memory });
    const endOfDay = (st.finished || (ctx.minute ?? 0) >= END_OF_DAY_MIN) && !ctx.memory.get('records.summaryWritten');
    return endOfDay ? 'end of day' : null;
  },

  plan(ctx, { reason }) {
    if (!reason.includes('end of day') && !reason.includes('manual')) return null;
    return { prompt: `Plan clock ${ctx.clock}. Write today's summary from the facts.` };
  },

  act(ctx) {
    const jobs = ctx.memory.get('records.jobs') || [];
    const stops = ctx.memory.get('records.stops') || [];
    const open = (ctx.state?.jobs || []).filter(j => !['done', 'cancelled'].includes(j.status));
    const deferred = ctx.memory.get('plan.deferred') || [];
    const lines = [
      `# Day record: ${ctx.state?.scenario ?? 'farm'}, written at ${ctx.clock}`, '',
      `## Jobs done (${jobs.length})`, ...jobs.map(j => `- ${j.doneAt} ${j.job} ${j.label ?? ''} by ${j.tractor ?? 'unknown'}`), '',
      `## Stops (${stops.length})`, ...stops.map(s => `- ${s.started}${s.ended ? `–${s.ended}` : ' (still in force)'} ${s.kind} ${s.id} by ${s.by}: ${s.reason}`), '',
      `## Not finished (${open.length})`, ...open.map(j => `- ${j.id} ${j.label ?? ''} ${j.pct ?? 0}%`), '',
      `## Deferred to tomorrow (${deferred.length})`, ...deferred.map(j => `- ${j.id} ${j.label ?? ''}: ${j.reason}`),
    ];
    const file = ctx.writeFile(`summary-${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n') + '\n');
    ctx.commit({ memory: { 'records.summaryWritten': { at: ctx.clock, file } } });
    return {
      statements: [{ to: 'operator', type: 'summary', template: `Day record written: ${jobs.length} job(s) done, ${stops.length} stop(s), ${open.length} not finished, ${deferred.length} deferred.`, tag: '', facts: { jobs: jobs.length, stops: stops.length, open: open.length, deferred: deferred.length, file } }],
      summary: `summary written to ${file}`,
    };
  },

  tools: [
    {
      name: 'get_log', kind: 'reads', description: 'The durable log: messages and actions after a position, optionally for one agent.',
      input_schema: { type: 'object', properties: { since: { type: 'number' }, agent: { type: 'string' } }, additionalProperties: false },
      handler: ({ since = 0, agent }, ctx) => ctx.logEntries().filter(e => e.seq > since && (!agent || e.agent === agent) && ['commit', 'effect_done', 'person', 'wake', 'run_end'].includes(e.kind)).slice(-50).map(e => ({ seq: e.seq, kind: e.kind, agent: e.agent, ts: e.ts, message: e.message?.text, effects: e.effects?.map(f => f.id), summary: e.summary })),
    },
    {
      name: 'job_record', kind: 'reads', description: 'Who worked a job, when, how much, and every stop of its kind of work.',
      input_schema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'], additionalProperties: false },
      handler: ({ job }, ctx) => {
        const j = (ctx.state?.jobs || []).find(x => x.id === job);
        return { job: j ?? null, done: (ctx.memory.get('records.jobs') || []).find(r => r.job === job) ?? null, stops: (ctx.memory.get('records.stops') || []).filter(s => !j || s.work === '*' || String(s.work).includes(j.type) || s.kind === 'recall') };
      },
    },
    {
      name: 'write_summary', kind: 'acts', description: 'Write a summary for a period under agents/data/ (a new file each time; earlier records are never changed).',
      input_schema: { type: 'object', properties: { period: { type: 'string' }, text: { type: 'string' } }, required: ['period', 'text'], additionalProperties: false },
      handler: ({ period, text }, ctx) => ({ ok: true, file: ctx.writeFile(`summary-${period.replace(/[^\w-]/g, '_')}-${Date.now()}.md`, text) }),
    },
  ],
};
