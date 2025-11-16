import { ethers } from 'ethers';

async function main() {
    const vaultAddress = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F';
    const player = '0xb25ce199deb849e593d335d2e30a293d1d695821'; // From log
    const token = '0xec718d31590e2015837e22a10df96ff466da2a14'; // WBSTR
    const tableId = 'ELllbwzoeBAa9YEScWw0';
    const rpcUrl = 'https://rpc.mainnet.lukso.network';
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Minimal ABI
    const abi = [
        "function balanceOf(uint256 tableId, address player, address token) external view returns (uint256)"
    ];
    const vault = new ethers.Contract(vaultAddress, abi, provider);
    
    // Derive onchain tableId using same logic as backend
    const hex = ethers.keccak256(ethers.toUtf8Bytes(tableId));
    const onchainTableId = ethers.toBigInt(hex);
    console.log('Firestore tableId:', tableId);
    console.log('Onchain tableId (hex):', hex);
    console.log('Onchain tableId (decimal):', onchainTableId.toString());
    
    // Check balance using correct function signature
    const balance = await vault.balanceOf(onchainTableId, player, token);
    console.log('\nPlayer:', player);
    console.log('Token:', token);
    console.log('Balance in GameVault:', ethers.formatUnits(balance, 18), 'WBSTR');
    console.log('Balance in units:', balance.toString());
}

main().catch(console.error);
