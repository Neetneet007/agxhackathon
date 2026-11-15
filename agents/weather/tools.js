// Weather agent: decides whether spraying may go ahead right now, says why, and tells the
// coordinator. Readings and rules are plain code; the model only chooses tools and words.
import { evaluate, holdReason, templateText, readingText, THRESHOLDS } from './rules.js';
import { makeFeed } from './feed.js';

export const MEMORY_KEYS = {
  status: 'weather.spray',     // { status: Go|Caution|Stop, reason, triggers, reading, since, transition }
  reading: 'weather.reading',  // latest reading { clock, t2C, t10C, wind2Mph, wind10Mph, source }
  hold: 'weather.hold',        // { id, active, since }
};
export const HOLD_ID = 'weather-agent-spray';
const RECENT = 10;

const feeds = new WeakMap();
function feedFor(config) {
  if (!feeds.has(config)) feeds.set(config, makeFeed(config));
  return feeds.get(config);
}

const latest = ctx => ctx.agentState.latest || null;

// Commit a status change: memory, the hold or lift, and one message, in a single log entry,
// with effect ids derived from the transition number so a restart never sends them twice.
function announce(ctx, ev, explanation) {
  const prev = ctx.memory.get(MEMORY_KEYS.status);
  if (prev?.status === ev.status) return { acted: false };
  const n = (prev?.transition ?? 0) + 1;
  const holdActive = !!ctx.memory.get(MEMORY_KEYS.hold)?.active;
  const effects = [];
  if (ev.status === 'Stop') {
    effects.push({ id: `weather:t${n}:hold`, spec: { kind: 'hold', key: `hold:${HOLD_ID}`, body: { id: HOLD_ID, jobTypes: ['spray'], fields: null, reason: holdReason(ev), by: 'weather-agent' } } });
  } else if (holdActive) {
    effects.push({ id: `weather:t${n}:lift`, spec: { kind: 'unhold', key: `hold:${HOLD_ID}`, holdId: HOLD_ID } });
  }
  const text = (explanation && explanation.trim()) || templateText(ev, prev?.status);
  const status = { status: ev.status, reason: text, triggers: ev.triggers, reading: ev.reading, since: ctx.clock, transition: n, previous: prev?.status ?? null };
  const memory = { [MEMORY_KEYS.status]: status, [MEMORY_KEYS.hold]: { id: HOLD_ID, active: ev.status === 'Stop', since: ctx.clock } };
  // Speak only when the status changes. The very first Go of the day is recorded but not announced.
  const silent = prev == null && ev.status === 'Go';
  if (silent) ctx.commit({ memory, effects });
  else ctx.sendMessage(ev.status === 'Caution' ? 'operator' : 'coordinator', ev.status.toLowerCase(), text, { memory, effects });
  ctx.journal({ kind: 'status_change', clock: ctx.clock, from: prev?.status ?? null, to: ev.status, triggers: ev.triggers, reading: ev.reading, text, by: ctx.run?.caller || 'rules', hold: effects[0]?.spec.kind ?? null });
  return { acted: true, summary: `${prev?.status ?? 'start'} → ${ev.status}: ${text}` };
}

export default {
  schedule: { everyPlanMinutes: 60 },

  // Cheap, every poll: take one reading per new plan minute; fire when the rules' status differs
  // from the announced one. No model here.
  async sense(ctx) {
    const minute = ctx.minute;
    if (minute == null) return null;
    const st = ctx.agentState;
    const last = st.lastMinute;
    if (last != null && minute === last) return null;
    // clock went back (runner restarted) or jumped far: read just this minute
    const from = last == null || minute < last || minute - last > 30 ? minute : last + 1;
    const feed = feedFor(ctx.config);
    let r = null;
    const recent = [...(st.recent || [])];
    for (let m = from; m <= minute; m++) {
      const v = await feed(m, ctx);
      if (!v) continue;
      r = { clock: ctx.clock && m === minute ? ctx.clock : null, minute: m, ...v };
      const ev = evaluate(r);
      ctx.journal({ kind: 'reading', ...r, rules: ev.status, triggers: ev.triggers.map(t => t.code) });
      recent.push(r); if (recent.length > RECENT) recent.shift();
      ctx.sensed++;
    }
    if (!r) return null;
    ctx.saveState({ lastMinute: minute, latest: r, recent });
    const ev = evaluate(r);
    ctx.commit({ memory: { [MEMORY_KEYS.reading]: { ...r, rules: ev.status } } });
    const announced = ctx.memory.get(MEMORY_KEYS.status)?.status ?? null;
    if (ev.status !== announced) return `rules say ${ev.status} (announced: ${announced ?? 'nothing yet'})`;
    return null;
  },

  // On a wake: is there anything to decide? null means no model call.
  plan(ctx, { reason, inbox }) {
    const r = latest(ctx);
    if (!r) return null;
    const ev = evaluate(r);
    const prev = ctx.memory.get(MEMORY_KEYS.status);
    if (prev?.status === ev.status && !inbox.length) return null;
    const lines = [
      `Plan clock: ${ctx.clock}. Wake reason: ${reason}.`,
      `Announced spray status so far: ${prev?.status ?? 'none yet today'}${prev?.since ? ` (since ${prev.since})` : ''}.`,
      `Latest reading: ${readingText(r)}.`,
    ];
    if (inbox.length) lines.push('Messages for you:', ...inbox.map(m => `- from ${m.from} (${m.type}): ${m.text}`));
    lines.push('Check the conditions with evaluate_spray_conditions, then act on the result as your instructions say. If the status has not changed, do nothing and reply in one line.');
    return { prompt: lines.join('\n'), previous: prev?.status ?? null };
  },

  // Rule-only path, and the safety net after a model run: make the announced status match the rules.
  ruleOnly(ctx) {
    const r = latest(ctx);
    if (!r) return { acted: false };
    return announce(ctx, evaluate(r), null);
  },

  tools: [
    {
      name: 'get_weather_readings',
      description: 'Latest weather readings (temperature and wind at 2 m and 10 m), newest last.',
      input_schema: { type: 'object', properties: { count: { type: 'number', description: 'how many recent readings, default 3' } }, additionalProperties: false },
      handler: ({ count = 3 }, ctx) => (ctx.agentState.recent || []).slice(-Math.max(1, Math.min(10, count))),
    },
    {
      name: 'evaluate_spray_conditions',
      description: 'Apply the spray-drift rules to the latest reading. Returns status Go, Caution or Stop, the triggers with the readings behind them, and the thresholds. This is the only source of the status.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_, ctx) => {
        const ev = evaluate(latest(ctx));
        return { ...ev, announced: ctx.memory.get(MEMORY_KEYS.status)?.status ?? null, thresholds: THRESHOLDS };
      },
    },
    {
      name: 'announce_spray_status',
      description: 'Record a new spray status and tell the fleet. Stop places a hold on all spray jobs; Go or Caution lifts the hold if one is in force; one message goes to the coordinator (Stop, Go) or operator (Caution). The status must equal what evaluate_spray_conditions returned; otherwise the call is refused. Does nothing if that status is already announced.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['Go', 'Caution', 'Stop'] },
          explanation: { type: 'string', description: 'One or two plain sentences for the operator, naming the readings that matter.' },
        },
        required: ['status', 'explanation'], additionalProperties: false,
      },
      handler: ({ status, explanation }, ctx) => {
        const ev = evaluate(latest(ctx));
        if (status !== ev.status) throw new Error(`refused: the rules say ${ev.status}, not ${status}`);
        const r = announce(ctx, ev, String(explanation).slice(0, 300));
        return r.acted ? { ok: true, announced: ev.status } : { ok: true, note: `${ev.status} was already announced; nothing sent` };
      },
    },
  ],
};
