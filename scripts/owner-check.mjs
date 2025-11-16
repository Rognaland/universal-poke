#!/usr/bin/env node
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

async function isContract(provider, address) {
  try {
    const code = await provider.getCode(address);
    return code && code !== '0x';
  } catch {
    return false;
  }
}

async function main() {
  const RPC_URL = getEnv('RPC_URL', true);
  const PD_ADDR = getEnv('PRIZE_DISTRIBUTOR', false);
  const VAULT_ADDR = getEnv('GAME_VAULT', false);
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  console.log('Network:', (await provider.getNetwork()).chainId);

  if (PD_ADDR) {
    const pdAbi = JSON.parse(readFileSync(resolve(__dirname, '..', 'frontend', 'src', 'PrizeDistributorV3.json'), 'utf8')).abi;
    const pd = new ethers.Contract(PD_ADDR, pdAbi, provider);
    try {
      const owner = await pd.owner();
      console.log('PD.owner:', owner, 'contract:', await isContract(provider, owner));
    } catch (e) {
      console.log('PD.owner read failed:', e.message);
    }
  }

  if (VAULT_ADDR) {
    const vaultAbi = JSON.parse(readFileSync(resolve(__dirname, '..', 'artifacts', 'contracts', 'GameVaultV3.sol', 'GameVaultV3.json'), 'utf8')).abi;
    const vault = new ethers.Contract(VAULT_ADDR, vaultAbi, provider);
    try {
      const owner = await vault.owner();
      console.log('Vault.owner:', owner, 'contract:', await isContract(provider, owner));
    } catch (e) {
      console.log('Vault.owner read failed:', e.message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
