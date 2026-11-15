import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoundtable } from '../roundtable/roundtable.js';

const facts = { tractor: 'T2', kind: 'stall', signal: 'no movement for 40 s', field: 'F3' };
const sys = (p) => (p.system.match(/^# (.+)$/m) || [])[1];
const text = (t) => ({ content: [{ type: 'text', text: t }], model: 'fake', stop_reason: 'end_turn' });

function fake(handler) {
  const calls = [];
  return { calls, messages: { create: async (p, o) => { const c = { p, start: Date.now() }; calls.push(c); return handler(p, o, c); } } };
}

test('fallback lines: one per default speaker, chair last, mention tractor', async () => {
  const lines = [];
  const rt = createRoundtable({ say: (l) => lines.push(l), enabled: false });
  await rt.convene({ type: 'fault', title: 'T2 fault', facts });
  assert.deepEqual(lines.map((l) => l.agent), ['fault-manager', 'fleet-manager', 'safety-officer', 'plan-manager']);
  for (const l of lines) { assert.equal(l.kind, 'fallback'); assert.match(l.text, /T2/); }
  assert.equal(rt.stats().fallbacks, 4);
});

test('round 1 parallel, chair after and sees their lines; managers get no tools', async () => {
  const c = fake(async (p) => { await new Promise((r) => setTimeout(r, 40)); return text(`${sys(p)} speaks`); });
  const lines = [];
  const rt = createRoundtable({ say: (l) => lines.push(l), _client: c, tools: { t: { description: 'x', input_schema: { type: 'object' }, handler: async () => 1 } } });
  await rt.convene({ type: 'fault', title: 'x', facts });
  assert.equal(c.calls.length, 4);
  const starts = c.calls.slice(0, 3).map((x) => x.start);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 15);
  assert.ok(c.calls[3].start >= Math.max(...starts) + 40);
  const chair = c.calls[3].p;
  assert.match(chair.messages[0].content, /Fault Manager: Fault Manager speaks/);
  assert.ok(chair.tools?.length === 1);
  for (const x of c.calls.slice(0, 3)) assert.equal(x.p.tools, undefined);
  assert.deepEqual(lines.map((l) => l.kind), ['says', 'says', 'says', 'decision']);
});

test('chair tool call runs handler once, then decision; third call refused', async () => {
  let n = 0, handled = [];
  const c = fake(async (p) => {
    if (sys(p) !== 'Plan Manager') return text('ok');
    n++;
    if (n === 1) return { content: [{ type: 'tool_use', id: 'a', name: 'hold', input: { tractor: 'T2' } }, { type: 'tool_use', id: 'b', name: 'hold', input: { tractor: 'T3' } }, { type: 'tool_use', id: 'c', name: 'hold', input: { tractor: 'T1' } }], stop_reason: 'tool_use' };
    const last = p.messages.at(-1).content;
    assert.equal(last.length, 3);
    assert.equal(last[2].is_error, true);
    return text('Holding T2 and T3.');
  });
  const lines = [];
  const rt = createRoundtable({ say: (l) => lines.push(l), _client: c, tools: { hold: { description: 'h', input_schema: { type: 'object' }, handler: async (i) => { handled.push(i); return { summary: `held ${i.tractor}` }; } } } });
  await rt.convene({ type: 'recovered', title: 'x', facts });
  assert.deepEqual(handled, [{ tractor: 'T2' }, { tractor: 'T3' }]);
  const kinds = lines.map((l) => l.kind);
  assert.deepEqual(kinds, ['says', 'tool', 'tool', 'tool', 'decision']);
  assert.match(lines[1].text, /Plan Manager called hold: held T2/);
  assert.match(lines[3].text, /refused/);
  assert.equal(rt.stats().toolCalls, 2);
});

test('hanging client times out into fallback and convene resolves', async () => {
  const c = fake(() => new Promise(() => {}));
  const lines = [];
  const rt = createRoundtable({ say: (l) => lines.push(l), _client: c, timeoutMs: 50 });
  await rt.convene({ type: 'recovered', title: 'x', facts });
  assert.deepEqual(lines.map((l) => l.kind), ['fallback', 'fallback']);
  assert.match(rt.stats().lastError, /timed out/);
});

test('throwing client does not reject; lastError set', async () => {
  const c = fake(async () => { throw new Error('boom'); });
  const rt = createRoundtable({ say() {}, _client: c });
  await rt.convene({ type: 'fault', title: 'x', facts });
  assert.equal(rt.stats().lastError, 'boom');
  assert.equal(rt.stats().fallbacks, 4);
});

test('queue runs in order and drops oldest waiting beyond three', async () => {
  const lines = [];
  const rt = createRoundtable({ say: (l) => lines.push(l), enabled: false });
  await Promise.all([1, 2, 3, 4, 5].map((i) => rt.convene({ type: 'job-done', title: `n${i}`, facts: { tractor: `T${i}` } })));
  assert.deepEqual(lines.map((l) => l.text.match(/T\d/)[0]), ['T1', 'T3', 'T4', 'T5']);
  assert.equal(rt.stats().topics, 4);
  assert.equal(rt.stats().dropped, 1);
});

test('agents lists seven managers from the md files', () => {
  const rt = createRoundtable({ say() {}, enabled: false });
  assert.equal(rt.agents.length, 7);
  const chair = rt.agents.find((a) => a.id === 'plan-manager');
  assert.equal(chair.name, 'Plan Manager');
  for (const a of rt.agents) assert.ok(a.name && a.role);
});
