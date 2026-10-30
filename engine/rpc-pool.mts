/**
 * RPC failsafe pool (chain 143). Ordered list: QuickNode (secret, never printed) first, then free public Monad mainnet RPCs.
 * Each request goes to the first healthy endpoint; on quota (HTTP 402/429, -32005, "credits"/"rate limit"...), HTTP 5xx/403,
 * timeout, network error or a stale head it fails over instantly and cools the bad endpoint down (default 10 min), then retries it.
 * Execution errors (revert, nonce too low, insufficient funds) are returned to the caller unchanged (no failover).
 * Only endpoint NAMES are ever exposed (status/logs); URLs stay inside this module.
 */
export type Ep = { name: string; url: string; downUntil: number; fails: number; why: string; head: bigint; headAt: number; bad: boolean };
export type Verdict = 'ok' | 'failover' | 'skip';
const QUOTA = /credits?\b|quota|(rate|request|usage|daily|monthly|plan)[ -]?limit|limit (exceeded|reached)|too many requests|exceeded (your|the) (capacity|limit|plan)|api key|not allowed to access|capacity/i;
const SKIP = /restricted|method not (found|supported|allowed|available)|not whitelisted|unsupported method|block range|range (is )?too (large|wide)|max(imum)? (block )?range|limited to \d+|response size/i;
/** Classify one failed attempt. status = HTTP status (0 = network/timeout), code/msg = JSON-RPC error. */
export function classify(status: number, code?: number, msg = ''): Verdict {
  if (status === 0 || status === 402 || status === 429 || status === 403 || status === 401 || status >= 500) return 'failover';
  if (code === -32005 || code === -32029 || code === -32090) return 'failover';
  if (/gas/i.test(msg) && !/credits?\b|quota/i.test(msg)) return 'ok';           // "gas limit", "intrinsic gas too low": real tx errors
  if (QUOTA.test(msg)) return 'failover';
  if (code === -32601 || SKIP.test(msg)) return 'skip';                          // this endpoint can't serve this method/range: try next, no cooldown
  return 'ok';
}
export const PUBLIC_MONAD: [string, string][] = [
  ['monad-rpc', 'https://rpc.monad.xyz'], ['monad-rpc1', 'https://rpc1.monad.xyz'], ['monad-rpc2', 'https://rpc2.monad.xyz'], ['monad-rpc3', 'https://rpc3.monad.xyz'],
  ['monadinfra', 'https://rpc-mainnet.monadinfra.com'], ['drpc', 'https://monad-mainnet.drpc.org'], ['thirdweb', 'https://143.rpc.thirdweb.com'],
];
export type PoolOpts = { cooldownMs?: number; timeoutMs?: number; staleBlocks?: number; staleCooldownMs?: number; chainIdHex?: string; note?: (s: string) => void; now?: () => number; fetch?: typeof fetch };
export class RpcPool {
  eps: Ep[]; o: Required<Omit<PoolOpts, 'note'>> & { note: (s: string) => void }; active = ''; switches = 0;
  constructor(list: [string, string][], o: PoolOpts = {}) {
    this.eps = list.filter(([, u]) => !!u).map(([name, url]) => ({ name, url, downUntil: 0, fails: 0, why: '', head: 0n, headAt: 0, bad: false }));
    this.o = { cooldownMs: 600_000, timeoutMs: 8_000, staleBlocks: 40, staleCooldownMs: 120_000, chainIdHex: '0x8f', note: () => {}, now: Date.now, fetch: globalThis.fetch, ...o } as any;
  }
  static redact = (s: string) => s.replace(/(https?|wss?):\/\/\S+/g, '<rpc>');
  down(e: Ep, why: string, ms = this.o.cooldownMs) { e.downUntil = this.o.now() + ms; e.fails++; e.why = RpcPool.redact(why).slice(0, 80); this.o.note(`rpc ${e.name} down ${Math.round(ms / 1000)}s: ${e.why}`); }
  order(): Ep[] { const t = this.o.now(), ok = this.eps.filter(e => !e.bad && e.downUntil <= t);
    return ok.length ? ok : this.eps.filter(e => !e.bad).sort((a, b) => a.downUntil - b.downUntil); }   // all down: try the one that recovers first
  private async once(e: Ep, method: string, params: unknown) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), this.o.timeoutMs);
    try { const r = await this.o.fetch(e.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }), signal: ac.signal });
      const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { j = undefined; }
      if (!r.ok || !j) return { status: r.ok ? 502 : r.status, err: { code: j?.error?.code, message: j?.error?.message ?? `HTTP ${r.status}` } };
      if (j.error) return { status: 200, err: j.error };
      return { status: 200, result: j.result };
    } catch (x: any) { return { status: 0, err: { message: x?.name === 'AbortError' ? 'timeout' : String(x?.message ?? x) } }; } finally { clearTimeout(tm); }
  }
  /** JSON-RPC request with failover. Throws {code,message} for real RPC errors (viem maps them). */
  async request(method: string, params?: unknown): Promise<any> {
    let last: any = { code: -32603, message: 'no rpc endpoint available' };
    for (const e of this.order()) {
      const r = await this.once(e, method, params);
      if (!r.err) { if (this.active !== e.name) { if (this.active) { this.switches++; this.o.note(`rpc active: ${e.name} (was ${this.active})`); } this.active = e.name; }
        if (method === 'eth_blockNumber' && typeof r.result === 'string') this.seen(e, BigInt(r.result)); return r.result; }
      const v = classify(r.status, r.err.code, String(r.err.message ?? ''));
      if (v === 'ok') { const er: any = new Error(RpcPool.redact(String(r.err.message))); er.code = r.err.code; er.data = r.err.data; throw er; }
      if (v === 'failover') this.down(e, `${r.status || 'net'} ${r.err.code ?? ''} ${r.err.message}`, this.coolFor(r.status, String(r.err.message ?? '')));
      last = { code: r.err.code ?? -32603, message: RpcPool.redact(String(r.err.message)) };
    }
    const er: any = new Error(last.message); er.code = last.code; throw er;
  }
  /** Quota/credits exhausted -> full cooldown (10 min); a plain burst rate limit (429 without quota wording) or timeout -> 60 s. */
  coolFor(status: number, msg: string) { return /credits?\b|quota|monthly|daily|plan/i.test(msg) || status === 402 ? this.o.cooldownMs : Math.min(60_000, this.o.cooldownMs); }
  seen(e: Ep, n: bigint) { if (n > e.head) { e.head = n; e.headAt = this.o.now(); } }
  /** Probe all endpoints: chainId must be 0x8f (else permanently excluded); an endpoint > staleBlocks behind the best head is cooled down. */
  async probe(): Promise<void> {
    const t = this.o.now();
    await Promise.all(this.eps.filter(e => !e.bad).map(async e => {
      if (!e.head) { const c = await this.once(e, 'eth_chainId', []); if (!c.err && String(c.result).toLowerCase() !== this.o.chainIdHex) { e.bad = true; this.o.note(`rpc ${e.name} excluded: chainId ${c.result}`); return; } }
      const r = await this.once(e, 'eth_blockNumber', []);
      if (r.err) { if (e.downUntil <= t && classify(r.status, r.err.code, String(r.err.message ?? '')) === 'failover') this.down(e, `probe ${r.status || 'net'} ${r.err.message}`); return; }
      this.seen(e, BigInt(r.result));
    }));
    const best = this.eps.reduce((m, e) => e.head > m ? e.head : m, 0n);
    for (const e of this.eps) if (!e.bad && e.head && best - e.head > BigInt(this.o.staleBlocks) && e.downUntil <= t) this.down(e, `stale head ${best - e.head} blocks behind`, this.o.staleCooldownMs);
  }
  healthy() { const t = this.o.now(); return this.eps.filter(e => !e.bad && e.downUntil <= t); }
  status() { const t = this.o.now(); return { active: this.active || null, switches: this.switches,
    endpoints: this.eps.map(e => ({ name: e.name, up: !e.bad && e.downUntil <= t, downForS: e.downUntil > t ? Math.round((e.downUntil - t) / 1000) : 0, fails: e.fails, why: e.why || undefined, excluded: e.bad || undefined })) }; }
  /** Broadcast a signed tx to every healthy endpoint (first acceptance wins); single nonce lane is the caller's job. */
  async broadcast(raw: string): Promise<string> {
    const eps = this.healthy().length ? this.healthy() : this.order();
    return Promise.any(eps.map(async e => { const r = await this.once(e, 'eth_sendRawTransaction', [raw]);
      if (r.err) { if (classify(r.status, r.err.code, String(r.err.message ?? '')) === 'failover') this.down(e, `send ${r.status || 'net'} ${r.err.message}`);
        const er: any = new Error(RpcPool.redact(String(r.err.message))); er.code = r.err.code; throw er; }
      return r.result as string; }));
  }
}
/** Default keeper pool: QN_HTTP (if set) first, then public Monad RPCs. */
export const defaultPool = (qn: string | undefined, o?: PoolOpts) => new RpcPool([...(qn ? [['quicknode', qn] as [string, string]] : []), ...PUBLIC_MONAD], o);
