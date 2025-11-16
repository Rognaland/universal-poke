const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');

async function main() {
  const vaultAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/GameVaultV6.sol/GameVaultV6.json', 'utf8')).abi;
  const provider = new ethers.JsonRpcProvider('https://rpc.testnet.lukso.network');
  const vault = new ethers.Contract('0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F', vaultAbi, provider);
  
  const tableId = 'wxEMBpL2E0jPnSxpLRt5';
  const player = '0xB25CE199DeB849E593D335D2e30A293D1d695821';
  const token = '0xec718d31590e2015837e22a10df96ff466da2a14';
  
  const hash = crypto.createHash('sha256').update(tableId).digest();
  const onchainTableId = BigInt('0x' + hash.slice(0, 8).toString('hex'));
  
  console.log('Table:', tableId, '-> onchain:', onchainTableId.toString());
  console.log('Player:', player);
  console.log('Token:', token);
  
  const bal = await vault.balanceOf(onchainTableId, player, token);
  console.log('\nBalance in vault:', bal.toString(), 'units');
  console.log('Balance in chips:', (Number(bal) / 1e21).toFixed(2));
}

main().catch(console.error);
