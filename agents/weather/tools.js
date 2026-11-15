// Weather Manager: what the weather allows the fleet to do, now, today and tomorrow, and days ahead.
// The playbook (playbook.json, with sources) decides; plain code acts at once (holds, recall, closed
// bridges); the model only writes the words and may ask the Plan Manager to reprioritise.
import { fire, decide, derive, sourceTag, ruleById, authorized, RISK, PLAYBOOK } from './playbook.js';
import { makeFeed } from './feed.js';

export const MEMORY_KEYS = {
  status: 'weather.status',    // { level: Go|Caution|Stop|Recall, fired: [ruleIds], since, summary }
  reading: 'weather.reading',  // latest snapshot { clock, minute, reading, forecast, alerts }
  actions: 'weather.actions',  // what this agent has placed: { n, sig, holds, recall, blocks, advisories, requests }
  episode: 'weather.episode',  // open after-flood / after-storm inspection round
};
const BY = 'Weather Manager';
const RECENT = 10;
const SCALE = { now: 'Now', today: 'Today and tomorrow', days: 'Days ahead' };

const feeds = new WeakMap();
function feedFor(config) { if (!feeds.has(config)) feeds.set(config, makeFeed(config)); return feeds.get(config); }

function inputs(ctx) {
  const st = ctx.agentState;
  const snap = st.latest;
  if (!snap) return null;
  const minutesSinceLightning = st.lastLightningMinute == null ? null : snap.minute - st.lastLightningMinute;
  return { reading: snap.reading, forecast: snap.forecast || {}, alerts: snap.alerts || [], derived: derive(snap.reading, { minutesSinceLightning }), history: st.history || {} };
}

function inspectionsList(ctx) { return ctx.memory.get('depot.inspections') || []; }

function evaluateNow(ctx) {
  const inp = inputs(ctx);
  if (!inp) return null;
  const fired = fire(inp);
  let episode = ctx.memory.get(MEMORY_KEYS.episode) || null;
  // An "after" rule that has just fired keeps everything in place from the same minute,
  // before the Depot Manager has even opened the inspections.
  const after = fired.find(f => f.authorized && f.rule.actions.includes('inspections'));
  const provisional = after && (!episode || episode.closed || episode.rule !== after.id);
  if (provisional) episode = { id: 'pending', rule: after.id, items: inspectionItems(after.id, ctx), closed: false };
  const decision = decide(fired, { episode, inspections: inspectionsList(ctx) });
  return { inp, fired, decision, episode, provisional };
}

function signature(d, fired) {
  return JSON.stringify({
    holds: Object.values(d.holds).map(h => [h.id, h.jobTypes, h.fields]).sort(),
    recall: !!d.recall, blocks: !!d.blocks,
    adv: d.advisories.map(f => f.id).sort(),
    req: d.requests.map(r => r.kind + ':' + r.rule).sort(), depot: d.depot.map(r => r.kind).sort(),
    inspect: d.inspect?.id ?? null, fired: fired.map(f => f.id).sort(),
  });
}

function levelOf(d) {
  if (d.recall) return 'Recall';
  if (Object.keys(d.holds).length) return 'Stop';
  if (d.advisories.length) return 'Caution';
  return 'Go';
}

const simulated = inp => ['simulated', 'script'].includes(inp.reading?.source) ? ' (simulated weather)' : '';
const workName = h => (h.jobTypes.includes('*') ? 'all work' : `${h.jobTypes.join(', ')} work`) + (h.fields ? ` in ${h.fields.join(', ')}` : '');

// The fast path: bring holds, recall and bridge closures in line with the playbook, at once.
// Returns the statements for the roundtable (the model may write their words; templates otherwise).
function reconcile(ctx) {
  const ev = evaluateNow(ctx);
  if (!ev) return { statements: [] };
  const { inp, fired, decision: d } = ev;
  const prev = ctx.memory.get(MEMORY_KEYS.actions) || { n: 0, sig: null, holds: {}, recall: null, blocks: null, advisories: [], requests: [], depot: [] };
  const sig = signature(d, fired);
  if (sig === prev.sig) return { statements: [] };
  const n = prev.n + 1;
  const effects = [], did = [];
  // Holds: place new or changed ones; lift only holds this agent placed (ids it recorded).
  for (const h of Object.values(d.holds)) {
    const old = prev.holds[h.id];
    if (!old || JSON.stringify([old.jobTypes, old.fields]) !== JSON.stringify([h.jobTypes, h.fields])) {
      effects.push({ id: `wm:t${n}:hold:${h.id}`, spec: { kind: 'hold', key: `hold:${h.id}`, body: { id: h.id, jobTypes: h.jobTypes, fields: h.fields, reason: `${h.reason} [rule ${h.rules.join(', ')}]`, by: BY, ruleId: h.rules[0] } } });
      did.push(`holding ${workName(h)}`);
    }
  }
  for (const id of Object.keys(prev.holds)) if (!d.holds[id]) {
    effects.push({ id: `wm:t${n}:lift:${id}`, spec: { kind: 'unhold', key: `hold:${id}`, holdId: id } });
    did.push(`lifting the hold on ${workName(prev.holds[id])}`);
  }
  if (d.recall && !prev.recall) {
    effects.push({ id: `wm:t${n}:recall`, spec: { kind: 'recall', key: 'recall', body: { id: d.recall.id, reason: `${d.recall.reason} [rule ${d.recall.rules.join(', ')}]`, by: BY } } });
    did.push('recalling the fleet to the depot');
  } else if (!d.recall && prev.recall) {
    effects.push({ id: `wm:t${n}:end-recall`, spec: { kind: 'unrecall', key: 'recall', recallId: prev.recall.id } });
    did.push('ending the recall');
  }
  if (d.blocks && !prev.blocks) {
    for (const b of d.blocks.bridges) effects.push({ id: `wm:t${n}:block:${b.name}`, spec: { kind: 'event', key: `route:${b.name}`, body: { type: 'block_route', name: b.name, cells: b.cells, note: `closed by the Weather Manager [rule ${d.blocks.rules.join(', ')}]`, source: 'weather', signal: d.blocks.rules.join(', ') } } });
    did.push(`closing ${d.blocks.bridges.map(b => b.name).join(' and ')}`);
  } else if (!d.blocks && prev.blocks) {
    for (const b of prev.blocks.bridges) effects.push({ id: `wm:t${n}:unblock:${b.name}`, spec: { kind: 'event', key: `route:${b.name}`, body: { type: 'unblock_route', name: b.name, cells: b.cells, note: 'reopened after inspection', source: 'weather' } } });
    did.push(`reopening ${prev.blocks.bridges.map(b => b.name).join(' and ')}`);
  }

  const statements = [];
  const acting = [...new Set([...Object.values(d.holds).flatMap(h => h.rules), ...(d.recall?.rules || []), ...(d.blocks?.rules || [])])];
  const actingFired = fired.filter(f => acting.includes(f.id));
  const lead = actingFired.sort((a, b) => b.rule.actions.length - a.rule.actions.length)[0];
  const tagIds = acting.length ? acting : prev.lastActing || [];
  if (did.length) {
    const why = lead ? lead.text : (d.recall?.reason || Object.values(d.holds)[0]?.reason || 'The weather rules that required it no longer apply.');
    const scale = SCALE[lead?.rule.scale || 'now'];
    const conflict = d.conflict ? ` Rules ${d.conflict.rules.join(' and ')} both apply; the more cautious wins (${d.conflict.chosen}).` : '';
    const Did = did.join(', ').replace(/^./, c => c.toUpperCase());
    const sentence = `${scale}: ${Did}.${conflict} ${why}`;
    statements.push({ to: 'plan', type: levelOf(d).toLowerCase(), template: sentence, tag: `[rule ${sourceTag(tagIds)}]${simulated(inp)}`, facts: { did, why, rules: tagIds, conflict: d.conflict, readings: inp.reading, alerts: inp.alerts } });
  }
  // Advice: new advisory rules only (unverified rules can only ever get here).
  const newAdv = d.recall ? [] : d.advisories.filter(f => !prev.advisories.includes(f.id) && !(f.authorized && acting.includes(f.id))); // during a recall, advice adds nothing
  if (newAdv.length) {
    const f = newAdv[0];
    const extra = newAdv.length > 1 ? ` Also: ${newAdv.slice(1).map(x => x.text).join(' ')}` : '';
    statements.push({ to: 'operator', type: 'caution', template: `${SCALE[f.rule.scale]}: Caution. ${f.text}${extra}`, tag: `[rule ${sourceTag(newAdv.map(x => x.id))}]${simulated(inp)}`, facts: { advice: newAdv.map(x => ({ rule: x.id, text: x.text, verified: x.authorized })) } });
  }
  // Requests to the agents that own the decision.
  for (const r of d.requests.filter(r => !prev.requests.includes(r.kind + ':' + r.rule))) {
    if (r.kind === 'fuel_all') statements.push({ to: 'fleet', type: 'request', template: `Please have every tractor fuelled while it is safe: ${r.text}`, tag: `[rule ${sourceTag([r.rule])}]`, data: { kind: 'fuel_all', rule: r.rule }, facts: r });
    else statements.push({ to: 'plan', type: 'request', template: `${r.kind === 'reprioritise_low_fields' ? `Please bring work on ${RISK.lowFields.join(', ')} forward.` : r.kind === 'reprioritise_harvest' ? 'Please bring harvesting of what is ready forward.' : 'Please reprioritise protective jobs.'} ${r.text}`, tag: `[rule ${sourceTag([r.rule])}]`, data: { kind: r.kind, direction: 'forward', fields: r.kind === 'reprioritise_low_fields' ? RISK.lowFields : null, jobTypes: r.kind === 'reprioritise_harvest' ? ['mow'] : null, rule: r.rule }, facts: r });
  }
  for (const r of d.depot.filter(r => !(prev.depot || []).includes(r.kind))) {
    statements.push({ to: 'depot', type: r.kind === 'no_depot_tasks' ? 'stop' : 'request', template: r.kind === 'no_depot_tasks' ? `Nobody works at the depot until further notice: ${r.text}` : r.kind === 'secure_depot' ? `Please have people secure fuel and chemicals at the depot: ${r.text}` : `Please move fuelling and re-fitting to cooler hours: ${r.text}`, tag: `[rule ${sourceTag([r.rule])}]`, data: { kind: r.kind, rule: r.rule }, facts: r });
  }
  // A new after-flood / after-storm round: open inspections through the Depot Manager.
  let episodeMem = {};
  const episode = ctx.memory.get(MEMORY_KEYS.episode);
  if (d.inspect && ev.provisional) {
    const items = ev.episode.items;
    const ep = { id: `ep${n}`, rule: d.inspect.id, items, opened: ctx.clock, closed: false };
    episodeMem = { [MEMORY_KEYS.episode]: ep };
    statements.push({ to: 'depot', type: 'inspect', template: `${d.inspect.text} Please open ${items.length} inspections for people: ${items.map(i => i.what).join('; ')}.`, tag: `[rule ${sourceTag([d.inspect.id])}]${simulated(inp)}`, data: { kind: 'inspections', episode: ep.id, items }, facts: { rule: d.inspect.id, items } });
  }
  const placedHolds = Object.fromEntries(Object.values(d.holds).map(h => [h.id, { id: h.id, jobTypes: h.jobTypes, fields: h.fields, rules: h.rules }]));
  const status = { level: levelOf(d), fired: fired.map(f => f.id), since: ctx.clock, summary: statements[0]?.template ?? prev.summary ?? null };
  ctx.commit({
    memory: {
      [MEMORY_KEYS.actions]: { n, sig, holds: placedHolds, recall: d.recall ? { id: d.recall.id, rules: d.recall.rules } : null, blocks: d.blocks ? { bridges: d.blocks.bridges, rules: d.blocks.rules } : null, advisories: d.advisories.map(f => f.id), requests: d.requests.map(r => r.kind + ':' + r.rule), depot: d.depot.map(r => r.kind), lastActing: acting.length ? acting : prev.lastActing || [], summary: status.summary },
      [MEMORY_KEYS.status]: status,
      ...episodeMem,
    },
    effects,
  });
  ctx.journal({ kind: 'decision', clock: ctx.clock, fired: fired.map(f => ({ id: f.id, authorized: f.authorized })), did, level: status.level, conflict: d.conflict, reading: inp.reading, alerts: inp.alerts });
  return { statements, summary: did.join(', ') || (statements.length ? 'spoke' : 'no change') };
}

function inspectionItems(ruleId, ctx) {
  const tractors = (ctx.state?.tractors || []).map(t => t.id);
  const machines = (tractors.length ? tractors : ['every tractor']).map(id => ({ key: `machine:${id}`, kind: 'machine', what: `Inspect tractor ${id}`, where: 'depot' }));
  const bridges = RISK.bridges.map(b => ({ key: `bridge:${b.name}`, kind: 'bridge', what: `Inspect ${b.name}`, where: b.name }));
  if (ruleId === 'after-flood') {
    return [...machines, ...bridges, ...RISK.lowFields.map(f => ({ key: `field:${f}`, kind: 'field', what: `Inspect ${f} for flood damage; do not harvest food crops that touched flood water until cleared`, where: f }))];
  }
  const fields = (ctx.farm?.fields?.map(f => f.name) || RISK.fields);
  return [...machines, ...RISK.lanes.map(l => ({ key: `lane:${l}`, kind: 'lane', what: `Inspect ${l}`, where: l })), ...bridges, ...fields.map(f => ({ key: `field:${f}`, kind: 'field', what: `Inspect ${f}`, where: f }))];
}

export default {
  displayName: 'Weather Manager',
  job: 'What the weather allows, now and over the coming days',
  schedule: { everyPlanMinutes: 60 },

  // Cheap, every poll: one snapshot per new plan minute; fire when the playbook's decision changes.
  async sense(ctx) {
    const minute = ctx.minute;
    if (minute == null) return null;
    const st = ctx.agentState;
    const last = st.lastMinute;
    if (last != null && minute === last) return this.changed(ctx);
    const from = last == null || minute < last || minute - last > 30 ? minute : last + 1;
    const feed = feedFor(ctx.config);
    let snap = null, lastLightningMinute = st.lastLightningMinute ?? null, history = { ...(st.history || {}) }, prevFired = st.prevFired || [];
    const recent = [...(st.recent || [])];
    for (let m = from; m <= minute; m++) {
      const v = await feed(m, ctx);
      if (!v) continue;
      snap = { clock: m === minute ? ctx.clock : null, minute: m, ...v };
      if (typeof v.reading.lightningMi === 'number' && v.reading.lightningMi <= 10) lastLightningMinute = m;
      // Phase memory for the "after" rules.
      const inp = { reading: v.reading, forecast: v.forecast || {}, alerts: v.alerts || [], derived: derive(v.reading, { minutesSinceLightning: lastLightningMinute == null ? null : m - lastLightningMinute }), history };
      const ids = fire(inp).map(f => f.id);
      if (prevFired.includes('flood-warning') && !ids.includes('flood-warning')) history.floodEnded = true;
      if ((prevFired.includes('tropical-warning') || prevFired.includes('storm-conditions')) && !ids.includes('tropical-warning') && !ids.includes('storm-conditions')) history.stormEnded = true;
      prevFired = ids;
      ctx.journal({ kind: 'reading', minute: m, clock: snap.clock, ...v, fired: ids });
      recent.push(snap); if (recent.length > RECENT) recent.shift();
      ctx.sensed++;
    }
    if (!snap) return null;
    // An inspection round that is finished closes its episode, so the "after" rule stops firing.
    const ep = ctx.memory.get(MEMORY_KEYS.episode);
    if (ep && !ep.closed) {
      const insp = inspectionsList(ctx);
      if (ep.items.every(it => insp.find(x => x.key === it.key)?.status === 'done')) {
        ctx.commit({ memory: { [MEMORY_KEYS.episode]: { ...ep, closed: true, closedAt: ctx.clock } } });
        if (ep.rule === 'after-flood') history.floodEnded = false;
        if (ep.rule === 'after-storm') history.stormEnded = false;
      }
    }
    ctx.saveState({ lastMinute: minute, latest: snap, recent, lastLightningMinute, history, prevFired });
    ctx.commit({ memory: { [MEMORY_KEYS.reading]: { clock: snap.clock, minute: snap.minute, reading: snap.reading, forecast: snap.forecast, alerts: snap.alerts } } });
    return this.changed(ctx);
  },

  changed(ctx) {
    const ev = evaluateNow(ctx);
    if (!ev) return null;
    const prev = ctx.memory.get(MEMORY_KEYS.actions);
    return signature(ev.decision, ev.fired) !== prev?.sig ? `playbook decision changed (${ev.fired.map(f => f.id).join(', ') || 'no rule fires'})` : null;
  },

  plan(ctx, { reason, inbox }) {
    const ev = evaluateNow(ctx);
    if (!ev) return null;
    const prev = ctx.memory.get(MEMORY_KEYS.actions);
    if (signature(ev.decision, ev.fired) === prev?.sig && !inbox.length) return null;
    const lines = [`Plan clock: ${ctx.clock}. Wake reason: ${reason}.`, `Rules firing: ${ev.fired.map(f => `${f.id}${f.authorized ? '' : ' (advice only)'}`).join(', ') || 'none'}.`];
    if (inbox.length) lines.push('Messages for you:', ...inbox.map(m => `- from ${m.from} (${m.type}): ${m.text}`));
    lines.push('The fast path has already placed or lifted holds, the recall and bridge closures. Write the words for each statement. You may call request_reprioritise if a job should move; the Plan Manager decides.');
    return { prompt: lines.join('\n') };
  },

  act(ctx) { return reconcile(ctx); },

  tools: [
    {
      name: 'get_readings', kind: 'reads',
      description: 'Latest temperature and wind at 2 m and 10 m, gusts, lightning distance and gauges, with time and whether simulated.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => { const s = ctx.agentState.latest; return s ? { clock: s.clock, minute: s.minute, ...s.reading } : { unavailable: true }; },
    },
    {
      name: 'get_forecast', kind: 'reads',
      description: 'The forecast for the coming hours (rain timing).',
      input_schema: { type: 'object', properties: { hours: { type: 'number' } }, additionalProperties: false },
      handler: (_, ctx) => ctx.agentState.latest?.forecast ?? { unavailable: true },
    },
    {
      name: 'get_alerts', kind: 'reads',
      description: 'Official alerts in force (watch, warning, all-clear), simulated or from the weather service.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => ({ alerts: ctx.agentState.latest?.alerts ?? [], source: ctx.agentState.latest?.reading?.source ?? null }),
    },
    {
      name: 'evaluate_playbook', kind: 'reads',
      description: 'Which playbook rules fire now, each with rule id, phase, time scale, the filled explanation, whether it is verified, and its sources. Also what the fleet must do.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => {
        const ev = evaluateNow(ctx);
        if (!ev) return { unavailable: true };
        return {
          fired: ev.fired.map(f => ({ id: f.id, hazard: f.rule.hazard, phase: f.rule.phase, scale: f.rule.scale, explain: f.text, verified: f.authorized, sources: f.rule.source })),
          mustDo: { holds: Object.values(ev.decision.holds).map(h => ({ id: h.id, work: workName(h), rules: h.rules })), recall: ev.decision.recall, bridgesClosed: !!ev.decision.blocks, conflict: ev.decision.conflict },
        };
      },
    },
    {
      name: 'log_reading', kind: 'acts',
      description: 'Append a note about the current reading to the time-stamped weather log.',
      input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
      handler: ({ note }, ctx) => { ctx.journal({ kind: 'note', clock: ctx.clock, note: String(note).slice(0, 300), by: ctx.run?.caller }); return { ok: true }; },
    },
    {
      name: 'place_hold', kind: 'acts',
      description: 'Stop a kind of work. Refused unless the named rule is verified and firing now; the fast path normally does this already.',
      input_schema: { type: 'object', properties: { ruleId: { type: 'string' } }, required: ['ruleId'], additionalProperties: false },
      handler: ({ ruleId }, ctx) => {
        const r = ruleById(ruleId);
        if (!r) throw new Error(`no rule ${ruleId} in the playbook`);
        if (!authorized(r)) throw new Error(`refused: rule ${ruleId} has no verified source, so it can only advise`);
        if (!evaluateNow(ctx)?.fired.some(f => f.id === ruleId)) throw new Error(`refused: rule ${ruleId} does not fire now`);
        return { ok: true, note: 'the rule is in force; its hold is placed by the fast path', did: reconcile(ctx).summary };
      },
    },
    {
      name: 'lift_hold', kind: 'acts',
      description: 'Lift a hold. Only holds this agent placed, and only when no rule requires them any more.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      handler: ({ id }, ctx) => {
        const mine = ctx.memory.get(MEMORY_KEYS.actions)?.holds || {};
        if (!mine[id]) throw new Error(`refused: hold ${id} was not placed by the Weather Manager`);
        if (evaluateNow(ctx)?.decision.holds[id]) throw new Error(`refused: rules ${evaluateNow(ctx).decision.holds[id].rules.join(', ')} still require hold ${id}`);
        return { ok: true, did: reconcile(ctx).summary };
      },
    },
    {
      name: 'recall_fleet', kind: 'acts',
      description: 'Recall every tractor to the depot. Refused unless the named rule is verified, firing now and calls for a recall.',
      input_schema: { type: 'object', properties: { ruleId: { type: 'string' } }, required: ['ruleId'], additionalProperties: false },
      handler: ({ ruleId }, ctx) => {
        const r = ruleById(ruleId);
        if (!authorized(r) || !r.actions.includes('recall')) throw new Error(`refused: rule ${ruleId} is not a verified recall rule`);
        if (!evaluateNow(ctx)?.fired.some(f => f.id === ruleId)) throw new Error(`refused: rule ${ruleId} does not fire now`);
        return { ok: true, did: reconcile(ctx).summary };
      },
    },
    {
      name: 'end_recall', kind: 'acts',
      description: 'End this agent\'s recall. Refused while any rule or open inspection still requires it.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => {
        if (!ctx.memory.get(MEMORY_KEYS.actions)?.recall) throw new Error('refused: the Weather Manager has no recall in force');
        const d = evaluateNow(ctx)?.decision;
        if (d?.recall) throw new Error(`refused: ${d.recall.rules.join(', ')} still require the recall`);
        return { ok: true, did: reconcile(ctx).summary };
      },
    },
    {
      name: 'request_reprioritise', kind: 'acts',
      description: 'Ask the Plan Manager to bring a job forward or push it back. The Plan Manager decides.',
      input_schema: { type: 'object', properties: { job: { type: 'string' }, direction: { type: 'string', enum: ['forward', 'back'] }, reason: { type: 'string' } }, required: ['job', 'direction', 'reason'], additionalProperties: false },
      handler: ({ job, direction, reason }, ctx) => ({ ok: true, id: ctx.sendMessage('plan', 'request', `Please move ${job} ${direction}: ${reason}`, { data: { kind: 'reprioritise', job, direction } }) }),
    },
  ],
};

export { PLAYBOOK };
