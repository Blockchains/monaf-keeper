/**
 * monaf maker keeper: ONE process, ONE key, driving MonafMakerVaultV5 (Uniswap v4 MON/WETH 0.05% ts1) and, once deployed,
 * MonafMakerVaultV6 (MON/USDC 0.05% ts10) (ALPHA, unaudited, no guaranteed returns).
 * Strategy in engine/maker-v4-lib.mts (STRATEGY): one order per side sized from vault inventory, a filled order stays in place as its
 * own exit, min-profit gate, gas cap 150 gwei, daily loss guard, strict full-cross fills. Gas: limit = estimate x 1.2 (fixed fallback
 * per type only if estimateGas fails and eth_call succeeds), tip MAKER_TIP_GWEI (default 0.5, clamped to [MAKER_MIN_TIP_GWEI, 1]).
 * V6: auto-discovered (engine/maker-v6-gate.mts): the owner deploys from a wallet; a contract created by the owner whose runtime passes
 * the gate (VERSION 6, owner, keeper == this key, poolId, token1 == USDC) is adopted. Until then V6 is a no-op (rescan every 30 s).
 * MAKER_V6=0 = never touch V6. V6 sends only when vault.active() && !vault.paused(), exactly like V5.
 * NEVER-STALL rules (hard-coded): the keeper never calls keeperPause(); stale data = no new orders until fresh blocks (auto-resume);
 * daily loss = no new orders until the next UTC day (auto-resume); no halt survives a restart (only the supervisor STOP file stops it);
 * WS drop -> immediate HTTP polling + WS reconnect with backoff; wall-clock jump / wake -> resync feed, reload pending nonce, reconcile
 * open positions; a block handler (either vault) stuck > busyKillS exits so the supervisor restarts it.
 * Nonce: every tx of both vaults goes through ONE lane (mutex): sign + broadcast + receipt strictly sequential, pending nonce reloaded each send.
 * env: VAULT (V5), MAKER_KEEPER_KEY (0600 env file; never in a repo/browser/log), QN_HTTP / QN_WSS (never printed), STATUS (heartbeat path)
 *      FORK=1 (anvil fork test: broadcast only to QN_HTTP, never to public RPCs); MAKER_V6_OWNER / MAKER_V6_FROM_NONCE / MAKER_V6_VAULT (tests)
 */
import { RpcPool, defaultPool } from './rpc-pool.mts';
import { createPublicClient, http, custom, webSocket, parseAbi, parseEventLogs, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { BlockFeed } from './maker-v4-feed.mts';
import { V4, STRATEGY, plan, observe, waitReason, rollDay, clearHaltOnStart, reconcile, applyClose, applyPlace, proceeds, liquidityFor, amountFor, migrateOrder, gasLimit, gasSane, clampGeometry, tipGwei, mtm, newBook, type Book, type Ord, type Side, type GasFb } from './maker-v4-lib.mts';
import { startLease, canSend, isLeader, releaseLease, leaseStatus } from './maker-leader.mts';
import { loadV6Cfg, gateState, checkV6, makeDiscovery } from './maker-v6-gate.mts';

const WANT_LIVE = process.env.MONAF_MAKER_LIVE === '1', FORK = process.env.FORK === '1';
const VAULT = (process.env.VAULT ?? '') as Address;
const STATUS = process.env.STATUS ?? 'maker-keeper-v4-status.json', BOOK = STATUS.replace(/\.json$/, '') + '-book.json', BOOK6 = STATUS.replace(/\.json$/, '') + '-v6-book.json';
if (WANT_LIVE && !/^0x[0-9a-fA-F]{40}$/.test(VAULT)) throw new Error('VAULT is required when live');
if (WANT_LIVE && !process.env.MAKER_KEEPER_KEY) throw new Error('MAKER_KEEPER_KEY is required when live (env file, never committed)');
const account = process.env.MAKER_KEEPER_KEY ? privateKeyToAccount(process.env.MAKER_KEEPER_KEY as Hex) : null;
const redact = (e: unknown) => String((e as any)?.shortMessage ?? (e as any)?.message ?? e).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<rpc>').slice(0, 200);
process.on('unhandledRejection', e => console.log(`${new Date().toISOString()} unhandled ${redact(e)}`)); // never print a raw viem error (it carries the RPC host)
const httpUrl = process.env.QN_HTTP || process.env.QUICKNODE_MONAD_RPC_URL || '';
if (!httpUrl && FORK) throw new Error('QN_HTTP (RPC URL) is required in fork mode');
if (!httpUrl) console.log('QN_HTTP not set: public Monad RPCs only (failsafe pool)');
const chain = { id: V4.chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [httpUrl] } } } as const;
// RPC failsafe: QuickNode first, then public Monad RPCs; quota/timeout/stale -> instant failover + 10 min cooldown (engine/rpc-pool.mts)
const pool = FORK ? new RpcPool([['fork', httpUrl]]) : defaultPool(httpUrl, { note: (s: string) => note(s) });
if (!FORK) { void pool.probe(); setInterval(() => { void pool.probe(); }, 15_000).unref(); }
const pub = createPublicClient({ chain, transport: custom({ request: ({ method, params }) => pool.request(method, params) }, { retryCount: 1 }) });
const retry = async <T,>(f: () => Promise<T>, n = 4): Promise<T> => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n) throw new Error(redact(e)); await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const ercAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const svAbi = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']);
const common = ['function close(uint256 tokenId,uint256 deadline) returns (uint256,uint256)', 'function openCount() view returns (uint256)', 'function openIds(uint256) view returns (uint256)',
  'function paused() view returns (bool)', 'function active() view returns (bool)', 'function keeper() view returns (address)', 'function poolId() view returns (bytes32)', 'function VERSION() view returns (uint8)',
  'function maxDistanceTicks() view returns (int24)', 'function snapshot() view returns (bool,bool,int24,uint160,uint256,uint256,uint256[])'] as const;
const abi5 = parseAbi([...common, 'function place(int24 tickLower,uint128 liquidity,uint128 amountMax,uint256 deadline) returns (uint256)',
  'function execute(uint256[] closeIds,(int24 tickLower,uint128 liquidity,uint128 amountMax)[] orders,uint256 deadline) returns (uint256)',
  'event Placed(uint256 indexed tokenId, int24 tickLower, bool sellMon, uint128 liquidity, uint256 amountMax)', 'event Closed(uint256 indexed tokenId, uint256 mon, uint256 weth)']);
/** V6 Order carries tickUpper (ranges wider than one tick, spacing 10). */
export const abi6 = parseAbi([...common, 'function maxWidthTicks() view returns (int24)', 'function place((int24 tickLower,int24 tickUpper,uint128 liquidity,uint128 amountMax) o,uint256 deadline) returns (uint256)',
  'function execute(uint256[] closeIds,(int24 tickLower,int24 tickUpper,uint128 liquidity,uint128 amountMax)[] orders,uint256 deadline) returns (uint256)',
  'event Placed(uint256 indexed tokenId, int24 tickLower, int24 tickUpper, bool sellMon, uint128 liquidity, uint256 amountMax)', 'event Closed(uint256 indexed tokenId, uint256 mon, uint256 amount1)']);
const envNum = (k: string, d: number) => { const r = process.env[k], v = Number(r); return r !== undefined && r !== '' && Number.isFinite(v) ? v : d; };
const TIP_GWEI = tipGwei(envNum('MAKER_TIP_GWEI', STRATEGY.tipGwei), envNum('MAKER_MIN_TIP_GWEI', 0)), TIP = BigInt(Math.round(TIP_GWEI * 1e9));
const log: string[] = []; const note = (s: string) => { log.push(`${new Date().toISOString()} ${s}`); if (log.length > 50) log.shift(); console.log(log.at(-1)); };
let nonce = -1, head = 0n, lastBlockAt = Date.now(), feed = 'http', gasPrice = 0n, dryId = 0, wakes = 0; const startedAt = new Date().toISOString();

/** ONE nonce lane for the single key: a promise-chain mutex around sign + broadcast + receipt (V5 and V6 never interleave). */
let lane: Promise<unknown> = Promise.resolve();
export const inLane = <T,>(f: () => Promise<T>): Promise<T> => { const r = lane.then(f, f); lane = r.catch(() => {}); return r; };

type Profile = { name: 'v5' | 'v6'; vault: Address; abi: any; poolId: string; token1: Address; unit1: string; dec1: number; spacing: number; fixedWidth?: number;
  want: { offset: number; width: number }; tun: { recentreTicks: number; recentreMs: number; stopTicks: number }; calmTicks: number; gasFb: GasFb; book: string; v6: boolean };
type Engine = ReturnType<typeof makeEngine> extends Promise<infer E> ? E : never;

async function makeEngine(p: Profile) {
  const book: Book = existsSync(p.book) ? JSON.parse(readFileSync(p.book, 'utf8')) : { ...newBook(), day: '', gasMon: 0 };
  book.orders.forEach(migrateOrder);
  const st = book as Book & { day: string; gasMon: number };
  const save = () => writeFileSync(p.book, JSON.stringify(book, null, 1));
  const tag = p.name === 'v5' ? '' : `[${p.name}] `, n_ = (s: string) => note(tag + s);
  { const was = clearHaltOnStart(book); if (was) { n_(`startup: cleared persisted halt "${was}" (only STOP stops the bot)`); save(); } }
  const TUN = { ...p.tun, deployIdle: process.env.MAKER_DEPLOY_IDLE !== '0', geo: undefined as undefined | ReturnType<typeof clampGeometry> };
  const E = { name: p.name, vault: p.vault, book, st, TUN, needReconcile: true, waiting: '', busy: false, busySince: 0, tick: 0, live: false, vaultState: { active: false, paused: false },
    txs: { place: 0, close: 0, fail: 0 } as { place: number; close: number; fail: number; batch?: number }, gasLog: [] as { kind: string; limit: number; used: number; mon: number; ok: boolean }[], head: 0n,
    tickHist: [] as [number, number][], batch: false, onBlock: async (_n: bigint, _gapS: number) => {}, save, profile: p };
  const rd = (fn: string, args?: any[]) => pub.readContract({ address: p.vault, abi: p.abi, functionName: fn, args } as any) as Promise<any>;
  const [pid, k] = await retry(() => Promise.all([rd('poolId'), rd('keeper')])); // refuse a vault not wired to the verified pool / this keeper
  if (String(pid).toLowerCase() !== p.poolId.toLowerCase()) throw new Error(`${p.name} vault poolId mismatch`);
  if (account && String(k).toLowerCase() !== account.address.toLowerCase()) throw new Error(`${p.name} vault keeper is not this key`);
  E.batch = p.v6 || await rd('VERSION').then(v => Number(v) === 5).catch(() => false); // V5/V6: snapshot + batched execute; V4: per-op txs
  const readDist = async () => Number(await rd('maxDistanceTicks'));
  const setGeo = (dist?: number) => { const g = clampGeometry(p.want, { fixedWidth: p.fixedWidth, maxDistance: dist, spacing: p.spacing }); const was = JSON.stringify(TUN.geo); TUN.geo = g;
    if (was !== JSON.stringify(g)) n_(`geometry: offset ${g.offset} width ${g.width} spacing ${g.spacing} (wanted ${p.want.offset}/${p.want.width}${g.clamped ? `; CLAMPED by vault maxDistanceTicks ${dist}${p.fixedWidth ? `, fixed ${p.fixedWidth}-tick ranges` : ''}` : ''})`); };
  setGeo(await retry(readDist).catch(() => undefined));
  setInterval(() => { readDist().then(setGeo).catch(() => {}); }, 300_000);
  const show1 = (x: number) => (x * 10 ** (18 - p.dec1)).toPrecision(6); // internal token1 units are raw/1e18
  async function gasFor(data: Hex, kinds: (Side | 'close')[]): Promise<{ gas: bigint; fallback: boolean }> {
    const fb = () => kinds.reduce((a, kk) => a + gasLimit(null, kk, p.gasFb), 0n);
    try { const est = await pub.estimateGas({ account: account!.address, to: p.vault, data }); return { gas: gasLimit(est, kinds[0], p.gasFb), fallback: false }; }
    catch { await pub.call({ account: account!.address, to: p.vault, data }); return { gas: fb(), fallback: true }; }
  }
  async function tickUnchanged(planTick: number): Promise<boolean> {
    const s0 = await pub.readContract({ address: V4.stateView as Address, abi: svAbi, functionName: 'getSlot0', args: [p.poolId] } as any) as readonly [bigint, number, number, number];
    return Number(s0[1]) === planTick;
  }
  const send = (fn: 'place' | 'close' | 'execute', args: readonly unknown[], kind: Side | 'close' | (Side | 'close')[], planTick?: number) => {
    const data = encodeFunctionData({ abi: p.abi, functionName: fn, args: args as any } as any);
    if (!E.live) return Promise.resolve(null);
    return inLane(async () => {
      if (!canSend()) throw new Error('not lease leader: send skipped');
      const kinds = Array.isArray(kind) ? kind : [kind];
      if (planTick !== undefined && !(await tickUnchanged(planTick))) throw new Error(`tick moved since plan (${planTick}): place skipped, no tx sent`);
      let { gas, fallback } = await gasFor(data, kinds);
      if (!gasSane(gas, kinds, p.gasFb)) throw new Error(`gas limit ${gas} > ${STRATEGY.gasSanityMult}x real usage for ${kinds.join('+')}: skipped, no tx sent`);
      for (let attempt = 0; ; attempt++) {
        nonce = await pub.getTransactionCount({ address: account!.address, blockTag: 'pending' }); // reload pending nonce every send (wake / hand-off / 2-vault safe)
        const raw = await account!.signTransaction({ chainId: V4.chainId, type: 'eip1559', to: p.vault, nonce, gas, maxFeePerGas: gasPrice * 12n / 10n + TIP, maxPriorityFeePerGas: TIP, data });
        try {
          const hash = await pool.broadcast(raw) as Hex; nonce++;
          const rc = await pub.waitForTransactionReceipt({ hash, timeout: 20_000 });
          const cost = Number(rc.gasUsed * rc.effectiveGasPrice) / 1e18; st.gasMon += cost; st.dayGas += cost;
          E.gasLog.push({ kind: kinds.join('+'), limit: Number(gas), used: Number(rc.gasUsed), mon: cost, ok: rc.status === 'success' }); if (E.gasLog.length > 20) E.gasLog.shift();
          if (rc.status !== 'success') {
            E.txs.fail++;
            if (fallback && attempt === 0) { gas = gas * 13n / 10n; n_(`${fn} ${kind} reverted at the fallback limit: one retry at ${gas}`); continue; }
            throw new Error(`reverted ${hash}`);
          }
          if (fn === 'execute') E.txs.batch = (E.txs.batch ?? 0) + 1; else E.txs[fn]++;
          return parseEventLogs({ abi: p.abi, logs: rc.logs }) as any[];
        } catch (e) { nonce = -1; throw e; }
      }
    });
  };
  const dl = () => BigInt(Math.floor(Date.now() / 1000) + 120);
  const ord = (a: { lower: number; w?: number; side: Side; amt: number }) => { const wei = BigInt(Math.floor(a.amt * 1e18)), liq = liquidityFor(a.side, a.lower, wei, a.w ?? 1);
    return p.v6 ? { tickLower: a.lower, tickUpper: a.lower + (a.w ?? 1), liquidity: liq, amountMax: wei } : { tickLower: a.lower, liquidity: liq, amountMax: wei }; };
  const ret1 = (c: any) => ({ mon: Number(c.mon) / 1e18, weth: Number(c.weth ?? c.amount1) / 1e18 });
  async function idsV4() { const n = Number(await rd('openCount')); return (await Promise.all(Array.from({ length: n }, (_, i) => rd('openIds', [BigInt(i)])))).map(String); }
  async function reconcileOnChain() {
    const ids = E.batch ? (await rd('snapshot'))[6].map(String) : await idsV4(); const n = ids.length;
    if (E.live) book.orders = book.orders.filter(o => !o.id.startsWith('dry'));
    const r = reconcile(book, ids); save();
    n_(`reconcile: on-chain open ${n} [${ids.join(',')}], book ${book.orders.length}, dropped ${r.dropped.map(o => o.id).join(',') || '-'}, orphans ${r.orphans.join(',') || '-'}`);
    if (E.live && r.orphans.length) { if (E.batch) await send('execute', [r.orphans.map(BigInt), [], dl()], r.orphans.map(() => 'close' as const)); else for (const id of r.orphans) await send('close', [BigInt(id), dl()], 'close'); n_(`closed orphan vault position(s) ${r.orphans.join(',')} (funds back to the vault)`); }
    E.needReconcile = false;
  }
  async function runBatch(acts: ReturnType<typeof plan>) {
    const closes = acts.filter(a => a.do === 'close') as Extract<ReturnType<typeof plan>[number], { do: 'close' }>[];
    const places = (acts.filter(a => a.do === 'place') as Extract<ReturnType<typeof plan>[number], { do: 'place' }>[]).filter(a => a.amt > 0);
    const kinds = [...closes.map(() => 'close' as const), ...places.map(a => a.side)];
    const ev = await send('execute', [closes.map(a => BigInt(a.o.id)), places.map(ord), dl()], kinds, places.length ? E.tick : undefined);
    if (!ev) return;
    for (const a of closes) { const c = (ev.find(e => e.eventName === 'Closed' && String(e.args.tokenId) === a.o.id) as any).args, ret = ret1(c);
      applyClose(book, a.o as Ord, a.why, E.tick, ret, Date.now()); save(); n_(`batch close ${a.why} ${a.o.kind} ${a.o.side} #${a.o.id} -> ${ret.mon.toPrecision(6)} MON + ${show1(ret.weth)} ${p.unit1}`); }
    const placed = ev.filter(e => e.eventName === 'Placed').map(e => e.args);
    places.forEach((a, i) => { const pl = placed[i]; const minted = amountFor(a.side, a.lower, pl.liquidity, a.w ?? 1); applyPlace(book, a, String(pl.tokenId), minted, Date.now(), E.tick); save();
      n_(`batch place ${a.kind} ${a.side} ${a.side === 'ask' ? minted.toPrecision(6) + ' MON' : show1(minted) + ' ' + p.unit1} [${a.lower},${a.lower + (a.w ?? 1)}) #${pl.tokenId}`); });
  }
  E.onBlock = async (n: bigint, gapS: number) => {
    if (E.busy || n <= E.head) return; E.busy = true; E.busySince = Date.now(); E.head = n;
    try {
      if (rollDay(st, Date.now())) { n_(`UTC day ${st.day}: daily counters reset`); save(); }
      let snapBal: [bigint, bigint] | null = null, s0: readonly [bigint, number, ...unknown[]], act: boolean, pau: boolean;
      if (E.batch) { const sn = await rd('snapshot'); [act, pau] = [sn[0], sn[1]]; s0 = [sn[3], sn[2]]; snapBal = [sn[4], sn[5]]; }
      else [s0, act, pau] = await Promise.all([pub.readContract({ address: V4.stateView as Address, abi: svAbi, functionName: 'getSlot0', args: [p.poolId] } as any) as any, rd('active'), rd('paused')]);
      const gp = gasPrice; E.tick = Number(s0[1]); const tick = E.tick;
      E.tickHist.push([Date.now(), tick]); while (E.tickHist.length && Date.now() - E.tickHist[0][0] > 10_000) E.tickHist.shift(); E.vaultState = { active: act, paused: pau };
      if (isLeader()) { const ob = observe(book, tick, Date.now()); for (const o of ob.crossed) n_(`filled ${o.side} [${o.lower},${o.lower + (o.w ?? 1)}) #${o.id}: held in place as its own exit`);
        for (const o of ob.returned) n_(`round trip ${o.rounds} done: ${o.side} [${o.lower},${o.lower + (o.w ?? 1)}) #${o.id} back to its start asset`); if (ob.crossed.length + ob.returned.length) save(); }
      const nowLive = WANT_LIVE && act && !pau;
      if (nowLive !== E.live) { n_(`mode ${nowLive ? 'LIVE' : 'DRY RUN'} (MONAF_MAKER_LIVE=${WANT_LIVE ? 1 : 0} active=${act} paused=${pau})`); E.live = nowLive; }
      if (!isLeader()) { E.waiting = 'standby (lease held elsewhere)'; return; }
      if (WANT_LIVE && !E.live) { E.waiting = 'vault inactive or paused by owner'; return; } // do nothing at all
      if (E.needReconcile) { if (E.live) await reconcileOnChain(); else E.needReconcile = false; }
      const [monW, t1W] = snapBal ?? await Promise.all([pub.getBalance({ address: p.vault }), pub.readContract({ address: p.token1, abi: ercAbi, functionName: 'balanceOf', args: [p.vault] })]);
      const inv = { mon: Number(monW) / 1e18, weth: Number(t1W) / 1e18 };
      const ok = { gas: gp > 0n && gp <= BigInt(STRATEGY.gasCapGwei * 1e9), fresh: gapS <= STRATEGY.staleNoNewS, gasGwei: Number(gp + TIP) / 1e9, calm: Math.max(...E.tickHist.map(h => h[1])) - Math.min(...E.tickHist.map(h => h[1])) <= p.calmTicks };
      const w = waitReason(book, tick, Date.now(), ok); if (w !== E.waiting) { n_(w ? `wait: ${w}` : `resume: trading`); E.waiting = w; }
      const acts = plan(book, tick, Date.now(), ok, inv, TUN);
      if (E.batch && E.live && acts.filter(a => a.do !== 'halt').length > 1) { await runBatch(acts); return; } // one tx for all of this block's work
      for (const a of acts) {
        if (a.do === 'halt') continue; // never emitted; never pauses on chain
        if (a.do === 'close') {
          const o = a.o as Ord; const ev = await send('close', [BigInt(o.id.startsWith('dry') ? 0 : o.id), dl()], 'close');
          let ret: { mon: number; weth: number };
          if (ev) ret = ret1((ev.find(e => e.eventName === 'Closed') as any).args);
          else { const conv = o.kind === 'exit' ? a.why === 'fill' : !!o.crossed; const v = conv ? proceeds(o) : o.amt; ret = ((o.side === 'ask') === conv) ? { mon: 0, weth: v } : { mon: v, weth: 0 }; }
          const n0 = book.trips.length; applyClose(book, o, a.why, tick, ret, Date.now()); save();
          n_(`close ${a.why} ${o.kind} ${o.side} [${o.lower},${o.lower + (o.w ?? 1)}) #${o.id} -> ${ret.mon.toPrecision(6)} MON + ${show1(ret.weth)} ${p.unit1}${book.trips.length > n0 ? ` | trip pnl ${book.trips.at(-1)!.pnlMon.toFixed(4)} MON before gas (${book.trips.at(-1)!.rounds} rounds)` : ''}`);
        } else {
          if (!(a.amt > 0)) continue;
          const o6 = ord(a); const ev = await send('place', p.v6 ? [o6, dl()] : [a.lower, o6.liquidity, o6.amountMax, dl()], a.side, tick);
          const pl = ev ? (ev.find(e => e.eventName === 'Placed') as any).args : null;
          const id = pl ? String(pl.tokenId) : `dry${dryId++}`, minted = amountFor(a.side, a.lower, pl ? pl.liquidity : o6.liquidity, a.w ?? 1);
          applyPlace(book, a, id, minted, Date.now(), tick); save();
          n_(`place ${a.kind} ${a.side} ${a.side === 'ask' ? minted.toPrecision(6) + ' MON' : show1(minted) + ' ' + p.unit1} [${a.lower},${a.lower + (a.w ?? 1)}) #${id}`);
        }
      }
    } catch (e) { n_(`error ${redact(e)}`); } finally { E.busy = false; E.busySince = 0; }
  };
  (E as any).reconcileOnChain = reconcileOnChain;
  return E;
}

const v5 = VAULT ? await makeEngine({ name: 'v5', vault: VAULT, abi: abi5, poolId: V4.poolId, token1: V4.weth as Address, unit1: 'WETH', dec1: 18, spacing: 1, fixedWidth: 1,
  want: { offset: envNum('MAKER_OFFSET_TICKS', STRATEGY.offsetTicks), width: envNum('MAKER_WIDTH_TICKS', STRATEGY.widthTicks) },
  tun: { recentreTicks: envNum('MAKER_RECENTRE_TICKS', STRATEGY.recentreTicks), recentreMs: envNum('MAKER_RECENTRE_MIN', STRATEGY.recentreMs / 60_000) * 60_000, stopTicks: envNum('MAKER_STOP_TICKS', STRATEGY.stopTicks) },
  calmTicks: STRATEGY.placeMaxMoveTicks, gasFb: STRATEGY.gasFallback, book: BOOK, v6: false }) : null;

// ---- V6: no-op until a gated vault exists ----
const c6 = loadV6Cfg(), g6 = gateState(c6);
let v6: Engine | null = null, v6State: string = g6 === 'off' ? 'off' : 'awaiting deploy', v6Vault: string | null = null, v6Bad: string[] = [], v6ScanAt = '', v6Next = 0;
const v6Profile = (vault: Address): Profile => ({ name: 'v6', vault, abi: abi6, poolId: c6.poolId, token1: c6.currency1 as Address, unit1: 'USDC', dec1: c6.decimals1, spacing: c6.spacing,
  want: c6.geometry, tun: { recentreTicks: c6.tunables?.recentreTicks ?? STRATEGY.recentreTicks, recentreMs: STRATEGY.recentreMs, stopTicks: c6.tunables?.stopTicks ?? STRATEGY.stopTicks },
  calmTicks: c6.tunables?.placeMaxMoveTicks ?? STRATEGY.placeMaxMoveTicks, gasFb: c6.gasFallback ?? STRATEGY.gasFallback, book: BOOK6, v6: true });
let adopt6: any = null; // a lease book for V6 that arrived before the engine existed
async function enableV6(addr: string) {
  const g = await checkV6(pub, addr, c6, account?.address); v6Bad = g.bad;
  if (!g.ok) { v6State = 'gate failed'; v6Vault = addr; note(`[v6] gate FAILED for ${addr}: ${g.bad.join(',')} (V6 stays off)`); return; }
  v6 = await makeEngine(v6Profile(addr as Address)); v6Vault = addr; v6State = 'enabled';
  if (adopt6) { leaseHooks.adopt({ v6: adopt6 }, 'lease (deferred)'); adopt6 = null; }
  note(`[v6] vault ${addr} passed the gate (VERSION 6, owner, keeper, poolId, USDC): ENABLED, trades once active && !paused`);
}
if (g6 !== 'off') {
  const disc = makeDiscovery(pub, c6, account?.address);
  const scan = async () => { if (v6) return; try {
      if (g6 === 'fixed') await enableV6(c6.vault!); else { const f = await disc.step(); v6Next = disc.next; v6ScanAt = new Date().toISOString(); if (f) { note(`[v6] discovered owner deployment ${f.addr} (nonce ${f.nonce})`); await enableV6(f.addr); }
        else if (disc.rejected.length) v6Bad = disc.rejected.map(r => `${r.addr}:${r.bad.join('/')}`); }
    } catch (e) { note(`[v6] scan error ${redact(e)} (retry in 30 s)`); } };
  await scan(); const t6 = setInterval(() => { if (v6) clearInterval(t6); else void scan(); }, 30_000);
}
const engines = () => [v5, v6].filter(Boolean) as Engine[];

async function onBlock(n: bigint) {
  if (n <= head) return; head = n; const gapS = (Date.now() - lastBlockAt) / 1000; lastBlockAt = Date.now();
  try { gasPrice = await pub.getGasPrice(); } catch (e) { note(`error gas price ${redact(e)}`); }
  await Promise.all(engines().map(e => e.onBlock(n, gapS)));
}

const wss = process.env.QN_WSS;
const feedObj = new BlockFeed({
  openWs: wss ? (onB, onE) => { const ws = createPublicClient({ chain, transport: webSocket(wss, { retryCount: 0 }) }); const un = ws.watchBlockNumber({ emitOnBegin: true, onBlockNumber: onB, onError: onE });
    return () => { un(); (ws.transport as any).getRpcClient?.().then((c: any) => c.close?.()).catch(() => {}); }; } : undefined,
  pollHttp: async () => pub.getBlockNumber({ cacheTime: 0 }),
  onBlock: (n, via) => { feed = via; void onBlock(n); }, note,
});
const engStatus = (E: Engine) => ({ live: E.live, vaultState: E.vaultState, vault: E.vault, tick: E.tick, waiting: E.waiting, halted: E.st.halted, txs: E.txs, open: E.book.orders.length, openIds: E.book.orders.map(o => o.id),
  orders: E.book.orders.map(o => ({ id: o.id, side: o.side, lower: o.lower, upper: o.lower + (o.w ?? 1), crossed: !!o.crossed })), sidePaused: E.book.sidePaused, mtmMon: mtm(E.book, E.tick), trips: E.book.trips.length,
  crossed: E.book.orders.filter(o => o.crossed).map(o => o.id), rounds: E.book.orders.reduce((a, o) => a + (o.rounds ?? 0), 0), tunables: E.TUN, lastGas: E.gasLog.slice(-10), dayPnlMon: E.st.dayPnl, dayGasMon: E.st.dayGas, gasMon: E.st.gasMon });
const v6Status = () => { const base = { state: v6 ? (!v6.vaultState.active ? 'inactive' : v6.vaultState.paused ? 'paused' : 'active') : v6State, vault: v6Vault, bad: v6Bad, lastScan: v6ScanAt || null, scannedToNonce: v6Next ? v6Next - 1 : null, deployJson: (c6 as any).deployJson ?? null };
  return v6 ? { ...base, ...engStatus(v6) } : base; };
let wallPrev = Date.now(), monoPrev = performance.now();
setInterval(() => {   // heartbeat; wake / clock-jump detection; stuck-handler kill. Never pauses a vault.
  const wall = Date.now(), mono = performance.now(), dWall = wall - wallPrev, dMono = mono - monoPrev; wallPrev = wall; monoPrev = mono;
  if (dWall > 6_000 || Math.abs(dWall - dMono) > 3_000) { wakes++; note(`wake/clock jump: wall +${(dWall / 1000).toFixed(1)}s mono +${(dMono / 1000).toFixed(1)}s -> resync, reload nonce, reconcile`); nonce = -1; for (const e of engines()) e.needReconcile = true; feedObj.resync('wake'); }
  for (const e of engines()) if (e.busySince && wall - e.busySince > STRATEGY.busyKillS * 1000) { note(`${e.name} block handler stuck ${((wall - e.busySince) / 1000).toFixed(0)}s: exiting for a clean supervisor restart`); setTimeout(() => process.exit(3), 200); }
  const age = (wall - lastBlockAt) / 1000, E = v5;
  writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), startedAt, wantLive: WANT_LIVE, keeper: account?.address ?? null, head: String(head), feed, wsUp: feedObj.wsUp, wsReconnects: feedObj.wsReconnects, lease: leaseStatus(), rpc: pool.status(),
    gasGwei: Number(gasPrice) / 1e9, blockAgeS: age, stale: age > STRATEGY.staleNoNewS, staleWarn: age > STRATEGY.staleWarnS, wakes, tipGwei: TIP_GWEI,
    ...(E ? engStatus(E) : { live: false, vault: null }), strategy: STRATEGY, v6: v6Status(), log: log.slice(-10) }, null, 1));
}, 2_000);
feedObj.start();
process.on('SIGUSR2', () => feedObj.resync('SIGUSR2 (simulated WS drop)'));
note(`maker keeper v4/v5/v6 one-process${v5?.batch ? ' (V5: snapshot + batched execute)' : ''} ${WANT_LIVE ? 'LIVE requested (needs vault active + unpaused)' : 'DRY RUN'} ${STRATEGY.sizeMinMonEq}-${STRATEGY.sizeMonEq} MON-eq/order skewed to inventory, stop held exits > ${v5?.TUN.stopTicks ?? STRATEGY.stopTicks} ticks, loss guard realised+gas -${STRATEGY.dailyLossFrac * 2 * STRATEGY.sizeMonEq} MON, no place if > ${STRATEGY.placeMaxMoveTicks} ticks/10 s, filled = own exit, tip ${TIP_GWEI} gwei, gas limit x${STRATEGY.gasMult}; V6 ${v6 ? 'ENABLED ' + v6Vault : v6State}; never-stall mode (no keeperPause)`);

// leader lease (box <-> GitHub Actions); carries both books so a takeover continues the same positions. Root = V5 (unchanged), v6 = V6 book.
const snap = (E: Engine) => ({ cfg: { geo: E.TUN.geo, recentreTicks: E.TUN.recentreTicks, recentreMin: E.TUN.recentreMs / 60_000, size: [STRATEGY.sizeMinMonEq, STRATEGY.sizeMonEq] }, orders: E.book.orders, sidePaused: E.book.sidePaused, halted: '', day: E.st.day, dayPnl: E.st.dayPnl, dayGas: E.st.dayGas });
const adoptInto = (E: Engine, b: any, from: string) => { if (!b || !Array.isArray(b.orders) || b.orders.some((o: Ord) => String(o.id).startsWith('dry'))) return; E.book.orders = b.orders.map(migrateOrder); E.book.sidePaused = b.sidePaused ?? E.book.sidePaused;
  if (b.day === E.st.day || !E.st.day) { E.st.day = b.day; E.st.dayPnl = b.dayPnl ?? E.st.dayPnl; E.st.dayGas = b.dayGas ?? E.st.dayGas; } E.needReconcile = true; E.save(); note(`${E.name === 'v6' ? '[v6] ' : ''}lease: adopted book from ${from} (${E.book.orders.length} open)`); };
const leaseHooks = {
  note,
  snapshot: () => ({ ...(v5 ? snap(v5) : {}), rpc: { active: pool.status().active, switches: pool.switches, down: pool.status().endpoints.filter(e => !e.up).map(e => e.name) }, v6: v6 ? { vault: v6.vault, state: v6Status().state, ...snap(v6) } : { state: v6State, vault: v6Vault } }),
  adopt: (b: any, from: string) => { if (!b) return; if (v5 && Array.isArray(b.orders)) adoptInto(v5, b, from);
    if (b.v6) { if (v6 && (!b.v6.vault || String(b.v6.vault).toLowerCase() === v6.vault.toLowerCase())) adoptInto(v6, b.v6, from); else if (!v6) adopt6 = b.v6; } },
};
if (WANT_LIVE) await startLease(leaseHooks); // dry runs never touch the shared lease
const runFor = Number(process.env.RUN_FOR_S ?? 0);
const bye = async () => { await releaseLease(leaseHooks); const t = Date.now(); while (engines().some(e => e.busy) && Date.now() - t < 30_000) await new Promise(r => setTimeout(r, 200)); for (const e of engines()) e.save(); process.exit(0); };
if (runFor > 0) setTimeout(bye, runFor * 1000);
process.on('SIGTERM', bye); process.on('SIGINT', bye);
