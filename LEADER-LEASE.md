# Maker keeper v4 leader lease (box vs GitHub Actions)

Both copies use the same keeper key, so only one may send (nonce clashes otherwise). Implementation: `engine/maker-leader.mts`.

- **Store**: the JSON body of one comment on a locked issue in this repo (comment id in repo variable `LEASE_COMMENT_ID`), edited in place with the REST API.
  Chosen because the Actions `GITHUB_TOKEN` can write it (`issues: write`) without a PAT, it is free, fast (~200 ms), and
  edits create no notifications. Repo variables / Gists would need a PAT stored as a secret; a branch file is too slow.
  Ages come from GitHub's clock (`Date` header minus `updated_at`), so host clock skew is irrelevant.
- **Roles**: Actions = `primary` (always leads when running), box = `standby`.
- **Timings**: leader renews every 8 s (~450 writes/h, under the GITHUB_TOKEN 1000 req/h/repo and the 500/h content limit).
  A leader that has not renewed for 15 s fences itself (stops sending) and must re-claim. Standby takes over only when the lease
  is >25 s stale or marked `released`. A primary claiming over a live standby waits 30 s before its first send (standby polls
  every 4 s and steps down at once; its in-flight receipt wait is <=20 s). Every send reloads the pending nonce from chain.
- **Book hand-off**: the lease carries the open orders + day counters, so the new leader continues the same positions.
- **Job rollover**: each Actions job runs ~5h50m, releases the lease (box takes over immediately), re-dispatches itself and
  exits; the next job re-claims. The 5-min cron + `concurrency: maker-keeper-v4` keep exactly one Actions job alive.
- No `GH_TOKEN`/`LEASE_COMMENT_ID` => single-instance mode (always leader), the old behaviour.
