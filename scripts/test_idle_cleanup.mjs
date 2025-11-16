// Test: simulate an idle table and verify cleanupIdleTables removes it
// Note: scheduled functions may not auto-run in emulator; this test will call the function directly via HTTP emulation if available, otherwise it will check for deletion after invoking a manual trigger document.
// Run with: node ./scripts/test_idle_cleanup.mjs

import admin from 'firebase-admin';
import fetch from 'node-fetch';

async function main(){
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const projectId = 'poker-4683e';
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  console.log('Creating table with old createdAt to simulate idle...');
  const oldDate = new Date(Date.now() - (1000 * 60 * 60 * 24 * 8)); // 8 days ago
  const tableRef = await db.collection('tables').add({
    host: 'IdleHost',
    hostId: 'idle-host-1',
    maxPlayers: 2,
    sb: 10,
    bb: 20,
    stack: 1500,
    tokenAddress: '0x0000000000000000000000000000000000000000',
  unitMultiplier: '10000000000000000',
    buyin: 100,
    createdAt: admin.firestore.Timestamp.fromDate(oldDate),
    status: 'waiting',
    players: 0,
    minPlayers: 2,
  });
  const tableId = tableRef.id;
  console.log('Table created:', tableId);

  console.log('Attempting to trigger scheduled cleanup (if emulator exposes an HTTP function endpoint)...');
    try {
    // Common functions emulator host/port mapping
    const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
    const url = `http://${functionsHost}/poker-4683e/us-central1/cleanupIdleTablesHttp`;
    console.log('Calling', url);
    const res = await fetch(url, { method: 'POST' });
    console.log('HTTP trigger response status:', res.status);
    if (res.status !== 200) {
      console.log('HTTP trigger did not return 200; falling back to local runner.');
      const { execSync } = await import('child_process');
      execSync('node ./scripts/run_idle_cleanup.mjs', { stdio: 'inherit' });
    }
  } catch (e) {
    console.log('HTTP trigger not available or failed:', e.message);
    console.log('Falling back to running local cleanup helper script.');
    try {
      const { execSync } = await import('child_process');
      execSync('node ./scripts/run_idle_cleanup.mjs', { stdio: 'inherit' });
    } catch (e2) {
      console.error('Fallback runner failed:', e2 && e2.message);
    }
  }

  console.log('Waiting up to 10s for the table doc to be deleted by cleanup trigger...');
  for (let i = 0; i < 10; i++) {
    const snap = await tableRef.get();
    if (!snap.exists) {
      console.log('SUCCESS: Idle table was deleted by cleanup trigger.');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.error('FAIL: Idle table was NOT deleted within timeout. If scheduled functions are not running in emulator, consider invoking the cleanup function manually or using the functions emulator REST endpoint.');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
