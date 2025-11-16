// E2E test: verify cleanupWaitingLobbyOnHostLeave deletes waiting table when host leaves
// Run with: node ./scripts/test_host_leave.mjs
import admin from 'firebase-admin';

async function main(){
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const projectId = 'poker-4683e';
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  console.log('Creating waiting table with host...');
  const tableRef = await db.collection('tables').add({
    host: 'HostCleanup',
    hostId: 'host-cleanup-1',
    maxPlayers: 2,
    sb: 10,
    bb: 20,
    stack: 1500,
    tokenAddress: '0x0000000000000000000000000000000000000000',
  unitMultiplier: '10000000000000000',
    buyin: 100,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'waiting',
    players: 1,
    minPlayers: 2,
  });
  const tableId = tableRef.id;
  console.log('Table created:', tableId);

  console.log('Adding host player doc...');
  const hostDocRef = await db.collection(`tables/${tableId}/players`).add({ name: 'HostCleanup', address: '0xdeadbeef00000000000000000000000000000000', role: 'host', status: 'seated', createdAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log('Host player doc id:', hostDocRef.id);

  // Give functions a moment to settle
  await new Promise(r => setTimeout(r, 500));

  console.log('Deleting host player doc to simulate host leaving...');
  await hostDocRef.delete();

  console.log('Waiting up to 10s for the table doc to be deleted by cleanup trigger...');
  for (let i = 0; i < 10; i++) {
    const snap = await tableRef.get();
    if (!snap.exists) {
      console.log('SUCCESS: Table was deleted by cleanup trigger.');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.error('FAIL: Table was NOT deleted within timeout. Check functions emulator logs.');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
