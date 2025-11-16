import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// Initialize Firebase Admin
const serviceAccount = JSON.parse(readFileSync('./poker-4683e-firebase-adminsdk-r3y7l-fc25a6e928.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function resetAiMatchResult(tableId) {
    const tableRef = db.doc(`tables/${tableId}`);
    
    try {
        await tableRef.update({
            aiMatchResult: admin.firestore.FieldValue.delete()
        });
        console.log(`✅ Reset aiMatchResult for table ${tableId}`);
    } catch (err) {
        console.error(`❌ Failed to reset:`, err.message);
    }
    
    process.exit(0);
}

const tableId = process.argv[2];
if (!tableId) {
    console.error('Usage: node reset_ai_match.mjs <tableId>');
    process.exit(1);
}

resetAiMatchResult(tableId);
