/**
 * monaf maker keeper for MonafMakerVaultV4 on Uniswap v4 MON/WETH 0.05% ts1 (ALPHA, unaudited, no guaranteed returns).
 * Strategy is HARD-CODED in engine/maker-v4-lib.mts (STRATEGY): 1,000 MON-eq per side, adjacent single tick, max 4 open,
 * cap hit -> pause the filled side and hold (no recycle), re-centre unfilled fresh after 5 min, exits never moved,
 * gas cap 150 gwei, daily loss -25 MON incl. MTM, strict full-cross fills.
 * NEVER-STALL rules (hard-coded): the keeper never calls keeperPause(); stale data = no new orders until fresh blocks (auto-resume);
 * daily loss = no new orders until the next UTC day (auto-resume); no halt survives a restart (only the supervisor STOP file stops it);
 * WS drop -> immediate HTTP polling + WS reconnect with backoff; wall-clock jump / wake -> resync feed, reload pending nonce, reconcile
 * open positions with vault.openIds; a block handler stuck > busyKillS exits so the supervisor restarts it.
 * Sends txs ONLY when MONAF_MAKER_LIVE=1 AND vault.active() AND !vault.paused(); otherwise dry run (models fills, sends nothing).
 * env: VAULT, MAKER_KEEPER_KEY (0600 env file; never in a repo/browser/log), QN_HTTP / QN_WSS (never printed), STATUS (heartbeat path)
 *      FORK=1 (anvil fork test: broadcast only to QN_HTTP, never to public RPCs)
 */
import { createPublicClient, http, webSocket, parseAbi, parseEventLogs, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { BlockFeed } from './maker-v4-feed.mts';
import { V4, STRATEGY, plan, waitReason, rollDay, clearHaltOnStart, reconcile, applyClose, applyPlace, proceeds, liquidityFor, mtm, newBook, type Book, type Ord } from './maker-v4-lib.mts';
import { startLease, canSend, isLeader, releaseLease, leaseStatus } from './maker-leader.mts';

const WANT_LIVE = process.env.MONAF_MAKER_LIVE === '1', FORK = process.env.FORK === '1';
const VAULT = (process.env.VAULT ?? '') as Address;
const STATUS = process.env.STATUS ?? 'maker-keeper-v4-status.json', BOOK = STATUS.replace(/\.json$/, '') + '-book.json';
if (WANT_LIVE && !/^0x[0-9a-fA-F]{40}$/.test(VAULT)) throw new Error('VAULT is required when live');
if (WANT_LIVE && !process.env.MAKER_KEEPER_KEY) throw new Error('MAKER_KEEPER_KEY is required when live (env file, never committed)');
const account = process.env.MAKER_KEEPER_KEY ? privateKeyToAccount(process.env.MAKER_KEEPER_KEY as Hex) : null;
const redact = (e: unknown) => String((e as any)?.shortMessage ?? (e as any)?.message ?? e).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<rpc>').slice(0, 200);
const httpUrl = process.env.QN_HTTP || process.env.QUICKNODE_MONAD_RPC_URL || '';
if (!httpUrl) throw new Error('QN_HTTP (RPC URL) is required: set it from a secret, never hardcode it');
const chain = { id: V4.chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [httpUrl] } } } as const;
const pub = createPublicClient({ chain, transport: http(httpUrl, { retryCount: 2 }) });
const nodes = (FORK ? [httpUrl] : [httpUrl, 'https://rpc.monad.xyz', 'https://rpc2.monad.xyz']).map(u => createPublicClient({ chain, transport: http(u) }));
const ercAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const svAbi = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']);
const vaultAbi = parseAbi(['function place(int24 tickLower,uint128 liquidity,uint128 amountMax,uint256 deadline) returns (uint256)', 'function close(uint256 tokenId,uint256 deadline) returns (uint256,uint256)',
  'function openCount() view returns (uint256)', 'function openIds(uint256) view returns (uint256)', 'function paused() view returns (bool)', 'function active() view returns (bool)', 'function keeper() view returns (address)', 'function poolId() view returns (bytes32)',
  'event Placed(uint256 indexed tokenId, int24 tickLower, bool sellMon, uint128 liquidity, uint256 amountMax)', 'event Closed(uint256 indexed tokenId, uint256 mon, uint256 weth)']);

const book: Book = existsSync(BOOK) ? JSON.parse(readFileSync(BOOK, 'utf8')) : { ...newBook(), day: '', gasMon: 0 };
const st = book as Book & { day: string; gasMon: number };
const save = () => writeFileSync(BOOK, JSON.stringify(book, null, 1));
{ const was = clearHaltOnStart(book); if (was) { console.log(`${new Date().toISOString()} startup: cleared persisted halt "${was}" (only STOP stops the bot)`); save(); } }
let needReconcile = true, waiting = '', busySince = 0, wakes = 0, txs = { place: 0, close: 0, fail: 0 }; const startedAt = new Date().toISOString();
let nonce = -1, tick = 0, head = 0n, lastBlockAt = Date.now(), busy = false, feed = 'http', gasPrice = 0n, dryId = 0, live = false, vaultState = { active: false, paused: false };
const log: string[] = []; const note = (s: string) => { log.push(`${new Date().toISOString()} ${s}`); if (log.length > 50) log.shift(); console.log(log.at(-1)); };

if (VAULT) { // refuse a vault that is not wired to the verified pool / this keeper
  const [pid, k] = await Promise.all([pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'poolId' }), pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'keeper' })]);
  if (pid.toLowerCase() !== V4.poolId) throw new Error('vault poolId mismatch');
  if (account && k.toLowerCase() !== account.address.toLowerCase()) throw new Error('vault keeper is not this key');
}

/** Single nonce lane: every tx from this key goes through here, strictly sequential. */
async function send(fn: 'place' | 'close', args: readonly unknown[]) {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: fn, args: args as any });
  if (!live) return null;
  if (!canSend()) throw new Error('not lease leader: send skipped');
  nonce = await pub.getTransactionCount({ address: account!.address, blockTag: 'pending' }); // reload pending nonce every send (wake / hand-off safe)
  const gas = await pub.estimateGas({ account: account!.address, to: VAULT, data });
  const tip = gasPrice / 10n;
  const raw = await account!.signTransaction({ chainId: V4.chainId, type: 'eip1559', to: VAULT, nonce, gas: gas * 115n / 100n, maxFeePerGas: gasPrice * 12n / 10n + tip, maxPriorityFeePerGas: tip, data });
  try {
    const hash = await Promise.any(nodes.map(n => n.sendRawTransaction({ serializedTransaction: raw }))); nonce++;
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 20_000 });
    const cost = Number(rc.gasUsed * rc.effectiveGasPrice) / 1e18; st.gasMon += cost; st.dayGas += cost;
    if (rc.status !== 'success') { txs.fail++; throw new Error(`reverted ${hash}`); }
    txs[fn]++;
    return parseEventLogs({ abi: vaultAbi, logs: rc.logs });
  } catch (e) { nonce = -1; throw e; }
}
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 120);
/** Reconcile the book with vault.openIds (startup + after a wake): drop orders closed elsewhere, close unknown vault positions back into the vault. */
async function reconcileOnChain() {
  if (!VAULT) { needReconcile = false; return; }
  const n = Number(await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'openCount' }));
  const ids = (await Promise.all(Array.from({ length: n }, (_, i) => pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'openIds', args: [BigInt(i)] })))).map(String);
  if (live) book.orders = book.orders.filter(o => !o.id.startsWith('dry'));
  const r = reconcile(book, ids); save();
  note(`reconcile: on-chain open ${n} [${ids.join(',')}], book ${book.orders.length}, dropped ${r.dropped.map(o => o.id).join(',') || '-'}, orphans ${r.orphans.join(',') || '-'}`);
  if (live) for (const id of r.orphans) { await send('close', [BigInt(id), dl()]); note(`closed orphan vault position #${id} (funds back to the vault)`); }
  needReconcile = false;
}

async function onBlock(n: bigint) {
  if (busy || n <= head) return; busy = true; busySince = Date.now(); head = n; const gapS = (Date.now() - lastBlockAt) / 1000; lastBlockAt = Date.now();
  try {
    if (rollDay(st, Date.now())) { note(`UTC day ${st.day}: daily counters reset`); save(); }
    const [s0, gp, act, pau] = await Promise.all([pub.readContract({ address: V4.stateView as Address, abi: svAbi, functionName: 'getSlot0', args: [V4.poolId] }), pub.getGasPrice(),
      VAULT ? pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'active' }) : false, VAULT ? pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'paused' }) : false]);
    tick = Number(s0[1]); gasPrice = gp; vaultState = { active: act, paused: pau };
    const nowLive = WANT_LIVE && act && !pau;
    if (nowLive !== live) { note(`mode ${nowLive ? 'LIVE' : 'DRY RUN'} (MONAF_MAKER_LIVE=${WANT_LIVE ? 1 : 0} active=${act} paused=${pau})`); live = nowLive; }
    if (!isLeader()) { waiting = 'standby (lease held elsewhere)'; return; } // status/heartbeat still written
    if (WANT_LIVE && !live) { waiting = 'vault inactive or paused by owner'; return; } // do nothing at all (no dry-run book drift)
    if (needReconcile) { if (live) await reconcileOnChain(); else needReconcile = false; }
    const [monW, wethW] = VAULT ? await Promise.all([pub.getBalance({ address: VAULT }), pub.readContract({ address: V4.weth as Address, abi: ercAbi, functionName: 'balanceOf', args: [VAULT] })]) : [0n, 0n];
    const inv = VAULT ? { mon: Number(monW) / 1e18, weth: Number(wethW) / 1e18 } : undefined;
    const ok = { gas: gp <= BigInt(STRATEGY.gasCapGwei * 1e9), fresh: gapS <= STRATEGY.staleNoNewS };
    const w = waitReason(book, tick, Date.now(), ok); if (w !== waiting) { note(w ? `wait: ${w}` : `resume: trading`); waiting = w; }
    const acts = plan(book, tick, Date.now(), ok, inv);
    let lastGot = 0;
    for (const a of acts) {
      if (a.do === 'halt') continue; // never emitted any more; never pauses on chain
      if (a.do === 'close') {
        const o = a.o as Ord; const ev = await send('close', [BigInt(o.id.startsWith('dry') ? 0 : o.id), dl()]);
        let got: number;
        if (ev) { const c = (ev.find(e => e.eventName === 'Closed') as any).args; const backIsWeth = (o.side === 'ask') === (a.why === 'fill'); got = Number(backIsWeth ? c.weth : c.mon) / 1e18; }
        else got = a.why === 'fill' ? proceeds(o) : o.amt;
        lastGot = got; applyClose(book, o, a.why, tick, got, Date.now()); save();
        note(`close ${a.why} ${o.kind} ${o.side} [${o.lower},${o.lower + 1}) #${o.id} -> ${got.toPrecision(6)}`);
      } else {
        const amt = Number.isNaN(a.amt) ? lastGot : a.amt; if (!(amt > 0)) continue;
        const wei = BigInt(Math.floor(amt * 1e18));
        const ev = await send('place', [a.lower, liquidityFor(a.side, a.lower, wei), wei, dl()]);
        const id = ev ? String((ev.find(e => e.eventName === 'Placed') as any).args.tokenId) : `dry${dryId++}`;
        applyPlace(book, a, id, amt, Date.now(), tick); save();
        note(`place ${a.kind} ${a.side} ${amt.toPrecision(6)} ${a.side === 'ask' ? 'MON' : 'WETH'} [${a.lower},${a.lower + 1}) #${id}`);
      }
    }
  } catch (e) { note(`error ${redact(e)}`); } finally { busy = false; busySince = 0; }
}

const wss = process.env.QN_WSS;
const rpcRot = FORK ? [pub] : [pub, ...nodes.slice(1)]; let rpcI = 0;
const feedObj = new BlockFeed({
  openWs: wss ? (onB, onE) => { const ws = createPublicClient({ chain, transport: webSocket(wss, { retryCount: 0 }) }); const un = ws.watchBlockNumber({ emitOnBegin: true, onBlockNumber: onB, onError: onE });
    return () => { un(); (ws.transport as any).getRpcClient?.().then((c: any) => c.close?.()).catch(() => {}); }; } : undefined,
  pollHttp: async () => { const c = rpcRot[rpcI % rpcRot.length]; try { return await c.getBlockNumber({ cacheTime: 0 }); } catch (e) { rpcI++; throw e; } },
  onBlock: (n, via) => { feed = via; void onBlock(n); }, note,
});
let wallPrev = Date.now(), monoPrev = performance.now();
setInterval(() => {   // heartbeat for the supervisor; wake / clock-jump detection; stuck-handler kill. Never pauses the vault.
  const wall = Date.now(), mono = performance.now(), dWall = wall - wallPrev, dMono = mono - monoPrev; wallPrev = wall; monoPrev = mono;
  if (dWall > 6_000 || Math.abs(dWall - dMono) > 3_000) { wakes++; note(`wake/clock jump: wall +${(dWall / 1000).toFixed(1)}s mono +${(dMono / 1000).toFixed(1)}s -> resync, reload nonce, reconcile`); nonce = -1; needReconcile = true; feedObj.resync('wake'); }
  if (busySince && wall - busySince > STRATEGY.busyKillS * 1000) { note(`block handler stuck ${((wall - busySince) / 1000).toFixed(0)}s: exiting for a clean supervisor restart`); setTimeout(() => process.exit(3), 200); }
  const age = (wall - lastBlockAt) / 1000;
  writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), startedAt, live, wantLive: WANT_LIVE, vaultState, keeper: account?.address ?? null, vault: VAULT || null, head: String(head), feed, wsUp: feedObj.wsUp, wsReconnects: feedObj.wsReconnects, tick, lease: leaseStatus(),
    gasGwei: Number(gasPrice) / 1e9, blockAgeS: age, stale: age > STRATEGY.staleNoNewS, staleWarn: age > STRATEGY.staleWarnS, waiting, halted: st.halted, wakes, txs, open: book.orders.length, openIds: book.orders.map(o => o.id), sidePaused: book.sidePaused, mtmMon: mtm(book, tick), trips: book.trips.length,
    dayPnlMon: st.dayPnl, dayGasMon: st.dayGas, gasMon: st.gasMon, strategy: STRATEGY, log: log.slice(-10) }, null, 1));
}, 2_000);
feedObj.start();
process.on('SIGUSR2', () => feedObj.resync('SIGUSR2 (simulated WS drop)')); // ops/test: drop WS now, HTTP fallback + reconnect
note(`maker keeper v4 ${WANT_LIVE ? 'LIVE requested (needs vault active + unpaused)' : 'DRY RUN'} size ${STRATEGY.sizeMonEq} MON-eq/side maxOpen ${STRATEGY.maxOpen}; never-stall mode (no keeperPause)`);

// leader lease (box <-> GitHub Actions); the lease carries the open book so a takeover continues the same positions
const leaseHooks = {
  note,
  snapshot: () => ({ orders: book.orders, sidePaused: book.sidePaused, halted: '', day: st.day, dayPnl: st.dayPnl, dayGas: st.dayGas }),
  adopt: (b: any, from: string) => { if (!b || !Array.isArray(b.orders) || b.orders.some((o: Ord) => String(o.id).startsWith('dry'))) return; book.orders = b.orders; book.sidePaused = b.sidePaused ?? book.sidePaused;
    if (b.day === st.day || !st.day) { st.day = b.day; st.dayPnl = b.dayPnl ?? st.dayPnl; st.dayGas = b.dayGas ?? st.dayGas; } needReconcile = true; save(); note(`lease: adopted book from ${from} (${book.orders.length} open)`); },
};
if (WANT_LIVE) await startLease(leaseHooks); // dry runs never touch the shared lease
const runFor = Number(process.env.RUN_FOR_S ?? 0); // Actions: graceful hand-off before the 6h job limit
const bye = async () => { await releaseLease(leaseHooks); const t = Date.now(); while (busy && Date.now() - t < 30_000) await new Promise(r => setTimeout(r, 200)); save(); process.exit(0); };
if (runFor > 0) setTimeout(bye, runFor * 1000);
process.on('SIGTERM', bye); process.on('SIGINT', bye);
