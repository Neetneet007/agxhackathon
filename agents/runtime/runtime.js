// Durable agent runtime. An agent is a folder: AGENT.md (instructions) + tools.js (tools and
// cheap rules). The runtime polls the live runner, lets each agent take its cheap readings,
// wakes an agent only when a rule fires, a message arrives or its schedule comes round.
//
// A wake-up runs in this order, so the tractors never wait for a model:
//   1. plan(ctx)  plain code: is there anything to decide? (null = no model call)
//   2. act(ctx)   plain code, the fast path: holds, recalls, events. Sent at once.
//   3. the model  writes the words for each statement the rules produced, and may call the
//                 agent's other allowed tools. No key, no network, an error: skipped.
//   4. templates  any statement the model did not write goes out as its template sentence.
//
// Durability: everything goes through DurableLog before it is acted on. On start the runtime
// replays the log to rebuild memory, messages, side effects, agent state, runs and counters.
// Side effects carry stable ids: one recorded as done is never sent again; one recorded as
// started but not finished (crash mid-call) is retried once on restart.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DurableLog } from './log.js';
import { RunnerClient, ForbiddenCallError, clockToMinute } from './runner.js';
import { Model } from './model.js';

const RESERVED = new Set(['runtime', 'test', 'data', 'node_modules']);

export async function discoverAgents(agentsDir) {
  const out = [];
  for (const name of fs.readdirSync(agentsDir).sort()) {
    if (RESERVED.has(name)) continue;
    const dir = path.join(agentsDir, name);
    if (fs.existsSync(path.join(dir, 'AGENT.md')) && fs.existsSync(path.join(dir, 'tools.js'))) out.push(await loadAgent(dir));
  }
  return out;
}

export async function loadAgent(dir) {
  const name = path.basename(dir);
  const instructions = fs.readFileSync(path.join(dir, 'AGENT.md'), 'utf8');
  const mod = (await import(pathToFileURL(path.join(dir, 'tools.js')).href)).default;
  if (!mod || !Array.isArray(mod.tools)) throw new Error(`${dir}/tools.js must default-export { tools: [...] }`);
  return { name, dir, instructions, mod, displayName: mod.displayName || name };
}

// Built-in tools every agent gets (the "shared by every agent" catalogue).
function builtinTools(rt, agent) {
  return [
    {
      name: 'get_state', kind: 'reads',
      description: 'The live runner state (cached for one second): clock, mode, tractors, jobs, tasks, holds, recalls, recent messages.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => rt.state ? { clock: rt.state.clock, mode: rt.state.mode ?? 'running', tractors: rt.state.tractors, jobs: rt.state.jobs, tasks: rt.state.tasks, holds: rt.state.holds, recalls: rt.state.recalls, trail: (rt.state.trail || []).slice(0, 10) } : { unavailable: 'live runner not reachable' },
    },
    {
      name: 'get_farm', kind: 'reads',
      description: 'The farm from the live runner: depot position and field outlines.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => rt.farm ?? { unavailable: 'live runner not reachable' },
    },
    {
      name: 'now', kind: 'reads',
      description: 'The plan clock and how many real seconds one plan minute takes.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => ({ clock: rt.state?.clock ?? null, secPerMin: rt.state?.secPerMin ?? null }),
    },
    {
      name: 'memory_get', kind: 'reads',
      description: 'Read a key from the shared memory all agents can see, with who wrote it and when.',
      input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      handler: ({ key }) => rt.memoryGet(key) ?? { missing: true },
    },
    {
      name: 'memory_set', kind: 'acts',
      description: `Write a value to shared memory (history is kept). You may only write keys starting with "${agent.name}.".`,
      input_schema: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'], additionalProperties: false },
      handler: ({ key, value }, ctx) => {
        if (!key.startsWith(agent.name + '.')) throw new Error(`you may only write keys starting with "${agent.name}."`);
        ctx.commit({ memory: { [key]: value } });
        return { ok: true };
      },
    },
    {
      name: 'send_message', kind: 'acts',
      description: 'Message another agent (plan, fleet, fault, route, depot, weather, safety, records) or the operator. Logged, delivered on the recipient\'s next wake-up and shown at the roundtable. Only when something changed; at most one per wake-up.',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'string' }, type: { type: 'string', description: 'one short word' }, text: { type: 'string', description: 'one or two plain sentences' } },
        required: ['to', 'type', 'text'], additionalProperties: false,
      },
      handler: ({ to, type, text }, ctx) => {
        if (ctx.run.sent >= 1 + (ctx.run.statements?.length || 0)) throw new Error('only one extra message per wake-up');
        return { ok: true, id: ctx.sendMessage(to, type, text) };
      },
    },
    {
      name: 'get_messages', kind: 'reads',
      description: 'Messages addressed to you after a position in the log (0 = all).',
      input_schema: { type: 'object', properties: { since: { type: 'number' } }, additionalProperties: false },
      handler: ({ since = 0 }) => rt.messages.filter(m => m.to === agent.name && m.n > since).slice(-20).map(({ n, from, type, text, clock }) => ({ n, from, type, text, clock })),
    },
    {
      name: 'speak', kind: 'acts',
      description: 'Write the words for statement number `index` from your wake-up facts: one or two short plain sentences with the real numbers and names. The rule id and source are added for you.',
      input_schema: { type: 'object', properties: { index: { type: 'number' }, text: { type: 'string' } }, required: ['index', 'text'], additionalProperties: false },
      handler: ({ index, text }, ctx) => {
        const s = ctx.run.statements?.[index];
        if (!s) throw new Error(`there is no statement ${index}`);
        if (s.spoken) throw new Error(`statement ${index} was already spoken`);
        rt.speakStatement(agent, ctx, s, String(text).slice(0, 300), 'model');
        return { ok: true };
      },
    },
  ];
}

function validate(schema, input) {
  if (!schema || schema.type !== 'object') return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'input must be an object';
  for (const k of schema.required || []) if (!(k in input)) return `missing required field "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties?.[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown field "${k}"`; continue; }
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (p.type === 'number' && typeof v !== 'number') return `"${k}" must be a number`;
    if (p.type === 'array' && !Array.isArray(v)) return `"${k}" must be an array`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

export class Runtime {
  constructor({ dataDir, agents, runnerUrl = 'http://127.0.0.1:5190', model = null, pollMs = 1000, config = {}, quiet = false } = {}) {
    this.dataDir = dataDir;
    this.agents = agents;
    this.runner = new RunnerClient(runnerUrl);
    this.model = model || new Model();
    this.pollMs = pollMs;
    this.config = config;
    this.quiet = quiet;
    this.log = new DurableLog(path.join(dataDir, 'runtime.jsonl'));
    this.startedAt = new Date().toISOString();
    this.runnerStatus = { reachable: false, lastOk: null, lastError: null };
    this.notes = new Set();
    this.state = null;
    this.farm = null;
    this.minute = null;
    this.busy = false;
    this.timer = null;
    this.manualWakes = [];
    this.lastSchedule = new Map();
    this.volatile = new Map(); // per-agent in-memory scratch (telemetry windows); not durable by design
    this.replay();
  }

  displayOf(name) { return this.agents.find(a => a.name === name)?.displayName || name; }

  // ------------------------------------------------------------------ rebuild from the log
  replay() {
    this.memory = new Map();
    this.messages = [];
    this.effects = new Map();
    this.agentState = new Map();
    this.runs = new Map();
    this.counters = new Map();
    for (const a of this.agents) { this.runs.set(a.name, []); this.counters.set(a.name, this.newCounters()); this.agentState.set(a.name, {}); }
    const runIndex = new Map();
    for (const e of this.log.entries) {
      switch (e.kind) {
        case 'commit': this.applyCommit(e); break;
        case 'effect_start': { const f = this.effects.get(e.id); if (f) { f.status = 'started'; f.attempts = e.attempt; } break; }
        case 'effect_done': { const f = this.effects.get(e.id); if (f) { f.status = 'done'; f.result = e.result; } break; }
        case 'effect_failed': { const f = this.effects.get(e.id); if (f) { f.status = e.final ? 'failed' : 'pending'; f.error = e.error; } break; }
        case 'message_delivered': for (const id of e.ids) { const m = this.messages.find(x => x.id === id); if (m) m.delivered = e.seq; } break;
        case 'agent_state': this.agentState.set(e.agent, e.state); break;
        case 'wake': {
          const run = { id: e.run, agent: e.agent, reason: e.reason, clock: e.clock, startedAt: e.ts, path: null, modelCalls: 0, toolCalls: 0, endedAt: null, sent: 0 };
          runIndex.set(e.run, run); this.runs.get(e.agent)?.push(run); this.count(e.agent, 'wakes'); break;
        }
        case 'model_call': { const r = runIndex.get(e.run); if (r) r.modelCalls++; this.count(e.agent, 'modelCalls'); break; }
        case 'tool_call': { const r = runIndex.get(e.run); if (r) r.toolCalls++; this.count(e.agent, 'toolCalls'); break; }
        case 'model_error': this.count(e.agent, 'modelErrors'); break;
        case 'run_end': {
          const r = runIndex.get(e.run);
          if (r) Object.assign(r, { path: e.path, endedAt: e.ts, summary: e.summary, error: e.error, fastMs: e.fastMs });
          this.count(e.agent, { model: 'modelWakes', rules: 'ruleWakes', 'rules-fallback': 'fallbackWakes', idle: 'idleWakes' }[e.path] || 'otherWakes');
          break;
        }
        case 'sense': this.count(e.agent, 'senses', e.n || 1); break;
        default: break;
      }
    }
    for (const runs of this.runs.values()) for (const r of runs) if (!r.endedAt) r.path = 'interrupted';
    for (const f of this.effects.values()) if (f.status === 'started') { f.status = 'pending'; f.interrupted = true; }
    this.runSeq = Math.max(0, ...[...runIndex.keys()].map(id => Number(String(id).split('-r').pop()) || 0));
  }

  newCounters() { return { senses: 0, wakes: 0, idleWakes: 0, modelWakes: 0, ruleWakes: 0, fallbackWakes: 0, otherWakes: 0, modelCalls: 0, modelErrors: 0, toolCalls: 0 }; }
  count(agent, key, n = 1) { const c = this.counters.get(agent); if (c) c[key] = (c[key] || 0) + n; }

  applyCommit(e) {
    for (const [key, value] of Object.entries(e.memory || {})) {
      const cur = this.memory.get(key) || { history: [] };
      cur.value = value; cur.by = e.agent; cur.ts = e.ts; cur.seq = e.seq;
      cur.history.push({ seq: e.seq, ts: e.ts, by: e.agent, value });
      if (cur.history.length > 200) cur.history.shift();
      this.memory.set(key, cur);
    }
    if (e.message) this.messages.push({ ...e.message, n: this.messages.length + 1, ts: e.ts, delivered: null });
    for (const f of e.effects || []) if (!this.effects.has(f.id)) this.effects.set(f.id, { id: f.id, agent: e.agent, spec: f.spec, status: 'pending', attempts: 0, seq: e.seq });
  }

  // ------------------------------------------------------------------ shared memory & messages
  memoryGet(key) { const m = this.memory.get(key); return m ? { key, value: m.value, by: m.by, ts: m.ts } : null; }

  commit(agent, { memory, effects, message } = {}) {
    const fresh = (effects || []).filter(f => !this.effects.has(f.id));
    const e = this.log.append('commit', { agent, memory, effects: fresh.length ? fresh : undefined, message });
    this.applyCommit(e);
    return e;
  }

  // extra: { memory, effects, data } committed in the same log entry as the message (atomic).
  sendMessage(from, to, type, text, run, extra = {}) {
    const id = `${from}-m${this.messages.filter(m => m.from === from).length + 1}`;
    const clock = this.state?.clock ?? null;
    const message = { id, from, to, type, text: String(text).slice(0, 400), clock, run: run?.id, data: extra.data };
    // Mirror to the roundtable under the role's display name.
    const effects = [...(extra.effects || []), { id: `say:${id}`, spec: { kind: 'say', key: 'say', body: { from: this.displayOf(from), to: this.displayOf(to), type, text: message.text } } }];
    this.commit(from, { memory: extra.memory, message, effects });
    if (run) run.sent++;
    return id;
  }

  speakStatement(agent, ctx, s, text, by) {
    // The live runner keeps 400 characters: trim the words if needed, never the rule tag.
    const tag = s.tag || '';
    let words = text || s.template;
    const room = 400 - tag.length - 1;
    if (words.length > room) words = words.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, '') + '…';
    const body = [words, tag].filter(Boolean).join(' ');
    s.spoken = by;
    ctx.sendMessage(s.to, s.type, body, { data: s.data, memory: s.memory, effects: s.effects });
  }

  inbox(agent) { return this.messages.filter(m => m.to === agent && !m.delivered && m.from !== agent); }

  // ------------------------------------------------------------------ side effects
  async flushEffects() {
    const blocked = new Set(); // order per resource: a later lift never overtakes an earlier hold
    const list = [...this.effects.values()].sort((a, b) => a.seq - b.seq);
    for (const f of list) {
      if (f.status === 'done' || f.status === 'failed') continue;
      const key = f.spec.key || f.id;
      if (blocked.has(key)) continue;
      if (f.nextTry && Date.now() < f.nextTry) { blocked.add(key); continue; }
      const attempt = (f.attempts || 0) + 1;
      this.log.append('effect_start', { id: f.id, agent: f.agent, attempt, spec: f.spec });
      f.status = 'started'; f.attempts = attempt;
      let res, err;
      try { res = await this.execute(f.spec); } catch (e) { err = e; }
      if (err instanceof ForbiddenCallError) {
        this.log.append('effect_failed', { id: f.id, error: err.message, final: true }); f.status = 'failed'; continue;
      }
      if (!err && res.ok) {
        this.log.append('effect_done', { id: f.id, result: { status: res.status } }); f.status = 'done'; f.interrupted = false; continue;
      }
      const reason = err ? `runner unreachable (${err.cause?.code || err.name})` : `HTTP ${res.status}`;
      const retryable = !!err || res.status === 404 || res.status >= 500 || res.status === 409 || res.status === 429;
      const final = !retryable;
      this.log.append('effect_failed', { id: f.id, error: reason, final });
      f.status = final ? 'failed' : 'pending';
      f.interrupted = false;
      if (!final) {
        f.nextTry = Date.now() + (res?.status === 404 ? 5000 : Math.min(30_000, 1000 * 2 ** Math.min(5, attempt - 1)));
        if (res?.status === 404) this.noteOnce(`404:${f.spec.kind}`, `live runner has no ${this.describe(f.spec)} endpoint yet (404); will keep retrying`);
        blocked.add(key);
      }
    }
  }

  describe(spec) { return { hold: 'POST /hold', unhold: 'DELETE /hold/:id', recall: 'POST /recall', unrecall: 'DELETE /recall/:id', say: 'POST /agent/say', event: 'POST /event' }[spec.kind] || spec.kind; }

  execute(spec) {
    switch (spec.kind) {
      case 'hold': return this.runner.postHold(spec.body);
      case 'unhold': return this.runner.deleteHold(spec.holdId);
      case 'recall': return this.runner.postRecall(spec.body);
      case 'unrecall': return this.runner.deleteRecall(spec.recallId);
      case 'say': return this.runner.say(spec.body);
      case 'event': return this.runner.postEvent(spec.body);
      default: throw new ForbiddenCallError(`unknown effect kind ${spec.kind}`);
    }
  }

  noteOnce(key, text) {
    if (this.notes.has(key)) return;
    this.notes.add(key);
    this.log.append('note', { text });
    if (!this.quiet) console.log(`[agents] ${text}`);
  }

  // ------------------------------------------------------------------ the loop
  start() {
    const loop = async () => { await this.tick(); this.timer = setTimeout(loop, this.pollMs); };
    this.timer = setTimeout(loop, 0);
  }

  stop() { clearTimeout(this.timer); this.timer = null; this.log.close(); }

  async pollRunner() {
    try {
      const r = await this.runner.getState();
      if (!r.ok || !r.json) throw new Error(`HTTP ${r.status}`);
      this.state = r.json;
      this.minute = clockToMinute(r.json.clock);
      if (!this.runnerStatus.reachable) {
        if (this.runnerStatus.lastError) this.log.append('note', { text: 'live runner reachable again' });
        this.notes.delete('runner-down');
      }
      this.runnerStatus = { reachable: true, lastOk: new Date().toISOString(), lastError: null };
      if (!this.farm) {
        const f = await this.runner.getFarm().catch(() => null);
        if (f?.ok && f.json) this.farm = f.json;
      }
      return true;
    } catch (err) {
      this.runnerStatus = { ...this.runnerStatus, reachable: false, lastError: err.cause?.code || err.message };
      this.noteOnce('runner-down', `live runner not reachable at ${this.runner.base} (${this.runnerStatus.lastError}); retrying quietly`);
      return false;
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const up = await this.pollRunner();
      for (const agent of this.agents) {
        const reasons = [];
        if (up) {
          const ctx = this.context(agent, null);
          let fired = null;
          try { fired = await agent.mod.sense?.(ctx); } catch (err) { this.noteOnce(`sense:${agent.name}:${err.message}`, `${agent.name} sense failed: ${err.message}`); }
          if (ctx.sensed) { this.log.append('sense', { agent: agent.name, n: ctx.sensed, clock: this.state?.clock }); this.count(agent.name, 'senses', ctx.sensed); }
          if (fired) reasons.push(fired);
          const every = agent.mod.schedule?.everyPlanMinutes;
          if (every && this.minute != null) {
            const slot = Math.floor(this.minute / every);
            const last = this.lastSchedule.get(agent.name);
            if (last != null && slot > last) reasons.push(`schedule (every ${every} plan min)`);
            this.lastSchedule.set(agent.name, slot);
          }
        }
        if (this.inbox(agent.name).length) reasons.push('message');
        if (this.manualWakes.includes(agent.name)) { reasons.push('manual'); this.manualWakes = this.manualWakes.filter(w => w !== agent.name); }
        if (reasons.length) await this.wake(agent, reasons.join('; '));
      }
      await this.flushEffects();
    } finally {
      this.busy = false;
    }
  }

  requestWake(name) {
    if (!this.agents.some(a => a.name === name)) return false;
    this.manualWakes.push(name);
    return true;
  }

  // A person's action reported through the API (e.g. an inspection marked done). Logged first.
  async person(agentName, action, body) {
    const agent = this.agents.find(a => a.name === agentName);
    const fn = agent?.mod.people?.[action];
    if (!fn) return { ok: false, error: `no person action ${action} on ${agentName}` };
    if (!body?.by) return { ok: false, error: 'a person action needs "by" (who did it)' };
    this.log.append('person', { agent: agentName, action, body });
    const ctx = this.context(agent, { id: `${agentName}-person`, toolSeq: 0, toolCalls: 0, sent: 0, caller: 'person' });
    const result = await fn(ctx, body);
    await this.flushEffects();
    return { ok: true, ...result };
  }

  context(agent, run) {
    const rt = this;
    const ctx = {
      agent: agent.name,
      run,
      config: this.config,
      get state() { return rt.state; },
      get farm() { return rt.farm; },
      get clock() { return rt.state?.clock ?? null; },
      get minute() { return rt.minute; },
      get mode() { return rt.state?.mode ?? 'running'; },
      sensed: 0,
      memory: { get: k => rt.memory.get(k)?.value, entry: k => rt.memoryGet(k) },
      get agentState() { return rt.agentState.get(agent.name) || {}; },
      saveState(state) { rt.log.append('agent_state', { agent: agent.name, state }); rt.agentState.set(agent.name, state); },
      get volatile() { if (!rt.volatile.has(agent.name)) rt.volatile.set(agent.name, {}); return rt.volatile.get(agent.name); },
      commit(c) { return rt.commit(agent.name, c); },
      hasEffect: id => rt.effects.has(id),
      effectStatus: id => rt.effects.get(id)?.status ?? null,
      sendMessage: (to, type, text, extra) => rt.sendMessage(agent.name, to, type, text, run, extra),
      journal(obj) {
        fs.appendFileSync(path.join(rt.dataDir, `${agent.name}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
      },
      writeFile(name, text) { fs.writeFileSync(path.join(rt.dataDir, name), text); return path.join(rt.dataDir, name); },
      logEntries: () => rt.log.entries,
      messages: () => rt.messages,
      callTool: (name, input) => rt.callTool(agent, ctx, name, input),
    };
    return ctx;
  }

  allTools(agent) { return [...agent.mod.tools, ...builtinTools(this, agent)]; }

  async callTool(agent, ctx, name, input) {
    const tool = this.allTools(agent).find(t => t.name === name);
    const callId = `${ctx.run?.id}:t${++ctx.run.toolSeq}`;
    this.log.append('tool_call', { agent: agent.name, run: ctx.run?.id, callId, tool: name, input, by: ctx.run?.caller || 'rules' });
    ctx.run.toolCalls++; this.count(agent.name, 'toolCalls');
    let result, error;
    if (!tool) error = `unknown tool ${name}`;
    else if (ctx.run?.caller === 'model' && tool.modelMay === false) error = `${name} is not available to the model`;
    else {
      error = validate(tool.input_schema, input ?? {});
      if (!error) {
        try { result = await tool.handler(input ?? {}, ctx); } catch (err) { error = err.message; }
      }
    }
    this.log.append('tool_result', { agent: agent.name, run: ctx.run?.id, callId, tool: name, result, error });
    return error ? { error } : { result };
  }

  async wake(agent, reason) {
    const run = { id: `${agent.name}-r${++this.runSeq}`, agent: agent.name, reason, clock: this.state?.clock ?? null, startedAt: new Date().toISOString(), path: null, modelCalls: 0, toolCalls: 0, toolSeq: 0, sent: 0, endedAt: null };
    this.log.append('wake', { agent: agent.name, run: run.id, reason, clock: run.clock });
    this.runs.get(agent.name).push(run); this.count(agent.name, 'wakes');
    const inbox = this.inbox(agent.name);
    if (inbox.length) {
      const e = this.log.append('message_delivered', { agent: agent.name, ids: inbox.map(m => m.id) });
      for (const m of inbox) m.delivered = e.seq;
    }
    const ctx = this.context(agent, run);
    let pathTaken = 'idle', summary = null, error = null, fastMs = null;
    try {
      const task = await agent.mod.plan?.(ctx, { reason, inbox });
      if (task) {
        // 1. Fast path: rules act and the calls go out now, before any model is asked.
        const t0 = performance.now();
        run.caller = 'rules';
        const acted = await agent.mod.act?.(ctx, task);
        await this.flushEffects();
        fastMs = Math.round(performance.now() - t0);
        run.statements = acted?.statements || task.statements || [];
        summary = acted?.summary || null;
        pathTaken = 'rules';
        // 2. The model writes the words (and may use its other allowed tools).
        if (this.model.available() && (run.statements.length || task.prompt)) {
          run.caller = 'model';
          try {
            const facts = run.statements.map((s, i) => ({ index: i, to: s.to, type: s.type, facts: s.facts, plainTemplate: s.template }));
            const prompt = [task.prompt || '', facts.length ? `Statements to speak (call speak once for each index):\n${JSON.stringify(facts)}` : 'No statement is required; use your tools only if your instructions say so.'].filter(Boolean).join('\n\n');
            const out = await this.model.run({
              system: agent.instructions,
              tools: this.allTools(agent).filter(t => t.modelMay !== false),
              prompt,
              callTool: (n, i) => this.callTool(agent, ctx, n, i),
              hooks: {
                onCall: n => { this.log.append('model_call', { agent: agent.name, run: run.id, n, model: this.model.model }); run.modelCalls++; this.count(agent.name, 'modelCalls'); },
                onResult: (n, r) => this.log.append('model_result', { agent: agent.name, run: run.id, n, ...r }),
              },
            });
            pathTaken = 'model'; summary = [summary, out.text].filter(Boolean).join(' | ');
          } catch (err) {
            error = `${err.status ? `HTTP ${err.status}: ` : ''}${err.message}`;
            this.log.append('model_error', { agent: agent.name, run: run.id, error });
            this.count(agent.name, 'modelErrors');
            pathTaken = 'rules-fallback';
          }
          run.caller = 'rules';
        }
        // 3. Anything the model did not say goes out as its template sentence.
        for (const s of run.statements) if (!s.spoken) this.speakStatement(agent, ctx, s, null, 'template');
        const r = await agent.mod.ruleOnly?.(ctx, task);
        if (r?.acted) summary = [summary, r.summary].filter(Boolean).join(' | ');
      }
    } catch (err) {
      error = err.stack || err.message; pathTaken = 'error';
      this.noteOnce(`wake-error:${agent.name}:${err.message}`, `${agent.name} wake failed: ${err.message}`);
    }
    run.path = pathTaken; run.endedAt = new Date().toISOString(); run.summary = summary; run.error = error; run.fastMs = fastMs;
    this.log.append('run_end', { agent: agent.name, run: run.id, path: pathTaken, summary, error, fastMs });
    this.count(agent.name, { model: 'modelWakes', rules: 'ruleWakes', 'rules-fallback': 'fallbackWakes', idle: 'idleWakes' }[pathTaken] || 'otherWakes');
    await this.flushEffects();
    return run;
  }

  // ------------------------------------------------------------------ read-only views for the API
  agentSummary(agent) {
    const c = this.counters.get(agent.name);
    const runs = this.runs.get(agent.name);
    const last = runs[runs.length - 1] || null;
    return {
      name: agent.name,
      displayName: agent.displayName,
      job: agent.mod.job || null,
      status: !this.runnerStatus.reachable ? 'waiting for live runner' : last && !last.endedAt ? 'running' : 'idle',
      schedule: agent.mod.schedule || null,
      lastRun: last && { id: last.id, reason: last.reason, clock: last.clock, path: last.path, startedAt: last.startedAt, summary: last.summary, error: last.error, fastMs: last.fastMs },
      counts: { ...c, wakesWithModelCall: c.modelWakes + c.fallbackWakes, modelCallRatio: c.wakes ? +((c.modelWakes + c.fallbackWakes) / c.wakes).toFixed(3) : 0 },
      pendingEffects: [...this.effects.values()].filter(f => f.agent === agent.name && f.status !== 'done' && f.status !== 'failed').map(f => f.id),
    };
  }
}
