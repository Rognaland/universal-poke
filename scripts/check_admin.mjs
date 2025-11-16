import admin from 'firebase-admin';

async function main(){
  try{
    console.log('firebase-admin imported OK');
    console.log('SDK version:', admin.SDK_VERSION || 'unknown');
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    const projectId = 'poker-4683e';
    admin.initializeApp({ projectId });
    const db = admin.firestore();
    console.log('initialized app, attempting small write...');
    await db.collection('diag').doc('ping').set({now: admin.firestore.FieldValue.serverTimestamp()});
    console.log('write succeeded');
    process.exit(0);
  }catch(e){
    console.error('diagnostic error:', e && e.stack ? e.stack : e);
    process.exit(2);
  }
}

main();
