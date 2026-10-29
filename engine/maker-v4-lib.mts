// monaf v4 maker strategy (Uniswap v4 MON/WETH 0.05% tickSpacing 1). Pure logic shared by the keeper and the replay. No signing, no I/O.
// HARD-CODED strategy (not env-tunable on purpose): see engine/MAKER-V4-RUNBOOK.md.
export const V4 = {
  chainId: 143,
  poolManager: '0x188d586ddcf52439676ca21a244753fa19f9ea8e',
  positionManager: '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016',
  stateView: '0x77395f3b2e73ae90843717371294fa97cc419d64',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  weth: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242',
  poolId: '0x3783b51e33900eb366a9e8473c76cda441e7170d2e5d96927f30c16a7add93aa', // keccak(abi.encode(0x0, WETH, 500, 1, 0x0))
  fee: 0.0005, spacing: 1,
} as const;
export const STRATEGY = {
  sizeMonEq: 1000,          // per side cap, MON-equivalent (actual size = min(cap, vault inventory share))
  maxOpen: 4,               // live fresh + stuck exits (vault also enforces 4)
  maxDistanceTicks: 10,     // vault limit (keeper always uses adjacent ticks)
  recentreMs: 5 * 60_000,   // unfilled fresh order re-centred after 5 min; exits never moved
  gasCapGwei: 150,          // no new orders / re-centres above this
  staleNoNewS: 10,          // no new orders if last block older than this
  staleWarnS: 60,           // status warning only: the keeper NEVER pauses the vault on chain; stale data only means "wait", auto-resume on fresh blocks
  dailyLossMon: 25,         // realised + open-exit MTM - gas: no NEW orders until the next UTC day (time-boxed, auto-resumes; fills still get their exits)
  busyKillS: 120,           // one block's work stuck longer than this -> process exits, supervisor restarts it (never a silent stall)
  askInvFrac: 0.45,         // fresh ask <= 45% of vault MON
  bidInvFrac: 0.9,          // fresh bid <= 90% of vault WETH
  minOrderMonEq: 5,         // skip a side below this (gas would eat the fees)
  capMode: 'pause' as const // cap hit: pause the filled side, hold the asset, never market-recycle
};
export type Side = 'ask' | 'bid'; // ask: sells MON in [t+1,t+2) above spot (MON only). bid: sells WETH in [t-1,t) below spot (WETH only).
export type Ord = { id: string; kind: 'fresh' | 'exit'; side: Side; lower: number; amt: number; placedAt: number; startMonEq: number; startAsset: 'MON' | 'WETH'; startAmt: number };
export const px = (tick: number) => Math.pow(1.0001, tick);            // WETH per MON at tick
export const monEq = (asset: 'MON' | 'WETH', x: number, tick: number) => asset === 'MON' ? x : x / px(tick);
/** Adjacent single-tick range for a new order at the current tick. */
export const rangeFor = (side: Side, tick: number) => side === 'ask' ? tick + 1 : tick - 1;
/** STRICT fill rule: the price has fully crossed the 1-tick range (position fully converted). */
export const filled = (o: { side: Side; lower: number }, tick: number) => o.side === 'ask' ? tick >= o.lower + 1 : tick < o.lower;
/** Proceeds of a fully crossed order (model): converted at the range mid price, plus 0.05% fee on the notional. */
export function proceeds(o: Ord) { const mid = Math.sqrt(px(o.lower) * px(o.lower + 1)); return o.side === 'ask' ? o.amt * mid * (1 + V4.fee) : o.amt / mid * (1 + V4.fee); }
/** v4 liquidity for a 1-tick single-sided order spending at most `amtWei` (0.1% haircut so PositionManager never needs more than amountMax). */
export function liquidityFor(side: Side, lower: number, amtWei: bigint): bigint {
  const Q = 2 ** 96, a = Math.sqrt(px(lower)) * Q, b = Math.sqrt(px(lower + 1)) * Q, x = Number(amtWei) * 0.999;
  return BigInt(Math.floor(side === 'ask' ? x * a / Q * b / (b - a) : x * Q / (b - a)));
}
export type Book = { orders: Ord[]; sidePaused: Record<Side, boolean>; trips: { t: number; pnlMon: number }[]; dayPnl: number; dayGas: number; halted: string };
export const newBook = (): Book => ({ orders: [], sidePaused: { ask: false, bid: false }, trips: [], dayPnl: 0, dayGas: 0, halted: '' });
/** Open-exit mark-to-market vs simply holding the starting asset (MON-eq). */
export const mtm = (b: Book, tick: number) => b.orders.filter(o => o.kind === 'exit').reduce((a, o) => a + monEq(o.side === 'ask' ? 'MON' : 'WETH', o.amt, tick) - monEq(o.startAsset, o.startAmt, tick), 0);
export type Action = { do: 'close'; o: Ord; why: 'fill' | 'recentre' } | { do: 'place'; kind: Ord['kind']; side: Side; lower: number; amt: number; start?: Ord } | { do: 'halt'; why: string };
/**
 * Decide the next actions for one block. Caller executes them in order (live: vault txs, dry/replay: model) and calls apply*().
 * Rules: fills first (fresh fill -> exit on the opposite side with the proceeds, adjacent to spot); cap hit -> pause the side that
 * filled (hold the asset, no recycle); re-centre fresh after 5 min; arm one fresh per unpaused side while open < 4.
 */
/** Size a fresh order to what the vault actually holds: ask uses <= 45% of vault MON (room for an exit), bid <= 90% of vault WETH; 0 = skip side. */
export function freshSize(side: Side, tick: number, inv?: { mon: number; weth: number }): number {
  const cap = side === 'ask' ? STRATEGY.sizeMonEq : STRATEGY.sizeMonEq * 0.995 * px(tick); /* 0.5% under the on-chain MON-eq cap so a price drop before mining can't trip TooBig */
  if (!inv) return cap;
  const amt = Math.min(cap, side === 'ask' ? inv.mon * STRATEGY.askInvFrac : inv.weth * STRATEGY.bidInvFrac);
  return monEq(side === 'ask' ? 'MON' : 'WETH', amt, tick) >= STRATEGY.minOrderMonEq ? amt : 0;
}
/** UTC day key; the daily-loss guard is scoped to it and resets automatically when it changes. */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const nextUtcDay = (now: number) => new Date(Math.floor(now / 86_400_000 + 1) * 86_400_000).toISOString();
/** Roll the per-day counters at a UTC day change (clears a daily-loss wait). Returns true if it rolled. */
export function rollDay(b: Book & { day?: string }, now: number): boolean { const d = utcDay(now); if (b.day === d) return false; b.day = d; b.dayPnl = 0; b.dayGas = 0; if (b.halted?.startsWith('daily loss')) b.halted = ''; return true; }
export const dayLoss = (b: Book, tick: number) => b.dayPnl + mtm(b, tick) - b.dayGas;
/** Why no NEW orders right now ('' = trade). Never latches: stale clears on the next fresh block, loss at the next UTC day, gas when it drops. */
export function waitReason(b: Book, tick: number, now: number, ok: { gas: boolean; fresh: boolean }): string {
  if (!ok.fresh) return 'stale data (waiting for fresh blocks)';
  if (dayLoss(b, tick) < -STRATEGY.dailyLossMon) return `daily loss ${dayLoss(b, tick).toFixed(2)} MON (resumes ${nextUtcDay(now)})`;
  if (!ok.gas) return `gas > ${STRATEGY.gasCapGwei} gwei`;
  return '';
}
/** Startup: no halt survives a restart (only the supervisor's STOP file stops the bot). */
export function clearHaltOnStart(b: Book): string { const was = b.halted || ''; b.halted = ''; return was; }
/** Reconcile the book with the vault's on-chain openIds: drop orders no longer open on chain, return on-chain ids the book does not know. */
export function reconcile(b: Book, onchain: string[]): { dropped: Ord[]; orphans: string[] } {
  const on = new Set(onchain), known = new Set(b.orders.map(o => o.id));
  const dropped = b.orders.filter(o => !on.has(o.id)); b.orders = b.orders.filter(o => on.has(o.id));
  if (b.orders.length <= STRATEGY.maxOpen - 2) b.sidePaused = { ask: false, bid: false };
  return { dropped, orphans: onchain.filter(id => !known.has(id)) };
}
export function plan(b: Book, tick: number, now: number, ok: { gas: boolean; fresh: boolean }, inv?: { mon: number; weth: number }): Action[] {
  // No hard halt here any more: fills are always handled (exit placed), only NEW orders wait (see waitReason).
  if (dayLoss(b, tick) < -STRATEGY.dailyLossMon) ok = { ...ok, gas: false };
  const acts: Action[] = []; let open = b.orders.length;
  for (const o of b.orders) if (filled(o, tick)) {
    acts.push({ do: 'close', o, why: 'fill' });
    if (o.kind === 'fresh') { const s: Side = o.side === 'ask' ? 'bid' : 'ask'; acts.push({ do: 'place', kind: 'exit', side: s, lower: rangeFor(s, tick), amt: NaN, start: o }); }
    else open--;
  }
  if (!ok.gas || !ok.fresh) return acts;
  const closing = new Set(acts.filter(a => a.do === 'close').map(a => (a as any).o.id));
  for (const o of b.orders) if (o.kind === 'fresh' && !closing.has(o.id) && now - o.placedAt > STRATEGY.recentreMs) { acts.push({ do: 'close', o, why: 'recentre' }); closing.add(o.id); open--; }
  for (const side of ['ask', 'bid'] as Side[]) {
    if (b.sidePaused[side]) continue;
    if (b.orders.some(o => o.kind === 'fresh' && o.side === side && !closing.has(o.id))) continue;
    if (open >= STRATEGY.maxOpen) continue;
    const amt = freshSize(side, tick, inv); if (!(amt > 0)) continue; // too little inventory on this side: still place the other
    acts.push({ do: 'place', kind: 'fresh', side, lower: rangeFor(side, tick), amt }); open++;
  }
  return acts;
}
/** Book updates after an action executed. `got` = real (live) or modelled proceeds in the order's opposite asset. */
export function applyClose(b: Book, o: Ord, why: 'fill' | 'recentre', tick: number, got: number, now: number) {
  b.orders = b.orders.filter(x => x.id !== o.id);
  if (why === 'fill' && o.kind === 'exit') { const back = o.side === 'ask' ? 'WETH' : 'MON'; const pnl = monEq(back, got, tick) - monEq(o.startAsset, o.startAmt, tick); b.dayPnl += pnl; b.trips.push({ t: now, pnlMon: pnl }); }
  if (why === 'fill' && o.kind === 'fresh' && b.orders.length >= STRATEGY.maxOpen - 1) b.sidePaused[o.side] = true; // cap hit: pause the filled side
  if (b.orders.length <= STRATEGY.maxOpen - 2) b.sidePaused = { ask: false, bid: false };                            // room for both sides again
}
export function applyPlace(b: Book, a: Extract<Action, { do: 'place' }>, id: string, amt: number, now: number, tick: number) {
  const startAsset = a.start ? (a.start.side === 'ask' ? 'MON' : 'WETH') : (a.side === 'ask' ? 'MON' : 'WETH');
  const startAmt = a.start ? a.start.amt : amt;
  b.orders.push({ id, kind: a.kind, side: a.side, lower: a.lower, amt, placedAt: now, startMonEq: monEq(startAsset, startAmt, tick), startAsset, startAmt });
}
