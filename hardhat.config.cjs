// CommonJS Hardhat config to be used when package.json.type === 'module'.
// CommonJS Hardhat config to be used when package.json.type === 'module'.
// Load hardhat toolbox which brings common plugins (including hardhat-ethers)
try {
  require('@nomicfoundation/hardhat-toolbox');
} catch (e) {
  // If toolbox isn't installed, try to require the ethers plugin directly.
  try { require('@nomicfoundation/hardhat-ethers'); } catch (e2) { /* ignore */ }
}
// Ensure ethers plugin is loaded (some environments may not load toolbox's plugins synchronously)
try { require('@nomicfoundation/hardhat-ethers'); } catch (e) { /* ignore if already loaded */ }
module.exports = {
  solidity: {
    compilers: [
  { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
      { version: '0.8.20' },
      { version: '0.8.4' }
    ]
  },
  networks: {
    // Keep default 'hardhat' network. Add custom networks here if needed.
    // Docker-friendly network: use the compose service name `hardhat` as the RPC host
    // so other containers can reach the node as http://hardhat:8545
    docker: {
      url: 'http://hardhat:8545',
      // If you need to provide specific accounts for this client, set
      // process.env.DOCKER_PRIVATE_KEYS to a comma-separated list and
      // uncomment the line below to load them. Otherwise the provider's
      // accounts (Hardhat node) will be used.
      // accounts: process.env.DOCKER_PRIVATE_KEYS ? process.env.DOCKER_PRIVATE_KEYS.split(',') : undefined,
    },
  },
};
