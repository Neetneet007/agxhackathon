// The farm assistant: one conversation with the operator. A language model with a short instruction text and a
// set of plain-code tools supplied by the coordinator (read the farm, add jobs, change a priority, explain a job,
// send the drone). The model decides which tools to call; the tools do the work and enforce the rules.
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are the farm assistant for a fleet coordinator that runs three autonomous tractors, a fuel truck and a scout drone on one farm. You talk with the farm operator.

How to answer:
- Plain language a farmer would use. Short: two to five sentences, or a short list with lines starting "- ". No headings, no bold, no tables, no emoji.
- Facts come from the tools. Never guess a number, a field's state or a job id; look it up first. If a tool refuses something, say why in the tool's own words and say what would work instead.
- When the operator asks you to do something, do it with the tools and then say what you did. Do not ask for confirmation for ordinary work (adding jobs, a survey, a priority change). Do ask before removing several jobs at once.
- "Plow" or "till" is the step "till". "Sow", "seed" or "plant" is "seed". A field must be plowed before it is sown; to do both, pass the steps in that order in one call.
- When the operator asks what a field is like, how a field is doing, or to look at a field, ALWAYS call field_report with send_drone true. Answer from the record straight away, say how old the last survey is, and say the drone is on its way and its camera is shown below your answer.
- When asked why a tractor has a job or why the plan is the way it is, use why_job (and farm_overview to find the job id).
- You cannot release a tractor that is locked at the depot for fuelling or an implement change: a person must do the work and press Good to go on the dashboard. You cannot repair a tractor. Say so if asked.
- Weather stops on spraying are safety rules; you cannot lift them.
- Everything on this farm is simulated (tractors run in AgOpenGPS simulators, the drone and the crops are simulated). Say so only if asked.`;

export function createChat({ tools, context = () => '', clock = () => '', model = process.env.CHAT_MODEL || 'claude-haiku-5-5', maxTurns = 6, fallback = null }) {
  let client = null;
  let history = [];          // what the model sees: plain user and assistant turns
  const shown = [];          // what the page shows
  const defs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  async function runTool(u, actions, state) {
    const t = tools.find(x => x.name === u.name);
    let out, isErr = false;
    try { if (!t) throw new Error(`No such tool: ${u.name}`); out = await t.handler(u.input || {}); } catch (err) { out = err.message; isErr = true; }
    if (!isErr && t.summary) { const s = t.summary(u.input || {}, out); if (s) actions.push({ tool: u.name, summary: s }); }
    if (!isErr && t.drone) state.drone = t.drone(u.input || {}, out) || state.drone;
    return { type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out ?? null), ...(isErr ? { is_error: true } : {}) };
  }

  async function send(text) {
    text = String(text || '').slice(0, 1000).trim();
    if (!text) throw new Error('Type a question or an instruction.');
    shown.push({ role: 'user', text, clock: clock() });
    const actions = [], state = { drone: null };
    let reply = '';
    const turn = [...history, { role: 'user', content: text }];
    try {
      client ||= new Anthropic({ maxRetries: 1, timeout: 30000 });
      for (let i = 0; i < maxTurns; i++) {
        const res = await client.messages.create({ model, max_tokens: 700, thinking: { type: 'disabled' }, system: `${SYSTEM}\n\nRight now: ${context()}`, tools: defs, messages: turn });
        turn.push({ role: 'assistant', content: res.content });
        const uses = (res.content || []).filter(b => b.type === 'tool_use');
        if (!uses.length) { reply = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim(); break; }
        const results = [];
        for (const u of uses) results.push(await runTool(u, actions, state));
        turn.push({ role: 'user', content: results });
      }
      if (!reply) reply = actions.length ? 'Done.' : 'I could not finish that. Try asking in a different way.';
    } catch (err) {
      // No model (offline, no key, timeout): answer what plain code can, and say so.
      const fb = fallback ? await Promise.resolve(fallback(text, actions, state)).catch(() => null) : null;
      reply = fb || `The assistant could not reach its language model (${String(err.message).slice(0, 120)}). The dashboard still works: use the field list and the job list there.`;
    }
    // Keep only the words of each turn; the tool traffic is not needed again.
    history = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply + (actions.length ? `\n(Actions taken: ${actions.map(a => a.summary).join('; ')})` : '') }].slice(-24);
    const msg = { role: 'assistant', text: reply, clock: clock(), actions, drone: state.drone };
    shown.push(msg);
    if (shown.length > 200) shown.splice(0, shown.length - 200);
    return msg;
  }

  return { send, history: () => shown.slice(), reset: () => { history = []; shown.length = 0; } };
}
