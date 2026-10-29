// Block feed for the v4 maker keeper: WebSocket first, HTTP polling whenever WS is down or quiet, so blocks never stop arriving.
// Transport-agnostic (injected) so it is unit-tested without a network. No secrets, no URLs here.
export type FeedDeps = {
  /** Open a WS block subscription. Must call onBlock for each head and onError on any failure. Returns an unsubscribe. */
  openWs?: (onBlock: (n: bigint) => void, onError: (e: unknown) => void) => () => void;
  /** HTTP eth_blockNumber (caller may rotate RPCs inside). */
  pollHttp: () => Promise<bigint>;
  onBlock: (n: bigint, via: 'wss' | 'http') => void;
  note?: (s: string) => void;
  now?: () => number;
  pollMs?: number;      // HTTP poll cadence while WS is down/quiet (~1 s)
  wsQuietMs?: number;   // WS silent this long -> treat as down, reconnect
  backoffMs?: number[]; // WS reconnect backoff
};
export class BlockFeed {
  feed: 'wss' | 'http' = 'http'; wsUp = false; wsReconnects = 0; lastWsAt = 0; lastAt = 0;
  private unsub: (() => void) | null = null; private timers: any[] = []; private attempt = 0; private gen = 0; private stopped = false; private polling = false;
  private d: FeedDeps;
  constructor(d: FeedDeps) { this.d = d; }
  private now() { return (this.d.now ?? Date.now)(); }
  start() {
    this.connect();
    const pollMs = this.d.pollMs ?? 1000, quiet = this.d.wsQuietMs ?? 5000;
    this.timers.push(setInterval(() => {
      if (this.wsUp && this.now() - this.lastWsAt > quiet) this.drop('ws quiet');
      if (!this.wsUp || this.now() - this.lastAt > 1500) void this.poll();
    }, pollMs));
    void this.poll();
  }
  stop() { this.stopped = true; this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.unsub?.(); this.unsub = null; }
  /** Force an immediate resync (after a wake / clock jump): poll now and rebuild WS. */
  resync(why: string) { this.d.note?.(`feed resync: ${why}`); this.drop(why); void this.poll(); }
  async poll() {
    if (this.polling || this.stopped) return; this.polling = true;
    try { const n = await this.d.pollHttp(); this.lastAt = this.now(); if (!this.wsUp) this.feed = 'http'; this.d.onBlock(n, 'http'); }
    catch (e) { this.d.note?.(`poll failed ${String((e as any)?.message ?? e).replace(/(https?|wss?):\/\/\S+/g, '<rpc>').slice(0, 120)}`); }
    finally { this.polling = false; }
  }
  private connect() {
    if (this.stopped || !this.d.openWs) return;
    const g = ++this.gen;
    try {
      this.unsub = this.d.openWs(n => { if (g !== this.gen) return; this.wsUp = true; this.attempt = 0; this.lastWsAt = this.lastAt = this.now(); this.feed = 'wss'; this.d.onBlock(n, 'wss'); },
        e => { if (g === this.gen) this.drop(`ws error ${String((e as any)?.message ?? e).replace(/(https?|wss?):\/\/\S+/g, '<rpc>').slice(0, 80)}`); });
      this.lastWsAt = this.now(); this.wsUp = true;
    } catch (e) { this.drop('ws open failed'); }
  }
  private drop(why: string) {
    if (this.stopped) return;
    this.gen++; try { this.unsub?.(); } catch {} this.unsub = null; this.wsUp = false; this.feed = 'http';
    if (!this.d.openWs) return;
    const bo = this.d.backoffMs ?? [0, 1000, 2000, 5000, 10000, 30000]; const wait = bo[Math.min(this.attempt++, bo.length - 1)];
    this.wsReconnects++; this.d.note?.(`${why}; HTTP polling, WS reconnect in ${wait}ms`);
    const t = setTimeout(() => { this.timers = this.timers.filter(x => x !== t); this.connect(); }, wait); this.timers.push(t);
  }
}
