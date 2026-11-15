# Fault test report

Generated 2026-11-15 21:17 UTC from the live demo farm (3 tractors, 9 fields, 11 jobs). Times are clock times from a 06:00 start.

| Case | What was injected | What the system did | Result |
|---|---|---|---|
| A tractor breaks mid-job and another finishes it, with no lost or repeated work | The tractor working a job breaks part-way and stays out all day | T1 broke at 06:51 on J9; T1 then T3 finished it at 11:07. 24.0 of 24 acres logged. | PASS |
| Any single tractor can break early and the day still completes once repaired | Each of T1, T2, T3 in turn: breaks at 07:00, repaired at 09:00 | T1: 11/11 done, 0 late, finished 15:56; T2: 11/11 done, 0 late, finished 16:56; T3: 11/11 done, 0 late, finished 15:56 | PASS |
| A job nobody can do is flagged, not dropped | The only tractor with a sprayer breaks at 06:30 and is never repaired | A2 stays on the books with 48 acres left; the end-of-day record says "A2 not completed (48.0 ac left)". The mowing job was still finished. Note: no warning was given when the tractor broke. | PASS |
| An urgent job added mid-day is fitted in and finishes on time | At 08:30 a high-priority spray job (due 13:30) is added | N1 finished at 10:48 by T3; 0 other jobs late. | PASS |
| An implement change is planned when the job needs one | None (normal day) | Implement changes: T1 1, T2 3, T3 1. Jobs worked by a tractor without the right tool: 0. | PASS |
| No tractor's fuel ever drops below the reserve | Normal day, and the breakdown day | Lowest tank level seen: 19.0% (normal day), 19.0% (breakdown day); the limit is 10.0%. | PASS |
| No job is ever held by two tractors at once | T1 breaks at 07:00, T3 breaks at 07:40, T1 repaired at 09:20; checked every minute | 674 minutes checked: 0 clashes, 0 duplicate-assignment warnings. | PASS |
| A tractor held at the depot for a person does not move or gain fuel until released | First refuel is held for 30 minutes, then released | T2 held at 06:21 with 45.0 fuel: no movement, no fuel gained for 30 min; full 14 min after release. | PASS |
| The coordinator finishes at least as many jobs on time as first come, first served, after a breakdown | T1 breaks at 07:00, repaired at 09:00; same for both | Coordinator 11 of 11 on time; first come, first served 7 of 11. | PASS |
| The same day with the same faults gives the same result twice | Two breakdowns and a repair, run twice | Both runs identical (8250 characters of results compared). | PASS |

## Coordinator versus first come, first served (breakdown day)

T1 breaks at 07:00 and is repaired at 09:00. Same farm, same jobs, same fault.

| | Coordinator | First come, first served |
|---|---:|---:|
| Jobs completed (of 11) | 11 | 11 |
| Jobs finished on time | 11 | 7 |
| Travel (tractor-minutes) | 698 | 758 |
| Idle (tractor-minutes) | 0 | 22 |
| Day ended at | 15:56 | 17:16 |

Result: 10 of 10 cases passed.
