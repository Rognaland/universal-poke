// Test: create an 11-minute-old waiting table and verify cleanup deletes it
// Run with: node ./scripts/test_idle_10min.mjs

import admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

async function main(){
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const projectId = 'poker-4683e';
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  const oldDate = new Date(Date.now() - 11 * 60 * 1000); // 11 minutes ago
  console.log('Creating table with createdAt =', oldDate.toISOString());
  const tableRef = await db.collection('tables').add({
    host: 'IdleTest10', hostId: 'idle-10', status: 'waiting', players: 0,
    createdAt: admin.firestore.Timestamp.fromDate(oldDate)
  });
  console.log('Created table:', tableRef.id);

  // Give functions/emulator a moment
  await new Promise(r=>setTimeout(r,500));

  // Run local cleanup runner
  console.log('Running local cleanup runner...');
  const runner = await import('./run_idle_cleanup.mjs');
  // Request cleanup for tables older than 10 minutes => days = 10 / (24*60)
  const daysForTenMin = 10 / (24 * 60);
  await runner.runCleanup({ days: daysForTenMin });

  // Check whether table exists
  const snap = await tableRef.get();
  if (!snap.exists) {
    console.log('SUCCESS: table deleted by cleanup');
    process.exit(0);
  }
  console.error('FAIL: table still exists');
  process.exit(2);
}

main().catch(e=>{ console.error(e); process.exit(1); });
