# Agents: the team that runs the farm

Eight agents on one durable runtime. Each agent is a language model plus an instructions file, doing one job for the whole farm. It calls plain-code tools, shares memory, and speaks at the operator's roundtable. Everything here lives under `agents/`; nothing else in the repo is touched.

```bash
node agents/server.js                                   # all eight agents, rule-only, API on http://127.0.0.1:5200
WEATHER_DAY=monsoon node agents/server.js               # or hurricane; default calm
ANTHROPIC_API_KEY=sk-ant-... node agents/server.js      # model in the loop (needs npm install in the repo root for @anthropic-ai/sdk)
node --test agents/test/                                # all tests against a fake live runner; no demo needed
FUZZ_RUNS=100 node --test agents/test/fuzz.test.js      # 100 random days, eight invariants each (default 12)
curl 'http://127.0.0.1:5200/ask?q=What+soil+is+Bottomland+on'   # ask the team a question
```

| Variable | Default | |
|---|---|---|
| `AGENTS_PORT` | `5200` | API port (reserved ports are refused) |
| `RUNNER_URL` | `http://127.0.0.1:5190` | live runner; must be a local address |
| `AGENTS_DATA` | `agents/data` | durable log, journals, day summaries (git-ignored) |
| `AGENTS` | all | comma list of agent folders to run |
| `POLL_MS` | `1000` | how often `GET /state` is polled (real ms) |
| `AGENT_MODEL` | `claude-haiku-5-5` | any Claude model id, or `off` for rule-only |
| `WEATHER_DAY` | `calm` | `calm`, `monsoon` or `hurricane` (all simulated) |
| `WEATHER_SOURCE` | `sim` | `nws` for National Weather Service forecasts and alerts (internet; off by default) |
| `WEATHER_SCRIPT` | — | JSON file of snapshots `[{ "at": "HH:MM", "t2C", "t10C", "wind2Mph", "wind10Mph", "gustMph", "alerts": [], ... }]` |

## The team

| Folder | Speaks as | One job | Wakes when | Never |
|---|---|---|---|---|
| `plan` | Plan Manager (chair) | Owns today's plan; decides what gives | a request from another agent, a stop/recall/fault to close, a job running late | moves a tractor; overrides a safety or weather stop |
| `fleet` | Fleet Manager | Knows every tractor | a tractor drops below 25 % fuel; asked to fuel the fleet | releases a tractor from the depot |
| `fault` | Fault Manager | Is a tractor really in trouble? | a symptom lasts 3 checks in a row (silent, GO but not moving, off its line) | declares a fault from one reading; repairs anything |
| `route` | Route Manager | Coverage and lane routes | a job starts | sends a tractor across a field that is not its job |
| `depot` | Depot Manager | People's work: fuel, implements, inspections | a request arrives; a task waits 10+ plan minutes | releases a locked tractor; marks an inspection done |
| `weather` | Weather Manager | What the weather allows, now / today and tomorrow / days ahead | the playbook's decision changes; hourly | lifts a stop it did not place |
| `safety` | Safety Officer | Checks plans and recalls; watches spacing | two tractors under 15 m apart for 2 checks; a tractor working against a stop | is overruled by another agent |
| `agronomy` | Agronomy Advisor | What the field and crop mean for a job, from the farm plan and the real soil survey and elevation in `dashboard/gis/` | a job starts | acts at all: it has no acting tool, and its notes are advice only until a person adds and checks a source |
| `records` | Record Keeper | The day's record | each job done, each stop, end of day (18:00) | changes a record after the fact |

The live runner has its own model voices for some roles on the same roundtable. These agents speak only when they hold new facts for the role, so the two don't say the same thing twice.

A discussion looks like this. The agent that noticed speaks first; the agents affected add a line; the Plan Manager closes with the decision. Monsoon day, abridged, rule-only:

```
Weather Manager → Plan Manager: Now: Holding spray work, recalling the fleet to the depot. Rules drift-wind and lightning both apply;
                                 the more cautious wins (lightning). Lightning within 10 miles ... [rule drift-wind (...), lightning (National Weather Service +1)] (simulated weather)
Weather Manager → Depot Manager: Nobody works at the depot until further notice: ... [rule lightning (National Weather Service +1)]
Depot Manager → operator:        Nobody should work at the depot now; fuelling, re-fitting and inspections wait until it is safe.
Plan Manager → operator:         Decision: the plan pauses while the fleet is recalled; jobs resume in priority order when the recall ends.
```

## Ask the team

`GET /ask?q=<question>&agent=<name>` or `POST /ask {"question": "...", "agent": "weather"}`. Leave `agent` out and the question goes to the one or two agents whose job it is, by topic: weather, tractors and fuel, faults, routes, the depot and its people, safety and stops, the plan and deadlines, the day's record, and soil, crops and field work.

- **No key:** plain code answers from the live state and that agent's shared memory (`runtime/ask.js`; an agent can export its own `answer(ctx, question)`, as `agronomy` does).
- **With a key:** the agent's own `AGENT.md`, the same facts and only its `kind: 'reads'` tools go to the model, which writes the answer. A model error leaves the plain-code answer in place.
- **Asking never acts.** No hold, recall, event or message is sent. The randomised test checks this on every question.
- **What it will not do.** It does not invent rates, products or dates. For irrigation, fertiliser, pests, harvest timing, planting and livestock it says what the team knows, what it does not, and who decides (`agronomy/guide.json`, `topics`).

## Randomised days

`agents/test/fuzz.test.js` builds a different day from each seed: weather with missing and impossible readings and alerts nobody has heard of, tractors that crowd each other, run low on fuel, go silent or report nothing, jobs starting and finishing, a runner that answers 404 for a while, restarts from the durable log, people clearing inspections, and questions to the team. After each day:

1. nothing outside the allowlist was called;
2. only the four allowed event types were sent;
3. a hold and a recall placed by a person are still in force, and every lift is of something an agent placed;
4. the Agronomy Advisor only advised;
5. every weather stop or recall names rules that exist, are verified and have a source;
6. every spoken line fits the runner's 400 characters;
7. no side effect was sent twice: one successful call per finished effect, across 404s and restarts;
8. each agent wrote only its own keys in shared memory.

A failure prints its seed; `FUZZ_RUNS=1 FUZZ_SEED=<seed>` replays that day exactly.

## How every agent works

An agent is a folder: `AGENT.md` (the instructions) and `tools.js` (`export default { displayName, sense, plan, act, tools, people? }`). A new agent is a new folder; the runtime needs no change.

1. **`sense(ctx)`** runs on every poll. It is cheap plain code: it reads `/state`, keeps its part of shared memory current, and returns a reason when its trigger fires.
2. **`plan(ctx)`** checks whether there is anything to decide. `null` ends the wake-up with **no model call**.
3. **`act(ctx)`** is the fast path, also plain code: holds, recall, closed bridges, priority changes. These go out at once, before any model is asked; `fastMs` on each run shows how long it took (a few ms).
4. **The model** gets the agent's `AGENT.md`, its tools, and the statements the rules produced. It writes the words with `speak` and may call the agent's other allowed tools. A tool refuses anything the rules don't allow.
5. **Templates.** Every statement the model did not write goes out as its template sentence. With no key, no network, a timeout or an error, steps 1–3 and 5 still happen, so the actions are identical.

## What the runtime guarantees

- **Durable log.** `agents/data/runtime.jsonl` is fsync'd before anything is acted on. It holds every wake-up, model call and result, tool call and result, message, memory write, side effect start/done/failure, and person action. On start the runtime replays it to rebuild its state.
- **No repeated side effects.** Every call that changes something outside the runtime has a stable id and is committed together with the memory change that caused it.
  - Done: never sent again.
  - In flight at a crash: retried once on restart.
  - Runner down or 404: kept and retried, in order per resource.
- **Shared memory** is key-value with history. Every agent can read every key; an agent writes only `<its-folder>.*`.
- **Messages** are delivered on the recipient's next wake-up and mirrored to `POST /agent/say` under the role's display name.
- **Allowlist.** Only these calls can leave the process; everything else is refused before any network traffic.

  | Allowed | Notes |
  |---|---|
  | `GET /state`, `GET /farm` | |
  | `POST /hold`, `DELETE /hold/<id>` | |
  | `POST /recall`, `DELETE /recall/<id>` | |
  | `POST /agent/say` | |
  | `POST /event` | only `priority_change`, `cancel_job`, `block_route`, `unblock_route` |

  Refused includes `/human/*/go`, `/cmd/*`, `/start`, `/draft`, and `breakdown`/`repair` events.
- **People keep the final say.** `POST /people/depot/inspection_done {"id": "I3", "by": "Sam"}` is the only way an inspection is marked done. No agent tool can call it, the model is refused, and the action is logged with the person's name.

## API (port 5200)

| | |
|---|---|
| `GET /health` | runner reachability, plan clock, model on/off and why, log size |
| `GET /agents` | each agent: display name, job, status, last run (with `fastMs`), counts (`senses`, `wakes`, `wakesWithModelCall`, `idleWakes`, `modelCallRatio`), pending side effects |
| `GET /agents/<name>` | the same plus its instructions and tools |
| `GET /agents/<name>/runs?limit=50` | wake-ups, newest first, with every step (model calls, tool calls, results) |
| `GET /messages?since=<n>` | the roundtable after message `n` |
| `GET /memory`, `GET /memory?key=<k>` | current values; one key with its history |
| `GET /effects` | every side effect and its state |
| `POST /agents/<name>/wake` | wake an agent on the next poll |
| `POST /people/depot/inspection_done` | a person reports an inspection done: `{ "id" or "key", "by" }` |

## The Weather Manager and its playbook

The rules are data: `weather/playbook.json`. Each rule has the following fields:
- `id`, `hazard` and `phase` (before / during / after)
- `scale`: now, today, or days
- `trigger`: a condition on readings, forecast, alerts or history
- `actions`
- `explain`: a sentence template
- `source[]`: title, publisher, URL and date read
- `verified`

**A rule with no source, or `verified: false`, may only advise.** It can post a Caution. It cannot place a hold, recall the fleet, close a route or change the plan. Every action message ends with the rule ids and their publishers, so the operator can always ask "says who?".

Actions the playbook can take:

| Action | What it does |
|---|---|
| `hold_spray`, `hold_types`, `hold_all`, `hold_low_fields` | `POST /hold` with ids `wm-spray`, `wm-types`, `wm-all`, `wm-lowfields` |
| `recall` | `POST /recall` with id `wm-recall` |
| `block_bridges` | `block_route` events for North bridge `[15,4]` and South bridge `[15,15]` |
| `reprioritise*` | a request to the Plan Manager, who decides |
| `fuel_all` | a request to the Fleet Manager, who asks the Depot Manager |
| `tell_depot`, `secure_depot`, `no_depot_tasks` | requests to the Depot Manager |
| `inspections` | an inspection round for people |

Two or more rules asking for different levels of action resolve to the most cautious, and the message names both rules. The Weather Manager lifts only holds and recalls it recorded placing itself. It never touches `safety-stop` or anything a person placed.

**After a flood or a storm nothing restarts by itself.** The "after" rule opens inspections through the Depot Manager: every machine, lane and bridge, and the low fields (flood) or every field (storm). While any machine, lane or bridge inspection is open, the recall and the bridge closures stay. Each field's hold is lifted when a person clears that field.

### Playbook rules and their sources (read 2026-11-15)

The sources were found through web search on 2026-11-15. Pesticide pages could not be opened by the page reader (it refused them), so those were checked through search excerpts. Every rule's `checked` field says how it was read.

| Rule | Hazard | Can act? | Source |
|---|---|---|---|
| `drift-wind` | Spray drift: wind | **yes** | [Washington State University Tree Fruit (product label)](https://treefruit.wsu.edu/?p=10273), [University of Minnesota Extension](https://extension.umn.edu/agriculture/crop-production/weed-management/avoiding-herbicide-drift) |
| `drift-inversion` | Spray drift: inversion | **yes** | [North Dakota State University Extension](https://www.ndsu.edu/agriculture/extension/publications/understanding-air-temperature-inversions-relating-pesticide-drift), [Virginia Cooperative Extension](https://www.pubs.ext.vt.edu/SPES/spes-827-understanding-temperature-inversions-protecting-against-pesticide-drift-during-aerial-drone-spray-applications.html) |
| `drift-shear` | Wind shear between 2 m and 10 m | no (advice only) | none: 5 mph is a farm choice |
| `drift-wind-near-limit` | Wind near the upper limit | no (advice only) | none: 8 mph is a farm choice |
| `rain-after-spray` | Rain soon after spraying | no (advice only) | [University of Missouri IPM](https://ipm.missouri.edu/MEG/2018/3/rainfastness_pesticides/): the rain-free period must come from the product label |
| `rain-before-dry-job` | Rain before a dry-ground job | no (advice only) | none found |
| `wet-soil` | Wet or saturated soil | no (advice only) | none: the machinery limit is farm- and soil-specific |
| `freeze-warning` | Frost or freeze | **yes** | [National Weather Service](https://www.weather.gov/abr/FallFrostFreezeDSSPage) |
| `extreme-heat` | Heat for people at the depot | no (advice only) | [OSHA, archived page](https://webarchive.library.unt.edu/web/20121016220915/http://www.osha.gov/SLTC/heatillness/heat_index/index.html): current page not confirmed |
| `dust-storm` | Dust storm | **yes** | [NWS definitions](https://www.weather.gov/otx/Watch_Warning_Advisory_Definitions), [NWS SCN 18-90](https://weather.gov/media/notification/pdfs/scn18-90swq_dsw_oper_aaa.pdf) |
| `lightning` | Thunderstorm and lightning | **yes** | [NWS lightning safety](https://www.weather.gov/media/owlie/LightningSafety-OnePager-11-29-18.pdf), [NOAA JetStream](https://noaa.gov/jetstream/lightning/lightning-safety) |
| `high-wind` | High wind | **yes** | [National Weather Service](https://www.weather.gov/dtx/noPrecip_defs) |
| `wind-advisory` | Strong wind below warning level | **yes** | [National Weather Service](https://www.weather.gov/dtx/noPrecip_defs) |
| `flood-watch` | Flood watch | **yes** | [National Weather Service](https://www.weather.gov/safety/flood-watch-warning) |
| `flood-warning` | Flood warning | **yes** | [NWS](https://www.weather.gov/safety/flood-watch-warning), [NWS glossary](https://forecast.weather.gov/glossary.php?word=Flash+Flood) |
| `creek-gauge` | Creek gauge over the farm's limit | no (advice only) | none: 1.5 m is a placeholder; the official warning triggers the closures |
| `after-flood` | After a flood | **yes** | [FDA flood-affected food crops guidance](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-evaluating-safety-flood-affected-food-crops-human-consumption) |
| `tropical-watch` | Hurricane / tropical storm watch | **yes** | [NOAA National Hurricane Center](https://www.nhc.noaa.gov/watchwarn_changes.shtml) |
| `tropical-warning` | Hurricane / tropical storm warning | **yes** | [NOAA National Hurricane Center](https://www.nhc.noaa.gov/watchwarn_changes.shtml) |
| `storm-conditions` | During the storm | **yes** | [NOAA National Hurricane Center](https://www.nhc.noaa.gov/watchwarn_changes.shtml) |
| `after-storm` | After the storm | **yes** | [NOAA](https://noaa.gov/node/11994), [CDC](https://www.cdc.gov/hurricanes/safety/how-to-safely-stay-safe-after-a-hurricane-or-other-tropical-storm.html) |
| `wildfire-evacuation` | Evacuation order | **yes** | [Ready.gov (FEMA)](https://www.ready.gov/wildfires) |
| `smoke-aqi` | Heavy smoke | no (advice only) | [Cal/OSHA](https://dir.ca.gov/dosh/wildfire/worker-protection-from-wildfire-smoke.html): California rule, not Arizona |
| `unknown-signal` | Missing or impossible reading | **yes** | the farm's own policy (see below) |

Where sources gave a range, the more cautious value is used and the rule's `note` says so. For example, labels allow 3–10 mph and only ask for an inversion check below 3 mph; this farm stops below 3 mph outright.

<a id="unknown-signals"></a>**Unknown signals.** A missing or impossible reading holds all work and asks a person to check the station. This rule's authority is the farm's own operating policy (ground rule 7 of the team brief), not an outside body, and the rule says so.

**Farm facts** in `weather/farm-risk.json` are this farm's own judgement and should be confirmed by a person:
- Low fields: Creek Pasture, Bottomland and South Flats.
- Bridges: North `[15,4]` and South `[15,15]`, from `scenario.json`.

### Shared memory keys

| Key | Owner | Value |
|---|---|---|
| `weather.status` | weather | `{ level: Go/Caution/Stop/Recall, fired: [ruleIds], since, summary }` |
| `weather.reading` | weather | latest `{ clock, minute, reading, forecast, alerts }` |
| `weather.actions` | weather | holds, recall and closures this agent placed (the only ones it may lift) |
| `weather.episode` | weather | open after-flood / after-storm inspection round |
| `depot.inspections` | depot | `[{ id, key, kind, what, where, status, by, doneAt }]` |
| `depot.requests`, `depot.paused` | depot | requests from other agents; whether depot work is paused |
| `fleet.tractors` | fleet | brief state of every tractor |
| `fault.verdicts`, `fault.history` | fault | current verdict per tractor; all verdicts |
| `plan.deferred`, `plan.atRisk` | plan | jobs deferred to tomorrow; jobs flagged at risk |
| `route.jobs` | route | route facts per started job |
| `safety.stop` | safety | its own stop, if in force |
| `records.jobs`, `records.stops`, `records.summaryWritten` | records | append-only day record |

### What is simulated

- **The weather.** All three scripted days are simulated, and every weather statement from them is labelled "(simulated weather)".
- **NWS mode.** `WEATHER_SOURCE=nws` uses real NWS forecasts and alerts. NWS gives one height only, so the 10 m temperature and 2 m wind are estimated, and each reading lists them under `estimated`.
- **Route figures.** Coverage and lane lengths come from `agopen/coverage.js` and `agopen/lanes.js`, imported read-only, when the checkout has them; otherwise the tools say "not available".

## Contract with the live runner (port 5190), as found

Checked against `agopen/live.js` on `agopen-bridge` at `22b4768`:
- **Present:** `/hold`, `/recall` and `/agent/say`, plus `holds`, `recalls`, `tasks` and `mode` in `/state`.
- **Different from the contract:**
  - `DELETE /hold/<id>` lifts **any** hold, whoever placed it. Our agents enforce "only lift your own"; the runner does not.
  - The runner keeps 400 characters of each spoken line. The runtime trims the words, never the rule tag.
- **Not yet on `main`:** that commit isn't merged, so this PR (based on `main`) cannot import `coverage.js` or `lanes.js`. The Route Manager says "not available" there.
