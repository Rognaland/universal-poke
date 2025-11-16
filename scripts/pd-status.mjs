#!/usr/bin/env node
import { ethers } from 'ethers';

function env(name, required=false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) throw new Error(`${name} env required`);
  return v;
}

const ABI = [
  'function gameServerAddress() view returns (address)',
  'function isAuthorizedVault(address) view returns (bool)',
  'function authorizedPayouts(address,address) view returns (uint256)'
];

async function main() {
  const RPC_URL = env('RPC_URL', true);
  const PD = env('PRIZE_DISTRIBUTOR', true);
  const VAULT = env('VAULT', false);
  const TOKEN = env('TOKEN', false) || ethers.ZeroAddress;
  const WINNER = env('WINNER', false);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pd = new ethers.Contract(PD, ABI, provider);

  const net = await provider.getNetwork();
  console.log('Network chainId:', net.chainId);
  console.log('PrizeDistributor:', PD);

  const gs = await pd.gameServerAddress();
  console.log('gameServerAddress:', gs);

  if (VAULT) {
    const ok = await pd.isAuthorizedVault(VAULT);
    console.log(`isAuthorizedVault(${VAULT}):`, ok);
  }

  const lyx = await provider.getBalance(PD);
  console.log('PD LYX balance:', ethers.formatEther(lyx));

  if (WINNER) {
    const amt = await pd.authorizedPayouts(TOKEN, WINNER);
    console.log(`authorizedPayouts[${TOKEN}][${WINNER}] =`, amt.toString());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
