// "Ask the team": one question in plain words, answered by the agent (or two) whose job it is.
//   POST /ask { "question": "...", "agent": "weather" (optional) }     GET /ask?q=...&agent=...
// Rule-only, the answer is built by plain code from the live state and shared memory, so it works with
// no key and no network. With a model, the same facts go to the agent's own instructions and its
// read-only tools, and the model writes the answer. Asking never acts: no hold, recall, event or message
// is sent, and only tools marked kind: 'reads' are offered to the model.

const TOPICS = {
  weather: ['weather', 'wind', 'rain', 'storm', 'frost', 'freeze', 'heat', 'lightning', 'flood', 'forecast', 'inversion', 'drift', 'dust', 'smoke', 'hurricane', 'safe to spray', 'can i spray', 'can we spray'],
  fleet: ['tractor', 'fuel', 'battery', 'implement', 'sprayer', 'mower', 'tiller', 'seeder', 'fleet', 'machine', 'who can'],
  fault: ['fault', 'broke', 'breakdown', 'stuck', 'not moving', 'no response', 'out of service', 'telemetry', 'repair'],
  route: ['route', 'lane', 'coverage', 'pass', 'bridge', 'detour', 'path', 'how far'],
  depot: ['depot', 'inspection', 'refuel', 'fuelling', 'fueling', 'good to go', 'people', 'crew', 'worker', 'waiting'],
  safety: ['safe', 'safety', 'spacing', 'collision', 'too close', 'stop', 'hold', 'recall'],
  plan: ['plan', 'deadline', 'priority', 'late', 'schedule', 'defer', 'tomorrow', 'job', 'when will', 'at risk'],
  records: ['record', 'history', 'done today', 'summary', 'finished', 'completed', 'what happened', 'log'],
  agronomy: ['soil', 'crop', 'field', 'irrigat', 'water', 'fertili', 'pest', 'weed', 'disease', 'harvest', 'plant', 'seed', 'mow', 'hay', 'alfalfa', 'corn', 'wheat', 'soybean', 'orchard', 'till', 'spray', 'elevation', 'slope', 'drain', 'livestock', 'yield', 'agronom'],
};

export function route(question, names) {
  const q = ` ${String(question).toLowerCase()} `;
  return names.map(n => ({ n, score: (TOPICS[n] || []).reduce((s, w) => s + (q.includes(w) ? (w.includes(' ') ? 3 : 1) : 0), 0) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.n.localeCompare(b.n)).map(x => x.n);
}

const list = (a, n = 6) => (a.length > n ? `${a.slice(0, n).join('; ')}; and ${a.length - n} more` : a.join('; '));
const mem = (rt, k) => rt.memory.get(k)?.value;

// Plain-code answers per agent: sentences from the live state and that agent's shared memory.
const ANSWER = {
  weather(rt) {
    const s = mem(rt, 'weather.status'), r = mem(rt, 'weather.reading'), a = mem(rt, 'weather.actions');
    if (!s && !r) return { lines: ['The Weather Manager has no reading yet.'], facts: {} };
    const rd = r?.reading || {};
    const ok = v => typeof v === 'number' && Number.isFinite(v);
    const KEYS = [['t2C', v => `${v} °C at 2 m`], ['t10C', v => `${v} °C at 10 m`], ['wind2Mph', v => `wind ${v} mph at 2 m`], ['gustMph', v => `gusts ${v} mph`]];
    const nums = KEYS.filter(([k]) => ok(rd[k])).map(([k, f]) => f(rd[k]));
    const bad = KEYS.filter(([k]) => k in rd && !ok(rd[k])).map(([k]) => k);
    if (bad.length) nums.push(`no usable value for ${bad.join(', ')}`);
    return { facts: { status: s, reading: r, actions: a }, lines: [
      s ? `Weather level is ${s.level}${s.since ? ` since ${s.since}` : ''}.${s.summary ? ` ${s.summary}` : ''}${s.fired?.length ? ` Rules in force: ${s.fired.join(', ')}.` : ''}` : 'No weather decision has been made yet.',
      nums.length ? `Latest reading${r.clock ? ` at ${r.clock}` : ''}: ${nums.join(', ')}.${(r.alerts || []).filter(x => typeof x === 'string' && x).length ? ` Official alerts: ${r.alerts.filter(x => typeof x === 'string' && x).join(', ')}.` : ' No official alerts.'}` : null,
    ].filter(Boolean) };
  },
  fleet(rt) {
    const ts = rt.state?.tractors || [];
    return { facts: { tractors: ts.map(t => ({ id: t.id, state: t.state?.code, mounted: t.mounted, fuelPct: t.fuelPct, queue: t.queue })) },
      lines: [ts.length ? `Tractors: ${list(ts.map(t => `${t.id} is ${String(t.state?.code ?? 'unknown').toLowerCase().replace(/_/g, ' ')} with the ${t.mounted ?? 'no implement'} on and ${t.fuelPct ?? '?'}% fuel`))}.` : 'The live runner has reported no tractors.'] };
  },
  fault(rt) {
    const ev = x => (Array.isArray(x.evidence) ? x.evidence.map(e => e?.evidence).filter(Boolean).join('; ') : typeof x.evidence === 'string' ? x.evidence : '');
    const v = mem(rt, 'fault.verdicts') || {};
    const bad = Object.entries(v).filter(([, x]) => x?.verdict === 'out-of-service');
    return { facts: { verdicts: v }, lines: [bad.length ? `Looks out of service: ${list(bad.map(([id, x]) => `${id}${ev(x) ? ` (${ev(x)})` : ''}${x.since ? ` since ${x.since}` : ''}`))}. Only a person or the coordinator declares a breakdown.` : 'No tractor has a fault that has lasted three checks in a row.'] };
  },
  route(rt) {
    const j = mem(rt, 'route.jobs') || {};
    const withRoute = Object.entries(j).filter(([, x]) => x?.route);
    return { facts: { jobs: j }, lines: [withRoute.length ? `Routes: ${list(withRoute.map(([id, x]) => `${id} on ${x.field}: ${x.route.passes} passes, ${(x.route.lengthM / 1000).toFixed(1)} km`))}.` : `${Object.keys(j).length} job(s) started; the live runner has reported no coverage route for them.`] };
  },
  depot(rt) {
    const insp = (mem(rt, 'depot.inspections') || []).filter(i => i.status !== 'done'), tasks = rt.state?.tasks || [], paused = mem(rt, 'depot.paused');
    return { facts: { openInspections: insp, tasks, paused }, lines: [
      paused ? 'Depot work is paused: nobody should work there until it is safe.' : 'The depot is open for work.',
      tasks.length ? `Waiting for a person: ${list(tasks.map(t => `${t.tractor} ${t.kind}${t.since ? ` since ${t.since}` : ''}`))}.` : 'No tractor is waiting for a person.',
      insp.length ? `${insp.length} inspection(s) open: ${list(insp.map(i => i.what), 4)}. Only a person can mark one done.` : null,
    ].filter(Boolean) };
  },
  safety(rt) {
    const holds = rt.state?.holds || [], recalls = rt.state?.recalls || [], stop = mem(rt, 'safety.stop');
    return { facts: { holds, recalls, safetyStop: stop }, lines: [
      holds.length ? `Holds in force: ${list(holds.map(h => `${h.id} by ${h.by}${h.reason ? ` (${String(h.reason).slice(0, 90)})` : ''}`), 4)}.` : 'No hold is in force.',
      recalls.length ? `The fleet is recalled to the depot: ${list(recalls.map(r => `${r.id} by ${r.by}`))}.` : 'No recall is in force.',
      stop ? 'The Safety Officer\'s own stop is in force; only a person, or the officer once tractors are apart, can lift it.' : null,
    ].filter(Boolean) };
  },
  plan(rt) {
    const jobs = rt.state?.jobs || [], by = s => jobs.filter(j => j.status === s);
    const def = mem(rt, 'plan.deferred') || [], risk = mem(rt, 'plan.atRisk') || [];
    const ids = a => a.map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
    return { facts: { jobs, deferred: def, atRisk: risk }, lines: [
      `Plan clock ${rt.state?.clock ?? 'unknown'}: ${by('done').length} of ${jobs.length} job(s) done, ${by('active').length} running, ${jobs.length - by('done').length - by('active').length} waiting.`,
      by('active').length ? `Running now: ${list(by('active').map(j => `${j.id} ${j.type} on ${j.field}${j.pct != null ? ` (${j.pct}%)` : ''}, due ${j.deadline}`))}.` : null,
      ids(risk).length ? `At risk of finishing late: ${ids(risk).join(', ')}.` : null,
      ids(def).length ? `Deferred to tomorrow: ${ids(def).join(', ')}.` : null,
    ].filter(Boolean) };
  },
  records(rt) {
    const jobs = mem(rt, 'records.jobs') || [], stops = mem(rt, 'records.stops') || [];
    return { facts: { jobs, stops }, lines: [`The day record has ${jobs.length} finished job(s) and ${stops.length} stop(s) so far.${jobs.length ? ` Finished: ${list(jobs.map(j => j.id ?? j.label ?? '?'))}.` : ''}`] };
  },
};

export async function ask(rt, { question, agent } = {}) {
  question = String(question ?? '').trim().slice(0, 600);
  if (!question) return { ok: false, error: 'question is required' };
  const names = rt.agents.map(a => a.name);
  if (agent && !names.includes(agent)) return { ok: false, error: `no agent ${agent}`, agents: names };
  const routed = agent ? [agent] : route(question, names).slice(0, 2);
  const covers = rt.agents.map(a => `${a.displayName} (${a.mod.job || a.name})`).join('; ');
  if (!routed.length) return { ok: true, question, answeredBy: [], mode: 'rules', routed: 'no agent covers this', text: `No agent on this team covers that. The team is: ${covers}.`, facts: {} };

  const parts = [];
  for (const name of routed) {
    const a = rt.agents.find(x => x.name === name);
    let rule;
    try { rule = a.mod.answer ? a.mod.answer(rt.context(a, null), question) : (ANSWER[name] ? ANSWER[name](rt, question) : { lines: [`${a.displayName}: ${a.mod.job || 'no summary available'}.`], facts: {} }); }
    catch (e) { rule = { lines: [`${a.displayName} could not read its facts (${e.message}).`], facts: {} }; }
    let text = rule.lines.join(' '), mode = 'rules', modelError = null;
    if (rt.model.available()) {
      try {
        const ctx = rt.context(a, { id: `${name}-ask`, toolSeq: 0, toolCalls: 0, sent: 0, caller: 'ask' });
        const reads = rt.allTools(a).filter(t => t.kind === 'reads' && t.modelMay !== false);
        const out = await rt.model.run({
          system: `${a.instructions}\n\nSomeone is asking you a question directly. Answer it in at most four plain sentences, from the facts given and your read-only tools. Keep every name and number exactly as given. If the facts do not answer it, say what is not known and who decides it. You cannot act from here: do not say you have done or will do anything.`,
          tools: reads, prompt: `Question: ${question}\n\nFacts from plain code:\n${JSON.stringify({ summary: rule.lines, facts: rule.facts }).slice(0, 6000)}`,
          callTool: (n, i) => (reads.some(t => t.name === n) ? rt.callTool(a, ctx, n, i) : { error: `${n} is not available when answering a question` }),
        });
        if (out.text) { text = out.text; mode = 'model'; }
      } catch (e) { modelError = e.message; }          // the rule-only answer stands
    }
    parts.push({ agent: name, displayName: a.displayName, mode, text, modelError, facts: rule.facts });
  }
  return {
    ok: true, question, clock: rt.state?.clock ?? null,
    answeredBy: parts.map(p => p.displayName), mode: parts.some(p => p.mode === 'model') ? 'model' : 'rules',
    routed: agent ? 'asked by name' : 'by topic',
    text: parts.map(p => (parts.length > 1 ? `${p.displayName}: ${p.text}` : p.text)).join('\n'),
    parts,
  };
}
