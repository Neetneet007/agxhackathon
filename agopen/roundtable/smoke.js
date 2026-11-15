// Manual smoke test: one real discussion for a sample fault. Run: node agopen/roundtable/smoke.js
import { createRoundtable, credentialPresent } from './roundtable.js';

const rt = createRoundtable({
  say: (l) => console.log(`[${l.kind.padEnd(8)}] ${String(l.ms).padStart(5)}ms ${l.role}: ${l.text}  (${l.model ?? 'rules'})`),
  tools: {
    hold_tractor: {
      description: 'Hold one tractor in place until a person checks it.',
      input_schema: { type: 'object', properties: { tractor: { type: 'string' }, reason: { type: 'string' } }, required: ['tractor'] },
      handler: async (i) => ({ summary: `held ${i.tractor}${i.reason ? ' (' + i.reason + ')' : ''}` }),
    },
  },
});
console.log('credential present:', credentialPresent());
await rt.convene({ type: 'fault', title: 'T2 stalled on field F3', facts: { tractor: 'T2', kind: 'stall', signal: 'no movement for 40 s, engine load 0%', field: 'F3', fuel: '62%', others: [{ tractor: 'T1', field: 'F1' }, { tractor: 'T3', field: 'F4', distanceToT2: '180 m' }] } });
console.log(rt.stats());
