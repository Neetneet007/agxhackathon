// Server-side LLM explainer (Claude). The planner makes every decision; Claude only
// turns the planner's facts into plain language. Runs in Node (serve.js) so the
// API key never reaches the browser. Without credentials, callers fall back to the
// planner's own rule-based text.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.FLEET_LLM_MODEL || 'claude-opus-5-5';

const SYSTEM = `You are the dispatch copilot for a fleet of autonomous tractors on one farm.
An algorithmic planner makes every assignment and re-plan; you explain its decisions to the farm operator.
Rules:
- Use only the facts in the message. Never invent numbers, times, tractors, fields, jobs or data sources. If the facts do not answer the question, say what is not known.
- Plain language for a farm operator. No planner jargon such as "cost", "objective" or "insertion".
- When a data source triggered the change (telematics, weather service, bridge gauges, imagery, dealer service, soil probes, operator), name it.
- Times are 24-hour clock times as given. Tractors are T1, T2, T3; jobs are J-numbers or N-numbers.`;

export function llmEnabled() {
  if (process.env.FLEET_LLM === 'off') return false;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  return client;
}

async function ask(userText, format) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', ...(format ? { format } : {}) },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`declined (${response.stop_details?.category ?? 'unspecified'})`);
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) throw new Error(`empty response (stop_reason ${response.stop_reason})`);
  return { text, model: response.model };
}

const SHIFT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'At most 8 words' },
      reason: { type: 'string', description: 'One or two short sentences, at most 45 words' },
    },
    required: ['title', 'reason'],
    additionalProperties: false,
  },
};

// A plan shift → {title, reason} for the pop-down notification.
export async function explainShift(facts) {
  const { text, model } = await ask(
    `A re-plan just happened. Write the operator notification: a title of at most 8 words and a reason of one or two short sentences (at most 45 words) saying what changed and why.\n\nFacts (JSON):\n${JSON.stringify(facts)}`,
    SHIFT_FORMAT,
  );
  const out = JSON.parse(text);
  return { title: String(out.title), reason: String(out.reason), model };
}

// Free-form "why?" from the operator, grounded in the planner's facts.
export async function answerWhy(question, facts) {
  const { text, model } = await ask(
    `The operator asks: "${question}"\n\nAnswer in at most 4 short sentences of plain text (no headings or bullet lists). Cite the facts that matter: times, tractors, deadlines, data sources, and which alternatives were rejected and why.\n\nFacts (JSON):\n${JSON.stringify(facts)}`,
  );
  return { answer: text, model };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude: invalid or missing API key';
  if (err instanceof Anthropic.RateLimitError) return 'Claude: rate limited';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}`.trim();
  return `Claude unavailable: ${err.message}`;
}
