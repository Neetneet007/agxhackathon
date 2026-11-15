// Claude in the loop. The model picks tools and writes the explanation; every number, threshold
// and safety decision stays in plain code inside the tools. Any failure (no key, no SDK, no
// network, timeout, refusal, API error) throws, and the runtime falls back to the agent's
// rule-only path, which takes the same actions with a templated explanation.

export const DEFAULT_MODEL = 'claude-haiku-5-5'; // fast and inexpensive; override with AGENT_MODEL
const MAX_TURNS = 6;

export class Model {
  // client: optional object with messages.create() (tests inject a fake one)
  constructor({ model = process.env.AGENT_MODEL || DEFAULT_MODEL, client = null, timeoutMs = 20_000, env = process.env } = {}) {
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.injected = client;
    this.client = client;
    this.disabledReason = null;
    if (!client) {
      if (model === 'off') this.disabledReason = 'AGENT_MODEL=off';
      else if (!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) this.disabledReason = 'no ANTHROPIC_API_KEY';
    }
  }

  available() { return !this.disabledReason; }

  async getClient() {
    if (this.client) return this.client;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      this.disabledReason = '@anthropic-ai/sdk is not installed (run npm install in the repo root)';
      throw new Error(this.disabledReason);
    }
    this.client = new Anthropic({ timeout: this.timeoutMs, maxRetries: 0 });
    return this.client;
  }

  // Runs one tool-use conversation. callTool(name, input) → {result} | {error}.
  // hooks.onCall(n), hooks.onResult(n, summary) are used for the durable log.
  async run({ system, tools, prompt, callTool, hooks = {} }) {
    const client = await this.getClient();
    const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const messages = [{ role: 'user', content: prompt }];
    let text = '';
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      hooks.onCall?.(turn);
      const resp = await client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system,
        tools: toolDefs,
        tool_choice: { type: 'auto' },
        output_config: { effort: 'low' },
        messages,
      }, { timeout: this.timeoutMs });
      const uses = (resp.content || []).filter(b => b.type === 'tool_use');
      text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() || text;
      hooks.onResult?.(turn, { stop_reason: resp.stop_reason, text, toolUses: uses.map(u => ({ name: u.name, input: u.input })), usage: resp.usage });
      if (resp.stop_reason === 'refusal') throw new Error(`model declined (${resp.stop_details?.category ?? 'unspecified'})`);
      if (resp.stop_reason === 'max_tokens') throw new Error('model hit max_tokens');
      if (resp.stop_reason !== 'tool_use' || !uses.length) return { text, turns: turn };
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const u of uses) {
        const r = await callTool(u.name, u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.error ? { error: r.error } : r.result ?? null), is_error: !!r.error });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text, turns: MAX_TURNS, truncated: true };
  }
}
