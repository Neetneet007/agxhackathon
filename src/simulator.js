// Minute-by-minute farm simulator. It owns the ground truth (positions, fuel,
// job progress) and asks a dispatcher (our coordinator, or the FCFS baseline)
// which job each free tractor should work on next.

import { Navigation } from './navigation.js';
import {
  nextAction, workFuelBudget, ratePerMin, reserve, fmtTime, JOB_VERB,
  SWAP_MIN, REFUEL_MIN, canDo,
} from './model.js';
import { sourceName } from './sources.js';

const EPS = 1e-6;

export function fieldEntry(f) {
  return { x: f.x + Math.floor(f.w / 2), y: f.y + Math.floor(f.h / 2) };
}

export function jobLabel(job, fields) {
  const f = fields.get(job.fieldId);
  return `${job.id} ${JOB_VERB[job.type]} ${f ? f.name : job.fieldId}`;
}

export class Simulator {
  constructor(scenario, dispatcher, { scriptedEvents = true } = {}) {
    this.scenario = scenario;
    this.dispatcher = dispatcher;
    this.nav = new Navigation(scenario.map);
    this.depot = { ...scenario.depot };
    this.horizon = scenario.horizonMinutes ?? 720;
    this.time = 0;
    this.fields = new Map(scenario.fields.map(f => [f.id, { ...f, entry: fieldEntry(f) }]));
    this.tractors = scenario.tractors.map(t => ({
      ...t,
      x: this.depot.x, y: this.depot.y,
      fuel: t.fuel ?? t.fuelCapacity,
      mounted: t.mounted ?? t.implements[0],
      status: 'ok',
      action: null,
      jobId: null,
      stats: { travel: 0, work: 0, idle: 0, wait: 0, refuel: 0, swap: 0, broken: 0, fuelStops: 0, swaps: 0, minFuelPct: 100 },
      trail: [],
    }));
    this.jobs = new Map();
    this.fieldHolder = new Map();
    this.log = [];
    this.violations = [];
    this.pending = scriptedEvents ? [...(scenario.events || [])].map(e => ({ ...e })) : [];
    this.pending.sort((a, b) => a.time - b.time);
    this.finished = false;
    this.listeners = [];
    this._addJobs(scenario.jobs, 0);
    this.emit('submit', `Operator submitted ${scenario.jobs.length} jobs.`, { jobs: scenario.jobs.map(j => j.id) });
    dispatcher.init(this);
  }

  // ---------- helpers ----------
  tractor(id) { return this.tractors.find(t => t.id === id); }
  jobField(job) { return this.fields.get(job.fieldId).entry; }
  jobView(job) { return { type: job.type, field: this.jobField(job), remaining: job.remaining }; }
  openJobs() { return [...this.jobs.values()].filter(j => j.status !== 'done' && j.status !== 'cancelled'); }
  label(job) { return jobLabel(job, this.fields); }

  emit(type, text, data = {}) {
    const entry = { time: this.time, clock: fmtTime(this.time), type, text, ...data };
    this.log.push(entry);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  _addJobs(list, time) {
    for (const j of list) {
      if (this.jobs.has(j.id)) continue;
      if (!this.fields.has(j.fieldId)) throw new Error(`Job ${j.id}: unknown field ${j.fieldId}`);
      const f = this.fields.get(j.fieldId);
      const acres = j.acres ?? f.acres;
      this.jobs.set(j.id, {
        ...j, acres, remaining: acres, status: 'pending', submittedAt: time,
        doneAt: null, doneBy: null, workLog: [], allowLate: !!j.allowLate,
      });
    }
  }

  // ---------- events ----------
  inject(evt) { this.pending.push({ ...evt, time: Math.max(evt.time ?? this.time, this.time) }); this.pending.sort((a, b) => a.time - b.time); }

  _applyEvent(e) {
    const ok = this._applyEventInner(e);
    if (ok && e.source && this.log.length) {
      const last = this.log[this.log.length - 1];
      last.source = e.source;
      last.signal = e.signal || null;
      last.text += ` [${sourceName(e.source)}${e.signal ? `: ${e.signal}` : ''}]`;
    }
    return ok;
  }

  _applyEventInner(e) {
    switch (e.type) {
      case 'breakdown': {
        const t = this.tractor(e.tractor);
        if (!t || t.status === 'broken') return false;
        const job = t.jobId ? this.jobs.get(t.jobId) : null;
        t.status = 'broken'; t.action = null; t.fault = e.signal ? e.signal.split(' — ')[0] : 'fault';
        let detail = '';
        if (job && job.status !== 'done') {
          job.status = 'pending';
          const pct = Math.round(100 * (1 - job.remaining / job.acres));
          detail = ` while on ${this.label(job)} (${pct}% done, ${job.remaining.toFixed(1)} ac left)`;
        }
        t.jobId = null;
        this.emit('event', `BREAKDOWN: ${t.id} ${t.name} is out of service${detail}${e.note ? ` — ${e.note}` : ''}.`, { event: e });
        return true;
      }
      case 'repair': {
        const t = this.tractor(e.tractor);
        if (!t || t.status !== 'broken') return false;
        t.status = 'ok';
        this.emit('event', `REPAIRED: ${t.id} ${t.name} is back in service at (${t.x},${t.y}).`, { event: e });
        return true;
      }
      case 'block_route':
        this.nav.block(e.cells, e.name || 'route');
        this.emit('event', `ROUTE BLOCKED: ${e.name || 'route'}${e.note ? ` — ${e.note}` : ''}.`, { event: e });
        return true;
      case 'unblock_route':
        this.nav.unblock(e.cells);
        this.emit('event', `ROUTE REOPENED: ${e.name || 'route'}.`, { event: e });
        return true;
      case 'priority_change': {
        const j = this.jobs.get(e.job);
        if (!j || j.status === 'done') return false;
        const parts = [];
        if (e.priority && e.priority !== j.priority) { parts.push(`priority ${j.priority} → ${e.priority}`); j.priority = e.priority; }
        if (e.deadline != null && e.deadline !== j.deadline) { parts.push(`deadline ${fmtTime(j.deadline)} → ${fmtTime(e.deadline)}`); j.deadline = e.deadline; }
        if (e.allowLate != null) { j.allowLate = e.allowLate; parts.push(e.allowLate ? 'late finish approved' : 'late finish not allowed'); }
        this.emit('event', `PRIORITY CHANGE: ${this.label(j)}: ${parts.join(', ')}${e.note ? ` — ${e.note}` : ''}.`, { event: e });
        return true;
      }
      case 'cancel_job': {
        const j = this.jobs.get(e.job);
        if (!j || j.status === 'done' || j.status === 'cancelled') return false;
        for (const t of this.tractors) if (t.jobId === j.id) { t.jobId = null; t.action = null; }
        j.status = 'cancelled';
        this.emit('event', `JOB DROPPED by operator: ${this.label(j)}${j.remaining < j.acres ? ` (${(j.acres - j.remaining).toFixed(1)} ac had been done)` : ''}.`, { event: e });
        return true;
      }
      case 'new_jobs':
        this._addJobs(e.jobs, this.time);
        this.emit('submit', `Operator submitted ${e.jobs.length} new job(s): ${e.jobs.map(j => this.label(this.jobs.get(j.id))).join('; ')}.`, { event: e });
        return true;
      default:
        return false;
    }
  }

  // ---------- main loop ----------
  // Apply every event that is due (also callable while paused, for operator input).
  processEvents() {
    if (this.finished) return;
    while (this.pending.length && this.pending[0].time <= this.time) {
      const e = this.pending.shift();
      if (this._applyEvent(e)) {
        // Tractors on the move drop their current leg and re-route against the new plan.
        for (const t of this.tractors) if (t.action && t.action.kind === 'goto') t.action = null;
        this.dispatcher.onEvent(e, this);
      }
    }
  }

  tick() {
    if (this.finished) return;
    // 1. events due now
    this.processEvents();

    // 2. free tractors pick their next primitive action
    for (const t of this.tractors) {
      if (t.status !== 'ok' || t.action) continue;
      this._decide(t);
    }

    // 3. advance one minute
    const open = this.openJobs();
    const anyOpen = open.length > 0;
    const anyActive = this.tractors.some(t => t.status === 'ok' && t.action);
    // Idle = a working tractor with nothing to do while compatible work is still open.
    for (const t of this.tractors) this._advance(t, open.some(j => canDo(t, j.type) && !this.tractors.some(o => o !== t && o.jobId === j.id && o.action?.kind === 'work')));

    this.time++;
    const allDone = !anyOpen;
    const stalled = !anyActive && this.pending.length === 0;
    if (allDone || stalled || this.time >= this.horizon) this._finish(allDone ? 'all jobs complete' : stalled ? 'no further work possible' : 'end of shift');
  }

  _decide(t, depth = 0) {
    const jobId = this.dispatcher.nextJob(t, this);
    if (!jobId) { t.jobId = null; return; }
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'done') { this.dispatcher.onInfeasible(t, job, 'done', this); if (depth < 3) this._decide(t, depth + 1); return; }
    // Safety interlock: never two tractors on one job.
    const other = this.tractors.find(o => o !== t && o.jobId === jobId && o.status === 'ok');
    if (other) { this.violations.push({ time: this.time, kind: 'duplicate-assignment', text: `${jobId} given to ${t.id} while ${other.id} holds it` }); t.jobId = null; return; }
    t.jobId = jobId;
    const a = nextAction(t, t, this.jobView(job), this.nav, this.depot);
    if (a.kind === 'infeasible') {
      t.jobId = null;
      this.dispatcher.onInfeasible(t, job, a.reason, this);
      if (depth < 3) this._decide(t, depth + 1);
      return;
    }
    if (a.kind === 'goto') {
      const path = this.nav.path(t, a.target);
      if (!path) { t.jobId = null; this.dispatcher.onInfeasible(t, job, 'unreachable', this); return; }
      t.action = { kind: 'goto', target: a.target, purpose: a.purpose, path, step: 0 };
    } else if (a.kind === 'swap') {
      t.action = { kind: 'swap', impl: a.impl, left: SWAP_MIN };
    } else if (a.kind === 'refuel') {
      t.action = { kind: 'refuel', left: REFUEL_MIN };
    } else {
      t.action = { kind: 'work' };
      if (job.status !== 'active') job.status = 'active';
    }
  }

  _record(t, kind) {
    const h = (t.history ||= []);
    const last = h[h.length - 1];
    const jobId = kind === 'work' || kind === 'travel' ? t.jobId : null;
    if (last && last.kind === kind && last.jobId === jobId && last.end === this.time) last.end = this.time + 1;
    else h.push({ kind, jobId, start: this.time, end: this.time + 1 });
  }

  _advance(t, countIdle) {
    const s = t.stats;
    this._record(t, t.status === 'broken' ? 'broken' : !t.action ? 'idle' : t.action.kind === 'goto' ? 'travel' : t.action.kind);
    if (t.status === 'broken') { s.broken++; return; }
    if (t.action) s.lastActive = this.time;
    const a = t.action;
    if (!a) { if (countIdle) { s.idle++; (t.idleTicks ||= []).push(this.time); } return; }
    switch (a.kind) {
      case 'goto': {
        s.travel++;
        a.step++;
        if (a.step >= t.ticksPerCell) {
          a.step = 0;
          const c = a.path.shift();
          if (c) {
            if (!this.nav.passable(c.x, c.y) && !(c.x === t.x && c.y === t.y)) {
              // route closed under us — re-plan the leg
              t.action = null; return;
            }
            t.x = c.x; t.y = c.y; t.fuel -= t.burnPerCell;
            t.trail.push([t.x, t.y]); if (t.trail.length > 40) t.trail.shift();
          }
          if (!a.path.length) t.action = null;
        }
        break;
      }
      case 'swap':
        s.swap++;
        if (--a.left <= 0) { t.mounted = a.impl; s.swaps++; this.emit('ops', `${t.id} swapped to ${a.impl} at the depot.`, { tractor: t.id }); t.action = null; }
        break;
      case 'refuel':
        s.refuel++;
        if (--a.left <= 0) { t.fuel = t.fuelCapacity; s.fuelStops++; this.emit('ops', `${t.id} refuelled to 100%.`, { tractor: t.id }); t.action = null; }
        break;
      case 'work': {
        const job = this.jobs.get(t.jobId);
        if (!job || job.status === 'done') { t.action = null; break; }
        const field = this.jobField(job);
        // Field interlock: one working tractor per field at a time.
        const holderId = this.fieldHolder.get(job.fieldId);
        const holder = holderId && holderId !== t.id ? this.tractor(holderId) : null;
        if (holder && holder.status === 'ok' && holder.action?.kind === 'work' && this.jobs.get(holder.jobId)?.fieldId === job.fieldId) { s.wait++; break; }
        this.fieldHolder.set(job.fieldId, t.id);
        const rate = ratePerMin(t, job.type);
        const budget = workFuelBudget(t, t, field, this.nav, this.depot);
        const acres = Math.min(job.remaining, rate, Math.max(0, budget / t.burnPerAcre));
        if (acres <= EPS) { t.action = null; break; } // must go refuel
        s.work++;
        job.remaining -= acres; t.fuel -= acres * t.burnPerAcre;
        const last = job.workLog[job.workLog.length - 1];
        if (last && last.tractor === t.id && last.end === this.time) { last.end = this.time + 1; last.acres += acres; }
        else job.workLog.push({ tractor: t.id, start: this.time, end: this.time + 1, acres });
        if (job.remaining <= 1e-4) {
          job.remaining = 0; job.status = 'done'; job.doneAt = this.time + 1; job.doneBy = t.id;
          const late = job.doneAt > job.deadline;
          const who = [...new Set(job.workLog.map(w => w.tractor))];
          this.emit('done', `${t.id} completed ${this.label(job)} at ${fmtTime(job.doneAt)}${late ? ` — LATE by ${job.doneAt - job.deadline} min (deadline ${fmtTime(job.deadline)})` : ` (deadline ${fmtTime(job.deadline)})`}${who.length > 1 ? `; work shared by ${who.join(' + ')}` : ''}.`, { job: job.id, tractor: t.id, late });
          if (late) {
            const f = this.dispatcher.flaggedLate?.get(job.id);
            this.violations.push({ time: this.time, kind: f ? 'deadline-flagged' : 'deadline', text: `${job.id} finished ${job.doneAt - job.deadline} min late${f ? ` (forecast and flagged to operator at ${fmtTime(f.time)} after ${f.cause.replace('_', ' ')})` : ''}` });
          }
          t.action = null; t.jobId = null;
          this.dispatcher.onJobDone(job, t, this);
        }
        break;
      }
    }
    const pct = 100 * t.fuel / t.fuelCapacity;
    s.minFuelPct = Math.min(s.minFuelPct, pct);
    if (t.fuel < reserve(t) - 0.5 && !t._lowFuelFlag) {
      t._lowFuelFlag = true;
      this.violations.push({ time: this.time, kind: 'fuel-reserve', text: `${t.id} dropped below its 10% fuel reserve` });
    }
    if (t.fuel <= 0) this.violations.push({ time: this.time, kind: 'out-of-fuel', text: `${t.id} ran out of fuel` });
  }

  step() { this.tick(); }

  run() { while (!this.finished) this.step(); return this.metrics(); }

  _finish(reason) {
    if (this.finished) return;
    this.finished = true;
    for (const j of this.openJobs()) {
      this.violations.push({ time: this.time, kind: 'unfinished', text: `${j.id} not completed (${j.remaining.toFixed(1)} ac left)` });
    }
    this.emit('end', `Simulation ended at ${fmtTime(this.time)}: ${reason}.`);
  }

  metrics() {
    const jobs = [...this.jobs.values()];
    const done = jobs.filter(j => j.status === 'done');
    const onTime = done.filter(j => j.doneAt <= j.deadline);
    // Idle = gaps inside a tractor's working day (free, with compatible work still open).
    // Minutes after a tractor's last task are 'spare capacity': it is released early.
    for (const t of this.tractors) {
      const last = t.stats.lastActive ?? -1;
      const ticks = t.idleTicks || [];
      t.stats.spare = ticks.filter(x => x > last).length;
      t.stats.idle = ticks.length - t.stats.spare;
    }
    const sum = k => this.tractors.reduce((a, t) => a + t.stats[k], 0);
    const W = { high: 3, medium: 2, low: 1 };
    return {
      jobsTotal: jobs.length,
      jobsCompleted: done.length,
      jobsOnTime: onTime.length,
      jobsLate: done.length - onTime.length,
      acresOnTime: +onTime.reduce((a, j) => a + j.acres, 0).toFixed(1),
      priorityValueOnTime: Math.round(onTime.reduce((a, j) => a + W[j.priority] * j.acres, 0)),
      travelMin: sum('travel'),
      idleMin: sum('idle') + sum('wait'),
      spareMin: sum('spare'),
      workMin: sum('work'),
      fuelStops: sum('fuelStops'),
      implementSwaps: sum('swaps'),
      makespan: this.time,
      makespanClock: fmtTime(this.time),
      violations: this.violations.filter(v => !['unfinished', 'deadline-flagged'].includes(v.kind)).length,
      lateFlagged: this.violations.filter(v => v.kind === 'deadline-flagged').length,
      violationList: this.violations,
      perTractor: Object.fromEntries(this.tractors.map(t => [t.id, { ...t.stats, minFuelPct: +t.stats.minFuelPct.toFixed(1) }])),
      nonProductiveMin: sum('travel') + sum('idle') + sum('wait'),
    };
  }
}
