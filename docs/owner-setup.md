# Contract Owner Setup

The Poker platform contracts on LUKSO mainnet are owned by the Universal Profile at
`0x6C87a8c057A2Bb30ae49672848FD0EC94A57fc85`. This profile must sign every
on-chain admin action (configuring the prize distributor, vault, rake, etc.).

To ensure both the backend Cloud Functions and local tooling can act as the
owner without unexpected prompts, store the owner private key securely and
expose it only through managed secrets.

> **Owner private key:** `0x978c748cb2941091eb3f851585be6572227a122c9a7c1e0c9cc167a8925d5094`
>
> Keep this key in secrets only. Rotate it immediately if it is ever shared or
> checked into version control by accident.

## 1. Configure Firebase Functions secrets

```powershell
firebase functions:secrets:set ADMIN_OWNER_PK
```

Paste the private key above when prompted. After setting the secret, redeploy
functions so the new value is available:

```powershell
npm run deploy --prefix functions
```

> **Tip:** If PowerShell reports `firebase` is not recognized, add the npm
> global bin directory to your PATH for the current session:
> ```powershell
> $env:PATH = "$env:PATH;C:\Users\$env:USERNAME\AppData\Roaming\npm"
> firebase --version
> ```
> You can add the same path to your user environment variables for a permanent
> fix.

## 2. Local development

When running functions or scripts locally, export the same key before starting
any tooling:

```powershell
$env:ADMIN_OWNER_PK="0x978c748cb2941091eb3f851585be6572227a122c9a7c1e0c9cc167a8925d5094"
```

Alternatively, create a local `.env.local` (excluded from git) with:

```
ADMIN_OWNER_PK=0x978c748cb2941091eb3f851585be6572227a122c9a7c1e0c9cc167a8925d5094
```

and source it before running scripts.

## 3. Verification checklist

1. Call the `adminConfigContracts` HTTPS endpoint with `ADMIN_TOKEN`. The JSON
   response should include your owner address as `expectedOwner`, and
   `signer` must match `0x6C87...fc85`.
2. Trigger a rake configuration call (`adminSetRakeForTables` or the Firestore
   hook). Logs should **not** show a warning about mismatched owners.
3. Run a WBSTR `authorizeOperator` + deposit flow from the frontend. The
   extension should prompt exactly twice (authorize + deposit) and succeed.

If any warning about mismatched owners appears, double-check that
`ADMIN_OWNER_PK` is set everywhere and redeploy the functions.

## 4. Operational notes

- Never commit the private key to the repository.
- Rotate the key after any shared debugging session.
- If ownership of the contracts moves to another profile, update
  `frontend/public/deployments/prod.json` (`owner` field) and repeat the steps
  above for the new key.

## 5. Universal Profile permissions for WBSTR

If the LUKSO extension rejects the `authorizeOperator` call (the app will show a
message that the Universal Profile denied the transaction), ensure the
controller you're using has permission to call the WBSTR token. The frontend
does not adjust permissions automatically.

1. Open the LUKSO browser extension, choose your Universal Profile, and click
   **Manage controllers**.
2. Select the active controller (the account you use to sign transactions) and
   enable **CALL** permission.
3. In **Allowed Calls**, add WBSTR `authorizeOperator` if it is missing:
   - Target contract: `0xec718D31590E2015837e22a10Df96fF466DA2A14`
   - Function selector: `authorizeOperator(address,uint256)` (or choose “All” to
     allow every function for this token).
4. Save the changes, approve pending signature requests, and retry the deposit
   flow.
