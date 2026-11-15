# Hand-in files from a recorded live run

Recorded on 15 November 2026 from the live mode (`agopen/start-demo.sh`, three tractors and the fuel truck on
AgOpenWeb, `--fuel-scale 70`), plan clock 06:00 to 08:59. The day was stopped there; it was not run to the end.

| File | What it is |
| --- | --- |
| `event-log.jsonl` | Every message between the operator, planner, executor, fault detector, weather, drone, fuel planner and the person at the depot, one JSON object per line, with wall-clock and plan-clock times. A copy of `agopen/out/trail.jsonl`, which is emptied at each start. |
| `spray-conditions-log.txt` | The time-stamped Go / Caution / Stop log (`GET /weather-log`), one reading per plan minute at 2 m and 10 m. |

What happened in this run, in order: the operator drafted a job list (mow Ridge 80; plow then sow North Field and
Home Quarter; spray Creek Pasture) and started the day. Spraying was held for a temperature inversion and released
when it cleared. Three implement changes and two refuels were done at the depot, each tractor locked until Good to
go. T1 was made to stick (`inject` entries, type `fault T1 stuck`): the detector raised `GO_NOT_MOVING`, the drone
was sent to look, and its job was re-assigned. T1 was then freed and took work back. The fuel planner sent the
fuel truck to T3 in Creek Pasture, both were locked there until Good to go, and T3 carried on.

In this run Good to go was pressed through the same API the page's button uses, by a test script standing in
for the person at the depot, five seconds after each task appeared. The fault was injected by the same script.

The scenario is `agopen/scenario.live.json`. The comparison with a first-come-first-served baseline is in
`agopen/test/TEST_REPORT.md`.
