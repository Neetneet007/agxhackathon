# Run the Fleet — AI Farm Orchestrator

A coordinator that assigns field jobs to a small fleet of autonomous tractors, re-plans in milliseconds when something goes wrong, and explains every change in plain language. It also answers "why?" for any assignment.

**Simulation:** we use **our own simulation**, not AgOpenWeb. It is a minute-by-minute farm sim on a 30×20 grid, with a creek crossed by two bridges, a depot (fuel and implement shed), 9 fields and 3 tractors. Judges score the coordinator, so we kept the sim small and spent our time on the planning.

**Stack:** Node.js 18+. The planner, simulator and CLI have no dependencies; the dashboard server uses the Anthropic SDK for optional Claude explanations, and the 3D view loads three.js from a CDN. The same coordinator code runs in the CLI and live in the browser.

## Run it

```bash
npm install                 # only needed for the dashboard server (Anthropic SDK)
node cli.js                 # demo day with scripted events: coordinator vs FCFS baseline → out/
node cli.js --no-events     # same farm, no disruptions
node cli.js --why J13       # print the "why?" explanation for any job
node stress.js 200          # 200 random scenarios: invariants + comparison
node serve.js               # 3D Command Center → http://localhost:5180/
```

To have Claude write the notifications and answer "why?" questions, start the server with an API key:

```bash
ANTHROPIC_API_KEY=sk-ant-... node serve.js
```

Without a key everything still works: notifications and answers come from the planner's own rule-based explanations, and the dashboard shows which one you're getting.

### 3D Command Center

- **3D farm** (three.js): fields with crop rows that fill in as work progresses, the creek and bridges, the depot, and a low-poly tractor for each machine with its current implement. The beacon is green while working, amber while driving and flashing red when broken down. Drag to orbit, scroll to zoom, and click a tractor or field for a pop-down card.
- **Re-routing in 3D:** each tractor's live route is a glowing path. When the planner re-routes it, the abandoned route fades out in red and the new one draws in. Planned future legs show as dashed lines. A closed bridge gets a red barrier and a flashing lamp, and every event sends a pulse ring out from where it happened.
- **Data sources:** every disruption comes from a named feed: tractor telematics (fault codes, fuel), the weather service, bridge water-level gauges, drone and satellite imagery, dealer service tickets, soil-moisture probes, or the operator. The Data sources panel shows each feed's latest reading and flags alerts. Notifications, the event log and Claude's explanations all cite the source.
- **A notification for every shift:** each re-plan drops down a notification with a short title and reason, written by Claude (Opus 5.5) from the planner's facts. Claude explains the decision; the algorithmic planner makes it. Each notification has Details (the planner's full change list) and **Why?**.
- **Ask why:** the copilot answers free-form questions about any plan change, job or tractor, grounded in the planner's reasoning, its rejected alternatives and the current feed readings.
- **Pop-down panels:** Fleet, Jobs, Data sources and Operator, plus a "Needs your decision" card for late or unfittable jobs, with Approve late / Drop / Why?.
- The original 2D dashboard is still at `/dashboard/classic.html`.

Operator controls:
- break or repair a tractor
- close or reopen a bridge
- change a job's priority or deadline
- submit a single job, or paste a JSON job list
- approve a late finish, or drop a job
- click any job to ask **why?**
- "Compare vs baseline" replays the same day, including your manual actions, with both dispatchers.
- Switch to **FCFS baseline** mode to watch the starter dispatcher run the same farm.

## Hand-in files

| Item | Where |
|---|---|
| Scenario (tractors, fields, jobs, events) | [`scenario.json`](scenario.json) |
| Event log of the demo run (coordinator) | [`out/event_log.txt`](out/event_log.txt) (human), [`out/event_log.jsonl`](out/event_log.jsonl) (machine) |
| Baseline event log, same run | [`out/event_log_baseline.txt`](out/event_log_baseline.txt) |
| Comparison against the baseline | [`out/comparison.md`](out/comparison.md), [`out/no-events/comparison.md`](out/no-events/comparison.md), [`out/stress_200.txt`](out/stress_200.txt) |

## Results

**Demo day with events.** Scripted events:
- 07:40: T1 (the main sprayer) breaks down for 2 h 50 min
- 08:30: an urgent new spray job arrives
- 09:20: the south bridge washes out
- 10:00: a hay field becomes high priority because rain is forecast
- 10:30: T1 is repaired

| Metric | Coordinator | FCFS baseline |
|---|---:|---:|
| Jobs completed (of 13) | **13** | 10 |
| …on time | **11** | 7 |
| Priority-weighted acres on time | **660** | 358 |
| Travel (tractor-min) | **746** (−26%) | 1004 |
| Idle in the working day (tractor-min) | 0 | 0 |
| Implement swaps | **3** | 5 |
| Unannounced constraint violations | **0** | 3 |
| Late jobs, each forecast and flagged to the operator when the event made it unavoidable | 2 | — |
| All work finished | **17:26** | not finished by 18:00 |

**Same farm, no events.**

| Metric | Coordinator | FCFS baseline |
|---|---:|---:|
| On time | **12 / 12** | 8 / 12 |
| Travel (tractor-min) | **540** (−39%) | 892 |
| Refuel stops / implement swaps | **4 / 2** | 6 / 4 |
| All work finished | **15:47** | not finished by 18:00 |

**200 random scenarios.** Each has random jobs, fuel levels and 0–4 events (breakdowns, repairs, closures, priority changes, new jobs).
- The coordinator does more priority-weighted on-time work in 168 of 200 scenarios, ties in 22 and is worse in 10.
- It completes 1387 jobs on time against 1108 for the baseline.
- It drives 18% less.
- It has **0** unannounced violations, against 346 for the baseline.
- No acre was lost or worked twice, and nothing crashed.
- The slowest re-plan took 9 ms.

### Metric definitions
- **Travel**: minutes spent driving, including trips to the depot.
- **Idle**: minutes a working tractor sat free, or waited for a field another tractor was on, while compatible work was still open. Counted up to that tractor's last task of the day.
- **Spare capacity**: minutes after a tractor's last task. The tractor finished early and is free for new work, so this is reported separately rather than as idle.
- **Broken-down time** is excluded from both.
- **Unannounced violations**: any deadline missed without prior warning, a fuel-reserve breach, a duplicate assignment or an unsafe plan.

## Architecture

This maps to the "AI Farm Orchestrator" layer of ATC's diagram.

```
 Operator ──jobs/events──► Coordinator (src/coordinator.js)
                              ├─ Fleet Agent       src/fleet.js       assign + order jobs
                              ├─ Navigation Agent  src/navigation.js  routes, closures, detours
                              ├─ Safety Agent      src/safety.js      checks every plan before release
                              ├─ Explainer         src/explain.js     plan diffs + "why?"
                              └─ Data sources      src/sources.js     telematics, weather, gauges, imagery, service, soil
 Claude explanations (optional)  src/llm.js via serve.js /api/explain, /api/why
                                          │ next job per tractor
                              Simulator (src/simulator.js) ── tractors, fuel, fields, interlocks
 Command Center dashboard (dashboard/) ◄──┘     Baseline FCFS dispatcher (src/baseline.js)
```

**Fleet Agent.** It plans by priority-first regret insertion, then local search with relocate, swap and eject-and-insert moves. Each candidate plan is scored by simulating every tractor's day with the same action rule the simulator executes (`src/model.js`): drive, swap implement, refuel, work. As a result the predicted plan matched the simulator to the minute in the no-event run.

**Hard constraints.** These are never broken:
- the right implement must be on board (a swap at the depot is planned when needed)
- fuel or battery never drops below a 10% reserve on any leg, with refuels inserted automatically
- the route must be reachable
- work must fit in the shift
- one tractor per job
- in-progress work is never pre-empted

**Objective.** The planner maximises on-time work weighted by priority × acres. It then minimises driving, finishes high-priority work early, avoids two tractors on one field at once, and keeps assignments stable across re-plans. A missed deadline costs most of a job's value. As a result, the planner only lets a job run late when an event makes that unavoidable. When it does, the job is flagged on the spot with the reason and the best achievable finish, and the operator can approve the late finish or drop the job.

**Re-planning.** The coordinator re-plans on every event: breakdown, repair, closure, reopening, priority change, new jobs, a dropped job, and each completed job.
- Completed work and partial progress are kept, down to the fraction of an acre.
- Only open work moves.
- The Safety Agent then re-checks the plan for duplicates, compatibility, fuel, deadlines, field conflicts and lost jobs before release. An unsafe plan is held, not executed.

**Explanations.** Every re-plan is logged with a headline, then what moved and why ("only working tractor with a sprayer", "T3 would miss the deadline", "+24 min detour via the north bridge"), then the before → after fleet finish time and the safety result. **Why?** for a job lists its slot, its slack against the deadline and its fuel at start. It also shows what each alternative tractor would have done: no implement, out of service, late, makes another job late, or extra driving.

**Baseline.** First come, first served: a free tractor takes the earliest-submitted unclaimed job it can do. It ignores priority and deadlines. It runs in the same simulator with the same routing and refuel rule, so the comparison is fair.

## Stretch goals covered
- [x] Blocked routes and changed priorities, as well as breakdowns (plus repairs, new jobs and dropped jobs)
- [x] Planning around fuel and battery levels: reserve-aware, with refuel stops inserted and a refuel-first rule so jobs aren't split by a mid-job refuel
- [x] Beats the FCFS baseline on completed work, deadlines, travel and idle time
- [x] Operator can ask "why?" about any assignment
- [ ] AgOpenWeb integration (not attempted; the coordinator talks to the simulator through a small dispatcher interface — `nextJob`, `onEvent`, `onJobDone` — so another simulator could sit behind it)

## Limitations
- Travel is grid-based (4-connected) with flat per-tractor speeds. There are no slopes, turning time or road speed classes.
- A field is a single work point. The coverage path inside the field is not modelled; work time is acres ÷ rate.
- The planner is a heuristic, not an exact optimiser. In 10 of 200 random scenarios the baseline did slightly more on-time work.
- When a disruption makes the day impossible, late work goes ahead automatically (flagged) so the fleet keeps working. Set `"policy": {"lateWork": "hold"}` in the scenario to treat deadlines as strictly hard instead. On the demo day that gives 11 jobs on time, 0 late and 2 carried over to tomorrow.
