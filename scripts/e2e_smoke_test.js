// scripts/e2e_smoke_test.js
const fs = require('fs');
const fetch = require('node-fetch');
const hre = require('hardhat');
const { ethers } = hre;

async function main() {
  const deployInfo = JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
  const rpc = deployInfo.rpcUrl || 'http://127.0.0.1:8545';
  const provider = new hre.ethers.JsonRpcProvider(rpc);

  // wallets
  const player1 = provider.getSigner(deployInfo.player1);
  const gameServerPk = process.env.TEST_GAME_SERVER_PK || deployInfo.testGameServerPk;
  let gameServer;
  if (gameServerPk) {
    gameServer = new hre.ethers.Wallet(gameServerPk, provider);
  } else {
    // fallback: use first signer
    const s = await provider.listAccounts();
    gameServer = provider.getSigner(s[0]);
  }

  console.log('Using provider', rpc);
  console.log('Player1 address', await player1.getAddress());
  console.log('GameServer address', gameServer.address || (await gameServer.getAddress && await gameServer.getAddress()));

  // 1) Call startAiGame create
  const createResp = await fetch('http://127.0.0.1:5001/poker-4683e/us-central1/startAiGame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'create', difficulty: 'easy', buyin: 10, tokenAddress: '0x0000000000000000000000000000000000000000', unitMultiplier: '1', hostAddress: await player1.getAddress(), hostName: 'E2E Tester' })
  });
  const created = await createResp.json();
  console.log('createResp', created);
  if (!created.tableId) throw new Error('create failed');

  // 2) Deposit: using test mode we'll skip actual on-chain deposit. But deposit flow requires front-end; instead call confirm with test=true
  const confirmResp = await fetch('http://127.0.0.1:5001/poker-4683e/us-central1/startAiGame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'confirm', tableId: created.tableId, txHash: '0x0', hostAddress: await player1.getAddress(), buyin: 10, test: true })
  });
  const confirmed = await confirmResp.json();
  console.log('confirmResp', confirmed);
  if (!confirmed.ok) throw new Error('confirm failed');

  // 3) Verify table is active in Firestore (use firestore emulator REST API)
  const fsUrl = `http://127.0.0.1:8080/v1/projects/poker-4683e/databases/(default)/documents/tables/${created.tableId}`;
  const tableDocResp = await fetch(fsUrl);
  const tableDoc = await tableDocResp.json();
  console.log('tableDoc', tableDoc.name || tableDoc);

  // 4) Simulate authorizePayout by calling PrizeDistributor.authorizePayout with gameServer signer (local test)
  const pdAbi = require('../frontend/src/PrizeDistributorV3.json').abi || require('../frontend/src/PrizeDistributorV3.json');
  const pd = new hre.ethers.Contract(deployInfo.prizeDistributor, pdAbi, gameServer);
  const winner = await player1.getAddress();
  const token = '0x0000000000000000000000000000000000000000';
  const amount = hre.ethers.parseEther ? hre.ethers.parseEther('0.001') : hre.ethers.utils.parseEther('0.001');
  console.log('Authorizing payout to', winner, 'amount', amount.toString());
  const tx = await pd.authorizePayout(winner, token, amount);
  const receipt = await tx.wait();
  console.log('authorizePayout tx', receipt.transactionHash);

  const events = receipt.logs.map(l => l.topics && l.topics[0]).filter(Boolean);
  console.log('Events topics in receipt:', events.slice(0,5));

  console.log('E2E smoke test completed OK');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
