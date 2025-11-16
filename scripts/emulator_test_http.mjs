// HTTP-based emulator E2E test that uses Firestore emulator REST API to avoid firebase-admin issues
// Usage: node ./scripts/emulator_test_http.mjs
const base = 'http://127.0.0.1:8080/v1/projects/poker-4683e/databases/(default)/documents';

function toStringValue(s){ return { stringValue: String(s) }; }
function toIntegerValue(n){ return { integerValue: String(n) }; }
function toBooleanValue(b){ return { booleanValue: !!b }; }

async function createDoc(collection, fields){
  const res = await fetch(`${base}/${collection}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`createDoc ${collection} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.name; // full resource name: projects/.../documents/collection/docId
}

async function createSubDoc(docPath, subcol, fields){
  const res = await fetch(`${base}/${docPath}/${subcol}`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`createSubDoc ${docPath}/${subcol} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).name;
}

async function patchDoc(fullName, fields){
  // fullName is the resource name returned by create (projects/.../documents/collection/docId)
  const url = `http://127.0.0.1:8080/v1/${fullName}`; // emulator expects /v1/{name}
  const res = await fetch(url, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`patchDoc failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function getDoc(fullName){
  const url = `http://127.0.0.1:8080/v1/${fullName}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDoc failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function fieldsForTable(payload){
  const f = {};
  for (const k of Object.keys(payload)){
    const v = payload[k];
    if (typeof v === 'string') f[k] = toStringValue(v);
    else if (typeof v === 'number') f[k] = toIntegerValue(v);
    else if (typeof v === 'boolean') f[k] = toBooleanValue(v);
    else if (v === null) f[k] = { nullValue: null };
    else f[k] = toStringValue(JSON.stringify(v));
  }
  return f;
}

(async function(){
  try{
    console.log('Creating table via REST...');
    const tname = await createDoc('tables', fieldsForTable({
      host: 'TestHost',
      hostId: 'host-1',
      players: 0,
      status: 'waiting',
      maxPlayers: 2,
      sb: 10,
      bb: 20,
      stack: 1500,
      buyin: 100,
      tokenAddress: '0xToken',
      unitMultiplier: 1,
      minChips: 0,
      createdAt: new Date().toISOString()
    }));
    console.log('Table resource:', tname);
    const parts = tname.split('/');
    const tableId = parts[parts.length-1];
    console.log('TableId:', tableId);

    console.log('Adding two players...');
    const p1 = await createSubDoc(`tables/${tableId}`, 'players', fieldsForTable({ name: 'Host', address: '0x1111', role: 'host', status: 'seated' }));
    const p2 = await createSubDoc(`tables/${tableId}`, 'players', fieldsForTable({ name: 'Player2', address: '0x2222', role: 'player', status: 'seated' }));
    console.log('Players created:', p1, p2);

    // update players count
    await patchDoc(tname, fieldsForTable({ players: 2 }));

    console.log('Set status to starting (paymentWindowSec:10)');
    await patchDoc(tname, fieldsForTable({ status: 'starting', paymentWindowSec: 10 }));

    console.log('Simulate payment: mark players as paid via subdocs');
    // Need to get their doc names to patch
    const p1Name = p1; const p2Name = p2;
    await patchDoc(p1Name, fieldsForTable({ status: 'paid' }));
    await patchDoc(p2Name, fieldsForTable({ status: 'paid' }));

    console.log('Wait 2s then set table active');
    await new Promise(r => setTimeout(r, 2000));
    await patchDoc(tname, fieldsForTable({ status: 'active' }));

    console.log('Polling for game state (up to 15s)...');
    const gameStatePath = `projects/poker-4683e/databases/(default)/documents/tables/${tableId}/game/state`;
    for (let i=0;i<15;i++){
      const g = await getDoc(gameStatePath);
      if (g){ console.log('Game state found:', JSON.stringify(g, null, 2)); process.exit(0); }
      await new Promise(r=>setTimeout(r,1000));
    }
    console.error('Game state not created within timeout. Check functions emulator logs.');
    process.exit(2);
  }catch(e){
    console.error('HTTP smoke test error:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
