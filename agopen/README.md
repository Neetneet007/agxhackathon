# Live run on AgOpenWeb tractors

The coordinator in `src/` plans the day. Here each tractor is a separate process wrapping its own AgOpenWeb instance, and the coordinator re-plans from the telemetry those processes send back.

```
 coordinator (live.js)  ── commands ──►  tractor-node.js T1  ── WebSocket ──►  AgOpenWeb :5175
        ▲                               tractor-node.js T2  ── WebSocket ──►  AgOpenWeb :5176
        └────── telemetry, 4×/s ◄────── tractor-node.js T3  ── WebSocket ──►  AgOpenWeb :5177
```

## Set up once

AgOpenWeb allows one copy per computer, so it needs three small changes to run one copy per tractor. They are in `agopen/agopenweb/agopenweb-multi-instance.patch`: the port can be set per copy, the single-copy lock is per port, and only the fleet's tractor process may take control (browser views can only watch).

1. Clone AgOpenWeb next to this repo and install the .NET 10 SDK.
2. In the AgOpenWeb folder, apply the patch and build into `../agopen-multi/bin`:

```bash
git apply ../agxhackathon/agopen/agopenweb/agopenweb-multi-instance.patch
```

```bash
DesktopOnly=true dotnet build Platforms/AgOpenWeb.Desktop -o ../agopen-multi/bin
```

3. Copy `agopen/agopenweb/start-fleet.sh` into `../agopen-multi/`, run it once so each copy creates its data folder, then stop it:

```bash
../agopen-multi/start-fleet.sh 3 && sleep 8 && ../agopen-multi/start-fleet.sh stop
```

4. Here, install the one dependency and write the farm and tool profiles into the three copies:

```bash
npm install && node agopen/build-farm.js
```

## Run it

```bash
agopen/start-demo.sh
```

That opens a Terminal window per tractor with telemetry every second, a Terminal window for the coordinator, and the status page at http://localhost:5190. The status page has the farm map, every tractor's state and AgOpenWeb view, and a link to the 3D view (`/dashboard/?live=1`), which replays the live run. macOS only, because it opens Terminal windows; on another system start `tractor-node.js` three times and `live.js` once by hand.

```bash
agopen/start-demo.sh stop
```

The original dashboard and CLI in the repo root are unchanged and need none of this.

## People in the loop

Fuelling and implement changes are done by a person at the depot.

- When the plan sends a tractor to refuel or change implement, a task appears under "Needs a person at the depot".
- Once the tractor is parked there, its own process locks it: it will not move, whatever it is sent.
- The fuel gauge and the mounted implement do not change until someone presses **Good to go**.
- For an implement change, Good to go also loads that tool profile in the tractor's AgOpenWeb, so the farmer's own record matches.

`--auto-humans 6` on `live.js` presses Good to go after 6 seconds, for unattended test runs only.

## Implements come from AgOpenWeb

Each tractor's implements are the tool profiles in its own AgOpenWeb (`Sprayer 24m`, `Mower 6m` and so on), and the mounted one is its active profile. The coordinator reads them at start-up, works out each work rate from the width, and plans an implement change at the depot when a job needs a different one.

## Faults

Type into a tractor's Terminal window, or use the buttons on the status page:

| Type | What the tractor does | What the coordinator sees |
| --- | --- | --- |
| `dead` | Stops answering and halts | `NO_RESPONSE`: no telemetry for 3 s |
| `stuck` | Keeps acknowledging GO; wheels stop | `GO_NOT_MOVING`: far from target, moved under 8 m in 5 s |
| `ok` | Clears the fault | `NO_RESPONSE` clears by itself; for `stuck`, type `repair T1` in the coordinator window or use Clear fault |

Add `--chaos 90` to a tractor-node command for a random fault about every 90 seconds.

Either symptom becomes a breakdown event for the coordinator, which reassigns that tractor's unfinished work. Every hand-off is written to `agopen/out/trail.jsonl`.

## Scripted test case

```bash
node agopen/live.js --sec 1 --until 95 --script "30:fault T1 stuck;75:fault T1 ok;78:repair T1"
```

Runs 95 simulated minutes: T1 goes stuck at 06:30, is detected, its jobs move to T2 and T3, and it takes work back after recovery. Needs the three tractor processes already running.

## The farm lives in AgOpenWeb

Fields are AgOpenWeb's own field folders: one folder per field, with `field.geojson` holding the boundary and guidance line. A farmer would create these in AgOpenGPS by driving or drawing each boundary.

- `node agopen/build-farm.js` stands in for that step. It writes the scenario's nine fields into every tractor's AgOpenWeb field folder and records the depot position in `farm.json`. The depot sits on real farmland in the Yuma Valley; the field shapes come from the scenario, not a survey.
- The status page reads those folders directly and draws the farm from them. Click fields, pick a job, priority and finish time, and the jobs go to the coordinator.
- Any other AgOpenWeb field folder dropped into `agopen-multi/data-5175/AgOpenWeb/Fields` shows up on the map and can be given jobs. Copy it into the other tractors' folders too so they can open it.

When a tractor starts a job, its process opens that field in AgOpenWeb, selects the field's guidance line and switches section control on. Along each pass AgOpenWeb's own autosteer holds the line; our steering loop only drives between fields and turns at the field ends.

## How it fits together, and what is simulated

- `scenario.live.json` is `scenario.json` with every implement on two tractors, so any single breakdown can be covered, and with no scripted events.
- The planner's own simulator (`src/simulator.js`) keeps the plan's clock, fuel and job progress. Each AgOpenWeb tractor is driven towards where the plan says its machine should be, at the simulator's 10x speed, 100 m per grid cell.
- Fault detection uses only real telemetry from the tractor processes. Job progress does not: acres done come from the planner's simulator, not from AgOpenWeb's coverage map.
- Passes are 60 m apart so a field is crossed in a few passes at demo speed; they do not cover the whole field.
- The 3D view shows the planner's picture of the day (the same plan, events and holds, replayed), not the tractors' GPS positions. The farm map on the status page shows GPS.
