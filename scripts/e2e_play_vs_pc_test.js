// scripts/e2e_play_vs_pc_test.js (ESM)
import fs from 'fs';
// prefer global fetch (Node 18+), fall back to node-fetch if missing
let fetchFn = globalThis.fetch;
if (!fetchFn) {
	const mod = await import('node-fetch');
	fetchFn = mod.default;
}

const hardhatPkg = await import('hardhat');
const hre = hardhatPkg && hardhatPkg.default ? hardhatPkg.default : hardhatPkg;
const { ethers } = hre;

// Minimal PrizeDistributor ABI for authorizePayout
const PRIZE_DISTRIBUTOR_ABI = [
	'function authorizePayout(address winner, address tokenAddress, uint256 amount) external'
];

async function main() {
	const deployInfo = JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
	// Prefer RPC_URL from environment (docker-compose sets this to http://hardhat:8545),
	// then fall back to the deployments file, then localhost for non-Docker runs.
	const rpc = process.env.RPC_URL || deployInfo.rpcUrl || 'http://127.0.0.1:8545';
	const provider = new hre.ethers.JsonRpcProvider(rpc);

	// Always bind signers to the external JSON-RPC provider (do not use in-process Hardhat signers here)
	const player1Addr = deployInfo.player1;
	const DEPLOYER_PK = process.env.DEPLOYER_PK || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
	const deployer = new hre.ethers.Wallet(DEPLOYER_PK, provider);

	console.log('Using provider', rpc);
	console.log('Player1 address', player1Addr);

	// Base emulator endpoints (override via env FNS_URL / FS_URL)
	const FNS_BASE = process.env.FNS_URL || 'http://127.0.0.1:5001/poker-4683e/us-central1';
	const FS_BASE = process.env.FS_URL || 'http://127.0.0.1:8080/v1/projects/poker-4683e/databases/(default)/documents';

	// 1) create Play-vs-PC table (use medium difficulty) via functions emulator
	const createResp = await fetchFn(`${FNS_BASE}/startAiGame`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ step: 'create', difficulty: 'medium', buyin: 10, tokenAddress: deployInfo.wbstrToken || ethers.ZeroAddress, unitMultiplier: '1', hostAddress: player1Addr, hostName: 'E2E Tester' })
	});
	const created = await createResp.json();
	console.log('createResp', created);
	if (!created.tableId) throw new Error('create failed');

	// 2) confirm (test mode) to skip on-chain deposit
	const confirmResp = await fetchFn(`${FNS_BASE}/startAiGame`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ step: 'confirm', tableId: created.tableId, txHash: '0x0', hostAddress: player1Addr, buyin: 10, test: true })
	});
	const confirmed = await confirmResp.json();
	console.log('confirmResp', confirmed);
	if (!confirmed.ok) throw new Error('confirm failed');

	// Read table doc from Firestore emulator
	const fsUrl = `${FS_BASE}/tables/${created.tableId}`;
	const tableDocResp = await fetchFn(fsUrl);
	const tableDoc = await tableDocResp.json();
	console.log('tableDoc', tableDoc.name || tableDoc);

	// Helper: write simulated showdown using Admin SDK
	async function writeSimulatedShowdownAdmin(tableId, simObj) {
		try {
			process.env.FIRESTORE_EMULATOR_HOST = 'firebase:8080';
			const mod = await import('firebase-admin');
			const admin = mod.default || mod;
			if (!admin.apps || admin.apps.length === 0) admin.initializeApp({ projectId: 'poker-4683e' });
			const db = admin.firestore ? admin.firestore() : admin.getFirestore();
			await db.doc(`tables/${tableId}/game/state`).set({ phase: 'showdown', players: simObj });
			console.log('Simulated showdown written via Admin SDK');
			return true;
		} catch (e) {
			console.warn('Admin SDK simulated showdown write failed', e && e.message);
			return false;
		}
	}

	// Determine host player doc to read initial stack
	const playersUrl = `${FS_BASE}/tables/${created.tableId}/players`;
	const playersList = await (await fetchFn(playersUrl)).json();
	let hostPlayerDoc = null;
	if (playersList && playersList.documents) {
		for (const d of playersList.documents) {
			const fields = d.fields || {};
			const addr = (fields.address && fields.address.stringValue) ? fields.address.stringValue.toLowerCase() : null;
			const role = (fields.role && fields.role.stringValue) ? fields.role.stringValue : null;
			if (addr === (player1Addr || '').toLowerCase() || role === 'host') { hostPlayerDoc = { name: d.name, fields }; break; }
		}
	}
	if (!hostPlayerDoc) throw new Error('Host player document not found');
	const initialStack = Number(hostPlayerDoc.fields.stack && (hostPlayerDoc.fields.stack.integerValue || hostPlayerDoc.fields.stack.stringValue) || 0);
	console.log('Host initial stack (chips):', initialStack);

	// Immediately simulate showdown for determinism
	const hostPid = hostPlayerDoc && hostPlayerDoc.name ? hostPlayerDoc.name.split('/').pop() : 'host0';
	const hostFinalStack = initialStack + Math.max(1, Math.floor(initialStack * 0.5));
	const adminOk = await writeSimulatedShowdownAdmin(created.tableId, { [hostPid]: { address: player1Addr, stack: hostFinalStack } });
	if (!adminOk) console.warn('Admin simulated showdown failed, continuing and hoping game reaches showdown naturally');

	// Compute expected on-chain payout based on table fields
	const tableFields = tableDoc.fields || {};
	const difficulty = (tableFields.aiDifficulty && tableFields.aiDifficulty.stringValue) ? tableFields.aiDifficulty.stringValue.toLowerCase() : 'medium';
	const buyinChips = Number(tableFields.buyin && (tableFields.buyin.integerValue || tableFields.buyin.stringValue) || 10);
	const mult = difficulty === 'hard' ? 2.0 : difficulty === 'medium' ? 1.5 : 1.2;
	const payoutChips = Math.floor(buyinChips * mult);

	// For LYX payouts, prefer the vault's smallestUnitsPerChip over any table-provided unitMultiplier
	const gameVaultAddr = process.env.GAME_VAULT || deployInfo.gameVault;
	if (!gameVaultAddr) throw new Error('GAME_VAULT not configured');
	const vaultAbiPath = 'artifacts/contracts/GameVaultV3.sol/GameVaultV3.json';
	let vaultAbi;
	try { vaultAbi = JSON.parse(fs.readFileSync(vaultAbiPath, 'utf8')).abi; } catch (e) { throw new Error('Could not load GameVault ABI: ' + e.message); }
	const vaultForRead = new hre.ethers.Contract(gameVaultAddr, vaultAbi, provider);
	const unitsPerChip = await vaultForRead.smallestUnitsPerChip(ethers.ZeroAddress);
	const unitMultiplier = BigInt(unitsPerChip.toString());
	const onchainAmount = BigInt(payoutChips) * unitMultiplier;
	console.log('Computed payout (units):', onchainAmount.toString(), 'chips:', payoutChips, 'unitsPerChip:', unitMultiplier.toString());

	// Authorize payout on PrizeDistributor on-chain using deployer
	const prizeDistributorAddr = process.env.PRIZE_DISTRIBUTOR || deployInfo.prizeDistributor;
	if (!prizeDistributorAddr) throw new Error('PRIZE_DISTRIBUTOR address not provided');
	// PrizeDistributor requires onlyGameServer; sign with game server key
	const GAME_SERVER_PK = process.env.GAME_SERVER_PK || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
	const gameServer = new hre.ethers.Wallet(GAME_SERVER_PK, provider);
	const prizeContract = new hre.ethers.Contract(prizeDistributorAddr, PRIZE_DISTRIBUTOR_ABI, gameServer);
	console.log('Authorizing payout on PrizeDistributor...');
	const authTx = await prizeContract.authorizePayout(player1Addr, (tableFields.tokenAddress && tableFields.tokenAddress.stringValue) ? tableFields.tokenAddress.stringValue : ethers.ZeroAddress, onchainAmount);
	const authRc = await authTx.wait();
	console.log('authorizePayout rc', authRc && authRc.status);
	if (!authRc || authRc.status !== 1) throw new Error('authorizePayout failed');

	// Now execute atomic payout via GameVault using FUND_SENDER_PK (house pays gas)
	// Use deployer as trusted depositor (configured during deploy)
	const vault = new hre.ethers.Contract(gameVaultAddr, vaultAbi, deployer);

	// Convert Firestore string tableId to a deterministic uint256 using keccak256
	const tableIdNum = BigInt(hre.ethers.keccak256(hre.ethers.toUtf8Bytes(created.tableId)));

	// Snapshot player balance
	const beforeBal = BigInt(await provider.send('eth_getBalance', [player1Addr, 'latest']));
	console.log('Player balance before atomic payout:', beforeBal.toString());

	// Deterministic path: for LYX, fund and pay in one call so player's balance increases by onchainAmount
	const tx2 = await vault.depositLyxForAndWithdrawFor(tableIdNum, player1Addr, { value: onchainAmount });
	const rc2 = await tx2.wait();
	console.log('depositLyxForAndWithdrawFor rc', rc2 && rc2.status);
	if (!rc2 || rc2.status !== 1) throw new Error('depositLyxForAndWithdrawFor failed');

	const afterBal = BigInt(await provider.send('eth_getBalance', [player1Addr, 'latest']));
	console.log('Player balance after atomic payout:', afterBal.toString());
	const delta = afterBal - beforeBal;
	console.log('Observed delta (wei):', delta.toString());
	if (delta !== onchainAmount) throw new Error(`Payout amount mismatch: expected ${onchainAmount} got ${delta}`);

	console.log('E2E play-vs-PC test (with PrizeDistributor + GameVault atomic payout) completed OK');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });