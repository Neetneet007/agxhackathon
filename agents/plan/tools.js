// Plan Manager (chair): owns today's plan and decides what gives when it cannot all fit.
// It changes priorities and deadlines through POST /event; the planner re-plans by itself.
// It never moves a tractor directly and never overrides a safety or weather stop.

const SRC = 'plan-manager';
const toMin = c => { const [h, m] = String(c || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + m - 360 : null; };

// Code: a job is at risk when its deadline has passed and it is not done, or the deadline is
// within 30 plan minutes and it is less than half done. (30 min / 50 % are the farm's own choice.)
export function jobsAtRisk(state) {
  const now = toMin(state?.clock);
  if (now == null) return [];
  return (state.jobs || []).filter(j => !['done', 'cancelled'].includes(j.status)).map(j => {
    const dl = toMin(j.deadline);
    if (dl == null) return null;
    if (now > dl) return { id: j.id, label: j.label, deadline: j.deadline, pct: j.pct, late: true, byMin: now - dl };
    if (dl - now <= 30 && (j.pct ?? 0) < 50) return { id: j.id, label: j.label, deadline: j.deadline, pct: j.pct, late: false, minutesLeft: dl - now };
    return null;
  }).filter(Boolean);
}

// The chair's closing line after another agent's stop, recall or fault verdict.
const CLOSERS = {
  recall: () => 'Decision: the plan pauses while the fleet is recalled; jobs resume in priority order when the recall ends.',
  stop: m => (m.from === 'safety' ? 'Decision: the safety stop stands until a person or the Safety Officer lifts it.' : 'Decision: the held work waits; other jobs carry on and the planner re-plans around the hold.'),
  go: () => 'Decision: held work goes back into the plan in priority order.',
  caution: null,
  'out-of-service': m => `Decision: ${m.text.split(' ')[0]}'s jobs move to the other tractors; the live runner's own detector decides the fault.`,
  'back-in-service': m => `Decision: ${m.text.split(' ')[0]} takes work again at the next re-plan.`,
  object: () => 'Decision: noted; the stop stays in force and the operator is asked to check.',
};
for (const k of Object.keys(CLOSERS)) if (!CLOSERS[k]) delete CLOSERS[k];

function changePriority(ctx, { job, priority, deadline, reason }, n) {
  const body = { type: 'priority_change', job, note: reason, source: SRC };
  if (priority) body.priority = priority;
  if (deadline != null) body.deadline = typeof deadline === 'string' ? toMin(deadline) : deadline;
  return { id: `plan:${n}:prio:${job}:${priority ?? ''}:${deadline ?? ''}`, spec: { kind: 'event', key: `job:${job}`, body } };
}

export default {
  displayName: 'Plan Manager',
  job: "Owns today's plan; decides what gives when it cannot all fit",

  sense(ctx) {
    const risk = jobsAtRisk(ctx.state).map(r => r.id + (r.late ? ':late' : ':risk'));
    const seen = ctx.memory.get('plan.atRisk') || [];
    return risk.some(r => !seen.includes(r)) ? 'a job is running late' : null;
  },

  plan(ctx, { inbox }) {
    const risk = jobsAtRisk(ctx.state);
    const seen = ctx.memory.get('plan.atRisk') || [];
    const fresh = risk.filter(r => !seen.includes(r.id + (r.late ? ':late' : ':risk')));
    const actionable = inbox.filter(m => m.data?.kind?.startsWith('reprioritise') || CLOSERS[m.type]);
    if (!actionable.length && !fresh.length) return null;
    return { inbox, fresh, risk, prompt: `Plan clock ${ctx.clock}. You chair the roundtable: close each discussion with the decision in the statements. Jobs at risk: ${JSON.stringify(risk)}.` };
  },

  act(ctx, { inbox, fresh, risk }) {
    const statements = [], effects = [];
    const n = (ctx.memory.get('plan.n') || 0) + 1;
    const jobs = ctx.state?.jobs || [];
    const open = j => !['done', 'cancelled', 'active'].includes(j.status);
    for (const m of inbox) {
      const d = m.data || {};
      let targets = [];
      if (d.kind === 'reprioritise_low_fields') targets = jobs.filter(j => open(j) && d.fields?.includes(j.field) && j.priority !== 'high');
      else if (d.kind === 'reprioritise_harvest') targets = jobs.filter(j => open(j) && (d.jobTypes || ['mow']).includes(j.type) && j.priority !== 'high');
      else if (d.kind === 'reprioritise' && d.job) targets = jobs.filter(j => j.id === d.job && open(j));
      else continue;
      const priority = d.direction === 'back' ? 'low' : 'high';
      for (const j of targets) effects.push(changePriority(ctx, { job: j.id, priority, reason: `asked by ${m.from}: ${m.text.slice(0, 120)}` }, n));
      statements.push({
        to: m.from, type: 'decision',
        template: targets.length ? `Decision: ${targets.map(j => j.id).join(', ')} moved to ${priority} priority so ${priority === 'high' ? 'they run first' : 'they wait'}; the planner re-plans now.` : 'Decision: no open job matches that request, so the plan stays as it is.',
        tag: d.rule ? `[on rule ${d.rule}]` : '', facts: { request: m.text, jobs: targets.map(j => ({ id: j.id, field: j.field, type: j.type, was: j.priority })), priority },
      });
    }
    // Close the discussion: one decision line for the latest stop, recall or fault this wake-up.
    const closing = [...inbox].reverse().find(m => CLOSERS[m.type]);
    if (closing) statements.push({ to: 'operator', type: 'decision', template: CLOSERS[closing.type](closing), tag: '', facts: { after: { from: closing.from, type: closing.type, text: closing.text } } });
    for (const r of fresh) {
      statements.push({ to: 'operator', type: 'late', template: r.late ? `${r.id} (${r.label}) is past its ${r.deadline} deadline at ${r.pct ?? 0}% done. Approve a late finish or defer it to tomorrow?` : `${r.id} (${r.label}) is ${r.pct ?? 0}% done with ${r.minutesLeft} minutes to its ${r.deadline} deadline and may finish late.`, tag: '', facts: r });
    }
    ctx.commit({ memory: { 'plan.n': n, 'plan.atRisk': risk.map(r => r.id + (r.late ? ':late' : ':risk')) }, effects });
    return { statements, summary: `${effects.length} priority change(s), ${fresh.length} job(s) at risk` };
  },

  tools: [
    {
      name: 'list_jobs', kind: 'reads',
      description: 'Jobs from the live runner, filtered, with deadline, progress and assigned tractor.',
      input_schema: { type: 'object', properties: { status: { type: 'string' }, type: { type: 'string' }, field: { type: 'string' } }, additionalProperties: false },
      handler: ({ status, type, field }, ctx) => (ctx.state?.jobs || []).filter(j => (!status || j.status === status) && (!type || j.type === type) && (!field || j.field === field)),
    },
    {
      name: 'get_plan', kind: 'reads',
      description: "Each tractor's queue of jobs, in order.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => Object.fromEntries((ctx.state?.tractors || []).map(t => [t.id, t.queue || []])),
    },
    {
      name: 'jobs_at_risk', kind: 'reads',
      description: 'Code: jobs past their deadline, or within 30 minutes of it and under half done.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => jobsAtRisk(ctx.state),
    },
    {
      name: 'change_priority', kind: 'acts',
      description: "Change a job's priority and/or deadline (\"HH:MM\"). The planner re-plans by itself.",
      input_schema: { type: 'object', properties: { job: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, deadline: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'], additionalProperties: false },
      handler: (inp, ctx) => {
        if (!(ctx.state?.jobs || []).some(j => j.id === inp.job)) throw new Error(`no job ${inp.job}`);
        const n = (ctx.memory.get('plan.n') || 0) + 1;
        ctx.commit({ memory: { 'plan.n': n }, effects: [changePriority(ctx, inp, n)] });
        return { ok: true };
      },
    },
    {
      name: 'approve_late', kind: 'acts',
      description: 'Approve a late finish for a job.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'], additionalProperties: false },
      handler: ({ job, reason }, ctx) => {
        const n = (ctx.memory.get('plan.n') || 0) + 1;
        ctx.commit({ memory: { 'plan.n': n }, effects: [{ id: `plan:${n}:late:${job}`, spec: { kind: 'event', key: `job:${job}`, body: { type: 'priority_change', job, allowLate: true, note: reason, source: SRC } } }] });
        return { ok: true };
      },
    },
    {
      name: 'defer_job', kind: 'acts',
      description: 'Defer a job to tomorrow: it is dropped from today and recorded under plan.deferred so it is not lost.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, reason: { type: 'string' } }, required: ['job', 'reason'], additionalProperties: false },
      handler: ({ job, reason }, ctx) => {
        const j = (ctx.state?.jobs || []).find(x => x.id === job);
        if (!j) throw new Error(`no job ${job}`);
        const n = (ctx.memory.get('plan.n') || 0) + 1;
        const deferred = [...(ctx.memory.get('plan.deferred') || []), { ...j, reason, deferredAt: ctx.clock }];
        ctx.commit({ memory: { 'plan.n': n, 'plan.deferred': deferred }, effects: [{ id: `plan:${n}:defer:${job}`, spec: { kind: 'event', key: `job:${job}`, body: { type: 'cancel_job', job, note: `deferred to tomorrow: ${reason}`, source: SRC } } }] });
        return { ok: true };
      },
    },
  ],
};
