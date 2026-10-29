import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { newBook, plan, observe, waitReason, rollDay, clearHaltOnStart, reconcile, applyPlace, STRATEGY } from './maker-v4-lib.mts';
import { BlockFeed } from './maker-v4-feed.mts';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const T0 = Date.parse('2026-10-29T12:00:00Z');

test('stale data -> wait (no new orders, no on-chain pause), then auto-resume on fresh blocks', () => {
  const b = newBook();
  assert.equal(plan(b, 0, T0, { gas: true, fresh: false }).length, 0);
  assert.match(waitReason(b, 0, T0, { gas: true, fresh: false }), /stale/);
  assert.equal(b.halted, '');                                         // nothing latched
  assert.equal(waitReason(b, 0, T0, { gas: true, fresh: true }), ''); // fresh block -> trade
  assert.equal(plan(b, 0, T0, { gas: true, fresh: true }).filter(a => a.do === 'place').length, 2);
  assert.ok(!('stalePauseS' in STRATEGY));
  const src = readFileSync(new URL('./maker-keeper-v4.mts', import.meta.url), 'utf8');
  assert.ok(!/['"]keeperPause['"]/.test(src) && !/function keeperPause/.test(src), 'keeper must never encode keeperPause');
});

test('daily loss: no new orders, fills still exit, auto-resets at next UTC day', () => {
  const b: any = { ...newBook(), day: '' }; rollDay(b, T0); b.dayGas = 26;
  assert.match(waitReason(b, 0, T0, { gas: true, fresh: true }), /daily loss.*resumes 2026-10-30T00:00:00/);
  assert.equal(plan(b, 0, T0, { gas: true, fresh: true }).length, 0);
  applyPlace(b, { do: 'place', kind: 'fresh', side: 'ask', lower: 1, amt: 100 }, '7', 100, T0, 0);
  const ob = observe(b, 3); const acts = plan(b, 3, T0, { gas: true, fresh: true }); // ask filled at tick 3: held in place as its own exit (no tx)
  assert.equal(ob.crossed.length, 1); assert.equal(acts.length, 0); assert.equal(b.orders[0].crossed, true);
  b.halted = 'daily loss -26 MON';                                         // even an old persisted latch clears
  assert.equal(rollDay(b, T0 + 3600_000), false);
  assert.equal(rollDay(b, Date.parse('2026-10-30T00:00:01Z')), true);
  assert.equal(b.dayGas, 0); assert.equal(b.halted, ''); assert.equal(waitReason(b, 0, T0, { gas: true, fresh: true }), '');
});

test('restart: persisted halt cleared, book reconciled with vault openIds', () => {
  const b = newBook(); b.halted = 'stale data 75s';
  for (const id of ['10', '11', '12']) applyPlace(b, { do: 'place', kind: 'fresh', side: 'ask', lower: 1, amt: 1 }, id, 1, T0, 0);
  b.sidePaused.ask = true;
  assert.equal(clearHaltOnStart(b), 'stale data 75s'); assert.equal(b.halted, '');
  const r = reconcile(b, ['11', '12', '99']);
  assert.deepEqual(r.dropped.map(o => o.id), ['10']); assert.deepEqual(r.orphans, ['99']);
  assert.deepEqual(b.orders.map(o => o.id), ['11', '12']); assert.equal(b.sidePaused.ask, false);
});

test('WS drop -> HTTP polling keeps blocks flowing, WS reconnects with backoff', async () => {
  let h = 100n, wsCb: ((n: bigint) => void) | null = null, wsErr: ((e: unknown) => void) | null = null, opens = 0, polls = 0;
  const seen: string[] = [];
  const f = new BlockFeed({
    openWs: (onB, onE) => { opens++; wsCb = onB; wsErr = onE; return () => { wsCb = null; }; },
    pollHttp: async () => { polls++; return ++h; }, onBlock: (_n, via) => seen.push(via), pollMs: 20, wsQuietMs: 10_000, backoffMs: [30, 60],
  });
  f.start(); await sleep(5); wsCb!(++h); assert.equal(f.feed, 'wss');
  const before = polls; await sleep(60); assert.ok(polls - before <= 1, 'no busy polling while WS delivers');
  wsCb!(++h);
  wsErr!(new Error('socket closed wss://secret.example/abc')); assert.equal(f.wsUp, false); assert.equal(f.feed, 'http');
  const p0 = polls; await sleep(25); assert.ok(polls > p0, 'HTTP polling starts immediately');
  assert.ok(seen.includes('http'));
  await sleep(60); assert.equal(opens, 2, 'WS reconnected after backoff');
  wsCb!(++h); assert.equal(f.feed, 'wss'); assert.equal(f.wsReconnects, 1);
  f.stop();
});

test('WS silently quiet -> treated as down and HTTP takes over', async () => {
  let h = 1n; const f = new BlockFeed({ openWs: () => () => {}, pollHttp: async () => ++h, onBlock: () => {}, pollMs: 10, wsQuietMs: 30, backoffMs: [1000] });
  f.start(); await sleep(80); assert.equal(f.wsUp, false); assert.equal(f.feed, 'http'); assert.ok(h > 3n); f.stop();
});
