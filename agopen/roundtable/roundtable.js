// Roundtable of AI managers: a short, visible, asynchronous discussion per event.
// Never blocks the fast rule-based path; never throws out of convene().
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const DIR = new URL('./agents/', import.meta.url);
const CHAIR = 'plan-manager';
const MAX_TOOLS = 2;
const MAX_WAITING = 3;
const DEFAULT_MODEL = 'claude-haiku-5-5';

const SPEAKERS = {
  fault: ['fault-manager', 'fleet-manager', 'safety-officer', CHAIR],
  replan: ['route-manager', 'fleet-manager', CHAIR],
  'new-jobs': ['route-manager', 'fleet-manager', CHAIR],
  'day-start': ['route-manager', 'fleet-manager', CHAIR],
  'service-request': ['depot-manager', 'fleet-manager', CHAIR],
  'service-done': ['depot-manager', 'fleet-manager', CHAIR],
  hold: ['weather-manager', 'fleet-manager', CHAIR],
  'hold-lifted': ['weather-manager', 'fleet-manager', CHAIR],
  'job-done': ['fleet-manager'],
  recovered: ['fault-manager', CHAIR],
};

export function loadAgents() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = fs.readFileSync(new URL(f, DIR), 'utf8');
    const id = f.replace(/\.md$/, '');
    const name = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || id;
    const role = (text.match(/^Role:\s*(.+)$/m) || [])[1]?.trim() || '';
    return { id, name, role, prompt: text };
  });
}

export function credentialPresent(env = process.env) {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

// ---- rule-written fallback lines ------------------------------------------
const pick = (f, ...keys) => { for (const k of keys) if (f?.[k] != null && f[k] !== '') return f[k]; return undefined; };
function tractorOf(f) { return pick(f, 'tractor', 'tractorId', 'id', 'vehicle'); }
function brief(f) {
  const parts = Object.entries(f || {}).filter(([, v]) => v == null || typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k} ${v}`);
  return parts.join(', ');
}

function fallbackText(agentId, { type, title, facts }) {
  const f = facts || {};
  const t = tractorOf(f);
  const T = t ?? 'The fleet';
  const where = pick(f, 'field', 'job', 'jobId', 'location');
  const w = where ? ` on ${where}` : '';
  const gen = `${title || type}${brief(f) ? ': ' + brief(f) : ''}.`;
  switch (agentId) {
    case 'fault-manager':
      if (type === 'recovered') return `${T} has recovered${pick(f, 'signal') ? `: ${f.signal}` : ''}, back in service${w}.`;
      return `${T} reported ${pick(f, 'kind', 'fault') ?? 'a fault'}${pick(f, 'signal', 'symptom') ? `: ${pick(f, 'signal', 'symptom')}` : ''}.`;
    case 'fleet-manager': {
      const bits = [pick(f, 'state') && `state ${f.state}`, pick(f, 'fuel') != null && `fuel ${f.fuel}`, pick(f, 'implement') && `implement ${f.implement}`].filter(Boolean);
      const tail = bits.length ? `: ${bits.join(', ')}` : '';
      if (type === 'fault') return `${T} is affected${tail || ''}; the other tractors carry on.`;
      if (type === 'job-done') return `${T} finished${where ? ' ' + where : ' its job'}${tail} and is free.`;
      return `${T}${tail || ` is in the picture for ${title || type}`}.`;
    }
    case 'safety-officer':
      return `${T} is flagged${pick(f, 'kind') ? ` for ${f.kind}` : ''}; keep other tractors clear of it until it is checked.`;
    case 'route-manager':
      return `Routes updated for ${title || type}${t ? ` involving ${t}` : ''}${w}${pick(f, 'lanes') != null ? `, ${f.lanes} lanes` : ''}.`;
    case 'depot-manager':
      if (type === 'service-done') return `Depot work for ${T} is done; waiting for a person to release it.`;
      return `${T} is requested at the depot${pick(f, 'work', 'service', 'kind') ? ` for ${pick(f, 'work', 'service', 'kind')}` : ''}; it stays locked until a person releases it.`;
    case 'weather-manager':
      if (type === 'hold-lifted') return `The hold is lifted${pick(f, 'reason') ? ` (${f.reason})` : ''}; spraying may resume.`;
      return `Spraying is held${pick(f, 'reason', 'wind', 'rain') != null ? `: ${pick(f, 'reason', 'wind', 'rain')}` : ''}.`;
    case CHAIR:
      return `${gen} Rule-based planner has already adjusted the plan; no further action.`;
    default:
      return gen;
  }
}

// ---- engine ---------------------------------------------------------------
export function createRoundtable({ say, tools = {}, model, timeoutMs = 6000, enabled, _client } = {}) {
  const agents = loadAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const modelId = model || process.env.ROUNDTABLE_MODEL || DEFAULT_MODEL;
  const useModel = enabled ?? (!!_client || credentialPresent());
  let client = _client || null;
  const getClient = () => (client ||= new Anthropic({ maxRetries: 0, timeout: timeoutMs + 2000 }));

  const st = { topics: 0, lines: 0, modelCalls: 0, fallbacks: 0, toolCalls: 0, dropped: 0, lastError: null };
  let msSum = 0, msN = 0, lineSeq = 0, topicSeq = 0;
  const waiting = [];
  let running = false;

  const emit = (topicId, a, text, kind, ms, mdl) => {
    st.lines++;
    const line = { id: `l${++lineSeq}`, topicId, agent: a.id, role: a.name, text, kind, ms: Math.round(ms || 0), model: mdl ?? null };
    try { say?.(line); } catch (e) { st.lastError = String(e?.message || e); }
    return line;
  };

  async function call(params) {
    st.modelCalls++;
    const ac = new AbortController();
    let timer;
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        getClient().messages.create({ model: modelId, max_tokens: 200, thinking: { type: 'disabled' }, ...params }, { signal: ac.signal }),
        new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error(`model call timed out after ${timeoutMs}ms`)); }, timeoutMs); }),
      ]);
      const ms = Date.now() - t0;
      msSum += ms; msN++;
      return { res, ms };
    } finally { clearTimeout(timer); }
  }

  const textOf = (res) => (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  const fallback = (topicId, a, topic, ms = 0) => {
    st.fallbacks++;
    return emit(topicId, a, fallbackText(a.id, topic), 'fallback', ms, null);
  };
  const fail = (e) => { st.lastError = String(e?.message || e); };

  function userMsg(topic, others) {
    let s = `Event: ${topic.type} - ${topic.title ?? ''}\nFacts: ${JSON.stringify(topic.facts ?? {})}\n`;
    if (others) s += `Managers said:\n${others.map((o) => `- ${o.role}: ${o.text}`).join('\n')}\n`;
    return s + (others ? 'Give your decision in one or two short sentences, at most 40 words. Call a tool only if it is needed.' : 'Reply in one or two short sentences, at most 35 words.');
  }

  async function speakWorker(topicId, a, topic) {
    if (!useModel) return fallback(topicId, a, topic);
    const t0 = Date.now();
    try {
      const { res, ms } = await call({ system: a.prompt, messages: [{ role: 'user', content: userMsg(topic) }] });
      const text = textOf(res);
      if (!text) throw new Error('empty model reply');
      return emit(topicId, a, text, 'says', ms, res.model || modelId);
    } catch (e) { fail(e); return fallback(topicId, a, topic, Date.now() - t0); }
  }

  async function speakChair(topicId, a, topic, said) {
    if (!useModel) return fallback(topicId, a, topic);
    const toolDefs = Object.entries(tools).map(([name, t]) => ({ name, description: t.description || name, input_schema: t.input_schema || { type: 'object', properties: {} } }));
    const messages = [{ role: 'user', content: userMsg(topic, said) }];
    const t0 = Date.now();
    let used = 0;
    try {
      for (let turn = 0; turn < 4; turn++) {
        const { res, ms } = await call({ system: a.prompt, messages, ...(toolDefs.length ? { tools: toolDefs } : {}) });
        const uses = (res.content || []).filter((b) => b.type === 'tool_use');
        if (!uses.length) {
          const text = textOf(res);
          if (!text) throw new Error('empty model reply');
          emit(topicId, a, text, 'decision', ms, res.model || modelId);
          return;
        }
        messages.push({ role: 'assistant', content: res.content });
        const results = [];
        for (const u of uses) {
          const def = tools[u.name];
          let out, isErr = false, label;
          const t1 = Date.now();
          if (!def) { out = `unknown tool ${u.name}`; isErr = true; label = `refused ${u.name}: unknown tool`; }
          else if (used >= MAX_TOOLS) { out = 'refused: at most two tool calls per discussion'; isErr = true; label = `refused ${u.name}: limit of two tool calls`; }
          else {
            used++; st.toolCalls++;
            try { out = await def.handler(u.input); label = `called ${u.name}: ${oneLine(out)}`; }
            catch (e) { out = `error: ${e?.message || e}`; isErr = true; label = `${u.name} failed: ${e?.message || e}`; fail(e); }
          }
          emit(topicId, a, `Plan Manager ${label}`, 'tool', Date.now() - t1, null);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out ?? null), ...(isErr ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      throw new Error('chair did not finish');
    } catch (e) { fail(e); fallback(topicId, a, topic, Date.now() - t0); }
  }

  function oneLine(r) {
    const s = typeof r === 'string' ? r : (r && (r.summary || r.message)) || JSON.stringify(r ?? 'ok');
    const x = String(s).replace(/\s+/g, ' ');
    return x.length > 140 ? x.slice(0, 137) + '...' : x;
  }

  async function run(topic, topicId) {
    st.topics++;
    const ids = (Array.isArray(topic.who) && topic.who.length ? topic.who : SPEAKERS[topic.type] || [CHAIR]).filter((id) => byId.has(id));
    const workers = ids.filter((id) => id !== CHAIR).map((id) => byId.get(id));
    const said = (await Promise.all(workers.map((a) => speakWorker(topicId, a, topic)))).filter(Boolean);
    if (ids.includes(CHAIR)) await speakChair(topicId, byId.get(CHAIR), topic, said);
  }

  async function pump() {
    if (running) return;
    running = true;
    while (waiting.length) {
      const { topic, done } = waiting.shift();
      try { await run(topic, `t${++topicSeq}`); } catch (e) { fail(e); }
      done();
    }
    running = false;
  }

  function convene(topic) {
    return new Promise((resolve) => {
      try {
        if (!topic || typeof topic !== 'object') { st.lastError = 'convene needs a topic object'; return resolve(); }
        waiting.push({ topic, done: resolve });
        while (waiting.length > MAX_WAITING) { st.dropped++; waiting.shift().done(); }
        pump();
      } catch (e) { fail(e); resolve(); }
    });
  }

  return {
    convene,
    stats: () => ({ ...st, avgMs: msN ? Math.round(msSum / msN) : 0 }),
    agents: agents.map(({ id, name, role }) => ({ id, name, role })),
  };
}
