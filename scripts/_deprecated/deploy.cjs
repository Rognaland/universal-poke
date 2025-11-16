// scripts/deploy.cjs - CommonJS deploy script to ensure Hardhat Runtime Environment (hre) is loaded with plugins
const fs = require('fs');
let hre;
try {
  hre = require('hardhat');
} catch (e) {
  hre = null;
}

async function main() {
  let ethersLib = null;
  let deployer, defaultGameServer, player1, gameServer;
  if (hre && hre.ethers) {
    ethersLib = hre.ethers;
    const signers = await hre.ethers.getSigners();
    deployer = signers[0];
    defaultGameServer = signers[1];
    player1 = signers[2];
  } else {
    // Fallback: use ethers library connected to local JSON-RPC (Hardhat node)
    console.log('hre.ethers not available — falling back to plain ethers via RPC');
    ethersLib = require('ethers');
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const provider = new ethersLib.JsonRpcProvider(rpcUrl);
    // Use the default Hardhat first account private key so we can deploy
  const defaultPk = process.env.DEPLOYER_PK || '';
  if (!defaultPk) throw new Error('DEPLOYER_PK is not set for fallback deploy. Use Hardhat signers or set DEPLOYER_PK env.');
  const wallet = new ethersLib.Wallet(defaultPk, provider);
    deployer = wallet;
    // derive other accounts deterministically for test use
    defaultGameServer = ethersLib.Wallet.createRandom().connect(provider);
    player1 = ethersLib.Wallet.createRandom().connect(provider);
  }
  const testGameServerPk = process.env.TEST_GAME_SERVER_PK || null;
  gameServer = defaultGameServer;
  if (testGameServerPk) {
    const Wallet = (ethersLib && ethersLib.Wallet) || require('ethers').Wallet;
    const provider = (hre && hre.ethers && hre.ethers.provider) || (ethersLib && ethersLib.provider) || null;
    gameServer = new Wallet(testGameServerPk, provider);
  }

  console.log('Deploying contracts with the account:', deployer.address);
  console.log('Game Server account:', gameServer.address);
  console.log('Player1 account:', player1.address);

  let prizeDistributor, gameVault, wbstrToken;
  // hoisted addresses so they are available outside the hre vs fallback block
  let prizeDistributorAddress = undefined;
  let gameVaultAddress = undefined;
  let wbstrTokenAddress = undefined;
  if (hre && hre.ethers) {
    // helper that deploys via the factory and returns the contract + address from the receipt
    async function deployAndGetAddress(factory, provider, ...args) {
      const contract = await factory.deploy(...args);
      let receipt = null;
      try {
        if (contract.deployTransaction && typeof contract.deployTransaction.wait === 'function') {
          receipt = await contract.deployTransaction.wait();
        } else if (contract.deploymentTransaction && typeof contract.deploymentTransaction.wait === 'function') {
          receipt = await contract.deploymentTransaction.wait();
        } else {
          const txHash = (contract.deployTransaction && contract.deployTransaction.hash)
            || (contract.deploymentTransaction && contract.deploymentTransaction.hash)
            || contract.transactionHash || contract.hash;
          if (txHash && provider) {
            receipt = await provider.waitForTransaction(txHash, 1, 120000).catch(() => null);
          }
        }
      } catch (e) {
        console.log('Error while waiting for receipt:', e && e.message);
      }
      const address = (receipt && receipt.contractAddress) || contract.address || contract.target || null;
      return { contract, address, receipt };
    }

    const PrizeDistributorV3 = await hre.ethers.getContractFactory('PrizeDistributorV3');
    const pd = await deployAndGetAddress(PrizeDistributorV3, hre.ethers.provider, deployer.address, gameServer.address);
    prizeDistributor = pd.contract;
    prizeDistributorAddress = pd.address;

    const GameVaultV3 = await hre.ethers.getContractFactory('GameVaultV3');
    const gv = await deployAndGetAddress(GameVaultV3, hre.ethers.provider, deployer.address, prizeDistributorAddress || deployer.address);
    gameVault = gv.contract;
    gameVaultAddress = gv.address;

    const MockLSP7 = await hre.ethers.getContractFactory('MockLSP7');
    const mock = await deployAndGetAddress(MockLSP7, hre.ethers.provider, 'Test WBSTR', 'TWBSTR', deployer.address);
    wbstrToken = mock.contract;
    wbstrTokenAddress = mock.address;
  } else {
    // Fallback: deploy using compiled artifacts and plain ethers
    const ethers = require('ethers');
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = deployer.connect ? deployer : deployer.connect(provider);

    // helper that deploys via the ContractFactory and returns the contract + address from the receipt
    async function deployAndGetAddress(factory, provider, ...args) {
      const contract = await factory.deploy(...args);
      let receipt = null;
      try {
        if (contract.deployTransaction && typeof contract.deployTransaction.wait === 'function') {
          receipt = await contract.deployTransaction.wait();
        } else if (contract.deploymentTransaction && typeof contract.deploymentTransaction.wait === 'function') {
          receipt = await contract.deploymentTransaction.wait();
        } else {
          const txHash = (contract.deployTransaction && contract.deployTransaction.hash)
            || (contract.deploymentTransaction && contract.deploymentTransaction.hash)
            || contract.transactionHash || contract.hash;
          if (txHash && provider) {
            receipt = await provider.waitForTransaction(txHash, 1, 120000).catch(() => null);
          }
        }
      } catch (e) {
        console.log('Error while waiting for receipt (fallback):', e && e.message);
      }
      const address = (receipt && receipt.contractAddress) || contract.address || contract.target || null;
      return { contract, address, receipt };
    }

    function loadArtifact(name) {
      // artifacts path: artifacts/contracts/<ContractName>.sol/<ContractName>.json
      const candidates = [
        `artifacts/contracts/${name}.sol/${name}.json`,
        `artifacts/${name}.json`,
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      }
      throw new Error('Artifact for ' + name + ' not found in expected paths: ' + candidates.join(', '));
    }

    const pdArtifact = loadArtifact('PrizeDistributorV3');
    const pdFactory = new ethers.ContractFactory(pdArtifact.abi, pdArtifact.bytecode, signer);
    // Ensure we use deterministic nonces when talking to the RPC to avoid nonce re-use / NONCE_EXPIRED
    const deployerAddress = (typeof deployer.address === 'string') ? deployer.address : (await deployer.getAddress());
    let baseNonce = await provider.getTransactionCount(deployerAddress);

    const pdNonce = baseNonce++;
    const pdNonceOverride = { nonce: pdNonce };
    const pd = await deployAndGetAddress(pdFactory, provider, deployer.address, gameServer.address);
    prizeDistributor = pd.contract;
    prizeDistributorAddress = pd.address;

    const gvArtifact = loadArtifact('GameVaultV3');
    const gvFactory = new ethers.ContractFactory(gvArtifact.abi, gvArtifact.bytecode, signer);
    const gvNonce = baseNonce++;
    const gv = await deployAndGetAddress(gvFactory, provider, deployer.address, prizeDistributorAddress || deployerAddress);
    gameVault = gv.contract;
    gameVaultAddress = gv.address;

    const mockArtifact = loadArtifact('MockLSP7');
    const mockFactory = new ethers.ContractFactory(mockArtifact.abi, mockArtifact.bytecode, signer);
    const mockNonce = baseNonce++;
    const mock = await deployAndGetAddress(mockFactory, provider, 'Test WBSTR', 'TWBSTR', deployer.address);
    wbstrToken = mock.contract;
    wbstrTokenAddress = mock.address;

    // Build explicit Contract instances for stable interaction if addresses are available
    // use the ABI from artifacts and the signer
    function isValidAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
    if (isValidAddress(prizeDistributorAddress)) {
      try { prizeDistributor = new ethers.Contract(prizeDistributorAddress, pdArtifact.abi, signer); } catch (e) { /* ignore */ }
    }
    if (isValidAddress(gameVaultAddress)) {
      try { gameVault = new ethers.Contract(gameVaultAddress, gvArtifact.abi, signer); } catch (e) { /* ignore */ }
    }
    if (isValidAddress(wbstrTokenAddress)) {
      try { wbstrToken = new ethers.Contract(wbstrTokenAddress, mockArtifact.abi, signer); } catch (e) { /* ignore */ }
    }
  }

  const parseEther = (val) => {
    if (hre && hre.ethers && hre.ethers.parseEther) return hre.ethers.parseEther(val);
    if (hre && hre.ethers && hre.ethers.utils && hre.ethers.utils.parseEther) return hre.ethers.utils.parseEther(val);
    const ethers = require('ethers');
    return ethers.parseEther ? ethers.parseEther(val) : ethers.utils.parseEther(val);
  };
  const mintAmount = parseEther('10000');
  const addressIsValid = (a) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a));
  if (wbstrToken && typeof wbstrToken.mint === 'function') {
    // player1.address should be valid; do a final sanity check
    if (!player1 || !player1.address) throw new Error('player1 address missing');
    await wbstrToken.mint(player1.address, mintAmount);
  }

  // Use concrete addresses extracted above in case contract objects don't expose .address consistently
  const finalPrizeDistributorAddress = (typeof prizeDistributorAddress !== 'undefined') ? prizeDistributorAddress : (prizeDistributor.address || null);
  const finalGameVaultAddress = (typeof gameVaultAddress !== 'undefined') ? gameVaultAddress : (gameVault.address || null);
  const finalWbstrTokenAddress = (typeof wbstrTokenAddress !== 'undefined') ? wbstrTokenAddress : (wbstrToken.address || null);

  if (addressIsValid(finalGameVaultAddress) && prizeDistributor && typeof prizeDistributor.setAuthorizedVault === 'function') {
    await prizeDistributor.setAuthorizedVault(finalGameVaultAddress, true);
  } else {
    console.log('Skipping setAuthorizedVault because finalGameVaultAddress is invalid or prizeDistributor method missing', finalGameVaultAddress);
  }
  if (addressIsValid(finalWbstrTokenAddress) && gameVault && typeof gameVault.setTokenAllowed === 'function') {
    await gameVault.setTokenAllowed(finalWbstrTokenAddress, true);
  } else {
    console.log('Skipping setTokenAllowed because finalWbstrTokenAddress is invalid or gameVault method missing', finalWbstrTokenAddress);
  }
  if (addressIsValid(finalWbstrTokenAddress) && gameVault && typeof gameVault.setSmallestUnitsPerChip === 'function') {
    const oneUnit = parseEther('1');
    await gameVault.setSmallestUnitsPerChip(finalWbstrTokenAddress, oneUnit);
  } else {
    console.log('Skipping setSmallestUnitsPerChip because finalWbstrTokenAddress is invalid or gameVault method missing', finalWbstrTokenAddress);
  }

  const out = {
  prizeDistributor: finalPrizeDistributorAddress || prizeDistributor.address,
  gameVault: finalGameVaultAddress || gameVault.address,
  wbstrToken: finalWbstrTokenAddress || wbstrToken.address,
    deployer: deployer.address,
    gameServer: gameServer.address,
    player1: player1.address,
    testGameServerPk: testGameServerPk || null,
    rpcUrl: (hre && hre.network && hre.network.config && hre.network.config.url) || process.env.RPC_URL || 'http://127.0.0.1:8545'
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
// DEPRECATED: deploy.cjs removed. Use scripts/deploy.js (ESM) only.
