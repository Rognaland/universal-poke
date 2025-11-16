import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import fs from 'fs';
import path from 'path';

const rules = fs.readFileSync(path.resolve('./firestore.rules'), 'utf8');

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'poker-4683e',
    firestore: { rules }
  });
});

afterAll(async () => {
  await testEnv.clearFirestore();
  await testEnv.cleanup();
});

test('unauthenticated user can read tables but cannot delete table', async () => {
  const alice = testEnv.unauthenticatedContext();
  const db = alice.firestore();

  // create a table as admin
  const adminDb = testEnv.adminContext().firestore();
  const tableRef = adminDb.collection('tables').doc('t1');
  await tableRef.set({
    host: 'TestHost', hostId: 'host-1', maxPlayers: 2, sb: 10, bb: 20, stack: 1500,
    tokenAddress: '0x0', unitMultiplier: '1000', buyin: 100, createdAt: admin.firestore.FieldValue.serverTimestamp ? admin.firestore.FieldValue.serverTimestamp() : { _test: true },
    status: 'waiting', players: 0, minChips: 0
  });

  // read should succeed
  await assertSucceeds(db.collection('tables').doc('t1').get());

  // unauthenticated delete should fail
  await assertFails(db.collection('tables').doc('t1').delete());
});
