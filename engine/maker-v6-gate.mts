/**
 * V6 (MON/USDC) gate + auto-discovery. Read-only: sends nothing, never prints the RPC URL.
 * A V6 vault is used ONLY if its runtime passes the gate: code present, VERSION()==6, owner/keeper/poolId/token1 == the config.
 * Discovery: the owner deploys from a wallet (monaf.ai /vault button). CREATE addresses are keccak(rlp(owner, nonce)), so the keeper
 * walks the owner's nonces from cfg.discoverFromNonce up to its current nonce and gates every address that has code. Nonces already
 * checked without code can never get code later (the nonce is spent), so each is checked once per process.
 * CLI: node engine/maker-v6-gate.mts  -> prints the gate state for the configured / discovered vault.
 */
import { readFileSync } from 'node:fs';
import { parseAbi, getAddress, getContractAddress, type Address } from 'viem';
export type V6Cfg = { enabled: boolean; autoEnable?: boolean; vault: string | null; owner: string; keeper: string; poolId: string; currency1: string; decimals1: number; fee: number; spacing: number;
  geometry: { offset: number; width: number }; discoverFromNonce?: number; tunables?: { recentreTicks?: number; stopTicks?: number; placeMaxMoveTicks?: number }; gasFallback?: { ask: number; bid: number; close: number } };
export const loadV6Cfg = (): V6Cfg => {
  const c = JSON.parse(readFileSync(new URL('./pools/maker-pools.json', import.meta.url), 'utf8'))['mon-usdc-v6'] as V6Cfg;
  if (process.env.MAKER_V6_OWNER) c.owner = process.env.MAKER_V6_OWNER;                 // fork tests only
  if (process.env.MAKER_V6_FROM_NONCE) c.discoverFromNonce = Number(process.env.MAKER_V6_FROM_NONCE);
  if (process.env.MAKER_V6_VAULT) c.vault = process.env.MAKER_V6_VAULT;
  if (process.env.MAKER_V6_KEEPER) c.keeper = process.env.MAKER_V6_KEEPER;            // fork tests only (the vault keeper must ALSO equal the signing key)
  return c;
};
/** 'off' = never touch V6 (kill switch); 'fixed' = configured address (still gated); 'discover' = scan the owner's creations. */
export function gateState(c: Partial<V6Cfg> | undefined, env: Record<string, string | undefined> = process.env): 'off' | 'fixed' | 'discover' {
  if (!c || env.MAKER_V6 === '0') return 'off';
  if (typeof c.vault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.vault) && (c.enabled === true || c.autoEnable === true)) return 'fixed';
  return c.autoEnable === true || c.enabled === true ? 'discover' : 'off';
}
const abi = parseAbi(['function VERSION() view returns (uint8)', 'function owner() view returns (address)', 'function keeper() view returns (address)', 'function poolId() view returns (bytes32)',
  'function token1() view returns (address)', 'function active() view returns (bool)', 'function paused() view returns (bool)']);
/** Gate one address. keeper = the address of the key this process signs with (must equal cfg.keeper too). */
export async function checkV6(pub: any, addr: string, c: V6Cfg, keeper?: string): Promise<{ ok: boolean; bad: string[]; active?: boolean; paused?: boolean }> {
  const v = getAddress(addr) as Address;
  const code = await pub.getCode({ address: v }); if (!code || code === '0x') return { ok: false, bad: ['no code'] };
  const r = (fn: string) => pub.readContract({ address: v, abi, functionName: fn }).catch(() => null);
  const [ver, own, kp, pid, t1, act, pau] = await Promise.all(['VERSION', 'owner', 'keeper', 'poolId', 'token1', 'active', 'paused'].map(r));
  const eq = (a: any, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const bad = [ver === null || Number(ver) !== 6 ? 'VERSION' : '', !eq(own, c.owner) ? 'owner' : '', !eq(kp, c.keeper) || (keeper && !eq(kp, keeper)) ? 'keeper' : '',
    !eq(pid, c.poolId) ? 'poolId' : '', !eq(t1, c.currency1) ? 'token1' : ''].filter(Boolean);
  return { ok: bad.length === 0, bad, active: act ?? undefined, paused: pau ?? undefined };
}
/** Stateful scanner over the owner's CREATE addresses. step() returns the first gated vault, or null. */
export function makeDiscovery(pub: any, c: V6Cfg, keeper?: string) {
  let next = c.discoverFromNonce ?? 0; const rejected: { addr: string; nonce: number; bad: string[] }[] = [];
  return {
    get next() { return next; }, rejected,
    async step(): Promise<{ addr: string; nonce: number } | null> {
      const n = await pub.getTransactionCount({ address: getAddress(c.owner), blockTag: 'latest' });
      while (next < n) {
        const hi = Math.min(n, next + 8), batch = Array.from({ length: hi - next }, (_, i) => next + i);
        const codes = await Promise.all(batch.map(k => pub.getCode({ address: getContractAddress({ from: getAddress(c.owner) as Address, nonce: BigInt(k) }) })));
        for (let i = 0; i < batch.length; i++) if (codes[i] && codes[i] !== '0x') {
          const addr = getContractAddress({ from: getAddress(c.owner) as Address, nonce: BigInt(batch[i]) }), g = await checkV6(pub, addr, c, keeper);
          if (g.ok) { next = batch[i] + 1; return { addr, nonce: batch[i] }; }
          rejected.push({ addr, nonce: batch[i], bad: g.bad }); if (rejected.length > 10) rejected.shift();
        }
        next = hi;
      }
      return null;
    },
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  process.on('uncaughtException', e => { console.log('v6: error ' + String((e as any)?.shortMessage ?? (e as any)?.message ?? e).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<rpc>').slice(0, 120)); process.exit(1); });
  process.on('unhandledRejection', e => { console.log('v6: error ' + String((e as any)?.shortMessage ?? (e as any)?.message ?? e).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<rpc>').slice(0, 120)); process.exit(1); });
  const { createPublicClient, http } = await import('viem');
  const c = loadV6Cfg(), st = gateState(c);
  if (st === 'off') { console.log('v6: off (maker-pools.json mon-usdc-v6: enabled/autoEnable false, or MAKER_V6=0)'); process.exit(0); }
  const url = process.env.QN_HTTP; if (!url) { console.log('v6: no RPC (QN_HTTP)'); process.exit(1); }
  const pub = createPublicClient({ transport: http(url, { retryCount: 4, timeout: 10_000 }) });
  if (st === 'fixed') { const g = await checkV6(pub, c.vault!, c); console.log(g.ok ? `v6: vault ok ${c.vault} active=${g.active} paused=${g.paused}` : `v6: REFUSE ${c.vault} ${g.bad.join(',')}`); process.exit(g.ok ? 0 : 1); }
  const d = makeDiscovery(pub, c), f = await d.step();
  console.log(f ? `v6: discovered ${f.addr} (owner nonce ${f.nonce}) - gate ok` : `v6: awaiting deploy (owner nonces ${c.discoverFromNonce}..${d.next - 1} scanned, no gated V6)${d.rejected.length ? ` rejected ${d.rejected.map(r => r.addr + ':' + r.bad.join('/')).join(' ')}` : ''}`); process.exit(0);
}
