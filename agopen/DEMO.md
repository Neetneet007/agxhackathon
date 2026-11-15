# Five-minute table demo

This script shows the live mode (see [README.md](README.md)) to judges in five minutes, then takes questions. The track is "Run the Fleet": a coordinator that assigns jobs to a small fleet of tractors and re-plans when something breaks.

The point to land: **a real AgOpenWeb instance drives each tractor, a fault is detected from telemetry, no work is lost, and the new plan is explained in plain language.**

## How the five minutes map to the brief

| Time | Step | Must-have in the brief | Rubric row | Mentor's point |
| --- | --- | --- | --- | --- |
| 0:00 | Frame it | | Explanations and demo | |
| 0:30 | Build the job list | Take an operator's job list | Constraint compliance | |
| 1:15 | Start, implement change, Good to go | Assign compatible tractors (capabilities, implements, fuel) | Constraint compliance | One task per agent (the Depot Manager) |
| 2:00 | Watch the passes | Show progress on a dashboard or map | Completed work | |
| 2:45 | Inject a fault | Recover from a breakdown with no conflicts or lost work; explain the new plan | Adaptation to events; explanations and demo | Tools, shared memory, agents talking |
| 4:15 | Clear the fault | Recover | Adaptation to events | |
| 4:40 | Close with the comparison | A comparison against first come, first served | Operational efficiency | |

The tiebreaker is "would a farm operator trust this plan?" Keep it in mind in every sentence: the plan is explained, a person does the fuelling, and nothing is hidden.

## Before the judges arrive

Do this about ten minutes ahead.

- [ ] Run the launcher and wait for the preflight to finish.

```bash
agopen/start-demo.sh
```

- [ ] The last line of the preflight must read `All checks passed. Ready to demo.` You can run it again at any time.

```bash
node agopen/preflight.js
```

- [ ] If you rehearsed, copy `agopen/out/trail.jsonl` somewhere safe first if you want that log, then press **Start over** (two clicks) on the status page. The coordinator restarts with an empty job list at 06:00, and the trail file is emptied.
- [ ] Open http://localhost:5190 in the browser, at a zoom where the map, the job builder and the roundtable card are all visible. Leave the page open.
- [ ] Open a second tab at http://localhost:5190/3d, and load it while you still have the internet. It loads three.js from a CDN. If the internet is down, skip the 3D view and use the map.
- [ ] Open one tractor's own AgOpenWeb page (for example http://localhost:5175) in a third tab, so judges can see the real application behind T1. It is watch-only.
- [ ] Arrange the windows. The coordinator's Terminal window must be visible, because it lists every job the planner moved and why. The three tractor windows show telemetry once a second. The launcher places the windows for a screen about 1920 pixels wide.
- [ ] Check the roundtable. If you have an Anthropic key, set it where a new shell reads it (see the README) before you start. After the first discussion, the roundtable card header counts model calls. Zero model calls means the managers are rule-written. Either is fine for the demo, but know which one you have.
- [ ] Have two fallback tabs ready: `out/comparison.md` and `agopen/test/TEST_REPORT.md`.
- [ ] Rehearse once and time it. I did not time a full demo run. From one earlier run, a single one-pass spray job took about two minutes of wall time, so a list of five jobs across three tractors should fit, but check it.

## The main path

### 0:00 Frame it (30 seconds)

Show the status page.

Say: "Three tractors, nine fields. Each tractor is a real AgOpenWeb instance, driven by its own process. The coordinator plans the day and watches telemetry. I'll build a job list, break a tractor, and you'll see what it does."

The judge sees: the farm map, three tractor cards in standby and the roundtable card.

If asked "is it simulated?": "The GPS is AgOpenWeb's simulator. The plan's clock, fuel and timing are the planner's own simulation."

### 0:30 Build the list (45 seconds)

Click, in this order:

1. **Ridge 80** and **South Flats** on the map.
2. **Plow**, then **Sow**. Set priority **High**. Press **Add to list**.
3. **Creek Pasture** on the map, **Spray**, priority **Medium**. Press **Add to list**.
4. Optional, 10 seconds: pick **North Field**, press **Sow** only and **Add to list**. It is refused with "North Field has not been plowed. Add Plow before Sow." Then click North Field and Sow again to clear the selection.

I chose Ridge 80 and South Flats because the 8 m tiller needs 8 passes on each, which gives a tractor visible work to be interrupted. That comes from running `planCoverage` on the field outlines, not from a timed run.

Say: "Plow always goes before Sow, and the list refuses things a foreman would refuse."

The judge sees: the job list grouped by field, each step with its order and priority. The Sow steps are marked "Waiting" until the Plow is done.

This covers: take an operator's job list, and constraint compliance.

### 1:15 Start, and the implement change (45 seconds)

Press **Start the day**.

Say: "The planner assigns each job to a tractor that has the right implement. If the tractor carries the wrong one, it plans a change at the depot."

The judge sees:

- The job table fills with a tractor for each job, and the tractors start to drive along the lanes.
- A task appears under "Needs a person at the depot", for example "Change T2's implement to Tiller 8m". The tractor parks in its bay and its card says it is locked.
- Press **Good to go** when the card shows the tractor waiting.

Say: "The tractor will not move until a person says so. Fuel and implement only change when I press this. Pressing it also loads the tool profile in that tractor's AgOpenWeb."

Which tractor needs a change depends on the plan. T2 starts with a mower and T3 with a seeder, so a Plow normally means a change. If no task appears, say so and move on. Do not wait for it.

The roundtable card shows the Depot Manager and Fleet Manager lines for this request. Point at it: "Each manager has one job and one instructions file."

FUEL TRUCK STEP: TO BE COMPLETED

### 2:00 Watch the passes (45 seconds)

Say: "Progress is measured from the tractor's real position along its route, not from a timer."

The judge sees:

- Tractor cards read "Working", with a label such as "pass 3 of 8, 40% worked".
- Coloured strips appear on the map, one implement-width wide, behind each tractor.
- In the 3D tab (if open), the same strips and the tractors moving.
- In the AgOpenWeb tab, the field, the guidance line and the worked area as AgOpenWeb paints it. I did not check how this looks on screen, so look at it in the rehearsal.
- The jobs table shows the percent done rising.

This covers: show progress on a dashboard or map, and completed work.

### 2:45 Inject a fault (90 seconds)

Choose a tractor that is working and still early in a pass, with its label showing "pass 1 of 8" to "pass 3 of 8". The check only fires when the tractor is more than 40 m from its target.

Press **Inject: GO but not moving** on that tractor's card.

Say: "The tractor still says GO received, but it is not moving. The coordinator sees that only from the GPS."

Wait about 8 to 9 seconds. The judge sees, in order:

1. The tractor's badge turns red: "GO acknowledged, GPS not moving".
2. The trail ("Messages between agents") shows `fault-detector → planner`, with the ack count and "moved under 5 m in 8 s".
3. A breakdown line, then a re-plan headline, for example "T2 broke down: 4 unfinished job(s) re-assigned, 1 completed job(s) unaffected."
4. In the coordinator window, one line per moved job with the reason, for example "keeps 4.7 ac already done" and "only working tractor with a seeder". Read one out.
5. The jobs table: the interrupted job's percent does not go back to zero, and the job shows another tractor.
6. A new "Needs a person at the depot" task if the new tractor needs a different implement. Press **Good to go**.
7. The roundtable card: the Fault Manager, Fleet Manager and Safety Officer speak, then the Plan Manager decides. If the Plan Manager calls a tool, a line says "Plan Manager called change_priority" or similar.

Say, in one or two sentences: "The planner acted in milliseconds from rules. Now the managers explain it and the chair can change a priority or approve a late job, but it can't send a tractor anywhere."

This covers: recover from a breakdown without conflicting assignments or lost work, and explain the new plan in plain language.

#### Which of the mentor's four points to name

| Point | What to say, and where it is |
| --- | --- |
| One task per agent | Seven managers, each a language model plus one `.md` instructions file in `agopen/roundtable/agents/`. Every file says "Your one job" and "You must never". The Depot Manager may never release a tractor. Show one file: it is short. |
| Calling deterministic tools | Only the Plan Manager has tools: `change_priority`, `approve_late`, `defer_job`, at most two per discussion. Each one sends an event to the planner. Outside agents use `POST /hold`, `/recall` and `/agent/say`. |
| Shared memory | The coordinator's state is the shared memory: the open jobs, the fleet, the holds and the message trail, in `GET /state`. Every manager gets those facts with each event. Nothing is kept between discussions, and no manager has memory of its own. |
| Talking to each other | The chair reads what the other managers said before it decides. Outside agents can post to the trail. |

Be honest if asked: the "talking" is one round, then the chair. It is not a free-form conversation.

### 4:15 Clear the fault (25 seconds)

Press **Clear fault** on the tractor.

Say: "When the tractor recovers, it goes back into the pool and takes work again."

The judge sees: the badge returns to normal, the trail shows `fault-detector → planner: recovered`, the planner reports the tractor back in service and the roundtable's Fault Manager and chair comment.

### 4:40 Close (20 seconds)

Say: "On the planner's own simulator, with the same faults, the coordinator finishes all 11 jobs on time on the breakdown day. First come, first served finishes 7 of 11 on time. Over 200 random scenarios it makes no unannounced constraint violations, against 346 for the baseline."

Then open the fallback tab if asked for the numbers (see the next section). The live run itself has no baseline. Say so if asked.

Leave the status page on screen and ask for questions.

## If something breaks: the 60-second fallback

If the live run fails and cannot be fixed in 15 seconds, say "Let me show you the same planner without the tractors" and switch tabs.

1. Open `out/comparison.md`. It is the comparison of the coordinator against first come, first served on the scripted demo day: 13 jobs completed against 10, 11 on time against 7, travel 746 against 1004 tractor-minutes (26% less), 0 unannounced violations against 3.
2. To regenerate it in front of the judges, run the original command. It prints the event log and the comparison, and rewrites the files in `out/`.

```bash
node cli.js
```

3. Open `agopen/test/TEST_REPORT.md`. It lists ten injected-fault cases, each with what was injected, what the system did and PASS, plus the breakdown-day comparison (11 of 11 on time against 7 of 11).
4. Run the tests if you have 10 seconds. It takes about 0.3 seconds and needs no AgOpenWeb.

```bash
npm test
```

It should end with `# pass 43`, `# fail 0` and `# todo 1`. The one `todo` is a known gap: when the only tractor that can do a job breaks, the planner does not warn the operator at that moment.

The original 3D Command Center is another fallback: `node serve.js`, then http://localhost:5180/.

## Likely questions

**Is this real AgOpenGPS?**
No. It is [AgOpenWeb](https://github.com/AgOpenGPS-Official/AgOpenWeb), from the AgOpenGPS-Official organisation on GitHub, running as one real instance per tractor. We patched it in three places so several copies run on one computer. The GPS is its built-in simulator. No hardware is involved, and the fields are rectangles placed at a real location, not surveyed.

**Does the AI drive the tractors?**
No. The planner and our tractor process drive them: ordinary code, the same every time. Language models appear only in the roundtable. They discuss each event, and the chair can call three tools: change a priority, approve a late finish, or defer a job. Each call goes to the planner as an event. A model cannot send a tractor anywhere.

**What happens with no internet?**
The planner, the tractors, fault detection and the status page keep working. The roundtable lines become rule-written ones, marked as such, and the chair stops calling tools. The 3D view will not load, because it takes three.js from a CDN. With a key but no network, each model call times out after 6 seconds and then falls back. That is how the code is written. I did not test it offline.

**How do you know it covers the whole field?**
Three things, and one gap. The coverage planner lays parallel passes one implement-width apart along the guidance line, plus a lap round the boundary. It measures its own plan on a one-metre grid, and the tests require at least 99.5% on rectangles. On the nine farm fields it reports 100% at all four implement widths. The tractor's progress is measured along the route it actually drives. AgOpenWeb also paints the worked ground, and you can see that in its page. The gap: the planner's measure assumes the implement reaches half a width past the end of each leg, so a real corner can leave a small wedge. We have not compared the planned coverage with AgOpenWeb's worked area.

**Why should an operator trust this plan?**
The hard rules are never broken: the right implement, fuel above a 10% reserve, one tractor per job, no duplicate assignment. Every re-plan is written out with reasons, and a job that cannot make its deadline is flagged for sign-off, not hidden. A person does the fuelling and the implement change, and the tractor stays locked until they say so. The gap to admit: when the only capable tractor breaks, the warning comes at the end of the day, not at the moment of the breakdown. The test for that is marked `todo`.

**How is it better than first come, first served?**
On the planner's own simulator, with the same faults and the same farm: on the scripted demo day it completes 13 jobs against 10, 11 on time against 7, and drives 26% less. On the live scenario with a breakdown, 11 of 11 on time against 7 of 11, and the day ends at 15:56 against 17:16. Over 200 random scenarios it is better on on-time value in 168, ties in 22 and worse in 10. These come from the headless planner. The live AgOpenWeb run does not run a baseline.

**How do you detect a fault?**
From telemetry only. Silence for 3 seconds is `NO_RESPONSE`. A tractor that acknowledges GO but moves less than 5 m in 8 seconds while more than 40 m from its target is `GO_NOT_MOVING`. We inject the fault on stage, but the detection is real. It has blind spots: a stall within 40 m of the target is not caught.

**Does it reassign without repeating work?**
A job's route belongs to the job, so the next tractor continues from the same waypoint. From reading the code, the pass that was interrupted is driven again from its start, so at most one pass can be done twice. The planner's own tests check that no acre is lost or counted twice.

**What if two tractors meet?**
A give-way rule: if two moving tractors come within 9 m, the one doing less important work stops until they are 13 m apart. A tractor working a pass keeps going. It does not plan around a tractor standing still in a lane.

**Why does the clock run so fast?**
One plan minute is 1.8 real seconds, about 33 times faster than a wall clock, so a day fits a demo. The tractors move at real speed (up to 20 km/h on lanes), and the fields are 1 to 2 acres.

**Can the operator override the plan?**
The status page builds the list, removes jobs that have not been sent, presses Good to go and injects or clears faults. Approving a late job or dropping one is in the older view at `/dashboard/?live=1`, and through `POST /event`. I read that code but did not click through it.

**How would it run on a real farm?**
Not as it is. Fields would come from surveyed boundaries, GPS from real receivers, fuel from tractor data, and the fault checks would need tuning. The structure (one process per machine, a coordinator that sees only telemetry) is meant to carry over.

**What is not finished?**
The warning gap above, small wedges at headland corners, fault checks with blind spots, a launcher that works only on macOS, and no authentication on the API. The README lists these under "What is simulated, and known limits".
