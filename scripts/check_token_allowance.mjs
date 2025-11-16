
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- START: Replicated getCfg logic ---
// This logic is copied from functions/index.js to ensure the script sees the exact same configuration.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCfg() {
    const s = (v) => (v === undefined || v === null) ? v : String(v).trim();
    const lower = (a) => { const v = s(a); return v ? v.toLowerCase() : v; };

    const cfg = {
        rpcUrl: process.env.RPC_URL,
        gameVault: process.env.GAME_VAULT,
        allowedLsp7: lower(process.env.ALLOWED_LSP7_TOKEN || ''),
    };

    try {
        const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
        const isTestnet = process.env.TESTNET === 'true' || process.env.TESTNET === '1' || isEmulator;

        if (isTestnet) {
            console.log('[getCfg] 🧪 TESTNET MODE ENABLED - Using testnet deployment addresses');
        }

        const testnetPath = path.resolve(__dirname, '..', 'frontend', 'public', 'deployments', 'testnet.json');
        const prodPath = path.resolve(__dirname, '..', 'frontend', 'public', 'deployments', 'prod.json');
        const localPath = path.resolve(__dirname, '..', 'deployments', 'local.json');
        
        const loadConfig = (filePath) => {
            if (fs.existsSync(filePath)) {
                try {
                    const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || null;
                    cfg.gameVault = cfg.gameVault || d.gameVault || null;
                    cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                    console.log(`[getCfg] ✅ Loaded config from ${filePath}`);
                } catch (e) {
                    console.warn(`[getCfg] ⚠️ Failed to parse ${filePath}:`, e.message);
                }
            }
        };

        if (isTestnet) {
            loadConfig(testnetPath);
        } else {
            loadConfig(prodPath);
        }
        
        if (!cfg.gameVault) {
            loadConfig(localPath);
        }

    } catch (e) {
        console.error('Error reading deployment files:', e.message);
    }
    
    return cfg;
}

// --- END: Replicated getCfg logic ---


// --- START: Replicated loadVaultAbi logic ---
function loadVaultAbi() {
    const abiPath = path.resolve(__dirname, '..', 'artifacts/contracts/GameVaultV6.sol/GameVaultV6.json');
    console.log(`DEBUG: Attempting to load ABI from: ${abiPath}`);
    try {
        const artV6 = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        return artV6.abi;
    } catch (e) {
        console.log("DEBUG: Failed to load GameVaultV6 ABI:", e.message); // Changed to console.log
        return null;
    }
}
// --- END: Replicated loadVaultAbi logic ---


async function main() {
    console.log('--- Running Token Allowance Verification Script ---');

    const cfg = getCfg();

    if (!cfg.rpcUrl) {
        console.error('❌ RPC_URL not found in config. Please set RPC_URL environment variable or add it to your deployment.json.');
        return;
    }
    if (!cfg.gameVault) {
        console.error('❌ GAME_VAULT address not found in config. Please set GAME_VAULT environment variable or add it to your deployment.json.');
        return;
    }
    if (!cfg.allowedLsp7) {
        console.error('❌ ALLOWED_LSP7_TOKEN address not found in config. This is likely the root cause.');
        console.log('The backend code does not know which LSP7 token to use for rewards.');
        return;
    }

    console.log(`\n1. Configuration loaded by the backend:`);
    console.log(`   - RPC URL: ${cfg.rpcUrl}`);
    console.log(`   - GameVault Address: ${cfg.gameVault}`);
    console.log(`   - Allowed LSP7 Token: ${cfg.allowedLsp7}`);

    console.log('DEBUG: ABI loading starts...');
    const vaultAbi = loadVaultAbi();
    if (!vaultAbi) {
        console.error('DEBUG: ABI not loaded, exiting.');
        return;
    }
    console.log('DEBUG: ABI loaded successfully.');

    try {
        console.log('DEBUG: Provider initialization starts...');
        const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
        const vaultContract = new ethers.Contract(cfg.gameVault, vaultAbi, provider);
        console.log('DEBUG: Provider and contract initialized.');

        console.log(`\n2. Checking on-chain status...`);
        console.log(`   - Calling 'isTokenAllowed' on contract ${cfg.gameVault}`);
        console.log(`   - With token address: ${cfg.allowedLsp7}`);

        const isAllowed = await vaultContract.isTokenAllowed(cfg.allowedLsp7);

        console.log(`\n--- RESULT ---`);
        if (isAllowed) {
            console.log(`✅ SUCCESS: The token ${cfg.allowedLsp7} IS correctly marked as allowed on the GameVault contract.`);
            console.log(`This means the problem is likely not 'isTokenAllowed', but something else.`);
        } else {
            console.log(`❌ FAILURE: The token ${cfg.allowedLsp7} IS NOT marked as allowed on the GameVault contract.`);
            console.log(`This confirms the error from the logs. The backend is configured with a token that the contract does not allow.`);
            console.log(`\n   ACTION: Please call 'setTokenAllowed(true)' for this token address on the GameVaultV6 contract.`);
        }
        console.log(`--------------\n`);

    } catch (error) {
        console.error('\n--- SCRIPT ERROR ---');
        console.error('An error occurred while checking the contract:', error.message);
        console.error('--------------------\n');
    }
}

main().catch(console.error);
