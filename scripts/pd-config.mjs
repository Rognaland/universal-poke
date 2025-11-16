#!/usr/bin/env node
// Configure an already-deployed PrizeDistributor (setGameServer, setAuthorizedVault)
// Usage (PowerShell):
//   $env:RPC_URL="https://rpc.lukso.network"; $env:PRIVATE_KEY="0x..."; \
//   $env:PRIZE_DISTRIBUTOR="0x..."; $env:GAME_SERVER="0x..."; $env:VAULT="0x..."; \
//   node ./scripts/pd-config.mjs

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
  const PD_ADDR = getEnv('PRIZE_DISTRIBUTOR', true);
  const GAME_SERVER = getEnv('GAME_SERVER', false);
  const VAULT = getEnv('VAULT', false);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Load ABI from frontend artifact (has all functions)
  const abiPath = resolve(__dirname, '..', 'frontend', 'src', 'PrizeDistributorV3.json');
  const abi = JSON.parse(readFileSync(abiPath, 'utf8')).abi;
  const pd = new ethers.Contract(PD_ADDR, abi, wallet);

  console.log('Network:', (await provider.getNetwork()).chainId);
  console.log('PD:', PD_ADDR);
  console.log('Signer:', await wallet.getAddress());

  // Show current values
  try {
    const gs = await pd.gameServerAddress();
    console.log('gameServerAddress(current):', gs);
  } catch {}
  try {
    const owner = await pd.owner();
    console.log('owner:', owner);
  } catch {}
  try {
    if (VAULT) {
      const ok = await pd.isAuthorizedVault(VAULT);
      console.log('isAuthorizedVault(current):', ok);
    }
  } catch {}

  // Helper: execute via Universal Profile + KeyManager if PD owner is a contract
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

  // Determine if we must route via UP
  let pdOwner;
  try { pdOwner = await pd.owner(); } catch {}
  const needsUP = pdOwner && (await provider.getCode(pdOwner)) !== '0x' && (pdOwner.toLowerCase() !== (await wallet.getAddress()).toLowerCase());

  // Apply config
  if (GAME_SERVER) {
    console.log('Setting gameServerAddress ->', GAME_SERVER);
    const data = pd.interface.encodeFunctionData('setGameServer', [GAME_SERVER]);
    if (needsUP) {
      await executeViaUP(pdOwner, PD_ADDR, data);
    } else {
      const tx = await pd.setGameServer(GAME_SERVER);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
  }
  if (VAULT) {
    console.log('Authorizing vault ->', VAULT);
    const data = pd.interface.encodeFunctionData('setAuthorizedVault', [VAULT, true]);
    if (needsUP) {
      await executeViaUP(pdOwner, PD_ADDR, data);
    } else {
      const tx = await pd.setAuthorizedVault(VAULT, true);
      console.log('tx:', tx.hash);
      await tx.wait();
    }
    const ok = await pd.isAuthorizedVault(VAULT);
    console.log('isAuthorizedVault:', ok);
  }

  // Show balances
  try {
    const lyx = await provider.getBalance(PD_ADDR);
    console.log('PD LYX balance:', ethers.formatEther(lyx));
  } catch {}

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
