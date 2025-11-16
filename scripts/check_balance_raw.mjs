#!/usr/bin/env node
/**
 * Check vault balance using direct RPC call (no ENS)
 */

import { ethers } from 'ethers';

const RPC_URL = 'https://rpc.mainnet.lukso.network';
const GAME_VAULT = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F'; // CORRECT address with capital F
const WBSTR_TOKEN = '0xec718d31590e2015837e22a10df96ff466da2a14';

function toOnchainTableId(firestoreId) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(firestoreId));
  return BigInt(hash);
}

async function main() {
  const firestoreId = process.argv[2];
  const playerAddress = process.argv[3];

  if (!firestoreId || !playerAddress) {
    console.error('Usage: node check_balance_raw.mjs <firestoreId> <playerAddress>');
    process.exit(1);
  }

  console.log('🔍 Checking vault balance (raw RPC)...');
  console.log('Firestore ID:', firestoreId);
  console.log('Player:', playerAddress);

  // Create provider without ENS support
  const network = new ethers.Network('lukso', 42);
  const provider = new ethers.JsonRpcProvider(RPC_URL, network, { ensAddress: null });
  
  const onchainId = toOnchainTableId(firestoreId);

  console.log('Onchain ID:', onchainId.toString());

  // balanceOf(uint256 tableId, address player, address token)
  const iface = new ethers.Interface([
    'function balanceOf(uint256,address,address) view returns (uint256)'
  ]);

  // Pad addresses to proper format (0x + 40 hex chars, no ENS resolution)
  const paddedPlayer = ethers.zeroPadValue(playerAddress.toLowerCase(), 20);
  const paddedToken = ethers.zeroPadValue(WBSTR_TOKEN.toLowerCase(), 20);
  const paddedVault = ethers.zeroPadValue(GAME_VAULT.toLowerCase(), 20);

  const data = iface.encodeFunctionData('balanceOf', [
    onchainId,
    paddedPlayer,
    paddedToken
  ]);

  const result = await provider.call({
    to: paddedVault,
    data
  });

  const balance = iface.decodeFunctionResult('balanceOf', result)[0];

  console.log('\n💰 Vault Balance (WBSTR):');
  console.log('  Raw:', balance.toString());
  console.log('  Formatted:', ethers.formatUnits(balance, 18), 'WBSTR');

  if (balance > 0n) {
    console.log('\n✅ Player HAS locked funds!');
  } else {
    console.log('\n❌ No locked funds.');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
