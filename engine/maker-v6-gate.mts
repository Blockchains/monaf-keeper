/**
 * V6 (MON/USDC) enable gate. Read-only: sends nothing, never prints the RPC URL.
 * Exit 0 + "disabled" while engine/pools/maker-pools.json mon-usdc-v6.enabled is false or vault is null.
 * When enabled, refuses (exit 1) unless the vault has code and VERSION()==6, owner/keeper/poolId/token1 match the config.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, getAddress, type Address } from 'viem';
const cfg = JSON.parse(readFileSync(new URL('./pools/maker-pools.json', import.meta.url), 'utf8'))['mon-usdc-v6'];
export function gateState(c: any): 'disabled' | 'check' { return c?.enabled === true && typeof c?.vault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.vault) ? 'check' : 'disabled'; }
if (gateState(cfg) === 'disabled') { console.log('v6: disabled (maker-pools.json mon-usdc-v6.enabled=false or vault=null)'); process.exit(0); }
const url = process.env.QN_HTTP; if (!url) { console.log('v6: no RPC'); process.exit(1); }
const pub = createPublicClient({ chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [url] } } } as any, transport: http(url) });
const abi = parseAbi(['function VERSION() view returns (uint8)', 'function owner() view returns (address)', 'function keeper() view returns (address)', 'function poolId() view returns (bytes32)', 'function token1() view returns (address)', 'function active() view returns (bool)', 'function paused() view returns (bool)']);
const v = getAddress(cfg.vault) as Address;
const code = await pub.getCode({ address: v }); if (!code || code === '0x') { console.log('v6: vault has no code'); process.exit(1); }
const r = (fn: any) => pub.readContract({ address: v, abi, functionName: fn } as any) as Promise<any>;
const [ver, own, kp, pid, t1, act, pau] = await Promise.all(['VERSION', 'owner', 'keeper', 'poolId', 'token1', 'active', 'paused'].map(r));
const bad = [Number(ver) !== 6 && 'VERSION', getAddress(own) !== getAddress(cfg.owner) && 'owner', getAddress(kp) !== getAddress(cfg.keeper) && 'keeper',
  String(pid).toLowerCase() !== cfg.poolId.toLowerCase() && 'poolId', getAddress(t1) !== getAddress(cfg.currency1) && 'token1'].filter(Boolean);
if (bad.length) { console.log('v6: REFUSE mismatch ' + bad.join(',')); process.exit(1); }
console.log(`v6: vault ok ${v} active=${act} paused=${pau}`);
