# Coordinator vs. FCFS baseline

Scenario: **Demo day — Barrow Farms, 9 fields, 3 tractors** (`scenario.json`), with scripted events (07:40 breakdown, 08:30 new_jobs, 09:20 block_route, 10:00 priority_change, 10:30 repair).

| Metric | Coordinator | FCFS baseline | Δ |
|---|---:|---:|---:|
| Jobs completed | 13 | 10 | +30% |
| …on time | 11 | 7 | +57% |
| …late (deadline missed) | 2 | 3 | -33% |
| Acres done on time | 302 | 208 | +45% |
| Priority-weighted acres on time | 660 | 358 | +84% |
| Travel time (tractor-min) | 746 | 1004 | -26% |
| Idle time in the working day (tractor-min) | 0 | 0 | 0% |
| Non-productive time: travel + idle (tractor-min) | 746 | 1004 | -26% |
| Spare capacity: tractor finished early (tractor-min) | 62 | 0 | — |
| Refuel/recharge stops | 5 | 5 | 0% |
| Implement swaps | 3 | 5 | -40% |
| Constraint violations (unannounced) | 0 | 3 | -100% |
| Late jobs forecast & flagged at the event | 2 | 0 | — |
| All work finished at | 17:26 | 18:00 | |

*Travel* = minutes driving, including depot trips. *Idle* = minutes a working tractor sat free (or waited for a busy field) while work it could do was still open, counted up to its last task of the day. Minutes after a tractor's last task are *spare capacity*: the tractor is released early and is free for new jobs. Broken-down minutes are excluded.

**Coordinator re-plans:** 19 (avg 2.3 ms, max 16.1 ms)

**Coordinator violations:** 16:16 J2 finished 137 min late (forecast and flagged to operator at 10:30 after repair); 17:24 J9 finished 385 min late (forecast and flagged to operator at 08:30 after new jobs)

**Baseline violations:** 12:52 J4 finished 203 min late; 16:15 J8 finished 46 min late; 17:31 J9 finished 392 min late; 18:00 J11 not completed (24.0 ac left); 18:00 J12 not completed (16.0 ac left); 18:00 J13 not completed (30.0 ac left)

## Per tractor (coordinator / baseline)

| Tractor | Work | Travel | Idle+wait | Broken | Min fuel % |
|---|---:|---:|---:|---:|---:|
| T1 Atlas | 267 / 194 | 218 / 326 | 0 / 0 | 170 / 170 | 14.8 / 16.8 |
| T2 Bison | 318 / 318 | 231 / 231 | 0 / 0 | 0 / 0 | 13.7 / 13.7 |
| T3 Comet | 256 / 198 | 297 / 447 | 0 / 0 | 0 / 0 | 18.6 / 20.3 |
