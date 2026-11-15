// Shared physical model: implements, fuel, work rates and the "next primitive
// action" rule. The simulator executes it minute by minute; the planner runs the
// same rule analytically to predict a schedule, so plans and reality agree.

export const IMPLEMENT_FOR = { spray: 'sprayer', mow: 'mower', till: 'tiller', seed: 'seeder' };
export const JOB_VERB = { spray: 'Spray', mow: 'Mow', till: 'Till', seed: 'Seed' };
export const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
export const SWAP_MIN = 20;    // implement change at the depot
export const REFUEL_MIN = 15;  // refuel / recharge at the depot
export const RESERVE_FRAC = 0.10; // never plan to drop below 10% tank
const EPS = 1e-6;

export const START_HOUR = 6; // minute 0 = 06:00
export function fmtTime(min) {
  const m = Math.round(min) + START_HOUR * 60;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function reserve(spec) { return spec.fuelCapacity * RESERVE_FRAC; }
export function ratePerMin(spec, jobType) {
  const r = spec.workRates[IMPLEMENT_FOR[jobType]];
  return r ? r / 60 : 0;
}
export function canDo(spec, jobType) { return spec.implements.includes(IMPLEMENT_FOR[jobType]); }

// st = {x, y, fuel, mounted}; job = {type, field:{x,y}, remaining}
// returns {kind: 'goto'|'swap'|'refuel'|'work'|'infeasible', ...}
export function nextAction(spec, st, job, nav, depot) {
  const impl = IMPLEMENT_FOR[job.type];
  if (!spec.implements.includes(impl)) return { kind: 'infeasible', reason: 'no-implement' };
  const atDepot = st.x === depot.x && st.y === depot.y;
  const dToField = nav.distance(st, job.field);
  const dReturn = nav.distance(job.field, depot);
  if (!isFinite(dToField) || !isFinite(dReturn)) return { kind: 'infeasible', reason: 'unreachable' };

  const travelFuel = (dToField + dReturn) * spec.burnPerCell;
  const fullWork = job.remaining * spec.burnPerAcre;
  const res = reserve(spec);

  if (st.mounted !== impl) {
    if (atDepot) return { kind: 'swap', impl };
    return { kind: 'goto', target: depot, purpose: 'swap' };
  }
  // At the depot anyway: top up if the whole job doesn't fit in the tank.
  if (atDepot && st.fuel < spec.fuelCapacity - EPS && st.fuel < res + travelFuel + fullWork - EPS) {
    return { kind: 'refuel' };
  }
  // Whole job fits in a full tank but not in what's left: refuel first. By the
  // triangle inequality this never drives more than splitting the job.
  if (st.fuel < res + travelFuel + fullWork - EPS && spec.fuelCapacity >= res + 2 * dReturn * spec.burnPerCell + fullWork) {
    if (atDepot) return { kind: 'refuel' };
    return { kind: 'goto', target: depot, purpose: 'refuel' };
  }
  // Need at least a useful chunk of work plus the drive back with reserve.
  const minChunk = Math.min(fullWork, 0.25 * spec.fuelCapacity);
  if (st.fuel < res + travelFuel + minChunk - EPS) {
    if (atDepot) {
      if (st.fuel >= spec.fuelCapacity - EPS) return { kind: 'infeasible', reason: 'fuel' };
      return { kind: 'refuel' };
    }
    return { kind: 'goto', target: depot, purpose: 'refuel' };
  }
  if (dToField > 0) return { kind: 'goto', target: job.field, purpose: 'job' };
  return { kind: 'work' };
}

// Fuel the tractor may still burn on work before it must leave for the depot.
export function workFuelBudget(spec, st, field, nav, depot) {
  return st.fuel - reserve(spec) - nav.distance(field, depot) * spec.burnPerCell;
}
