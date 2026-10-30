// monaf v4 maker strategy (Uniswap v4 MON/WETH 0.05% tickSpacing 1). Pure logic shared by the keeper and the replay. No signing, no I/O.
// Strategy constants: see engine/MAKER-V4-RUNBOOK.md. Only the recentre tunables and the gas tip are env-overridable (keeper).
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
  sizeMonEq: 500,           // Phase 1: per order cap, MON-equivalent
  sizeMinMonEq: 300,        // Phase 1: per order floor (orders below are skipped unless inventory forces a smaller one, >= minOrderMonEq)
  sizeBaseMonEq: 400,       // Phase 1 skew: ask = S x (0.5 + m), bid = S x (1.5 - m), m = MON share of value; clipped to [sizeMinMonEq, sizeMonEq]
  offsetTicks: 30,          // Phase 1 target: range starts 30 ticks beyond spot (clamped to what the vault allows, see clampGeometry)
  widthTicks: 5,            // Phase 1 target: 5-tick range (V5 vault mints fixed 1-tick ranges -> clamped to 1 there)
  vaultMarginTicks: 2,      // keep the order this many ticks inside the vault's maxDistanceTicks so a small move before mining cannot TooFar-revert
  stopTicks: 25,            // D1: a FILLED order held as its exit more than 25 ticks from spot is stopped out (closed) and its funds re-quoted at spot
  placeMaxMoveTicks: 7,     // D4: no new order if the pool moved > 7 ticks over the last ~10 s (TooFar = > 10 ticks at mining reverts and still bills gas)
  maxOpen: 4,               // vault limit: fresh orders + legacy exits
  maxFresh: 2,              // strictly one unfilled order per side (extras are closed in one batch)
  maxDistanceTicks: 10,     // vault limit (keeper always uses adjacent ticks)
  flipHoldMs: 5 * 60_000,   // an order that crossed/returned within this window is 'unsettled': no extra-close, no replacement (churn guard)
  recentreMs: 30 * 60_000,  // D5: an UNFILLED order is re-centred only when >= 30 min old (was 15) ...
  recentreTicks: 8,         // ... AND more than 8 ticks (was 3) from the adjacent tick. Filled orders (= their own exit) are never moved.
  gasCapGwei: 150,          // no new orders / re-centres above this
  staleNoNewS: 10,          // no new orders if last block older than this
  staleWarnS: 60,           // status warning only: the keeper NEVER pauses the vault on chain; stale data only means "wait", auto-resume on fresh blocks
  dailyLossFrac: 0.04,      // D3: realised P&L today (stops included) - gas today < -(4% x 2 x sizeMonEq) = -40 MON at 500: no NEW orders until the next UTC day (auto-resumes)
  busyKillS: 120,           // one block's work stuck longer than this -> process exits, supervisor restarts it (never a silent stall)
  askInvFrac: 0.45,         // ask <= 45% of vault MON
  bidInvFrac: 0.9,          // bid <= 90% of vault WETH
  minOrderMonEq: 5,         // hard floor
  minProfitMult: 3,         // D5: skip an order whose 2-leg fee (0.05% x 2) < 3x its round-trip gas (was 1.5)
  gasMult: 1.03,            // gas limit = estimate x 1.03 (Monad bills the LIMIT, not gas used)
  gasFallback: { ask: 360_000, bid: 500_000, close: 300_000 }, // from real receipts (ask 345.6k, first bid 488k, close 290k; Monad bills the limit)
  gasSanityMult: 1.5,       // never sign if estimate x 1.03 > 1.5 x the summed real-usage limits for the tx (something is off: skip, no tx)
  tipGwei: 0.5,             // priority tip (keeper clamps to [MAKER_MIN_TIP_GWEI, 1])
  capMode: 'pause' as const // both sides filled: hold, never market-recycle
};
export type Geometry = { offset: number; width: number; spacing: number };
/** Clamp the configured geometry to the vault: V5 mints fixed 1-tick ranges (width 1) and reverts TooFar beyond maxDistanceTicks
 *  (ask: tickLower - tick; bid: tick - tickUpper). Offset is kept vaultMarginTicks inside so a small move before mining cannot revert. */
export function clampGeometry(want: { offset: number; width: number }, vault: { fixedWidth?: number; maxDistance?: number; spacing?: number }): Geometry & { clamped: boolean } {
  const spacing = vault.spacing ?? 1, width = vault.fixedWidth ?? Math.max(spacing, Math.round(want.width / spacing) * spacing);
  let offset = Math.max(0, Math.round(want.offset));
  // rangeFor rounds away from spot to the spacing: an ask's tickLower can land up to `spacing` ticks past tick+offset (V5: spacing 1 = unchanged)
  if (vault.maxDistance !== undefined) offset = Math.min(offset, Math.max(0, vault.maxDistance - spacing - STRATEGY.vaultMarginTicks));
  return { offset, width, spacing, clamped: offset !== Math.round(want.offset) || width !== Math.round(want.width) };
}
export type Side = 'ask' | 'bid'; // ask: sells MON in [t+1,t+2) above spot (MON only). bid: sells WETH in [t-1,t) below spot (WETH only).
/** amt/startAmt = amount actually MINTED (not amountMax). crossed = fully converted right now; rounds = completed full round trips.
 *  spare = idle remainder left in the vault by the old 0.1% haircut (legacy exits only, in the exit's asset). v = book schema. */
export type Ord = { id: string; kind: 'fresh' | 'exit'; side: Side; lower: number; amt: number; placedAt: number; startMonEq: number; startAsset: 'MON' | 'WETH'; startAmt: number;
  crossed?: boolean; rounds?: number; spare?: number; v?: number; m0?: number; m0Day?: string; w?: number /* range width in ticks (default 1) */; flipAt?: number /* ms of last cross/return */ };
export const wOf = (o: { w?: number }) => o.w ?? 1;
export const px = (tick: number) => Math.pow(1.0001, tick);            // WETH per MON at tick
export const monEq = (asset: 'MON' | 'WETH', x: number, tick: number) => asset === 'MON' ? x : x / px(tick);
export const assetOf = (side: Side): 'MON' | 'WETH' => side === 'ask' ? 'MON' : 'WETH';
export const mid = (lower: number, w = 1) => Math.sqrt(px(lower) * px(lower + w));
const ceilTo = (t: number, s: number) => Math.ceil(t / s) * s, floorTo = (t: number, s: number) => Math.floor(t / s) * s;
/** tickLower of a new order: ask starts `offset` ticks above the next tick (tick+1+offset), bid ends `offset` ticks below spot
 *  (upper = tick-offset); both aligned to the pool spacing, away from spot. offset 0 / width 1 = the old adjacent single tick. */
export const rangeFor = (side: Side, tick: number, g: Partial<Geometry> = {}) => { const o = g.offset ?? 0, w = g.width ?? 1, s = g.spacing ?? 1;
  return side === 'ask' ? ceilTo(tick + 1 + o, s) : floorTo(tick - o, s) - w; };
/** STRICT fill rule: the price has fully crossed the range (position fully converted). Inside the range = partial. */
export const filled = (o: { side: Side; lower: number; w?: number }, tick: number) => o.side === 'ask' ? tick >= o.lower + wOf(o) : tick < o.lower;
/** Fully back on the original side (position fully un-converted). */
export const unfilled = (o: { side: Side; lower: number; w?: number }, tick: number) => o.side === 'ask' ? tick < o.lower : tick >= o.lower + wOf(o);
/** Which way the order trades right now: an unfilled ask sells MON (ask); a filled ask holds WETH and buys MON back (bid), etc. */
/** Ticks from spot within which an order counts as in play (see plan). */
export const IN_PLAY = 2;
export const effSide = (o: Ord): Side => o.kind === 'fresh' && o.crossed ? (o.side === 'ask' ? 'bid' : 'ask') : o.side;
/** Ticks between spot and the near edge of the range (0 = in range). */
export const distTo = (o: { lower: number; w?: number }, tick: number) => tick < o.lower ? o.lower - tick : tick >= o.lower + wOf(o) ? tick - (o.lower + wOf(o)) + 1 : 0;
/** Where the exit of a fill must sit: a bid exit (after an ask fill) at or BELOW the ask's range, an ask exit at or ABOVE the bid's range,
 *  never on the losing side of the fill price. The keeper achieves this by leaving the filled range in place (exit lower == fill lower). */
export const exitLower = (exitSide: Side, fillLower: number, tick: number) => exitSide === 'bid' ? Math.min(fillLower, tick - 1) : Math.max(fillLower, tick + 1);
/** Proceeds of a fully crossed order (model): converted at the range mid price, plus 0.05% fee on the notional. */
export function proceeds(o: { side: Side; lower: number; amt: number; w?: number }) { const m = mid(o.lower, wOf(o)); return o.side === 'ask' ? o.amt * m * (1 + V4.fee) : o.amt / m * (1 + V4.fee); }
const HAIRCUT = 1e-6; // rounding headroom only (was 0.999: 0.1% of every order sat idle in the vault and the book counted it as a loss)
/** v4 liquidity for a `w`-tick single-sided order spending at most `amtWei`. */
export function liquidityFor(side: Side, lower: number, amtWei: bigint, w = 1): bigint {
  const Q = 2 ** 96, a = Math.sqrt(px(lower)) * Q, b = Math.sqrt(px(lower + w)) * Q, x = Number(amtWei) * (1 - HAIRCUT);
  return BigInt(Math.floor(side === 'ask' ? x * a / Q * b / (b - a) : x * Q / (b - a)));
}
/** Amount (token units, 18 dp) a 1-tick single-sided position of `liq` holds: what was actually minted. Inverse of liquidityFor. */
export function amountFor(side: Side, lower: number, liq: bigint | number, w = 1): number {
  const Q = 2 ** 96, a = Math.sqrt(px(lower)) * Q, b = Math.sqrt(px(lower + w)) * Q, L = Number(liq);
  return (side === 'ask' ? L * (b - a) / (a / Q * b) : L * (b - a) / Q) / 1e18;
}
/** Book written by the pre-fix keeper (no v): amounts were amountMax; minted was 0.999x, the 0.1% stayed in the vault. Idempotent. */
export function migrateOrder(o: Ord): Ord {
  if (o.v === 2) return o;
  if (o.kind === 'exit') { o.spare = o.amt * 0.001; o.amt *= 0.999; o.startAmt *= 0.999; o.startMonEq *= 0.999; }
  else { o.amt *= 0.999; o.startAmt = o.amt; o.startMonEq *= 0.999; }
  o.v = 2; return o;
}
export type Book = { orders: Ord[]; sidePaused: Record<Side, boolean>; trips: { t: number; pnlMon: number; rounds?: number; id?: string }[]; dayPnl: number; dayGas: number; halted: string };
export const newBook = (): Book => ({ orders: [], sidePaused: { ask: false, bid: false }, trips: [], dayPnl: 0, dayGas: 0, halted: '' });
/** Mark-to-market of one order vs holding what it started with (MON-eq; fees not included = conservative). Unfilled fresh = 0. */
export function orderMtm(o: Ord, tick: number) {
  if (o.kind === 'exit') return monEq(assetOf(o.side), o.amt + (o.spare ?? 0), tick) - monEq(o.startAsset, o.startAmt, tick);
  if (!o.crossed) return 0;
  return monEq(assetOf(o.side === 'ask' ? 'bid' : 'ask'), proceeds(o), tick) - monEq(o.startAsset, o.startAmt, tick);
}
export const mtm = (b: Book, tick: number) => b.orders.reduce((a, o) => a + orderMtm(o, tick), 0);
export type Why = 'fill' | 'recentre' | 'stop' | 'extra';
export type Action = { do: 'close'; o: Ord; why: Why } | { do: 'place'; kind: Ord['kind']; side: Side; lower: number; amt: number; w?: number; start?: Ord } | { do: 'halt'; why: string };
/** Never sign a tx whose limit is far above what such a tx really used (estimate glitch or unexpected path); returns false = skip, no tx. */
export type GasFb = Record<Side | 'close', number>;
export const gasSane = (limit: bigint, kinds: (Side | 'close')[], fb: GasFb = STRATEGY.gasFallback) => Number(limit) <= STRATEGY.gasSanityMult * kinds.reduce((a, k) => a + fb[k], 0);
/** Gas limit: estimate x gasMult (rounded up); null estimate (estimateGas failed, eth_call ok) -> fixed per-type fallback. */
export const gasLimit = (est: bigint | null, kind: Side | 'close', fb: GasFb = STRATEGY.gasFallback) => est === null ? BigInt(fb[kind]) : (est * BigInt(Math.round(STRATEGY.gasMult * 1000)) + 999n) / 1000n;
/** Priority tip in gwei: configured value clamped to <= 1 gwei and >= the network minimum (>= 0). */
export const tipGwei = (cfg?: number, netMin = 0) => Math.max(Math.min(Number.isFinite(cfg as number) ? cfg as number : STRATEGY.tipGwei, 1), Math.max(0, netMin));
/** Round-trip gas of one order in MON (place + the close that eventually realises it) at `gwei`, using the fallback limits as the bound. */
export const tripGasMon = (side: Side, gwei: number) => (STRATEGY.gasFallback[side] + STRATEGY.gasFallback.close) * gwei * 1e-9;
/** Min-profit gate: a round trip earns the 0.05% fee on both legs; require that to be >= minProfitMult x the round-trip gas. */
export const worthIt = (side: Side, amtMonEq: number, gwei: number) => amtMonEq * V4.fee * 2 >= STRATEGY.minProfitMult * tripGasMon(side, gwei);
/** Size an order to what the vault holds: ask <= 45% of vault MON, bid <= 90% of vault WETH, <= 1,000 MON-eq; 0 = skip the side. */
/** D2 skew: MON-eq target in [sizeMinMonEq, sizeMonEq]. monShare = MON / (MON + WETH) of the vault in MON-eq (incl. held orders' assets if given).
 *  Long MON (share > 0.5) -> bigger ask, smaller bid; long WETH -> the reverse; balanced -> 400 each. */
export function skewTarget(side: Side, monShare?: number) { const m = Math.max(0, Math.min(1, monShare ?? 0.5)), S = STRATEGY.sizeBaseMonEq;
  const t = side === 'ask' ? S * (0.5 + m) : S * (1.5 - m); return Math.max(STRATEGY.sizeMinMonEq, Math.min(STRATEGY.sizeMonEq, t)); }
export function freshSize(side: Side, tick: number, inv?: { mon: number; weth: number }, gasGwei?: number, monShare?: number): number {
  const tgt = skewTarget(side, monShare ?? (inv ? inv.mon / Math.max(1e-18, inv.mon + monEq('WETH', inv.weth, tick)) : undefined));
  const cap = side === 'ask' ? tgt : tgt * 0.995 * px(tick); /* 0.5% under the on-chain MON-eq cap so a price drop before mining can't trip TooBig */
  const amt = inv ? Math.min(cap, side === 'ask' ? inv.mon * STRATEGY.askInvFrac : inv.weth * STRATEGY.bidInvFrac) : cap;
  const me = monEq(assetOf(side), amt, tick);
  if (me < STRATEGY.minOrderMonEq) return 0;
  if (gasGwei !== undefined && !worthIt(side, me, gasGwei)) return 0;
  return amt;
}
/** UTC day key; the daily-loss guard is scoped to it and resets automatically when it changes. */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const nextUtcDay = (now: number) => new Date(Math.floor(now / 86_400_000 + 1) * 86_400_000).toISOString();
/** Roll the per-day counters at a UTC day change (clears a daily-loss wait). Returns true if it rolled. */
export function rollDay(b: Book & { day?: string }, now: number): boolean { const d = utcDay(now); if (b.day === d) return false; b.day = d; b.dayPnl = 0; b.dayGas = 0; if (b.halted?.startsWith('daily loss')) b.halted = ''; return true; }
/** D3: daily loss = REALISED P&L today - gas today (no open MTM). Open risk is bounded by the D1 stop instead. Each open order carries its MTM at the
 *  start of the day (m0, taken lazily, 0 for orders placed today), and a close books only (pnl - m0): a loss already carried into the day is not
 *  counted again, so the guard always resumes at the next UTC day and never latches. Limit scales with order size. */
export const dailyLossLimit = () => STRATEGY.dailyLossFrac * 2 * STRATEGY.sizeMonEq;
export function markDay(b: Book, tick: number) { const d = (b as any).day ?? ''; for (const o of b.orders) if (o.m0Day !== d) { o.m0 = orderMtm(o, tick); o.m0Day = d; } }
export const dayLoss = (b: Book, tick: number) => { markDay(b, tick); return b.dayPnl - b.dayGas; };
/** Why no NEW orders right now ('' = trade). Never latches: stale clears on the next fresh block, loss at the next UTC day, gas when it drops. */
export function waitReason(b: Book, tick: number, now: number, ok: { gas: boolean; fresh: boolean }): string {
  if (!ok.fresh) return 'stale data (waiting for fresh blocks)';
  if (dayLoss(b, tick) < -dailyLossLimit()) return `daily loss ${dayLoss(b, tick).toFixed(2)} MON (resumes ${nextUtcDay(now)})`;
  if (!ok.gas) return `gas > ${STRATEGY.gasCapGwei} gwei`;
  return '';
}
/** Startup: no halt survives a restart (only the supervisor's STOP file stops the bot). */
export function clearHaltOnStart(b: Book): string { const was = b.halted || ''; b.halted = ''; return was; }
/** Reconcile the book with the vault's on-chain openIds: drop orders no longer open on chain, return on-chain ids the book does not know. */
export function reconcile(b: Book, onchain: string[]): { dropped: Ord[]; orphans: string[] } {
  const on = new Set(onchain), known = new Set(b.orders.map(o => o.id));
  const dropped = b.orders.filter(o => !on.has(o.id)); b.orders = b.orders.filter(o => on.has(o.id));
  sideFull(b);
  return { dropped, orphans: onchain.filter(id => !known.has(id)) };
}
/** pause-when-full: a side is "full" while its order is filled and held as its exit; it resumes automatically when the price returns. */
function sideFull(b: Book) { for (const s of ['ask', 'bid'] as Side[]) b.sidePaused[s] = b.orders.some(o => o.kind === 'fresh' && o.side === s && !!o.crossed); }
/** Per block, before plan(): track full crosses and full returns of live orders (no tx; the range itself is the exit). */
export function observe(b: Book, tick: number, now = Date.now()): { crossed: Ord[]; returned: Ord[] } {
  const crossed: Ord[] = [], returned: Ord[] = [];
  for (const o of b.orders) if (o.kind === 'fresh') {
    if (!o.crossed && filled(o, tick)) { o.crossed = true; o.flipAt = now; crossed.push(o); }
    else if (o.crossed && unfilled(o, tick)) { o.crossed = false; o.rounds = (o.rounds ?? 0) + 1; o.flipAt = now; returned.push(o); }
  }
  sideFull(b); return { crossed, returned };
}
export type Tunables = { recentreMs?: number; recentreTicks?: number; deployIdle?: boolean; stopTicks?: number; geo?: Geometry };
/**
 * Decide the next actions for one block (call observe() first). Caller executes them in order (live: vault txs, dry/replay: model) and calls apply*().
 * A filled order is NOT closed: the 1-tick range stays where it is and is now the exit, buying/selling back at exactly the fill price
 * (old keeper: close + re-place the exit at tick+-1 = up to 5 ticks on the losing side, plus ~0.4 MON of gas per trip).
 * Legacy exits (from the old keeper) are closed once fully filled. Unfilled orders re-centre only if > recentreTicks out AND >= recentreMs old.
 * Strictly one resting order per direction (a filled order counts for the direction it now trades), total open <= vault maxOpen.
 */
export function plan(b: Book, tick: number, now: number, ok: { gas: boolean; fresh: boolean; gasGwei?: number; calm?: boolean }, inv?: { mon: number; weth: number }, tun: Tunables = {}): Action[] {
  const rMs = tun.recentreMs ?? STRATEGY.recentreMs, rT = tun.recentreTicks ?? STRATEGY.recentreTicks, sT = tun.stopTicks ?? STRATEGY.stopTicks;
  const geo: Geometry = tun.geo ?? { offset: 0, width: 1, spacing: 1 };
  const lossWait = dayLoss(b, tick) < -dailyLossLimit();
  const acts: Action[] = [], closing = new Set<string>();
  for (const o of b.orders) if (o.kind === 'exit' && filled(o, tick)) { acts.push({ do: 'close', o, why: 'fill' }); closing.add(o.id); }
  // D1 stop-out: a FILLED order (fresh held as its own exit, or a legacy exit still unfilled) further than stopTicks from spot is closed; its
  // funds come back to the vault and are re-quoted at spot in the same batched tx. Risk-reducing, so it runs even in a loss wait (never stalls).
  if (ok.fresh && ok.gas !== false) for (const o of b.orders) if (!closing.has(o.id) && ((o.kind === 'fresh' && o.crossed) || (o.kind === 'exit' && !filled(o, tick))) && Math.abs(o.lower - tick) > sT) { acts.push({ do: 'close', o, why: 'stop' }); closing.add(o.id); }
  if (lossWait) ok = { ...ok, gas: false };
  if (!ok.gas || !ok.fresh) return acts;
  for (const o of b.orders) if (o.kind === 'fresh' && !o.crossed && unfilled(o, tick) && now - o.placedAt >= rMs && Math.abs(o.lower - rangeFor(o.side, tick, geo)) > rT) { acts.push({ do: 'close', o, why: 'recentre' }); closing.add(o.id); }
  // Deploy idle funds (every block: inv = this block's vault balances, so new deposits are picked up on the next block).
  //  - top-up: an UNFILLED order whose fresh size (from today's idle + its own funds) is >= 1.5x and >= +100 MON-eq bigger is
  //    closed and re-placed bigger in the SAME batched tx (no move otherwise: gas-saving).
  // STRICTLY one resting order per trading direction (effSide): a filled ask now buys MON back, so it IS the bid. Keep the order
  // nearest to spot per direction, close the rest in this block's batch
  // (one execute tx together with any re-place; only on a fresh block with acceptable gas, like recentres).
  // Hysteresis: an order within IN_PLAY ticks of spot is being traded right now and its direction flips with every tick (crossed <->
  // returned). It is never closed as an extra and covers BOTH directions for placement, so a 1-tick price wobble cannot cause a
  // close/place cycle (seen live 22:36-22:49 UTC: ~15 txs in 13 min). Once price leaves it, it gets a direction and duplicates resolve once.
  // Time hysteresis too: price wobbles of 10-20 ticks/min cross 1-tick ranges back and forth (live 22:48 & 22:56 UTC), so an order that
  // crossed or returned < flipHoldMs ago is also unsettled.
  const inPlay = (o: Ord) => distTo(o, tick) <= IN_PLAY || (o.flipAt !== undefined && now - o.flipAt < STRATEGY.flipHoldMs);
  for (const s of ['ask', 'bid'] as Side[]) { const g = b.orders.filter(o => !closing.has(o.id) && !inPlay(o) && effSide(o) === s).sort((x, y) => distTo(x, tick) - distTo(y, tick));
    for (const o of g.slice(1)) { acts.push({ do: 'close', o, why: 'extra' }); closing.add(o.id); } }
  const idle = tun.deployIdle ?? true;
  if (idle && inv) for (const o of b.orders) if (o.kind === 'fresh' && !o.crossed && !closing.has(o.id) && unfilled(o, tick)) {
    const want = freshSize(o.side, tick, { mon: inv.mon + (o.side === 'ask' ? o.amt : 0), weth: inv.weth + (o.side === 'bid' ? o.amt : 0) }, ok.gasGwei);
    if (ok.calm === false) continue;
    if (want >= o.amt * 1.5 && monEq(assetOf(o.side), want - o.amt, tick) >= 100) { acts.push({ do: 'close', o, why: 'recentre' }); closing.add(o.id); }
  }
  const live = b.orders.filter(o => !closing.has(o.id)); let open = live.length;
  const pending = { mon: 0, weth: 0 }; for (const a of acts) if (a.do === 'close') { const conv = a.o.kind === 'exit' ? a.why === 'fill' : !!a.o.crossed, v = conv ? proceeds(a.o) : a.o.amt;
    if ((a.o.side === 'ask') === conv) pending.weth += v; else pending.mon += v; } // funds the closes return this tx (model, conservative enough: ranges are 1 tick)
  if (ok.calm === false) return acts; // D4: market moving > placeMaxMoveTicks: closes only, no new orders this block (auto-resumes when calm)
  for (const side of ['ask', 'bid'] as Side[]) {
    if (live.some(o => effSide(o) === side || inPlay(o)) || open >= STRATEGY.maxOpen) continue; // one resting order per direction, ever
    const amt = freshSize(side, tick, inv && { mon: inv.mon + pending.mon, weth: inv.weth + pending.weth }, ok.gasGwei); if (!(amt > 0)) continue;
    acts.push({ do: 'place', kind: 'fresh', side, lower: rangeFor(side, tick, geo), amt, w: geo.width }); open++;
  }
  return acts;
}
/** Book update after a close. ret = what the vault got back: {mon, weth} from the Closed event, or a number in the asset the order holds now. */
export function applyClose(b: Book, o: Ord, why: Why, tick: number, ret: number | { mon: number; weth: number }, now: number) {
  b.orders = b.orders.filter(x => x.id !== o.id);
  let r = ret as { mon: number; weth: number };
  if (typeof ret === 'number') { const conv = o.kind === 'exit' ? why === 'fill' : !!o.crossed; const a = assetOf(conv ? (o.side === 'ask' ? 'bid' : 'ask') : o.side); r = a === 'MON' ? { mon: ret, weth: 0 } : { mon: 0, weth: ret }; }
  const back = r.mon + monEq('WETH', r.weth, tick) + (o.spare ? monEq(assetOf(o.side), o.spare, tick) : 0);
  const pnl = (o.kind === 'exit' && why === 'fill') || why === 'stop' || (why === 'extra' && !!o.crossed) || (o.rounds ?? 0) > 0 ? back - monEq(o.startAsset, o.startAmt, tick) : null;
  if (pnl !== null) { b.dayPnl += pnl - (o.m0Day === (b as any).day ? (o.m0 ?? 0) : 0); b.trips.push({ t: now, pnlMon: pnl, rounds: o.kind === 'exit' ? 1 : (o.rounds ?? 0), id: o.id }); }
  sideFull(b);
}
/** Book update after a place; amt = the MINTED amount (from the Placed event's liquidity), not amountMax. */
export function applyPlace(b: Book, a: Extract<Action, { do: 'place' }>, id: string, amt: number, now: number, tick: number) {
  const startAsset = assetOf(a.side);
  b.orders.push({ id, kind: a.kind, side: a.side, lower: a.lower, amt, placedAt: now, startMonEq: monEq(startAsset, amt, tick), startAsset, startAmt: amt, rounds: 0, v: 2, m0: 0, m0Day: (b as any).day ?? '', w: a.w ?? 1 });
}
