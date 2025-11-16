// Run-time script to delete idle waiting tables (mimics cleanupIdleTables scheduled function)
// Run with: node ./scripts/run_idle_cleanup.mjs

import admin from 'firebase-admin';

function ensureAdmin(projectId = 'poker-4683e'){
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  try {
    // if already initialized, return default app
    return admin.app();
  } catch (e) {
    return admin.initializeApp({ projectId });
  }
}

export async function runCleanup({ days = 7 } = {}){
  const app = ensureAdmin();
  const db = admin.firestore();
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  console.log('Querying for waiting tables created before', cutoff.toDate().toISOString());

  const q = db.collection('tables').where('status', '==', 'waiting').where('createdAt', '<=', cutoff).limit(100);
  const snap = await q.get();
  if (snap.empty) {
    console.log('No idle tables found.');
    return { deleted: 0 };
  }

  console.log('Found', snap.size, 'idle tables. Deleting...');
  for (const doc of snap.docs) {
    console.log('Deleting table', doc.id);
    await doc.ref.delete();
  }

  console.log('Done.');
  return { deleted: snap.size };
}

// CLI entrypoint when run directly
if (process.argv[1] && process.argv[1].endsWith('run_idle_cleanup.mjs')){
  runCleanup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
