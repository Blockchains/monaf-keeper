import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getContractAddress } from 'viem';
import { gateState, checkV6, makeDiscovery, type V6Cfg } from './maker-v6-gate.mts';
import { clampGeometry, rangeFor } from './maker-v4-lib.mts';
const cfg: V6Cfg = JSON.parse(readFileSync(new URL('./pools/maker-pools.json', import.meta.url), 'utf8'))['mon-usdc-v6'];
const A = (c: string) => '0x' + c.repeat(40);
test('v6 gate state: autoEnable discovers, kill switch wins', () => {
  assert.equal(cfg.enabled, false); assert.equal(cfg.vault, null); assert.equal(cfg.autoEnable, true);
  assert.equal(gateState(cfg, {}), 'discover'); assert.equal(gateState(cfg, { MAKER_V6: '0' }), 'off');
  assert.equal(gateState({ ...cfg, autoEnable: false }, {}), 'off');
  assert.equal(gateState({ ...cfg, vault: A('1') }, {}), 'fixed'); assert.equal(gateState({ ...cfg, vault: '0x12' }, {}), 'discover');
  const d = JSON.parse(readFileSync(new URL('../site/v6/deploy.json', import.meta.url), 'utf8'));
  assert.equal(d.poolId.toLowerCase(), cfg.poolId.toLowerCase()); assert.equal(d.keeper.toLowerCase(), cfg.keeper.toLowerCase());
});
// mock chain: owner nonces 0..5; nonce 2 = some other contract, nonce 4 = a wrong-keeper V6, nonce 5 = the good V6
const owner = cfg.owner as `0x${string}`, at = (n: number) => getContractAddress({ from: owner, nonce: BigInt(n) }).toLowerCase();
const mk = (nonce: number, good: Record<string, any>) => ({
  getTransactionCount: async () => nonce,
  getCode: async ({ address }: any) => good[address.toLowerCase()] ? '0x60' : '0x',
  readContract: async ({ address, functionName }: any) => { const g = good[address.toLowerCase()]; if (!g || !(functionName in g)) throw new Error('revert'); return g[functionName]; },
});
const v6 = (o: any = {}) => ({ VERSION: 6, owner: cfg.owner, keeper: cfg.keeper, poolId: cfg.poolId, token1: cfg.currency1, active: false, paused: false, ...o });
test('v6 discovery: only a contract passing the full gate is adopted', async () => {
  const chain = { [at(2)]: { foo: 1 }, [at(4)]: v6({ keeper: A('2') }) };
  const c = { ...cfg, discoverFromNonce: 0 };
  let pub = mk(5, chain); const d = makeDiscovery(pub, c, cfg.keeper);
  assert.equal(await d.step(), null); assert.equal(d.next, 5); assert.deepEqual(d.rejected.map(r => r.nonce), [2, 4]);
  assert.ok(d.rejected[0].bad.includes('VERSION')); assert.deepEqual(d.rejected[1].bad, ['keeper']);
  pub = mk(6, { ...chain, [at(5)]: v6() }); Object.assign(pub, {}); const d2 = makeDiscovery(pub, { ...c, discoverFromNonce: 5 }, cfg.keeper);
  assert.deepEqual(await d2.step(), { addr: getContractAddress({ from: owner, nonce: 5n }), nonce: 5 });
  // the signing key must equal the vault keeper too
  assert.deepEqual((await checkV6(pub, at(5), cfg, A('3'))).bad, ['keeper']);
  for (const [k, v] of [['VERSION', 5], ['owner', A('4')], ['poolId', '0x' + '0'.repeat(64)], ['token1', A('5')]] as const)
    assert.deepEqual((await checkV6(mk(6, { [at(5)]: v6({ [k]: v }) }), at(5), cfg, cfg.keeper)).bad, [k]);
  assert.deepEqual((await checkV6(mk(6, {}), at(5), cfg)).bad, ['no code']);
});
test('v6 geometry: spacing 10, width 50, never TooFar at dist 60', () => {
  const g = clampGeometry(cfg.geometry, { maxDistance: 60, spacing: 10 });
  assert.equal(g.width, 50); assert.equal(g.offset, 48);
  for (let t = -300_017; t < -299_900; t += 7) {
    const a = rangeFor('ask', t, g), b = rangeFor('bid', t, g);
    assert.ok(a % 10 === 0 && b % 10 === 0); assert.ok(a > t && a - t <= 60, `ask ${a} @${t}`); assert.ok(b + 50 <= t && t - (b + 50) <= 60, `bid ${b} @${t}`);
  }
  assert.deepEqual(clampGeometry({ offset: 30, width: 5 }, { fixedWidth: 1, maxDistance: 10, spacing: 1 }).width, 1); // V5 unchanged
});
