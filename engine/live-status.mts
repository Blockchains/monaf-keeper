/**
 * Live status publisher for the monaf maker vault. READ-ONLY and GAS-FREE: no key, no signing, never touches the keeper's
 * process, nonce or lease (it only READS the lease comment). Runs in its own workflow (live-status.yml), so a stall here can
 * never stall the keeper. Every TICK_S it writes OUT_DIR/status.json; the workflow pushes it to the gh-pages branch.
 * env: QN_HTTP (optional, read-only RPC secret; falls back to the public RPC), GH_TOKEN + LEASE_COMMENT_ID (lease read),
 *      OUT_DIR, PREV (previous status.json for incremental action history), RUN_FOR_S, TICK_S.
 */
import { createPublicClient, http, parseAbi, decodeEventLog, decodeFunctionData, type Address } from 'viem';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { V4 } from './maker-v4-lib.mts';

const VAULT = (process.env.VAULT ?? '0x1fEE5da5FEDa2656163a593Af70b84325B8e2958') as Address;
const KEEPER = (process.env.KEEPER ?? '0x85c2bBcf6d7419740d01a60874BD3F85B2c96Fe2') as Address;
const FUND = { block: 117674770n, nonce: 142, mon: 1100, weth: 0.0098, at: '2026-10-29T17:43:17Z' }; // owner funding tx 0x48eb2bf7…
const PRIV = process.env.QN_HTTP || '', RPC = PRIV || 'https://rpc.monad.xyz', CHUNK = PRIV ? 1000n : 100n;
const OUT = process.env.OUT_DIR ?? 'site', TICK_S = Number(process.env.TICK_S ?? 30), RUN_FOR_S = Number(process.env.RUN_FOR_S ?? 0);
const c = createPublicClient({ transport: http(RPC, { retryCount: 2, timeout: 10_000 }) });
const redact = (e: unknown) => String((e as any)?.shortMessage ?? (e as any)?.message ?? e).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<rpc>').slice(0, 160);
const vAbi = parseAbi(['function snapshot() view returns (bool,bool,int24,uint160,uint256,uint256,uint256[])',
  'event Placed(uint256 indexed tokenId, int24 tickLower, bool sellMon, uint128 liquidity, uint256 amountMax)', 'event Closed(uint256 indexed tokenId, uint256 mon, uint256 weth)']);
const pmAbi = parseAbi(['function getPositionLiquidity(uint256) view returns (uint128)']);
const sqrtAt = (t: number) => Math.pow(1.0001, t / 2);
/** token amounts of a v4 position (currency0 = MON, currency1 = WETH), float math, display only */
function amounts(L: number, lo: number, hi: number, sp: number) {
  const a = sqrtAt(lo), b = sqrtAt(hi), s = Math.min(Math.max(sp, a), b);
  return { mon: L * (b - s) / (s * b) / 1e18, weth: L * (s - a) / 1e18 };
}
type Act = { t: string; block: string; tx: string; kind: string; ok: boolean; gasMon: number; detail: string };
let prev: any = {}; try { if (process.env.PREV && existsSync(process.env.PREV)) prev = JSON.parse(readFileSync(process.env.PREV, 'utf8')); } catch {}
let actions: Act[] = Array.isArray(prev.allActions) ? prev.allActions : [];
let scanned = BigInt(Array.isArray(prev.flows) ? (prev.scannedBlock ?? FUND.block - 1n) : FUND.block - 1n), seenNonce = Number(prev.seenNonce ?? FUND.nonce);
const OWNER = (process.env.OWNER ?? '0x9A4382E8C662B827cf38A1f18cb5fa07ce61Ac1F') as Address, WETH = V4.weth as Address;
/** owner deposits / withdrawals after the first funding (signed: + into the vault). Native MON: owner txs to the vault (value, or
 *  withdraw(address,uint256) calldata); WETH: Transfer logs owner <-> vault. Seeded with the first funding. */
let flows: { t: string; tx: string; mon: number; weth: number }[] = Array.isArray(prev.flows) ? prev.flows : [{ t: FUND.at, tx: '0x48eb2bf721a80cd3287ca2a36d0595e132ed243e82ee5e86aa48350b61655b4f', mon: FUND.mon, weth: FUND.weth }];
let ownerNonce = Number(prev.ownerNonce ?? -1);
const tAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const wAbi = parseAbi(['function withdraw(address to,uint256 amount)', 'function withdrawToken(address token,address to,uint256 amount)']);
const addFlow = (f: { t: string; tx: string; mon: number; weth: number }) => { const e = flows.find(x => x.tx === f.tx); if (e) { e.mon = e.mon || f.mon; e.weth = e.weth || f.weth; } else flows.push(f); };
const known = new Set(actions.map(a => a.tx));
const blockTime = new Map<bigint, string>();
async function tOf(b: bigint) { if (!blockTime.has(b)) blockTime.set(b, new Date(Number((await c.getBlock({ blockNumber: b })).timestamp) * 1000).toISOString()); return blockTime.get(b)!; }
async function addTx(hash: `0x${string}`) {
  if (known.has(hash)) return; known.add(hash);
  const r = await c.getTransactionReceipt({ hash }); const evs: string[] = []; let kind = 'tx';
  for (const l of r.logs) if (l.address.toLowerCase() === VAULT.toLowerCase()) try {
    const d: any = decodeEventLog({ abi: vAbi, data: l.data, topics: l.topics });
    if (d.eventName === 'Placed') evs.push(`place ${d.args.sellMon ? 'ask' : 'bid'} #${d.args.tokenId} [${d.args.tickLower},${d.args.tickLower + 1}) max ${(Number(d.args.amountMax) / 1e18).toPrecision(5)} ${d.args.sellMon ? 'MON' : 'WETH'}`);
    else evs.push(`close #${d.args.tokenId} -> ${(Number(d.args.mon) / 1e18).toPrecision(6)} MON + ${(Number(d.args.weth) / 1e18).toPrecision(5)} WETH`);
  } catch {}
  if (evs.length) kind = evs.some(e => e.startsWith('close')) && evs.some(e => e.startsWith('place')) ? 'recentre' : evs[0].split(' ')[0];
  if (r.status !== 'success') kind = 'REVERTED';
  if (r.from.toLowerCase() !== KEEPER.toLowerCase()) kind = `owner ${kind}`;
  actions.push({ t: await tOf(r.blockNumber), block: String(r.blockNumber), tx: hash, kind, ok: r.status === 'success', gasMon: Number(r.gasUsed * r.effectiveGasPrice) / 1e18, detail: evs.join('; ') || (r.status === 'success' ? '' : 'reverted (no events; Monad bills the full gas limit)') });
}
/** vault events since `scanned` (chunked to the RPC's getLogs range) + any keeper tx without vault events (reverts) via nonce search */
async function scan(head: bigint) {
  const from = scanned + 1n; if (head < from) return;
  const starts: bigint[] = []; for (let b = from; b <= head; b += CHUNK) starts.push(b);
  for (let i = 0; i < starts.length; i += 6) {
    const rs = await Promise.all(starts.slice(i, i + 6).map(b => c.getLogs({ address: VAULT, fromBlock: b, toBlock: b + CHUNK - 1n > head ? head : b + CHUNK - 1n })));
    for (const ls of rs) for (const l of ls) await addTx(l.transactionHash!);
  }
  for (let i = 0; i < starts.length; i += 6) { // WETH owner <-> vault
    const rs = await Promise.all(starts.slice(i, i + 6).flatMap(b => { const to = b + CHUNK - 1n > head ? head : b + CHUNK - 1n;
      return [c.getLogs({ address: WETH, event: tAbi[0], args: { from: OWNER, to: VAULT }, fromBlock: b, toBlock: to }), c.getLogs({ address: WETH, event: tAbi[0], args: { from: VAULT, to: OWNER }, fromBlock: b, toBlock: to })]; }));
    for (const ls of rs) for (const l of ls) { const inn = (l.args as any).to.toLowerCase() === VAULT.toLowerCase(); if (l.transactionHash === flows[0].tx) continue;
      addFlow({ t: await tOf(l.blockNumber!), tx: l.transactionHash!, mon: 0, weth: (inn ? 1 : -1) * Number((l.args as any).value) / 1e18 }); }
  }
  const on = await c.getTransactionCount({ address: OWNER, blockNumber: head }); // owner native MON in/out via txs to the vault
  if (ownerNonce < 0) ownerNonce = await c.getTransactionCount({ address: OWNER, blockNumber: FUND.block });
  for (let k = ownerNonce + 1; k <= on; k++) {
    let lo = scanned < FUND.block ? FUND.block : scanned, hi = head;
    if (await c.getTransactionCount({ address: OWNER, blockNumber: lo }) >= k) continue;
    while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (await c.getTransactionCount({ address: OWNER, blockNumber: m }) >= k) hi = m; else lo = m; }
    const blk = await c.getBlock({ blockNumber: hi, includeTransactions: true });
    for (const tx of blk.transactions) if (typeof tx !== 'string' && tx.from.toLowerCase() === OWNER.toLowerCase() && tx.to?.toLowerCase() === VAULT.toLowerCase()) {
      const r = await c.getTransactionReceipt({ hash: tx.hash }); if (r.status !== 'success' || tx.hash === flows[0].tx) continue;
      let mon = Number(tx.value) / 1e18, weth = 0;
      try { const d = decodeFunctionData({ abi: wAbi, data: tx.input }); if (d.functionName === 'withdraw') mon -= Number(d.args[1]) / 1e18; else if (String(d.args[0]).toLowerCase() === WETH.toLowerCase()) weth = -Number(d.args[2]) / 1e18; } catch {}
      if (mon || weth) addFlow({ t: await tOf(hi), tx: tx.hash, mon, weth });
    }
  }
  ownerNonce = on;
  const n = await c.getTransactionCount({ address: KEEPER, blockNumber: head });
  for (let k = seenNonce + 1; k <= n; k++) { // find the block where nonce reached k (tx with nonce k-1)
    let lo = scanned < FUND.block ? FUND.block : scanned, hi = head;
    if (await c.getTransactionCount({ address: KEEPER, blockNumber: lo }) >= k) continue;
    while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (await c.getTransactionCount({ address: KEEPER, blockNumber: m }) >= k) hi = m; else lo = m; }
    const blk = await c.getBlock({ blockNumber: hi, includeTransactions: true });
    for (const tx of blk.transactions) if (typeof tx !== 'string' && tx.from.toLowerCase() === KEEPER.toLowerCase()) await addTx(tx.hash);
  }
  seenNonce = n; scanned = head;
  actions.sort((a, b) => Number(BigInt(a.block) - BigInt(b.block))); if (actions.length > 500) actions = actions.slice(-500);
}
async function lease() {
  const cid = process.env.LEASE_COMMENT_ID, tok = process.env.GH_TOKEN; if (!cid || !tok) return null;
  const r = await fetch(`https://api.github.com/repos/${process.env.LEASE_REPO ?? 'Blockchains/monaf-keeper'}/issues/comments/${cid}`,
    { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'monaf-live-status' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return { error: `lease read ${r.status}` };
  const j: any = await r.json(); const now = Date.parse(r.headers.get('date') ?? '') || Date.now(); let l: any = {}; try { l = JSON.parse(j.body); } catch {}
  return { holder: l.holder, role: l.role, released: !!l.released, ageS: Math.round((now - Date.parse(j.updated_at)) / 1000), book: l.book ?? null };
}
async function runs() {
  const tok = process.env.GH_TOKEN; if (!tok) return null;
  try { const r = await fetch(`https://api.github.com/repos/${process.env.LEASE_REPO ?? 'Blockchains/monaf-keeper'}/actions/workflows/maker-keeper.yml/runs?per_page=3`, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'monaf-live-status' }, signal: AbortSignal.timeout(5000) });
    const j: any = await r.json(); return (j.workflow_runs ?? []).map((x: any) => ({ id: x.id, status: x.status, conclusion: x.conclusion, created: x.created_at, url: x.html_url })); } catch { return null; }
}
async function once() {
  const head = await c.getBlockNumber();
  const [sn, gp, ls, rn] = await Promise.all([c.readContract({ address: VAULT, abi: vAbi, functionName: 'snapshot', blockNumber: head }), c.getGasPrice(), lease().catch(e => ({ error: redact(e) })), runs()]);
  await scan(head);
  const [active, paused, tick, sqrtX96, monW, wethW, ids] = sn; const sp = Number(sqrtX96) / 2 ** 96, monPerWeth = 1 / (sp * sp);
  const bookById = new Map<string, any>(((ls as any)?.book?.orders ?? []).map((o: any) => [String(o.id), o]));
  const orders = await Promise.all(ids.map(async id => {
    const L = Number(await c.readContract({ address: V4.positionManager as Address, abi: pmAbi, functionName: 'getPositionLiquidity', args: [id], blockNumber: head }));
    const b = bookById.get(String(id)); const lo = b?.lower ?? null, w = b?.w ?? 1; const a = lo === null ? null : amounts(L, lo, lo + w, sp);
    const side = b?.side ?? '?'; const wantMon = side === 'ask'; // ask = MON->WETH (fills when price rises above the range)
    const fill = a ? (side === 'ask' ? a.weth * monPerWeth / (a.mon + a.weth * monPerWeth || 1) : a.mon / (a.mon + a.weth * monPerWeth || 1)) : null;
    return { id: String(id), side, kind: b?.kind ?? '?', range: lo === null ? null : [lo, lo + w], widthTicks: lo === null ? null : w, ticksFromSpot: lo === null ? null : (lo > Number(tick) ? lo - Number(tick) : lo + w <= Number(tick) ? lo + w - Number(tick) : 0), trades: b ? ((b.kind === 'fresh' && b.crossed) ? (side === 'ask' ? 'bid' : 'ask') : side) : '?', mon: a?.mon ?? null, weth: a?.weth ?? null,
      valueMon: a ? a.mon + a.weth * monPerWeth : null, fillPct: fill === null ? null : Math.round(fill * 1000) / 10, heldAsExit: !!b?.crossed, placedAt: b?.placedAt ? new Date(b.placedAt).toISOString() : null, startAsset: wantMon ? 'MON' : 'WETH', startAmt: b?.startAmt ?? null };
  }));
  const idleMon = Number(monW) / 1e18, idleWeth = Number(wethW) / 1e18;
  const ordMon = orders.reduce((s, o) => s + (o.mon ?? 0), 0), ordWeth = orders.reduce((s, o) => s + (o.weth ?? 0), 0);
  const totMon = idleMon + ordMon, totWeth = idleWeth + ordWeth, valueMon = totMon + totWeth * monPerWeth;
  const fundMon = flows.reduce((a, f) => a + f.mon, 0), fundWeth = flows.reduce((a, f) => a + f.weth, 0), fundValueNow = fundMon + fundWeth * monPerWeth;
  const today = new Date().toISOString().slice(0, 10);
  const keeperActs = actions.filter(a => !a.kind.startsWith('owner'));
  const gasSince = keeperActs.reduce((s, a) => s + a.gasMon, 0), gasToday = keeperActs.filter(a => a.t.startsWith(today)).reduce((s, a) => s + a.gasMon, 0);
  const lAge = (ls as any)?.ageS ?? null, lastAct = keeperActs.at(-1)?.t ?? null;
  const alerts: string[] = [];
  if (lAge === null || lAge > 180) alerts.push(`KEEPER SILENT: lease not renewed for ${lAge ?? '?'} s (> 180 s)`);
  const unknown = orders.filter(o => o.valueMon === null).length;
  if (unknown) alerts.push(`valuation incomplete: ${unknown} order(s) not yet in the lease book (just placed); totals and P&L exclude them until the next refresh`);
  for (const d of ['ask', 'bid']) { const n = orders.filter(o => o.trades === d).length; if (n > 1) alerts.push(`${n} resting ${d}-direction orders (Phase 1 rule: exactly one per side; the keeper closes extras in its next batch)`); }
  if (!active) alerts.push('vault inactive'); if (paused) alerts.push('vault paused by owner');
  const recentFails = keeperActs.filter(a => !a.ok && Date.now() - Date.parse(a.t) < 6 * 3600e3); if (recentFails.length) alerts.push(`${recentFails.length} reverted keeper tx(s) in the last 6 h`);
  const s = {
    at: new Date().toISOString(), block: String(head), vault: VAULT, keeper: KEEPER, active, paused, tick: Number(tick), spotMonPerWeth: monPerWeth, gasGwei: Number(gp) / 1e9,
    idle: { mon: idleMon, weth: idleWeth }, orders, totals: { mon: totMon, weth: totWeth, valueMon },
    funding: { netMon: fundMon, netWeth: fundWeth, valueAtSpotMon: fundValueNow, flows },
    pnl: { vsFundingAtSpotMon: valueMon - fundValueNow, partial: unknown > 0, note: 'vault value now minus the net owner deposits (1,100 MON + 0.0098 WETH at 17:43 UTC plus any later deposits or withdrawals), all at current pool spot (= P&L vs simply holding); includes gas already paid' },
    gas: { sinceFundingMon: gasSince, todayUtcMon: gasToday, keeperDayGasMon: (ls as any)?.book?.dayGas ?? null, txsSinceFunding: keeperActs.length, revertsSinceFunding: keeperActs.filter(a => !a.ok).length },
    config: (ls as any)?.book?.cfg ?? null,
    keeperDay: (ls as any)?.book ? { day: (ls as any).book.day, dayPnlMon: (ls as any).book.dayPnl, sidePaused: (ls as any).book.sidePaused } : null,
    leader: ls ? { holder: (ls as any).holder, role: (ls as any).role, released: (ls as any).released, leaseAgeS: lAge, healthy: lAge !== null && lAge <= 60 && !(ls as any).released, error: (ls as any).error } : null,
    standby: 'box copy polls the lease every 5 s and takes over if it is > 60 s stale', runs: rn, lastKeeperTx: lastAct,
    alerts, actions: actions.slice(-20).reverse(), allActions: actions, scannedBlock: String(scanned), seenNonce, ownerNonce,
  };
  writeFileSync(`${OUT}/status.json`, JSON.stringify(s, null, 1));
  return s;
}
const end = RUN_FOR_S ? Date.now() + RUN_FOR_S * 1000 : 0;
for (;;) {
  const t0 = Date.now();
  try { const s = await once(); console.log(`${s.at} block ${s.block} tick ${s.tick} value ${s.totals.valueMon.toFixed(3)} MON pnl ${s.pnl.vsFundingAtSpotMon.toFixed(3)} lease ${s.leader?.leaseAgeS}s alerts ${s.alerts.length}`); }
  catch (e) { console.log(`${new Date().toISOString()} error ${redact(e)}`); }
  if (!end || Date.now() > end) break;
  await new Promise(r => setTimeout(r, Math.max(1000, TICK_S * 1000 - (Date.now() - t0))));
}
