# Agents

A durable agent runtime (`agents/runtime/`) and the first agent on it, the weather agent (`agents/weather/`). Everything here lives under `agents/`; nothing else in the repo is touched.

```bash
node agents/server.js                    # rule-only, API on http://127.0.0.1:5200
ANTHROPIC_API_KEY=sk-ant-... node agents/server.js   # model in the loop (needs npm install in the repo root for @anthropic-ai/sdk)
node --test agents/test/                 # 15 tests against a fake live runner; no demo needed
```

It starts cleanly when the live runner is not up and keeps retrying quietly (one log line, then silence until it comes back).

| Variable | Default | |
|---|---|---|
| `AGENTS_PORT` | `5200` | API port (reserved ports are refused) |
| `RUNNER_URL` | `http://127.0.0.1:5190` | live runner; must be a local address |
| `AGENTS_DATA` | `agents/data` | durable log and journals (git-ignored) |
| `AGENTS` | all | comma list of agent folders to run |
| `POLL_MS` | `1000` | how often `GET /state` is polled (real ms) |
| `AGENT_MODEL` | `claude-haiku-5-5` | any Claude model id, or `off` for rule-only |
| `WEATHER_SOURCE` | `sim` | `nws` for the National Weather Service (internet; off by default) |
| `WEATHER_SCRIPT` | — | JSON file of readings `[{ "at": "HH:MM", "t2C", "t10C", "wind2Mph", "wind10Mph" }]` |

## How an agent is defined

An agent is a folder with two files. The runtime finds every folder under `agents/` that has both, so an observer, a failure agent or an initiator is a new folder, not a runtime change.

- `AGENT.md`: the instructions, plain prose, sent as the system prompt.
- `tools.js`: `export default { tools, schedule, sense, plan, ruleOnly }`
  - `tools`: `[{ name, description, input_schema, handler(input, ctx) }]`. Every agent also gets `memory_get`, `memory_set` (own `<agent>.` keys only) and `send_message`.
  - `schedule: { everyPlanMinutes }`: a scheduled wake-up on the plan clock.
  - `sense(ctx)`: cheap plain code, run on every poll. Takes readings; returns a reason string when a rule fires, which wakes the agent.
  - `plan(ctx, { reason, inbox })`: on a wake-up, is there anything to decide? `null` ends the wake with **no model call**; otherwise `{ prompt }`.
  - `ruleOnly(ctx, task)`: the same actions without a model, with a templated explanation. It also runs after every model run as a safety net: it does nothing if the model already acted, and completes the action if the model did not.

## What the runtime guarantees

- **Durable log.** `agents/data/runtime.jsonl`, one JSON object per line, fsync'd before the runtime acts on it: every wake-up, model call and result, tool call and result, message, memory write, side effect start/done/failure. On start the runtime replays it to rebuild memory, messages, pending side effects, agent state, runs and counters. A line torn by a crash is ignored.
- **No repeated side effects.** Each call that changes something outside the runtime (hold, lift, message mirror, event) has a stable id and is written in the same log entry as the memory change that caused it. Done → never sent again. Started but not finished (process killed mid-call) → retried once on restart. Failed because the runner is down or the endpoint returns 404 → kept and retried with back-off, in order per resource (a lift never overtakes its hold). Any other 4xx → marked failed.
- **Shared memory.** Key-value with history (last 200 revisions per key), readable by every agent (`memory_get`, `GET /memory`); an agent writes only keys under its own name.
- **Messages.** `send_message` logs the message, delivers it on the recipient agent's next wake-up (an unread message is itself a wake rule) and mirrors it to the operator's trail with `POST /agent/say`. One per wake-up.
- **Cheap waking.** Agents wake on a schedule, on a rule from `sense`, on a message, or on `POST /agents/<name>/wake`. `GET /agents` counts senses, wake-ups, wake-ups that led to a model call and idle wake-ups.
- **Model use.** Claude chooses tools and writes the explanation. Thresholds, arithmetic and the Go/Caution/Stop decision are plain code; a tool refuses a status that disagrees with the rules. No key, no SDK, no network, a timeout (20 s), a refusal or an API error → the rule-only path takes the same actions. The demo never depends on the internet.
- **Safety.** The live-runner client is an allowlist: `GET /state`, `GET /farm`, `POST /hold`, `DELETE /hold/<id>`, `POST /agent/say`, and `POST /event` with type `priority_change` only. Everything else (`/human/*/go`, `/cmd/*`, `/start`, `/draft`, breakdown/repair events, …) is refused before any network traffic. Only local runner addresses are accepted.

## API (port 5200, read-only except wake)

| | |
|---|---|
| `GET /health` | runner reachability, plan clock, model on/off and why, log size |
| `GET /agents` | each agent: status, last run, counts (`senses`, `wakes`, `wakesWithModelCall`, `idleWakes`, `modelCallRatio`, …), pending side effects |
| `GET /agents/<name>` | the same plus its instructions and tool list |
| `GET /agents/<name>/runs?limit=50` | wake-ups, newest first, each with its steps (model calls, tool calls and results) |
| `GET /messages?since=<n>` | messages after number `n`; `next` is the number to pass next time |
| `GET /memory`, `GET /memory?key=<k>` | current values; one key with its history |
| `GET /effects` | every side effect and its state |
| `POST /agents/<name>/wake` | wake an agent on the next poll |

## The weather agent

One task: decide whether spraying may go ahead on this farm right now, say why, and tell the coordinator.

**Readings**, one per plan minute (minutes skipped by a fast clock are back-filled, up to 30): temperature and wind at 2 m (boom height) and 10 m.

**Rules** (`weather/rules.js`):

| Rule | Threshold | Result |
|---|---|---|
| Inversion | 10 m temperature higher than 2 m temperature | Stop |
| Wind too low | 2 m wind below 3 mph | Stop |
| Wind too high | 2 m wind above 10 mph | Stop |
| Near the limit | 2 m wind above 8 mph | Caution |
| Shear | \|10 m wind − 2 m wind\| above 5 mph | Caution |

The worst result wins.

**Actions**, only when the status changes:
- Stop: `POST /hold` `{ id: "weather-agent-spray", jobTypes: ["spray"], fields: null, reason, by: "weather-agent" }`, plus one message to the coordinator.
- Go or Caution after a Stop: `DELETE /hold/weather-agent-spray`. Caution means "no hold", so a Stop → Caution change lifts the hold too.
- Caution: one message to the operator.
- The first Go of the day is recorded but not announced.

**Shared memory keys**

| Key | Value |
|---|---|
| `weather.spray` | `{ status, reason, triggers[], reading, since, transition, previous }`: the current decision and why |
| `weather.reading` | the latest reading `{ clock, minute, t2C, t10C, wind2Mph, wind10Mph, source, rules }` |
| `weather.hold` | `{ id, active, since }` |

**Record.** `agents/data/weather.jsonl` has every reading (with the rule result) and every status change with its triggers, readings, text and whether the model or the rules wrote it.

**Two heights.** From 06:32 to 08:46 in the simulated day the 2 m reading alone looks fine (3–5 mph), but the 10 m air is warmer: an inversion, so spraying stays stopped and the message says so. Test 1 checks the same case.

### What is simulated

- The weather. The default feed is a scripted day on the live runner's plan clock: 06:00 calm with an inversion (Stop), 06:32 wind reaches 3 mph but the inversion holds (Stop), 08:46 the inversion breaks (Go), 13:06 wind passes 8 mph (Caution), 13:50 wind passes 10 mph (Stop).
- With `WEATHER_SOURCE=nws`, the NWS hourly forecast for the depot in `GET /farm` gives the 2 m temperature and the 10 m wind. The 10 m temperature and the 2 m wind are **estimated** (log wind profile; an inversion is assumed on calm nights) and each reading lists them in `estimated`.

## Integration contract with the live runner (port 5190)

Polled, never pushed. Read: `GET /state` (`clock`, `secPerMin`, optional `mode` and `holds`, `tractors[]`, `jobs[]`, `trail[]`) and `GET /farm` (`home`, `fields[]`). Write: `POST /hold`, `DELETE /hold/<id>`, `POST /agent/say` and, sparingly, `POST /event` with `priority_change`. Until the write endpoints exist, a 404 is logged once and the call is kept and retried.

Checked against `agopen/live.js` in this checkout:
- `/hold`, `DELETE /hold/<id>` and `/agent/say` are not there yet.
- `GET /state` has no `mode` and no `holds`.

The runtime works without all of these (tests 8b and 8).
