const admin = require("firebase-admin");
// Robust loader for firebase-functions v2 APIs across versions/environments
let onDocumentUpdated, onDocumentDeleted, onDocumentCreated, onSchedule, defineSecret;
try {
    const ff = require('firebase-functions');
    if (ff && ff.v2 && ff.v2.firestore) {
        onDocumentUpdated = ff.v2.firestore.onDocumentUpdated;
        onDocumentDeleted = ff.v2.firestore.onDocumentDeleted;
        onDocumentCreated = ff.v2.firestore.onDocumentCreated;
        onSchedule = ff.v2.scheduler && ff.v2.scheduler.onSchedule ? ff.v2.scheduler.onSchedule : null;
        defineSecret = require('firebase-functions/params').defineSecret;
    } else {
        // Try explicit v2 entrypoints
        const ffFirestore = require('firebase-functions/v2/firestore');
        const ffScheduler = require('firebase-functions/v2/scheduler');
        onDocumentUpdated = ffFirestore.onDocumentUpdated;
        onDocumentDeleted = ffFirestore.onDocumentDeleted;
        onDocumentCreated = ffFirestore.onDocumentCreated;
        onSchedule = ffScheduler.onSchedule;
        defineSecret = require('firebase-functions/params').defineSecret;
    }
} catch (e) {
    // Last-resort fallbacks (emulator/local): provide simple stubs so file can load.
    console.warn('firebase-functions v2 APIs not available, using local fallbacks:', e && e.message);
    // Minimal no-op defineSecret that reads from env for emulator runs
    defineSecret = (name) => ({ value: () => process.env[name] || undefined });
    // Emulate v2 firestore triggers using v1 style if possible
    try {
        const ff = require('firebase-functions');
        if (ff && ff.firestore) {
            onDocumentUpdated = ff.firestore.onUpdate || null;
            onDocumentDeleted = ff.firestore.onDelete || null;
            onDocumentCreated = ff.firestore.onCreate || null;
        }
        // scheduler fallback: use pubsub schedule if available
        onSchedule = ff && ff.pubsub && ff.pubsub.schedule ? (cron => ({ onRun: ff.pubsub.schedule(cron) })) : null;
    } catch (e2) {
        // nothing else to do
        onDocumentUpdated = null;
        onDocumentDeleted = null;
        onSchedule = null;
    }
}
const get = require("lodash.get");
const isEqual = require("lodash.isequal");
const { Hand } = require("pokersolver");
const { ethers } = require("ethers");
const MAX_AUTO_WITHDRAW_ATTEMPTS = 2;
// Lazy loader for GameVault ABI/artifact. If artifacts are not yet present (deploy hasn't run),
// this prevents the module from throwing at import time. Call loadVaultAbi() where ABI is needed.
function loadVaultAbi() {
    const extractAbi = (candidate) => {
        if (!candidate) return null;
        if (Array.isArray(candidate)) return candidate;
        if (Array.isArray(candidate?.abi)) return candidate.abi;
        if (Array.isArray(candidate?.default)) return candidate.default;
        if (candidate?.default && Array.isArray(candidate.default.abi)) return candidate.default.abi;
        return null;
    };
    try {
        // First check if artifacts are bundled within the functions directory (for Firebase deploys)
        try {
            const bundledV6 = require('./artifacts/contracts/GameVaultV6.sol/GameVaultV6.json');
            const abi = extractAbi(bundledV6);
            if (abi && abi.length) return abi;
        } catch (_) {}
        // Prefer newest artifact (V6)
        try {
            const artV6 = require('../artifacts/contracts/GameVaultV6.sol/GameVaultV6.json');
            const abi = extractAbi(artV6);
            if (abi && abi.length) return abi;
        } catch (_) {}
        // Fallback to V3 artifact if present
        try {
            const bundledV3 = require('./artifacts/contracts/GameVaultV3.sol/GameVaultV3.json');
            const abi = extractAbi(bundledV3);
            if (abi && abi.length) return abi;
        } catch (_) {}
        try {
            const artV3 = require('../artifacts/contracts/GameVaultV3.sol/GameVaultV3.json');
            const abi = extractAbi(artV3);
            if (abi && abi.length) return abi;
        } catch (_) {}
        // Fallback to legacy path if present
        try {
            const art = require('../artifacts/contracts/GameVault.sol/GameVault.json');
            const abi = extractAbi(art);
            if (abi && abi.length) return abi;
        } catch (_) {}
    } catch (e) {
        // Artifact not available yet
        return null;
    }
}

function toMillis(ts) {
    if (!ts) return null;
    try {
        if (typeof ts.toMillis === 'function') return ts.toMillis();
    } catch (_) {}
    if (ts instanceof Date) {
        return ts.getTime();
    }
    if (typeof ts === 'number') {
        return ts;
    }
    return null;
}

function computeRetryDelayMs(attempt) {
    const safeAttempt = attempt > 0 ? attempt : 0;
    const baseMs = 15000; // 15s
    const maxMs = 10 * 60 * 1000; // 10 minutes
    const multiplier = 2 ** Math.min(safeAttempt, 6);
    const jitter = Math.floor(Math.random() * 5000); // up to 5s jitter to avoid thundering herd
    const delay = baseMs * multiplier + jitter;
    return delay > maxMs ? maxMs : delay;
}

async function resolvePrizePoolWallet(provider, { requireTrusted = true } = {}) {
    try {
        const CFG = getCfg();
        const candidates = [];
        const pushCandidate = (value) => {
            if (!value) return;
            try {
                const trimmed = String(value).trim();
                if (!trimmed) return;
                candidates.push(trimmed);
            } catch (_) {}
        };
        pushCandidate(CFG.prizePoolKey);
        pushCandidate(CFG.fundWalletKey);
    pushCandidate(CFG.privateKey);
        pushCandidate(process.env.PRIZE_POOL_PK);
        pushCandidate(process.env.FUND_SENDER_PK);
        const uniq = [];
        const seen = new Set();
        for (const key of candidates) {
            const lower = key.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            uniq.push(key);
        }
        if (!uniq.length) {
            console.warn('resolvePrizePoolWallet: no signer candidates configured (set PRIZE_POOL_PK or FUND_SENDER_PK)');
            return null;
        }
        const vaultAbi = loadVaultAbi();
        const vaultAddress = CFG.gameVault;
        const vaultReadonly = (vaultAbi && vaultAddress) ? new ethers.Contract(vaultAddress, vaultAbi, provider) : null;
        for (const key of uniq) {
            let wallet = null;
            try {
                wallet = new ethers.Wallet(key, provider);
            } catch (err) {
                console.warn('resolvePrizePoolWallet: skipping invalid signer key', err && err.message ? err.message : err);
                continue;
            }
            if (!wallet) continue;
            if (!wallet.provider) {
                wallet = wallet.connect(provider);
            }
            if (requireTrusted && vaultReadonly) {
                try {
                    const trusted = await vaultReadonly.trustedDepositor(wallet.address);
                    if (!trusted) {
                        console.warn(`resolvePrizePoolWallet: signer ${wallet.address} is not a trusted depositor on GameVault`);
                        continue;
                    }
                } catch (checkErr) {
                    console.warn('resolvePrizePoolWallet: unable to verify trusted depositor status', checkErr && checkErr.message ? checkErr.message : checkErr);
                    continue;
                }
            }
            return wallet;
        }
    } catch (err) {
        console.warn('resolvePrizePoolWallet error', err && err.message ? err.message : err);
    }
    return null;
}

function deriveOnchainTableId(raw) {
    if (raw === undefined || raw === null) return null;
    try {
        return ethers.toBigInt(raw);
    } catch (_) {
        try {
            const hex = ethers.keccak256(ethers.toUtf8Bytes(String(raw)));
            return ethers.toBigInt(hex);
        } catch (_) {
            return null;
        }
    }
}

function toBigIntSafe(value, fallback = 0n) {
    try {
        if (value === undefined || value === null) return fallback;
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return fallback;
            return BigInt(Math.trunc(value));
        }
        if (typeof value === 'string') {
            const str = value.trim();
            if (!str) return fallback;
            if (str.startsWith('0x') || /^-?\d+$/.test(str)) return BigInt(str);
            return fallback;
        }
        if (value && typeof value.toString === 'function') {
            return toBigIntSafe(value.toString(), fallback);
        }
        return fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeAddress(addr) {
    if (addr === undefined || addr === null) return null;
    try {
        return String(addr).trim().toLowerCase();
    } catch (_) {
        return null;
    }
}

function toFirestoreValue(value, depth = 0) {
    if (value === undefined) return null;
    if (value === null) return null;
    const type = typeof value;
    if (type === 'bigint') return value.toString();
    if (type === 'number' || type === 'boolean' || type === 'string') return value;
    if (value instanceof Uint8Array) {
        try { return ethers.hexlify(value); } catch (_) { return Array.from(value); }
    }
    if (Array.isArray(value)) {
        return value.map((item) => toFirestoreValue(item, depth + 1));
    }
    if (type === 'object') {
        if (value && typeof value.toJSON === 'function') {
            return toFirestoreValue(value.toJSON(), depth + 1);
        }
        if (depth > 10) {
            try {
                const str = value.toString();
                if (str && str !== '[object Object]') return str;
            } catch (_) { return null; }
        }
        const plain = {};
        for (const [key, val] of Object.entries(value)) {
            plain[key] = toFirestoreValue(val, depth + 1);
        }
        return plain;
    }
    try {
        return String(value);
    } catch (_) {
        return null;
    }
}

function serializeReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object') return null;
    const base = {
        transactionHash: receipt.hash || receipt.transactionHash || null,
        blockHash: receipt.blockHash || null,
        blockNumber: toFirestoreValue(receipt.blockNumber),
        status: typeof receipt.status === 'number' ? receipt.status : toFirestoreValue(receipt.status),
        gasUsed: toFirestoreValue(receipt.gasUsed),
        cumulativeGasUsed: toFirestoreValue(receipt.cumulativeGasUsed),
        effectiveGasPrice: toFirestoreValue(receipt.effectiveGasPrice),
        logsBloom: receipt.logsBloom || null,
        type: typeof receipt.type === 'number' ? receipt.type : toFirestoreValue(receipt.type),
        contractAddress: receipt.contractAddress || null,
        transactionIndex: typeof receipt.transactionIndex === 'number' ? receipt.transactionIndex : toFirestoreValue(receipt.transactionIndex),
        logs: Array.isArray(receipt.logs) ? receipt.logs.map((log) => ({
            address: log.address || null,
            data: toFirestoreValue(log.data),
            topics: Array.isArray(log.topics) ? log.topics.map((topic) => toFirestoreValue(topic)) : [],
            blockNumber: toFirestoreValue(log.blockNumber),
            blockHash: log.blockHash || null,
            transactionHash: log.transactionHash || (receipt.hash || receipt.transactionHash || null),
            transactionIndex: typeof log.transactionIndex === 'number' ? log.transactionIndex : toFirestoreValue(log.transactionIndex),
            logIndex: typeof log.logIndex === 'number' ? log.logIndex : toFirestoreValue(log.logIndex),
            removed: !!log.removed,
        })) : []
    };
    return base;
}

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
// Ensure FieldValue alias exists for serverTimestamp/increment operations
let FieldValue = null;
try {
    // Prefer admin.firestore.FieldValue
    FieldValue = (admin && admin.firestore && admin.firestore.FieldValue) ? admin.firestore.FieldValue : null;
} catch (e) { /* ignore */ }
if (!FieldValue) {
    try {
        const adminFirestore = require('firebase-admin').firestore;
        FieldValue = adminFirestore && adminFirestore.FieldValue ? adminFirestore.FieldValue : null;
    } catch (e) { /* ignore */ }
}
if (!FieldValue) {
    // Fallback shim: serverTimestamp returns a Date/Timestamp acceptable to emulator
    FieldValue = {
        serverTimestamp: () => {
            try {
                return (admin && admin.firestore && admin.firestore.Timestamp) ? admin.firestore.Timestamp.now() : new Date();
            } catch (e) { return new Date(); }
        },
        increment: (n) => { return { __increment: n }; }
    };
}

// Small helper to bump table activity and updatedAt safely
async function bumpTableActivity(tableId) {
    try {
        await db.doc(`tables/${tableId}`).set({
            lastActivityAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    } catch (e) {
        console.warn('bumpTableActivity error', tableId, e && e.message ? e.message : e);
    }
}

// --- Config & Constants ---
const TIME_BANK_SECONDS = 60; // time to act before auto-fold (reduced to 60s for reliable 3x timeout detection)
const MAX_PLAYERS = 8;

// Default tournament (SNG/Scheduled) blind structure and timing
function defaultTournamentConfig() {
    return {
        levelDurationSec: 120, // 2 minutes per level (fast-paced Play vs PC)
        currentLevel: 0,
        levelStartedAt: FieldValue.serverTimestamp(),
        levels: [
            { sb: 5,   bb: 10,   ante: 0 },
            { sb: 10,  bb: 20,   ante: 0 },
            { sb: 15,  bb: 30,   ante: 0 },
            { sb: 25,  bb: 50,   ante: 5 },
            { sb: 40,  bb: 80,   ante: 10 },
            { sb: 50,  bb: 100,  ante: 10 },
            { sb: 75,  bb: 150,  ante: 15 },
            { sb: 100, bb: 200,  ante: 25 },
            { sb: 150, bb: 300,  ante: 25 },
            { sb: 200, bb: 400,  ante: 50 },
            { sb: 300, bb: 600,  ante: 75 },
            { sb: 500, bb: 1000, ante: 100 },
            { sb: 750, bb: 1500, ante: 150 },
            { sb: 1000, bb: 2000, ante: 200 },
            { sb: 1500, bb: 3000, ante: 300 },
            { sb: 2000, bb: 4000, ante: 400 },
        ]
    };
}

// Secrets (v2) for chain config and token rules
const RPC_URL = defineSecret('RPC_URL');
const PRIVATE_KEY = defineSecret('PRIVATE_KEY');
const PRIZE_DISTRIBUTOR = defineSecret('PRIZE_DISTRIBUTOR');
const PRIZE_POOL_PK = defineSecret('PRIZE_POOL_PK');
const FUND_SENDER_PK = defineSecret('FUND_SENDER_PK');
const ALLOWED_LSP7_TOKEN = defineSecret('ALLOWED_LSP7_TOKEN');
const LYX_UNIT_MULTIPLIER = defineSecret('LYX_UNIT_MULTIPLIER');
const LSP7_UNIT_MULTIPLIER = defineSecret('LSP7_UNIT_MULTIPLIER');
// New: managed secret for vault address
const GAME_VAULT = defineSecret('GAME_VAULT');
const GAME_ENTRY = defineSecret('GAME_ENTRY');
const GAME_SERVER = defineSecret('GAME_SERVER');
// Admin token for protected ops
const ADMIN_TOKEN = defineSecret('ADMIN_TOKEN');
// Optional: temporary owner key to perform one-time admin wiring
const ADMIN_OWNER_PK = defineSecret('ADMIN_OWNER_PK');
// New: auto-config defaults for table config
const HOUSE_WALLET_SEC = defineSecret('HOUSE_WALLET');
const DEFAULT_RAKE_BPS_SEC = defineSecret('DEFAULT_RAKE_BPS');
// Dev convenience: allow public deposits from localhost without ADMIN_TOKEN when explicitly enabled
const DEV_ALLOW_PUBLIC_DEPOSIT = defineSecret('DEV_ALLOW_PUBLIC_DEPOSIT');
const DEBUG_TOKEN_SEC = defineSecret('DEBUG_TOKEN');
const ALLOW_DEBUG_SEC = defineSecret('ALLOW_DEBUG');

// ABI for PrizeDistributor
const PRIZE_DISTRIBUTOR_ABI = [
    // Match PrizeDistributor.sol: authorizePayout(address winner, address tokenAddress, uint256 amount)
    "function authorizePayout(address winner, address tokenAddress, uint256 amount) external"
];

const LSP7_MIN_ABI = [
    "function transfer(address from, address to, uint256 amount, bool force, bytes data) external",
    "function balanceOf(address tokenHolder) view returns (uint256)"
];

const GAME_ENTRY_ABI = [
    // Minimal interface for decoding buy-in transactions
    "function buyInLYX(uint256 tableId)",
    "function buyInLSP7(address token, uint256 tableId, uint256 amount)"
];

const UNIVERSAL_PROFILE_ABI = [
    "function execute(uint256 operationType, address target, uint256 value, bytes data)"
];

const KEY_MANAGER_ABI = [
    "function execute(bytes data)",
    "function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)",
    "function account() view returns (address)"
];

const UNIVERSAL_EXECUTE_HELPERS_ABI = [
    "function execute(uint256 operationType, address target, uint256 value, bytes data)",
    "function executeBatch(bytes[] data)",
    "function batchCalls(bytes[] data)"
];

function getCfg() {
    // Prefer Secrets; fall back to env for local emulators; finally read deployments/local.json if mounted
    const s = (v) => {
        if (v === undefined || v === null) return v;
        try { return String(v).trim(); } catch { return v; }
    };
    const normHex = (h) => {
        const v = s(h);
        if (!v) return v;
        let t = v.replace(/^"|"$/g, ''); // strip accidental quotes
        if (!t.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(t)) t = '0x' + t;
        return t;
    };
    const lower = (a) => { const v = s(a); return v ? v.toLowerCase() : v; };
    const cfg = {
        rpcUrl: s(RPC_URL.value && RPC_URL.value() || process.env.RPC_URL),
        privateKey: normHex((PRIVATE_KEY.value && PRIVATE_KEY.value()) || process.env.PRIVATE_KEY),
        prizeDistributor: s((PRIZE_DISTRIBUTOR.value && PRIZE_DISTRIBUTOR.value()) || process.env.PRIZE_DISTRIBUTOR),
        allowedLsp7: lower((ALLOWED_LSP7_TOKEN.value && ALLOWED_LSP7_TOKEN.value()) || process.env.ALLOWED_LSP7_TOKEN || ''),
        lyxMultiplier: s(LYX_UNIT_MULTIPLIER.value && LYX_UNIT_MULTIPLIER.value() || process.env.LYX_UNIT_MULTIPLIER || '10000000000000000'),
        lsp7Multiplier: s(LSP7_UNIT_MULTIPLIER.value && LSP7_UNIT_MULTIPLIER.value() || process.env.LSP7_UNIT_MULTIPLIER || '1000000000000000000000'),
        // Game vault address for deposit verification. Configure via env GAME_VAULT or secret.
        gameVault: s((GAME_VAULT.value && GAME_VAULT.value()) || process.env.GAME_VAULT || process.env.VAULT_ADDRESS || null),
        gameEntry: normHex((GAME_ENTRY.value && GAME_ENTRY.value()) || process.env.GAME_ENTRY || null),
        gameServer: normHex((GAME_SERVER.value && GAME_SERVER.value()) || process.env.GAME_SERVER || null),
        owner: normHex(process.env.CONTRACT_OWNER || null),
        houseWallet: normHex((HOUSE_WALLET_SEC.value && HOUSE_WALLET_SEC.value()) || process.env.HOUSE_WALLET || null),
        prizePoolKey: normHex((PRIZE_POOL_PK.value && PRIZE_POOL_PK.value()) || process.env.PRIZE_POOL_PK || ''),
        fundWalletKey: normHex((FUND_SENDER_PK.value && FUND_SENDER_PK.value()) || process.env.FUND_SENDER_PK || '')
    };
    console.log(`[getCfg] USING TOKEN ADDRESS (ALLOWED_LSP7_TOKEN): ${cfg.allowedLsp7}`);
    try {
        const fs = require('fs');
        const path = require('path');
        // Check if testnet mode is enabled via env variable, Firebase config, OR running on emulator
        const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true' || 
                           process.env.FIREBASE_CONFIG?.includes('localhost') ||
                           (!process.env.FUNCTIONS_EMULATOR && !cfg.rpcUrl); // No RPC = likely emulator/local dev
        
        const isTestnet = process.env.TESTNET === 'true' || 
                          process.env.TESTNET === '1' ||
                          isEmulator || // AUTO-ENABLE testnet for emulator/localhost
                          (typeof admin.functions !== 'undefined' && admin.functions?.config?.()?.testnet?.enabled === 'true');
        
        if (isTestnet) {
            console.log('[getCfg] 🧪 TESTNET MODE ENABLED - Using testnet deployment addresses');
            if (isEmulator) {
                console.log('[getCfg] 📍 Running on Firebase Emulator - auto-enabled testnet config');
            }
        }
        
        // Prefer testnet.json when TESTNET=true, otherwise prod.json, fallback to local.json
        const testnetPath = path.resolve(__dirname, '..', 'frontend', 'public', 'deployments', 'testnet.json');
        const prodPath = path.resolve(__dirname, '..', 'frontend', 'public', 'deployments', 'prod.json');
        const localPath = path.resolve(__dirname, '..', 'deployments', 'local.json');
        const functionsTestnetPath = path.resolve(__dirname, 'deployments', 'testnet.json');
        const functionsProdPath = path.resolve(__dirname, 'deployments', 'prod.json');
        const functionsLocalPath = path.resolve(__dirname, 'deployments', 'local.json');
        
        // Try testnet paths first if TESTNET=true
        if (isTestnet && (!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(functionsTestnetPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(functionsTestnetPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || (d.unitsPerChip && d.unitsPerChip.wbstr) || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || (d.unitsPerChip && d.unitsPerChip.lyx) || '');
                console.log(`[getCfg] ✅ Loaded TESTNET config from ${functionsTestnetPath}`);
            } catch (_) {}
        }
        if ((!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(functionsProdPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(functionsProdPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || (d.unitsPerChip && d.unitsPerChip.wbstr) || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || (d.unitsPerChip && d.unitsPerChip.lyx) || '');
            } catch (_) {}
        }
        if ((!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(functionsLocalPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(functionsLocalPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || (d.unitsPerChip && d.unitsPerChip.wbstr) || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || (d.unitsPerChip && d.unitsPerChip.lyx) || '');
            } catch (_) {}
        }
        if (isTestnet && (!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(testnetPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(testnetPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || '');
                console.log(`[getCfg] ✅ Loaded TESTNET config from ${testnetPath}`);
            } catch (_) {}
        }
        if ((!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(prodPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || '');
            } catch (_) {}
        }
        if ((!cfg.prizeDistributor || !cfg.gameVault || !cfg.rpcUrl || !cfg.allowedLsp7) && fs.existsSync(localPath)) {
            try {
                const d = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                cfg.prizeDistributor = cfg.prizeDistributor || d.prizeDistributor || null;
                cfg.gameVault = cfg.gameVault || d.gameVault || null;
                cfg.gameEntry = cfg.gameEntry || d.gameEntry || null;
                cfg.gameServer = cfg.gameServer || d.gameServer || null;
                cfg.owner = cfg.owner || d.owner || null;
                cfg.houseWallet = cfg.houseWallet || normHex(d.houseWallet || d.house || d.owner || null);
                cfg.rpcUrl = cfg.rpcUrl || d.rpcUrl || cfg.rpcUrl;
                cfg.allowedLsp7 = cfg.allowedLsp7 || lower(d.wbstrToken || d.allowedLsp7 || '');
                cfg.lsp7Multiplier = cfg.lsp7Multiplier || s(d.lsp7Multiplier || '');
                cfg.lyxMultiplier = cfg.lyxMultiplier || s(d.lyxMultiplier || '');
            } catch (_) {}
        }
    } catch (_) {}
    if (!cfg.prizePoolKey) cfg.prizePoolKey = null;
    if (!cfg.fundWalletKey) cfg.fundWalletKey = null;
    if (!cfg.prizePoolKey) cfg.prizePoolKey = cfg.fundWalletKey || cfg.privateKey || null;
    if (!cfg.fundWalletKey) cfg.fundWalletKey = cfg.prizePoolKey || cfg.privateKey || null;
    try {
        cfg.prizePoolAddress = cfg.prizePoolKey ? new ethers.Wallet(cfg.prizePoolKey).address : null;
    } catch (_) {
        cfg.prizePoolAddress = null;
    }
    try {
        cfg.fundWalletAddress = cfg.fundWalletKey ? new ethers.Wallet(cfg.fundWalletKey).address : null;
    } catch (_) {
        cfg.fundWalletAddress = null;
    }
    if (!cfg.houseWallet && cfg.owner) cfg.houseWallet = cfg.owner;
    console.log(`[getCfg] USING TOKEN ADDRESS (ALLOWED_LSP7_TOKEN): ${cfg.allowedLsp7}`);
    return cfg;
}

function assertConfig(cfg) {
    if (!cfg.rpcUrl || !cfg.prizeDistributor || !(cfg.privateKey || cfg.prizePoolKey)) {
        console.warn("Missing chain config (RPC_URL/PRIZE_DISTRIBUTOR/PRIZE_POOL_PK). Payouts will be skipped.");
        return false;
    }
    return true;
}

async function unwrapGameEntryInvocation({ provider, tx, gameEntryAddress }) {
    if (!tx) return null;
    const lowerGameEntry = normalizeAddress(gameEntryAddress);
    if (!lowerGameEntry) return null;
    const controllerAddress = normalizeAddress(tx.from);
    const txToLower = normalizeAddress(tx.to);
    const entryInterface = new ethers.Interface(GAME_ENTRY_ABI);
    const upInterface = new ethers.Interface(UNIVERSAL_PROFILE_ABI);
    const keyManagerInterface = new ethers.Interface(KEY_MANAGER_ABI);
    const executeHelperInterface = new ethers.Interface(UNIVERSAL_EXECUTE_HELPERS_ABI);
    const EXECUTE_SELECTOR = (executeHelperInterface.getFunction('execute')?.selector || '0x44c028fe').toLowerCase();
    const EXECUTE_BATCH_SELECTOR = (executeHelperInterface.getFunction('executeBatch')?.selector || '0x31858452').toLowerCase();
    const BATCH_CALLS_SELECTOR = (executeHelperInterface.getFunction('batchCalls')?.selector || '0x6963d438').toLowerCase();

    const toHexString = (bytes) => {
        if (!bytes) return '0x';
        if (typeof bytes === 'string') {
            if (bytes.startsWith('0x') || bytes.startsWith('0X')) return bytes.toLowerCase();
            return `0x${bytes.toLowerCase()}`;
        }
        try {
            return ethers.hexlify(bytes).toLowerCase();
        } catch (_) {
            return '0x';
        }
    };

    const unwrapExecuteChain = (initialTarget, forwardedValue, rawData, depth = 0, hops = []) => {
        if (depth > 8) return null;
        const dataHex = toHexString(rawData);
        if (!dataHex || dataHex === '0x') return null;
        const parsedEntry = tryParseEntry(dataHex, forwardedValue);
        if (parsedEntry) {
            return {
                parsedEntry,
                rawEntryData: dataHex,
                forwardedValue: forwardedValue !== undefined ? toBigIntSafe(forwardedValue, 0n) : 0n,
                targetAddress: initialTarget ? normalizeAddress(initialTarget) : null,
                hops,
            };
        }
        if (dataHex.length < 10) return null;
        const selector = dataHex.slice(0, 10).toLowerCase();
        if (selector === EXECUTE_SELECTOR) {
            let execDecoded = null;
            try {
                execDecoded = executeHelperInterface.parseTransaction({ data: dataHex });
            } catch (_) { /* ignore */ }
            if (!execDecoded) return null;
            const nextTarget = execDecoded.args?.target ?? execDecoded.args?.[1] ?? null;
            const nextValue = execDecoded.args?.value ?? execDecoded.args?.[2] ?? forwardedValue;
            const nextData = execDecoded.args?.data ?? execDecoded.args?.[3] ?? '0x';
            const operationType = execDecoded.args?.operationType ?? execDecoded.args?.[0] ?? 0n;
            const hop = {
                type: 'execute',
                target: normalizeAddress(nextTarget),
                operationType: toBigIntSafe(operationType, 0n),
            };
            const nested = unwrapExecuteChain(nextTarget, nextValue, nextData, depth + 1, hops.concat(hop));
            if (nested) {
                if (!nested.targetAddress) nested.targetAddress = normalizeAddress(nextTarget);
                if (nested.forwardedValue === undefined || nested.forwardedValue === null) {
                    nested.forwardedValue = toBigIntSafe(nextValue, toBigIntSafe(forwardedValue, 0n));
                }
                return nested;
            }
            return null;
        }
        if (selector === EXECUTE_BATCH_SELECTOR || selector === BATCH_CALLS_SELECTOR) {
            let batchDecoded = null;
            try {
                batchDecoded = executeHelperInterface.parseTransaction({ data: dataHex });
            } catch (_) { /* ignore */ }
            const calls = batchDecoded && batchDecoded.args
                ? (batchDecoded.args?.data ?? batchDecoded.args?.[0] ?? [])
                : [];
            if (!Array.isArray(calls)) return null;
            for (let i = 0; i < calls.length; i++) {
                const callBytes = calls[i];
                const hop = {
                    type: selector === EXECUTE_BATCH_SELECTOR ? 'executeBatch' : 'batchCalls',
                    index: i,
                };
                const nested = unwrapExecuteChain(initialTarget, forwardedValue, callBytes, depth + 1, hops.concat(hop));
                if (nested && nested.parsedEntry) {
                    return nested;
                }
            }
        }
        return null;
    };

    const tryParseEntry = (data, value) => {
        if (!data) return null;
        try {
            return entryInterface.parseTransaction(value !== undefined
                ? { data, value }
                : { data });
        } catch (_) {
            return null;
        }
    };

    const tryResolveKeyManagerAccount = async (kmAddress) => {
        const addr = normalizeAddress(kmAddress);
        if (!addr) return null;
        const probes = [
            { name: 'account', signature: 'function account() view returns (address)' },
            { name: 'target', signature: 'function target() view returns (address)' },
            { name: 'owner', signature: 'function owner() view returns (address)' },
        ];
        for (const probe of probes) {
            try {
                const iface = new ethers.Interface([probe.signature]);
                const raw = await provider.call({ to: addr, data: iface.encodeFunctionData(probe.name, []) });
                if (!raw || raw === '0x') continue;
                const decoded = iface.decodeFunctionResult(probe.name, raw);
                const candidate = decoded && decoded[0] ? normalizeAddress(decoded[0]) : null;
                if (candidate && candidate !== ethers.ZeroAddress.toLowerCase()) {
                    return candidate;
                }
            } catch (probeErr) {
                const msg = probeErr && probeErr.message ? probeErr.message : String(probeErr || '');
                if (msg && !msg.toLowerCase().includes('call exception') && !msg.toLowerCase().includes('execution reverted')) {
                    console.warn('[unwrapGameEntryInvocation] key manager probe failed', { kmAddress: addr, method: probe.name, error: msg });
                }
            }
        }
        return null;
    };

    const buildResult = ({
        route,
        profileAddress,
        keyManagerAddress,
        targetAddress,
        parsedEntry,
        forwardedValue,
        rawEntryData,
        hops,
    }) => ({
        route,
        controllerAddress,
        profileAddress: profileAddress ? normalizeAddress(profileAddress) : null,
        keyManagerAddress: keyManagerAddress ? normalizeAddress(keyManagerAddress) : null,
        targetAddress: targetAddress ? normalizeAddress(targetAddress) : null,
        parsedEntry: parsedEntry || null,
        forwardedValue: forwardedValue !== undefined ? toBigIntSafe(forwardedValue, 0n) : 0n,
        rawEntryData: rawEntryData || null,
        hops: Array.isArray(hops) ? hops : [],
    });

    // Direct GameEntry call (EOA or contract calling directly)
    if (txToLower && txToLower === lowerGameEntry) {
        const parsedEntry = tryParseEntry(tx.data, tx.value);
        if (!parsedEntry) return null;
        return buildResult({
            route: 'direct',
            profileAddress: controllerAddress,
            keyManagerAddress: null,
            targetAddress: lowerGameEntry,
            parsedEntry,
            forwardedValue: tx.value,
            rawEntryData: tx.data,
        });
    }

    // Key Manager mediated call
    let kmParsed = null;
    try {
        kmParsed = keyManagerInterface.parseTransaction({ data: tx.data, value: tx.value });
    } catch (_) {
        kmParsed = null;
    }
    if (kmParsed && txToLower) {
        let payload = null;
        let baseRoute = 'key-manager';
        const initialHops = [];
        if (kmParsed.name === 'executeRelayCall') {
            payload = kmParsed.args?.payload ?? kmParsed.args?.[3] ?? null;
            baseRoute = 'key-manager:relay';
            initialHops.push({
                type: 'executeRelayCall',
                nonce: toBigIntSafe(kmParsed.args?.nonce ?? kmParsed.args?.[1] ?? 0n, 0n).toString(),
                validity: toBigIntSafe(kmParsed.args?.validityTimestamps ?? kmParsed.args?.[2] ?? 0n, 0n).toString(),
            });
        } else {
            payload = kmParsed.args?.data ?? kmParsed.args?.[0] ?? null;
        }
        let profileAddress = null;
        if (payload) {
            try {
                profileAddress = await tryResolveKeyManagerAccount(tx.to);
            } catch (kmErr) {
                const msg = kmErr && kmErr.message ? kmErr.message : kmErr;
                console.warn('[unwrapGameEntryInvocation] unable to resolve Key Manager account', msg);
            }
            let upParsed = null;
            try {
                upParsed = upInterface.parseTransaction({ data: payload });
            } catch (_) {
                upParsed = null;
            }
            if (upParsed) {
                const targetAddress = upParsed.args?.target ?? upParsed.args?.[1];
                const forwardedValue = upParsed.args?.value ?? upParsed.args?.[2];
                const innerData = toHexString(upParsed.args?.data ?? upParsed.args?.[3] ?? '0x');
                let parsedEntry = tryParseEntry(innerData, forwardedValue);
                let resolvedTarget = targetAddress;
                let resolvedForwardedValue = forwardedValue;
                let rawEntryData = innerData;
                let routeLabel = baseRoute;
                let hops = initialHops.length ? initialHops.slice() : [];
                if (!parsedEntry) {
                    const cascaded = unwrapExecuteChain(targetAddress, forwardedValue, innerData);
                    if (cascaded && cascaded.parsedEntry) {
                        parsedEntry = cascaded.parsedEntry;
                        resolvedTarget = cascaded.targetAddress || targetAddress;
                        resolvedForwardedValue = cascaded.forwardedValue ?? forwardedValue;
                        rawEntryData = cascaded.rawEntryData || innerData;
                        const nestedHops = cascaded.hops || [];
                        if (nestedHops.length) {
                            hops = hops.concat(nestedHops);
                            routeLabel = `${baseRoute}:execute-chain`;
                        }
                    }
                }
                return buildResult({
                    route: routeLabel,
                    profileAddress: profileAddress || null,
                    keyManagerAddress: txToLower,
                    targetAddress: resolvedTarget,
                    parsedEntry,
                    forwardedValue: resolvedForwardedValue,
                    rawEntryData,
                    hops,
                });
            }
        }
        return buildResult({
            route: baseRoute,
            profileAddress: null,
            keyManagerAddress: txToLower,
            targetAddress: null,
            parsedEntry: null,
            forwardedValue: 0n,
            rawEntryData: null,
            hops: initialHops,
        });
    }

    // Universal Profile direct call (EOA interacting with UP contract)
    let upDirectParsed = null;
    try {
        upDirectParsed = upInterface.parseTransaction({ data: tx.data, value: tx.value });
    } catch (_) {
        upDirectParsed = null;
    }
    if (upDirectParsed && txToLower) {
        const targetAddress = upDirectParsed.args?.target ?? upDirectParsed.args?.[1];
        const forwardedValue = upDirectParsed.args?.value ?? upDirectParsed.args?.[2];
        const innerData = toHexString(upDirectParsed.args?.data ?? upDirectParsed.args?.[3] ?? '0x');
        let parsedEntry = tryParseEntry(innerData, forwardedValue);
        let resolvedTarget = targetAddress;
        let resolvedForwardedValue = forwardedValue;
        let rawEntryData = innerData;
        let routeLabel = 'universal-profile';
        let hops = [];
        if (!parsedEntry) {
            const cascaded = unwrapExecuteChain(targetAddress, forwardedValue, innerData);
            if (cascaded && cascaded.parsedEntry) {
                parsedEntry = cascaded.parsedEntry;
                resolvedTarget = cascaded.targetAddress || targetAddress;
                resolvedForwardedValue = cascaded.forwardedValue ?? forwardedValue;
                rawEntryData = cascaded.rawEntryData || innerData;
                hops = cascaded.hops || [];
                if (hops.length) routeLabel = 'universal-profile:execute-chain';
            }
        }
        return buildResult({
            route: routeLabel,
            profileAddress: txToLower,
            keyManagerAddress: null,
            targetAddress: resolvedTarget,
            parsedEntry,
            forwardedValue: resolvedForwardedValue,
            rawEntryData,
            hops,
        });
    }

    const fallbackExecute = unwrapExecuteChain(txToLower, tx.value, tx.data);
    if (fallbackExecute && fallbackExecute.parsedEntry) {
        return buildResult({
            route: 'execute-chain',
            profileAddress: controllerAddress,
            keyManagerAddress: null,
            targetAddress: fallbackExecute.targetAddress || txToLower,
            parsedEntry: fallbackExecute.parsedEntry,
            forwardedValue: fallbackExecute.forwardedValue,
            rawEntryData: fallbackExecute.rawEntryData,
            hops: fallbackExecute.hops || [],
        });
    }

    return null;
}

// --- Leaderboard (Play-to-Earn) helpers ---
const { getISOWeekKey, getMonthKey, computeHandPoints } = require('./p2e');
async function awardP2EPoints({ game, contribs, winningsAdd }) {
    try {
        const cfg = getCfg();
        const wbstrAllowed = String(cfg.allowedLsp7 || '').toLowerCase();
        const tokenUsed = String(game.tokenAddress || '').toLowerCase();
        const isWBSTR = wbstrAllowed && tokenUsed === wbstrAllowed;
        const now = new Date();
        const weekKey = getISOWeekKey(now);
        const monthKey = getMonthKey(now);

        const batch = db.batch();
        for (const [pid, p] of Object.entries(game.players)) {
            if (!p || !p.address || p.bot) continue; // award only real players with address
            const wager = Math.max(0, contribs[pid] || 0);
            const wonAdd = Math.max(0, winningsAdd[pid] || 0);
            const points = computeHandPoints({ wager, wonAdd, tokenUsed, allowedWbstr: wbstrAllowed });
            if (points <= 0) continue;
            const ref = db.collection('leaderboards').doc(p.address.toLowerCase());
            batch.set(ref, {
                user: p.name || p.address,
                address: p.address,
                    points: FieldValue.increment(points),
                    chipsWagered: FieldValue.increment(wager),
                    chipsNetWon: FieldValue.increment(wonAdd - wager),
                    hands: FieldValue.increment(1),
                    updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });

            // Weekly doc: leaderboards_weekly/{period}_{address}
            const wkId = `${weekKey}_${p.address.toLowerCase()}`;
            const wkRef = db.collection('leaderboards_weekly').doc(wkId);
            batch.set(wkRef, {
                period: weekKey,
                user: p.name || p.address,
                address: p.address,
                    points: FieldValue.increment(points),
                    chipsWagered: FieldValue.increment(wager),
                    chipsNetWon: FieldValue.increment(wonAdd - wager),
                    hands: FieldValue.increment(1),
                    updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });

            // Monthly doc: leaderboards_monthly/{period}_{address}
            const moId = `${monthKey}_${p.address.toLowerCase()}`;
            const moRef = db.collection('leaderboards_monthly').doc(moId);
            batch.set(moRef, {
                period: monthKey,
                user: p.name || p.address,
                address: p.address,
                    points: FieldValue.increment(points),
                    chipsWagered: FieldValue.increment(wager),
                    chipsNetWon: FieldValue.increment(wonAdd - wager),
                    hands: FieldValue.increment(1),
                    updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        await batch.commit();
    } catch (e) {
        console.error('awardP2EPoints error', e);
    }
}

// --- Helpers: Deck & Cards ---
function buildDeck() {
    const suits = ['s','h','d','c'];
    const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const deck = [];
    for (const r of ranks) for (const s of suits) deck.push(r + s);
    return deck;
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// --- Cleanup helpers ---
async function deleteCollection(refPath, batchSize = 100) {
    const colRef = db.collection(refPath);
    const snapshot = await colRef.limit(batchSize).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size >= batchSize) return deleteCollection(refPath, batchSize);
}

async function cascadeDeleteWaitingTable(tableId) {
    const tableRef = db.collection('tables').doc(tableId);
    try {
        // Delete known subcollections: players, chat, game
        await deleteCollection(`tables/${tableId}/players`);
        await deleteCollection(`tables/${tableId}/chat`);
        await deleteCollection(`tables/${tableId}/game`);
    } catch (e) {
        console.warn('Error cleaning subcollections for table', tableId, e);
    }
    try {
        await tableRef.delete();
    } catch (e) {
        console.warn('Error deleting table', tableId, e);
    }
}

// When a host leaves a waiting room, delete the table if no host remains (waiting only)
exports.cleanupWaitingLobbyOnHostLeave = onDocumentDeleted("tables/{tableId}/players/{playerId}", async (event) => {
    try {
        const { tableId } = event.params;
        // Regardless of the deleted player's role, re-check whether any host remains
        const tableRef = db.collection('tables').doc(tableId);
        const tableSnap = await tableRef.get();
        if (!tableSnap.exists) return;
        const table = tableSnap.data();
        if (table.status !== 'waiting') return; // only handle waiting rooms
        // Check players subcollection: if no players remain, delete table immediately
        const playersColRef = db.collection('tables').doc(tableId).collection('players');
        const anyPlayerSnap = await playersColRef.limit(1).get();
        const noPlayersRemain = anyPlayerSnap.empty;
        if (noPlayersRemain) {
            console.log(`No players remain in waiting table ${tableId}. Deleting table and waiting lobby.`);
            await cascadeDeleteWaitingTable(tableId);
            return;
        }
        // Otherwise, check if any host remains; if none, delete the waiting table
        const hostSnap = await playersColRef.where('role', '==', 'host').limit(1).get();
        const hostStillPresent = !hostSnap.empty;
        if (!hostStillPresent) {
            console.log(`No host remains in waiting table ${tableId}. Deleting table and waiting lobby.`);
            await cascadeDeleteWaitingTable(tableId);
        }
    } catch (e) {
        console.error('cleanupWaitingLobbyOnHostLeave error', e);
    }
});

// Maintain playerCount and lastActivityAt on player add/remove
exports.onPlayerCreated = onDocumentCreated("tables/{tableId}/players/{playerId}", async (event) => {
    try {
        const { tableId } = event.params;
        const tableRef = db.doc(`tables/${tableId}`);
        await tableRef.set({ playerCount: FieldValue.increment(1), lastActivityAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
        console.warn('onPlayerCreated error', e && e.message);
    }
});
exports.onPlayerDeleted = onDocumentDeleted({
    document: "tables/{tableId}/players/{playerId}",
    secrets: [RPC_URL, PRIVATE_KEY, PRIZE_DISTRIBUTOR, GAME_VAULT, ALLOWED_LSP7_TOKEN, LYX_UNIT_MULTIPLIER, LSP7_UNIT_MULTIPLIER]
}, async (event) => {
    try {
        const { tableId, playerId } = event.params;
        const tableRef = db.doc(`tables/${tableId}`);
        await tableRef.set({ playerCount: FieldValue.increment(-1), lastActivityAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        
        // Refund logic: Check if player left a balance in the vault (e.g. left waiting room after paying)
        // Do this for ALL games (AI and Multiplayer).
        // We need the player's address which was in the deleted doc.
        // Note: In v2 onDocumentDeleted, event.data is the QueryDocumentSnapshot of the deleted doc.
        const deletedData = event.data ? event.data.data() : null;
        const playerAddress = deletedData ? deletedData.address : null;

        if (playerAddress) {
            console.log(`[onPlayerDeleted] Checking for refund for player ${playerAddress} on table ${tableId}`);
            try {
                const CFG = getCfg();
                const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                const vaultAbi = loadVaultAbi();

                if (vaultAbi && CFG.gameVault) {
                    const vault = new ethers.Contract(CFG.gameVault, vaultAbi, provider);
                    const onchainTableId = deriveOnchainTableId(tableId);

                    // Need to check both LYX and Token if we don't know which one
                    // We'll try to guess from table data if possible, or check both.
                    const tableSnap = await tableRef.get();
                    const tableData = tableSnap.data() || {};
                    const tokenAddress = tableData.tokenAddress || ethers.ZeroAddress;
                    const normalizedToken = normalizeAddress(tokenAddress);
                    const normalizedPlayer = normalizeAddress(playerAddress);

                    let balance = 0n;
                    try {
                        const bal = await vault.balanceOf(onchainTableId, normalizedPlayer, normalizedToken);
                        balance = BigInt(bal.toString());
                    } catch (e) {
                        console.warn(`[onPlayerDeleted] Failed to check vault balance:`, e.message);
                    }

                    if (balance > 0n) {
                        console.log(`[onPlayerDeleted] Found balance ${balance.toString()} for leaving player. Authorizing refund.`);
                        await authorizePayoutsOnChain([{
                            address: normalizedPlayer,
                            tokenAddress: normalizedToken,
                            amount: balance,
                            tableId: tableId
                        }]);
                    } else {
                        console.log(`[onPlayerDeleted] No balance found for leaving player.`);
                    }
                }
            } catch (refundErr) {
                console.error(`[onPlayerDeleted] Refund check failed:`, refundErr);
            }
        }

        // CRITICAL: For AI games, check if human player left - if so, end the match immediately
        const tableSnap = await tableRef.get();
        const tableData = tableSnap.data() || {};
        const isAiGame = tableData.mode === 'ai' && tableData.isPrivate;
        const isActive = tableData.status === 'active';
        
        if (isAiGame && isActive) {
            console.log(`[onPlayerDeleted] Player ${playerId} left AI game ${tableId} - checking if match should end`);
            
            // Check remaining players
            const playersSnap = await db.collection(`tables/${tableId}/players`).get();
            let humanWithChips = false;
            let humanCount = 0;
            let humanPlayers = [];
            
            playersSnap.forEach((doc) => {
                const data = doc.data() || {};
                const isBot = data.bot === true || String(data.role || '').toLowerCase() === 'bot';
                const stack = typeof data.stack === 'number' ? data.stack : Number(data.stack || 0);
                const hasChips = Number.isFinite(stack) && stack > 0;
                
                if (!isBot) {
                    humanCount++;
                    humanPlayers.push({ pid: doc.id, address: data.address, stack });
                    if (hasChips) {
                        humanWithChips = true;
                    }
                }
            });
            
            console.log(`[onPlayerDeleted] Remaining humans: ${humanCount}, humanWithChips: ${humanWithChips}`);
            
            // If no humans left or no humans with chips, end the match (human lost by abandonment)
            if (humanCount === 0 || !humanWithChips) {
                console.log(`[onPlayerDeleted] 🚨 Human player abandoned AI game ${tableId} - ending match as LOSS`);
                
                // Mark table as ended FIRST
                await tableRef.set({
                    status: 'ended',
                    endedAt: FieldValue.serverTimestamp(),
                    endReason: 'humanAbandoned',
                    updatedAt: FieldValue.serverTimestamp(),
                }, { merge: true });
                
                // Now trigger settleEndOfHand to handle confiscation
                console.log(`[onPlayerDeleted] Triggering settleEndOfHand for abandoned game ${tableId}`);
                await settleEndOfHand(tableId);
            }
        }
    } catch (e) {
        console.warn('onPlayerDeleted error', e && e.message);
    }
});

// Cron: every hour clean up idle tables
async function runCleanupIdleTables() {
    try {
        // CLEANUP TIMING: 
        // - ALL tables older than 2 hours: DELETE (abandoned/forgotten)
        // - Finished/empty tables older than 5 minutes: DELETE
        const nowTs = admin.firestore.Timestamp.now();
        const twoHoursAgo = new admin.firestore.Timestamp(nowTs.seconds - 2 * 60 * 60, 0);
        const fiveMinAgo = new admin.firestore.Timestamp(nowTs.seconds - 5 * 60, 0);
        
        const tablesRef = db.collection('tables');
        
        // STEP 1: Delete ALL tables older than 2 hours (regardless of status/type)
        console.log(`[cleanupIdleTables] STEP 1: Looking for tables older than 2 hours...`);
        const veryOldSnap = await tablesRef
            .where('lastActivityAt', '<', twoHoursAgo)
            .get();
        
        console.log(`[cleanupIdleTables] Found ${veryOldSnap.size} tables older than 2 hours`);
        for (const d of veryOldSnap.docs) {
            const tableData = d.data();
            const lastActivity = tableData.lastActivityAt && tableData.lastActivityAt.toDate ? tableData.lastActivityAt.toDate() : null;
            const ageMinutes = lastActivity ? Math.floor((Date.now() - lastActivity.getTime()) / (60 * 1000)) : Infinity;
            
            console.log(`[cleanupIdleTables] Deleting old table ${d.id} (idle ${ageMinutes} min, abandoned)`);
            await cascadeDeleteWaitingTable(d.id);
        }
        
        // STEP 2: Delete empty multiplayer tables older than 5 minutes
        console.log(`[cleanupIdleTables] STEP 2: Looking for empty tables older than 5 minutes...`);
        const emptySnap = await tablesRef
            .where('playerCount', '==', 0)
            .where('lastActivityAt', '<', fiveMinAgo)
            .get();
        
        console.log(`[cleanupIdleTables] Found ${emptySnap.size} empty tables older than 5 minutes`);
        for (const d of emptySnap.docs) {
            // Skip if already deleted in step 1
            if (veryOldSnap.docs.find(doc => doc.id === d.id)) continue;
            
            console.log(`[cleanupIdleTables] Deleting empty table ${d.id}`);
            await cascadeDeleteWaitingTable(d.id);
        }
        
        // STEP 3: Delete finished AI/PvE tables older than 5 minutes
        console.log(`[cleanupIdleTables] STEP 3: Looking for finished AI/PvE tables older than 5 minutes...`);
        const finishedSnap = await tablesRef
            .where('status', '==', 'finished')
            .where('lastActivityAt', '<', fiveMinAgo)
            .get();
        
        console.log(`[cleanupIdleTables] Found ${finishedSnap.size} finished tables older than 5 minutes`);
        for (const d of finishedSnap.docs) {
            // Skip if already deleted in step 1
            if (veryOldSnap.docs.find(doc => doc.id === d.id)) continue;
            
            const tableData = d.data();
            // Skip if blockchain is still processing
            if (tableData.aiMatchResult && tableData.aiMatchResult.processingBlockchain === true) {
                console.log(`[cleanupIdleTables] Skipping table ${d.id} - blockchain still processing`);
                continue;
            }
            
            console.log(`[cleanupIdleTables] Deleting finished table ${d.id}`);
            await cascadeDeleteWaitingTable(d.id);
        }
        
        // NOTE: STEP 4 (auto-forfeit abandoned AI games) removed - now handled by 3x timeout in checkTimeouts
        
        console.log(`[cleanupIdleTables] Cleanup complete`)
    } catch (e) {
        console.error('cleanupIdleTables error', e);
        throw e;
    }
}

// Helper: find only idle/empty table IDs without deleting them
async function findIdleTableIds() {
    const nowTs = admin.firestore.Timestamp.now();
    const fiveMinAgo = new admin.firestore.Timestamp(nowTs.seconds - 5 * 60, 0);
    const tablesRef = db.collection('tables');
    const idsSet = new Set();
    // Multiplayer: empty tables older than 5 minutes
    const mpSnap = await tablesRef
        .where('playerCount', '==', 0)
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    mpSnap.docs.forEach(d => idsSet.add(d.id));
    // AI
    const pveSnap = await tablesRef
        .where('mode', '==', 'ai')
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    pveSnap.docs.forEach(d => idsSet.add(d.id));
    // PvE (alternative schema)
    const pveSnap2 = await tablesRef
        .where('gameType', '==', 'PvE')
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    pveSnap2.docs.forEach(d => idsSet.add(d.id));
    return Array.from(idsSet);
}

// Register schedule trigger (if available) under a dedicated export name so we can also expose an HTTP endpoint
if (onSchedule) {
    try {
        // Run cleanup every hour to reduce costs (vs every 5 minutes)
        exports.cleanupIdleTables_schedule = onSchedule("every 60 minutes", async (event) => {
            await runCleanupIdleTables();
        });
    } catch (e) {
        console.warn('Failed to register scheduled cleanup trigger:', e && e.message);
    }
}

// Expose HTTP endpoints for tests/emulator without colliding with the scheduled function name.
try {
    const ffv1 = require('firebase-functions');
    if (ffv1 && ffv1.https && ffv1.https.onRequest) {
        // Use a distinct name to avoid conflicts with an existing scheduled function named 'cleanupIdleTables'.
        exports.cleanupIdleTablesHttp = ffv1.https.onRequest(async (req, res) => {
            try {
                await runCleanupIdleTables();
                res.status(200).send('OK');
            } catch (e) {
                console.error('cleanupIdleTablesHttp error', e);
                res.status(500).send('ERROR');
            }
        });
    }
} catch (e) {
    // ignore if firebase-functions v1 https isn't available in this environment
}

// (kept intentionally empty; the HTTP endpoint is defined above under cleanupIdleTablesHttp)

// Try registering a v2 https onRequest endpoint for environments using firebase-functions v2
try {
    const v2https = require('firebase-functions/v2/https');
    if (v2https && v2https.onRequest) {
        exports.cleanupIdleTablesV2 = v2https.onRequest(async (req, res) => {
            try {
                await runCleanupIdleTables();
                res.status(200).send('OK');
            } catch (e) {
                console.error('cleanupIdleTablesV2 error', e);
                res.status(500).send('ERROR');
            }
        });
    }
} catch (e) {
    // ignore if v2 https not present
}

// Admin endpoint: dry-run or execute cleanup of ALL tables in Firestore
try {
    const v2https = require('firebase-functions/v2/https');
    exports.adminCleanupTables = v2https.onRequest({ secrets: [ADMIN_TOKEN] }, async (req, res) => {
        try {
            const hdr = req.headers || {};
            const auth = (hdr['authorization'] || hdr['Authorization'] || '').toString();
            const xhdr = (hdr['x-admin-token'] || '').toString();
            const q = (req.query && (req.query.token || req.query.admin_token)) ? String(req.query.token || req.query.admin_token) : '';
            let bodyToken = '';
            try { bodyToken = req.body && typeof req.body === 'object' && (req.body.token || req.body.admin_token) ? String(req.body.token || req.body.admin_token) : ''; } catch(_) {}
            const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            const provided = (xhdr || bearer || q || bodyToken || '').trim();
            const expected = (process.env.ADMIN_TOKEN && String(process.env.ADMIN_TOKEN).trim())
                || ((ADMIN_TOKEN && ADMIN_TOKEN.value) ? (ADMIN_TOKEN.value() || '') : '')
                || '';
            if (!expected || !provided || provided !== expected) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const execute = String(req.query?.execute || req.body?.execute || 'false').toLowerCase() === 'true';
            const snap = await db.collection('tables').get();
            const ids = snap.docs.map(d => d.id);
            if (!execute) {
                return res.json({ ok: true, dryRun: true, count: ids.length, ids });
            }
            // Execute deletion in batches with cascading subcollections
            for (const id of ids) {
                try { await cascadeDeleteWaitingTable(id); } catch (e) { console.warn('Failed to delete table', id, e && e.message); }
            }
            return res.json({ ok: true, dryRun: false, deleted: ids.length });
        } catch (e) {
            console.error('adminCleanupTables error', e);
            return res.status(500).json({ error: String(e?.message || e) });
        }
    });
} catch (e) {
    console.warn('Could not register adminCleanupTables endpoint:', e && e.message);
}

// Admin endpoint: dry-run or execute cleanup of ONLY idle/empty tables
try {
    const v2https = require('firebase-functions/v2/https');
    exports.adminCleanupIdleTables = v2https.onRequest({ secrets: [ADMIN_TOKEN] }, async (req, res) => {
        try {
            const hdr = req.headers || {};
            const auth = (hdr['authorization'] || hdr['Authorization'] || '').toString();
            const xhdr = (hdr['x-admin-token'] || '').toString();
            const q = (req.query && (req.query.token || req.query.admin_token)) ? String(req.query.token || req.query.admin_token) : '';
            let bodyToken = '';
            try { bodyToken = req.body && typeof req.body === 'object' && (req.body.token || req.body.admin_token) ? String(req.body.token || req.body.admin_token) : ''; } catch(_) {}
            const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            const provided = (xhdr || bearer || q || bodyToken || '').trim();
            const expected = (process.env.ADMIN_TOKEN && String(process.env.ADMIN_TOKEN).trim())
                || ((ADMIN_TOKEN && ADMIN_TOKEN.value) ? (ADMIN_TOKEN.value() || '') : '')
                || '';
            if (!expected || !provided || provided !== expected) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const execute = String(req.query?.execute || req.body?.execute || 'false').toLowerCase() === 'true';
            const ids = await findIdleTableIds();
            if (!execute) {
                return res.json({ ok: true, dryRun: true, count: ids.length, ids });
            }
            const results = { ok: true, dryRun: false, attempted: ids.length, deleted: 0, errors: [] };
            for (const id of ids) {
                try {
                    await cascadeDeleteWaitingTable(id);
                    results.deleted++;
                } catch (e) {
                    results.errors.push({ id, error: String(e?.message || e) });
                }
            }
            return res.json(results);
        } catch (e) {
            console.error('adminCleanupIdleTables error', e);
            return res.status(500).json({ error: String(e?.message || e) });
        }
    });
} catch (e) {
    console.warn('Could not register adminCleanupIdleTables endpoint:', e && e.message);
}

// Admin endpoint: purge ALL tables with per-ID verification and detailed result
try {
    const v2https = require('firebase-functions/v2/https');
    exports.adminPurgeAllTables = v2https.onRequest({ secrets: [ADMIN_TOKEN] }, async (req, res) => {
        try {
            const hdr = req.headers || {};
            const auth = (hdr['authorization'] || hdr['Authorization'] || '').toString();
            const xhdr = (hdr['x-admin-token'] || '').toString();
            const q = (req.query && (req.query.token || req.query.admin_token)) ? String(req.query.token || req.query.admin_token) : '';
            let bodyToken = '';
            try { bodyToken = req.body && typeof req.body === 'object' && (req.body.token || req.body.admin_token) ? String(req.body.token || req.body.admin_token) : ''; } catch(_) {}
            const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            const provided = (xhdr || bearer || q || bodyToken || '').trim();
            const expected = (process.env.ADMIN_TOKEN && String(process.env.ADMIN_TOKEN).trim())
                || ((ADMIN_TOKEN && ADMIN_TOKEN.value) ? (ADMIN_TOKEN.value() || '') : '')
                || '';
            if (!expected || !provided || provided !== expected) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const execute = String(req.query?.execute || req.body?.execute || 'false').toLowerCase() === 'true';
            const snap = await db.collection('tables').get();
            const ids = snap.docs.map(d => d.id);
            if (!execute) {
                return res.json({ ok: true, dryRun: true, count: ids.length, ids });
            }
            const results = { ok: true, dryRun: false, attempted: ids.length, deleted: 0, remaining: [], errors: [], idsDeleted: [] };
            for (const id of ids) {
                try {
                    await cascadeDeleteWaitingTable(id);
                    const stillThere = await db.collection('tables').doc(id).get();
                    if (stillThere.exists) {
                        // Try one more pass on subcollections then delete again
                        await deleteCollection(`tables/${id}/players`);
                        await deleteCollection(`tables/${id}/chat`);
                        await deleteCollection(`tables/${id}/game`);
                        await db.collection('tables').doc(id).delete();
                    }
                    const finalCheck = await db.collection('tables').doc(id).get();
                    if (!finalCheck.exists) {
                        results.deleted++;
                        results.idsDeleted.push(id);
                    } else {
                        results.remaining.push(id);
                    }
                } catch (e) {
                    results.errors.push({ id, error: String(e?.message || e) });
                }
            }
            return res.json(results);
        } catch (e) {
            console.error('adminPurgeAllTables error', e);
            return res.status(500).json({ error: String(e?.message || e) });
        }
    });
} catch (e) {
    console.warn('Could not register adminPurgeAllTables endpoint:', e && e.message);
}

// Admin endpoint: configure PD and Vault on-chain using server wallet
try {
    const v2https = require('firebase-functions/v2/https');
    exports.adminConfigContracts = v2https.onRequest({
    secrets: [PRIVATE_KEY, PRIZE_POOL_PK, FUND_SENDER_PK, ADMIN_TOKEN, ADMIN_OWNER_PK]
    }, async (req, res) => {
        try {
            // Extract admin token from multiple sources for robustness
            const hdr = req.headers || {};
            const auth = (hdr['authorization'] || hdr['Authorization'] || '').toString();
            const xhdr = (hdr['x-admin-token'] || '').toString();
            const q = (req.query && (req.query.token || req.query.admin_token)) ? String(req.query.token || req.query.admin_token) : '';
            let bodyToken = '';
            try { bodyToken = req.body && typeof req.body === 'object' && (req.body.token || req.body.admin_token) ? String(req.body.token || req.body.admin_token) : ''; } catch(_) {}
            const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            const provided = (xhdr || bearer || q || bodyToken || '').trim();
            // Prefer environment variable mounted by GCF v2 for secrets, then fallback to params.value()
            const expected = (process.env.ADMIN_TOKEN && String(process.env.ADMIN_TOKEN).trim())
                || ((ADMIN_TOKEN && ADMIN_TOKEN.value) ? (ADMIN_TOKEN.value() || '') : '')
                || '';
            const ok = !!expected && !!provided && provided === expected;
            if (!ok) {
                console.warn('adminConfigContracts forbidden: token mismatch', { providedLen: provided ? provided.length : 0, expectedLen: expected ? expected.length : 0 });
                return res.status(403).json({ error: 'Forbidden' });
            }
            const cfg = getCfg();
            if (!cfg.rpcUrl || !cfg.privateKey || !cfg.prizeDistributor || !cfg.gameVault) {
                return res.status(400).json({ error: 'Missing config', cfg: { rpcUrl: !!cfg.rpcUrl, pk: !!cfg.privateKey, pd: !!cfg.prizeDistributor, vault: !!cfg.gameVault } });
            }
            const { ethers } = require('ethers');
            const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
            // Prefer a one-time ADMIN_OWNER_PK for admin wiring if present; fallback to PRIMARY PRIVATE_KEY
            const sanitizePk = (k) => {
                if (!k) return k;
                let t = String(k).trim();
                t = t.replace(/\r|\n/g, '');
                t = t.replace(/^["']|["']$/g, '');
                if (!t.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(t)) t = '0x' + t;
                return t;
            };
            // Allow override via request for one-time use
            const bodyOwnerPk = sanitizePk((req.body && (req.body.ownerPk || req.body.privateKey)) || '');
            const headerOwnerPk = sanitizePk(req.headers['x-owner-pk'] || '');
            const envOwnerPk = sanitizePk(process.env.ADMIN_OWNER_PK || '');
            if (!cfg.privateKey && !bodyOwnerPk && !headerOwnerPk && !envOwnerPk) {
                return res.status(400).json({ error: 'Missing signer key. Provide ownerPk in request or configure ADMIN_OWNER_PK/PRIVATE_KEY secret.' });
            }
            const ownerPk = bodyOwnerPk || headerOwnerPk || envOwnerPk || '';
            const signerPk = ownerPk || cfg.privateKey;
            let wallet;
            try {
                wallet = new ethers.Wallet(signerPk, provider);
            } catch (err) {
                return res.status(400).json({ error: 'Invalid signer private key supplied', detail: String(err?.message || err) });
            }
            const ownerPkSource = bodyOwnerPk ? 'body' : (headerOwnerPk ? 'header' : (envOwnerPk ? 'secret-admin-owner-pk' : 'privateKey'));
            const signerAddr = await wallet.getAddress();
            if (cfg.owner) {
                try {
                    const expectedOwner = ethers.getAddress(cfg.owner);
                    if (expectedOwner.toLowerCase() !== signerAddr.toLowerCase()) {
                        console.warn('adminSetRakeForTables: signer does not match configured owner', { expectedOwner, signerAddr });
                    }
                } catch (_) {
                    console.warn('adminSetRakeForTables: configured owner address invalid', { owner: cfg.owner });
                }
            }
            let expectedOwner = null;
            if (cfg.owner) {
                try { expectedOwner = ethers.getAddress(cfg.owner); } catch (_) { expectedOwner = null; }
                if (expectedOwner && expectedOwner.toLowerCase() !== signerAddr.toLowerCase()) {
                    console.warn('adminConfigContracts: signer does not match configured owner', { expectedOwner, signerAddr });
                }
            }

            // PrizeDistributor ABI (only needed functions)
            const PD_ABI = [
                'function setGameServer(address) external',
                'function setAuthorizedVault(address,bool) external',
                'function gameServerAddress() view returns (address)',
                'function owner() view returns (address)'
            ];
            const pd = new ethers.Contract(cfg.prizeDistributor, PD_ABI, wallet);

            // Vault ABI from artifacts (preferred), otherwise fallback to a minimal inline ABI for admin config
            let vaultAbi = loadVaultAbi();
            if (!vaultAbi) {
                vaultAbi = [
                    // Minimal methods needed for admin configuration
                    'function setPrizeDistributor(address _prizeDistributor) external',
                    'function setTrustedDepositor(address depositor, bool allowed) external',
                    'function setSmallestUnitsPerChip(address token, uint256 units) external',
                    'function setTokenAllowed(address token, bool allowed) external',
                    'function owner() view returns (address)'
                ];
            }
            const vault = new ethers.Contract(cfg.gameVault, vaultAbi, wallet);

            const results = [];

            // Preflight: capture ownership info to help diagnose permission errors
            let pdOwner = null, vaultOwner = null, currentGs = null;
            try { currentGs = await pd.gameServerAddress(); } catch (_) {}
            try { pdOwner = await pd.owner(); } catch (_) {}
            try { vaultOwner = await vault.owner(); } catch (_) {}

            const targetGameServer = cfg.gameServer || signerAddr;
            const trustedDepositors = [];
            const pushUnique = (addr) => {
                if (!addr) return;
                const norm = addr.toLowerCase();
                if (trustedDepositors.find((a) => a.toLowerCase() === norm)) return;
                trustedDepositors.push(addr);
            };
            pushUnique(signerAddr);
            pushUnique(cfg.gameServer);
            pushUnique(cfg.gameEntry);
            if (cfg.prizePoolKey) {
                try { pushUnique(ethers.computeAddress(cfg.prizePoolKey)); } catch (_) {}
            }
            if (cfg.fundWalletKey) {
                try { pushUnique(ethers.computeAddress(cfg.fundWalletKey)); } catch (_) {}
            }

            // PD: set game server and authorize vault
            try {
                const tx = await pd.setGameServer(targetGameServer);
                const rc = await tx.wait();
                results.push({ action: 'pd.setGameServer', address: targetGameServer, tx: tx.hash, status: rc?.status });
            } catch (e) { results.push({ action: 'pd.setGameServer', error: String(e?.reason || e?.message || e) }); }
            try {
                const tx = await pd.setAuthorizedVault(cfg.gameVault, true);
                const rc = await tx.wait();
                results.push({ action: 'pd.setAuthorizedVault', tx: tx.hash, status: rc?.status });
            } catch (e) { results.push({ action: 'pd.setAuthorizedVault', error: String(e?.reason || e?.message || e) }); }

            // Vault: set PD, trusted depositor, token rules, units
            try {
                const tx = await vault.setPrizeDistributor(cfg.prizeDistributor);
                const rc = await tx.wait();
                results.push({ action: 'vault.setPrizeDistributor', tx: tx.hash, status: rc?.status });
            } catch (e) { results.push({ action: 'vault.setPrizeDistributor', error: String(e?.reason || e?.message || e) }); }
            for (const addr of trustedDepositors) {
                try {
                    const tx = await vault.setTrustedDepositor(addr, true);
                    const rc = await tx.wait();
                    results.push({ action: 'vault.setTrustedDepositor', address: addr, tx: tx.hash, status: rc?.status });
                } catch (e) { results.push({ action: 'vault.setTrustedDepositor', address: addr, error: String(e?.reason || e?.message || e) }); }
            }

            // Units per chip: LYX 1e16, LSP7 1e21 (if configured)
            try {
                const tx = await vault.setSmallestUnitsPerChip(ethers.ZeroAddress, '10000000000000000');
                const rc = await tx.wait();
                results.push({ action: 'vault.setSmallestUnitsPerChip(LYX)', tx: tx.hash, status: rc?.status });
            } catch (e) { results.push({ action: 'vault.setSmallestUnitsPerChip(LYX)', error: String(e?.reason || e?.message || e) }); }
            if (cfg.allowedLsp7) {
                try {
                    const tx1 = await vault.setTokenAllowed(cfg.allowedLsp7, true);
                    const rc1 = await tx1.wait();
                    results.push({ action: 'vault.setTokenAllowed(LSP7)', tx: tx1.hash, status: rc1?.status });
                } catch (e) { results.push({ action: 'vault.setTokenAllowed(LSP7)', error: String(e?.reason || e?.message || e) }); }
                try {
                    const tx2 = await vault.setSmallestUnitsPerChip(cfg.allowedLsp7, '1000000000000000000000');
                    const rc2 = await tx2.wait();
                    results.push({ action: 'vault.setSmallestUnitsPerChip(LSP7)', tx: tx2.hash, status: rc2?.status });
                } catch (e) { results.push({ action: 'vault.setSmallestUnitsPerChip(LSP7)', error: String(e?.reason || e?.message || e) }); }
            }

            const net = await provider.getNetwork();
            const chainId = (() => {
                try {
                    const x = net && net.chainId;
                    if (typeof x === 'bigint') return x.toString();
                    if (x && typeof x.toString === 'function') return x.toString();
                    return String(x);
                } catch { return '' + (net && net.chainId); }
            })();
            return res.json({
                ok: true,
                signer: signerAddr,
                signerSource: ownerPkSource,
                expectedOwner,
                network: chainId,
                pd: cfg.prizeDistributor,
                vault: cfg.gameVault,
                pdOwner,
                vaultOwner,
                currentGameServer: currentGs,
                configuredGameServer: targetGameServer,
                configuredDepositors: trustedDepositors,
                signerIsPdOwner: pdOwner ? (pdOwner.toLowerCase() === signerAddr.toLowerCase()) : undefined,
                signerIsVaultOwner: vaultOwner ? (vaultOwner.toLowerCase() === signerAddr.toLowerCase()) : undefined,
                results
            });
        } catch (e) {
            console.error('adminConfigContracts error', e);
            return res.status(500).json({ error: String(e?.message || e) });
        }
    });
} catch (e) {
    console.warn('Could not register adminConfigContracts endpoint:', e && e.message);
}

// serverDeposit endpoint has been removed. All deposits are client-side only now.

// Admin endpoint: set rake for all tables and/or set token rake defaults (e.g., 3%).
// Gated by ADMIN_TOKEN; supports ownerPk override and UP KeyManager routing when Vault owner is a UP.
try {
    const v2https = require('firebase-functions/v2/https');
    exports.adminSetRakeForTables = v2https.onRequest({
    secrets: [RPC_URL, PRIVATE_KEY, PRIZE_POOL_PK, FUND_SENDER_PK, GAME_VAULT, ADMIN_TOKEN, ADMIN_OWNER_PK],
        invoker: 'public'
    }, async (req, res) => {
        try {
            if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

            // Token gating (reuse robust extraction approach)
            const hdr = req.headers || {};
            const auth = (hdr['authorization'] || hdr['Authorization'] || '').toString();
            const xhdr = (hdr['x-admin-token'] || '').toString();
            const q = (req.query && (req.query.token || req.query.admin_token)) ? String(req.query.token || req.query.admin_token) : '';
            let bodyToken = '';
            try { bodyToken = req.body && typeof req.body === 'object' && (req.body.token || req.body.admin_token) ? String(req.body.token || req.body.admin_token) : ''; } catch(_) {}
            const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            const provided = (xhdr || bearer || q || bodyToken || '').trim();
            const expected = (process.env.ADMIN_TOKEN && String(process.env.ADMIN_TOKEN).trim())
                || ((ADMIN_TOKEN && ADMIN_TOKEN.value) ? (ADMIN_TOKEN.value() || '') : '')
                || '';
            if (!expected || !provided || provided !== expected) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const cfg = getCfg();
            if (!cfg.rpcUrl || !cfg.gameVault) return res.status(400).json({ error: 'Missing config', cfg: { rpcUrl: !!cfg.rpcUrl, vault: !!cfg.gameVault } });

            const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
            const sanitizePk = (k) => {
                if (!k) return '';
                let t = String(k).trim();
                t = t.replace(/\r|\n/g, '');
                t = t.replace(/^['"]|['"]$/g, '');
                if (!t.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(t)) t = '0x' + t;
                return t;
            };
            const isValidPk = (k) => typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k);
            const bodyOwnerPk = sanitizePk((req.body && (req.body.ownerPk || req.body.privateKey)) || '');
            const headerOwnerPk = sanitizePk(req.headers['x-owner-pk'] || '');
            const envOwnerPk = sanitizePk(process.env.ADMIN_OWNER_PK || '');
            const candidatePks = [bodyOwnerPk, headerOwnerPk, envOwnerPk].filter(isValidPk);
            const signerPk = candidatePks[0] || cfg.privateKey;
            if (!isValidPk(signerPk)) return res.status(400).json({ error: 'Invalid or missing signer private key. Provide ownerPk in request or rotate secrets.' });
            const wallet = new ethers.Wallet(signerPk, provider);
            const signerAddr = await wallet.getAddress();

            // Vault ABI (prefer artifacts via loadVaultAbi)
            let vaultAbi = loadVaultAbi();
            if (!vaultAbi) {
                vaultAbi = [
                    'function owner() view returns (address)',
                    'function setTableConfig(uint256 tableId, address ownerWallet, uint16 rakeBps) external',
                    'function setTokenRakeBps(address token, uint16 rakeBps) external'
                ];
            }
            const vault = new ethers.Contract(cfg.gameVault, vaultAbi, wallet);

            // Owner + UP routing check
            let vaultOwner = null; try { vaultOwner = await vault.owner(); } catch {}
            const isOwnerContract = vaultOwner ? ((await provider.getCode(vaultOwner)) !== '0x') : false;
            const needsUP = isOwnerContract && (vaultOwner.toLowerCase() !== signerAddr.toLowerCase());
            async function executeViaUP(upAddr, to, data) {
                const UP_ABI = [
                    'function execute(uint256 operationType, address to, uint256 value, bytes data) external payable returns (bytes)',
                    'function owner() view returns (address)'
                ];
                const KM_ABI = ['function execute(bytes calldata payload) external payable returns (bytes)'];
                const up = new ethers.Contract(upAddr, UP_ABI, provider);
                const keyManager = await up.owner();
                const km = new ethers.Contract(keyManager, KM_ABI, wallet);
                const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, to, 0, data]);
                const tx = await km.execute(payload);
                const rc = await tx.wait();
                return { tx: tx.hash, status: rc?.status };
            }

            // Inputs
            const houseWallet = String(req.body?.houseWallet || '').trim();
            const rakeBps = Number(req.body?.rakeBps || 300);
            const setDefaults = String(req.body?.setDefaults || '').toLowerCase() === 'true' || req.body?.setDefaults === true;
            let tokensForDefaults = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
            // Include configured LSP7 if present
            if (cfg.allowedLsp7 && typeof cfg.allowedLsp7 === 'string' && cfg.allowedLsp7.length === 42) tokensForDefaults = [...tokensForDefaults, cfg.allowedLsp7];
            const mapping = String(req.body?.mapping || 'parse').toLowerCase(); // 'parse' | 'keccak'
            let tableIds = Array.isArray(req.body?.tableIds) ? req.body.tableIds : null;

            if (!Number.isFinite(rakeBps) || rakeBps < 0 || rakeBps > 10000) return res.status(400).json({ error: 'rakeBps must be 0..10000' });
            if (!houseWallet || !ethers.isAddress(houseWallet)) return res.status(400).json({ error: 'houseWallet required and must be a valid address' });

            function toOnchainId(raw) {
                if (mapping === 'keccak') {
                    const hex = ethers.keccak256(ethers.toUtf8Bytes(String(raw)));
                    return BigInt(hex);
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) return BigInt(n);
                const hex = ethers.keccak256(ethers.toUtf8Bytes(String(raw)));
                return BigInt(hex);
            }

            const results = [];

            // Token-wide defaults (includes LYX = address(0) and optionally WBSTR)
            if (setDefaults) {
                const unique = Array.from(new Set([ethers.ZeroAddress, ...tokensForDefaults.filter(t => t && ethers.isAddress(t)).map(t => t.toLowerCase())]));
                for (const tok of unique) {
                    try {
                        const data = (vault.interface && vault.interface.encodeFunctionData)
                            ? vault.interface.encodeFunctionData('setTokenRakeBps', [tok, rakeBps])
                            : new ethers.Interface(vaultAbi).encodeFunctionData('setTokenRakeBps', [tok, rakeBps]);
                        if (needsUP) {
                            const r = await executeViaUP(vaultOwner, cfg.gameVault, data);
                            results.push({ action: 'setTokenRakeBps', token: tok, ...r });
                        } else {
                            const tx = await vault.setTokenRakeBps(tok, rakeBps);
                            const rc = await tx.wait();
                            results.push({ action: 'setTokenRakeBps', token: tok, tx: tx.hash, status: rc?.status });
                        }
                    } catch (e) {
                        results.push({ action: 'setTokenRakeBps', token: tok, error: String(e?.reason || e?.message || e) });
                    }
                }
            }

            // Determine tables to configure
            if (!Array.isArray(tableIds) || tableIds.length === 0) {
                // List tables from Firestore
                try {
                    const snap = await db.collection('tables').get();
                    tableIds = snap.docs.map(d => d.id);
                } catch (e) {
                    return res.status(500).json({ error: 'Failed to list tables from Firestore', detail: String(e?.message || e) });
                }
            }

            for (const rawId of tableIds) {
                try {
                    const onchainId = toOnchainId(rawId);
                    const data = (vault.interface && vault.interface.encodeFunctionData)
                        ? vault.interface.encodeFunctionData('setTableConfig', [onchainId, houseWallet, rakeBps])
                        : new ethers.Interface(vaultAbi).encodeFunctionData('setTableConfig', [onchainId, houseWallet, rakeBps]);
                    if (needsUP) {
                        const r = await executeViaUP(vaultOwner, cfg.gameVault, data);
                        results.push({ action: 'setTableConfig', tableId: String(onchainId), rawId, ...r });
                    } else {
                        const tx = await vault.setTableConfig(onchainId, houseWallet, rakeBps);
                        const rc = await tx.wait();
                        results.push({ action: 'setTableConfig', tableId: String(onchainId), rawId, tx: tx.hash, status: rc?.status });
                    }
                } catch (e) {
                    results.push({ action: 'setTableConfig', rawId, error: String(e?.reason || e?.message || e) });
                }
            }

            return res.json({ ok: true, vault: cfg.gameVault, owner: vaultOwner, signer: signerAddr, needsUP, count: tableIds.length, results });
        } catch (e) {
            console.error('adminSetRakeForTables error', e);
            return res.status(500).json({ error: String(e?.message || e) });
        }
    });
} catch (e) {
    console.warn('Could not register adminSetRakeForTables endpoint:', e && e.message);
}

// --- Card parsing & simple strength heuristics for bots ---
const RANK_MAP = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
function parseCard(cs) { return { r: cs[0], s: cs[1], v: RANK_MAP[cs[0]] }; }
function isSuited(a,b) { return a.s === b.s; }
function isPair(a,b) { return a.v === b.v; }
function isConnected(a,b) { const d = Math.abs(a.v - b.v); return d === 1 || (a.v === 14 && b.v === 5) || (b.v === 14 && a.v === 5); }
function preflopScore(c1s, c2s) {
    if (!c1s || !c2s) return 0.2;
    const a = parseCard(c1s), b = parseCard(c2s);
    const hi = a.v >= b.v ? a : b, lo = a.v >= b.v ? b : a;
    const suited = isSuited(a,b);
    const pair = isPair(a,b);
    const connected = isConnected(a,b);
    let score = 0;
    if (pair) {
        // 22..AA ~ 0.35..0.95
        score = 0.35 + (hi.v - 2) / 20;
    } else {
        const broadwayCount = (hi.v >= 10 ? 1 : 0) + (lo.v >= 10 ? 1 : 0);
        score = broadwayCount * 0.18; // two broadways ~0.36
        if (suited) score += 0.08;
        if (connected) score += 0.06;
        score += (hi.v - 10) * 0.02; // A,K,Q,J bonus via hi card
    }
    return Math.max(0.02, Math.min(0.98, score));
}
function boardHasFlushDraw(hole, board) {
    const all = [...hole, ...board].map(parseCard);
    const counts = all.reduce((m,c)=> (m[c.s]=(m[c.s]||0)+1, m), {});
    return Object.values(counts).some(n => n >= 4);
}
function boardHasOpenEndedStraightDraw(hole, board) {
    const all = [...hole, ...board].map(c=>parseCard(c).v);
    const uniq = Array.from(new Set(all)).sort((a,b)=>a-b);
    if ([14,2,3,4,5].every(v => uniq.includes(v))) return true; // wheel potential
    for (let i=0;i<uniq.length;i++) {
        let run = 1;
        for (let j=i+1;j<uniq.length;j++) {
            if (uniq[j] === uniq[j-1]+1) { run++; if (run >= 4) return true; }
            else if (uniq[j] !== uniq[j-1]) { run = 1; }
        }
    }
    return false;
}
function postflopStrength(hole, board) {
    // Combine made hand category with draw bonuses (rough heuristic 0..1)
    try {
        const solved = Hand.solve([...hole, ...board]);
        const cat = solved?.rank || 1; // 1..9
        let base = Math.max(0.1, Math.min(1, (cat - 1) / 8));
        if (boardHasFlushDraw(hole, board)) base += 0.12;
        if (boardHasOpenEndedStraightDraw(hole, board)) base += 0.08;
        return Math.min(1, base);
    } catch (_) {
        return 0.3;
    }
}

// Classify board texture for c-bet/barrel logic: 'dry' | 'semi' | 'wet'
function boardTexture(board) {
    if (!board || board.length < 3) return 'unknown';
    const cards = board.map(parseCard);
    const suitCounts = cards.reduce((m, c) => (m[c.s] = (m[c.s] || 0) + 1, m), {});
    const counts = Object.values(suitCounts).sort((a,b)=>b-a);
    const values = cards.map(c=>c.v).sort((a,b)=>a-b);
    let run = 1, maxRun = 1;
    for (let i=1;i<values.length;i++) {
        if (values[i] === values[i-1]) continue;
        if (values[i] === values[i-1] + 1) {
            run++; maxRun = Math.max(maxRun, run);
        } else run = 1;
    }
    const paired = new Set(values).size < values.length;
    const monotone = counts[0] >= 3;
    const twoTone = !monotone && counts[0] === 2;
    // Wet if monotone or very connected or paired+twoTone
    if (monotone || maxRun >= 3 || (paired && twoTone)) return 'wet';
    if (twoTone || paired) return 'semi';
    return 'dry';
}

// --- Helpers: Players & Turns ---
function orderPlayersByCreated(snapDocs) {
    return snapDocs
        .slice()
        .sort((a,b) => {
            const ta = get(a.data(), 'createdAt._seconds', 0);
            const tb = get(b.data(), 'createdAt._seconds', 0);
            return ta - tb;
        })
        .map(d => d.id);
}

// Difficulty-aware bot with position-aware preflop and texture-aware sizing
function chooseBotAction(game, player) {
    const phase = String(game.phase || 'preflop');
    const toCall = Math.max(0, (game.currentBet || 0) - (player.bet || 0));
    const pot = Math.max(0, game.pot || 0);
    const stack = Math.max(0, player.stack || 0);
    const minRaise = Math.max(0, game.minRaise || 0);
    const hole = player.hole || [];
    const board = game.board || [];
    const diff = String(player.aiDifficulty || 'easy').toLowerCase();

    // Difficulty profiles tuned toward target percentiles
    // Easy: Beginner should win ~50% - loose passive (calls too much, raises too little)
    // Medium: Average player should win ~40-50% - solid ABC poker
    // Hard: Experienced player should win ~30-40% - aggressive with good balance
    const cfg = ({
        easy:   { agg: 0.30, bluff: 0.08, size: 0.45, callSlack: 0.95, sizeNoise: 0.14 },  // Loose passive
        medium: { agg: 0.75, bluff: 0.20, size: 0.75, callSlack: 1.00, sizeNoise: 0.06 },  // Solid, balanced
        hard:   { agg: 1.05, bluff: 0.38, size: 1.05, callSlack: 1.20, sizeNoise: 0.03 },  // Very aggressive, tough
    })[diff] || { agg: 0.30, bluff: 0.08, size: 0.45, callSlack: 0.95, sizeNoise: 0.14 };

    // Identify player id by reference and compute rough position bucket
    const ids = Array.isArray(game.order) ? game.order.filter(id => !!game.players[id]) : Object.keys(game.players || {});
    const pid = ids.find(id => game.players[id] === player) || ids[0];
    const dealerIdx = ids.indexOf(game.dealer);
    const order = [];
    for (let i = 1; i <= ids.length; i++) order.push(ids[(dealerIdx + i) % ids.length]);
    const posIdx = Math.max(0, order.indexOf(pid));
    const isBTN = order[posIdx] === game.dealer;
    const isSB = order[posIdx] === game.smallBlind;
    const isBB = order[posIdx] === game.bigBlind;
    const n = order.length;
    let posBucket = 'MP';
    if (n <= 2) posBucket = isBB ? 'HU-BB' : 'HU-SB';
    else if (isBTN) posBucket = 'BTN';
    else if (isSB) posBucket = 'SB';
    else if (isBB) posBucket = 'BB';
    else if (posIdx - 2 <= Math.floor((n - 2) * 0.33)) posBucket = 'EP';
    else if (posIdx - 2 >= Math.floor((n - 2) * 0.66)) posBucket = 'LP';

    // Helpers
    const suited = hole[0] && hole[1] && isSuited(parseCard(hole[0]), parseCard(hole[1]));
    const connected = hole[0] && hole[1] && isConnected(parseCard(hole[0]), parseCard(hole[1]));
    const isPreflopUnraised = () => {
        if (phase !== 'preflop') return false;
        const bbBet = (game.players?.[game.bigBlind]?.bet) || 0;
        if ((game.currentBet || 0) !== bbBet) return false;
        for (const [id, p] of Object.entries(game.players)) {
            if (id === game.smallBlind || id === game.bigBlind) continue;
            if ((p.bet || 0) > 0) return false;
        }
        return true;
    };

    // Strength estimate 0..1 and pot-odds threshold
    const strength = phase === 'preflop' ? preflopScore(hole[0], hole[1]) : postflopStrength(hole, board);
    const need = (toCall > 0) ? (toCall / Math.max(1, pot + toCall)) : 0;

    // Free-to-bet branches
    if (toCall === 0) {
        if (phase === 'preflop') {
            // BB option: mostly check; Hard raises more with good hands
            const bbRaiseThresh = diff === 'hard' ? 0.60 : diff === 'medium' ? 0.67 : 0.80;  // Medium defends better, Easy very tight
            const willRaise = !isPreflopUnraised() ? false : (strength > bbRaiseThresh && Math.random() < cfg.agg);
            if (!willRaise || stack <= minRaise) return { action: 'check', amount: 0 };
            const base = Math.max(pot, game.currentBet || minRaise);
            const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
            // Preflop open size slightly larger for Hard
            let raiseAmt = Math.max(minRaise, Math.floor(base * (diff === 'hard' ? Math.max(cfg.size, 0.95) : cfg.size) * noise));
            raiseAmt = Math.min(raiseAmt, stack);
            if (raiseAmt >= minRaise) return { action: 'raise', amount: raiseAmt };
            return { action: 'check', amount: 0 };
        } else {
            // Postflop probing/valuing with draw awareness
            const drawy = boardHasFlushDraw(hole, board) || boardHasOpenEndedStraightDraw(hole, board);
            const tex = boardTexture(board);
            const texAdj = tex === 'dry' ? -0.03 : tex === 'wet' ? 0.04 : 0.0;
            const threshold = 0.52 - cfg.agg * 0.12 + texAdj + (drawy ? -0.02 : 0.00);
            const smallPotBias = pot <= Math.max(3 * (game.minRaise || 0), 60) ? (diff === 'hard' ? 0.12 : diff === 'medium' ? 0.1 : 0.06) : 0;
            const willBet = (strength + Math.random() * 0.2 + smallPotBias) > threshold || Math.random() < cfg.bluff * (drawy ? 0.6 : 0.4);
            if (!willBet || stack <= (game.minRaise || 0)) return { action: 'check', amount: 0 };
            const base = Math.max(pot, game.currentBet || 0);
            const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
            // Street-aware sizing: smaller on very dry boards, larger on wet
            const streetMult = game.phase === 'flop' ? (tex === 'dry' ? 0.8 : tex === 'wet' ? 1.1 : 1.0)
                              : game.phase === 'turn' ? (tex === 'dry' ? 0.9 : tex === 'wet' ? 1.15 : 1.05)
                              : (tex === 'dry' ? 0.95 : tex === 'wet' ? 1.2 : 1.1);
            const target = Math.max((game.minRaise || 0), Math.floor(base * cfg.size * streetMult * noise));
            const amt = Math.min(stack, target);
            if (amt < (game.minRaise || 0)) return { action: 'check', amount: 0 };
            return { action: 'bet', amount: amt };
        }
    }

    // Preflop logic when facing a decision
    if (phase === 'preflop') {
        // Opening thresholds by position - realistic ranges
        const openThresh = (() => {
            if (diff === 'hard') return { EP: 0.52, MP: 0.47, LP: 0.40, BTN: 0.36, SB: 0.42, BB: 0.999, 'HU-SB': 0.44, 'HU-BB': 0.999 }[posBucket] || 0.46;  // Wide aggressive ranges
            if (diff === 'medium') return { EP: 0.58, MP: 0.52, LP: 0.46, BTN: 0.42, SB: 0.48, BB: 0.999, 'HU-SB': 0.50, 'HU-BB': 0.999 }[posBucket] || 0.52;  // Solid ABC ranges
            return { EP: 0.63, MP: 0.58, LP: 0.52, BTN: 0.47, SB: 0.54, BB: 0.999, 'HU-SB': 0.56, 'HU-BB': 0.999 }[posBucket] || 0.58;  // Loose passive
        })();

        const allowLimp = (diff === 'easy' && Math.random() < 0.20);  // Easy limps sometimes (passive play)

        if (isPreflopUnraised()) {
            if (strength >= openThresh) {
                const base = Math.max(pot, game.currentBet || minRaise);
                const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
                let raiseAmt = Math.max(minRaise, Math.floor(base * cfg.size * noise));
                raiseAmt = Math.min(raiseAmt, stack);
                if (raiseAmt >= minRaise) return { action: 'raise', amount: raiseAmt };
            }
            if (allowLimp && toCall > 0 && toCall <= Math.min(stack, minRaise)) return { action: 'call', amount: 0 };
            if (toCall > 0) return { action: 'fold', amount: 0 };
            return { action: 'check', amount: 0 };
        }

        // Facing a raise preflop: 3-bet value or occasional bluff for Medium/Hard
        const canRaise = stack > toCall + minRaise;
        const threeBetThresh = diff === 'hard' ? 0.65 : diff === 'medium' ? 0.70 : 0.85;  // Easy very tight on 3-betting
        const threeBetBluff = (diff === 'hard' || (diff === 'medium' && Math.random() < 0.4)) && (suited || connected) && strength >= 0.40 && strength <= 0.56 && Math.random() < (diff === 'hard' ? 0.28 : 0.15);  // Medium also bluff 3-bets
        if (canRaise && (strength >= threeBetThresh || threeBetBluff) && Math.random() < cfg.agg) {
            const base = pot + toCall;
            const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
            let raiseAmt = Math.max(minRaise, Math.floor(base * (diff === 'hard' ? 1.05 : diff === 'medium' ? 0.90 : cfg.size) * noise));
            raiseAmt = Math.min(raiseAmt, stack - toCall);
            if (raiseAmt >= minRaise) return { action: 'raise', amount: raiseAmt };
        }
        // 4-bet for value on Medium/Hard with premium strength
        if ((diff === 'hard' || diff === 'medium') && canRaise && strength >= (diff === 'hard' ? 0.78 : 0.83) && Math.random() < Math.min(1, cfg.agg * 0.85)) {
            const base = pot + toCall;
            const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
            let raiseAmt = Math.max(minRaise, Math.floor(base * (diff === 'hard' ? 1.20 : 1.10) * noise));
            raiseAmt = Math.min(raiseAmt, stack - toCall);
            if (raiseAmt >= minRaise) return { action: 'raise', amount: raiseAmt };
        }
        
        // Defending logic: realistic defense vs raises based on hand quality and situation
        // Don't auto-fold good hands, but DO fold trash
        const raiseSize = toCall / Math.max(1, pot);  // How big is the raise relative to pot
        
        // Base defend thresholds by difficulty (what % of hands to continue with)
        // These represent "calling range" - hands good enough to continue
        let minDefendStrength = 0.40;  // Base: need at least 40% hand strength to continue
        
        // Adjust for raise sizing - bigger raises need stronger hands
        if (raiseSize <= 0.5) minDefendStrength -= 0.05;  // Small raise: can call lighter
        else if (raiseSize > 1.5) minDefendStrength += 0.12;  // Big overbet: need strong hand
        
        // Difficulty adjustments - how they respond to pressure
        if (diff === 'easy') {
            minDefendStrength -= 0.03;  // Slightly looser (call a bit more)
        } else if (diff === 'hard') {
            minDefendStrength -= 0.06;  // Defend wider (don't give up easily)
        }
        // Medium stays at baseline
        
        // Position matters - defend wider in position (have initiative)
        if (posBucket === 'BTN') minDefendStrength -= 0.06;
        else if (posBucket === 'LP') minDefendStrength -= 0.03;
        else if (posBucket === 'EP') minDefendStrength += 0.04;
        
        // Premium speculative hands (suited/connected) get bonus
        const hasSpeculativeValue = (suited && strength >= 0.35) || (connected && strength >= 0.30);
        if (hasSpeculativeValue) minDefendStrength -= 0.05;
        
        // Final decision: call if hand is good enough OR if pot odds are great
        const handGoodEnough = strength >= minDefendStrength;
        const potOddsGreat = strength >= need * cfg.callSlack;
        
        if ((handGoodEnough || potOddsGreat) && toCall <= stack) return { action: 'call', amount: 0 };
        
        // Otherwise fold - hand too weak to continue
        return { action: 'fold', amount: 0 };
    }

    // Postflop: facing action
    const canRaise = stack > toCall + minRaise;
    const wantRaise = (strength > (diff === 'hard' ? 0.64 : diff === 'medium' ? 0.68 : 0.72) && Math.random() < cfg.agg) || (strength > (diff === 'hard' ? 0.80 : 0.83));
    if (canRaise && wantRaise) {
        const base = pot + toCall;
        const tex = boardTexture(board);
        const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
        const streetMult = game.phase === 'flop' ? (tex === 'dry' ? 0.85 : tex === 'wet' ? 1.20 : 1.0)
                          : game.phase === 'turn' ? (tex === 'dry' ? 0.90 : tex === 'wet' ? 1.25 : 1.05)
                          : (tex === 'dry' ? 0.95 : tex === 'wet' ? 1.30 : 1.1);
        let raiseAmt = Math.max(minRaise, Math.floor(base * cfg.size * streetMult * noise));
        raiseAmt = Math.min(raiseAmt, stack - toCall);
        if (raiseAmt >= minRaise) return { action: 'raise', amount: raiseAmt };
    }

    // Pot-odds informed call decision with draw awareness
    const drawy = boardHasFlushDraw(hole, board) || boardHasOpenEndedStraightDraw(hole, board);
    const drawBonus = drawy ? 0.15 : 0;
    const callOK = (strength + drawBonus) >= need * cfg.callSlack;
    if (callOK && toCall <= stack) return { action: 'call', amount: 0 };

    // Occasional Medium/Hard bluff-raise vs. small bets
    if ((diff === 'hard' || diff === 'medium') && canRaise && toCall <= Math.max(minRaise, Math.floor(pot * (diff === 'hard' ? 0.35 : 0.28))) && Math.random() < cfg.bluff) {
        const tex = boardTexture(board);
        const noise = 1 + (Math.random() * 2 * cfg.sizeNoise - cfg.sizeNoise);
        const mult = tex === 'dry' ? 0.60 : tex === 'wet' ? 0.80 : 0.70;
        const r = Math.min(stack - toCall, Math.max(minRaise, Math.floor((pot + toCall) * mult * noise)));
        if (r >= minRaise) return { action: 'raise', amount: r };
    }
    return { action: 'fold', amount: 0 };
}

// If current turn belongs to a bot, auto-act
async function maybeAutoAct(tableId) {
    try {
        const { data: game } = await loadGame(tableId);
        const pid = game.turn;
        if (!pid) return;
        const p = game.players && game.players[pid];
    if (!p || !p.bot || !p.inHand || p.folded || isPlayerAllIn(p)) return;
    // Add a small human-like delay before bot acts
    const diff = String(p.aiDifficulty || 'easy').toLowerCase();
    const baseDelay = diff === 'hard' ? 200 : diff === 'medium' ? 300 : 400;
    const jitter = Math.floor(150 + Math.random() * 400);
    await new Promise(res => setTimeout(res, baseDelay + jitter));
    const { action, amount } = chooseBotAction(game, p);
        console.log(`Bot ${pid} [${diff}] auto-acts: ${action}${amount ? ' ' + amount : ''}`);
        await applyPlayerAction(tableId, pid, action, amount || 0);
    } catch (e) {
        console.error('maybeAutoAct error', e);
    }
}

function isPlayerAllIn(player) {
    if (!player || !player.inHand || player.folded) return false;
    return (player.allIn === true) || ((player.stack || 0) <= 0);
}

function activePlayers(game) {
    return Object.entries(game.players)
        .filter(([, p]) => p.inHand && !p.folded)
        .map(([id]) => id);
}

function computePotLayers(game) {
    if (!game || !game.players) return { layers: [], total: 0 };
    const contribs = Object.fromEntries(
        Object.entries(game.players).map(([pid, p]) => [pid, Math.max(0, p.contrib || 0)])
    );
    const levels = Array.from(new Set(Object.values(contribs).filter((v) => v > 0))).sort((a, b) => a - b);
    if (!levels.length) {
        return { layers: [], total: 0 };
    }
    const allIds = Array.isArray(game.order) ? game.order.filter((id) => !!game.players[id]) : Object.keys(game.players);
    const activeSet = new Set(activePlayers(game));
    const layers = [];
    let prev = 0;
    for (const level of levels) {
        const chunk = level - prev;
        if (chunk <= 0) {
            prev = level;
            continue;
        }
        const contributors = allIds.filter((id) => (contribs[id] || 0) >= level);
        if (!contributors.length) {
            prev = level;
            continue;
        }
        const amount = chunk * contributors.length;
        const eligible = contributors.filter((id) => activeSet.has(id));
        layers.push({ level, amount, chunk, contributors, eligible });
        prev = level;
    }
    const total = Object.values(contribs).reduce((sum, value) => sum + value, 0);
    return { layers, total, contribs };
}

function updatePotAggregates(game) {
    const { layers, total } = computePotLayers(game);
    const sideLayers = layers.length > 1 ? layers.slice(1).filter((layer) => layer.eligible.length >= 2) : [];
    game.sidePots = sideLayers.map((layer) => layer.amount);
    game.pot = total;
    return { layers, total };
}

function nextActivePlayerId(game, fromPlayerId) {
    const ids = Array.isArray(game.order) ? game.order.filter(id => !!game.players[id]) : Object.keys(game.players);
    const start = ids.indexOf(fromPlayerId);
    for (let i = 1; i <= ids.length; i++) {
        const idx = (start + i) % ids.length;
        const pid = ids[idx];
        const p = game.players[pid];
        if (p && p.inHand && !p.folded && !isPlayerAllIn(p)) return pid;
    }
    return null;
}

function resetBetsForNewRound(game) {
    for (const pid of Object.keys(game.players)) {
        const player = game.players[pid];
        player.bet = 0;
        player.acted = isPlayerAllIn(player);
    }
    game.currentBet = 0;
}

function firstToActPostflop(game) {
    // First to act is first active player left of dealer
    const ids = Array.isArray(game.order) ? game.order.filter(id => !!game.players[id]) : Object.keys(game.players);
    const dealerIdx = ids.indexOf(game.dealer);
    for (let i = 1; i <= ids.length; i++) {
        const idx = (dealerIdx + i) % ids.length;
        const pid = ids[idx];
        const p = game.players[pid];
        if (p && p.inHand && !p.folded && !isPlayerAllIn(p)) return pid;
    }
    return null;
}

function allBetsEqualAmongActives(game) {
    const ids = activePlayers(game);
    if (ids.length <= 1) return true;
    let val = null;
    for (const pid of ids) {
        const b = game.players[pid].bet || 0;
        if (val === null) val = b; else if (b !== val) return false;
    }
    return true;
}

function everyoneActedOrAllIn(game) {
    const ids = activePlayers(game);
    return ids.every(pid => game.players[pid].acted || isPlayerAllIn(game.players[pid]));
}

// --- Blockchain payout helper ---
// distributions: Array<{ address: string, tokenAddress: string, amount: bigint | number, tableId?: string | number }>

// Ensure the GameVault has sufficient balance for the player; if not, top-up using the prize pool signer
async function ensureGameVaultBalance({ tableId, player, tokenAddress, neededAmount, provider: providerOverride, signerOverride }) {
    try {
        const CFG = getCfg();
        if (!CFG.rpcUrl || !CFG.gameVault) return true; // nothing to do if no vault configured
        // Force RPC to compose hostname for in-container calls
        const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
        const provider = providerOverride || new ethers.JsonRpcProvider(rpcUrl);
        const vaultAbi = loadVaultAbi();
        if (!vaultAbi) {
            console.warn('GameVault ABI not available; skipping ensureGameVaultBalance');
            return true;
        }
        const vault = new ethers.Contract(CFG.gameVault, vaultAbi, provider);
        const onchainTableId = deriveOnchainTableId(tableId);
        if (onchainTableId === null) {
            console.warn('ensureGameVaultBalance: could not derive on-chain table id', { tableId });
            return false;
        }

        const toAddress = (addr) => {
            if (!addr) return null;
            try { return ethers.getAddress(String(addr)); } catch (_) { return String(addr); }
        };
        const normalizedPlayer = toAddress(player);
        const normalizedToken = (!tokenAddress || String(tokenAddress).toLowerCase() === ethers.ZeroAddress.toLowerCase())
            ? ethers.ZeroAddress
            : toAddress(tokenAddress);

        const playerArg = normalizedPlayer || player;
        const tokenArg = normalizedToken || ethers.ZeroAddress;

        const readBalance = async () => {
            try {
                const res = await vault.balanceOf(onchainTableId, playerArg, tokenArg);
                return BigInt(res.toString ? res.toString() : res || 0);
            } catch (primaryErr) {
                try {
                    const res2 = await vault.balanceOf(onchainTableId, playerArg);
                    return BigInt(res2.toString ? res2.toString() : res2 || 0);
                } catch (fallbackErr) {
                    console.warn('Could not read vault balance', fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
                    return null;
                }
            }
        };

        const need = BigInt(neededAmount);
        if (need <= 0n) return true;

        let current = await readBalance();
        if (current === null) return true; // cannot verify, skip auto top-up
        if (current >= need) return true; // already enough

        let fundWallet = signerOverride;
        if (!fundWallet) {
            fundWallet = await resolvePrizePoolWallet(provider, { requireTrusted: true });
        }
        if (!fundWallet) {
            console.warn('No prize pool signer configured or signer not trusted; cannot top-up GameVault automatically');
            return false;
        }
        if (!fundWallet.provider) {
            fundWallet = fundWallet.connect(provider);
        }
        const vaultWithSigner = new ethers.Contract(CFG.gameVault, vaultAbi, fundWallet);

        const denom = 10000n;
        let effectiveRakeBps = 0n;
        try {
            const hasTableOverride = await vault.hasTableTokenRakeBps(onchainTableId, tokenArg);
            if (hasTableOverride) {
                effectiveRakeBps = BigInt(await vault.tableTokenRakeBps(onchainTableId, tokenArg));
            } else {
                const hasTokenOverride = await vault.hasTokenRakeBps(tokenArg);
                if (hasTokenOverride) {
                    effectiveRakeBps = BigInt(await vault.tokenRakeBps(tokenArg));
                } else {
                    effectiveRakeBps = BigInt(await vault.rakeBps());
                }
            }
        } catch (rakeErr) {
            console.warn('ensureGameVaultBalance: could not determine rake bps, assuming 0', rakeErr && rakeErr.message ? rakeErr.message : rakeErr);
            effectiveRakeBps = 0n;
        }
        if (effectiveRakeBps >= denom) {
            console.error('ensureGameVaultBalance: rakeBps >= 10000, cannot compute gross top-up', { effectiveRakeBps: effectiveRakeBps.toString() });
            return false;
        }

        const computeGrossFor = (netAmount) => {
            if (netAmount <= 0n) return 0n;
            if (effectiveRakeBps === 0n) return netAmount;
            const divisor = denom - effectiveRakeBps;
            return ((netAmount * denom) + (divisor - 1n)) / divisor;
        };

        const persistTopUp = async ({ txHash, receipt, grossAmount, netTarget }) => {
            try {
                await db.collection('payouts').doc(txHash).set({
                    txHash,
                    type: 'topup',
                    to: String(normalizedPlayer || player).toLowerCase(),
                    tableId: String(tableId),
                    token: String(normalizedToken || ethers.ZeroAddress).toLowerCase(),
                    amount: String(grossAmount),
                    netTarget: String(netTarget),
                    receipt: serializeReceipt(receipt),
                    createdAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            } catch (_) {}
        };

        const attemptDeposit = async (netGap) => {
            const gross = computeGrossFor(netGap);
            if (gross <= 0n) return false;
            console.log(`Top-up GameVault for player ${playerArg} table ${tableId} token ${tokenArg} netGap ${netGap} gross ${gross}`);
            if (!tokenAddress || String(tokenAddress).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
                const tx = await vaultWithSigner.depositLyxFor(onchainTableId, playerArg, { value: gross });
                const receipt = await tx.wait();
                await persistTopUp({ txHash: tx.hash, receipt, grossAmount: gross, netTarget: netGap });
                return receipt && receipt.status === 1;
            }
            const tx = await vaultWithSigner.depositLsp7For(tokenArg, onchainTableId, playerArg, gross);
            const receipt = await tx.wait();
            await persistTopUp({ txHash: tx.hash, receipt, grossAmount: gross, netTarget: netGap });
            return receipt && receipt.status === 1;
        };

        const ensureSufficient = async () => {
            let missing = need - current;
            if (missing <= 0n) return true;
            const first = await attemptDeposit(missing);
            if (!first) return false;
            current = await readBalance();
            if (current === null) return true; // unable to re-read; assume ok
            if (current >= need) return true;
            missing = need - current;
            if (missing <= 0n) return true;
            const second = await attemptDeposit(missing);
            if (!second) return false;
            current = await readBalance();
            if (current === null) return true;
            return current >= need;
        };

        return await ensureSufficient();
    } catch (e) {
        console.error('ensureGameVaultBalance error', e && e.message ? e.message : e);
        return false;
    }
}

async function withdrawFullVaultBalance({ tableId, player, tokenAddress, provider: providerOverride, signerOverride, reason }) {
    const CFG = getCfg();
    if (!assertConfig(CFG)) return false;
    const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
    const provider = providerOverride || new ethers.JsonRpcProvider(rpcUrl);
    const vaultAbi = loadVaultAbi();
    if (!vaultAbi) {
        console.warn('withdrawFullVaultBalance: vault ABI unavailable');
        return false;
    }
    const normalizedPlayer = normalizeAddress(player);
    if (!normalizedPlayer) {
        console.warn('withdrawFullVaultBalance: missing player address', { tableId, player });
        return false;
    }
    const normalizedToken = tokenAddress ? normalizeAddress(tokenAddress) : ethers.ZeroAddress;
    const onchainTableId = deriveOnchainTableId(tableId);
    if (onchainTableId === null) {
        console.warn('withdrawFullVaultBalance: unable to derive table id', { tableId });
        return false;
    }
    const vaultReader = new ethers.Contract(CFG.gameVault, vaultAbi, provider);
    let balance = 0n;
    try {
        // Prefer explicit 3-arg overload if available to avoid ambiguous function description errors
        let raw = null;
        if (typeof vaultReader['balanceOf(uint256,address,address)'] === 'function') {
            raw = await vaultReader['balanceOf(uint256,address,address)'](onchainTableId, normalizedPlayer, normalizedToken);
        } else {
            raw = await vaultReader.balanceOf(onchainTableId, normalizedPlayer, normalizedToken);
        }
        balance = BigInt(raw.toString ? raw.toString() : raw || 0);
    } catch (primaryErr) {
        try {
            let raw2 = null;
            if (typeof vaultReader['balanceOf(uint256,address)'] === 'function') {
                raw2 = await vaultReader['balanceOf(uint256,address)'](onchainTableId, normalizedPlayer);
            } else {
                raw2 = await vaultReader.balanceOf(onchainTableId, normalizedPlayer);
            }
            balance = BigInt(raw2.toString ? raw2.toString() : raw2 || 0);
        } catch (fallbackErr) {
            console.warn('withdrawFullVaultBalance: could not read balance', fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
            return false;
        }
    }
    if (balance <= 0n) {
        return true;
    }

    let fundWallet = signerOverride;
    if (!fundWallet) {
        fundWallet = await resolvePrizePoolWallet(provider, { requireTrusted: true });
    }
    if (!fundWallet) {
        console.warn('withdrawFullVaultBalance: no prize pool signer available');
        return false;
    }
    if (!fundWallet.provider) {
        fundWallet = fundWallet.connect(provider);
    }
    const vault = new ethers.Contract(CFG.gameVault, vaultAbi, fundWallet);
    const tx = await vault.withdrawFor(onchainTableId, normalizedPlayer, normalizedToken, balance);
    const rc = await tx.wait();
    try {
        await db.collection('payouts').doc(tx.hash).set({
            txHash: tx.hash,
            type: 'pve_flush',
            tableId: String(tableId),
            player: normalizedPlayer,
            token: normalizedToken,
            amount: String(balance),
            reason: reason || null,
            receipt: serializeReceipt(rc),
            createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    } catch (_) {}
    return rc && rc.status === 1;
}

async function topUpPrizeDistributor({ provider, tokenAddress, amount, payoutId, processedRef, processedDoc }) {
    try {
        const CFG = getCfg();
        if (!CFG.prizeDistributor) {
            console.warn('topUpPrizeDistributor: prize distributor address not configured');
            return false;
        }
        const doc = processedDoc || {};
        if (doc && doc.manualTopUpTxHash) {
            if (processedRef) {
                await processedRef.set({
                    pendingExecution: false,
                    executionStatus: 'manual_ready',
                    manualReadyAt: FieldValue.serverTimestamp(),
                    executionError: null,
                }, { merge: true });
            }
            return true;
        }
        const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
        const execProvider = provider || new ethers.JsonRpcProvider(rpcUrl);
        const fundWallet = await resolvePrizePoolWallet(execProvider, { requireTrusted: false });
        if (!fundWallet) {
            console.warn('topUpPrizeDistributor: no signer available to fund manual claim path');
            if (processedRef) {
                await processedRef.set({
                    pendingExecution: true,
                    executionStatus: 'manual_pending',
                    executionError: 'missing prize pool signer',
                }, { merge: true });
            }
            return false;
        }
        const normalizedToken = tokenAddress ? String(tokenAddress).toLowerCase() : ethers.ZeroAddress;
        const amt = typeof amount === 'bigint' ? amount : (() => {
            try { return ethers.toBigInt(amount); } catch (_) { return null; }
        })();
        if (!amt || amt <= 0n) {
            if (processedRef) {
                await processedRef.set({
                    pendingExecution: false,
                    executionStatus: 'manual_ready',
                    manualReadyAt: FieldValue.serverTimestamp(),
                    executionError: 'invalid amount',
                }, { merge: true });
            }
            return false;
        }

        let txHash = null;
        let receipt = null;
        if (normalizedToken === ethers.ZeroAddress.toLowerCase()) {
            const tx = await fundWallet.sendTransaction({ to: CFG.prizeDistributor, value: amt });
            receipt = await tx.wait();
            txHash = tx.hash;
        } else {
            const token = new ethers.Contract(normalizedToken, LSP7_MIN_ABI, fundWallet);
            const tx = await token.transfer(fundWallet.address, CFG.prizeDistributor, amt, true, ethers.toUtf8Bytes('PrizeDistributor manual topup'));
            receipt = await tx.wait();
            txHash = tx.hash;
        }
        if (!receipt || receipt.status !== 1) {
            throw new Error('Manual top-up receipt status != 1');
        }
        try {
            await db.collection('payouts').doc(txHash).set({
                txHash,
                payoutId: payoutId || null,
                type: 'manual_topup',
                token: normalizedToken,
                amount: String(amt),
                receipt: serializeReceipt(receipt),
                createdAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (_) {}
        if (processedRef) {
            await processedRef.set({
                pendingExecution: false,
                executionStatus: 'manual_ready',
                manualReadyAt: FieldValue.serverTimestamp(),
                manualTopUpTxHash: txHash,
                executionError: null,
            }, { merge: true });
        }
        return true;
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('topUpPrizeDistributor error', msg);
        if (processedRef) {
            await processedRef.set({
                pendingExecution: true,
                executionStatus: 'manual_pending',
                executionError: msg,
            }, { merge: true });
        }
        return false;
    }
}
async function attemptVaultWithdrawal({
    provider,
    tableId,
    player,
    tokenAddress,
    amount,
    payoutId,
    processedRef,
    processedDoc,
    allowTopUp = true
}) {
    try {
        const CFG = getCfg();
        if (!tableId) {
            if (processedRef) {
                await processedRef.set({ pendingExecution: false, executionStatus: 'skipped', executionError: 'missing tableId' }, { merge: true });
            }
            return false;
        }
        const normalizedPlayer = String(player || '').toLowerCase();
        if (!normalizedPlayer) {
            if (processedRef) {
                await processedRef.set({ pendingExecution: false, executionStatus: 'skipped', executionError: 'missing player address' }, { merge: true });
            }
            return false;
        }
        const normalizedToken = tokenAddress ? String(tokenAddress).toLowerCase() : ethers.ZeroAddress;
        const amt = typeof amount === 'bigint' ? amount : (() => {
            try { return ethers.toBigInt(amount); } catch (_) { return null; }
        })();
        if (!amt || amt <= 0n) {
            if (processedRef) {
                await processedRef.set({ pendingExecution: false, executionStatus: 'skipped', executionError: 'invalid amount' }, { merge: true });
            }
            return false;
        }
        const docData = processedDoc || {};
        const prevAttempts = Number(docData && docData.executionAttempts ? docData.executionAttempts : 0);
        if (prevAttempts >= MAX_AUTO_WITHDRAW_ATTEMPTS) {
            return await topUpPrizeDistributor({
                provider,
                tokenAddress: normalizedToken,
                amount: amt,
                payoutId,
                processedRef,
                processedDoc: docData,
            });
        }
        const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
        const execProvider = provider || new ethers.JsonRpcProvider(rpcUrl);
        const vaultAbi = loadVaultAbi();
        if (!vaultAbi) {
            if (processedRef) {
                await processedRef.set({ pendingExecution: true, executionStatus: 'blocked_config', executionError: 'missing vault ABI' }, { merge: true });
            }
            console.warn('attemptVaultWithdrawal: vault ABI unavailable');
            return false;
        }
        if (!CFG.gameVault) {
            console.warn('attemptVaultWithdrawal: GAME_VAULT not configured');
            if (processedRef) {
                await processedRef.set({ pendingExecution: true, executionStatus: 'blocked_config', executionError: 'vault address not configured' }, { merge: true });
            }
            return false;
        }
        const fundWallet = await resolvePrizePoolWallet(execProvider, { requireTrusted: true });
        if (!fundWallet) {
            console.warn('attemptVaultWithdrawal: no trusted prize pool signer available');
            if (processedRef) {
                await processedRef.set({ pendingExecution: true, executionStatus: 'blocked_config', executionError: 'no trusted prize pool signer' }, { merge: true });
            }
            return false;
        }
        const vault = new ethers.Contract(CFG.gameVault, vaultAbi, fundWallet);
        const onchainTableId = deriveOnchainTableId(tableId);
        if (onchainTableId === null) {
            console.warn('attemptVaultWithdrawal: unable to derive on-chain table id', { tableId });
            if (processedRef) {
                await processedRef.set({ pendingExecution: false, executionStatus: 'failed', executionError: 'invalid tableId' }, { merge: true });
            }
            return false;
        }

        const nextAttempt = prevAttempts + 1;

        if (processedRef) {
            await processedRef.set({
                pendingExecution: true,
                executionStatus: 'attempting',
                lastExecutionAttemptAt: FieldValue.serverTimestamp(),
                executionAttempts: FieldValue.increment ? FieldValue.increment(1) : nextAttempt,
                executionError: null
            }, { merge: true });
        }

        const performWithdraw = async () => {
            const txExec = await vault.withdrawFor(onchainTableId, normalizedPlayer, normalizedToken, amt);
            const rcExec = await txExec.wait();
            await db.collection('payouts').doc(txExec.hash).set({
                txHash: txExec.hash,
                payoutId: payoutId || null,
                type: 'payout_exec',
                to: normalizedPlayer,
                tableId: String(tableId),
                token: normalizedToken,
                amount: String(amt),
                receipt: serializeReceipt(rcExec),
                createdAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            return { txHash: txExec.hash, receipt: rcExec };
        };

        let lastError = null;
        try {
            const { receipt, txHash } = await performWithdraw();
            if (!receipt || receipt.status !== 1) {
                throw new Error('withdrawFor receipt status != 1');
            }
            if (processedRef) {
                await processedRef.set({
                    executionStatus: 'succeeded',
                    executionTxHash: txHash,
                    executionCompletedAt: FieldValue.serverTimestamp(),
                    pendingExecution: false,
                    executionError: null,
                }, { merge: true });
            }
            return true;
        } catch (err) {
            lastError = err;
            if (allowTopUp) {
                try {
                    const topped = await ensureGameVaultBalance({
                        tableId,
                        player: normalizedPlayer,
                        tokenAddress: normalizedToken,
                        neededAmount: amt,
                        provider: execProvider,
                        signerOverride: fundWallet,
                    });
                    if (topped) {
                        const { receipt, txHash } = await performWithdraw();
                        if (!receipt || receipt.status !== 1) {
                            throw new Error('withdrawFor receipt status != 1');
                        }
                        if (processedRef) {
                            await processedRef.set({
                                executionStatus: 'succeeded',
                                executionTxHash: txHash,
                                executionCompletedAt: FieldValue.serverTimestamp(),
                                pendingExecution: false,
                                executionError: null,
                            }, { merge: true });
                        }
                        return true;
                    }
                } catch (retryErr) {
                    lastError = retryErr || err;
                }
            }
        }

        const message = lastError && lastError.error && lastError.error.message
            ? lastError.error.message
            : lastError && lastError.message ? lastError.message : String(lastError);
        const attemptNo = nextAttempt;
        const delayMs = computeRetryDelayMs(attemptNo);
        const nextExecutionAt = admin.firestore && admin.firestore.Timestamp && admin.firestore.Timestamp.fromMillis
            ? admin.firestore.Timestamp.fromMillis(Date.now() + delayMs)
            : new Date(Date.now() + delayMs);
        if (processedRef) {
            await processedRef.set({
                pendingExecution: true,
                executionStatus: message && message.toLowerCase().includes('trusted') ? 'blocked_config' : 'failed',
                executionError: message,
                nextExecutionAt,
            }, { merge: true });
        }
        console.warn('attemptVaultWithdrawal failed', { payoutId, tableId, player: normalizedPlayer, token: normalizedToken, message });
        if (attemptNo >= MAX_AUTO_WITHDRAW_ATTEMPTS) {
            let latestDoc = docData;
            try {
                const snap = await processedRef.get();
                if (snap.exists) latestDoc = snap.data() || latestDoc;
            } catch (_) {}
            await topUpPrizeDistributor({
                provider,
                tokenAddress: normalizedToken,
                amount: amt,
                payoutId,
                processedRef,
                processedDoc: latestDoc,
            });
        }
        return false;
    } catch (outerErr) {
        const message = outerErr && outerErr.message ? outerErr.message : String(outerErr);
        console.error('attemptVaultWithdrawal fatal error', message, outerErr);
        if (processedRef) {
            await processedRef.set({
                pendingExecution: true,
                executionStatus: 'failed',
                executionError: message,
                nextExecutionAt: admin.firestore && admin.firestore.Timestamp && admin.firestore.Timestamp.fromMillis
                    ? admin.firestore.Timestamp.fromMillis(Date.now() + 60000)
                    : new Date(Date.now() + 60000),
            }, { merge: true });
        }
        return false;
    }
}

async function authorizePayoutsOnChain(distributions) {
    const CFG = getCfg();
    if (!assertConfig(CFG)) {
        console.warn("Skipping on-chain payouts due to missing config.");
        return;
    }
    // Force RPC to the compose hostname so functions container reaches the hardhat node.
    const rpcUrl = process.env.RPC_URL || getCfg().rpcUrl || 'http://127.0.0.1:8545';
    console.log('authorizePayoutsOnChain (HARDCODED) connecting to rpcUrl=', rpcUrl);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const authPk = CFG.privateKey;
    if (!authPk) {
        console.warn('authorizePayoutsOnChain: missing game server signer (configure PRIVATE_KEY)');
        return;
    }
    let wallet;
    try {
        wallet = new ethers.Wallet(authPk, provider);
    } catch (signerErr) {
        console.error('authorizePayoutsOnChain: invalid auth signer key', signerErr && signerErr.message ? signerErr.message : signerErr);
        return;
    }
    const contract = new ethers.Contract(CFG.prizeDistributor, PRIZE_DISTRIBUTOR_ABI, wallet);
    for (const { address, tokenAddress, amount, tableId } of distributions) {
        const normalizedAddress = String(address || '').toLowerCase();
        const normalizedToken = tokenAddress ? String(tokenAddress).toLowerCase() : ethers.ZeroAddress;
        let payoutId = null;
        let processedRef = null;
        let locked = false;
        try {
            const amt = typeof amount === 'bigint' ? amount : ethers.toBigInt(amount);
            const payoutIdParts = [normalizedAddress, normalizedToken, String(amt)];
            if (tableId !== undefined && tableId !== null) {
                payoutIdParts.push(String(tableId).toLowerCase());
            }
            payoutId = payoutIdParts.join('|');
            processedRef = db.collection('processedPayouts').doc(payoutId);
            let claimResult = null;
            // Use transaction to check/claim this payout id atomically
            claimResult = await db.runTransaction(async (tx) => {
                const doc = await tx.get(processedRef);
                const existing = doc.exists ? (doc.data() || {}) : {};
                const existingStatus = String(existing.status || '').toLowerCase();
                const hasRecordedTx = !!(existing && typeof existing.txHash === 'string' && existing.txHash.length);
                const allowedRetry = existingStatus === 'failed' || existingStatus === 'error' || (existingStatus === 'pending' && !hasRecordedTx);
                if (doc.exists && !allowedRetry) {
                    return { skip: true, status: existingStatus || 'pending' };
                }
                const attemptCount = (typeof existing.attempts === 'number' ? existing.attempts : 0) + 1;
                const payload = {
                    status: 'pending',
                    updatedAt: FieldValue.serverTimestamp(),
                    address: normalizedAddress,
                    token: normalizedToken,
                    amount: String(amt),
                    attempts: attemptCount,
                };
                if (tableId !== undefined && tableId !== null) payload.tableId = String(tableId);
                if (!doc.exists || !existing.createdAt) payload.createdAt = FieldValue.serverTimestamp();
                if (existing.error) payload.error = null;
                tx.set(processedRef, payload, { merge: true });
                return { skip: false, status: 'pending', attempts: attemptCount };
            });
            if (claimResult && claimResult.skip) {
                console.log(`Skipping payout (status=${claimResult.status}) for ${payoutId}`);
                continue;
            }
            locked = !!claimResult && !claimResult.skip;
            console.log(`Authorizing payout: ${amt} to ${address} token ${tokenAddress} (payoutId=${payoutId})`);
            const tx = await contract.authorizePayout(address, tokenAddress, amt);
            const receipt = await tx.wait();
            console.log(`Payout authorized tx: ${tx.hash}`);
            // Persist receipt for auditing and to mark processed
            const payoutRef = db.collection('payouts').doc(tx.hash);
            let persistErr = null;
            try {
                await payoutRef.set({
                    payoutId,
                    to: normalizedAddress,
                    token: normalizedToken,
                    amount: String(amt),
                    txHash: tx.hash,
                    receipt: serializeReceipt(receipt),
                    tableId: tableId !== undefined && tableId !== null ? String(tableId) : null,
                    createdAt: FieldValue.serverTimestamp(),
                    status: receipt && receipt.status === 1 ? 'confirmed' : 'failed'
                }, { merge: true });
            } catch (inner) {
                persistErr = inner;
                console.error('Failed to persist payout receipt', inner && inner.message ? inner.message : inner);
            }
            let processedDoc = null;
            try {
                const markerPayload = {
                    status: receipt && receipt.status === 1 ? 'confirmed' : 'failed',
                    txHash: tx.hash,
                    updatedAt: FieldValue.serverTimestamp(),
                    pendingExecution: receipt && receipt.status === 1 && tableId ? true : false,
                    executionStatus: receipt && receipt.status === 1 && tableId ? 'pending' : 'skipped',
                    executionError: null,
                };
                if (persistErr) {
                    markerPayload.error = `persist:${persistErr && persistErr.message ? persistErr.message : String(persistErr)}`;
                } else {
                    markerPayload.error = null;
                }
                await processedRef.set(markerPayload, { merge: true });
                const docSnap = await processedRef.get();
                if (docSnap.exists) {
                    processedDoc = docSnap.data();
                }
            } catch (markerErr) {
                console.error('Failed to update processed payout marker', markerErr && markerErr.message ? markerErr.message : markerErr);
            }
            if (receipt && receipt.status === 1 && tableId) {
                await attemptVaultWithdrawal({
                    provider,
                    tableId,
                    player: normalizedAddress,
                    tokenAddress: normalizedToken,
                    amount: amt,
                    payoutId,
                    processedRef,
                    processedDoc,
                });
            } else if (processedRef && tableId) {
                try {
                    await processedRef.set({ pendingExecution: false, executionStatus: 'skipped', executionError: receipt ? 'receipt not confirmed' : 'missing receipt' }, { merge: true });
                } catch (execMarkErr) {
                    console.warn('Failed to mark payout execution skip', execMarkErr && execMarkErr.message ? execMarkErr.message : execMarkErr);
                }
            }
        } catch (e) {
            console.error('authorizePayout error', e && e.message ? e.message : e);
            try {
                if (locked && processedRef) {
                    await processedRef.set({
                        status: 'failed',
                        error: e && e.message ? String(e.message) : String(e),
                        updatedAt: FieldValue.serverTimestamp(),
                        lastErrorAt: FieldValue.serverTimestamp(),
                    }, { merge: true });
                }
            } catch (markErr) {
                console.error('Failed to mark payout as failed', markErr && markErr.message ? markErr.message : markErr);
            }
        }
    }
}

if (onSchedule) {
    exports.retryPendingPayoutWithdrawals = onSchedule({
        schedule: 'every 2 minutes',
        timeZone: 'Europe/Ljubljana',
        secrets: [
            RPC_URL,
            PRIVATE_KEY,
            PRIZE_POOL_PK,
            FUND_SENDER_PK,
            GAME_VAULT,
            PRIZE_DISTRIBUTOR,
            ALLOWED_LSP7_TOKEN,
            LYX_UNIT_MULTIPLIER,
            LSP7_UNIT_MULTIPLIER,
            GAME_ENTRY,
            GAME_SERVER,
            HOUSE_WALLET_SEC
        ]
    }, async () => {
        try {
            // PART 1: Retry pending withdrawals
            const snapshot = await db.collection('processedPayouts')
                .where('pendingExecution', '==', true)
                .limit(20)
                .get();
            if (!snapshot.empty) {
                const CFG = getCfg();
                const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                const nowMs = Date.now();
                for (const doc of snapshot.docs) {
                    const data = doc.data() || {};
                    const nextAtMs = toMillis(data.nextExecutionAt);
                    if (nextAtMs && nextAtMs > nowMs) continue;
                    const tableId = data.tableId;
                    const player = data.address;
                    const tokenAddress = data.token;
                    let amountBig = null;
                    try {
                        amountBig = ethers.toBigInt(data.amount);
                    } catch (_) {
                        amountBig = null;
                    }
                    if (!tableId || !player || !amountBig || amountBig <= 0n) {
                        await doc.ref.set({ pendingExecution: false, executionStatus: 'skipped', executionError: 'invalid payout context' }, { merge: true });
                        continue;
                    }
                    await attemptVaultWithdrawal({
                        provider,
                        tableId,
                        player,
                        tokenAddress,
                        amount: amountBig,
                        payoutId: doc.id,
                        processedRef: doc.ref,
                        processedDoc: data,
                    });
                }
            }
            
            // PART 2: Retry failed reward deposits
            const failedRewards = await db.collection('failedRewards')
                .where('status', '==', 'pending_manual_process')
                .limit(10)
                .get();
            
            if (!failedRewards.empty) {
                console.log(`[retryPendingPayoutWithdrawals] Found ${failedRewards.size} failed rewards to retry`);
                const CFG = getCfg();
                const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                
                for (const doc of failedRewards.docs) {
                    const data = doc.data();
                    try {
                        console.log(`[retryPendingPayoutWithdrawals] Retrying reward deposit for table ${data.tableId}...`);
                        
                        let prizePoolWallet = await resolvePrizePoolWallet(provider, { requireTrusted: false });
                        if (!prizePoolWallet || !prizePoolWallet.provider) {
                            prizePoolWallet = prizePoolWallet.connect(provider);
                        }
                        
                        const vaultAbi = loadVaultAbi();
                        const vault = new ethers.Contract(CFG.gameVault, vaultAbi, prizePoolWallet);
                        const onchainTableId = deriveOnchainTableId(data.tableId);
                        
                        const rewardUnits = ethers.toBigInt(data.rewardAmount);
                        const depositTx = await vault.depositLsp7For(data.token, onchainTableId, data.player, rewardUnits);
                        await depositTx.wait();
                        
                        console.log(`[retryPendingPayoutWithdrawals] ✅ Reward deposit successful: ${depositTx.hash}`);
                        
                        // Mark as completed
                        await doc.ref.update({
                            status: 'completed',
                            completedAt: FieldValue.serverTimestamp(),
                            txHash: depositTx.hash
                        });
                        
                    } catch (retryErr) {
                        console.error(`[retryPendingPayoutWithdrawals] Retry failed:`, retryErr.message);
                        // Keep in pending state for next retry
                    }
                }
            }
        } catch (err) {
            console.warn('retryPendingPayoutWithdrawals error', err && err.message ? err.message : err);
        }
    });
}

// --- Leaderboard Stats Helper ---
async function updatePlayerStats({ playerAddress, playerName, result, buyinChips, rewardChips, difficulty }) {
    try {
        console.log(`[updatePlayerStats] Updating stats for ${playerAddress} (${playerName}): ${result}`);
        
        const playerRef = admin.firestore().collection('playerStats').doc(playerAddress.toLowerCase());
        
        // Increment counters using Firestore FieldValue.increment
        const updates = {
            displayName: playerName || 'Anonymous',
            lastPlayed: FieldValue.serverTimestamp(),
            gamesPlayed: FieldValue.increment(1),
            totalVolume: FieldValue.increment(buyinChips), // Total buy-ins (wagered amount)
        };
        
        if (result === 'win') {
            updates.wins = FieldValue.increment(1);
            updates.totalRewards = FieldValue.increment(rewardChips); // Just the bonus, not stake
            updates.winsByDifficulty = {
                [difficulty]: FieldValue.increment(1)
            };
        } else if (result === 'loss') {
            updates.losses = FieldValue.increment(1);
        }
        
        await playerRef.set(updates, { merge: true });
        console.log(`[updatePlayerStats] ✅ Stats updated successfully`);
    } catch (err) {
        console.error(`[updatePlayerStats] Failed to update stats:`, err);
    }
}

// --- PvE helpers using PrizeDistributor authorization (PLAYER-INITIATED WITHDRAWAL) ---
async function pvePayoutStakeAndReward({ tableId, player, tokenAddress, stakeUnits, rewardUnits }) {
    // DEPLOYMENT TIMESTAMP: 2025-11-04 - PLAYER-INITIATED WITHDRAWAL (NO SERVER BOTTLENECK)
    console.log(`[pvePayoutStakeAndReward] 🔥🔥🔥 CODE VERSION: 2025-11-04-PLAYER-WITHDRAWAL 🔥🔥🔥`);
    
    const CFG = getCfg();
    if (!assertConfig(CFG)) return false;
    const rpcUrl = process.env.RPC_URL || getCfg().rpcUrl || 'http://127.0.0.1:8545';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const authPk = CFG.privateKey;
    if (!authPk) throw new Error('Missing game server signer key (configure PRIVATE_KEY)');
    let authWallet;
    try {
        authWallet = new ethers.Wallet(authPk, provider);
    } catch (err) {
        throw new Error(`Invalid game server signer key: ${String(err?.message || err)}`);
    }
    const normalizedPlayer = String(player).toLowerCase();
    const normalizedToken = tokenAddress ? String(tokenAddress).toLowerCase() : ethers.ZeroAddress;
    const onchainTableId = deriveOnchainTableId(tableId);
    if (!onchainTableId) throw new Error(`Unable to derive on-chain table id for ${tableId}`);

    console.log(`[pvePayoutStakeAndReward] PvE payout authorization for table ${tableId}:`);
    console.log(`[pvePayoutStakeAndReward]   Player: ${normalizedPlayer}`);
    console.log(`[pvePayoutStakeAndReward]   Stake: ${stakeUnits.toString()} units`);
    console.log(`[pvePayoutStakeAndReward]   Reward: ${rewardUnits.toString()} units`);
    console.log(`[pvePayoutStakeAndReward]   Token: ${normalizedToken}`);
    console.log(`[pvePayoutStakeAndReward]   OnchainTableId: ${onchainTableId}`);

    if (stakeUnits === 0n && rewardUnits === 0n) {
        console.log(`[pvePayoutStakeAndReward] ⚠️ Both stake and reward are 0! Nothing to authorize.`);
        return true;
    }

    // Total amount to authorize (stake + reward)
    const totalAmount = stakeUnits + rewardUnits;
    console.log(`[pvePayoutStakeAndReward] Total amount to authorize: ${totalAmount.toString()} units`);

    // ============================================================
    // NEW APPROACH: Only AUTHORIZE withdrawal via PrizeDistributor
    // Player will call vault.withdraw() themselves from frontend!
    // This eliminates server wallet bottleneck.
    // ============================================================

    try {
        // Step 1: Authorize payout on PrizeDistributor
        console.log(`[pvePayoutStakeAndReward] Step 1: Authorizing payout via PrizeDistributor...`);
        const pd = new ethers.Contract(CFG.prizeDistributor, PRIZE_DISTRIBUTOR_ABI, authWallet);
        
        const authTx = await pd.authorizePayout(normalizedPlayer, normalizedToken, totalAmount);
        console.log(`[pvePayoutStakeAndReward] Authorization transaction sent: ${authTx.hash}, waiting...`);
        
        const authReceipt = await authTx.wait();
        console.log(`[pvePayoutStakeAndReward] ✅ Authorization successful: ${authTx.hash}`);
        console.log(`[pvePayoutStakeAndReward] Gas used: ${authReceipt.gasUsed?.toString() || 'N/A'}`);
        
        // Persist authorization record
        try {
            await db.collection('payouts').doc(authTx.hash).set({
                txHash: authTx.hash,
                type: 'pve_win_authorization',
                tableId: String(tableId),
                player: normalizedPlayer,
                token: normalizedToken,
                stakeAmount: String(stakeUnits),
                rewardAmount: String(rewardUnits),
                totalAmount: String(totalAmount),
                status: 'authorized',
                playerMustClaim: true,
                receipt: serializeReceipt(authReceipt),
                createdAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (_) {}
        
        // Step 2: Transfer REWARD from prize pool directly to the winner's wallet
        // This step is OPTIONAL - if it fails, player still gets their stake back
        if (rewardUnits > 0n) {
            try {
                console.log(`[pvePayoutStakeAndReward] Step 2: Transferring reward directly to player...`);
                
                let prizePoolWallet = await resolvePrizePoolWallet(provider, { requireTrusted: false }); // requireTrusted can be false for direct transfer
                if (!prizePoolWallet) {
                    console.warn(`[pvePayoutStakeAndReward] ⚠️ Prize pool wallet not available, skipping reward transfer`);
                } else {
                    if (!prizePoolWallet.provider) {
                        prizePoolWallet = prizePoolWallet.connect(provider);
                    }

                    // Instantiate the LSP7 token contract
                    const token = new ethers.Contract(normalizedToken, LSP7_MIN_ABI, prizePoolWallet);
                    
                    console.log(`[pvePayoutStakeAndReward] Transferring ${rewardUnits.toString()} reward units directly to ${normalizedPlayer}...`);
                    
                    // Direct transfer to the player's address
                    const transferTx = await token.transfer(prizePoolWallet.address, normalizedPlayer, rewardUnits, true, ethers.toUtf8Bytes('poker_reward'));
                    const transferReceipt = await transferTx.wait();
                    console.log(`[pvePayoutStakeAndReward] ✅ Reward directly transferred to player: ${transferTx.hash}`);
                    
                    // Persist transfer record
                    try {
                        await db.collection('payouts').doc(transferTx.hash).set({
                            txHash: transferTx.hash,
                            type: 'pve_reward_direct_transfer',
                            tableId: String(tableId),
                            player: normalizedPlayer,
                            token: normalizedToken,
                            amount: String(rewardUnits),
                            receipt: serializeReceipt(transferReceipt),
                            createdAt: FieldValue.serverTimestamp(),
                        }, { merge: true });
                    } catch (_) {}
                }
            } catch (rewardErr) {
                // DON'T FAIL THE ENTIRE PAYOUT IF REWARD TRANSFER FAILS
                // Player can still withdraw their stake!
                console.error(`[pvePayoutStakeAndReward] ⚠️ Reward transfer failed (non-fatal):`, rewardErr.message);
                console.log(`[pvePayoutStakeAndReward] Player can still claim their stake. Reward will be handled separately.`);
                
                // Log failed reward for manual processing
                try {
                    await db.collection('failedRewards').add({
                        tableId: String(tableId),
                        player: normalizedPlayer,
                        token: normalizedToken,
                        rewardAmount: String(rewardUnits),
                        error: String(rewardErr.message || rewardErr),
                        createdAt: FieldValue.serverTimestamp(),
                        status: 'pending_manual_process'
                    });
                } catch (_) {}
            }
        }
        
        console.log(`[pvePayoutStakeAndReward] ✅ SUCCESS! Player can now claim ${totalAmount.toString()} units via frontend.`);
        console.log(`[pvePayoutStakeAndReward] Player should click "💰 Claim Winnings" button to withdraw funds.`);
        
        return true;
        
    } catch (err) {
        console.error(`[pvePayoutStakeAndReward] ❌ Authorization FAILED:`);
        console.error(`[pvePayoutStakeAndReward] Error message: ${err.message || err}`);
        console.error(`[pvePayoutStakeAndReward] Error code: ${err.code || 'N/A'}`);
        console.error(`[pvePayoutStakeAndReward] Error reason: ${err.reason || 'N/A'}`);
        if (err.stack) {
            console.error(`[pvePayoutStakeAndReward] Stack trace:`, err.stack);
        }
        return false;
    }
}



// --- Core: initialize new hand ---
// NOTE: a consolidated onTableStatusChange trigger is defined later in the file.
// The earlier duplicate was removed; the later consolidated trigger performs
// tournament initialization and calls initializeNewHand when a table becomes active.
// Scheduled auto-start for tables of type 'scheduled'
exports.scheduledStartTables = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Europe/Ljubljana' }, async (event) => {
    try {
        const nowMs = Date.now();
        const snap = await db.collection('tables').where('type', '==', 'scheduled').get();
        if (snap.empty) return;
    const batch = db.batch();
    let updates = 0;
        for (const docSnap of snap.docs) {
            const t = docSnap.data() || {};
            if (t.status !== 'waiting') continue;
            // Parse startAt from string or timestamp
            let startMs = 0;
            if (t.startAt) {
                if (typeof t.startAt === 'string') {
                    const parsed = Date.parse(t.startAt);
                    startMs = isNaN(parsed) ? 0 : parsed;
                } else if (t.startAt && typeof t.startAt.toMillis === 'function') {
                    startMs = t.startAt.toMillis();
                }
            }
            if (!startMs) continue;
            const minPlayers = Math.max(2, t.minPlayers || 2);
            const playersCount = Number(t.players || 0);
        if (nowMs >= startMs && playersCount >= minPlayers) {
    batch.update(docSnap.ref, { status: 'active', startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
        updates++;
            }
        }
    if (updates === 0) return;
        await batch.commit();
    } catch (e) {
        console.error('scheduledStartTables error', e);
    }
});

async function initializeNewHand(tableId) {
    console.log(`Initializing new hand for table ${tableId}`);
    const tableRef = db.doc(`tables/${tableId}`);
    const tableSnap = await tableRef.get();
    const table = tableSnap.data() || {};
        const minChips = Math.max(0, Number(table.minChips || 0)) || 0;
        // Determine blinds/ante: use tournament level for non-cash types
        let sb = table.sb || 10;
        let bb = table.bb || 20;
        let ante = 0;
        if (table.type && table.type !== 'cash' && table.tournament && Array.isArray(table.tournament.levels)) {
            const idx = Math.max(0, Math.min(Number(table.tournament.currentLevel || 0), table.tournament.levels.length - 1));
            const lvl = table.tournament.levels[idx] || {};
            sb = Number(lvl.sb || sb);
            bb = Number(lvl.bb || bb);
            ante = Number(lvl.ante || 0);
        }
    const defaultStack = table.stack || 1500;
    // Enforce token choice: only LYX (ZeroAddress) or one allowed LSP7 from Secret/env
    const ZERO = ethers.ZeroAddress.toLowerCase();
    const inputToken = (table.tokenAddress || ethers.ZeroAddress).toLowerCase();
    const CFG = getCfg();
    const allowedLsp7 = CFG.allowedLsp7;
    let tokenAddress;
    // unitMultiplier = smallest units per 1 chip (BigInt-safe integer)
    let unitMultiplier;
    if (inputToken === ZERO) {
        tokenAddress = ethers.ZeroAddress;
        // 1 chip = 0.01 LYX; 1 LYX = 1e18 wei => 0.01 * 1e18 = 1e16 wei per chip
        unitMultiplier = "10000000000000000"; // 1e16
    } else if (allowedLsp7 && inputToken === allowedLsp7) {
        tokenAddress = allowedLsp7;
        // 1 chip = 1000 WBSTR; with 18 decimals this is 1000 * 1e18 = 1e21 smallest units per chip
        unitMultiplier = "1000000000000000000000"; // 1e21
    } else {
        console.warn(`Table ${tableId} provided unsupported token ${inputToken}. Defaulting to LYX.`);
        tokenAddress = ethers.ZeroAddress;
        unitMultiplier = "10000000000000000"; // 1e16
    }
    // Podpora za buyin in startAt
    const buyin = typeof table.buyin === 'number' ? table.buyin : 0;
    const startAt = table.startAt || null;

    const playersSnap = await db.collection(`tables/${tableId}/players`).where('status', 'in', ['seated','playing','paid']).get();
    if (playersSnap.empty) {
        console.error(`No players to start a hand for table ${tableId}. playersSnap.empty=true`);
        // Log current players subcollection snapshot for debugging
        const allPlayers = await db.collection(`tables/${tableId}/players`).get();
        console.error(`players subcollection docs for ${tableId}:`, allPlayers.docs.map(d => ({ id: d.id, data: d.data() })));
        return;
    }
        // Enforce minChips: only include players whose effective stack meets threshold; default to 0 if not set
    const eligibleDocs = playersSnap.docs.filter(d => {
        const pd = d.data() || {};
        const st = typeof pd.stack === 'number' ? pd.stack : defaultStack;
        return st >= minChips;
    });
    if (eligibleDocs.length < 2) {
        console.warn(`Not enough eligible players (>= ${minChips} chips) to start a hand for table ${tableId}. Eligible count=${eligibleDocs.length}`);
        console.error(`Eligible players for ${tableId}:`, eligibleDocs.map(d => ({ id: d.id, data: d.data() })));
        return;
    }
    const order = orderPlayersByCreated(eligibleDocs).slice(0, MAX_PLAYERS);
    // Default AI difficulty for bots comes from table config
    const tableAIDifficulty = (table && table.aiDifficulty) || 'easy';

    // Use prior game state to rotate dealer
    const gameRef = db.doc(`tables/${tableId}/game/state`);
    const prevSnap = await gameRef.get();
    let dealerIdx = 0;
    if (prevSnap.exists) {
        const prev = prevSnap.data();
        const prevDealer = prev.dealer;
        const prevIdx = order.indexOf(prevDealer);
        dealerIdx = prevIdx === -1 ? 0 : (prevIdx + 1) % order.length;
    }
    const dealer = order[dealerIdx];
    let sbId, bbId, turn;

    if (order.length === 2) {
        // Heads-up rules: dealer is SB, other is BB. Action starts with dealer.
        sbId = order[dealerIdx];
        bbId = order[(dealerIdx + 1) % order.length];
        turn = sbId;
    } else {
        // 3+ player rules: normal blinds. Action starts left of BB.
        sbId = order[(dealerIdx + 1) % order.length];
        bbId = order[(dealerIdx + 2) % order.length];
        turn = order[(dealerIdx + 3) % order.length];
    }

    // Build deck and deal
    const deck = shuffle(buildDeck());
    const players = {};
    for (const pid of order) {
        const match = eligibleDocs.find(d => d.id === pid);
        const pdata = match ? (match.data() || {}) : {};
        players[pid] = {
            name: pdata.name || pid,
            address: pdata.address || null,
            status: 'playing',
            inHand: true,
            folded: false,
            acted: false,
            stack: typeof pdata.stack === 'number' ? pdata.stack : defaultStack,
            bet: 0,
            contrib: 0,
            hole: [ deck.pop(), deck.pop() ],
            isLeaving: pdata.status === 'leaving' || pdata.isLeaving || false,
            // Treat role === 'bot' as bot. Avoid relying on disallowed client fields.
            bot: pdata.role === 'bot',
            // Use per-player aiDifficulty if present; else inherit from table.
            aiDifficulty: pdata.aiDifficulty || tableAIDifficulty || 'easy',
            allIn: false,
            consecutiveTimeouts: 0, // Track consecutive timeouts (player inactivity)
        };
    }

    // Antes
    let pot = 0;
    if (ante > 0) {
        for (const pid of order) {
            const p = players[pid];
            const pay = Math.min(p.stack, ante);
            p.stack -= pay;
            p.contrib = (p.contrib || 0) + pay;
            pot += pay;
            if (p.stack <= 0) {
                p.stack = 0;
                p.allIn = true;
                p.acted = true;
            }
        }
    }

    // Post blinds
    players[sbId].bet = Math.min(players[sbId].stack, sb);
    players[sbId].stack -= players[sbId].bet;
    players[sbId].contrib = (players[sbId].contrib || 0) + players[sbId].bet;
    if (players[sbId].stack <= 0) {
        players[sbId].stack = 0;
        players[sbId].allIn = true;
        players[sbId].acted = true;
    }
    players[bbId].bet = Math.min(players[bbId].stack, bb);
    players[bbId].stack -= players[bbId].bet;
    players[bbId].contrib = (players[bbId].contrib || 0) + players[bbId].bet;
    if (players[bbId].stack <= 0) {
        players[bbId].stack = 0;
        players[bbId].allIn = true;
        players[bbId].acted = true;
    }

    for (const pid of Object.keys(players)) {
        const p = players[pid];
        if (p.stack <= 0) {
            p.stack = 0;
            p.allIn = true;
            p.acted = true;
        }
    }

    pot += players[sbId].bet + players[bbId].bet;
    const currentBet = Math.max(players[sbId].bet, players[bbId].bet);

    // Preflop: action starts left of BB
    // Skip folded/leaving (auto-fold leaves) at start
    // Build temporary game object for skipAutoFoldIfNeeded
    const tempGame = {
        dealer,
        smallBlind: sbId,
        bigBlind: bbId,
        phase: 'preflop',
        board: [],
        deck,
        players,
        pot,
        currentBet,
        minRaise: bb,
        order, // IMPORTANT: include order so nextActivePlayerId works!
    };
    turn = await skipAutoFoldIfNeeded(tableId, tempGame, turn);

    const game = {
        dealer, smallBlind: sbId, bigBlind: bbId,
        phase: 'preflop',
        board: [],
        deck,
        players,
        pot,
        currentBet,
        minRaise: bb,
        tokenAddress,
        unitMultiplier,
        turn,
        order, // stable clockwise seating/action order
    lastAggressor: null,
    lastAggressionSize: 0,
        lastActionAt: FieldValue.serverTimestamp(),
    };
    // If a deterministic test outcome was set on the table, locate the host pid and store it on the game
    if (table && table.testOutcome) {
        for (const [pid, pdata] of Object.entries(game.players || {})) {
            try {
                const addr = pdata && pdata.address ? String(pdata.address).toLowerCase() : null;
                if (addr && table.hostId && String(table.hostId).toLowerCase() === addr) {
                    game.testHost = pid;
                    break;
                }
            } catch (_) { /* ignore */ }
        }
    }
    updatePotAggregates(game);
    await gameRef.set(game);
    await bumpTableActivity(tableId);
    console.log(`New hand started at table ${tableId}, turn=${turn}`);
    
    // If no valid turn (everyone all-in/folded), advance phase immediately
    if (!turn) {
        console.log(`[initializeNewHand] No valid turn at table ${tableId}; advancing phase immediately`);
        await advancePhase(tableId, game, gameRef);
        return;
    }
    
    // Auto-act if first to act is a bot
    await maybeAutoAct(tableId);
}

async function skipAutoFoldIfNeeded(tableId, game, proposedTurn) {
    let turn = proposedTurn;
    let guard = 0;
    while (turn) {
        const p = game.players[turn];
        if (p && p.inHand && !p.folded && !isPlayerAllIn(p)) {
            if (p.isLeaving) {
                // auto fold
                p.inHand = false;
                p.folded = true;
                // advance
                turn = nextActivePlayerId(game, turn);
                guard++;
                if (guard > MAX_PLAYERS) break;
                continue;
            }
            break; // good turn
        }
        turn = nextActivePlayerId(game, turn);
        guard++;
        if (guard > MAX_PLAYERS) break;
    }
    return turn;
}

// --- Core: handle player status/action updates ---
exports.onPlayerUpdate = onDocumentUpdated({
    document: "tables/{tableId}/players/{playerId}",
    secrets: [RPC_URL, PRIVATE_KEY, PRIZE_POOL_PK, FUND_SENDER_PK, PRIZE_DISTRIBUTOR, ALLOWED_LSP7_TOKEN, LYX_UNIT_MULTIPLIER, LSP7_UNIT_MULTIPLIER, GAME_VAULT, HOUSE_WALLET_SEC]
    // DEPLOYED: 2025-11-02T15:22:00Z - HOUSE_WALLET_SEC added for pveConfiscateLoss v5
}, async (event) => {
    const { tableId, playerId } = event.params;
    const before = event.data.before.data();
    const after = event.data.after.data();

        // Handle leaving flag
        if (before.status !== 'leaving' && after.status === 'leaving') {
            const gameRef = db.doc(`tables/${tableId}/game/state`);
            await gameRef.set({ [`players.${playerId}.isLeaving`]: true }, { merge: true });
            await bumpTableActivity(tableId);
            console.log(`Player ${playerId} set to leaving at table ${tableId}`);
            return;
        }

        // Handle player action command
        const beforeAt = get(before, 'actionAt');
        const afterAt = get(after, 'actionAt');
        if (!isEqual(beforeAt, afterAt)) {
            const action = after.action;
            const betAmount = after.betAmount || 0;
            await applyPlayerAction(tableId, playerId, action, betAmount);
        }
        });

async function loadGame(tableId) {
    const ref = db.doc(`tables/${tableId}/game/state`);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Game state not found');
    return { ref, data: snap.data() };
}

async function applyPlayerAction(tableId, playerId, action, amount) {
    const { ref, data: game } = await loadGame(tableId);
    if (game.turn !== playerId) {
        console.log('Ignoring action, not this player\'s turn', { playerId, turn: game.turn, action });
        return;
    }
    const player = game.players[playerId];
    if (!player || !player.inHand || player.folded) return;
    
    // CRITICAL: Reset consecutive timeouts when player takes ANY action (click)
    // This ensures only ACTUAL user inactivity (no clicks) counts toward forfeit
    if (player.consecutiveTimeouts && player.consecutiveTimeouts > 0) {
        console.log(`Player ${playerId} took action (${action}) - resetting consecutiveTimeouts from ${player.consecutiveTimeouts} to 0`);
        player.consecutiveTimeouts = 0;
    }

    switch ((action||'').toLowerCase()) {
        case 'fold':
            player.inHand = false;
            player.folded = true;
            player.acted = true;
            player.allIn = false;
            break;
        case 'check':
            if (player.bet !== (game.currentBet||0)) {
                console.log('Illegal check; requires call or fold');
                return;
            }
            player.acted = true;
            break;
        case 'call': {
            const toCall = Math.max(0, (game.currentBet||0) - (player.bet||0));
            const pay = Math.min(player.stack, toCall);
            player.stack -= pay;
            player.bet = (player.bet||0) + pay;
            player.contrib = (player.contrib || 0) + pay;
            game.pot += pay;
            player.acted = true;
            if (player.stack <= 0) {
                player.stack = 0;
                player.allIn = true;
            }
            break;
        }
        case 'bet': {
            if (game.currentBet !== 0) {
                console.log('Illegal bet; use raise');
                return;
            }
            const minBet = Math.max(0, game.minRaise || 0);
            const amt = Math.max(amount|0, minBet);
            const othersWithChips = activePlayers(game).filter(pid => pid !== playerId && !isPlayerAllIn(game.players[pid]) && (game.players[pid].stack || 0) > 0);
            if (!othersWithChips.length) {
                // No opponents with chips left to contest; treat as check
                player.acted = true;
                break;
            }
            const pay = Math.min(player.stack, amt);
            player.stack -= pay;
            player.bet += pay;
            player.contrib = (player.contrib || 0) + pay;
            game.pot += pay;
            game.currentBet = player.bet;
            // On bet/raise, reset others' acted
            for (const pid of Object.keys(game.players)) if (pid !== playerId) game.players[pid].acted = false;
            player.acted = true;
            // Min raise size becomes this bet size for the street
            game.minRaise = pay;
            game.lastAggressor = playerId;
            game.lastAggressionSize = pay;
            if (player.stack <= 0) {
                player.stack = 0;
                player.allIn = true;
            }
            break;
        }
        case 'raise': {
            const toCall = Math.max(0, (game.currentBet||0) - (player.bet||0));
            const minRaise = Math.max(game.minRaise || 0, 0);
            const raiseAmt = Math.max(amount|0, minRaise);
            const totalPutIn = toCall + raiseAmt;
            const othersWithChips = activePlayers(game).filter(pid => pid !== playerId && !isPlayerAllIn(game.players[pid]) && (game.players[pid].stack || 0) > 0);
            if (!othersWithChips.length) {
                const pay = Math.min(player.stack, toCall);
                player.stack -= pay;
                player.bet += pay;
                player.contrib = (player.contrib || 0) + pay;
                if (pay > 0) game.pot += pay;
                player.acted = true;
                if (player.stack <= 0) {
                    player.stack = 0;
                    player.allIn = true;
                }
                break;
            }
            const pay = Math.min(player.stack, totalPutIn);
            player.stack -= pay;
            player.bet += pay;
            player.contrib = (player.contrib || 0) + pay;
            game.pot += pay;
            game.currentBet = player.bet;
            // Update min raise to last raise size
            game.minRaise = raiseAmt;
            for (const pid of Object.keys(game.players)) if (pid !== playerId) game.players[pid].acted = false;
            player.acted = true;
            game.lastAggressor = playerId;
            game.lastAggressionSize = raiseAmt;
            if (player.stack <= 0) {
                player.stack = 0;
                player.allIn = true;
            }
            break;
        }
        default:
            console.log('Unknown action', action);
            return;
    }

    updatePotAggregates(game);

    // Check if hand ends due to all but one folded
    const stillIn = activePlayers(game);
    if (stillIn.length === 1) {
        const winnerId = stillIn[0];
        game.players[winnerId].stack += game.pot; // scoop
        game.pot = 0;
        game.sidePots = [];
        await ref.set(game);
        console.log(`Hand ended early; winner ${winnerId}`);
        await settleEndOfHand(tableId, game);
        return;
    }

    // Check round completion
    let advancePhaseNow = false;
    if (allBetsEqualAmongActives(game) && everyoneActedOrAllIn(game)) {
        advancePhaseNow = true;
    }

    const pendingNonAllIn = activePlayers(game).filter((pid) => {
        const player = game.players[pid];
        return player && !player.acted && !isPlayerAllIn(player);
    });
    if (!pendingNonAllIn.length) {
        advancePhaseNow = true;
    }

    if (advancePhaseNow) {
        await advancePhase(tableId, game, ref);
        return;
    }

    // Advance turn
    let next = nextActivePlayerId(game, playerId);
    next = await skipAutoFoldIfNeeded(tableId, game, next);

    if (!next) {
        game.turn = null;
        game.lastActionAt = FieldValue.serverTimestamp();
        await ref.set(game);
        await bumpTableActivity(tableId);
        // Everyone is all-in or folded; advance immediately.
        await advancePhase(tableId, game, ref);
        return;
    }

    game.turn = next;
    game.lastActionAt = FieldValue.serverTimestamp();
    await ref.set(game);
    await bumpTableActivity(tableId);
    // Auto-act if next turn is a bot
    await maybeAutoAct(tableId);
}

async function advancePhase(tableId, game, ref) {
    // CRITICAL: If all players are all-in or out, skip directly to showdown
    const playersWithActions = activePlayers(game).filter(pid => {
        const p = game.players[pid];
        return p && !isPlayerAllIn(p) && (p.stack || 0) > 0;
    });
    
    console.log(`[advancePhase] Table ${tableId}, phase: ${game.phase}, playersWithActions: ${playersWithActions.length}`);
    activePlayers(game).forEach(pid => {
        const p = game.players[pid];
        console.log(`  Player ${pid}: allIn=${p.allIn}, stack=${p.stack}, isPlayerAllIn=${isPlayerAllIn(p)}`);
    });
    
    if (playersWithActions.length === 0 && game.phase !== 'showdown') {
        console.log(`[advancePhase] ⚡ All players all-in or out - fast-forwarding to showdown!`);
        // Burn through remaining streets instantly
        while (game.phase !== 'river') {
            if (game.phase === 'preflop') {
                game.deck.pop();
                game.board.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
                game.phase = 'flop';
            } else if (game.phase === 'flop') {
                game.deck.pop();
                game.board.push(game.deck.pop());
                game.phase = 'turn';
            } else if (game.phase === 'turn') {
                game.deck.pop();
                game.board.push(game.deck.pop());
                game.phase = 'river';
            }
        }
        // Now go to showdown
        game.phase = 'showdown';
        game.turn = null;
        game.lastActionAt = FieldValue.serverTimestamp();
        await ref.set(game);
        await showdownAndPayout(tableId, game, ref);
        return;
    }
    
    // Reset per-round state
    resetBetsForNewRound(game);
    updatePotAggregates(game);
    game.lastAggressor = null;
    game.lastAggressionSize = 0;

    if (game.phase === 'preflop') {
        // Burn 1, then deal flop (3 cards)
        game.deck.pop();
        game.board.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
        game.phase = 'flop';
    } else if (game.phase === 'flop') {
        // Burn 1, then deal turn
        game.deck.pop();
        game.board.push(game.deck.pop());
        game.phase = 'turn';
    } else if (game.phase === 'turn') {
        // Burn 1, then deal river
        game.deck.pop();
        game.board.push(game.deck.pop());
        game.phase = 'river';
    } else if (game.phase === 'river') {
        // Move to showdown state first so clients can reveal all hole cards
        game.phase = 'showdown';
        game.turn = null; // no one's turn during showdown reveal
    game.lastActionAt = FieldValue.serverTimestamp();
        await ref.set(game);
        await showdownAndPayout(tableId, game, ref);
        return;
    }

    // Set next turn: first to act left of dealer
    let turn = firstToActPostflop(game);
    turn = await skipAutoFoldIfNeeded(tableId, game, turn);
    if (!turn) {
        game.turn = null;
        game.lastActionAt = FieldValue.serverTimestamp();
        await ref.set(game);
        await bumpTableActivity(tableId);
        // No eligible player to act on this street; immediately advance.
        await advancePhase(tableId, game, ref);
        return;
    }

    game.turn = turn;
    game.lastActionAt = FieldValue.serverTimestamp();
    await ref.set(game);
    await bumpTableActivity(tableId);
    // Auto-act if next turn is a bot
    await maybeAutoAct(tableId);
}

async function showdownAndPayout(tableId, game, ref) {
    // Ensure showdown phase is visible to clients before distributing chips
    if (game.phase !== 'showdown') {
        game.phase = 'showdown';
        game.turn = null;
    game.lastActionAt = FieldValue.serverTimestamp();
    try { await ref.set(game); await bumpTableActivity(tableId); } catch (_) {}
    }
    // Brief pause to display revealed hole cards client-side (PokerStars-like)
    try { await new Promise(res => setTimeout(res, 3000)); } catch (_) {}

    const actives = activePlayers(game);
    if (actives.length === 0) {
        // Edge: everyone folded?
        console.warn('Showdown but no active players');
        await settleEndOfHand(tableId, game);
        return;
    }
    // Evaluate active hands
    const handMap = {};
    const showdownSummary = {};
    const cardToKey = (card) => {
        if (!card) return null;
        if (typeof card === 'string') {
            const trimmed = card.trim();
            return trimmed ? trimmed.toUpperCase() : null;
        }
        try {
            const rendered = typeof card.toString === 'function' ? card.toString() : '';
            if (rendered) return rendered.trim().toUpperCase();
            const value = card.value || card.rank || '';
            const suit = card.suit || card.suitChar || '';
            const merged = `${String(value).trim()}${String(suit).trim()}`;
            return merged ? merged.toUpperCase() : null;
        } catch (_) {
            return null;
        }
    };
    for (const pid of actives) {
        const p = game.players[pid];
        const solved = Hand.solve([...p.hole, ...game.board]);
        handMap[pid] = solved;
        const bestCards = Array.isArray(solved?.cards) ? solved.cards.map((card) => cardToKey(card)).filter(Boolean) : [];
        showdownSummary[pid] = {
            name: solved?.name || null,
            description: solved?.descr || null,
            bestCards,
        };
    }

    // Test hook: if a deterministic testOutcome was set for this game, force win/lose for testHost
    try {
        if (game.testOutcome && game.testHost && game.players[game.testHost]) {
            const hpid = game.testHost;
            if (game.testOutcome === 'win') {
                // Give testHost an unbeatable hand by fabricating hole cards (e.g., set to four aces + board)
                // Quick approach: set their hand to Royal Flush in hearts by overriding the Hand.solve output
                // Since Hand.solve expects cards, give them two high suited cards that with board will form best hand
                // Easiest deterministic method: bump their handMap value artificially by wrapping in an object with high score
                handMap[hpid] = { __forcedWin: true };
            } else if (game.testOutcome === 'lose') {
                // Ensure testHost does not win: mark them as folded for showdown consideration
                // Remove from actives for winner selection by setting their hole to [] and handMap low
                handMap[hpid] = { __forcedLose: true };
            }
        }
    } catch (e) { console.warn('Error applying testOutcome hook at showdown', e && e.message); }

    const contribs = Object.fromEntries(Object.entries(game.players).map(([pid, p]) => [pid, Math.max(0, p.contrib || 0)]));
    const { layers: potLayers } = updatePotAggregates(game);
    const allIds = Array.isArray(game.order) ? game.order.filter((id) => !!game.players[id]) : Object.keys(game.players);
    const dealerIdx = allIds.indexOf(game.dealer);
    const seatOrder = [];
    for (let i = 1; i <= allIds.length; i++) seatOrder.push(allIds[(dealerIdx + i) % allIds.length]);

    const distributions = [];
    const winningsAdd = Object.fromEntries(allIds.map(id => [id, 0]));
    console.log(`[showdownAndPayout] 🎰 POT DISTRIBUTION STARTING for table ${tableId}`);
    console.log(`[showdownAndPayout] Total layers: ${potLayers.length}`);
    for (const layer of potLayers) {
        if (!(layer.amount > 0) || !layer.eligible.length) continue;
        console.log(`[showdownAndPayout] Processing layer: amount=${layer.amount}, eligible=${layer.eligible.join(',')}`);
        const hands = layer.eligible.map(pid => ({ pid, hand: handMap[pid] }));
        // Check for forced win/lose flags
        const forcedWinPid = hands.find(h => h.hand && h.hand.__forcedWin) ? hands.find(h => h.hand && h.hand.__forcedWin).pid : null;
        const forcedLosePid = hands.find(h => h.hand && h.hand.__forcedLose) ? hands.find(h => h.hand && h.hand.__forcedLose).pid : null;
        let winnerPids = [];
        if (forcedWinPid) {
            // forced winner gets entire pot for this side-pot
            winnerPids = [forcedWinPid];
        } else {
            // Exclude any forced-lose players from consideration
            const candidateHands = hands.filter(h => !(h.hand && h.hand.__forcedLose)).map(h => h.hand);
            const candidatePids = hands.filter(h => !(h.hand && h.hand.__forcedLose)).map(h => h.pid);
            if (candidateHands.length === 0) {
                // everyone excluded (all forced lose?) - fallback to original roster
                winnerPids = hands.map(h => h.pid);
            } else {
                const winnersHands = Hand.winners(candidateHands);
                // Stara, nezanesljiva koda, ki primerja objekte po referenci:
                // winnerPids = candidatePids.filter((pid, idx) => winnersHands.includes(candidateHands[idx]));

                // --- ZAČETEK NOVE KODE ---
                // Nova, zanesljiva koda, ki pravilno primerja kombinacije po njihovi vrednosti (besedilnem opisu).
                // To zagotavlja, da so "kickerji" pravilno upoštevani.
                const winnerDescr = new Set(winnersHands.map(h => h.toString()));
                winnerPids = candidatePids.filter((pid, idx) => winnerDescr.has(candidateHands[idx].toString()));
                // --- KONEC NOVE KODE ---
            }
        }
        console.log(`[showdownAndPayout] Layer winners: ${winnerPids.join(',')}`);
        const base = Math.floor(layer.amount / winnerPids.length);
        let remainder = layer.amount - base * winnerPids.length;
        const winnersOrdered = seatOrder.filter(id => winnerPids.includes(id));
        const remainderQueue = winnersOrdered.slice(0, remainder);
        for (const pid of winnerPids) {
            let add = base;
            if (remainder > 0 && remainderQueue.includes(pid)) {
                add += 1;
                remainder -= 1;
            }
            const playerIsBot = !!game.players[pid].bot;
            const playerAddress = game.players[pid].address;
            console.log(`[showdownAndPayout] 💰 Player ${pid}: +${add} chips (isBot=${playerIsBot}, address=${playerAddress})`);
            game.players[pid].stack += add;
            winningsAdd[pid] += add;
            const onchainAmount = BigInt(add) * BigInt(game.unitMultiplier || 1);
            if (game.players[pid].address) {
                console.log(`[showdownAndPayout] 📤 ADDING to distributions array: ${playerAddress} gets ${onchainAmount} units`);
                distributions.push({ address: game.players[pid].address, tokenAddress: game.tokenAddress || ethers.ZeroAddress, amount: onchainAmount, tableId: tableId });
            } else {
                console.log(`[showdownAndPayout] ⏭️  SKIPPING distribution (no address) for player ${pid}`);
            }
        }
    }
    console.log(`[showdownAndPayout] 🎰 POT DISTRIBUTION COMPLETE. Total distributions array entries: ${distributions.length}`);

    const showdownWinners = Object.entries(winningsAdd)
        .filter(([, amt]) => (amt || 0) > 0)
        .map(([pid]) => pid);
    for (const [pid, amt] of Object.entries(winningsAdd)) {
        if (!showdownSummary[pid]) {
            showdownSummary[pid] = { name: null, description: null, bestCards: [] };
        }
        showdownSummary[pid].chipsWon = amt || 0;
    }

    game.showdownSummary = {
        hands: showdownSummary,
        winners: showdownWinners.length ? showdownWinners : actives,
        updatedAt: FieldValue.serverTimestamp(),
    };

    game.pot = 0;
    game.sidePots = [];
    game.lastActionAt = FieldValue.serverTimestamp();
    await ref.set(game);
    await bumpTableActivity(tableId);

    // CRITICAL: For Play vs PC (private AI), chips are VIRTUAL during the match
    // Only trigger blockchain payouts at the END of the entire match, not after each hand
    let isPrivateAi = false;
    try {
        const tableRef = db.doc(`tables/${tableId}`);
        const tableSnap = await tableRef.get();
        if (tableSnap.exists) {
            const tableData = tableSnap.data() || {};
            const isAiTable = String(tableData.mode || '').toLowerCase() === 'ai';
            isPrivateAi = isAiTable && !!tableData.isPrivate;
        }
    } catch (e) {
        console.warn('[showdownAndPayout] Failed to check if table is private AI:', e);
    }

    if (isPrivateAi) {
        console.log(`[showdownAndPayout] Private AI table ${tableId}: Skipping on-chain payouts (chips are virtual until match ends)`);
        // Do NOT call authorizePayoutsOnChain - chips are virtual until match conclusion
    } else {
        // Normal tables: authorize on-chain payouts after each hand
        await authorizePayoutsOnChain(distributions);
    }

    // Award P2E points after finishing payouts
    try { await awardP2EPoints({ game, contribs, winningsAdd }); } catch (_) {}
    await settleEndOfHand(tableId, game);
}

async function settleEndOfHand(tableId, game) {
    console.log(`🔥🔥🔥 settleEndOfHand CODE VERSION: 2024-11-02-RAKE-FIX-V4 🔥🔥🔥`);
    
    // Players who set leaving -> return remaining stack via on-chain authorize later (off-hand)
    // For tournaments, players whose stack becomes 0 at the end of the hand should be marked as eliminated ('out')
    const tableRef = db.doc(`tables/${tableId}`);
    const batch = db.batch();
    const tablePlayerDocs = new Map();

    // Initialize auth wallet for blockchain operations (needed for vault balance checks)
    const CFG = getCfg();
    let authWallet = null;
    if (CFG && CFG.privateKey) {
        try {
            const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            authWallet = new ethers.Wallet(CFG.privateKey, provider);
        } catch (err) {
            console.warn(`[settleEndOfHand] Could not initialize auth wallet:`, err.message);
        }
    }

    // Snapshot player state before we mutate stacks/status so AI resolution logic can use original values
    const preSettlePlayers = JSON.parse(JSON.stringify(game.players || {}));
    const autoCashoutApplied = new Set();

    const leavingDistributions = [];

    // Detect if this table is a tournament (non-cash) or private AI table
    let isTournament = false;
    let isAiTable = false;
    let isPrivateAi = false;
    let tableData = {};
    let existingAiMatchResult = null;
    try {
        const tSnap = await tableRef.get();
        tableData = tSnap.exists ? (tSnap.data() || {}) : {};
        isTournament = tableData && tableData.type && tableData.type !== 'cash';
        isAiTable = String(tableData.mode || '').toLowerCase() === 'ai';
        isPrivateAi = isAiTable && !!tableData.isPrivate;
        existingAiMatchResult = tableData.aiMatchResult || null;
    } catch (e) {
        console.warn('Could not read table doc to determine table metadata', e);
    }

    // Count already eliminated players in game state (if any)
    let outCount = Object.values(game.players || {}).filter(pp => pp && pp.status === 'out').length;

    // For Play vs PC (isPrivateAi), disable auto-cashout - game should end naturally when only one side has chips
    // AI resolution logic will handle the final payouts correctly
    const autoCashOutEnabled = isAiTable && !isPrivateAi && (tableData.autoCashOutOnWin !== false);
    const botsHaveChips = Object.entries(game.players || {})
        .some(([, pdata]) => {
            if (!pdata || !pdata.bot) return false;
            const stackVal = typeof pdata.stack === 'number' ? pdata.stack : Number(pdata.stack || 0);
            return Number.isFinite(stackVal) && stackVal > 0;
        });

    for (const [pid, p] of Object.entries(game.players)) {
        const pref = db.doc(`tables/${tableId}/players/${pid}`);
        const rawStack = typeof p.stack === 'number' ? p.stack : Number(p.stack || 0);
        const currentStack = Number.isFinite(rawStack) ? rawStack : 0;
        p.stack = currentStack;
        const isBot = !!p.bot;
        const forceCashOut = autoCashOutEnabled && !isBot && !botsHaveChips;
        
        // CRITICAL FIX: Check for forfeit FIRST (Play vs PC human abandonment)
        const isForfeit = isPrivateAi && !isBot && p.isLeaving;
        
        if (isForfeit) {
            // Player forfeits in Play vs PC - they LOSE their stake, no refund
            console.log(`[settleEndOfHand] FORFEIT: Player ${pid} abandoned Play vs PC game - stack confiscated`);
            const payload = {
                stack: 0,
                status: 'out',
                outAt: FieldValue.serverTimestamp(),
                forfeit: true,
            };
            batch.set(pref, payload, { merge: true });
            // Update in-memory game snapshot
            game.players[pid].stack = 0;
            game.players[pid].status = 'out';
            game.players[pid].forfeit = true;
            // DO NOT add to leavingDistributions - player loses their stake!
        } else if (p.isLeaving || forceCashOut) {
            // Normal cash-out (non-forfeit leaving or auto-cashout)
            const payload = {
                stack: 0,
                status: 'left',
                leftAt: FieldValue.serverTimestamp(),
            };
            batch.set(pref, payload, { merge: true });
            if (p.address && currentStack > 0) {
                const amt = BigInt(currentStack) * BigInt(game.unitMultiplier || 1);
                leavingDistributions.push({ address: p.address, tokenAddress: game.tokenAddress || ethers.ZeroAddress, amount: amt });
            }
            // Ensure in-memory game snapshot reflects the cash-out so downstream logic does not reuse stack
            game.players[pid].stack = 0;
            game.players[pid].status = 'left';
            if (forceCashOut) {
                if (currentStack > 0) {
                    autoCashoutApplied.add(pid);
                }
                game.players[pid].autoCashout = true;
                console.log(`[settleEndOfHand] Auto-cashout applied for player ${pid} on table ${tableId}`);
            }
        } else {
            if (isAiTable && p.bot && currentStack <= 0) {
                const payload = {
                    stack: 0,
                    status: 'out',
                    outAt: FieldValue.serverTimestamp(),
                };
                batch.set(pref, payload, { merge: true });
                game.players[pid].status = 'out';
                continue;
            }
            // Tournament elimination: if stack is 0, mark as 'out' and assign elimination position
            if (isTournament && (currentStack === 0 || currentStack <= 0)) {
                outCount += 1;
                const payload = {
                    stack: 0,
                    status: 'out',
                    outAt: FieldValue.serverTimestamp(),
                    eliminationPosition: outCount,
                };
                batch.set(pref, payload, { merge: true });
            } else {
                batch.set(pref, { stack: currentStack, status: 'seated' }, { merge: true });
            }
        }
    }
    await batch.commit();

    console.log(`[settleEndOfHand] Resetting player statuses for table ${tableId}...`);
    try {
        const playersSnap = await db.collection(`tables/${tableId}/players`).get();
        if (!playersSnap.empty) {
            const batchReset = db.batch();
            let updates = 0;
            playersSnap.forEach((doc) => {
                const data = doc.data() || {};
                tablePlayerDocs.set(doc.id, data);
                const currentStatus = String(data.status || '').toLowerCase();
                if (currentStatus === 'left') return;
                const rawStack = typeof data.stack === 'number' ? data.stack : Number(data.stack || 0);
                const stack = Number.isFinite(rawStack) ? rawStack : 0;
                const isBot = data.role === 'bot' || data.bot;
                
                let targetStatus;
                if (stack > 0) {
                    targetStatus = 'seated';
                } else if (isBot) {
                    targetStatus = 'out';
                } else {
                    targetStatus = isTournament ? 'out' : 'out';
                }
                
                if (currentStatus !== targetStatus) {
                    batchReset.set(doc.ref, { status: targetStatus }, { merge: true });
                    updates += 1;
                }
            });
            if (updates > 0) {
                await batchReset.commit();
                console.log(`[settleEndOfHand] Updated statuses for ${updates} players on table ${tableId}.`);
            } else {
                console.log(`[settleEndOfHand] Player statuses already in sync for table ${tableId}.`);
            }
        }
    } catch (statusErr) {
        console.error(`[settleEndOfHand] Failed to reset player statuses for table ${tableId}:`, statusErr);
    }

    console.log(`[settleEndOfHand] Hand for table ${tableId} finished. Checking conditions to start a new hand.`);

    const stackFor = (player) => {
        const raw = typeof player?.stack === 'number' ? player.stack : Number(player?.stack || 0);
        return Number.isFinite(raw) ? raw : 0;
    };

    const resolveDocData = (pid) => {
        if (tablePlayerDocs.has(pid)) return tablePlayerDocs.get(pid) || {};
        return {};
    };

    const resolvePlayerAddress = (pid, pdata) => {
        const candidates = [
            pdata && pdata.address,
            preSettlePlayers?.[pid]?.address,
            resolveDocData(pid)?.address,
            resolveDocData(pid)?.wallet,
            resolveDocData(pid)?.playerAddress,
        ];
        for (const cand of candidates) {
            if (!cand) continue;
            try {
                if (ethers.isAddress(cand)) return ethers.getAddress(cand);
            } catch (_) {
                continue;
            }
        }
        return null;
    };

    const resolvePlayerRole = (pid, pdata) => {
        if (pdata && pdata.role) return pdata.role;
        const preRole = preSettlePlayers?.[pid]?.role;
        if (preRole) return preRole;
        const docRole = resolveDocData(pid)?.role;
        if (docRole) return docRole;
        return null;
    };

    let aiResolution = null;
    const aiMatchAlreadyResolved = !!(existingAiMatchResult && existingAiMatchResult.status);
    let privateAiShouldContinue = false;
    let humanEntries = [];
    let botEntries = [];
    let humansWithChips = [];
    let botsWithChips = [];

    if (isPrivateAi && !aiMatchAlreadyResolved) {
        // Prefer the post-settlement stacks in game.players (reflects results of showdown/payouts).
        // Fallback to preSettlePlayers only if current snapshot missing a player entry.
        const entryMap = new Map();
        const buildEntry = (pid, candidate) => {
            const docData = resolveDocData(pid);
            const base = {};
            if (docData && typeof docData === 'object') {
                Object.assign(base, docData);
            }
            if (candidate && typeof candidate === 'object') {
                Object.assign(base, candidate);
            }
            base.id = base.id || pid;
            const resolvedAddress = resolvePlayerAddress(pid, base);
            if (resolvedAddress) {
                base.address = resolvedAddress;
            }
            const resolvedRole = resolvePlayerRole(pid, base);
            if (resolvedRole) {
                base.role = resolvedRole;
                if (resolvedRole === 'bot' && base.bot === undefined) {
                    base.bot = true;
                }
            }
            const stackCandidates = [
                base.stack,
                base.chips,
                docData && docData.stack,
                docData && docData.chips,
            ];
            for (const candidateStack of stackCandidates) {
                if (candidateStack === undefined || candidateStack === null) continue;
                const parsed = typeof candidateStack === 'number' ? candidateStack : Number(candidateStack || 0);
                if (Number.isFinite(parsed)) {
                    base.stack = parsed;
                    break;
                }
            }
            if (base.stack === undefined) base.stack = 0;
            const parsedStack = typeof base.stack === 'number' ? base.stack : Number(base.stack || 0);
            base.stack = Number.isFinite(parsedStack) ? parsedStack : 0;
            return base;
        };

        const upsertEntry = (pid, candidate) => {
            const merged = buildEntry(pid, candidate);
            if (merged) {
                entryMap.set(pid, merged);
            }
        };

        Object.entries(preSettlePlayers || {}).forEach(([pid, pdata]) => upsertEntry(pid, pdata));
        Object.entries(game.players || {}).forEach(([pid, pdata]) => upsertEntry(pid, pdata));
        tablePlayerDocs.forEach((docData, pid) => {
            if (!entryMap.has(pid)) {
                upsertEntry(pid, docData);
            }
        });

        const entries = Array.from(entryMap.entries());
        humanEntries = entries.filter(([, pdata]) => {
            if (!pdata) return false;
            const role = String(pdata.role || '').toLowerCase();
            const isBot = pdata.bot === true || role === 'bot';
            return !isBot && !!pdata.address;
        });
        botEntries = entries.filter(([, pdata]) => {
            if (!pdata) return false;
            const role = String(pdata.role || '').toLowerCase();
            const isBot = pdata.bot === true || role === 'bot';
            return isBot;
        });

        humansWithChips = humanEntries.filter(([, pdata]) => stackFor(pdata) > 0);
        botsWithChips = botEntries.filter(([, pdata]) => stackFor(pdata) > 0);

        console.log(`[settleEndOfHand] ========================================`);
        console.log(`[settleEndOfHand] CHECKING IF PLAY VS PC MATCH ENDED`);
        console.log(`[settleEndOfHand] Table: ${tableId}`);
        
        // SIMPLE, DIRECT CHECK: Fetch from Firestore and count
        let finalHumanWithChips = false;
        let finalBotsWithChips = false;
        
        try {
            // Small delay to ensure Firestore consistency
            await new Promise(resolve => setTimeout(resolve, 150));
            
            const playersSnap = await db.collection(`tables/${tableId}/players`).get();
            
            playersSnap.forEach((doc) => {
                const data = doc.data() || {};
                const stack = typeof data.stack === 'number' ? data.stack : Number(data.stack || 0);
                const isBot = data.bot === true || String(data.role || '').toLowerCase() === 'bot';
                
                console.log(`[settleEndOfHand]   Player ${doc.id}: stack=${stack}, isBot=${isBot}, status=${data.status}`);
                
                if (isBot && Number.isFinite(stack) && stack > 0) {
                    finalBotsWithChips = true;
                }
                if (!isBot && data.address && Number.isFinite(stack) && stack > 0) {
                    finalHumanWithChips = true;
                }
            });
            
            console.log(`[settleEndOfHand] FINAL CHECK RESULT:`);
            console.log(`[settleEndOfHand]   Human has chips: ${finalHumanWithChips}`);
            console.log(`[settleEndOfHand]   Bots have chips: ${finalBotsWithChips}`);
            console.log(`[settleEndOfHand] ========================================`);
        } catch (err) {
            console.error(`[settleEndOfHand] ERROR checking match status:`, err);
            // Fallback to entry map
            finalHumanWithChips = humansWithChips.length > 0;
            finalBotsWithChips = botsWithChips.length > 0;
        }

        // DECISION: Should game continue or end?
        const matchEnded = !finalHumanWithChips || !finalBotsWithChips;
        privateAiShouldContinue = !matchEnded;
        
        console.log(`[settleEndOfHand] DECISION: matchEnded=${matchEnded}, privateAiShouldContinue=${privateAiShouldContinue}`);

        // If match ended, set resolution immediately
        if (matchEnded) {
            if (finalHumanWithChips && !finalBotsWithChips) {
                // Human won - all bots eliminated
                console.log(`[settleEndOfHand] 🎉 HUMAN WON - All bots eliminated!`);
                const winnerEntries = humanEntries.filter(([, p]) => stackFor(p) > 0);
                if (winnerEntries.length > 0) {
                    const [winnerPid, winnerPlayer] = winnerEntries[0];
                    const diff = String(tableData.aiDifficulty || 'easy').toLowerCase();
                    const mult = diff === 'hard' ? 2.10 : diff === 'medium' ? 1.45 : 1.20;
                    const baseStakeChips = Math.max(0, Number(tableData.buyin || 0));
                    const payoutChips = Math.floor(baseStakeChips * mult);
                    const rewardChips = Math.max(0, payoutChips - baseStakeChips);
                    
                    aiResolution = {
                        type: 'humanWon',
                        winnerPid,
                        winnerAddress: winnerPlayer?.address || null,
                        multiplier: mult,
                        stakeChips: baseStakeChips,
                        rewardChips,
                        stakeAlreadyReturned: false,
                    };
                    console.log(`[settleEndOfHand] aiResolution set:`, aiResolution);
                }
            } else if (!finalHumanWithChips) {
                // Human lost - eliminated
                console.log(`[settleEndOfHand] 💀 HUMAN LOST - Eliminated!`);
                console.log(`[settleEndOfHand] humanEntries count: ${humanEntries.length}`);
                humanEntries.forEach(([pid, pdata]) => {
                    console.log(`[settleEndOfHand]   Human entry ${pid}: address=${pdata?.address}, stack=${pdata?.stack}`);
                });
                
                const losers = humanEntries
                    .map(([pid, pdata]) => {
                        // Fallback address resolution: try multiple sources
                        let addr = pdata?.address;
                        if (!addr) {
                            const resolved = resolvePlayerAddress(pid, pdata);
                            if (resolved) {
                                console.log(`[settleEndOfHand] Resolved missing address for ${pid}: ${resolved}`);
                                addr = resolved;
                            }
                        }
                        return { pid, address: addr };
                    })
                    .filter(({ address }) => !!address);
                
                console.log(`[settleEndOfHand] Losers array (${losers.length} players):`, losers);
                
                if (losers.length) {
                    aiResolution = {
                        type: 'humanLost',
                        losers,
                    };
                    console.log(`[settleEndOfHand] aiResolution set:`, aiResolution);
                } else {
                    console.error(`[settleEndOfHand] CRITICAL: No losers with valid addresses! Cannot confiscate. humanEntries=${humanEntries.length}`);
                }
            }
        }
    }

    let aiMatchConcluded = isPrivateAi && (aiMatchAlreadyResolved || !!aiResolution);
    
    console.log(`[settleEndOfHand] Match conclusion check for table ${tableId}:`);
    console.log(`  - isPrivateAi: ${isPrivateAi}`);
    console.log(`  - aiMatchAlreadyResolved: ${aiMatchAlreadyResolved}`);
    console.log(`  - aiResolution: ${aiResolution ? aiResolution.type : 'none'}`);
    console.log(`  - aiMatchConcluded: ${aiMatchConcluded}`);
    console.log(`  - privateAiShouldContinue: ${privateAiShouldContinue}`);

    if (!aiMatchConcluded) {
        if (isPrivateAi) {
            if (privateAiShouldContinue) {
                // Match is NOT over - start new hand
                console.log(`[settleEndOfHand] Match continues - starting new hand for table ${tableId}`);
                try {
                    await initializeNewHand(tableId);
                    console.log(`[settleEndOfHand] New hand started successfully`);
                } catch (err) {
                    console.error(`[settleEndOfHand] Failed to start new hand:`, err);
                }
            } else {
                console.log(`[settleEndOfHand] Private AI table ${tableId} awaiting final resolution (humansWithChips=${humansWithChips.length}, botsWithChips=${botsWithChips.length}).`);
            }
        } else {
            const seatedPlayersSnap = await db.collection(`tables/${tableId}/players`).where('status', '==', 'seated').get();

            console.log(`[settleEndOfHand] Found ${seatedPlayersSnap.size} players with 'seated' status.`);

            const eligiblePlayers = [];
            const eligibleHumans = [];
            const eligibleBots = [];
            seatedPlayersSnap.forEach((doc) => {
                const data = doc.data() || {};
                const stack = typeof data.stack === 'number' ? data.stack : Number(data.stack || 0);
                if (!Number.isFinite(stack) || stack <= 0) return;

                const isBot = data.bot === true || String(data.role || '').toLowerCase() === 'bot';
                eligiblePlayers.push(doc.id);
                if (isBot) {
                    eligibleBots.push(doc.id);
                } else {
                    eligibleHumans.push(doc.id);
                }
            });

            console.log(`[settleEndOfHand] ${eligiblePlayers.length} seated players currently have chips (${eligibleHumans.length} humans, ${eligibleBots.length} bots).`);

            const localEligiblePlayers = [];
            const localHumansWithChips = [];
            const localBotsWithChips = [];
            Object.entries(game.players || {}).forEach(([pid, pdata]) => {
                if (!pdata) return;
                if (pdata.isLeaving) return;
                const stack = Number(pdata.stack || 0);
                if (!Number.isFinite(stack) || stack <= 0) return;
                localEligiblePlayers.push(pid);
                if (pdata.bot) {
                    localBotsWithChips.push(pid);
                } else if (pdata.address) {
                    localHumansWithChips.push(pid);
                }
            });
            console.log(`[settleEndOfHand] Local snapshot players with chips: humans=${localHumansWithChips.length} bots=${localBotsWithChips.length}`);

            const shouldStartNewHand = eligiblePlayers.length >= 2;

            if (shouldStartNewHand) {
                console.log(`[settleEndOfHand] CONDITIONS MET. Calling initializeNewHand for table ${tableId}.`);
                try {
                    await initializeNewHand(tableId);
                } catch (err) {
                    console.error(`[settleEndOfHand] initializeNewHand failed for table ${tableId}:`, err);
                }
            } else if (localEligiblePlayers.length >= 2) {
                console.warn(`[settleEndOfHand] Firestore snapshot returned ${eligiblePlayers.length} eligible players, but game state has ${localEligiblePlayers.length}. Forcing new hand.`);
                try {
                    await initializeNewHand(tableId);
                } catch (err) {
                    console.error(`[settleEndOfHand] forced initializeNewHand failed for table ${tableId}:`, err);
                }
            } else {
                console.log(`[settleEndOfHand] NOT ENOUGH PLAYERS to start new hand on table ${tableId}`);
                console.log(`[settleEndOfHand] - seatedPlayersSnap.size: ${seatedPlayersSnap.size}`);
                console.log(`[settleEndOfHand] - eligiblePlayers.length: ${eligiblePlayers.length}`);
                console.log(`[settleEndOfHand] - localEligiblePlayers.length: ${localEligiblePlayers.length}`);
                console.log(`[settleEndOfHand] - isPrivateAi: ${isPrivateAi}`);
                console.log(`[settleEndOfHand] - shouldStartNewHand: ${shouldStartNewHand}`);

                // Check for Last Man Standing (Multiplayer Game Over)
                // If we had players initially (seatedPlayersSnap.size >= 2) but now only 1 eligible left, that player wins.
                // Note: isPrivateAi checks above handle the AI case. This is for multiplayer.
                if (seatedPlayersSnap.size >= 2 && eligiblePlayers.length === 1) {
                    const winnerId = eligiblePlayers[0];
                    console.log(`[settleEndOfHand] 🏆 GAME OVER! Player ${winnerId} is the last man standing.`);

                    // Mark table as finished
                    try {
                        await tableRef.update({
                            status: 'finished',
                            endedAt: FieldValue.serverTimestamp(),
                            winnerId: winnerId
                        });

                        // Optional: You could trigger a full withdrawal for the winner here,
                        // but "withdrawFullVaultBalance" via the "Claim" button is safer/standard.
                        console.log(`[settleEndOfHand] Table ${tableId} marked as finished.`);
                    } catch (endErr) {
                        console.error(`[settleEndOfHand] Failed to mark table finished:`, endErr);
                    }
                } else if (seatedPlayersSnap.size >= 2 && eligiblePlayers.length < 1) {
                    console.log(`[settleEndOfHand] No eligible players left with chips.`);
                    // Maybe mark finished?
                } else {
                    console.log(`[settleEndOfHand] Seated count met but only ${eligiblePlayers.length} player(s) have chips. Awaiting buy-ins or top-ups.`);
                }
            }
        }
    } else {
        console.log(`[settleEndOfHand] AI match concluded on table ${tableId}; skipping new hand start.`);
    }

    // Process payouts for leaving players after stacks are persisted
    if (leavingDistributions.length) {
        await authorizePayoutsOnChain(leavingDistributions);
    }

    // Process AI match resolution (win/loss)
    if (aiResolution) {
        console.log(`[settleEndOfHand] ========================================`);
        console.log(`[settleEndOfHand] PROCESSING AI MATCH RESOLUTION`);
        console.log(`[settleEndOfHand] Table: ${tableId}`);
        console.log(`[settleEndOfHand] Resolution type: ${aiResolution.type}`);
        console.log(`[settleEndOfHand] ========================================`);
        
        // CRITICAL: Set aiMatchResult IMMEDIATELY so frontend shows result to user
        // Blockchain transactions will happen in background, but user sees result right away!
        // NOTE: We use a TEMPORARY field 'pendingStatus' instead of 'status' to avoid triggering
        // aiMatchAlreadyResolved=true on the NEXT hand settlement (which would skip blockchain logic!)
        const initialAutoWithdrawStatus = aiResolution.type === 'humanWon'
            ? 'pending'
            : aiResolution.type === 'humanLost'
                ? 'collecting_loss'
                : null;

        try {
            await tableRef.set({
                aiMatchResult: {
                    pendingStatus: aiResolution.type, // TEMPORARY - will become 'status' after blockchain completes
                    resolvedAt: FieldValue.serverTimestamp(),
                    winnerPid: aiResolution.type === 'humanWon' ? aiResolution.winnerPid : null,
                    multiplier: aiResolution.type === 'humanWon' ? aiResolution.multiplier : null,
                    stakeChips: aiResolution.type === 'humanWon' ? aiResolution.stakeChips : null,
                    rewardChips: aiResolution.type === 'humanWon' ? aiResolution.rewardChips : null,
                    stakeAlreadyReturned: aiResolution.type === 'humanWon' ? !!aiResolution.stakeAlreadyReturned : null,
                    processingBlockchain: true, // Flag to indicate blockchain is processing
                    autoWithdrawStatus: initialAutoWithdrawStatus,
                }
            }, { merge: true });
            console.log(`[settleEndOfHand] ✅ aiMatchResult.pendingStatus set IMMEDIATELY - frontend will show result now!`);
        } catch (err) {
            console.warn(`[settleEndOfHand] Failed to set immediate aiMatchResult for table ${tableId}`, err && err.message ? err.message : err);
        }
        
        if (aiResolution.type === 'humanWon') {
            console.log(`[settleEndOfHand] 🔥🔥🔥 AI RESOLUTION HUMAN WON - CODE VERSION v3 🔥🔥🔥`);
            if (aiResolution.winnerAddress) {
                let payoutSuccess = false;
                try {
                    const unitMultiplier = BigInt(game.unitMultiplier || 1);
                    
                    console.log(`[settleEndOfHand] DEBUG aiResolution:`, JSON.stringify(aiResolution, null, 2));
                    console.log(`[settleEndOfHand] DEBUG stakeChips: ${aiResolution.stakeChips}`);
                    console.log(`[settleEndOfHand] DEBUG stakeAlreadyReturned: ${aiResolution.stakeAlreadyReturned}`);
                    console.log(`[settleEndOfHand] DEBUG rewardChips: ${aiResolution.rewardChips}`);
                    console.log(`[settleEndOfHand] DEBUG unitMultiplier: ${unitMultiplier.toString()}`);
                    
                    // CRITICAL: Don't use stakeChips directly - it's GROSS amount before rake!
                    // Instead, check actual GameVault balance and withdraw that
                    let actualStakeUnits = 0n;
                    if (!aiResolution.stakeAlreadyReturned) {
                        try {
                            const vaultAbi = loadVaultAbi();
                            if (vaultAbi) {
                                const vault = new ethers.Contract(CFG.gameVault, vaultAbi, authWallet);
                                const onchainTableId = deriveOnchainTableId(tableId);
                                const vaultBalance = await vault.balanceOf(onchainTableId, aiResolution.winnerAddress, game.tokenAddress || ethers.ZeroAddress);
                                actualStakeUnits = vaultBalance;
                                console.log(`[settleEndOfHand] Actual GameVault balance: ${actualStakeUnits.toString()} units (after rake)`);
                            }
                        } catch (balErr) {
                            console.warn(`[settleEndOfHand] Could not check vault balance:`, balErr.message);
                            // FALLBACK: Calculate NET stake after 3% rake (300 basis points)
                            console.log(`🔥 RAKE FALLBACK CALCULATION ACTIVE - VERSION 2024-11-02-V4 🔥`);
                            const grossStake = BigInt(aiResolution.stakeChips) * unitMultiplier;
                            const rake = (grossStake * 300n) / 10000n; // 3%
                            actualStakeUnits = grossStake - rake;
                            console.warn(`[settleEndOfHand] Using calculated NET stake: ${actualStakeUnits.toString()} (gross ${grossStake.toString()} - rake ${rake.toString()})`);
                        }
                    }
                    
                    const rewardUnits = BigInt(aiResolution.rewardChips) * unitMultiplier;
                    
                    console.log(`[settleEndOfHand] CALCULATED actualStakeUnits: ${actualStakeUnits.toString()}`);
                    console.log(`[settleEndOfHand] CALCULATED rewardUnits: ${rewardUnits.toString()}`);
                    
                    console.log(`[settleEndOfHand] 🎉 HUMAN WON! Player ${aiResolution.winnerPid} defeated all bots on table ${tableId}`);
                    console.log(`[settleEndOfHand] Triggering final payout (mult=${aiResolution.multiplier}, stakeAlreadyReturned=${aiResolution.stakeAlreadyReturned}).`);
                    console.log(`[settleEndOfHand] PvE Win: stake=${actualStakeUnits.toString()} reward=${rewardUnits.toString()} (bot chips are virtual and not withdrawn)`);
                    
                    payoutSuccess = await pvePayoutStakeAndReward({
                        tableId,
                        player: aiResolution.winnerAddress,
                        tokenAddress: game.tokenAddress || ethers.ZeroAddress,
                        stakeUnits: actualStakeUnits,
                        rewardUnits,
                    });
                    
                    if (!payoutSuccess) {
                        console.error(`[settleEndOfHand] ⚠️ Payout FAILED! Not marking match as resolved to allow retry.`);
                        // Don't set aiMatchResult - allow retry on next settlement
                        await bumpTableActivity(tableId);
                        return;
                    }
                    
                    console.log(`[settleEndOfHand] ✅ Payout successful, marking match as resolved`);
                    
                    // Update leaderboard stats for WIN
                    try {
                        // Try to get player name from table players
                        let playerName = 'Player';
                        try {
                            const playerDoc = await admin.firestore().collection('tables').doc(tableId).collection('players').doc(aiResolution.winnerPid).get();
                            if (playerDoc.exists) {
                                playerName = playerDoc.data().displayName || playerDoc.data().name || aiResolution.winnerPid;
                            }
                        } catch (_) {}
                        
                        await updatePlayerStats({
                            playerAddress: aiResolution.winnerAddress,
                            playerName,
                            result: 'win',
                            buyinChips: aiResolution.stakeChips,
                            rewardChips: aiResolution.rewardChips,
                            difficulty: tableData.aiDifficulty || 'easy'
                        });
                    } catch (statsErr) {
                        console.warn(`[settleEndOfHand] Failed to update player stats:`, statsErr);
                    }
                    
                    try {
                        // Flush any remaining stake units that might still sit in the GameVault balance
                        // (e.g. safety against rounding or prior partial withdrawals).
                        await withdrawFullVaultBalance({
                            tableId,
                            player: aiResolution.winnerAddress,
                            tokenAddress: game.tokenAddress || ethers.ZeroAddress,
                            reason: 'pve_win_flush',
                        });
                    } catch (flushErr) {
                        console.warn(`[settleEndOfHand] withdrawFullVaultBalance (win flush) failed for table ${tableId}`, flushErr && flushErr.message ? flushErr.message : flushErr);
                    }
                } catch (e) {
                    console.error(`[settleEndOfHand] ❌ pvePayoutStakeAndReward EXCEPTION for table ${tableId}:`, e && e.message ? e.message : e);
                    console.error(`[settleEndOfHand] Stack:`, e.stack);
                    // Don't set aiMatchResult - allow retry
                    await bumpTableActivity(tableId);
                    return;
                }
            } else {
                console.warn(`[settleEndOfHand] Could not resolve human winner address for table ${tableId}; skipping final payout.`);
            }
        } else if (aiResolution.type === 'humanLost') {
            console.log(`[settleEndOfHand] 💀 HUMAN LOST! All human players eliminated on table ${tableId}. Confiscating stake.`);
            
            const CFG = getCfg();
            const houseWalletAddress = (CFG.houseWallet || CFG.owner || '').toLowerCase();
            if (!houseWalletAddress || !ethers.isAddress(houseWalletAddress)) {
                console.error(`[Confiscate] CRITICAL: House wallet not configured. Cannot confiscate funds for table ${tableId}.`);
                await tableRef.set({ aiMatchResult: { ...aiResolution, status: 'error', blockchainError: 'House wallet not configured' } }, { merge: true });
            } else {
                for (const loser of aiResolution.losers) {
                    console.log(`[Confiscate] Processing loser: ${loser.pid}, address: ${loser.address}`);
                    if (!loser.address || !ethers.isAddress(loser.address)) {
                        console.warn(`[Confiscate] Skipping confiscation for player ${loser.pid}: invalid address`, loser.address);
                        continue;
                    }

                    let authWallet;
                    let provider;
                    try {
                        const rpcUrl = process.env.RPC_URL || CFG.rpcUrl || 'http://127.0.0.1:8545';
                        provider = new ethers.JsonRpcProvider(rpcUrl);
                        const authPk = CFG.privateKey;
                        if (!authPk) throw new Error('Missing game server signer key (configure PRIVATE_KEY)');
                        authWallet = new ethers.Wallet(authPk, provider);
                    } catch (walletErr) {
                        console.error(`[Confiscate] Wallet/Provider setup failed for table ${tableId}:`, walletErr.message);
                        continue;
                    }

                    const vaultAbi = loadVaultAbi();
                    if (!vaultAbi) {
                        console.error(`[Confiscate] Vault ABI not available for table ${tableId}.`);
                        continue;
                    }
                    const vault = new ethers.Contract(CFG.gameVault, vaultAbi, authWallet);
                    const onchainTableId = deriveOnchainTableId(tableId);
                    const normalizedToken = game.tokenAddress ? normalizeAddress(game.tokenAddress) : ethers.ZeroAddress;
                    let stakeUnits = 0n;

                    try {
                        // Handle overloaded balanceOf signatures safely (some vaults expose both
                        // balanceOf(uint256,address) and balanceOf(uint256,address,address)).
                        let rawBal = null;
                        if (typeof vault['balanceOf(uint256,address,address)'] === 'function') {
                            rawBal = await vault['balanceOf(uint256,address,address)'](onchainTableId, loser.address, normalizedToken);
                        } else {
                            // Fallback: try calling the generic method (may still be overloaded)
                            rawBal = await vault.balanceOf(onchainTableId, loser.address, normalizedToken);
                        }
                        stakeUnits = BigInt(rawBal.toString ? rawBal.toString() : rawBal || 0);
                        if (stakeUnits <= 0n) {
                            console.log(`[Confiscate] Player ${loser.pid} has no balance in vault for table ${tableId}. Nothing to confiscate.`);
                            continue;
                        }

                        console.log(`[Confiscate] Attempting to confiscate ${stakeUnits.toString()} units from ${loser.address} to house ${houseWalletAddress}.`);

                        // Step 1: Move balance from player to house (internally in the vault).
                        console.log(`[Confiscate] Step 1: Calling moveBalance(${onchainTableId}, ${normalizedToken}, ${loser.address}, ${houseWalletAddress}, ${stakeUnits.toString()})`);
                        const txMove = await vault.moveBalance(onchainTableId, normalizedToken, loser.address, houseWalletAddress, stakeUnits);
                        const rcMove = await txMove.wait();
                        if (rcMove.status !== 1) {
                            throw new Error(`moveBalance transaction failed with status ${rcMove.status}. Hash: ${txMove.hash}`);
                        }
                        console.log(`[Confiscate] Step 1 (moveBalance) successful. Tx: ${txMove.hash}`);

                        // Step 2: Some vault implementations route withdrawFor through PrizeDistributor,
                        // which requires authorizePayout to be called by a prize-pool signer. Attempt
                        // to perform that authorization automatically if a prize-pool signer is available.
                        let pdAuthorized = false;
                        try {
                            if (!CFG.prizeDistributor) {
                                console.warn('[Confiscate] No PrizeDistributor configured; attempting withdrawFor may revert.');
                            } else {
                                try {
                                    // PrizeDistributor authorizes only the game server signer, so reuse authWallet here.
                                    if (CFG.gameServer) {
                                        const expected = CFG.gameServer.toLowerCase();
                                        const signerAddr = (authWallet.address || '').toLowerCase();
                                        if (signerAddr && signerAddr !== expected) {
                                            console.warn(`[Confiscate] WARNING: game server signer ${signerAddr} does not match configured gameServer ${CFG.gameServer}. Authorization may fail.`);
                                        }
                                    }
                                    const pdContract = new ethers.Contract(CFG.prizeDistributor, PRIZE_DISTRIBUTOR_ABI, authWallet);
                                    console.log(`[Confiscate] Step 2a: Authorizing payout on PrizeDistributor for house ${houseWalletAddress} amount ${stakeUnits.toString()}...`);
                                    const authTx = await pdContract.authorizePayout(houseWalletAddress, normalizedToken, stakeUnits);
                                    console.log(`[Confiscate] authorizePayout tx sent: ${authTx.hash}, waiting...`);
                                    const authRc = await authTx.wait();
                                    if (authRc && authRc.status === 1) {
                                        pdAuthorized = true;
                                        console.log(`[Confiscate] authorizePayout succeeded: ${authTx.hash}`);
                                        try {
                                            await db.collection('payouts').doc(authTx.hash).set({
                                                txHash: authTx.hash,
                                                type: 'confiscation_authorization',
                                                tableId: String(tableId),
                                                house: houseWalletAddress,
                                                token: normalizedToken,
                                                amount: String(stakeUnits),
                                                status: 'authorized',
                                                receipt: serializeReceipt(authRc),
                                                createdAt: FieldValue.serverTimestamp(),
                                            }, { merge: true });
                                        } catch (_) {}
                                    } else {
                                        throw new Error(`authorizePayout tx failed with status ${authRc ? authRc.status : 'unknown'}`);
                                    }
                                } catch (authErr) {
                                    console.error('[Confiscate] authorizePayout failed:', authErr && authErr.message ? authErr.message : authErr);
                                    try {
                                        await db.collection('failedPayouts').add({
                                            tableId: String(tableId),
                                            player: String(loser.address).toLowerCase(),
                                            token: normalizedToken,
                                            amount: stakeUnits ? stakeUnits.toString() : 'unknown',
                                            step: 'authorizePayout',
                                            error: String(authErr && authErr.message ? authErr.message : authErr),
                                            createdAt: FieldValue.serverTimestamp(),
                                            status: 'pending_manual_check',
                                        });
                                    } catch (_) {}
                                }
                            }
                        } catch (outerAuthErr) {
                            console.error('[Confiscate] Unexpected error during authorizePayout attempt:', outerAuthErr && outerAuthErr.message ? outerAuthErr.message : outerAuthErr);
                        }

                        // If PrizeDistributor is configured we require authorization to proceed (otherwise
                        // withdrawFor will likely revert). If authorization did not occur, record and abort.
                        if (CFG.prizeDistributor && !pdAuthorized) {
                            const msg = 'PrizeDistributor authorization not available; aborting withdrawFor to avoid revert.';
                            console.warn('[Confiscate] ' + msg);
                            await db.collection('failedPayouts').add({
                                tableId: String(tableId),
                                player: String(loser.address).toLowerCase(),
                                token: normalizedToken,
                                amount: stakeUnits ? stakeUnits.toString() : 'unknown',
                                step: 'pre-withdraw-authorization',
                                error: msg,
                                createdAt: FieldValue.serverTimestamp(),
                                status: 'pending_manual_check',
                            });
                            throw new Error(msg);
                        }

                        console.log(`[Confiscate] Step 2: Calling withdrawFor(${onchainTableId}, ${houseWalletAddress}, ${normalizedToken}, ${stakeUnits.toString()})`);
                        const txWithdraw = await vault.withdrawFor(onchainTableId, houseWalletAddress, normalizedToken, stakeUnits);
                        const rcWithdraw = await txWithdraw.wait();
                        if (rcWithdraw.status !== 1) {
                            throw new Error(`withdrawFor transaction failed with status ${rcWithdraw.status}. Hash: ${txWithdraw.hash}`);
                        }
                        console.log(`[Confiscate] Step 2 (withdrawFor) successful. Tx: ${txWithdraw.hash}`);
                        
                        console.log(`[Confiscate] ✅ Successfully confiscated ${stakeUnits.toString()} units from player ${loser.pid}.`);

                        // Update leaderboard stats for LOSS
                        try {
                            const baseStakeChips = Math.max(0, Number(tableData.buyin || 0));
                            let playerName = loser.pid || 'Player';
                            try {
                                const playerDoc = await admin.firestore().collection('tables').doc(tableId).collection('players').doc(loser.pid).get();
                                if (playerDoc.exists) {
                                    playerName = playerDoc.data().displayName || playerDoc.data().name || loser.pid;
                                }
                            } catch (_) {}
                            
                            await updatePlayerStats({
                                playerAddress: loser.address,
                                playerName,
                                result: 'loss',
                                buyinChips: baseStakeChips,
                                rewardChips: 0,
                                difficulty: tableData.aiDifficulty || 'easy'
                            });
                        } catch (statsErr) {
                            console.warn(`[Confiscate] Failed to update player stats for ${loser.pid}:`, statsErr);
                        }

                    } catch (err) {
                        console.error(`[Confiscate] ❌ FAILED to confiscate funds for player ${loser.pid} on table ${tableId}.`);
                        console.error(`[Confiscate] Error: ${err.message}`);
                        if (err.reason) console.error(`[Confiscate] Reason: ${err.reason}`);
                        // Record error for manual check
                        await db.collection('failedPayouts').add({
                            tableId: String(tableId),
                            player: String(loser.address).toLowerCase(),
                            token: normalizedToken,
                            amount: stakeUnits ? stakeUnits.toString() : 'unknown',
                            step: 'confiscation',
                            error: err.message,
                            reason: err.reason || null,
                            status: 'pending_manual_check',
                            createdAt: FieldValue.serverTimestamp(),
                        });
                    }
                }
            }
        }

        // Update blockchain processing status to complete AND set final status field
        const finalAiStatus = aiResolution.type === 'humanWon' ? 'pending' : 'lost';
        try {
            await tableRef.set({
                status: 'finished', // CRITICAL: Set table status to 'finished' so cleanup can delete it
                aiMatchResult: {
                    autoWithdrawStatus: finalAiStatus,
                    status: aiResolution.type, // NOW set the real status (after blockchain complete)
                    processingBlockchain: false, // Blockchain processing complete
                    blockchainCompletedAt: FieldValue.serverTimestamp(),
                }
            }, { merge: true });
            console.log(`[settleEndOfHand] ✅ Blockchain processing complete for table ${tableId}, autoWithdrawStatus finalized to '${finalAiStatus}'`);
        } catch (err) {
            console.warn(`[settleEndOfHand] Failed to update blockchain completion status for table ${tableId}`, err && err.message ? err.message : err);
        }

        await bumpTableActivity(tableId);
        return;
    }

    if (aiMatchAlreadyResolved && isPrivateAi) {
        await bumpTableActivity(tableId);
        return;
    }

    // Mark recent activity on table document
    await bumpTableActivity(tableId);
}

// --- Time bank auto-fold ---
exports.checkTimeouts = onSchedule({
    schedule: 'every 1 minutes',
    secrets: [RPC_URL, PRIVATE_KEY, PRIZE_POOL_PK, FUND_SENDER_PK, PRIZE_DISTRIBUTOR, ALLOWED_LSP7_TOKEN, LYX_UNIT_MULTIPLIER, LSP7_UNIT_MULTIPLIER, GAME_VAULT]
}, async () => {
    // Calculate a threshold timestamp. Only tables with lastActionAt older than this
    // timestamp are considered expired and need processing. We add a small buffer
    // (TIME_BANK_SECONDS + 5s) to reduce race conditions where actions happen
    // around the same time the scheduler runs.
    const now = Date.now();
    // Use Date for conversion to Firestore Timestamp.fromDate below
    const timeoutThreshold = new Date(now - ((TIME_BANK_SECONDS + 5) * 1000));

    const tablesSnap = await db.collection('tables')
        .where('status','==','active')
        .where('lastActivityAt', '<', admin.firestore.Timestamp.fromDate(timeoutThreshold))
        .get();

    if (tablesSnap.empty) return;

    for (const tableDoc of tablesSnap.docs) {
        const tableId = tableDoc.id;
        const gameRef = db.doc(`tables/${tableId}/game/state`);
        const gameSnap = await gameRef.get();
        if (!gameSnap.exists) continue;
        const game = gameSnap.data();
        try {
            const last = game.lastActionAt && game.lastActionAt.toDate ? game.lastActionAt.toDate() : null;
            const now = new Date();
            if (!last || (now - last)/1000 > TIME_BANK_SECONDS) {
                const pid = game.turn;
                if (pid && game.players[pid] && game.players[pid].inHand && !game.players[pid].folded) {
                    const player = game.players[pid];
                    const isHuman = !player.bot;
                    
                    // CRITICAL: Track consecutive timeouts for human players (actual inactivity)
                    // Only counts when player makes NO action (no clicks) - auto-fold/blinds don't reset this
                    if (isHuman) {
                        game.players[pid].consecutiveTimeouts = (game.players[pid].consecutiveTimeouts || 0) + 1;
                        console.log(`🕒 Player ${pid} timeout #${game.players[pid].consecutiveTimeouts} (consecutive) on table ${tableId}`);
                    }
                    
                    console.log(`Auto-folding player ${pid} on table ${tableId} due to timeout.`);
                    game.players[pid].inHand = false;
                    game.players[pid].folded = true;
                    
                    // CHECK: If human player had 3 consecutive timeouts (NO user action) -> AUTO-FORFEIT (AI games only)
                    const tableDoc = await db.collection('tables').doc(tableId).get();
                    const tableData = tableDoc.exists ? tableDoc.data() : {};
                    const isAiGame = tableData.mode === 'ai' || tableData.gameType === 'PvE';
                    
                    if (isHuman && isAiGame && game.players[pid].consecutiveTimeouts >= 3) {
                        console.log(`🚨 Player ${pid} had 3 CONSECUTIVE timeouts (no user action) - AUTO-FORFEITING AI game ${tableId}`);
                        console.log(`[AUTO-FORFEIT] consecutiveTimeouts = ${game.players[pid].consecutiveTimeouts}, player address = ${game.players[pid].address}`);
                        
                        // Human loses by forfeit - confiscate stake to house
                        try {
                            // CRITICAL: Read actual GameVault balance EXACTLY like normal loss scenario
                            let actualStakeUnits = 0n;
                            try {
                                const vaultAbi = loadVaultAbi();
                                if (vaultAbi) {
                                    const authPk = CFG.privateKey;
                                    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || getCfg().rpcUrl || 'http://127.0.0.1:8545');
                                    const authWallet = new ethers.Wallet(authPk, provider);
                                    const vault = new ethers.Contract(CFG.gameVault, vaultAbi, authWallet);
                                    const onchainTableId = deriveOnchainTableId(tableId);
                                    const vaultBalance = await vault.balanceOf(onchainTableId, game.players[pid].address, game.tokenAddress || ethers.ZeroAddress);
                                    actualStakeUnits = vaultBalance;
                                    console.log(`[AUTO-FORFEIT] Actual GameVault balance for ${pid}: ${actualStakeUnits.toString()} units`);
                                }
                            } catch (balErr) {
                                console.warn(`[AUTO-FORFEIT] Could not check vault balance for ${pid}:`, balErr.message);
                                // FALLBACK: Calculate NET stake after 3% rake (same as normal loss)
                                const buyin = Number(tableData.buyin || 0);
                                const unitMultiplier = BigInt(game.unitMultiplier || 1000000000000000000n);
                                const grossStake = BigInt(buyin) * unitMultiplier;
                                const rake = (grossStake * 300n) / 10000n; // 3%
                                actualStakeUnits = grossStake - rake;
                                console.warn(`[AUTO-FORFEIT] Using calculated NET stake for ${pid}: ${actualStakeUnits.toString()} (gross ${grossStake.toString()} - rake ${rake.toString()})`);
                            }
                            
                            if (actualStakeUnits === 0n) {
                                console.warn(`[AUTO-FORFEIT] Skipping forfeit for ${pid}: stake is 0`);
                                continue;
                            }
                            
                            console.log(`[AUTO-FORFEIT] Confiscating ${actualStakeUnits.toString()} units from ${game.players[pid].address} (${game.players[pid].consecutiveTimeouts} consecutive timeouts)`);
                            
                            await pveConfiscateLoss({
                                tableId,
                                player: game.players[pid].address,
                                tokenAddress: game.tokenAddress || ethers.ZeroAddress,
                                stakeUnits: actualStakeUnits,
                            });
                            
                            console.log(`[AUTO-FORFEIT] ✅ pveConfiscateLoss succeeded for ${pid}`);
                            
                            // Update leaderboard (use tableData.buyin for chip amount)
                            const buyinChips = Math.max(0, Number(tableData.buyin || 0));
                            try {
                                await updatePlayerStats({
                                    playerAddress: game.players[pid].address,
                                    playerName: game.players[pid].name || 'Player',
                                    result: 'loss',
                                    buyinChips: buyinChips,
                                    rewardChips: 0,
                                    difficulty: tableData.aiDifficulty || 'easy'
                                });
                            } catch (_) {}
                            
                            // Mark game as finished
                            await db.collection('tables').doc(tableId).set({
                                status: 'finished',
                                aiMatchResult: {
                                    status: 'humanLost',
                                    pendingStatus: 'humanLost',
                                    resolvedAt: FieldValue.serverTimestamp(),
                                    reason: 'timeout_forfeit',
                                    consecutiveTimeouts: game.players[pid].consecutiveTimeouts,
                                    processingBlockchain: false,
                                }
                            }, { merge: true });
                            
                            console.log(`✅ AI game ${tableId} forfeited - human lost by timeout (${game.players[pid].consecutiveTimeouts} consecutive timeouts, no user action)`);
                            
                            // CRITICAL: Save game state with updated consecutiveTimeouts before continuing
                            await gameRef.set(game);
                            
                            continue; // Skip further processing for this table
                        } catch (err) {
                            console.error(`Failed to forfeit AI game ${tableId}:`, err && err.message ? err.message : err);
                        }
                    }
                    
                    // Advance turn or end/advance phase
                    const stillIn = activePlayers(game);
                    if (stillIn.length === 1) {
                        const winnerId = stillIn[0];
                        game.players[winnerId].stack += game.pot;
                        game.pot = 0;
                        await gameRef.set(game);
                        await bumpTableActivity(tableId);
                        await settleEndOfHand(tableId, game);
                        continue;
                    }
                    // If bets equal and everyone acted -> advance phase
                    if (allBetsEqualAmongActives(game) && everyoneActedOrAllIn(game)) {
                        await gameRef.set(game);
                        await bumpTableActivity(tableId);
                        await advancePhase(tableId, game, gameRef);
                        continue;
                    }
                    // Else move to next player
                    let next = nextActivePlayerId(game, pid);
                    next = await skipAutoFoldIfNeeded(tableId, game, next);
                    game.turn = next;
                    game.lastActionAt = FieldValue.serverTimestamp();
                    await gameRef.set(game);
                    await bumpTableActivity(tableId);
                    // Auto-act if next turn is a bot
                    await maybeAutoAct(tableId);
                }
            }
        } catch (e) {
            console.error('checkTimeouts error', e);
        }
    }
});

// Advance tournament levels for non-cash tables (affects next hand blinds)
exports.advanceTournamentLevels = onSchedule({ schedule: 'every 1 minutes' }, async () => {
    try {
        const snap = await db.collection('tables').where('status','==','active').get();
        const now = Date.now();
        for (const docSnap of snap.docs) {
            const t = docSnap.data() || {};
            if (!t.type || t.type === 'cash') continue;
            const tour = t.tournament;
            if (!tour || !Array.isArray(tour.levels) || tour.levels.length === 0) continue;
            const startedAt = tour.levelStartedAt && typeof tour.levelStartedAt.toMillis === 'function' ? tour.levelStartedAt.toMillis() : 0;
            const dur = (tour.levelDurationSec || 600) * 1000;
            if (!startedAt || (now - startedAt) < dur) continue;
            const nextLevel = Math.min((tour.currentLevel || 0) + 1, tour.levels.length - 1);
            await docSnap.ref.set({
                tournament: {
                    ...tour,
                    currentLevel: nextLevel,
                    levelStartedAt: FieldValue.serverTimestamp(),
                }
            }, { merge: true });
            console.log(`Advanced table ${docSnap.id} to level ${nextLevel}`);
        }
    } catch (e) {
        console.error('advanceTournamentLevels error', e);
    }
});

// Helper: get GameVault contract connected via RPC (read-only)
function getVaultContract() {
    const cfg = getCfg();
    if (!cfg.rpcUrl || !cfg.gameVault) return null;
    // Force RPC to the compose hostname so functions container reaches the hardhat node.
    const rpcUrl = process.env.RPC_URL || getCfg().rpcUrl || 'http://127.0.0.1:8545';
    console.log('getVaultContract (HARDCODED) connecting to rpcUrl=', rpcUrl);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const abi = loadVaultAbi();
    if (!abi) {
        console.warn('getVaultContract: GameVault ABI not found (expecting GameVaultV6 artifact).');
        return null; // artifact not present yet
    }
    return new ethers.Contract(cfg.gameVault, abi, provider);
}

// Scheduled: verify deposits for tables in 'starting' state and promote/rollback as needed
exports.verifyStartingTables = onSchedule({ schedule: 'every 1 minutes', secrets: [RPC_URL, GAME_VAULT] }, async () => {
    try {
        const snap = await db.collection('tables').where('status','==','starting').get();
        if (snap.empty) return;
        const now = Date.now();
        const vault = getVaultContract();
        for (const docSnap of snap.docs) {
            const t = docSnap.data() || {};
            const tableId = docSnap.id;
            const startingAtMs = t.startingAt && typeof t.startingAt.toMillis === 'function' ? t.startingAt.toMillis() : (t.startingAt ? Date.parse(t.startingAt) : 0);
            const windowSec = Number(t.paymentWindowSec || 60);
            if (!startingAtMs) continue;
            if (now < startingAtMs + windowSec * 1000) continue; // still waiting

            // Time window expired — check which players paid
            const playersCol = db.collection(`tables/${tableId}/players`);
            const playersSnap = await playersCol.get();
            const paidPlayers = [];
            const unpaidPlayers = [];
            for (const pDoc of playersSnap.docs) {
                const pd = pDoc.data() || {};
                const addr = (pd.address || '').toLowerCase();
                if (!addr) {
                    unpaidPlayers.push(pDoc);
                    continue;
                }
                let balance = 0n;
                try {
                    if (vault && typeof vault.balanceOf === 'function') {
                        const res = await vault.balanceOf(Number(tableId), addr);
                        balance = BigInt(res.toString ? res.toString() : res || 0);
                    }
                } catch (e) {
                    console.warn('Vault balanceOf error', e);
                }
                const unitMultiplier = BigInt(t.unitMultiplier || 1);
                const chipsPaid = Number(balance / unitMultiplier);
                const requiredChips = Number(t.buyin || 0) || 0;
                if (chipsPaid >= requiredChips && requiredChips > 0) {
                    paidPlayers.push({ doc: pDoc, chipsPaid });
                } else {
                    unpaidPlayers.push(pDoc);
                }
            }

            // If not enough paid players, remove unpaid players (delete player docs) and revert table
            const minPlayers = Math.max(2, Number(t.minPlayers || 2));
            if (paidPlayers.length >= minPlayers) {
                // mark paid players as 'paid' and set table active
                const batch = db.batch();
                for (const p of paidPlayers) {
                    batch.set(p.doc.ref, { status: 'paid' }, { merge: true });
                }
                batch.update(docSnap.ref, { status: 'active', startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
                await batch.commit();
                console.log(`Table ${tableId} promoted to active with ${paidPlayers.length} paid players.`);
            } else {
                // Remove unpaid players and revert to waiting or delete table if empty
                const batch = db.batch();
                for (const pDoc of unpaidPlayers) batch.delete(pDoc.ref);
                // After deletions, check remaining players count
                await batch.commit();
                const remainSnap = await playersCol.get();
                if (remainSnap.empty) {
                    console.log(`No players paid for table ${tableId}; deleting table.`);
                    await cascadeDeleteWaitingTable(tableId);
                } else {
                    console.log(`Not enough players paid for table ${tableId}; reverting to waiting.`);
                    await docSnap.ref.update({ status: 'waiting', updatedAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
                }
            }
        }
    } catch (e) {
        console.error('verifyStartingTables error', e);
    }
});
// Trigger: when a table's status changes to 'active', create initial game state if missing
exports.onTableStatusChange = onDocumentUpdated({
    document: 'tables/{tableId}',
    secrets: [
        RPC_URL,
        PRIVATE_KEY,
        PRIZE_DISTRIBUTOR,
        PRIZE_POOL_PK,
        FUND_SENDER_PK,
        ALLOWED_LSP7_TOKEN,
        LYX_UNIT_MULTIPLIER,
        LSP7_UNIT_MULTIPLIER,
        GAME_VAULT,
        GAME_ENTRY,
        GAME_SERVER,
        HOUSE_WALLET_SEC,
        DEFAULT_RAKE_BPS_SEC,
        ADMIN_TOKEN,
        ADMIN_OWNER_PK,
        DEV_ALLOW_PUBLIC_DEPOSIT,
        DEBUG_TOKEN_SEC,
        ALLOW_DEBUG_SEC,
    ],
}, async (event) => {
    const { tableId } = event.params;
    const before = event.data && event.data.before ? event.data.before.data() || {} : {};
    const after = event.data && event.data.after ? event.data.after.data() || {} : {};

    const previousStatus = before.status || 'unknown';
    const nextStatus = after.status || 'unknown';
    console.log(`[onTableStatusChange] table=${tableId} ${previousStatus} -> ${nextStatus}`);

    if (previousStatus === nextStatus) {
        return;
    }

    // Initialize when table becomes 'active' OR enters 'starting' state
    // (many client flows use a two-step start: 'starting' -> backend verifies payments -> 'active').
    // For AI/private games we want to initialize immediately on 'starting' so the UI can proceed.
    if (after.status === 'active' || after.status === 'starting') {
        try {
            console.log(`Table ${tableId} is now active. Initializing first hand.`);

            const gameRef = db.doc(`tables/${tableId}/game/state`);
            const gameSnap = await gameRef.get();
            if (gameSnap.exists) {
                console.log(`Game state for table ${tableId} already exists. Skipping initialization.`);
                return;
            }

            // Zaženi prvo rundo igre
            await initializeNewHand(tableId);

        } catch (e) {
            console.error(`ERROR in onTableStatusChange for table ${tableId}:`, e);
        }
    }
});

// Auto-configure table on creation: set owner wallet and rake on-chain
exports.onTableCreatedConfigureRake = onDocumentCreated({ document: 'tables/{tableId}', secrets: [RPC_URL, PRIVATE_KEY, GAME_VAULT, HOUSE_WALLET_SEC, DEFAULT_RAKE_BPS_SEC, ADMIN_OWNER_PK] }, async (event) => {
    try {
        const cfg = getCfg();
        const houseWallet = (HOUSE_WALLET_SEC.value && HOUSE_WALLET_SEC.value()) || process.env.HOUSE_WALLET || '';
        const defaultRake = Number((DEFAULT_RAKE_BPS_SEC.value && DEFAULT_RAKE_BPS_SEC.value()) || process.env.DEFAULT_RAKE_BPS || 300);
        if (!cfg.rpcUrl || !cfg.gameVault) { console.warn('onCreate: missing rpcUrl/gameVault'); return; }
        if (!houseWallet || !ethers.isAddress(houseWallet)) { console.warn('onCreate: missing/invalid HOUSE_WALLET'); return; }
        if (!(defaultRake >= 0 && defaultRake <= 10000)) { console.warn('onCreate: invalid DEFAULT_RAKE_BPS'); return; }

        const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
        const sanitizePk = (k) => {
            if (!k) return '';
            let t = String(k).trim().replace(/\r|\n/g, '').replace(/^['"]|['"]$/g, '');
            if (!t.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(t)) t = '0x' + t;
            return t;
        };
        const isValidPk = (k) => typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k);
        const envOwnerPk = sanitizePk(process.env.ADMIN_OWNER_PK || (ADMIN_OWNER_PK.value && ADMIN_OWNER_PK.value()) || '');
        const fallbackPk = cfg.privateKey;
        const signerPk = isValidPk(envOwnerPk) ? envOwnerPk : fallbackPk;
        if (!isValidPk(signerPk)) {
            console.warn('onCreate: missing signer private key (configure ADMIN_OWNER_PK or PRIVATE_KEY).');
            return;
        }
        let wallet;
        try {
            wallet = new ethers.Wallet(signerPk, provider);
        } catch (err) {
            console.error('onCreate: invalid signer private key configured', err);
            return;
        }
        const signerAddr = await wallet.getAddress();
        if (cfg.owner) {
            try {
                const expectedOwner = ethers.getAddress(cfg.owner);
                if (expectedOwner.toLowerCase() !== signerAddr.toLowerCase()) {
                    console.warn('onCreate: signer does not match configured owner', { expectedOwner, signerAddr });
                }
            } catch (_) {
                console.warn('onCreate: configured owner address invalid', { owner: cfg.owner });
            }
        }

        let vaultAbi = loadVaultAbi();
        if (!vaultAbi) {
            vaultAbi = [
                'function owner() view returns (address)',
                'function setTableConfig(uint256 tableId, address ownerWallet, uint16 rakeBps) external'
            ];
        }
        const vault = new ethers.Contract(cfg.gameVault, vaultAbi, wallet);

        // Determine if UP routing is required
        let vaultOwner = null; try { vaultOwner = await vault.owner(); } catch {}
        const isOwnerContract = vaultOwner ? ((await provider.getCode(vaultOwner)) !== '0x') : false;
        const needsUP = isOwnerContract && (vaultOwner.toLowerCase() !== signerAddr.toLowerCase());
        async function executeViaUP(upAddr, to, data) {
            const UP_ABI = [
                'function execute(uint256 operationType, address to, uint256 value, bytes data) external payable returns (bytes)',
                'function owner() view returns (address)'
            ];
            const KM_ABI = ['function execute(bytes calldata payload) external payable returns (bytes)'];
            const up = new ethers.Contract(upAddr, UP_ABI, provider);
            const keyManager = await up.owner();
            const km = new ethers.Contract(keyManager, KM_ABI, wallet);
            const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, to, 0, data]);
            const tx = await km.execute(payload);
            const rc = await tx.wait();
            return { tx: tx.hash, status: rc?.status };
        }

        // Map Firestore tableId to on-chain id (use numeric parse; fallback to keccak if non-numeric)
        const rawId = event?.params?.tableId;
        let onchainId;
        if (/^\d+$/.test(String(rawId))) {
            onchainId = BigInt(rawId);
        } else {
            onchainId = BigInt(ethers.keccak256(ethers.toUtf8Bytes(String(rawId))));
        }

        // Execute setTableConfig
        const data = (vault.interface && vault.interface.encodeFunctionData)
            ? vault.interface.encodeFunctionData('setTableConfig', [onchainId, houseWallet, defaultRake])
            : new ethers.Interface(vaultAbi).encodeFunctionData('setTableConfig', [onchainId, houseWallet, defaultRake]);
        if (needsUP) {
            const r = await executeViaUP(vaultOwner, cfg.gameVault, data);
            console.log('onCreate setTableConfig via UP', rawId, r);
        } else {
            const tx = await vault.setTableConfig(onchainId, houseWallet, defaultRake);
            const rc = await tx.wait();
            console.log('onCreate setTableConfig direct', rawId, tx.hash, rc?.status);
        }
    } catch (e) {
        console.error('onTableCreatedConfigureRake error', e);
    }
});

// HTTP endpoint: startAiGame - two-step flow
// POST body { step: 'create', difficulty, buyin, tokenAddress, unitMultiplier, hostAddress, hostName, bots }
// POST body { step: 'confirm', tableId, txHash, hostAddress }
try {
    const ffv1 = require('firebase-functions');
    exports.startAiGame = ffv1.https.onRequest(async (req, res) => {
        try {
            // Basic CORS handling to allow frontend from localhost during manual testing and prod origins
            const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || '';
            const allowedOrigins = new Set([
                'http://localhost:3002',
                'http://127.0.0.1:3002',
                // Common LAN dev IPs (adjust dynamically if needed)
                'http://192.168.1.201:3002',
            ]);
            const allowAll = true; // safe for this public endpoint; tighten later if required
            if (origin && (allowAll || allowedOrigins.has(String(origin)))) {
                res.setHeader('Access-Control-Allow-Origin', String(origin));
                res.setHeader('Vary', 'Origin');
            } else {
                res.setHeader('Access-Control-Allow-Origin', '*');
            }
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token, x-debug-token');
            res.setHeader('Access-Control-Max-Age', '3600');
            if (req.method === 'OPTIONS') return res.status(204).send('');

            if (req.method !== 'POST') return res.status(405).send('Only POST allowed');
            const body = req.body || {};
            const step = body.step || 'create';
            if (step === 'create') {
                // Create a private AI table in 'starting' state so frontend can submit on-chain deposit
                const difficulty = String(body.difficulty || 'easy').toLowerCase();
                const buyin = Math.floor(Number(body.buyin || 0));
                const requestedToken = String((body.tokenAddress || ethers.ZeroAddress) || ethers.ZeroAddress);
                const unitMultiplierRaw = body.unitMultiplier;
                const hostAddress = String((body.hostAddress || '')).toLowerCase();
                const hostName = String(body.hostName || 'Player');
                // Fixed bot counts per difficulty: Easy=2, Medium=4, Hard=6
                const bots = (difficulty === 'hard') ? 6 : (difficulty === 'medium') ? 4 : 2;

                if (!hostAddress) return res.status(400).json({ error: 'hostAddress required' });

                const cfg = getCfg();
                const normalizeMultiplier = (value) => {
                    try {
                        if (value === undefined || value === null) return null;
                        if (typeof value === 'bigint') return value.toString();
                        if (typeof value === 'number') {
                            if (!Number.isFinite(value)) return null;
                            return BigInt(Math.floor(value)).toString();
                        }
                        const str = String(value).trim();
                        if (!str) return null;
                        return BigInt(str).toString();
                    } catch (_) {
                        return null;
                    }
                };
                const allowedWbstr = String(cfg.allowedLsp7 || '').toLowerCase();
                const normalizedToken = requestedToken.toLowerCase();
                let tokenAddress = normalizedToken;
                if (allowedWbstr && tokenAddress !== allowedWbstr) {
                    console.warn('[startAiGame] overriding requested token to allowed WBSTR token', { requestedToken, allowedWbstr });
                    tokenAddress = allowedWbstr;
                }
                if (!allowedWbstr && (!tokenAddress || tokenAddress === ethers.ZeroAddress.toLowerCase())) {
                    console.warn('[startAiGame] WBSTR token not configured; defaulting to ZeroAddress. Configure ALLOWED_LSP7_TOKEN or deployments file.');
                }
                const defaultLyxMultiplier = normalizeMultiplier(cfg.lyxMultiplier) || '10000000000000000';
                const defaultLsp7Multiplier = normalizeMultiplier(cfg.lsp7Multiplier) || '1000000000000000000000';
                let effectiveUnitMultiplier = normalizeMultiplier(unitMultiplierRaw);
                if (!effectiveUnitMultiplier) {
                    if (tokenAddress === ethers.ZeroAddress.toLowerCase()) {
                        effectiveUnitMultiplier = defaultLyxMultiplier;
                    } else if (allowedWbstr && tokenAddress === allowedWbstr) {
                        effectiveUnitMultiplier = defaultLsp7Multiplier;
                    } else {
                        effectiveUnitMultiplier = '1';
                    }
                }
                if (!effectiveUnitMultiplier) {
                    // Final fallback to avoid empty multiplier in the table doc
                    effectiveUnitMultiplier = '1';
                }

                // Compute sensible blinds from buyin: SB ~ 1% of buyin, BB = 2x SB, clamp to min/max
                const safeBuyin = Math.max(1, buyin);
                const sbComputed = Math.max(1, Math.floor(safeBuyin * 0.01));
                const bbComputed = Math.max(sbComputed * 2, Math.floor(safeBuyin * 0.02));

                // Create table doc
                const payload = {
                    name: `AI ${difficulty.toUpperCase()} ${safeBuyin}`,
                    host: hostName,
                    hostId: hostAddress,
                    maxPlayers: bots + 1,
                    sb: sbComputed,
                    bb: bbComputed,
                    stack: safeBuyin,
                    tokenAddress,
                    // keep unitMultiplier as string (frontend must send correct multiplier)
                    unitMultiplier: effectiveUnitMultiplier,
                    status: 'starting',
                    isPrivate: true,
                    mode: 'ai',
                    type: 'sng', // Mark as tournament type so blinds increase
                    aiDifficulty: difficulty,
                    buyin: safeBuyin,
                    players: 0,
                    tournament: defaultTournamentConfig(), // Add tournament config with 2-min blind levels
                    createdAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                    paymentWindowSec: Number(body.paymentWindowSec || 120),
                };
                const ref = await db.collection('tables').add(payload);
                // Add placeholder host player doc (waiting for on-chain confirmation)
                const playersCol = db.collection(`tables/${ref.id}/players`);
                const hostPlayerRef = await playersCol.add({ name: hostName, address: hostAddress, role: 'host', status: 'starting', stack: safeBuyin, createdAt: FieldValue.serverTimestamp() });
                // Add bots as seated players; bots get same stack but do not require on-chain deposit (platform underwrites)
                for (let i = 0; i < bots; i++) {
                    await playersCol.add({ name: `Bot ${i + 1}`, address: null, role: 'bot', status: 'seated', aiDifficulty: difficulty, stack: safeBuyin, createdAt: FieldValue.serverTimestamp() });
                }
                // update aggregate player count (host + bots)
                await ref.update({ players: bots + 1, playerCount: bots + 1, updatedAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
                return res.json({ tableId: ref.id, hostPlayerId: hostPlayerRef.id, unitMultiplier: effectiveUnitMultiplier, tokenAddress });
            } else if (step === 'confirm') {
                const tableId = String(body.tableId || '');
                const txHash = String(body.txHash || '');
                const hostAddress = String((body.hostAddress || '')).toLowerCase();
                const requiredChips = Number(body.buyin || 0);
                if (!tableId || !txHash || !hostAddress) return res.status(400).json({ error: 'tableId, txHash and hostAddress required' });

                // Dev/test mode: if body.test === true, skip on-chain verification and accept the deposit
                const isTest = body.test === true || String(body.test) === 'true';
                // Optional testOutcome for deterministic tests: 'win' or 'lose'
                const testOutcome = String(body.testOutcome || '').toLowerCase();
                const cfg = getCfg();
                let matchedAmount = 0n;
                let matchedChips = 0n;
                let matchedToken = null;
                let matchedTableId = null;
                let matchedRakeUnits = 0n;
                const rakeUnitsByKey = new Map();
                let txSentAmountUnits = 0n;
                let decodedTableIdFromInput = null;
                let decodedTokenFromInput = null;
                if (!isTest) {
                    // Verify transaction on-chain: look for PlayerBuyIn event matching host and amount
                    const rpcUrl = process.env.RPC_URL || cfg.rpcUrl || 'http://127.0.0.1:8545';
                    const usedFallbackRpc = !process.env.RPC_URL && !cfg.rpcUrl;
                    if (usedFallbackRpc) {
                        console.warn('[startAiGame] RPC_URL not configured; defaulting to http://127.0.0.1:8545');
                    }
                    if (usedFallbackRpc && rpcUrl.includes('127.0.0.1')) {
                        return res.status(500).json({
                            error: 'RPC endpoint not configured',
                            details: {
                                hint: 'Set the RPC_URL secret (firebase functions:secrets:set RPC_URL) or provide deployments/prod.json with rpcUrl so Cloud Functions can reach LUKSO RPC.',
                                currentValue: rpcUrl
                            }
                        });
                    }
                    console.log('confirm-step connecting to rpcUrl=', rpcUrl);
                    let provider;
                    try {
                        provider = new ethers.JsonRpcProvider(rpcUrl);
                    } catch (rpcErr) {
                        console.error('[startAiGame] RPC connection error', rpcErr && rpcErr.message ? rpcErr.message : rpcErr);
                        throw rpcErr;
                    }
                    let receipt;
                    let tx;
                    try {
                        receipt = await provider.getTransactionReceipt(txHash);
                        tx = await provider.getTransaction(txHash);
                    } catch (rpcErr) {
                        console.error('[startAiGame] RPC query error', rpcErr && rpcErr.message ? rpcErr.message : rpcErr);
                        throw rpcErr;
                    }
                    if (!receipt) return res.status(404).json({ error: 'Transaction receipt not found yet' });
                    if (receipt.status === 0) return res.status(400).json({ error: 'Transaction failed' });
                    if (!tx) return res.status(404).json({ error: 'Transaction not found on the blockchain.' });
                    const gameEntryAddress = normalizeAddress(cfg.gameEntry || '');
                    if (!gameEntryAddress) {
                        return res.status(500).json({
                            error: 'GameEntry address not configured',
                            details: {
                                hint: 'Set GAME_ENTRY secret or ensure deployments/prod.json provides "gameEntry".'
                            }
                        });
                    }
                    const unwrapInfo = await unwrapGameEntryInvocation({ provider, tx, gameEntryAddress });
                    if (!unwrapInfo || !unwrapInfo.parsedEntry || !unwrapInfo.parsedEntry.name) {
                        return res.status(400).json({ error: 'Could not parse transaction data. Not a valid buy-in.' });
                    }
                    const normalizedHost = normalizeAddress(hostAddress);
                    const { route: decodeRoute, profileAddress: decodedProfile, targetAddress: resolvedTarget, parsedEntry, forwardedValue } = unwrapInfo;
                    if (decodedProfile && normalizedHost && decodedProfile !== normalizedHost) {
                        return res.status(400).json({
                            error: 'Transaction host mismatch.',
                            details: {
                                expected: normalizedHost,
                                found: decodedProfile,
                                route: decodeRoute || 'unknown'
                            }
                        });
                    }
                    if (!resolvedTarget || resolvedTarget !== gameEntryAddress) {
                        return res.status(400).json({
                            error: 'Transaction sent to wrong contract.',
                            details: {
                                expected: gameEntryAddress,
                                actual: resolvedTarget || null,
                                route: decodeRoute || 'unknown'
                            }
                        });
                    }
                    const parsedTx = parsedEntry;
                    const functionName = parsedTx.name;
                    if (functionName === 'buyInLYX') {
                        decodedTableIdFromInput = toBigIntSafe(parsedTx.args?.tableId ?? parsedTx.args?.[0], null);
                        const lyxValue = forwardedValue > 0n ? forwardedValue : toBigIntSafe(tx.value, 0n);
                        txSentAmountUnits = lyxValue;
                        decodedTokenFromInput = normalizeAddress(ethers.ZeroAddress);
                    } else if (functionName === 'buyInLSP7') {
                        decodedTokenFromInput = normalizeAddress(parsedTx.args?.token ?? parsedTx.args?.[0] ?? ethers.ZeroAddress);
                        decodedTableIdFromInput = toBigIntSafe(parsedTx.args?.tableId ?? parsedTx.args?.[1], null);
                        txSentAmountUnits = toBigIntSafe(parsedTx.args?.amount ?? parsedTx.args?.[2], 0n);
                    } else {
                        return res.status(400).json({ error: 'Unsupported GameEntry function for buy-in.' });
                    }
                    if (txSentAmountUnits <= 0n) {
                        return res.status(400).json({ error: 'Insufficient amount sent in transaction.' });
                    }
                    if (decodedTableIdFromInput !== null) {
                        try {
                            matchedTableId = decodedTableIdFromInput;
                        } catch (_) { /* ignore */ }
                    }
                    if (!matchedToken && decodedTokenFromInput) {
                        matchedToken = decodedTokenFromInput;
                    }

                    const gameVaultAddress = cfg?.gameVault;
                    if (!gameVaultAddress) {
                        return res.status(500).json({
                            error: 'GameVault address not configured',
                            details: {
                                hint: 'Set GAME_VAULT secret or ensure deployments/prod.json provides "gameVault".'
                            }
                        });
                    }
                    const vaultAbi = loadVaultAbi();
                    if (!vaultAbi || !vaultAbi.length) {
                        return res.status(500).json({
                            error: 'GameVault ABI/artifact not available',
                            details: {
                                hint: 'Bundle GameVaultV6.sol/GameVaultV6.json inside functions/artifacts or run Hardhat build to generate artifacts before deploying functions.'
                            }
                        });
                    }
                    const iface = new ethers.Interface(vaultAbi);
                    let matched = false;
                    for (const log of receipt.logs || []) {
                        try {
                            const parsed = iface.parseLog(log);
                            if (!parsed) continue;
                            const name = String(parsed.name || '').toLowerCase();
                            // Accept legacy PlayerBuyIn
                            if (name === 'playerbuyin') {
                                const player = String(parsed.args[0] || parsed.args.player || '').toLowerCase();
                                const amount = BigInt(parsed.args[2] || parsed.args.amount || 0);
                                if (player === hostAddress) {
                                    if (!matched) matched = true;
                                    if (matchedAmount === 0n) matchedAmount = amount;
                                    if (matchedChips === 0n) matchedChips = 0n;
                                    if (!matchedToken) matchedToken = ethers.ZeroAddress.toLowerCase();
                                    try {
                                        const tableIdRaw = parsed.args[1] ?? parsed.args.tableId;
                                        const tableIdBig = toBigIntSafe(tableIdRaw, null);
                                        if (tableIdBig !== null) matchedTableId = tableIdBig;
                                    } catch (_) { /* ignore table id */ }
                                }
                            }
                            // Newer GameVaultV3 events: Deposited(player, token, tableId, amount)
                            if (name === 'deposited') {
                                const player = String(parsed.args[0] || parsed.args.player || '').toLowerCase();
                                const amount = BigInt(parsed.args[3] || parsed.args.amount || 0);
                                if (player === hostAddress) {
                                    if (!matched) matched = true;
                                    matchedAmount = amount > 0n ? amount : matchedAmount;
                                    if (matchedChips === 0n) matchedChips = 0n;
                                    try {
                                        const tok = String(parsed.args[1] || parsed.args.token || ethers.ZeroAddress).toLowerCase();
                                        if (tok) matchedToken = tok;
                                    } catch (_) { /* ignore token */ }
                                    try {
                                        const tableIdRaw = parsed.args[2] ?? parsed.args.tableId;
                                        const tableIdBig = toBigIntSafe(tableIdRaw, null);
                                        if (tableIdBig !== null) matchedTableId = tableIdBig;
                                    } catch (_) { /* ignore table id */ }
                                }
                            }
                            // DepositedInChips(player, token, tableId, chips, amount)
                            if (name === 'depositedinchips') {
                                const player = String(parsed.args[0] || parsed.args.player || '').toLowerCase();
                                const chips = BigInt(parsed.args[3] || parsed.args.chips || 0);
                                const amount = BigInt(parsed.args[4] || parsed.args.amount || 0);
                                if (player === hostAddress) {
                                    if (!matched) matched = true;
                                    const effectiveAmount = amount > 0n ? amount : chips;
                                    if (effectiveAmount > 0n) matchedAmount = effectiveAmount;
                                    if (chips > 0n) matchedChips = chips;
                                    try {
                                        const tok = String(parsed.args[1] || parsed.args.token || ethers.ZeroAddress).toLowerCase();
                                        if (tok) matchedToken = tok;
                                    } catch (_) { matchedToken = matchedToken || null; }
                                    try {
                                        const tableIdRaw = parsed.args[2] ?? parsed.args.tableId;
                                        const tableIdBig = toBigIntSafe(tableIdRaw, null);
                                        if (tableIdBig !== null) matchedTableId = tableIdBig;
                                    } catch (_) { /* ignore table id */ }
                                }
                            }
                            if (name === 'raketaken') {
                                try {
                                    const tableIdRaw = parsed.args[0] ?? parsed.args.tableId;
                                    const token = String(parsed.args[1] || parsed.args.token || ethers.ZeroAddress).toLowerCase();
                                    const amount = BigInt(parsed.args[2] || parsed.args.amount || 0);
                                    const tableIdBig = toBigIntSafe(tableIdRaw, null);
                                    const key = `${tableIdBig !== null ? tableIdBig.toString() : 'unknown'}::${token}`;
                                    const prev = rakeUnitsByKey.get(key) || 0n;
                                    rakeUnitsByKey.set(key, prev + amount);
                                } catch (_) { /* ignore */ }
                            }
                        } catch (e) { /* not parsable by this iface */ }
                    }
                    if (!matched) {
                        console.warn('[startAiGame] No deposit event (Deposited or DepositedInChips) found; falling back to transaction input amount', { txHash });
                        if (matchedAmount === 0n) {
                            matchedAmount = txSentAmountUnits;
                        }
                    }
                    if (!matchedToken && decodedTokenFromInput) {
                        matchedToken = decodedTokenFromInput;
                    }
                    if (matchedTableId === null && decodedTableIdFromInput !== null) {
                        matchedTableId = decodedTableIdFromInput;
                    }
                } else {
                    // Test mode: accept and set a nominal matchedAmount based on buyin
                    matchedChips = toBigIntSafe(requiredChips || Number(body.buyin || 0), 0n);
                    matchedAmount = matchedChips;
                    matchedToken = String(body.tokenAddress || '').toLowerCase() || null;
                    console.info('[startAiGame] confirm running in test mode; skipping on-chain verification');
                }

                // Load table to determine unitMultiplier and buyin
                const tableRef = db.doc(`tables/${tableId}`);
                const tableSnap = await tableRef.get();
                if (!tableSnap.exists) return res.status(404).json({ error: 'Table not found' });
                const t = tableSnap.data() || {};
                const expectedOnchainTableId = deriveOnchainTableId(tableId);
                if (matchedTableId === null && expectedOnchainTableId !== null) {
                    matchedTableId = expectedOnchainTableId;
                }
                if (matchedTableId !== null && expectedOnchainTableId !== null && matchedTableId !== expectedOnchainTableId) {
                    return res.status(400).json({
                        error: 'Deposit table mismatch',
                        details: {
                            expected: expectedOnchainTableId.toString(),
                            found: matchedTableId.toString()
                        }
                    });
                }
                // If running in test mode and a deterministic outcome was requested, persist it on the table
                if (isTest && (testOutcome === 'win' || testOutcome === 'lose')) {
                    try {
                        await tableRef.update({ testOutcome });
                    } catch (e) {
                        console.warn('Could not persist testOutcome on table:', e && e.message);
                    }
                }
                const tableToken = String(t.tokenAddress || ethers.ZeroAddress).toLowerCase();
                const normalizedTableToken = tableToken || ethers.ZeroAddress.toLowerCase();
                const wbstrAllowed = String(cfg.allowedLsp7 || '').toLowerCase();
                let unitMultiplier = toBigIntSafe(t.unitMultiplier, 1n);
                if (unitMultiplier <= 0n) unitMultiplier = 1n;
                const defaultLyxMultiplier = toBigIntSafe(cfg.lyxMultiplier, 10000000000000000n);
                const defaultLsp7Multiplier = toBigIntSafe(cfg.lsp7Multiplier, 1000000000000000000000n);
                if (unitMultiplier <= 1n) {
                    if (tableToken === ethers.ZeroAddress.toLowerCase() && defaultLyxMultiplier > 1n) {
                        unitMultiplier = defaultLyxMultiplier;
                    } else if (wbstrAllowed && tableToken === wbstrAllowed && defaultLsp7Multiplier > 1n) {
                        unitMultiplier = defaultLsp7Multiplier;
                    }
                }
                if (!isTest && decodedTokenFromInput) {
                    if (decodedTokenFromInput !== normalizedTableToken) {
                        return res.status(400).json({
                            error: 'Transaction token mismatch',
                            details: {
                                expectedToken: normalizedTableToken,
                                sentToken: decodedTokenFromInput
                            }
                        });
                    }
                }
                if (!matchedToken && normalizedTableToken) {
                    matchedToken = normalizedTableToken;
                }
                if (matchedTableId !== null) {
                    const tokenKey = `${matchedTableId.toString()}::${matchedToken || (tableToken || ethers.ZeroAddress.toLowerCase())}`;
                    matchedRakeUnits = rakeUnitsByKey.get(tokenKey) || 0n;
                    if (matchedRakeUnits === 0n && (matchedToken || tableToken)) {
                        const fallbackToken = (matchedToken && matchedToken !== tableToken) ? tableToken : ethers.ZeroAddress.toLowerCase();
                        const fallbackKey = `${matchedTableId.toString()}::${fallbackToken}`;
                        matchedRakeUnits = rakeUnitsByKey.get(fallbackKey) || 0n;
                    }
                }
                if (matchedRakeUnits === 0n && rakeUnitsByKey.size === 1) {
                    try {
                        const onlyValue = rakeUnitsByKey.values().next();
                        if (!onlyValue.done) matchedRakeUnits = onlyValue.value;
                    } catch (_) { /* noop */ }
                }
                let buyinChips = toBigIntSafe(typeof t.buyin === 'number' ? Math.trunc(t.buyin) : t.buyin, 0n);
                if (buyinChips === 0n) {
                    buyinChips = toBigIntSafe(requiredChips, 0n) || toBigIntSafe(body.buyin, 0n);
                }
                if (matchedChips === 0n && unitMultiplier > 0n && matchedAmount > 0n) {
                    matchedChips = matchedAmount / unitMultiplier;
                }
                if (matchedAmount === 0n && matchedChips > 0n && unitMultiplier > 0n) {
                    matchedAmount = matchedChips * unitMultiplier;
                }
                if (unitMultiplier > 1n && matchedChips > 0n && matchedAmount === matchedChips) {
                    matchedAmount = matchedChips * unitMultiplier;
                }
                const expectedUnits = unitMultiplier > 0n ? buyinChips * unitMultiplier : buyinChips;
                const matchedUnitsWithRake = matchedAmount + matchedRakeUnits;
                const matchedChipsWithRake = unitMultiplier > 0n ? matchedUnitsWithRake / unitMultiplier : matchedChips;
                const hasEnoughUnits = expectedUnits <= 0n || matchedUnitsWithRake >= expectedUnits;
                const hasEnoughChips = buyinChips <= 0n || matchedChipsWithRake >= buyinChips;
                if (!hasEnoughUnits && !hasEnoughChips) {
                    const ratioHint = unitMultiplier > 0n ? `1 chip = ${unitMultiplier.toString()} smallest units` : null;
                    const details = {
                        expectedChips: buyinChips.toString(),
                        matchedChips: matchedChips.toString(),
                        matchedChipsWithRake: matchedChipsWithRake.toString(),
                        expectedUnits: expectedUnits.toString(),
                        matchedUnits: matchedAmount.toString(),
                        matchedUnitsWithRake: matchedUnitsWithRake.toString(),
                        rakeUnits: matchedRakeUnits.toString(),
                        ratio: ratioHint,
                    };
                    if (wbstrAllowed && tableToken === wbstrAllowed) {
                        details.reminder = 'WBSTR conversion: 1 chip = 1000 WBSTR (0.001 chip per WBSTR).';
                        if (matchedRakeUnits > 0n) {
                            details.rakeNote = 'On-chain rake is subtracted before emitting Deposited events; deposit plus rake still meets the buy-in.';
                        }
                    }
                    return res.status(400).json({
                        error: 'Insufficient on-chain deposit',
                        details,
                    });
                }
                if (matchedToken && tableToken && matchedToken !== tableToken) {
                    console.warn('[startAiGame] Deposit token mismatch', { matchedToken, tableToken, tableId });
                }

                if (!isTest) {
                    const txDocId = txHash.toLowerCase();
                    const processedRef = db.collection('processedTransactions').doc(txDocId);
                    try {
                        await db.runTransaction(async (firestoreTx) => {
                            const existing = await firestoreTx.get(processedRef);
                            if (existing.exists) {
                                throw new Error('TRANSACTION_ALREADY_PROCESSED');
                            }
                            firestoreTx.set(processedRef, {
                                txHash,
                                tableId,
                                hostAddress,
                                chainTableId: matchedTableId !== null ? matchedTableId.toString() : null,
                                amountUnits: txSentAmountUnits > 0n ? txSentAmountUnits.toString() : null,
                                amountChips: matchedChips > 0n ? matchedChips.toString() : null,
                                token: matchedToken || decodedTokenFromInput || normalizedTableToken || null,
                                processedAt: FieldValue.serverTimestamp(),
                                step: 'startAiGame.confirm'
                            });
                        });
                    } catch (txRecordErr) {
                        const errMsg = String(txRecordErr && txRecordErr.message ? txRecordErr.message : txRecordErr || '').toUpperCase();
                        if (errMsg.includes('TRANSACTION_ALREADY_PROCESSED')) {
                            return res.status(409).json({ error: 'Transaction has already been processed.' });
                        }
                        console.error('[startAiGame] processedTransactions guard failed', txRecordErr && txRecordErr.message ? txRecordErr.message : txRecordErr);
                        return res.status(500).json({ error: 'Could not record processed transaction.' });
                    }
                }

                // Mark host player as 'paid' and activate table
                const playersCol = db.collection(`tables/${tableId}/players`);
                const playersSnap = await playersCol.where('address', '==', hostAddress).limit(1).get();
                if (playersSnap.empty) {
                    // create host player if missing
                    await playersCol.add({ name: body.hostName || 'Player', address: hostAddress, role: 'host', status: 'paid', stack: Number(t.stack || t.buyin || 0), createdAt: FieldValue.serverTimestamp() });
                } else {
                    const pdoc = playersSnap.docs[0];
                    await pdoc.ref.set({ status: 'paid', address: hostAddress, stack: Number(t.stack || t.buyin || 0) }, { merge: true });
                }

                // Activate table
                await tableRef.update({ status: 'active', startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
                console.log('[startAiGame.confirm] Table activated', {
                    tableId,
                    hostAddress,
                    matchedChips: matchedChips.toString(),
                    matchedUnits: matchedAmount.toString(),
                    unitMultiplier: unitMultiplier.toString()
                });

                // Ensure the first hand starts promptly even if the status trigger lags
                try {
                    const gameRef = db.doc(`tables/${tableId}/game/state`);
                    const gameSnap = await gameRef.get();
                    if (!gameSnap.exists) {
                        console.log('[startAiGame] no game state after activation, initializing immediately');
                        await initializeNewHand(tableId);
                    }
                } catch (initErr) {
                    console.warn('[startAiGame] immediate hand initialization failed', initErr && initErr.message ? initErr.message : initErr);
                }

                return res.json({ ok: true, tableId });
            } else if (step === 'cleanup') {
                const tableId = String(body.tableId || '');
                if (!tableId) return res.status(400).json({ error: 'tableId required for cleanup' });
                try {
                    await cascadeDeleteWaitingTable(tableId);
                    return res.json({ ok: true, cleaned: true });
                } catch (e) {
                    console.error('startAiGame cleanup error', e);
                    return res.status(500).json({ error: 'cleanup failed' });
                }
            } else {
                return res.status(400).json({ error: 'Unknown step' });
            }
        } catch (e) {
            console.error('startAiGame error', e);
            try { return res.status(500).json({ error: String(e && e.message ? e.message : e) }); } catch (_) { return res.status(500).send('ERROR'); }
        }
    });
} catch (e) {
    console.warn('Could not register startAiGame http endpoint:', e && e.message);
}

// Debug endpoint: trigger showdownAndPayout for a table (emulator only)
try {
    const ffv1 = require('firebase-functions');
    if (ffv1 && ffv1.https && ffv1.https.onRequest) {
        const REQUIRED_SECRETS = [
            DEBUG_TOKEN_SEC,
            ALLOW_DEBUG_SEC,
            RPC_URL,
            PRIVATE_KEY,
            PRIZE_DISTRIBUTOR,
            PRIZE_POOL_PK,
            FUND_SENDER_PK,
            ALLOWED_LSP7_TOKEN,
            LYX_UNIT_MULTIPLIER,
            LSP7_UNIT_MULTIPLIER,
            GAME_VAULT,
            GAME_ENTRY,
            GAME_SERVER,
            HOUSE_WALLET_SEC
        ].filter(Boolean);

        exports.debugTriggerShowdown = ffv1.https.onRequest({ secrets: REQUIRED_SECRETS }, async (req, res) => {
            try {
                // Allow only in emulator OR when explicitly enabled via ALLOW_DEBUG + a secret token header
                const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
                const allowDebugSource = ALLOW_DEBUG_SEC && typeof ALLOW_DEBUG_SEC.value === 'function' ? ALLOW_DEBUG_SEC.value() : null;
                const allowDebugFlag = String(allowDebugSource || process.env.ALLOW_DEBUG || '').toLowerCase() === 'true';
                const headerToken = (req.headers && (req.headers['x-debug-token'] || req.headers['x-debug-token'.toLowerCase()])) || null;
                const debugTokenSource = DEBUG_TOKEN_SEC && typeof DEBUG_TOKEN_SEC.value === 'function' ? DEBUG_TOKEN_SEC.value() : null;
                const configuredToken = debugTokenSource || process.env.DEBUG_TOKEN || null;
                console.log('[debugTriggerShowdown] gate check', {
                    isEmulator,
                    allowDebugFlag,
                    headerToken,
                    configuredToken
                });
                const allowedByToken = allowDebugFlag && configuredToken && headerToken && String(headerToken) === String(configuredToken);
                if (!isEmulator && !allowedByToken) {
                    return res.status(403).send('debugTriggerShowdown is allowed only in emulator or with ALLOW_DEBUG+DEBUG_TOKEN');
                }
                if (req.method !== 'POST') return res.status(405).send('POST only');
                const body = req.body || {};
                const tableId = String(body.tableId || '');
                if (!tableId) return res.status(400).json({ error: 'tableId required' });
                const gameRef = db.doc(`tables/${tableId}/game/state`);
                const snap = await gameRef.get();
                if (!snap.exists) return res.status(404).json({ error: 'game state not found' });
                let game = snap.data();
                // Optional test hooks: allow forcing a specific winner to validate on-chain payout
                const winnerAddress = body.winnerAddress ? String(body.winnerAddress).toLowerCase() : null;
                const forceHostWin = body.forceHostWin === true || String(body.forceHostWin) === 'true';
                if (winnerAddress || forceHostWin) {
                    try {
                        // Find the player id whose address matches winnerAddress, or use table.hostId for forceHostWin
                        const tableSnap = await db.doc(`tables/${tableId}`).get();
                        const tableData = tableSnap.exists ? tableSnap.data() : {};
                        let targetPid = null;
                        if (winnerAddress) {
                            for (const [pid, p] of Object.entries(game.players || {})) {
                                try { if (p && p.address && String(p.address).toLowerCase() === winnerAddress) { targetPid = pid; break; } } catch(_){}
                            }
                        }
                        if (!targetPid && forceHostWin && tableData && tableData.hostId) {
                            // find pid for hostId
                            for (const [pid, p] of Object.entries(game.players || {})) {
                                try { if (p && p.address && String(p.address).toLowerCase() === String(tableData.hostId).toLowerCase()) { targetPid = pid; break; } } catch(_){}
                            }
                        }
                        if (targetPid) {
                            // mark all other players as folded so targetPid wins
                            for (const pid of Object.keys(game.players || {})) {
                                if (pid === targetPid) { game.players[pid].inHand = true; game.players[pid].folded = false; }
                                else { game.players[pid].inHand = false; game.players[pid].folded = true; }
                            }
                            await gameRef.set(game, { merge: true });
                            console.log(`debugTriggerShowdown: forced winner pid=${targetPid} for table ${tableId}`);
                        } else {
                            console.warn('debugTriggerShowdown: could not find targetPid to force win');
                        }
                    } catch (e) {
                        console.warn('debugTriggerShowdown force-win helper failed', e && e.message);
                    }
                }
                // Call the existing showdownAndPayout helper
                await showdownAndPayout(tableId, game, gameRef);
                return res.json({ ok: true, tableId });
            } catch (e) {
                console.error('debugTriggerShowdown error', e && e.message);
                return res.status(500).json({ error: String(e && e.message ? e.message : e) });
            }
        });
    }
} catch (e) {
    console.warn('Could not register debugTriggerShowdown endpoint:', e && e.message);
}
