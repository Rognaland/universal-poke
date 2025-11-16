Secrets management for local emulator and CI

DO NOT commit real private keys to the repository.

Local emulator
- Create `functions/.secret.local` (gitignored) with your local secrets. Example keys:

  RPC_URL=http://127.0.0.1:8545
  PRIVATE_KEY=0xYOUR_PRIVATE_KEY
  PRIZE_POOL_PK=0xDEDICATED_PRIZE_POOL_PRIVATE_KEY
  FUND_SENDER_PK=0xOPTIONAL_LEGACY_TOPUP_KEY
  PRIZE_DISTRIBUTOR=0x...

- The Functions code falls back to environment variables when firebase-functions secrets are not available.

- `PRIZE_POOL_PK` is the dedicated EOA that authorizes and funds prize payouts. Leave `FUND_SENDER_PK` unset unless you need a separate legacy wallet for top-ups.

CI / Production
- Store sensitive keys in your CI provider secrets (GitHub Actions: Settings -> Secrets).
- In production, prefer a managed secret store or KMS (Google Secret Manager, AWS KMS). Avoid raw env vars if possible.

Debug endpoints
- Keep `ALLOW_DEBUG=false` in production and only set `ALLOW_DEBUG=true` locally when needed together with `DEBUG_TOKEN`.
