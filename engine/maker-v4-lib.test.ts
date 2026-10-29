import { test } from 'node:test'; import assert from 'node:assert/strict';
import { newBook, plan, observe, applyClose, applyPlace, filled, unfilled, rangeFor, exitLower, proceeds, liquidityFor, amountFor, migrateOrder, mtm, freshSize, worthIt, tripGasMon, gasLimit, tipGwei, reconcile, STRATEGY, V4, px, type Book } from './maker-v4-lib.mts';
const MIN = 60_000;
/** model executor: observe + plan + apply (the keeper's dry-run semantics) */
const run = (b: Book, tick: number, now: number, inv?: { mon: number; weth: number }, gasGwei?: number) => { observe(b, tick); const acts = plan(b, tick, now, { gas: true, fresh: true, gasGwei }, inv);
  for (const a of acts) { if (a.do === 'close') { const conv = a.o.kind === 'exit' ? a.why === 'fill' : !!a.o.crossed; const v = conv ? proceeds(a.o) : a.o.amt;
    applyClose(b, a.o, a.why, tick, ((a.o.side === 'ask') === conv) ? { mon: 0, weth: v } : { mon: v, weth: 0 }, now); }
    else if (a.do === 'place') applyPlace(b, a, String(Math.random()), a.amt, now, tick); } return acts; };

test('strict fill: ask needs tick >= upper, bid needs tick < lower; in range (partial) is neither filled nor returned', () => {
  assert.equal(filled({ side: 'ask', lower: 11 }, 11), false); assert.equal(filled({ side: 'ask', lower: 11 }, 12), true);
  assert.equal(filled({ side: 'bid', lower: 9 }, 9), false); assert.equal(filled({ side: 'bid', lower: 9 }, 8), true);
  assert.equal(unfilled({ side: 'ask', lower: 11 }, 11), false); assert.equal(unfilled({ side: 'ask', lower: 11 }, 10), true);
  assert.equal(unfilled({ side: 'bid', lower: 9 }, 9), false); assert.equal(unfilled({ side: 'bid', lower: 9 }, 10), true);
  assert.equal(rangeFor('ask', 10), 11); assert.equal(rangeFor('bid', 10), 9);
});
test('exit side: after an ask fill the bid exit sits at or BELOW the fill range, after a bid fill the ask exit at or ABOVE (old bug: tick-1 / tick+1 after drift)', () => {
  assert.equal(exitLower('bid', -116316, -116310), -116316);   // old keeper: -116311 = buying back 5 ticks above the sell (on-chain trip 643086->643087)
  assert.equal(exitLower('bid', -116309, -116308), -116309);
  assert.equal(exitLower('ask', -116296, -116298), -116296);   // old keeper: -116297 = selling back below the buy (643101->643103)
  for (let d = 1; d < 20; d++) { assert.ok(exitLower('bid', 0, d) <= 0); assert.ok(exitLower('ask', 0, -d) >= 0); }
});
test('a filled order is never closed: it stays in place as its own exit (no tx); a round trip counts only after a FULL return', () => {
  const b = newBook(); run(b, 0, 0); assert.equal(b.orders.length, 2);
  const ask = b.orders.find(o => o.side === 'ask')!; assert.equal(ask.lower, 1);
  assert.equal(run(b, 1, 1000).length, 0); assert.ok(!ask.crossed);                                       // tick inside [1,2): partial -> nothing
  const acts = run(b, 2, 2000); assert.ok(ask.crossed); assert.equal(acts.length, 0); assert.equal(b.sidePaused.ask, true);
  run(b, 1, 3000); assert.ok(ask.crossed); assert.equal(ask.rounds, 0);                                    // half way back: not a trip
  run(b, 0, 4000); assert.equal(ask.crossed, false); assert.equal(ask.rounds, 1); assert.ok(b.orders.includes(ask)); assert.equal(b.sidePaused.ask, false);
});
test('pause-when-full + no-stall: never more than 1 order per side / 2 total, nothing placed while both are filled, resumes after', () => {
  const b = newBook(); run(b, 0, 0);
  for (const t of [2, 5, -3, -8, 0, 4, -1, 1, 0]) { run(b, t, 1000); assert.ok(b.orders.length <= STRATEGY.maxFresh); for (const s of ['ask', 'bid']) assert.ok(b.orders.filter(o => o.side === s).length <= 1); }
  const both = newBook(); applyPlace(both, { do: 'place', kind: 'fresh', side: 'ask', lower: 1, amt: 1 }, 'a', 100, 0, 0); applyPlace(both, { do: 'place', kind: 'fresh', side: 'bid', lower: -1, amt: 1 }, 'b', 100, 0, 0);
  both.orders[0].crossed = both.orders[1].crossed = true; assert.equal(plan(both, 0, 99 * MIN, { gas: true, fresh: true }).length, 0);
});
test('recentre: only unfilled, > 3 ticks out AND >= 15 min old (configurable); filled orders never moved', () => {
  const b = newBook(); run(b, 0, 0);
  assert.equal(STRATEGY.recentreMs, 15 * MIN); assert.equal(STRATEGY.recentreTicks, 3);
  const askClose = (a: any[]) => a.some(x => x.do === 'close' && x.o.side === 'ask' && x.why === 'recentre');
  assert.ok(!askClose(plan(b, -3, 20 * MIN, { gas: true, fresh: true })));   // 3 out: keep
  assert.ok(!askClose(plan(b, -4, 14 * MIN, { gas: true, fresh: true })));   // too young
  assert.ok(askClose(plan(b, -4, 15 * MIN, { gas: true, fresh: true })));
  assert.ok(!askClose(plan(b, -4, 15 * MIN, { gas: true, fresh: true }, undefined, { recentreTicks: 10 })));
  assert.ok(askClose(plan(b, -4, 2 * MIN, { gas: true, fresh: true }, undefined, { recentreMs: MIN })));
  const c = newBook(); run(c, 0, 0); run(c, 2, 1); const ca = c.orders.find(o => o.side === 'ask')!; assert.ok(ca.crossed);
  assert.ok(!plan(c, 30, 60 * MIN, { gas: true, fresh: true }).some(x => x.do === 'close' && x.o.id === ca.id));
});
test('PnL accounting uses the MINTED amount: a same-tick round trip is +2 fees (old book: amountMax vs minted = fake -0.1%)', () => {
  const lower = -116309, max = 151.34727045; const liq = liquidityFor('ask', lower, BigInt(Math.floor(max * 1e18)));
  const minted = amountFor('ask', lower, liq); assert.ok(minted <= max && max / minted - 1 < 2e-6);
  const b = newBook(); applyPlace(b, { do: 'place', kind: 'fresh', side: 'ask', lower, amt: max }, '1', minted, 0, lower - 1);
  const o = b.orders[0]; observe(b, lower + 1); observe(b, lower - 1); assert.equal(o.rounds, 1);
  applyClose(b, o, 'recentre', lower - 5, { mon: minted * (1 + V4.fee) ** 2, weth: 0 }, 1);
  assert.equal(b.trips.length, 1); assert.ok(Math.abs(b.trips[0].pnlMon / minted - 0.001) < 1e-5); assert.equal(b.trips[0].rounds, 1);
  // on-chain 643088 -> 643089: fresh amountMax 151.347 MON, minted 0.999x, exit returned 151.19589 MON + 0.1% WETH spare idle in the vault; old book -0.1514
  const legacy = migrateOrder({ id: 'x', kind: 'exit', side: 'bid', lower, amt: 0.00134523, placedAt: 0, startMonEq: 151.34727045, startAsset: 'MON', startAmt: 151.34727045 });
  const c = newBook(); c.orders.push(legacy); applyClose(c, legacy, 'fill', lower - 1, { mon: 151.19588534, weth: 0 }, 1);
  assert.ok(c.trips[0].pnlMon > 0.14 && c.trips[0].pnlMon < 0.16, String(c.trips[0].pnlMon));
  const amt = legacy.amt; migrateOrder(legacy); assert.equal(legacy.amt, amt);   // idempotent
  const r = newBook(); applyPlace(r, { do: 'place', kind: 'fresh', side: 'bid', lower: -5, amt: 1 }, 'r', 1, 0, 0); applyClose(r, r.orders[0], 'recentre', 0, 1, 1); assert.equal(r.trips.length, 0); assert.equal(r.dayPnl, 0);
});
test('MTM: unfilled = 0, filled order marked at spot', () => {
  const b = newBook(); applyPlace(b, { do: 'place', kind: 'fresh', side: 'ask', lower: 1, amt: 100 }, '1', 100, 0, 0);
  assert.equal(mtm(b, 0), 0); observe(b, 2); assert.ok(Math.abs(mtm(b, 1) - 100 * 0.0005) < 0.01); assert.ok(mtm(b, 50) < 0 && mtm(b, -50) > 0);
});
test('gas: limit = estimate x 1.03 rounded up, fixed fallbacks, tip clamped to 0..1 gwei and >= network minimum', () => {
  assert.equal(gasLimit(357_000n, 'ask'), 367_710n); assert.equal(gasLimit(100_001n, 'close'), 103_002n);
  assert.equal(gasLimit(null, 'ask'), 360_000n); assert.equal(gasLimit(null, 'bid'), 530_000n); assert.equal(gasLimit(null, 'close'), 270_000n);
  assert.equal(tipGwei(undefined), 0.5); assert.equal(tipGwei(10.2), 1); assert.equal(tipGwei(-1), 0); assert.equal(tipGwei(0), 0); assert.equal(tipGwei(0.2, 0.3), 0.3);
});
test('sizing: ask <= 45% vault MON, bid <= 90% vault WETH, <= 1,000 MON-eq, one per side', () => {
  const t = -116279;
  const a = plan(newBook(), t, 0, { gas: true, fresh: true }, { mon: 1110, weth: 0.0098 }) as any[];
  assert.equal(a.length, 2); assert.ok(Math.abs(a.find(x => x.side === 'ask').amt - 499.5) < 1e-9); assert.ok(Math.abs(a.find(x => x.side === 'bid').amt - 0.0098 * 0.9) < 1e-12);
  assert.equal(freshSize('ask', t, { mon: 5000, weth: 0 }), 1000); assert.ok(freshSize('bid', t, { mon: 0, weth: 1 }) / px(t) <= 1000);
  const b = plan(newBook(), t, 0, { gas: true, fresh: true }, { mon: 1110, weth: 0 }) as any[]; assert.equal(b.length, 1); assert.equal(b[0].side, 'ask');
});
test('min-profit gate: skip an order whose 2-leg fee < 1.5x its round-trip gas', () => {
  const g = 100.5; assert.ok(Math.abs(tripGasMon('ask', g) - 630_000 * g * 1e-9) < 1e-12);
  const askMin = 1.5 * tripGasMon('ask', g) / (2 * V4.fee), bidMin = 1.5 * tripGasMon('bid', g) / (2 * V4.fee);
  assert.ok(askMin > 90 && askMin < 100 && bidMin > 115 && bidMin < 125, `${askMin} ${bidMin}`);
  assert.equal(worthIt('ask', askMin - 1, g), false); assert.equal(worthIt('ask', askMin + 1, g), true);
  const t = -116279; assert.equal(freshSize('ask', t, { mon: 186.95, weth: 0 }, g), 0);   // 84 MON ask: skipped
  assert.ok(freshSize('bid', t, { mon: 0, weth: 0.0098 }, g) > 0);
  assert.equal(plan(newBook(), t, 0, { gas: true, fresh: true, gasGwei: g }, { mon: 186.95, weth: 0.0098 }).length, 1);
});
test('daily loss blocks new orders (time-boxed, no halt)', () => { const b = newBook(); b.dayGas = 26; assert.equal(plan(b, 0, 0, { gas: true, fresh: true }).length, 0); assert.equal(b.halted, ''); });
test('legacy exits close on a full fill and count against the vault maxOpen; reconcile derives sidePaused', () => {
  const b = newBook(); for (const [id, l] of [['1', -20], ['2', -25], ['3', -30]] as const) b.orders.push(migrateOrder({ id, kind: 'exit', side: 'bid', lower: l, amt: 100, placedAt: 0, startMonEq: 100, startAsset: 'MON', startAmt: 100 }));
  let a = plan(b, 0, 0, { gas: true, fresh: true }); assert.equal(a.filter(x => x.do === 'place').length, 1);    // 3 legacy + 1 = vault max 4
  a = plan(b, -21, 0, { gas: true, fresh: true }); assert.deepEqual(a.filter(x => x.do === 'close').map((x: any) => x.o.id), ['1']); assert.equal(a.filter(x => x.do === 'place').length, 2);
  const r = reconcile(b, ['2', '3', '9']); assert.deepEqual(r.orphans, ['9']); assert.deepEqual(b.sidePaused, { ask: false, bid: false });
});
