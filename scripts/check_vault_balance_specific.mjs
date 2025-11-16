#!/usr/bin/env node
/**
 * Check vault balance for specific table and player
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.lukso.network'; // Production!
const GAME_VAULT = '0x44e8a50fbfcaeaddb0b6952dcc00edb90f1f94f'; // Production vault
const WBSTR_TOKEN = '0xec718d31590e2015837e22a10df96ff466da2a14'; // Production token

const VAULT_ABI = [
  'function balanceOf(uint256 tableId, address player, address token) view returns (uint256)',
  'function toTableId(string memory firestoreId) pure returns (uint256)'
];

// Helper to convert Firestore ID to onchain ID
function toOnchainTableId(firestoreId) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(firestoreId));
  return BigInt(hash);
}

async function main() {
  const firestoreId = process.argv[2];
  const playerAddress = process.argv[3];

  if (!firestoreId || !playerAddress) {
    console.error('Usage: node check_vault_balance_specific.mjs <firestoreId> <playerAddress>');
    console.error('Example: node check_vault_balance_specific.mjs IeEggfNQMy3L5d8hDsgf 0xYourAddress');
    process.exit(1);
  }

  console.log('🔍 Checking vault balance...');
  console.log('Firestore ID:', firestoreId);
  console.log('Player:', playerAddress);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const onchainId = toOnchainTableId(firestoreId);
  console.log('Onchain ID:', onchainId.toString());
  console.log('Onchain ID (hex):', '0x' + onchainId.toString(16));

  // Normalize addresses to lowercase (avoid ENS and checksum issues)
  const normalizedPlayer = playerAddress.toLowerCase();
  const normalizedVault = GAME_VAULT.toLowerCase();
  const normalizedToken = WBSTR_TOKEN.toLowerCase();

  // Create contract with normalized address
  const vaultContract = new ethers.Contract(normalizedVault, VAULT_ABI, provider);

  // Check balance for WBSTR
  const balance = await vaultContract.balanceOf(onchainId, normalizedPlayer, normalizedToken);
  console.log('\n💰 Vault Balance (WBSTR):');
  console.log('  Raw:', balance.toString());
  console.log('  Formatted:', ethers.formatUnits(balance, 18), 'WBSTR');

  if (balance > 0n) {
    console.log('\n✅ Player HAS locked funds in vault!');
  } else {
    console.log('\n❌ No locked funds found.');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
