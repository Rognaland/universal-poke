// Simple emulator E2E test: create table, add players, mark paid, set active
// Run with Firestore emulator running (FIRESTORE_EMULATOR_HOST=127.0.0.1:8080)

const admin = require('firebase-admin');

async function main() {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const projectId = 'poker-4683e';
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  console.log('Creating test table...');
  const tableRef = await db.collection('tables').add({
    host: 'TestHost',
    hostId: 'host-1',
    maxPlayers: 2,
    sb: 10,
    bb: 20,
    stack: 1500,
    tokenAddress: '0x0000000000000000000000000000000000000000',
  unitMultiplier: '10000000000000000',
    buyin: 100,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'waiting',
    players: 0,
    minPlayers: 2,
  });
  const tableId = tableRef.id;
  console.log('Table created:', tableId);

  console.log('Seating two players...');
  const p1 = await db.collection(`tables/${tableId}/players`).add({ name: 'Host', address: '0x1111000000000000000000000000000000001111', role: 'host', status: 'seated', createdAt: admin.firestore.FieldValue.serverTimestamp() });
  const p2 = await db.collection(`tables/${tableId}/players`).add({ name: 'Player2', address: '0x2222000000000000000000000000000000002222', role: 'player', status: 'seated', createdAt: admin.firestore.FieldValue.serverTimestamp() });

  await tableRef.update({ players: 2 });

  console.log('Setting table to starting (payment window 10s)...');
  await tableRef.update({ status: 'starting', startingAt: admin.firestore.FieldValue.serverTimestamp(), paymentWindowSec: 10 });

  console.log('Simulating deposits by marking players as paid...');
  await db.doc(`tables/${tableId}/players/${p1.id}`).update({ status: 'paid' });
  await db.doc(`tables/${tableId}/players/${p2.id}`).update({ status: 'paid' });

  console.log('Waiting 2s then activating table (simulate verify)...');
  await new Promise(r => setTimeout(r, 2000));
  await tableRef.update({ status: 'active', startedAt: admin.firestore.FieldValue.serverTimestamp() });

  console.log('Waiting up to 10s for game state to appear...');
  const gameRef = db.doc(`tables/${tableId}/game/state`);
  for (let i = 0; i < 10; i++) {
    const snap = await gameRef.get();
    if (snap.exists) {
      console.log('Game state created by functions. Details:');
      console.log(JSON.stringify(snap.data(), null, 2));
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('Game state not created within timeout. Check functions emulator logs.');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
