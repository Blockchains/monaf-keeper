/**
 * Leader election for the maker keeper v4: the box copy and the GitHub Actions copy share ONE key, so exactly one may send.
 * Lease = JSON body of one GitHub issue comment (LEASE_REPO + LEASE_COMMENT_ID), edited in place via the REST API.
 * Ages use GitHub's own clock (response Date header minus comment updated_at), so host clock skew does not matter.
 *  - primary (Actions, LEASE_ROLE=primary): claims on start even over a fresh standby lease, then waits CLAIM_WAIT_S before
 *    sending so the standby sees the claim and finishes any in-flight tx. Renews every RENEW_S (write-only, ~450 req/h).
 *  - standby (box, LEASE_ROLE=standby): reads every POLL_S; takes over only when the lease is > TAKEOVER_S stale or released;
 *    steps down at once when it reads another fresh holder.
 *  - Self-fence: a leader whose last successful renewal is > FENCE_S old stops sending (FENCE_S < TAKEOVER_S).
 * The lease carries the open book (orders etc.) so a new leader continues the other's positions instead of starting empty.
 * No LEASE_COMMENT_ID / GH_TOKEN, or a dry run (MONAF_MAKER_LIVE!=1) => always leader, lease untouched (old behaviour).
 */
const REPO = process.env.LEASE_REPO ?? 'Blockchains/monaf-keeper', CID = process.env.LEASE_COMMENT_ID ?? '', TOKEN = process.env.GH_TOKEN ?? '';
const ROLE = process.env.LEASE_ROLE === 'primary' ? 'primary' : 'standby';
export const ME = process.env.LEASE_INSTANCE || `${ROLE}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const RENEW_S = 8, POLL_S = 4, FENCE_S = 15, TAKEOVER_S = 25, CLAIM_WAIT_S = 30;
export type Lease = { holder: string; role?: string; at?: string; released?: boolean; epoch?: number; book?: unknown };
type Hooks = { snapshot: () => unknown; adopt: (book: unknown, from: string) => void; note: (s: string) => void };

const enabled = !!(CID && TOKEN);
let started = false, leader = true, renewedAt = Infinity, sendFrom = 0, epoch = 0, stopping = false, lastSeen: { holder: string; ageS: number } = { holder: '', ageS: 0 };
const url = `https://api.github.com/repos/${REPO}/issues/comments/${CID}`;
const hdr = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'monaf-maker-keeper' };

async function read(): Promise<{ lease: Lease; ageS: number }> {
  const r = await fetch(url, { headers: hdr, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`lease read ${r.status}`);
  const j: any = await r.json(); const now = Date.parse(r.headers.get('date') ?? '') || Date.now();
  let lease: Lease; try { lease = JSON.parse(j.body); } catch { lease = { holder: 'none', released: true }; }
  return { lease, ageS: (now - Date.parse(j.updated_at)) / 1000 };
}
async function write(l: Lease) {
  const r = await fetch(url, { method: 'PATCH', headers: { ...hdr, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: JSON.stringify(l) }), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`lease write ${r.status}`);
}
const mine = (book: unknown): Lease => ({ holder: ME, role: ROLE, at: new Date().toISOString(), epoch, book });

/** True only while this instance holds a fresh lease and any claim wait is over. Check right before every send. */
export const canSend = () => leader && !stopping && Date.now() - renewedAt < FENCE_S * 1000 && Date.now() >= sendFrom;
export const isLeader = () => leader && !stopping;
export const leaseStatus = () => ({ enabled, me: ME, role: ROLE, leader, canSend: canSend(), seen: lastSeen, renewedAgoS: Number.isFinite(renewedAt) ? (Date.now() - renewedAt) / 1000 : 0 });

async function become(h: Hooks, cur: Lease, why: string) {
  if (cur.book && cur.holder !== ME) h.adopt(cur.book, cur.holder);
  epoch = (cur.epoch ?? 0) + 1; await write(mine(h.snapshot())); renewedAt = Date.now(); leader = true;
  sendFrom = Date.now() + (ROLE === 'primary' && !cur.released && cur.holder !== 'none' ? CLAIM_WAIT_S * 1000 : 2000);
  h.note(`lease: LEADER (${why}; prev ${cur.holder}) sends from ${new Date(sendFrom).toISOString()}`);
}

export async function startLease(h: Hooks) {
  if (!enabled) { h.note('lease: disabled (no LEASE_COMMENT_ID/GH_TOKEN) -> always leader'); return; }
  started = true; leader = false; renewedAt = 0; h.note(`lease: ${ME} role ${ROLE}`);
  let busy = false;
  const tick = async () => {
    if (busy || stopping) return; busy = true;
    try {
      if (leader && Date.now() - renewedAt > FENCE_S * 1000) { leader = false; h.note('lease: renewal lapsed -> fenced, re-claiming'); }
      if (leader) {
        if (ROLE === 'standby') { // standby leader also reads, to step down the moment the primary claims
          const { lease, ageS } = await read(); lastSeen = { holder: lease.holder, ageS };
          if (lease.holder !== ME && !lease.released && ageS < TAKEOVER_S) { leader = false; h.adopt(lease.book, lease.holder); h.note(`lease: step down -> ${lease.holder}`); return; }
        }
        if (Date.now() - renewedAt >= RENEW_S * 1000 - 500) { await write(mine(h.snapshot())); renewedAt = Date.now(); }
      } else {
        const { lease, ageS } = await read(); lastSeen = { holder: lease.holder, ageS };
        if (ROLE === 'primary') await become(h, lease, 'primary claim');
        else if (lease.released || lease.holder === 'none' || ageS > TAKEOVER_S || lease.holder === ME) await become(h, lease, lease.released ? 'released' : `stale ${ageS.toFixed(0)}s`);
      }
    } catch (e) { h.note(`lease ${String((e as any)?.message ?? e).slice(0, 80)}`); }
    finally { busy = false; }
  };
  await tick(); setInterval(tick, (ROLE === 'primary' ? 2 : POLL_S) * 1000);
}

/** Graceful exit (end of an Actions job): stop sending, hand the book over and mark the lease released. */
export async function releaseLease(h: Hooks) {
  stopping = true; if (!enabled || !started || !leader) return; // dry runs / never-started instances never touch the lease
  try { await write({ ...mine(h.snapshot()), released: true }); h.note('lease: released'); } catch (e) { h.note(`lease release failed ${String(e).slice(0, 80)}`); }
  leader = false;
}
