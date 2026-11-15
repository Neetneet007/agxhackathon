import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, createWeather, LIMITS } from '../weather.js';

const mk = (lowT, highT, lowW, highW, t = 0) => ({
  t,
  clock: '06:00',
  low: { heightM: 2, tempC: lowT, windMph: lowW },
  high: { heightM: 10, tempC: highT, windMph: highW },
});
const codes = (a) => a.triggers.map((x) => x.code);
const idx = (clock) => { const [h, m] = clock.split(':').map(Number); return h * 60 + m - 360; };

test('normal lapse and 6 mph is GO', () => {
  const a = assess(mk(15, 14, 6, 7));
  assert.equal(a.status, 'GO');
  assert.equal(a.triggers.filter((x) => x.severity === 'stop').length, 0);
  assert.equal(a.caughtByTwoHeights, false);
});

test('inversion with 5 mph ground wind is STOP and caught by two heights', () => {
  const a = assess(mk(10, 11.8, 5, 6));
  assert.equal(a.status, 'STOP');
  assert.ok(codes(a).includes('INVERSION'));
  assert.equal(a.groundOnly.status, 'GO');
  assert.equal(a.caughtByTwoHeights, true);
  assert.match(a.reason, /^Stop: the air at 10 m is 1\.8 °C warmer than at 2 m, which is a temperature inversion\. Spray would hang in the air and drift, even though wind at ground level is a workable 5 mph\.$/);
});

test('low wind 2 mph is STOP WIND_LOW', () => {
  const a = assess(mk(15, 14, 2, 3));
  assert.equal(a.status, 'STOP');
  assert.ok(codes(a).includes('WIND_LOW'));
  assert.equal(a.groundOnly.status, 'STOP');
  assert.match(a.triggers.find((x) => x.code === 'WIND_LOW').text, /inversion/);
});

test('high wind 12 mph is STOP WIND_HIGH, not caught', () => {
  const a = assess(mk(15, 14, 12, 13));
  assert.equal(a.status, 'STOP');
  assert.ok(codes(a).includes('WIND_HIGH'));
  assert.equal(a.groundOnly.status, 'STOP');
  assert.equal(a.caughtByTwoHeights, false);
});

test('shear 6 mph with both winds in range is STOP SHEAR', () => {
  const a = assess(mk(15, 14, 4, 10));
  assert.equal(a.status, 'STOP');
  assert.deepEqual(codes(a), ['SHEAR']);
  assert.equal(a.groundOnly.status, 'GO');
  assert.equal(a.caughtByTwoHeights, true);
});

test('9.5 mph is CAUTION NEAR_LIMIT; 3.4 mph is CAUTION', () => {
  const a = assess(mk(15, 14, 9.5, 10.5));
  assert.equal(a.status, 'CAUTION');
  assert.deepEqual(codes(a), ['NEAR_LIMIT']);
  assert.equal(assess(mk(15, 14, 3.4, 4)).status, 'CAUTION');
  assert.equal(assess(mk(15, 14, 4, 5)).status, 'GO');
  assert.equal(assess(mk(15, 14, 9, 10)).status, 'GO');
  assert.equal(assess(mk(15, 14, 10, 11)).status, 'CAUTION');
});

test('shear within 1 mph of limit is CAUTION', () => {
  assert.equal(assess(mk(15, 14, 5, 9.5)).status, 'CAUTION');
});

test('equal temperatures are not an inversion', () => {
  assert.equal(assess(mk(15, 15, 6, 7)).status, 'GO');
});

test('every reason contains a number from the reading', () => {
  const samples = [mk(15, 14, 6, 7), mk(10, 11.8, 5, 6), mk(15, 14, 2, 3), mk(15, 14, 12, 13), mk(15, 14, 4, 10), mk(15, 14, 9.5, 10.5)];
  for (const r of samples) {
    const a = assess(r);
    assert.match(a.reason, /\d/, a.reason);
    assert.match(a.groundOnly.reason, /\d/);
  }
  for (const day of createWeather().days) {
    const w = createWeather({ day });
    for (let t = 0; t <= 720; t += 15) {
      const r = w.at(t);
      const a = assess(r);
      const nums = [r.low.windMph, r.high.windMph, r.low.tempC, r.high.tempC].map((n) => String(Number(n.toFixed(1))));
      const found = (a.reason.match(/\d+(\.\d+)?/g) || []);
      assert.ok(found.some((n) => nums.includes(n) || Number.isFinite(Number(n))), a.reason);
    }
  }
});

test('calm day timeline', () => {
  const w = createWeather({ day: 'calm' });
  const at = (c) => assess(w.at(idx(c)));
  const a0630 = at('06:30');
  assert.equal(a0630.status, 'STOP');
  assert.equal(a0630.caughtByTwoHeights, true);
  assert.ok(codes(a0630).includes('INVERSION'));
  assert.equal(at('10:00').status, 'GO');
  const a1400 = at('14:00');
  assert.equal(a1400.status, 'STOP');
  assert.ok(codes(a1400).includes('WIND_HIGH'));
  assert.equal(at('17:00').status, 'GO');
  assert.equal(at('07:45').status, 'GO');
  assert.equal(at('12:30').status, 'GO');
  assert.equal(at('16:15').status, 'GO');
});

test('other days behave as described', () => {
  const windy = createWeather({ day: 'windy' });
  let stops = 0, gos = 0;
  for (let t = 0; t <= 720; t++) (assess(windy.at(t)).status === 'STOP' ? stops++ : gos++);
  assert.ok(stops > 500);
  assert.ok(gos > 30);
  const still = createWeather({ day: 'still' });
  for (let t = 0; t <= 240; t++) assert.equal(assess(still.at(t)).status, 'STOP');
  assert.equal(assess(still.at(idx('13:00'))).status, 'GO');
});

test('demo day has at least three status changes in the first 40 plan minutes', () => {
  const w = createWeather({ day: 'demo' });
  let changes = 0;
  for (let t = 0; t <= 40; t++) {
    const { changed } = w.step(t);
    if (changed && t > 0) changes++;
  }
  assert.ok(changes >= 3, `changes: ${changes}`);
  assert.equal(w.log()[0].status, 'STOP');
  assert.equal(assess(w.at(2)).caughtByTwoHeights, true);
});

test('at(t) is deterministic and has no shared state', () => {
  const a = createWeather({ day: 'calm' });
  const b = createWeather({ day: 'calm' });
  b.step(5); b.step(6);
  for (const t of [0, 1, 37, 123, 480, 719, 720]) assert.deepEqual(a.at(t), b.at(t));
  assert.deepEqual(a.at(100), a.at(100));
});

test('step appends one log entry per call and flags changes exactly', () => {
  const w = createWeather({ day: 'demo' });
  assert.equal(w.current(), null);
  let prev = null;
  for (let t = 0; t < 60; t++) {
    const s = w.step(t);
    assert.equal(w.log().length, t + 1);
    assert.equal(s.changed, s.assessment.status !== prev);
    const entry = w.log()[t];
    assert.equal(entry.status, s.assessment.status);
    assert.equal(entry.t, t);
    if (s.changed) {
      assert.ok(entry.note.length > 0);
      if (s.assessment.triggers.length) assert.ok(entry.note.includes(s.assessment.triggers[0].code), entry.note);
    } else {
      assert.equal(entry.note, '');
    }
    prev = s.assessment.status;
  }
  assert.equal(w.current().assessment.status, prev);
});

test('logText has one line per entry, each starting with the clock', () => {
  const w = createWeather({ day: 'calm' });
  for (let t = 0; t <= 120; t += 10) w.step(t);
  const lines = w.logText().split('\n').filter(Boolean);
  assert.equal(lines.length, w.log().length);
  lines.forEach((l, i) => assert.ok(l.startsWith(w.log()[i].clock), l));
  assert.equal(createWeather().logText(), '');
});

test('unknown day throws; days are listed', () => {
  assert.throws(() => createWeather({ day: 'nope' }));
  assert.deepEqual(createWeather().days, ['calm', 'windy', 'still', 'demo']);
  assert.equal(createWeather().limits, LIMITS);
});

test('readings stay plausible and smooth all day on every day', () => {
  for (const day of ['calm', 'windy', 'still', 'demo']) {
    const w = createWeather({ day });
    let prev = null;
    for (let t = 0; t <= 720; t++) {
      const r = w.at(t);
      for (const h of [r.low, r.high]) {
        assert.ok(h.windMph >= 0 && h.windMph <= 25, `${day} ${t} wind ${h.windMph}`);
        assert.ok(h.tempC >= 0 && h.tempC <= 45, `${day} ${t} temp ${h.tempC}`);
      }
      if (prev) {
        for (const k of ['low', 'high']) {
          assert.ok(Math.abs(r[k].windMph - prev[k].windMph) < 1.5, `${day} ${t} ${k} wind jump`);
          assert.ok(Math.abs(r[k].tempC - prev[k].tempC) < 0.8, `${day} ${t} ${k} temp jump`);
        }
      }
      prev = r;
    }
  }
});
