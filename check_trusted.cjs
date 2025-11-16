const ethers = require('ethers');
const fs = require('fs');

async function main() {
    const provider = new ethers.JsonRpcProvider('https://rpc.mainnet.lukso.network');
    const vaultAddr = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F';
    const prizePoolAddr = '0x9171dfe4D926BAec07e9289F4b011d93F3AE2318';
    
    const artifact = JSON.parse(fs.readFileSync('./artifacts/contracts/GameVaultV6.sol/GameVaultV6.json', 'utf8'));
    const abi = artifact.abi;
    
    const vault = new ethers.Contract(vaultAddr, abi, provider);
    
    try {
        const isTrusted = await vault.trustedDepositors(prizePoolAddr);
        console.log('Prize Pool Address:', prizePoolAddr);
        console.log('Is trusted depositor:', isTrusted);
    } catch (err) {
        console.error('Error checking trusted depositor:', err.message);
    }
}

main();
