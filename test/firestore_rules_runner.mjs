import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import fs from 'fs';
import path from 'path';

async function run(){
  const rules = fs.readFileSync(path.resolve('./firestore.rules'), 'utf8');
  const testEnv = await initializeTestEnvironment({ projectId: 'poker-4683e', firestore: { rules } });
  try {
    const unauth = testEnv.unauthenticatedContext();
    const db = unauth.firestore();

    // create table as admin (bypass rules)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.firestore();
      const tableRef = adminDb.collection('tables').doc('t1');
      await tableRef.set({
        host: 'TestHost', hostId: 'host-1', maxPlayers: 2, sb: 10, bb: 20, stack: 1500,
        tokenAddress: '0x0', unitMultiplier: '1000', buyin: 100, createdAt: { _test: true },
        status: 'waiting', players: 0, minChips: 0
      });
    });

    // read should succeed
    await assertSucceeds(db.collection('tables').doc('t1').get());

    // unauthenticated delete should fail
    await assertFails(db.collection('tables').doc('t1').delete());

    console.log('PASS: firestore rules basic test');
    await testEnv.cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL: firestore rules test failed', e);
    await testEnv.cleanup();
    process.exit(1);
  }
}

run();
