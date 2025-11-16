// scripts/deploy.js (ESM)
// Dynamically import Hardhat at runtime and wait for hre.ethers to be available.
import fs from 'fs';

async function main() {
  // Import hardhat dynamically to improve compatibility inside Docker/Hardhat runtime.
  let hardhatPkg;
  try {
    hardhatPkg = await import('hardhat');
  } catch (err) {
    console.error('Failed to import hardhat:', err);
    throw err;
  }
  const hre = hardhatPkg && hardhatPkg.default ? hardhatPkg.default : hardhatPkg;

  // Wait briefly for hre.ethers to be present (plugin may augment HRE asynchronously in some runtimes)
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    if (hre && hre.ethers) break;
    console.log(`Waiting for hre.ethers... attempt ${i + 1}/${maxAttempts}`);
    // small delay
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!hre || !hre.ethers) {
    throw new Error('hre.ethers is not available. Ensure @nomicfoundation/hardhat-ethers is installed and loaded in hardhat.config.cjs');
  }

  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  const defaultGameServer = signers[1];
  const player1 = signers[2];
  const testGameServerPk = process.env.TEST_GAME_SERVER_PK || null;
  let gameServer = defaultGameServer;
  if (testGameServerPk) {
    const { Wallet } = await import('ethers');
    gameServer = new Wallet(testGameServerPk, hre.ethers.provider);
  }

  console.log('Deploying contracts with the account:', deployer.address);
  console.log('Game Server account:', gameServer.address);
  console.log('Player1 account:', player1.address);

  // Deploy PrizeDistributor
  // Use exact V3 contract names as defined in your Solidity sources
  const PrizeDistributorV3 = await hre.ethers.getContractFactory('PrizeDistributorV3');
  const prizeDistributor = await PrizeDistributorV3.deploy(deployer.address, gameServer.address);
  if (typeof prizeDistributor.waitForDeployment === 'function') {
    await prizeDistributor.waitForDeployment();
  } else if (typeof prizeDistributor.deployed === 'function') {
    await prizeDistributor.deployed();
  }
  // Get stable address after deployment
  const prizeDistributorAddr = (typeof prizeDistributor.getAddress === 'function') ? await prizeDistributor.getAddress() : (prizeDistributor.address || prizeDistributor.target || null);

  // Deploy GameVaultV3 (exact name)
  const GameVaultV3 = await hre.ethers.getContractFactory('GameVaultV3');
  // GameVaultV3 constructor takes (address initialOwner, address _prizeDistributor)
  const gameVault = await GameVaultV3.deploy(deployer.address, prizeDistributorAddr);
  if (typeof gameVault.waitForDeployment === 'function') {
    await gameVault.waitForDeployment();
  } else if (typeof gameVault.deployed === 'function') {
    await gameVault.deployed();
  }
  const gameVaultAddr = (typeof gameVault.getAddress === 'function') ? await gameVault.getAddress() : (gameVault.address || gameVault.target || null);

  // We're using native chain currency for payouts (no token contracts deployed).
  // Configure contracts that require an authorized vault
  if (prizeDistributor.setAuthorizedVault) {
    await prizeDistributor.setAuthorizedVault(gameVaultAddr, true);
  }

  // Configure GameVaultV3 operational params
  try {
    // Set LYX smallest units per chip to 1e16 (0.01 LYX per chip)
    if (gameVault.setSmallestUnitsPerChip) {
      await gameVault.setSmallestUnitsPerChip(hre.ethers.ZeroAddress, hre.ethers.parseUnits('0.01', 18));
    }
  } catch (e) {
    console.warn('setSmallestUnitsPerChip failed:', e && e.message ? e.message : e);
  }
  try {
    // Trust deployer and game server to execute house-paid payouts and deposits
    if (gameVault.setTrustedDepositor) {
      await gameVault.setTrustedDepositor(deployer.address, true);
      await gameVault.setTrustedDepositor(gameServer.address, true);
    }
  } catch (e) {
    console.warn('setTrustedDepositor failed:', e && e.message ? e.message : e);
  }

  const out = {
  prizeDistributor: prizeDistributorAddr || prizeDistributor.address || prizeDistributor.target,
  gameVault: gameVaultAddr || gameVault.address || gameVault.target,
  // no token address - using native coin
  wbstrToken: null,
    deployer: deployer.address,
    gameServer: gameServer.address,
    player1: player1.address,
    testGameServerPk: testGameServerPk || null,
  rpcUrl: (network && network.config && network.config.url) || process.env.RPC_URL || 'http://127.0.0.1:8545'
  };
  try { fs.mkdirSync('deployments', { recursive: true }); } catch (e) {}
  fs.writeFileSync('deployments/local.json', JSON.stringify(out, null, 2));

  console.log('\n--- KONFIGURACIJA ZA TEST (wrote deployments/local.json) ---');
  console.log(JSON.stringify(out, null, 2));
  console.log('---------------------------\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

