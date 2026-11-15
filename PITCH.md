# Run the Fleet: 3-minute pitch

Built around ATC's rubric: Constraints 4, Completed work 4, Adaptation 3, Efficiency 4, Explanations & Demo 5. The tiebreaker is "would a farm operator trust this plan?", so every beat ends on trust.

**Before you go up**
- `node serve.js` is running. Open http://localhost:5180/ and click **Reset day**.
- **AI coordinator** mode is on, **Scripted demo events** is ticked, and speed is **15 min/s**.
- Keep `out/comparison.md` open in a second tab as the backup if the browser misbehaves.
- No API key? That's fine: explanations fall back to the planner's own text. Say "rule-based" if anyone asks.

---

## 0:00 – 0:20 · The problem (speaker 1)

> "Autonomous tractors can drive themselves. They can't decide who does what. Today a person does that by hand, and when a tractor breaks down at 7:40 in the morning, that person re-plans the whole day on a whiteboard.
> We built the coordinator that does that re-plan in milliseconds, and tells the operator why."

## 0:20 – 0:40 · What it is (speaker 1)

> "It's ATC's Farm Orchestrator layer. A Fleet Agent assigns jobs, a Navigation Agent routes around closures, and a Safety Agent checks every plan before it's released. Nothing unsafe ever reaches a tractor.
> Three tractors, nine fields, a creek with two bridges, a depot for fuel and implements. Every job has a type, a priority and a deadline."

## 0:40 – 2:00 · Live demo (speaker 2 drives, speaker 1 narrates)

Click **Run**. The scripted day plays out.

1. **07:40, T1 breaks down** (the only sprayer).
   > "Hydraulic pump failure, straight from telematics. Watch: its work moves to T3 in under 20 milliseconds. Completed work stays completed, and nothing is assigned twice."
   - Open the notification and click **Details**.
   > "And here's the part that matters to an operator. It doesn't silently miss deadlines. It says up front: *this job can't make 14:30, here's why, here's the best option.* It asks for sign-off."
   - Point at the **Needs your decision** card.

2. **09:20, south bridge washes out.**
   > "The water-level gauge reads 2.1 metres over the deck. The red barrier goes up, and the routes redraw through the north bridge, plus 24 minutes for T2."

3. **10:00, rain forecast.**
   > "The weather service says rain at 15:00, so the hay has to come down by 14:00. Priority goes up and the plan reshuffles."

4. **Click any job, then Ask why.**
   > "The operator can ask why about any assignment. It shows which tractor got the job, the slack against the deadline, and why every other tractor was ruled out: no sprayer, out of service, or would make something else late."

## 2:00 – 2:35 · Results (speaker 1)

Click **Compare**.

> "Same farm, same simulator, same events, against first-come-first-served:
> - **13 of 13 jobs done vs 10.**
> - **84% more high-priority acres done on time.**
> - **26% less driving.**
> - **Zero unannounced rule breaks vs three.**
>
> And it's not one lucky day. Across 200 random scenarios: zero violations against 346 for the baseline, 61% less idle time, 18% less driving, and the slowest re-plan was 9 milliseconds."

## 2:35 – 3:00 · Trust + close (speaker 1)

> "This is a real place: that's an aerial photo of farmland in the Yuma Valley, with the real canals, and each field shows its real USDA soil type.
> We also connected it to AgOpenWeb: three real AgOpenWeb tractors, with faults detected from live telemetry.
> Claude writes the words, but the planner makes every decision, so every explanation is grounded in the plan.
> When it can't do everything, it tells you first. That's a plan a farm operator can trust."

---

## Q&A prep

| Likely question | Answer |
|---|---|
| "Two jobs finished late. Isn't that a violation?" | "Only when the breakdown made it physically impossible: T1 was the only sprayer, out for almost 3 hours. Both were flagged the moment it happened, with a reason and the best finish time, and the operator can approve or drop them. Set `lateWork: hold` and it treats deadlines as strictly hard: 11 on time, 0 late, 2 carried over." |
| "Idle time is 0 vs 0 on demo day." | "On one day both keep busy. The difference is what they're busy with: the baseline drives 26% more. Over 200 scenarios, idle is 1603 vs 4124 tractor-minutes." |
| "Does the baseline ever win?" | "In 10 of 200 scenarios, by a little. It's a fast heuristic (regret insertion plus local search), not an exact optimiser. We chose millisecond re-plans over a slower exact optimiser." |
| "Is the LLM making decisions?" | "No. The algorithmic planner decides. Claude only turns the planner's facts into plain language, and with no key the planner's own explanations are used, with identical decisions." |
| "How realistic is the sim?" | "A grid with flat speeds, and a field is one work point. The brief said to score the coordinator, not the sim. The AgOpenWeb run shows the same coordinator on real guidance software." |
| "Is the map real?" | "The photo, canals, roads, soil and elevation are real public data for a spot in the Yuma Valley. The field rectangles and Mill Creek are our scenario, and the screen says so." |
| "What's the `agents/` folder?" | "Next step: nine agents (weather, fault, safety, depot and more) that watch the farm and talk to the people. The weather rules cite the National Weather Service and university extension services. It works in tests and isn't wired into the live runner yet." |

## Don't

- Don't open with the AgOpenWeb setup or the agents. Both are fragile to demo and score nothing extra.
- Don't read the table. Say four numbers.
- Don't run past 3:00. Cut demo step 3 if you're behind.
