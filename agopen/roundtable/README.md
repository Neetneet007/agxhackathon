# Roundtable of AI managers

On each significant event (fault, re-plan, depot service, weather hold, ...) a few managers hold a short, visible discussion and the chair (Plan Manager) may act through a tool. Each manager is a language model plus one instructions file in `agents/`. It runs asynchronously and never blocks the rule-based fast path.

```js
import { createRoundtable } from './roundtable/roundtable.js';
const rt = createRoundtable({ say: (line) => ..., tools: { hold_tractor: { description, input_schema, handler } } });
rt.convene({ type: 'fault', title: 'T2 stalled', facts: { tractor: 'T2', kind: 'stall', signal: '...' } }); // no await needed
```

## How a discussion runs
1. Topics queue and run one at a time. More than 3 waiting: the oldest waiting ones are dropped (counted in `stats().dropped`).
2. Round 1: every speaker except the chair is asked in parallel, with its own `.md` as the system prompt plus the facts. Each line goes to `say` as it arrives (`kind: 'says'`).
3. Round 2: the Plan Manager sees the facts and the others' lines, and has the tools. It may call at most two (`kind: 'tool'` line each; a third is refused), then closes with a `kind: 'decision'` line.
4. Only the chair ever receives tools.

Default speakers per type are in `SPEAKERS` in `roundtable.js`; pass `who: ['id', ...]` to override.

## Add a manager
Create `agents/<id>.md` starting with `# Display Name` and a `Role: ...` line, then the instructions. Add its id to a type in `SPEAKERS` (or pass it in `who`). `agents` picks it up automatically.

## With no model
With no credential (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_PROFILE), `enabled: false`, a timeout or any error, each manager gets a rule-written line built from the facts (`kind: 'fallback'`). The chair's fallback never calls tools. `convene` never rejects; see `stats().lastError`.

Model: `claude-haiku-5-5`, override with the `model` option or `ROUNDTABLE_MODEL`. Thinking is disabled (otherwise it eats the small token budget). `node roundtable/smoke.js` runs one real fault discussion.
