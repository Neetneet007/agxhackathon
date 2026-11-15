import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrone, scanPath, fieldTruth, recommendFor } from '../drone.js';

const DT = 0.25;
const rect = (e0, n0, w, h) => [
  { e: e0, n: n0 }, { e: e0 + w, n: n0 }, { e: e0 + w, n: n0 + h }, { e: e0, n: n0 + h },
];

// Run until `until(events)` is true or maxTicks; collects events and per-tick states.
function run(d, { maxTicks = 40000, until, onTick } = {}) {
  const events = [];
  const states = [];
  let prev = d.state();
  for (let i = 0; i < maxTicks; i++) {
    const ev = d.tick(DT);
    const s = d.state();
    // speed check on every tick
    const step = Math.hypot(s.e - prev.e, s.n - prev.n);
    assert.ok(step <= 12 * DT + 1e-6, `moved ${step} in one tick`);
    prev = s;
    events.push(...ev);
    states.push(s);
    if (onTick) onTick(s, ev, i);
    if (until && until(events, s)) break;
  }
  return { events, states };
}

test('fresh drone is docked at home, full, simulated', () => {
  const d = createDrone({ home: { e: 5, n: 7 } });
  const s = d.state();
  assert.equal(s.status, 'docked');
  assert.equal(s.e, 5); assert.equal(s.n, 7);
  assert.equal(s.batteryPct, 100);
  assert.equal(s.simulated, true);
  assert.equal(s.mission, null);
  assert.equal(s.queue, 0);
  assert.deepEqual(d.tick(1), []);
});

test('investigate: arrive, circle the tractor at 22 m for ~14 s, one report, return, dock', () => {
  const d = createDrone();
  const target = { e: 120, n: 50 };
  const id = d.assign({ type: 'investigate', target, subject: 'T2', symptom: 'GO_NOT_MOVING' });
  let hoverTicks = 0, minDist = Infinity;
  const { events } = run(d, {
    until: (ev) => ev.some((e) => e.type === 'docked'),
    onTick: (s) => {
      if (s.status === 'hovering') hoverTicks++;
      minDist = Math.min(minDist, Math.hypot(s.e - target.e, s.n - target.n));
    },
  });
  assert.ok(Math.abs(minDist - 22) < 1.5, `closest ${minDist} m`);   // it circles the tractor, it does not sit on top of it
  assert.ok(Math.abs(hoverTicks * DT - 14) <= 0.6, `circled ${hoverTicks * DT}s`);
  const reports = events.filter((e) => e.type === 'report');
  assert.equal(reports.length, 1);
  const r = reports[0].report;
  assert.equal(reports[0].missionId, id);
  assert.equal(r.kind, 'fault-inspection');
  assert.equal(r.simulated, true);
  assert.equal(r.subject, 'T2');
  assert.ok(r.findings.length >= 3);
  assert.ok(['send a person', 'safe to restart remotely', 'keep out of service'].includes(r.recommend));
  assert.equal(typeof r.assessment, 'string');
  assert.ok(events.some((e) => e.type === 'arrived'));
  assert.ok(events.some((e) => e.type === 'returning' && e.reason === 'missions done'));
  assert.ok(events.some((e) => e.type === 'docked'));
  assert.ok(['docked', 'charging'].includes(d.state().status));
});

function report(subject, symptom, seed) {
  const d = createDrone({ seed });
  d.assign({ type: 'investigate', target: { e: 20, n: 0 }, subject, symptom });
  const { events } = run(d, { until: (ev) => ev.some((e) => e.type === 'report') });
  return events.find((e) => e.type === 'report').report;
}

test('investigate findings are deterministic per subject/symptom/seed and vary by seed', () => {
  assert.deepEqual(report('T1', 'GO_NOT_MOVING', 3), report('T1', 'GO_NOT_MOVING', 3));
  const causes = new Set();
  for (let seed = 1; seed <= 20; seed++) causes.add(report('T1', 'GO_NOT_MOVING', seed).findings[3]);
  assert.ok(causes.size > 1);
  const nr = report('T3', 'NO_RESPONSE', 1);
  assert.ok(nr.findings.length >= 3);
  assert.ok(nr.findings.some((f) => /antenna/i.test(f)));
});

test('scanPath over 100x60 rectangle', () => {
  const pts = scanPath(rect(0, 0, 100, 60), 30);
  assert.ok(pts.length >= 4);
  for (const p of pts) {
    assert.ok(p.e >= 0 && p.e <= 100 && p.n >= 0 && p.n <= 60);
  }
  const lines = [];
  for (let i = 0; i < pts.length; i += 2) lines.push([pts[i], pts[i + 1]]);
  assert.ok(lines.length >= 2);
  for (let i = 1; i < lines.length; i++) {
    const prevDir = Math.sign(lines[i - 1][1].e - lines[i - 1][0].e);
    const dir = Math.sign(lines[i][1].e - lines[i][0].e);
    assert.equal(dir, -prevDir);
  }
});

test('scan: progress monotonic to 100, one report, pests inside bbox', () => {
  const d = createDrone();
  const field = { name: 'North 40', boundary: rect(100, 100, 100, 60), ground: 'sown', crop: 'corn' };
  d.assign({ type: 'scan', field });
  const prog = [];
  const { events } = run(d, {
    until: (ev) => ev.some((e) => e.type === 'docked'),
    onTick: (s) => { if (s.mission) prog.push(s.mission.progressPct); },
  });
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i] >= prog[i - 1]);
  assert.ok(prog.length && prog[0] <= 1 && prog.at(-1) >= 90);
  const reports = events.filter((e) => e.type === 'report');
  assert.equal(reports.length, 1);
  const r = reports[0].report;
  assert.equal(r.kind, 'field-scan');
  assert.equal(r.simulated, true);
  assert.equal(r.areaM2, 6000);
  for (const p of r.pests) {
    assert.ok(p.e >= 100 && p.e <= 200 && p.n >= 100 && p.n <= 160);
  }
  assert.ok(r.recommend.length >= 1);
  assert.equal(typeof r.summary, 'string');
});

test('recommendations follow the rules', () => {
  const base = { moisturePct: 20, trafficable: true, standPct: 90, maturityPct: 10, harvestReady: false, weedsPct: 1 };
  const spot = { fx: 0.5, fy: 0.5, radiusM: 10, severity: 'low' };
  const acts = (t, area) => recommendFor(t, area).map((r) => r.action);
  assert.deepEqual(acts({ ...base, pestSpots: [] }, 10000), ['none']);
  assert.deepEqual(acts({ ...base, pestSpots: [spot] }, 10000), ['spot-spray']); // ~3%
  assert.deepEqual(acts({ ...base, pestSpots: [spot] }, 1500), ['spray-field']); // ~21%
  assert.deepEqual(acts({ ...base, trafficable: false, moisturePct: 40, pestSpots: [] }, 10000), ['hold-machines']);
  assert.deepEqual(acts({ ...base, harvestReady: true, maturityPct: 95, pestSpots: [spot] }, 10000), ['spot-spray', 'harvest']);
});

test('fieldTruth is deterministic and matches ground', () => {
  assert.deepEqual(fieldTruth('A', 'sown', 1), fieldTruth('A', 'sown', 1));
  for (let i = 0; i < 60; i++) {
    const name = `F${i}`;
    for (const ground of ['not plowed', 'plowed', 'sown']) {
      const t = fieldTruth(name, ground, i);
      assert.ok(t.moisturePct >= 8 && t.moisturePct <= 45);
      assert.equal(t.trafficable, t.moisturePct < 32);
      assert.ok(t.pestSpots.length <= 3);
      for (const p of t.pestSpots) {
        assert.ok(p.fx >= 0 && p.fx <= 1 && p.fy >= 0 && p.fy <= 1);
        assert.ok(p.radiusM >= 6 && p.radiusM <= 14);
        assert.ok(['low', 'medium', 'high'].includes(p.severity));
      }
      if (ground === 'plowed') {
        assert.equal(t.standPct, 0); assert.equal(t.maturityPct, 0);
        assert.equal(t.pestSpots.length, 0); assert.ok(t.weedsPct >= 0 && t.weedsPct <= 3);
        assert.equal(t.harvestReady, false);
      } else if (ground === 'not plowed') {
        assert.equal(t.standPct, 0); assert.equal(t.maturityPct, 0);
        assert.equal(t.harvestReady, false); assert.ok(t.weedsPct >= 5 && t.weedsPct <= 25);
        const c = fieldTruth(name, ground, i, 'wheat');
        assert.ok(c.standPct >= 80 && c.standPct <= 98);
        assert.ok(c.maturityPct >= 40 && c.maturityPct <= 100);
        assert.equal(c.harvestReady, c.maturityPct >= 85);
      } else {
        assert.ok(t.standPct >= 70 && t.standPct <= 98);
        assert.ok(t.maturityPct >= 5 && t.maturityPct <= 20);
        assert.equal(t.harvestReady, false);
      }
    }
  }
});

test('spot-spray: one sprayed event per spot, in order', () => {
  const d = createDrone();
  const spots = [{ e: 40, n: 10, radiusM: 8 }, { e: 60, n: 30, radiusM: 6 }, { e: 20, n: 40, radiusM: 10 }];
  d.assign({ type: 'spot-spray', field: 'East', spots });
  let sprayingTicks = 0;
  const { events } = run(d, {
    until: (ev) => ev.some((e) => e.type === 'docked'),
    onTick: (s) => { if (s.status === 'spraying') sprayingTicks++; },
  });
  const sprayed = events.filter((e) => e.type === 'sprayed');
  assert.equal(sprayed.length, 3);
  assert.deepEqual(sprayed.map((e) => e.spot), spots);
  assert.ok(sprayed.every((e) => e.field === 'East'));
  assert.ok(Math.abs(sprayingTicks * DT - 12) <= 1);
});

test('investigate during a scan runs first; scan resumes and completes', () => {
  const d = createDrone();
  d.assign({ type: 'scan', field: { name: 'Big', boundary: rect(100, 0, 200, 120), ground: 'plowed' } });
  let injected = false, progAtInject = 0;
  const kinds = [];
  const prog = [];
  run(d, {
    until: (ev) => ev.some((e) => e.type === 'docked'),
    onTick: (s, ev) => {
      if (s.mission && s.mission.type === 'scan') prog.push(s.mission.progressPct);
      if (!injected && s.mission && s.mission.progressPct > 20) {
        injected = true;
        progAtInject = s.mission.progressPct;
        d.assign({ type: 'investigate', target: { e: 50, n: 80 }, subject: 'T1', symptom: 'NO_RESPONSE' });
        assert.equal(d.state().queue, 2);
      }
      for (const e of ev) if (e.type === 'report') kinds.push(e.report.kind);
    },
  });
  assert.ok(injected);
  assert.deepEqual(kinds, ['fault-inspection', 'field-scan']);
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i] >= prog[i - 1] - 1e-9);
  assert.ok(prog.at(-1) >= progAtInject);
});

test('battery: returns when low, recharges, finishes; stays within 0..100', () => {
  const d = createDrone({ batteryMin: 0.6 });
  d.assign({ type: 'scan', field: { name: 'Far', boundary: rect(150, 0, 100, 60), ground: 'sown' } });
  let min = 100, max = 0, lowReturns = 0, reports = 0, chargedWhileDocked = false;
  const prog = [];
  run(d, {
    maxTicks: 20000,
    until: (ev, s) => reports > 0 && s.status !== 'flying' && s.status !== 'scanning' && s.status !== 'returning',
    onTick: (s, ev) => {
      min = Math.min(min, s.batteryPct); max = Math.max(max, s.batteryPct);
      if (s.status === 'charging') chargedWhileDocked = true;
      if (s.mission) prog.push(s.mission.progressPct);
      for (const e of ev) {
        if (e.type === 'returning' && e.reason === 'battery low') lowReturns++;
        if (e.type === 'report') reports++;
      }
    },
  });
  assert.ok(lowReturns >= 1);
  assert.ok(chargedWhileDocked);
  assert.equal(reports, 1);
  assert.ok(min >= 0 && max <= 100);
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i] >= prog[i - 1] - 1e-9);
});

test('speed: never exceeds speedMps x dt, with varied dt', () => {
  const d = createDrone({ speedMps: 7 });
  d.assign({ type: 'scan', field: { name: 'S', boundary: rect(30, 30, 60, 60), ground: 'sown' } });
  d.assign({ type: 'investigate', target: { e: -40, n: 20 }, subject: 'T3', symptom: 'GO_NOT_MOVING' });
  let prev = d.state();
  for (let i = 0; i < 20000; i++) {
    const dt = [0.05, 0.1, 0.5, 1, 2.3][i % 5];
    d.tick(dt);
    const s = d.state();
    assert.ok(Math.hypot(s.e - prev.e, s.n - prev.n) <= 7 * dt + 1e-6);
    prev = s;
  }
});

test('cancelAll sends an airborne drone home', () => {
  const d = createDrone();
  d.assign({ type: 'investigate', target: { e: 100, n: 0 }, subject: 'T1', symptom: 'NO_RESPONSE' });
  for (let i = 0; i < 20; i++) d.tick(DT);
  d.cancelAll();
  const ev = d.tick(DT);
  assert.ok(ev.some((e) => e.type === 'returning'));
  const { events } = run(d, { until: (e) => e.some((x) => x.type === 'docked') });
  assert.ok(events.some((e) => e.type === 'docked'));
});
