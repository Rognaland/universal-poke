#!/usr/bin/env node
// Configure an already-deployed GameVault (setPrizeDistributor, setTrustedDepositor, token flags, units)
// Usage (PowerShell examples):
//   $env:RPC_URL="https://rpc.mainnet.lukso.network";
//   $env:PRIVATE_KEY="0x...";
//   $env:GAME_VAULT="0x...";
//   $env:PRIZE_DISTRIBUTOR="0x...";
//   $env:TRUSTED_DEPOSITOR="0x...";
//   $env:LYX_UNITS="10000000000000000";
//   $env:LSP7_TOKEN="0x..."; $env:LSP7_UNITS="1000000000000000000000";
//   node ./scripts/vault-config.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`${name} env is required`);
  }
  return v;
}

async function main() {
  const RPC_URL = getEnv('RPC_URL', true);
  const PRIVATE_KEY = getEnv('PRIVATE_KEY', true);
  const VAULT_ADDR = getEnv('GAME_VAULT', true);
  const PD_ADDR = getEnv('PRIZE_DISTRIBUTOR', false);
  const TRUSTED_DEPOSITOR = getEnv('TRUSTED_DEPOSITOR', false);
  const LYX_UNITS = getEnv('LYX_UNITS', false);
  const LSP7_TOKEN = getEnv('LSP7_TOKEN', false);
  const LSP7_UNITS = getEnv('LSP7_UNITS', false);
  const HOUSE_WALLET = getEnv('HOUSE_WALLET', false);
  const RAKE_BPS = getEnv('RAKE_BPS', false) || '300';
  const SET_RAKE_DEFAULTS = getEnv('SET_RAKE_DEFAULTS', false); // 'true' to set token-wide defaults
  const TABLE_IDS = getEnv('TABLE_IDS', false); // comma-separated list of tableIds to set config for

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Prefer V3 ABI from artifacts
  const abiPath = resolve(__dirname, '..', 'artifacts', 'contracts', 'GameVaultV3.sol', 'GameVaultV3.json');
  const abi = JSON.parse(readFileSync(abiPath, 'utf8')).abi;
  const vault = new ethers.Contract(VAULT_ADDR, abi, wallet);

  console.log('Network:', (await provider.getNetwork()).chainId);
  console.log('Vault:', VAULT_ADDR);
  console.log('Signer:', await wallet.getAddress());
  if (SET_RAKE_DEFAULTS) console.log('SET_RAKE_DEFAULTS:', SET_RAKE_DEFAULTS);
  if (HOUSE_WALLET) console.log('HOUSE_WALLET:', HOUSE_WALLET);
  if (RAKE_BPS) console.log('RAKE_BPS:', RAKE_BPS);
  if (TABLE_IDS) console.log('TABLE_IDS:', TABLE_IDS);

  // Detect owner + whether to route via UP
  let vaultOwner;
  try { vaultOwner = await vault.owner(); console.log('owner:', vaultOwner); } catch {}
  const needsUP = vaultOwner && (await provider.getCode(vaultOwner)) !== '0x' && (vaultOwner.toLowerCase() !== (await wallet.getAddress()).toLowerCase());

  async function executeViaUP(upAddr, to, data) {
    const UP_ABI = [
      'function execute(uint256 operationType, address to, uint256 value, bytes data) external payable returns (bytes)',
      'function owner() view returns (address)'
    ];
    const KM_ABI = [
      'function execute(bytes calldata payload) external payable returns (bytes)'
    ];
    const up = new ethers.Contract(upAddr, UP_ABI, provider);
    const keyManager = await up.owner();
    console.log('UP KeyManager:', keyManager);
    const km = new ethers.Contract(keyManager, KM_ABI, wallet);
    const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, to, 0, data]);
    const tx = await km.execute(payload);
    console.log('km.execute tx:', tx.hash);
    return tx.wait();
  }

  // Set Prize Distributor
  if (PD_ADDR) {
    console.log('Setting prizeDistributor ->', PD_ADDR);
    const data = vault.interface.encodeFunctionData('setPrizeDistributor', [PD_ADDR]);
    if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
      const tx = await vault.setPrizeDistributor(PD_ADDR);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
  }

  // Set trusted depositor (backend/server wallet)
  if (TRUSTED_DEPOSITOR) {
    console.log('Setting trusted depositor ->', TRUSTED_DEPOSITOR);
    const data = vault.interface.encodeFunctionData('setTrustedDepositor', [TRUSTED_DEPOSITOR, true]);
    if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
      const tx = await vault.setTrustedDepositor(TRUSTED_DEPOSITOR, true);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
  }

  // Units per chip for LYX
  if (LYX_UNITS) {
    console.log('Setting smallestUnitsPerChip(LYX) ->', LYX_UNITS);
    const data = vault.interface.encodeFunctionData('setSmallestUnitsPerChip', [ethers.ZeroAddress, LYX_UNITS]);
    if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
      const tx = await vault.setSmallestUnitsPerChip(ethers.ZeroAddress, LYX_UNITS);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
  }

  // Token allow + units for LSP7
  if (LSP7_TOKEN) {
    console.log('Allowing LSP7 token ->', LSP7_TOKEN);
    const dataAllow = vault.interface.encodeFunctionData('setTokenAllowed', [LSP7_TOKEN, true]);
    if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, dataAllow); } else {
      let tx = await vault.setTokenAllowed(LSP7_TOKEN, true);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
    if (LSP7_UNITS) {
      console.log('Setting smallestUnitsPerChip(LSP7) ->', LSP7_UNITS);
      const dataUnits = vault.interface.encodeFunctionData('setSmallestUnitsPerChip', [LSP7_TOKEN, LSP7_UNITS]);
      if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, dataUnits); } else {
        const tx = await vault.setSmallestUnitsPerChip(LSP7_TOKEN, LSP7_UNITS);
        console.log('tx:', tx.hash);
        await tx.wait();
      }
    }
  }

  // Optional: set global/default rake for tokens (address(0) = LYX), applies when table-specific rake not set
  if (SET_RAKE_DEFAULTS && String(SET_RAKE_DEFAULTS).toLowerCase() === 'true') {
    console.log('Setting default rake bps for LYX ->', RAKE_BPS);
    {
      const data = vault.interface.encodeFunctionData('setTokenRakeBps', [ethers.ZeroAddress, Number(RAKE_BPS)]);
      if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
        const tx = await vault.setTokenRakeBps(ethers.ZeroAddress, Number(RAKE_BPS));
        console.log('tx:', tx.hash);
        await tx.wait();
      }
    }
    if (LSP7_TOKEN) {
      console.log('Setting default rake bps for LSP7 ->', RAKE_BPS);
      const data = vault.interface.encodeFunctionData('setTokenRakeBps', [LSP7_TOKEN, Number(RAKE_BPS)]);
      if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
        const tx = await vault.setTokenRakeBps(LSP7_TOKEN, Number(RAKE_BPS));
        console.log('tx:', tx.hash);
        await tx.wait();
      }
    }
  }

  // Optional: configure specific tables with house wallet + rake
  if (HOUSE_WALLET && TABLE_IDS) {
    const ids = String(TABLE_IDS).split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      console.log(`Setting table config tableId=${id} -> owner=${HOUSE_WALLET}, rakeBps=${RAKE_BPS}`);
      const data = vault.interface.encodeFunctionData('setTableConfig', [Number(id), HOUSE_WALLET, Number(RAKE_BPS)]);
      if (needsUP) { await executeViaUP(vaultOwner, VAULT_ADDR, data); } else {
        const tx = await vault.setTableConfig(Number(id), HOUSE_WALLET, Number(RAKE_BPS));
        console.log('tx:', tx.hash);
        await tx.wait();
      }
    }
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
