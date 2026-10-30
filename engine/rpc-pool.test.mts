import { test } from 'node:test'; import assert from 'node:assert/strict';
import { RpcPool, classify, defaultPool, PUBLIC_MONAD } from './rpc-pool.mts';
type R = { status?: number; body?: any; throws?: string };
const mkFetch = (plan: Record<string, (method: string) => R>, calls: string[]) => (async (url: string, init: any) => {
  const m = JSON.parse(init.body).method; calls.push(`${url}:${m}`); const r = plan[url](m);
  if (r.throws) { const e: any = new Error(r.throws); e.name = r.throws === 'timeout' ? 'AbortError' : 'Error'; throw e; }
  return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) } as any; }) as any;
const ok = (result: any) => ({ body: { jsonrpc: '2.0', id: 1, result } });
test('classify: quota/timeout/5xx fail over, tx errors do not, restricted methods skip', () => {
  for (const [s, c, m] of [[429, undefined, ''], [402, undefined, ''], [0, undefined, 'timeout'], [503, undefined, ''], [200, -32005, 'x'], [200, -32000, 'You have exceeded your monthly API credits'], [200, -32000, 'daily request limit reached'], [200, 1, 'rate limit exceeded']] as const)
    assert.equal(classify(s, c, m), 'failover', `${s} ${c} ${m}`);
  for (const m of ['execution reverted', 'nonce too low', 'insufficient funds for gas * price + value', 'exceeds block gas limit', 'intrinsic gas too low']) assert.equal(classify(200, -32000, m), 'ok', m);
  assert.equal(classify(200, -32601, 'method not found'), 'skip'); assert.equal(classify(200, -32000, 'Restricted JSON RPC method'), 'skip');
});
test('pool: QuickNode first; quota error -> instant failover, 10 min cooldown, retried after cooldown', async () => {
  let t = 1_000_000, qnQuota = true; const calls: string[] = [], notes: string[] = [];
  const pool = new RpcPool([['quicknode', 'q'], ['monad-rpc', 'a'], ['drpc', 'b']], { now: () => t, note: s => notes.push(s),
    fetch: mkFetch({ q: () => qnQuota ? { status: 429, body: { error: { code: -32005, message: 'credits exhausted' } } } : ok('0x10'), a: () => ok('0x11'), b: () => ok('0x12') }, calls) });
  assert.equal(await pool.request('eth_blockNumber'), '0x11'); assert.equal(pool.status().active, 'monad-rpc');
  assert.deepEqual(calls, ['q:eth_blockNumber', 'a:eth_blockNumber']); assert.equal(pool.status().endpoints[0].up, false); assert.equal(pool.status().endpoints[0].downForS, 600);
  calls.length = 0; await pool.request('eth_blockNumber'); assert.deepEqual(calls, ['a:eth_blockNumber']);              // cooled down: not retried
  qnQuota = false; t += 600_001; calls.length = 0; assert.equal(await pool.request('eth_blockNumber'), '0x10'); assert.deepEqual(calls, ['q:eth_blockNumber']);
  assert.equal(pool.status().active, 'quicknode'); assert.ok(notes.every(n => !/https?:\/\//.test(n)));
});
test('pool: timeout and network errors fail over; execution errors are returned, not failed over', async () => {
  const calls: string[] = [];
  const pool = new RpcPool([['quicknode', 'q'], ['monad-rpc', 'a']], { fetch: mkFetch({ q: m => m === 'eth_call' ? { body: { error: { code: 3, message: 'execution reverted' } } } : { throws: 'timeout' }, a: () => ok('0x1') }, calls) });
  assert.equal(await pool.request('eth_chainId'), '0x1'); assert.equal(pool.status().endpoints[0].downForS, 60);   // timeout: short cooldown
  const p2 = new RpcPool([['quicknode', 'q'], ['monad-rpc', 'a']], { fetch: mkFetch({ q: () => ({ body: { error: { code: 3, message: 'execution reverted' } } }), a: () => ok('0x1') }, calls) });
  await assert.rejects(p2.request('eth_call', [{}]), /execution reverted/); assert.equal(p2.status().endpoints[0].up, true);
});
test('pool: probe excludes a wrong chain and cools a stale head; broadcast goes to healthy endpoints only', async () => {
  const calls: string[] = [];
  const pool = new RpcPool([['quicknode', 'q'], ['wrong', 'w'], ['stale', 's'], ['monad-rpc', 'a']], { fetch: mkFetch({
    q: m => m === 'eth_chainId' ? ok('0x8f') : m === 'eth_sendRawTransaction' ? { status: 402, body: {} } : ok('0x1000'),
    w: m => m === 'eth_chainId' ? ok('0x1') : ok('0x1000'), s: m => m === 'eth_chainId' ? ok('0x8f') : m === 'eth_sendRawTransaction' ? ok('0xbad') : ok('0x100'),
    a: m => m === 'eth_chainId' ? ok('0x8f') : m === 'eth_sendRawTransaction' ? ok('0xhash') : ok('0x1001') }, calls) });
  await pool.probe(); const st = pool.status();
  assert.equal(st.endpoints[1].excluded, true); assert.equal(st.endpoints[2].up, false); assert.equal(st.endpoints[0].up, true);
  calls.length = 0; assert.equal(await pool.broadcast('0xraw'), '0xhash');
  assert.ok(!calls.some(c => c.startsWith('s:') || c.startsWith('w:'))); assert.equal(pool.status().endpoints[0].up, false);     // QN 402 on send -> cooled
});
test('default pool: QuickNode first, then the verified public Monad mainnet RPCs; status shows names only', () => {
  const p = defaultPool('https://secret.example/abc'); assert.deepEqual(p.eps.map(e => e.name), ['quicknode', ...PUBLIC_MONAD.map(x => x[0])]);
  assert.doesNotMatch(JSON.stringify(p.status()), /secret|https?:/); assert.equal(defaultPool(undefined).eps[0].name, 'monad-rpc');
});
