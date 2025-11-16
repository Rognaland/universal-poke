/**
 * Manual trigger for cleanup function (for testing)
 * 
 * Usage:
 *   node test_cleanup_manual.cjs
 * 
 * This will call the cleanup HTTP endpoint to test auto-forfeit logic
 */

const https = require('https');

const CLEANUP_URL = 'https://cleanupidletableshttp-gs6fjtrtfq-uc.a.run.app';

console.log('🧹 Manually triggering cleanup function...');
console.log(`URL: ${CLEANUP_URL}`);
console.log('');

https.get(CLEANUP_URL, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        console.log(`✅ Cleanup triggered successfully!`);
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${data}`);
    });
}).on('error', (err) => {
    console.error('❌ Error triggering cleanup:', err.message);
});
