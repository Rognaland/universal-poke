#!/usr/bin/env node
/**
 * Manually cleanup all old/idle tables from Firestore
 * This script mimics the cleanupIdleTables scheduled function
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Initialize Firebase Admin with project ID
initializeApp({
    projectId: 'poker-4683e'
});

const db = getFirestore();

// Cleanup helper functions (same as in functions/index.js)
async function deleteCollection(refPath, batchSize = 100) {
    const colRef = db.collection(refPath);
    const snapshot = await colRef.limit(batchSize).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size >= batchSize) return deleteCollection(refPath, batchSize);
}

async function cascadeDeleteTable(tableId) {
    console.log(`  🗑️  Deleting table ${tableId} and all subcollections...`);
    try {
        // Delete subcollections
        await deleteCollection(`tables/${tableId}/players`);
        await deleteCollection(`tables/${tableId}/chat`);
        await deleteCollection(`tables/${tableId}/game`);
        
        // Delete main table document
        await db.collection('tables').doc(tableId).delete();
        console.log(`  ✅ Table ${tableId} deleted successfully`);
    } catch (e) {
        console.warn(`  ⚠️  Error deleting table ${tableId}:`, e.message);
    }
}

async function cleanupAllOldTables() {
    console.log('🧹 Starting manual cleanup of all old tables...\n');
    
    const nowTs = Timestamp.now();
    const fiveMinAgo = new Timestamp(nowTs.seconds - 5 * 60, 0);
    
    const tablesRef = db.collection('tables');
    let totalDeleted = 0;
    
    // 1. Cleanup multiplayer tables with no players
    console.log('📋 Checking multiplayer tables (playerCount == 0)...');
    const mpSnap = await tablesRef
        .where('playerCount', '==', 0)
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    
    console.log(`Found ${mpSnap.docs.length} empty multiplayer tables older than 5 minutes`);
    for (const doc of mpSnap.docs) {
        await cascadeDeleteTable(doc.id);
        totalDeleted++;
    }
    
    // 2. Cleanup AI tables (mode == 'ai')
    console.log('\n🤖 Checking AI tables (mode == "ai")...');
    const aiSnap = await tablesRef
        .where('mode', '==', 'ai')
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    
    console.log(`Found ${aiSnap.docs.length} AI tables older than 5 minutes`);
    for (const doc of aiSnap.docs) {
        const tableData = doc.data();
        
        // Skip if still active
        if (tableData.status === 'active') {
            console.log(`  ⏭️  Skipping active AI table ${doc.id}`);
            continue;
        }
        
        // Skip if blockchain is processing
        if (tableData.aiMatchResult && tableData.aiMatchResult.processingBlockchain === true) {
            console.log(`  ⏭️  Skipping AI table ${doc.id} - blockchain processing`);
            continue;
        }
        
        // Skip if result not finalized
        if (tableData.aiMatchResult && !tableData.aiMatchResult.status) {
            console.log(`  ⏭️  Skipping AI table ${doc.id} - result not finalized`);
            continue;
        }
        
        await cascadeDeleteTable(doc.id);
        totalDeleted++;
    }
    
    // 3. Cleanup PvE tables (gameType == 'PvE')
    console.log('\n⚔️  Checking PvE tables (gameType == "PvE")...');
    const pveSnap = await tablesRef
        .where('gameType', '==', 'PvE')
        .where('lastActivityAt', '<', fiveMinAgo)
        .get();
    
    console.log(`Found ${pveSnap.docs.length} PvE tables older than 5 minutes`);
    for (const doc of pveSnap.docs) {
        const tableData = doc.data();
        
        if (tableData.status === 'active') {
            console.log(`  ⏭️  Skipping active PvE table ${doc.id}`);
            continue;
        }
        
        if (tableData.aiMatchResult && tableData.aiMatchResult.processingBlockchain === true) {
            console.log(`  ⏭️  Skipping PvE table ${doc.id} - blockchain processing`);
            continue;
        }
        
        if (tableData.aiMatchResult && !tableData.aiMatchResult.status) {
            console.log(`  ⏭️  Skipping PvE table ${doc.id} - result not finalized`);
            continue;
        }
        
        await cascadeDeleteTable(doc.id);
        totalDeleted++;
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`✅ Cleanup complete! Deleted ${totalDeleted} old tables`);
    console.log('='.repeat(50));
}

// Run cleanup
cleanupAllOldTables()
    .then(() => {
        console.log('\n✨ Script finished successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Script failed:', error);
        process.exit(1);
    });
