import { ethers } from 'ethers';
import fs from 'fs';

async function main() {
    // Configuration
    const vaultAddress = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F';
    const serverWallet = '0x01a842D1698DA387de50793Fdf56BF09Dc1D7C86';
    const rpcUrl = 'https://rpc.mainnet.lukso.network';
    
    // Load owner private key from environment or Firebase secret
    // Get via: firebase functions:secrets:access ADMIN_OWNER_PK
    const ownerPk = process.env.ADMIN_OWNER_PK || '0x978c748cb2941091eb3f851585be6572227a122c9a7c1e0c9cc167a8925d5094';
    
    // Setup provider and signer
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const owner = new ethers.Wallet(ownerPk, provider);
    
    console.log('Owner address:', owner.address);
    console.log('Server wallet to add:', serverWallet);
    console.log('GameVault address:', vaultAddress);
    
    // Minimal ABI for trustedDepositor functions
    const minimalAbi = [
        "function trustedDepositor(address) view returns (bool)",
        "function setTrustedDepositor(address depositor, bool isTrusted) external"
    ];
    const vault = new ethers.Contract(vaultAddress, minimalAbi, owner);
    
    // Check if already trusted
    const isTrusted = await vault.trustedDepositor(serverWallet);
    console.log(`\nServer wallet is currently trusted: ${isTrusted}`);
    
    if (!isTrusted) {
        console.log('\n🔧 Adding server wallet as trusted depositor...');
        const tx = await vault.setTrustedDepositor(serverWallet, true);
        console.log('Transaction sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('✅ Transaction confirmed!');
        console.log('Gas used:', receipt.gasUsed.toString());
    } else {
        console.log('\n✅ Server wallet is already a trusted depositor!');
    }
}

main().catch(console.error);
