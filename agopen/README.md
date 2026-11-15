# Live run on AgOpenWeb tractors

This is the live mode of the "Run the Fleet" project. The project's coordinator plans a day of field jobs for three tractors, and each tractor is a separate process driving its own AgOpenWeb instance. When a tractor stalls, the coordinator notices from the telemetry, hands the unfinished work to another tractor and explains the new plan.

**Does it use AgOpenWeb? Yes.** Each tractor is a real, running AgOpenWeb instance (a headless desktop build, one per tractor, on ports 5175 to 5177). Our process for that tractor connects to its WebSocket, takes the operator seat and drives it with the same simulator commands the AgOpenWeb web page uses. The fields, the guidance lines and the implements are read from AgOpenWeb's own files. We had to patch AgOpenWeb in three small places so several copies can run on one computer (see [Set up once](#set-up-once)).

**What is still simulated.** The GPS is AgOpenWeb's built-in simulator, not hardware. The plan's clock, fuel, job ordering and the planner's idea of time belong to the project's own planner simulator (`src/simulator.js`). Details are in [What is simulated, and known limits](#what-is-simulated-and-known-limits).

```
 coordinator (live.js)  ── commands ──►  tractor-node.js T1  ── WebSocket ──►  AgOpenWeb :5175
        ▲                               tractor-node.js T2  ── WebSocket ──►  AgOpenWeb :5176
        └────── telemetry, 4×/s ◄────── tractor-node.js T3  ── WebSocket ──►  AgOpenWeb :5177
```

The coordinator polls each tractor process four times a second. Each tractor process listens on its AgOpenWeb port plus 1000 (6175 to 6177).

A demo script for judges is in [DEMO.md](DEMO.md). The original planner, CLI and dashboard in the repo root are unchanged by the live mode and need none of this. See the [root README](../README.md).

## Contents

- [Set up once](#set-up-once)
- [Run it, and stop it](#run-it-and-stop-it)
- [What you see](#what-you-see)
- [Build a job list and start the day](#build-a-job-list-and-start-the-day)
- [Faults and how they are detected](#faults-and-how-they-are-detected)
- [People in the loop](#people-in-the-loop)
- [Fuel truck](#fuel-truck)
- [The roundtable of AI managers](#the-roundtable-of-ai-managers)
- [HTTP API on port 5190](#http-api-on-port-5190)
- [Tests](#tests)
- [Files](#files)
- [What is simulated, and known limits](#what-is-simulated-and-known-limits)

## Set up once

AgOpenWeb allows one copy per computer. The patch in `agopen/agopenweb/agopenweb-multi-instance.patch` changes three things:

| File patched in AgOpenWeb | Change |
| --- | --- |
| `RemoteServerHost.cs` | The environment variable `AGOPENWEB_PORT` sets the web port. |
| `SingleInstance.cs` | The single-copy lock gets the port in its name when `AGOPENWEB_PORT` is set, so one copy per port can run. |
| `ControlAuthority.cs` | When `AGOPENWEB_OPERATOR` is set, only a client whose name starts with that text can take control. Our tractor process connects as `Fleet-T1` and so on. Browser pages can then only watch, so an open page cannot take the seat. |

Each copy also gets its own data folder through `AGOPENWEB_DATA`, which AgOpenWeb already supports. `agopenweb/start-fleet.sh` sets all of this.

1. Clone [AgOpenWeb](https://github.com/AgOpenGPS-Official/AgOpenWeb) next to this repo (so the folders sit side by side) and install the .NET 10 SDK in `~/.dotnet`. `start-fleet.sh` sets `DOTNET_ROOT` to that folder.
2. In the AgOpenWeb folder, apply the patch:

```bash
git apply ../agxhackathon/agopen/agopenweb/agopenweb-multi-instance.patch
```

3. Build into `../agopen-multi/bin`:

```bash
DesktopOnly=true dotnet build Platforms/AgOpenWeb.Desktop -o ../agopen-multi/bin
```

4. Copy `agopen/agopenweb/start-fleet.sh` into `../agopen-multi/`, run it once so each copy creates its data folder, then stop it:

```bash
../agopen-multi/start-fleet.sh 3 && sleep 8 && ../agopen-multi/start-fleet.sh stop
```

5. In this repo, install the dependencies and write the farm and implement profiles into the three copies:

```bash
npm install && node agopen/build-farm.js
```

`npm install` also installs the Anthropic SDK that the roundtable uses.

I did not repeat this build on a clean machine while writing this file. The steps come from the scripts and the patch.

## Run it, and stop it

```bash
agopen/start-demo.sh
```

The script does five things, in this order:

1. Stops anything left from an earlier run.
2. Runs `build-farm.js`, which rewrites the nine fields and the implement profiles in all three AgOpenWeb copies. Work sessions and coverage from earlier runs are deleted.
3. Starts three AgOpenWeb copies and waits for ports 5175 to 5177.
4. Opens one Terminal window per tractor (telemetry once a second) and one for the coordinator.
5. Opens the status page at http://localhost:5190 and runs the preflight check.

The preflight (`node agopen/preflight.js`) prints one PASS or FAIL line per check and ends with `All checks passed. Ready to demo.` It checks Node 18 or later, the `ws` package, the patched build, each AgOpenWeb and tractor process, GPS at the farm, implement profiles, no leftover service lock, the coordinator, the fields, and that no tractor is in a fault state. You can run it again at any time.

```bash
agopen/start-demo.sh stop
```

This stops the tractor processes, the coordinator and the three AgOpenWeb copies, and removes the service locks.

Extra coordinator options go in `LIVE_ARGS`. For example, `LIVE_ARGS="--preset" agopen/start-demo.sh` starts with the 11 jobs from `scenario.live.json` already submitted instead of an empty list.

| Option | Where | Meaning |
| --- | --- | --- |
| `--preset` | `live.js` | Start with the scenario's job list already submitted and the day running. |
| `--auto-humans 6` | `live.js` | Press Good to go after 6 seconds. For unattended test runs only. |
| `--chaos 90` | `tractor-node.js` | Inject a random fault (`dead` or `stuck`) about every 90 seconds. |
| `--until 240` | `live.js` | End the run when the plan clock reaches that minute and write `out/live_metrics.json`. |
| `--script "30:fault T1 stuck;75:fault T1 ok;78:repair T1"` | `live.js` | Run commands at plan minutes. Plan minute 0 is 06:00. |
| `--sec`, `--cell`, `--nodes`, `--page`, `--fields` | `live.js` | Real seconds per plan minute, metres per plan cell, tractor process ports, status page port, AgOpenWeb fields folder. |

macOS only: the launcher uses `osascript`, Terminal and `open`. On another system, start `node agopen/tractor-node.js T1 5175 --depot` (and the same for T2 5176 and T3 5177) in three shells and then `node agopen/live.js` in a fourth.

## What you see

The status page at http://localhost:5190 shows, from top to bottom:

- The farm map, drawn from the field folders in AgOpenWeb. It shows the nine fields, the lanes and gates, the depot, each tractor's GPS position, the strips of ground already worked, and under each field name either its open jobs with percent done or its ground state (not plowed, plowed or sown).
- The job-list builder next to the map.
- The roundtable card: what the AI managers say about each event.
- A "Needs a person at the depot" card, which appears only when a tractor needs fuel or an implement change.
- One card per tractor: state, current task, fuel, mounted implement, a link to that tractor's own AgOpenWeb page (http://localhost:5175 and so on) and the fault buttons.
- "Messages between agents" (the trail, newest first) and the jobs table.

A **Start over** button (two clicks) and the plan clock are at the top, and a link opens the 3D view.

- `/3d` is a 3D view of the farm that draws the tractors from the same telemetry as the map. It needs the internet, because it loads three.js from a CDN.
- `/dashboard/?live=1` is the original Command Center, which keeps its own copy of the planner's world and replays the live run's log into it. It shows the planner's picture of the day, not the tractors' GPS positions. It is not linked from the status page.

Each tractor's own AgOpenWeb page is read-only for a browser, because of the patch. The detailed list of what the planner changed and why (one line per moved job) is printed in the coordinator's Terminal window. The status page shows the headline of each re-plan.

## Build a job list and start the day

The day starts with every tractor in its bay and an empty job list. Nothing moves until you press **Start the day**.

1. Click one or more fields on the map.
2. Click the operations in the order you want them: **Plow**, **Sow**, **Spray**, **Mow**. The number on each button is its order.
3. Choose a priority (high, medium or low) and **Finish by** (the default is 17:00).
4. Press **Add to list**. Repeat for other fields.
5. Press **Start the day**. You can still add jobs after the day has started.

The rules are the ones a foreman would apply. A list is added whole or not at all, and a refused step comes back with a plain reason.

| Ground state | Allowed | Refused with |
| --- | --- | --- |
| Not plowed | Plow, Spray, Mow | Sow: "has not been plowed. Add Plow before Sow." |
| Plowed | Sow, Spray, Plow | Mow: "is bare soil once plowed or sown. There is nothing to mow." |
| Sown | Spray | Sow again, or Plow: "Plowing it would destroy the seedbed." |

The check uses the ground state after everything already on the list is done. Plow always goes before Sow, whatever order you clicked. A Sow waits until the Plow on the same field has finished, and the status page shows it as "Waiting". Jobs that have not been sent to the planner can be removed. A finish time that has already passed is refused.

Under the hood, the plan clock starts at 06:00, and "Finish by" becomes a deadline in plan minutes. The planner (the project's own coordinator in `src/`) then assigns each job to a compatible tractor, plans implement changes and refuels at the depot, and orders the work.

### How a field is worked

- The field's outline and guidance (AB) line are read from its folder in AgOpenWeb (`field.geojson`).
- `coverage.js` plans parallel passes one implement width apart along that line, a lap round the boundary, and a straight run-up before each pass. The route belongs to the job, not to the tractor.
- The tractor opens the field in AgOpenWeb, starts an AgOpenWeb work session, selects the guidance line and turns section control on only while it is on a pass. AgOpenWeb therefore paints the worked ground.
- Progress is measured from the tractor's real position along its route. A job finishes when the route is complete, not when a timer runs out.
- Between fields, tractors follow a lane network that runs between the fields, crosses the creek only at the bridges and reaches each field at a gate (`lanes.js`).
- A give-way rule keeps tractors apart. If two moving tractors come within 9 m, the one doing less important work stops until they are 13 m apart. A tractor working a pass keeps going. Otherwise the lower-numbered tractor has right of way.

## Faults and how they are detected

The coordinator detects faults from telemetry. It does not trust a status flag.

| Type into a tractor's Terminal window | What the tractor does | What the coordinator sees |
| --- | --- | --- |
| `dead` | Stops answering and halts. | `NO_RESPONSE`: no telemetry for 3 seconds. |
| `stuck` | Keeps acknowledging GO, but the wheels stop. | `GO_NOT_MOVING`: told to go, more than 40 m from its target, moved less than 5 m for 8 seconds. |
| `ok` | Clears the fault. | `NO_RESPONSE` clears by itself once telemetry returns. For `stuck`, press **Clear fault** or type `repair T1` in the coordinator window. |

The status page has the same faults as buttons on each tractor card: **Inject: GO but not moving**, **Inject: stop responding** and **Clear fault**. You can also type into the coordinator window: `break T1`, `repair T1`, `fault T2 stuck|dead|ok` or `quit`.

Either symptom becomes a breakdown event for the coordinator. It marks the tractor out of service, returns its unfinished job to the pool and re-plans. The new assignee carries on from the job's route, so the passes already finished are not planned again (one caveat is in the limits table). Every hand-off is written to `agopen/out/trail.jsonl`. The coordinator empties that file each time it starts, so copy it before you press Start over or restart.

For each fault, the roundtable also holds a discussion (see below).

### Scripted test case

This runs 95 plan minutes: at 06:30 T1 is made to go stuck. The coordinator should detect it, move T1's jobs to T2 and T3, and give T1 work again after recovery. It needs the three tractor processes already running. I did not run it while writing this file, because a live demo was running.

```bash
node agopen/live.js --preset --auto-humans 6 --sec 1 --until 95 --script "30:fault T1 stuck;75:fault T1 ok;78:repair T1"
```

Without `--preset`, the job list starts empty and the script has nothing to disrupt. Without `--auto-humans`, a tractor sent to the depot waits for someone to press Good to go.

## People in the loop

Fuelling and implement changes are done by a person at the depot.

1. When the plan sends a tractor to refuel or change implement, a task appears under "Needs a person at the depot" (for example "Change T2's implement to Tiller 8m").
2. When the tractor is parked in its bay, its own process locks it. It will not move, whatever it is sent. The lock is saved in `agopen/out/lock-<id>.json`, so a restarted process is still locked.
3. The fuel gauge and the mounted implement do not change until someone presses **Good to go**. The button is disabled until the tractor is parked.
4. For an implement change, Good to go also loads that tool profile in the tractor's AgOpenWeb, so the farmer's own record matches.

## Fuel truck

TO BE COMPLETED

## The roundtable of AI managers

On each significant event, a few managers hold a short, visible discussion. The planner has already acted by then. The managers never delay a tractor. Full details are in [roundtable/README.md](roundtable/README.md).

Each manager is a language model plus one instructions file in `roundtable/agents/`. Each file gives one job and one thing the manager must never do.

| Manager | Its one job |
| --- | --- |
| Fault Manager | Say which tractor, what symptom, and whether it looks like a real fault or a recovery. |
| Fleet Manager | Say what the facts mean for the tractors: who is free, low on fuel or has the wrong implement. |
| Route Manager | Say what the facts mean for field coverage and lane routes. |
| Safety Officer | Say whether the situation is safe and object if tractors are close. |
| Depot Manager | Say what depot work is requested, in progress or finished. It may never release a tractor. |
| Weather Manager | Say whether spraying is allowed or held, and why. |
| Plan Manager (chair) | Read what the others said and decide what happens to the plan. Only the chair gets tools. |

How a discussion runs:

1. The managers for that event type speak in parallel. Each gets its own instructions file plus the facts (the event, the fleet's state and the open jobs).
2. The Plan Manager speaks last. It sees the others' lines and may call at most two tools. Three tools exist in the live run: `change_priority`, `approve_late` and `defer_job`. Each sends an event to the planner.
3. Discussions run one at a time. If more than three are waiting, the oldest waiting ones are dropped.

Discussions start when the day starts or new jobs arrive, when a detected fault becomes a breakdown, when a tractor is back in service, when a job finishes, when a tractor is locked at the depot, and when a hold or recall is placed or lifted. A breakdown you type as `break T1` (not detected from telemetry) starts a fault discussion only if a fault was detected earlier in the run, because the discussion uses the last detected fault's facts.

### With no key or no internet

- **No key.** The roundtable looks for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE`. With none, each manager's line is written by rules from the facts. The status page marks these lines "rule-written", and the Plan Manager never calls a tool. The tractors and the planner behave exactly the same.
- **A key but no internet, or a slow model.** Each model call stops after 6 seconds and the line falls back to the rule-written one. The code is written this way. I did not test it with the network off.
- **Where the key must be.** The launcher opens new Terminal windows, which start their own shells. Put the variable where a new shell reads it, such as your shell profile. I did not test whether a variable exported only in the shell that ran `start-demo.sh` reaches the coordinator window.
- **How to tell.** The roundtable card header counts lines, model calls, tool calls and rule-written lines. Zero model calls with some lines means the fallback is in use.
- **Model.** `claude-haiku-5-5` by default. Set `ROUNDTABLE_MODEL` to change it. With a key, the facts (tractor states, job names, times) go to the Anthropic API.

Outside agents can take part too. `POST /hold` and `POST /recall` let an agent stop a kind of work or call the fleet home, and `POST /agent/say` puts a message on the trail and in the roundtable card. A hold stops a tractor on a held job where it is, with the implement off, and the job makes no progress until the hold is lifted.

## HTTP API on port 5190

The coordinator serves everything on port 5190. There is no authentication, and the server listens on all network interfaces, so anyone on the same network can call these routes.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | The status page. Any GET that matches no other route also returns it. |
| GET | `/3d` | The 3D view of the farm (loads three.js from a CDN). |
| GET | `/state` | A JSON snapshot: plan clock, mode (`building` or `running`), job list, tractors with telemetry and state codes, jobs with percent done, ground states, worked-ground strips, holds, recalls, depot tasks, the trail and the roundtable lines and counts. |
| GET | `/farm` | The farm as read from AgOpenWeb's field folders: home point, depot, fields (boundary and guidance lines), lanes, gates and bays. |
| GET | `/replay` | The planner's log of events, holds and progress, which `/dashboard/?live=1` replays. |
| GET | `/scenario.json` | The scenario in use, with no scripted events. |
| GET | `/dashboard/...`, `/src/...` | Static files from the repo for the original dashboard. |
| POST | `/draft` | Add jobs to the list. Body: `{"fields": ["Ridge 80"], "steps": ["till", "seed"], "priority": "high", "deadline": "17:00"}`. Steps are `till`, `seed`, `spray` or `mow`. Returns `{"added": [ids]}`, or 409 with the reason in plain text. |
| POST | `/jobs` | The same for one step. Body: `{"fields": [...], "type": "spray", "priority": "medium", "deadline": "17:00"}`. |
| DELETE | `/draft/<job id>` | Remove a job that has not been sent to the planner, and any job that waits for it. |
| POST | `/start` | Start the day. 409 if it is already running or the list is empty. |
| POST | `/reset` | Start over: tractors go back to their bays and unlock, and the coordinator restarts with an empty list, the clock at 06:00 and an empty trail. |
| POST | `/human/<task id>/go` | Press Good to go for a depot task such as `H1`. 409 if the tractor is not parked yet. |
| POST | `/event` | Give the planner an event: `breakdown`, `repair`, `block_route`, `unblock_route`, `priority_change`, `cancel_job` or `new_jobs`. It applies at the current plan time. Events the planner cannot apply are ignored. |
| POST | `/hold` | Place a hold. Body: `{"id": "wind", "jobTypes": ["spray"], "fields": ["Ridge 80"], "reason": "...", "by": "weather-agent"}`. `jobTypes` can be `["*"]`. `fields` is optional. |
| DELETE | `/hold/<id>` | Lift a hold. |
| POST | `/recall` | Send every tractor back to its bay and keep it there. Body: `{"id": "...", "reason": "...", "by": "..."}`. |
| DELETE | `/recall/<id>` | End a recall. |
| POST | `/agent/say` | Put a message on the trail and in the roundtable card. Body: `{"from": "...", "to": "...", "type": "note", "text": "..."}`. The text is cut to 400 characters. |
| POST | `/cmd/<command>` | Run a coordinator command, URL-encoded: `break T1`, `repair T1`, `fault T1 stuck`, `fault T1 dead`, `fault T1 ok` or `quit`. `quit` ends the run. |

Invalid JSON in a body returns 400. A request to an unknown path other than a GET still returns the status page with status 200.

Each tractor process has its own small API on its port (6175 to 6177):

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/telemetry` | Position (east and north in metres from the depot, and latitude and longitude), heading, speed, last command and acknowledgement, AgOpenWeb field and job, worked area, implement profiles read from AgOpenWeb, service lock, link state. |
| POST | `/command` | The coordinator's order: `goto` with a target, an optional line to hold, and whether the implement is on, or `stop`. It is always acknowledged, even by a stuck tractor. |
| POST | `/service`, `/release` | Lock the tractor for depot work, and release it (Good to go). |
| POST | `/fault/<ok\|dead\|stuck>` | The same faults you can type into its window. |
| POST | `/home` | Back to the bay, unlocked, no fault. |

## Tests

```bash
npm test
```

This runs `node --test agopen/test/` from the repo root. It needs no AgOpenWeb and does not touch a running demo. On 2026-11-15 it printed:

```
# tests 44
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 1
```

It takes about 0.3 seconds.

| File | Tests | What it checks |
| --- | --- | --- |
| `coverage.test.js` | 14 | Field coverage routes: rectangles at four implement widths, a rotated field, a trapezoid, passes parallel to the guidance line and one width apart, alternating direction, the nearest start, progress and winding order. At least 99.5% planned coverage for rectangles, 98% for the trapezoid. |
| `faults.test.js` | 13 (12 pass, 1 todo) | Injected faults against the planner's simulator on the live scenario: a tractor breaks mid-job and another finishes it with no lost or repeated acres; each tractor in turn breaking early; a job nobody can do is flagged, not dropped; an urgent job fitted in; implement changes planned; fuel never below the reserve; no job held by two tractors; a tractor held at the depot does not move or gain fuel; more on-time jobs than first come, first served; the same faults give the same result twice. |
| `lanes.test.js` | 8 | Every field has a gate, routes stay out of fields, the creek is crossed only at the bridges, routes are deterministic. |
| `roundtable.test.js` | 7 | Rule-written lines with no model, managers get no tools, the chair's tool calls (a third is refused), timeouts and errors fall back, the queue drops the oldest beyond three, seven managers are loaded. |

`agopen/test/TEST_REPORT.md` is a table of the fault cases with the numbers from one run, including a comparison against first come, first served on a breakdown day. `node agopen/test/report.js` regenerates it. `npm test` does not, so it can fall behind the code. The copy in the repo was generated on 2026-11-15 at 21:17 UTC.

**The one known gap (marked `todo`).** When the only tractor that can do a job breaks down, the planner says the job was "re-assigned" and says nothing about the job at that moment. The only warning comes at the end of the day, as "not completed". The test for a plain warning at the time of the breakdown is marked `todo` and does not fail the run. In practice an operator would not hear about the stranded job until the day ends.

**What the tests do not cover.** They test the planner and simulator, the coverage geometry, the lanes and the roundtable. They do not test `live.js`, `tractor-node.js`, the fault-detection thresholds, the link to AgOpenWeb or the web pages. Those are checked by `preflight.js` and by running the scripted case above by hand.

## Files

| Path | What it is |
| --- | --- |
| `live.js` | The runner. Plans with the coordinator, sends commands to the tractors, detects faults, serves the status page and the API on port 5190. |
| `tractor-node.js` | One process per tractor. Wraps one AgOpenWeb, takes commands, reports telemetry, accepts the service lock and injected faults. |
| `tractor.js` | The client for one AgOpenWeb's WebSocket: takes the operator seat, decodes state frames, steers, sets speed, switches section control and opens fields. |
| `coverage.js` | Plans the passes, run-ups and headland lap for a field, and measures how much of it a route covers. Convex fields only. |
| `lanes.js` | Builds the farm's lane network: lanes between fields, creek crossings at bridges, a gate per field. |
| `rig.js` | The four implements (profile name and width), the work-rate formula and the pass speed. |
| `build-farm.js` | Writes the scenario's fields and the implement profiles into every AgOpenWeb copy, and `farm.json`. Stands in for drawing fields in AgOpenGPS. |
| `preflight.js` | The readiness check. |
| `start-demo.sh` | The one-command launcher and stopper (macOS). |
| `live.html` | The status page. |
| `live3d.html` | The 3D view, served at `/3d`. |
| `scenario.live.json` | `scenario.json` with every implement on two tractors, so any single breakdown can be covered, and no scripted events. |
| `farm.json` | Written by `build-farm.js`: the depot's latitude and longitude, metres per plan cell (20) and the fields. |
| `agopenweb/` | The patch to AgOpenWeb and `start-fleet.sh`. |
| `roundtable/` | The roundtable engine, a smoke script and the seven instructions files in `agents/`. |
| `test/` | The tests, `report.js` and `TEST_REPORT.md`. |
| `out/` | Written while running: `trail.jsonl` (the event log of the run), `live_metrics.json` (written when a run ends), `lock-<id>.json` and the logs. |

### Hand-in items for the live mode

| Item | Where |
| --- | --- |
| Code | This repo. |
| How to run, and whether AgOpenWeb was used | This file. AgOpenWeb is used. |
| Scenario and configuration | `scenario.live.json`, `farm.json` |
| Event log of the demo run | `agopen/out/trail.jsonl` (emptied each time the coordinator starts) |
| Comparison with first come, first served | `out/comparison.md` and `out/stress_200.txt` in the repo root (from the planner's own simulator), and the breakdown-day table in `agopen/test/TEST_REPORT.md`. The live run does not run a baseline. |

## What is simulated, and known limits

**Real, from AgOpenWeb:** each tractor's GPS position, heading and speed; the field outlines, guidance lines and implement widths; work sessions and worked area in each tractor's own record.

**Simulated:**

- The GPS and vehicle motion are AgOpenWeb's built-in simulator. There is no hardware.
- Fuel, job timing and the plan clock belong to the planner's simulator. The fuel gauge on the status page is the planner's number. AgOpenWeb has no fuel.
- Refuelling and implement changes are done by a person pressing a button. Nothing moves fuel or an implement physically.

**Known limits:**

| Limit | What it means |
| --- | --- |
| Field shapes are not surveyed | Each field is a rectangle from the scenario's grid, 3 m in from the grid lines, placed at a real location (the depot at 32.72, -114.6741, in the Yuma Valley). Each field is 1 to 2 acres, because the area is taken from the outline. The scenario's own acre figures (18 to 48 acres) are replaced by the outline area. |
| Only convex fields | `coverage.js` insets and clips convex polygons only. A concave outline from AgOpenWeb would not be planned correctly. I did not test one. |
| Steering is our own | On a pass the tractor process holds the line with its own controller, through AgOpenWeb's simulator controls (`sim.setSteer` and the speed steps). AgOpenWeb's own autosteer is switched off, so every pass is driven the same way. AgOpenWeb still shows the guidance line, because the field is opened and line 0 is selected. |
| Fuel and time are the planner's | Work rates (acres per hour) come from implement width and speed with the usual field-capacity formula. The planner uses them for its time and fuel estimates. A job still finishes when the route is complete. |
| The plan clock runs fast | One plan minute is 1.8 real seconds, so the plan clock runs about 33 times faster than a wall clock. Tractors move at real speed (lanes up to 20 km/h) and the fields are only about 100 m across. |
| Opening a field moves the simulated tractor | AgOpenWeb's simulator jumps the tractor to the middle of a field when it is opened. The tractor process remembers the position and sets it straight back. This is a workaround. |
| Headland corners can leave small wedges | The planner's own coverage measure counts the implement as extending half a width past each end of a leg. A real tractor turning at a corner may not sweep that. On the nine farm fields the planner reports 100% coverage at all four widths (my own run of `planCoverage`, not part of `npm test`). That measures the plan, not AgOpenWeb's painted area. I did not compare the two. |
| A hand-over restarts the interrupted pass | A job's route is kept when another tractor takes over, but the new tractor drives the interrupted pass again from its start. The code comment says nothing is repeated. By my reading of `live.js`, one pass can be driven twice. I did not watch it. |
| Fault detection has blind spots | `GO_NOT_MOVING` is only checked when the tractor is told to go, is more than 40 m from its target, and is not opening a field. A tractor that stalls within 40 m of its target is not caught by this check. There is no check for a tractor that leaves its lane or drives slowly. |
| Lanes do not change | The lane network is built once. A `block_route` event changes the planner's travel times but not where the tractors drive. I did not test this. |
| Give-way is simple | It stops one tractor when two moving tractors come within 9 m. It does not plan around a tractor that is standing still in the lane. |
| No persistence | The job list, the trail and the roundtable lines live in memory. Start over, or a restart, loses them. `out/trail.jsonl` is emptied at each start. |
| No authentication | Anyone on the network can call the API. |
| macOS only for the launcher | `start-demo.sh` uses `osascript`, Terminal and `open`. The window positions assume a screen about 1920 pixels wide. |
| Paths are fixed | `build-farm.js`, `tractor-node.js` and `live.js` look for `../agopen-multi` next to the repo. Only `start-demo.sh` honours `AGOPEN_MULTI`. The status page and the fields are read from tractor 1's AgOpenWeb folder, so a field added by hand must be copied into all three. |
| The 3D view and the roundtable need the internet | The 3D view loads three.js from a CDN. The roundtable calls the Anthropic API. Without the internet the status page, the planner and the tractors still work. |
| Tests do not cover the live runner | See [Tests](#tests). |
