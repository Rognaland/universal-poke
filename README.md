# Poker Platform On-Chain Deployment (LUKSO Mainnet)

_Date: 27 September 2025_

This repository powers the online/offline poker experience for Universal Profile players on the LUKSO Mainnet. The on-chain stack follows a "Reception / Safe / Notary" model that isolates responsibilities across three smart contracts for maximum security and operational clarity.

## Contract Architecture

### GameEntry.sol — “Recepcija”
- **Address:** `0x50aF74673Be378f7c5876a28C420F5cf746e1B8a`
- Sole contract that end users touch for buy-ins (LYX or WBSTR).
- Pulls authorised LSP7 balances from players, forwards native value, and acts as a trusted depositor for the vault.
- Simplifies UX by abstracting the more complex vault interactions.

### GameVaultV6.sol — “Sef”
- **Address:** `0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F`
- Secure escrow holding player balances per table and per token.
- Enforces token allow-list, rake configuration, and chip-to-token conversion rates.
- Trusted depositors: `GameEntry`, backend game server wallet, and prize pool wallet `0x9171dfe4D926BAec07e9289F4b011d93F3AE2318`.

### PrizeDistributorV6.sol — “Notar”
- **Address:** `0xB802b0b296D8D26Bf431E861E4a6F4a17Ac9c52D`
- Authoritative ledger of payouts authorised by the backend (“sodnik”).
- GameVault confirms every withdrawal against `consumeAuthorization` here before releasing funds.

## Mainnet Configuration Snapshot

| Parameter | Value |
|-----------|-------|
| Contract Owner (UP) | _Set during deployment — update `ADMIN_OWNER_PK` secret with the current admin UP private key before running admin endpoints._ |
| Backend Game Server | `0x01a842D1698DA387de50793Fdf56BF09Dc1D7C86` |
| Trusted Depositors | GameEntry (`0x50aF…1B8a`), Game Server (`0x01a8…7C86`), Prize Pool (`0x9171…2318`) |
| Allowed LSP7 Token | WBSTR `0xec718d31590e2015837e22a10df96ff466da2a14` |
| Chips ➜ LYX units | `1 chip = 0.01 LYX = 10¹⁶ wei` |
| Chips ➜ WBSTR units | `1 chip = 1000 WBSTR = 10²¹ token units` |
| Global rake (rakeBps) | `300` (3%) |

## Operational Flow

### Player Buy-in (LYX or WBSTR)
1. Player authorises GameEntry as an LSP7 operator (WBSTR only).
2. Frontend calls `GameEntry.buyInLYX(tableId)` with the correct LYX value or `GameEntry.buyInLSP7(token, tableId, amount)` for WBSTR.
3. GameEntry forwards the assets to GameVaultV6, crediting the player’s balance under the target table.

### Cash-out / Prize Claim
1. Backend (“sodnik”) computes final standings and calls `PrizeDistributorV6.authorizePayout` for each winner.
2. Player requests a withdrawal; GameVaultV6 consults `PrizeDistributorV6.consumeAuthorization` before releasing funds.

> **Opomba:** Firebase Functions avtomatsko sprožijo `GameVault.withdrawFor` prek `retryPendingPayoutWithdrawals` urnika. Poskrbi, da je `PRIZE_POOL_PK` nastavljena na zaupanja vreden depozitor (isti kot na verigi) in da ima ta denarnica WBSTR/LYX saldo za top-up in gas, sicer bodo izplačila ostala v čakalni vrsti.

> **Fallback:** če dva zaporedna poskusa avtomatskega dviga propadeta (npr. ker vault ni bil finančno napolnjen ali signer ni zaupan), backend samodejno nakaže zahtevani znesek neposredno na `PrizeDistributor`. V tem primeru začne gumb *Claim rewards* delovati kot varna ročna pot, saj imajo uporabniki sredstva pripravljena neposredno na notarju.

### Post-Game Settlement
*Before* authorising payouts, the backend can rebalance chip counts using `GameVaultV6.moveBalance` / `moveBalancesBatch` to reflect game results.

## Backend Secrets (Firebase Functions)

Configure these via `firebase functions:secrets:set` (or env vars for the local emulator):

- `RPC_URL`
- `PRIVATE_KEY` (backend signer for admin tasks/payouts)
- `PRIZE_POOL_PK` (trusted depositor that executes `GameVault.withdrawFor`; **required** for automated payouts)
- `FUND_SENDER_PK` (optional legacy fallback signer for vault deposits)
- `GAME_VAULT`
- `GAME_ENTRY`
- `GAME_SERVER`
- `PRIZE_DISTRIBUTOR`
- `ALLOWED_LSP7_TOKEN`
- `LYX_UNIT_MULTIPLIER` → `10000000000000000`
- `LSP7_UNIT_MULTIPLIER` → `1000000000000000000000`
- `ADMIN_TOKEN`
- `ADMIN_OWNER_PK` (required when routing via a Universal Profile Key Manager; configure with your current admin UP private key before running admin endpoints)
- `DEFAULT_RAKE_BPS`, `HOUSE_WALLET`, `DEV_ALLOW_PUBLIC_DEPOSIT` (optional operational knobs)

See [`docs/owner-setup.md`](./docs/owner-setup.md) for the full owner configuration checklist.

```powershell
npm --prefix functions install
$env:RPC_URL="http://127.0.0.1:8545"
$env:PRIVATE_KEY="0x..."               # test key (Hardhat account #0)
$env:GAME_VAULT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"  # from deployments/local.json
$env:GAME_ENTRY="0x0000000000000000000000000000000000000001"   # set to local stub if deployed
$env:GAME_SERVER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
$env:PRIZE_DISTRIBUTOR="0x5FbDB2315678afecb367f032d93F642f64180aa3"
$env:ALLOWED_LSP7_TOKEN="0x..."  # optional
$env:LYX_UNIT_MULTIPLIER="10000000000000000"
$env:LSP7_UNIT_MULTIPLIER="1000000000000000000000"
firebase emulators:start --only functions
```

## Firestore struktura
- `tables/{tableId}`: status, sb, bb, stack, tokenAddress, unitMultiplier …
- `tables/{tableId}/players/{playerId}`: uid, name, address, status (`'seated' | 'leaving' | 'playing'`)

## Frontend API (kratka referenca)
- `createTable`
- `startTable`
- `addPlayerToTable`
- `playerAction`
- `signalLeaveGame`
- `subscribeGameState`

## Deploy Functions

```powershell
firebase login
firebase use poker-4683e
firebase functions:secrets:set RPC_URL
firebase functions:secrets:set PRIVATE_KEY
firebase functions:secrets:set PRIZE_POOL_PK
firebase functions:secrets:set GAME_VAULT
firebase functions:secrets:set GAME_ENTRY
firebase functions:secrets:set GAME_SERVER
firebase functions:secrets:set PRIZE_DISTRIBUTOR
firebase functions:secrets:set ALLOWED_LSP7_TOKEN
firebase functions:secrets:set LYX_UNIT_MULTIPLIER
firebase functions:secrets:set LSP7_UNIT_MULTIPLIER
firebase functions:secrets:set DEFAULT_RAKE_BPS  # 300 recommended
npm run deploy --prefix functions
```

## Admin wiring and on-chain configuration

Use the `adminConfigContracts` HTTPS function (protected by `ADMIN_TOKEN`) for one-time wiring or corrective actions.

What the endpoint sets:
- PrizeDistributor: updates `gameServerAddress` (backend wallet) and authorises GameVault as a payout source.
- GameVault: points `prizeDistributor` to PD, grants trusted depositor rights to **both** GameEntry and the backend wallet, enables WBSTR, and applies the canonical unit multipliers (LYX → 1e16, WBSTR → 1e21).

Key files:
- `functions/index.js` (`adminConfigContracts` handler)
- `scripts/pd-config.mjs`
- `scripts/vault-config.mjs`
- `scripts/owner-check.mjs`

Quick verification:

```powershell
$env:RPC_URL="https://rpc.mainnet.lukso.network"; node .\scripts\pd-status.mjs
```

Expected snippet of output:
- `gameServerAddress`: `0x01a842D1698DA387de50793Fdf56BF09Dc1D7C86`
- `isAuthorizedVault(0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F)`: `true`

Security notes:
- Rotate or remove any temporary owner secrets after wiring.
- Keep the `ADMIN_TOKEN` secret; it protects all admin HTTPS endpoints.

Relevant addresses (mainnet):
- GameEntry: `0x50aF74673Be378f7c5876a28C420F5cf746e1B8a`
- GameVaultV6: `0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F`
- PrizeDistributorV6: `0xB802b0b296D8D26Bf431E861E4a6F4a17Ac9c52D`
- Server wallet (trusted depositor): `0x01a842D1698DA387de50793Fdf56BF09Dc1D7C86`
- WBSTR LSP7: `0xec718d31590e2015837e22a10df96ff466da2a14`

## Admin: set 3% rake for all tables

`adminSetRakeForTables` (Cloud Functions v2) can:
- Apply token-wide rake defaults (LYX = `address(0)`, WBSTR = configured token).
- Batch-set per-table rake + house wallet mapping.

Request payload:
- `houseWallet`: rake recipient.
- `rakeBps`: e.g. `300` for 3%.
- `setDefaults`: `true` to call `setTokenRakeBps`.
- `tokens`: e.g. `["0xec718d31590e2015837e22a10df96ff466da2a14"]`.
- `mapping`: `"parse"` (default) or `"keccak"` for FirestoreID → uint256 conversion.
- `tableIds`: optional subset override.
- `ownerPk`: optional UP KeyManager routing key.

```powershell
$body = @{
  houseWallet = "0xa92444efaBea7D99a4138989BF4B3cA6e8ebFb0e";
  rakeBps     = 300;
  setDefaults = $true;
  tokens      = @("0xec718d31590e2015837e22a10df96ff466da2a14");
  mapping     = "parse";
  # ownerPk   = "0x..."  # only needed when the vault owner is a UP and signer != owner
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://<region>-<project>.cloudfunctions.net/adminSetRakeForTables" -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" } -ContentType 'application/json' -Body $body
```

The response lists each transaction hash. With `setDefaults = true`, expect `setTokenRakeBps` entries for LYX (0x000…000) plus WBSTR, followed by `setTableConfig` operations.

_Operational tip:_ apply token defaults first so newly created tables inherit the correct 3% rake automatically.
