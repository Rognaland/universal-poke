# Quick local runner for the full stack (PowerShell)
# Usage: run from repo root: .\scripts\run-local.ps1

param()

Write-Host "Starting local stack (build + run) with recommended test env..."

# Ensure environment variables for this session
$env:FUND_SENDER_PK = $env:FUND_SENDER_PK -or "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
$env:PRIVATE_KEY = $env:PRIVATE_KEY -or "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# Bring up the stack
docker compose up --build
