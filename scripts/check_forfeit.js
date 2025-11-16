#!/usr/bin/env node
/*
Helper script to validate a forfeit/confiscation or payout flow.

Usage (PowerShell):
  $env:GOOGLE_APPLICATION_CREDENTIALS='C:\path\to\service-account.json'  # optional, for Firestore reads
  node .\scripts\check_forfeit.js --rpc https://rpc.testnet.lukso.network --table 123 --player 0xabc... --house 0xhouse...

Options:
  --rpc     RPC URL (required)
  --table   local tableId (optional, used to filter payouts)
  --player  player address (optional)
  --house   house wallet address (optional)
  --limit   number of payout records to show (default 10)
  --explorer  optional tx explorer prefix (e.g. https://explorer.testnet.lukso.network/tx/)

Notes:
- If GOOGLE_APPLICATION_CREDENTIALS is set and firebase-admin is installed, the script will query Firestore `payouts`.
- Otherwise the script will still do on-chain checks (receipts, balances) using the RPC only.
*/

const { ethers } = require('ethers');
const minimist = require('minimist');
let admin = null;
try {
    admin = require('firebase-admin');
} catch (e) {
    // firebase-admin optional
}

const argv = minimist(process.argv.slice(2));
const rpc = argv.rpc || process.env.RPC_URL;
const tableId = argv.table || argv.t || null;
const player = argv.player || argv.p || null;
const house = argv.house || argv.h || null;
const limit = Number(argv.limit || 10);
const explorer = argv.explorer || null;

if (!rpc) {
    console.error('RPC URL is required. Use --rpc <url>');
    process.exit(2);
}

function deriveOnchainTableId(raw) {
    if (raw === undefined || raw === null) return null;
    try {
        if (String(raw).startsWith('0x')) return BigInt(raw);
        if (/^\d+$/.test(String(raw))) return BigInt(String(raw));
    } catch (_) {}
    try {
        const hex = ethers.keccak256(ethers.toUtf8Bytes(String(raw)));
        return BigInt(hex);
    } catch (_) {
        return null;
    }
}

(async function main(){
    const provider = new ethers.JsonRpcProvider(rpc);
    console.log('Connected to RPC:', rpc);

    // Optional: Firestore
    let db = null;
    if (admin && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        try {
            admin.initializeApp();
            db = admin.firestore();
            console.log('Firestore available via firebase-admin');
        } catch (e) {
            console.warn('Failed to init firebase-admin:', e.message || e);
            db = null;
        }
    } else if (admin) {
        console.log('firebase-admin present but GOOGLE_APPLICATION_CREDENTIALS not set: skipping Firestore');
    } else {
        console.log('firebase-admin not installed: skipping Firestore');
    }

    if (db) {
        try {
            const q = db.collection('payouts');
            let query = q.orderBy('createdAt', 'desc');
            if (tableId) query = q.where('tableId','==',String(tableId)).orderBy('createdAt','desc');
            else if (player) query = q.where('player','==',String(player).toLowerCase()).orderBy('createdAt','desc');
            const snap = await query.limit(limit).get();
            if (snap.empty) {
                console.log('No payouts found for given filters in Firestore.');
            } else {
                console.log(`Found ${snap.docs.length} payout records:`);
                for (const d of snap.docs) {
                    const data = d.data();
                    console.log('---');
                    console.log('docId:', d.id);
                    console.log('type:', data.type);
                    console.log('tableId:', data.tableId);
                    console.log('player:', data.player);
                    console.log('house:', data.house);
                    console.log('token:', data.token);
                    console.log('amount:', data.amount || data.totalAmount || null);
                    console.log('txHash:', data.txHash || data.txHash || null);
                    console.log('status:', data.status || null);
                    console.log('createdAt:', data.createdAt ? data.createdAt.toDate() : null);
                }
            }
        } catch (e) {
            console.warn('Error querying payouts:', e.message || e);
        }
    }

    // On-chain checks: if payouts found via Firestore show txs -> fetch receipts
    // Also check Vault balances for player & house if we can find gameVault ABI/artifact

    // Try to load GameVault ABI from artifacts (repo relative path)
    let vaultAbi = null;
    try {
        // prefer artifacts in repo root
        vaultAbi = require('../artifacts/contracts/GameVaultV6.sol/GameVaultV6.json');
        if (vaultAbi && vaultAbi.abi) vaultAbi = vaultAbi.abi;
    } catch (_) {
        try {
            vaultAbi = require('./artifacts/contracts/GameVaultV6.sol/GameVaultV6.json');
            if (vaultAbi && vaultAbi.abi) vaultAbi = vaultAbi.abi;
        } catch (_) {
            vaultAbi = null;
        }
    }

    // Minimal vault ABI we need
    const MIN_VAULT_ABI = [
        'function balanceOf(uint256 tableId, address account, address token) view returns (uint256)'
    ];

    const finalVaultAbi = vaultAbi && Array.isArray(vaultAbi) ? vaultAbi : MIN_VAULT_ABI;

    // If tableId present and either player or house provided, attempt to call balanceOf
    if (tableId && (player || house)) {
        // need gameVault address - try to read from functions deployments file
        let gameVaultAddr = null;
        try {
            // read the functions deployments/testnet.json if exists
            const deploy = require('../functions/deployments/local.json');
            gameVaultAddr = deploy && deploy.gameVault ? deploy.gameVault : null;
        } catch (_) {}
        try {
            const fpub = require('../frontend/public/deployments/testnet.json');
            if (!gameVaultAddr && fpub && fpub.gameVault) gameVaultAddr = fpub.gameVault;
        } catch (_) {}
        if (!gameVaultAddr) {
            console.log('GameVault address not discovered in repo deployments; please provide GAME_VAULT or check deployments. Skipping balanceOf calls.');
        } else {
            try {
                const vault = new ethers.Contract(gameVaultAddr, finalVaultAbi, provider);
                const onchainTableId = deriveOnchainTableId(tableId);
                console.log('Using GameVault at', gameVaultAddr, 'onchain table id', String(onchainTableId));
                if (player) {
                    try {
                        const bal = await vault.balanceOf(Number(onchainTableId), String(player).toLowerCase(), ethers.ZeroAddress);
                        console.log(`Vault balanceOf(player ${player}):`, bal.toString());
                    } catch (e) { console.warn('vault.balanceOf(player) failed:', e.message || e); }
                }
                if (house) {
                    try {
                        const balh = await vault.balanceOf(Number(onchainTableId), String(house).toLowerCase(), ethers.ZeroAddress);
                        console.log(`Vault balanceOf(house ${house}):`, balh.toString());
                    } catch (e) { console.warn('vault.balanceOf(house) failed:', e.message || e); }
                }
            } catch (e) {
                console.warn('Error creating vault contract:', e.message || e);
            }
        }
    }

    // If Firestore showed tx hashes, we would fetch receipts — but we also allow manual txHash via --tx
    const txFromArg = argv.tx || argv.txHash || null;
    const txHashes = [];
    if (txFromArg) txHashes.push(txFromArg);

    // Optionally, attempt to find recent txs in payouts collection if db available
    if (db && (tableId || player)) {
        try {
            const q = db.collection('payouts');
            let query = q.orderBy('createdAt','desc');
            if (tableId) query = q.where('tableId','==',String(tableId)).orderBy('createdAt','desc');
            else query = q.where('player','==',String(player).toLowerCase()).orderBy('createdAt','desc');
            const snap = await query.limit(limit).get();
            for (const d of snap.docs) {
                const data = d.data();
                if (data && data.txHash) txHashes.push(data.txHash);
            }
        } catch (e) { /* ignore */ }
    }

    if (txHashes.length === 0) {
        console.log('No tx hashes discovered to inspect. Provide --tx <hash> or ensure Firestore payouts has txHash entries.');
    } else {
        console.log('Inspecting txs:', txHashes);
        for (const th of txHashes) {
            try {
                const rc = await provider.getTransactionReceipt(th);
                console.log('---');
                console.log('tx:', th);
                if (explorer) console.log('explorer:', `${explorer}${th}`);
                if (!rc) { console.log('Transaction receipt not found (maybe pending).'); continue; }
                console.log('status:', rc.status);
                console.log('blockNumber:', rc.blockNumber);
                console.log('gasUsed:', rc.gasUsed ? rc.gasUsed.toString() : null);
                console.log('logs:', rc.logs ? rc.logs.length : 0);
            } catch (e) {
                console.warn('Failed to fetch receipt for', th, e.message || e);
            }
        }
    }

    // House wallet chain balance
    if (house) {
        try {
            const bal = await provider.getBalance(house);
            console.log(`House wallet ${house} chain balance: ${ethers.formatEther(bal)} LYX (raw: ${bal.toString()})`);
        } catch (e) { console.warn('provider.getBalance(house) failed:', e.message || e); }
    }

    console.log('\nDone.');
    process.exit(0);
})();
