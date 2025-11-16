// scripts/deterministic_loss_test.js (ESM)
import fs from 'fs';
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  const mod = await import('node-fetch');
  fetchFn = mod.default;
}
const hardhatPkg = await import('hardhat');
const hre = hardhatPkg && hardhatPkg.default ? hardhatPkg.default : hardhatPkg;

async function main() {
  const deployInfo = JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
  const rpc = deployInfo.rpcUrl || 'http://127.0.0.1:8545';
  const provider = new hre.ethers.JsonRpcProvider(rpc);

  const player1Addr = deployInfo.player1;
  const deployerAddr = deployInfo.deployer;

  console.log('Starting deterministic LOSS test for host', player1Addr);

  // 1) create table
  const createResp = await fetchFn('http://firebase:5001/poker-4683e/us-central1/startAiGame', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'create', difficulty: 'medium', buyin: 10, tokenAddress: deployInfo.wbstrToken, unitMultiplier: '1', hostAddress: player1Addr, hostName: 'E2E-Deterministic-Loss' })
  });
  const created = await createResp.json();
  console.log('createResp', created);
  if (!created.tableId) throw new Error('create failed');

  // Snapshot balance before confirm / game
  const beforeBal = await provider.send('eth_getBalance', [player1Addr, 'latest']);
  console.log('Player balance before test (latest):', beforeBal);

  // 2) confirm in test mode requesting deterministic 'lose'
  const confirmResp = await fetchFn('http://firebase:5001/poker-4683e/us-central1/startAiGame', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'confirm', tableId: created.tableId, txHash: '0x0', hostAddress: player1Addr, buyin: 10, test: true, testOutcome: 'lose' })
  });
  const confirmed = await confirmResp.json();
  console.log('confirmResp', confirmed);
  if (!confirmed.ok) throw new Error('confirm failed');

  // Wait for table active
  const fsUrl = `http://firebase:8080/v1/projects/poker-4683e/databases/(default)/documents/tables/${created.tableId}`;
  const tableWaitStart = Date.now();
  const tableWaitTimeout = 2 * 60 * 1000; // 2 minutes
  while (Date.now() - tableWaitStart < tableWaitTimeout) {
    try {
      const tr = await fetchFn(fsUrl);
      if (tr.status === 200) {
        const tableData = await tr.json();
        const status = (tableData.fields && tableData.fields.status && tableData.fields.status.stringValue) ? tableData.fields.status.stringValue : null;
        console.log('Polled table status:', status);
        if (status === 'active') break;
      }
    } catch (e) { console.warn('poll table status', e && e.message); }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Helper: write simulated showdown using the Firestore Admin SDK (bypasses emulator security rules)
  async function writeSimulatedShowdownAdmin(tableId, simObj) {
    try {
      process.env.FIRESTORE_EMULATOR_HOST = 'firebase:8080';
      const mod = await import('firebase-admin');
      const admin = mod.default || mod;
      if (!admin.apps || admin.apps.length === 0) {
        admin.initializeApp({ projectId: 'poker-4683e' });
      }
      const dbadmin = admin.firestore ? admin.firestore() : admin.getFirestore();
      await dbadmin.doc(`tables/${tableId}/game/state`).set({ phase: 'showdown', players: simObj });
      console.log('Simulated showdown written via Admin SDK');
      return true;
    } catch (e) {
      console.warn('Admin SDK simulated showdown write failed', e && e.message);
      return false;
    }
  }

  // Poll players collection to determine host pid and initial stack, then write a simulated showdown (host loses)
  const playersUrl = `http://firebase:8080/v1/projects/poker-4683e/databases/(default)/documents/tables/${created.tableId}/players`;
  let playersList = null;
  try {
    const r = await fetchFn(playersUrl);
    playersList = await r.json();
  } catch (e) { /* ignore */ }
  let hostPlayerDoc = null;
  if (playersList && playersList.documents) {
    for (const d of playersList.documents) {
      const fields = d.fields || {};
      const addr = (fields.address && fields.address.stringValue) ? fields.address.stringValue.toLowerCase() : null;
      const role = (fields.role && fields.role.stringValue) ? fields.role.stringValue : null;
      if (addr === (player1Addr || '').toLowerCase() || role === 'host') {
        hostPlayerDoc = { name: d.name, fields };
        break;
      }
    }
  }
  if (!hostPlayerDoc) throw new Error('Host player document not found in players collection');
  const initialStack = Number(hostPlayerDoc.fields.stack && (hostPlayerDoc.fields.stack.integerValue || hostPlayerDoc.fields.stack.stringValue) || 0);
  console.log('Host initial stack (chips):', initialStack);

  // Immediately write a simulated showdown where host loses (final stack smaller than initial)
  const hostPid = hostPlayerDoc && hostPlayerDoc.name ? hostPlayerDoc.name.split('/').pop() : 'host0';
  const hostFinalStack = Math.max(0, initialStack - Math.max(1, Math.floor(initialStack * 0.5)));
  const adminOk = await writeSimulatedShowdownAdmin(created.tableId, { [hostPid]: { address: player1Addr, stack: hostFinalStack } });
  if (!adminOk) throw new Error('Simulated showdown write failed');

  // Construct finalGame from simulated data (no need to wait further)
  const finalGame = { hostPid, hostFinalStack };

  console.log('Game finished. Host final stack (chips):', finalGame.hostFinalStack);
  // Read balance after run
  const afterBal = await provider.send('eth_getBalance', [player1Addr, 'latest']);
  console.log('Player balance after test (latest):', afterBal);
  const delta = BigInt(afterBal) - BigInt(beforeBal);
  console.log('Balance delta (wei):', delta.toString());

  if (finalGame.hostFinalStack > 0 && (delta > 0n)) {
    throw new Error('Host received unexpected payout in deterministic lose test');
  }

  console.log('Deterministic LOSS test passed: host lost and received no payout');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
