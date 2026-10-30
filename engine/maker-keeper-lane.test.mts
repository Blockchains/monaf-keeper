import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
// the lane is a 2-line mutex; test the same construction the keeper uses (importing the keeper would start it)
const src = readFileSync(new URL('./maker-keeper-v4.mts', import.meta.url), 'utf8');
test('keeper: one nonce lane wraps every send, V6 order has tickUpper', async () => {
  assert.match(src, /return inLane\(async \(\) => \{/); assert.equal((src.match(/sendRawTransaction/g) ?? []).length, 1);
  assert.match(src, /tickUpper: a\.lower \+ \(a\.w \?\? 1\)/);
  let lane: Promise<unknown> = Promise.resolve(); const inLane = <T,>(f: () => Promise<T>) => { const r = lane.then(f, f); lane = r.catch(() => {}); return r; };
  let inside = 0, max = 0; const order: number[] = [];
  const job = (i: number, fail = false) => inLane(async () => { inside++; max = Math.max(max, inside); await new Promise(r => setTimeout(r, 5 * (5 - i))); order.push(i); inside--; if (fail) throw new Error('x'); return i; });
  const r = await Promise.allSettled([job(0), job(1, true), job(2), job(3)]);
  assert.equal(max, 1); assert.deepEqual(order, [0, 1, 2, 3]); assert.equal(r[1].status, 'rejected'); assert.equal((r[3] as any).value, 3);
});
