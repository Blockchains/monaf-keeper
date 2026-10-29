# monaf-keeper

> **ALPHA — experimental software. Use at your own risk.** This is an automated on-chain market-making keeper for a
> single, specific vault on Monad. It can lose money. Nothing here is financial advice and **no returns are claimed or implied**.

This repo contains only the minimal keeper runtime that GitHub Actions runs as the always-on primary:

- `engine/maker-keeper-v4.mts` – keeper loop (calls the vault's own `place` / `close`)
- `engine/maker-v4-lib.mts`, `engine/maker-v4-feed.mts` – strategy helpers and block feed
- `engine/maker-leader.mts` – leader lease so exactly one copy (Actions primary / standby elsewhere) sends; see `LEADER-LEASE.md`
- `.github/workflows/maker-keeper.yml` – schedule + manual dispatch only

Configuration comes only from repository secrets (`MAKER_KEEPER_PK`, `MONAD_RPC_URL`, `MONAD_WSS_URL`) and the variable
`LEASE_COMMENT_ID`. No keys, RPC endpoints, state or logs are stored in this repo. Contributions via pull request never run
the workflow (it has no PR triggers).

License: MIT.

## Live status page
https://blockchains.github.io/monaf-keeper/ is read-only and gas-free. `engine/live-status.mts` runs in its own workflow (`live-status.yml`), separate from the keeper. It reads the vault snapshot, the v4 positions, the vault events, the keeper nonce (which also catches reverted txs) and the lease comment. It writes `status.json` every 30 s and pushes it to `gh-pages` every 60 s. The page reloads every 15 s and shows a red alert if the keeper's lease is more than 3 min old.
