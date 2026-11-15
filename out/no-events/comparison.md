# Coordinator vs. FCFS baseline

Scenario: **Demo day — Barrow Farms, 9 fields, 3 tractors** (`scenario.json`), without scripted events.

| Metric | Coordinator | FCFS baseline | Δ |
|---|---:|---:|---:|
| Jobs completed | 12 | 11 | +9% |
| …on time | 12 | 8 | +50% |
| …late (deadline missed) | 0 | 3 | -100% |
| Acres done on time | 344 | 244 | +41% |
| Priority-weighted acres on time | 678 | 430 | +58% |
| Travel time (tractor-min) | 540 | 892 | -39% |
| Idle time in the working day (tractor-min) | 0 | 0 | 0% |
| Non-productive time: travel + idle (tractor-min) | 540 | 892 | -39% |
| Spare capacity: tractor finished early (tractor-min) | 175 | 0 | — |
| Refuel/recharge stops | 4 | 6 | -33% |
| Implement swaps | 2 | 4 | -50% |
| Constraint violations (unannounced) | 0 | 3 | -100% |
| Late jobs forecast & flagged at the event | 0 | 0 | 0% |
| All work finished at | 15:47 | 18:00 | |

*Travel* = minutes driving, including depot trips. *Idle* = minutes a working tractor sat free (or waited for a busy field) while work it could do was still open, counted up to its last task of the day. Minutes after a tractor's last task are *spare capacity*: the tractor is released early and is free for new jobs. Broken-down minutes are excluded.

**Coordinator re-plans:** 13 (avg 2.1 ms, max 15.8 ms)

**Coordinator violations:** none

**Baseline violations:** 10:24 J4 finished 55 min late; 12:00 J9 finished 61 min late; 16:28 J8 finished 59 min late; 18:00 J12 not completed (16.0 ac left)

## Per tractor (coordinator / baseline)

| Tractor | Work | Travel | Idle+wait | Broken | Min fuel % |
|---|---:|---:|---:|---:|---:|
| T1 Atlas | 270 / 222 | 228 / 244 | 0 / 0 | 0 / 0 | 14 / 24 |
| T2 Bison | 318 / 318 | 198 / 206 | 0 / 0 | 0 / 0 | 14.5 / 13.7 |
| T3 Comet | 192 / 208 | 114 / 442 | 0 / 0 | 0 / 0 | 29.1 / 26.6 |
