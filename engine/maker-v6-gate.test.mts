import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const gateState = (c: any) => c?.enabled === true && typeof c?.vault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.vault) ? 'check' : 'disabled';
test('v6 gate', () => {
  const cfg = JSON.parse(readFileSync(new URL('./pools/maker-pools.json', import.meta.url), 'utf8'))['mon-usdc-v6'];
  assert.equal(gateState(cfg), 'disabled'); assert.equal(cfg.enabled, false); assert.equal(cfg.vault, null);
  assert.equal(gateState({ enabled: true, vault: null }), 'disabled'); assert.equal(gateState({ enabled: false, vault: '0x' + '1'.repeat(40) }), 'disabled');
  assert.equal(gateState({ enabled: true, vault: '0x' + '1'.repeat(40) }), 'check');
  const d = JSON.parse(readFileSync(new URL('../site/v6/deploy.json', import.meta.url), 'utf8'));
  assert.equal(d.poolId.toLowerCase(), cfg.poolId.toLowerCase()); assert.equal(d.keeper.toLowerCase(), cfg.keeper.toLowerCase());
});
