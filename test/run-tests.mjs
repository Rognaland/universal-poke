import('./firestore.rules.test.mjs').then(()=>{
  console.log('Imported test module (async behavior may need a test runner)');
}).catch(e=>{ console.error(e); process.exit(1); });
