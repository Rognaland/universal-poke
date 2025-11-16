Run the CI (E2E) workflow locally or in GitHub Actions

What the workflow does
- Builds docker images and runs the `runner` service which executes deploy + E2E tests.
- Collects `docker-compose` logs and `deployments/local.json` into `artifacts/` and uploads as a workflow artifact.

Run locally (developer machine with Docker):
```powershell
# build & run the runner (same as CI)
docker compose up --exit-code-from runner --build
```

Artifacts produced
- `artifacts/docker-compose.log` — collected compose logs
- `artifacts/runner.log` — runner container logs (if available)
- `artifacts/local-deploy.json` — `deployments/local.json` copied if present

Notes
- Secrets/private keys should be configured as GitHub Secrets for CI (do NOT commit them into the repo).
- The workflow expects Docker Compose v2 on the runner.

Required GitHub Secrets for `ci-e2e-secrets.yml`:
- `PRIVATE_KEY` — the server/private key used by functions to sign payout transactions (keep small balance in prod wallet)
- `PRIZE_DISTRIBUTOR` — deployed PrizeDistributor contract address for the environment
- `FUND_SENDER_PK` — (optional) key used by the fund-wallet service to top up the functions wallet in CI/local runs
- `DEBUG_TOKEN` — a secret token used if you ever enable ALLOW_DEBUG=true for test runs (keep unset in prod)
- `ALLOW_DEBUG` — optional; set to `false` in production. If true, the `DEBUG_TOKEN` header must be supplied to debug endpoints.
