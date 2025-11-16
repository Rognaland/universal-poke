#!/usr/bin/env node
const { ethers } = require("ethers");
const artifact = require("../functions/artifacts/contracts/GameVaultV6.sol/GameVaultV6.json");

function resolveAbi(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate;
  if (candidate.abi && Array.isArray(candidate.abi)) return candidate.abi;
  if (candidate.default && Array.isArray(candidate.default.abi)) return candidate.default.abi;
  return [];
}

async function main() {
  const tableIdRaw = process.argv[2];
  if (!tableIdRaw) {
    console.error("Usage: node scripts/check_vault_events.cjs <tableId>");
    process.exitCode = 1;
    return;
  }
  const abi = resolveAbi(artifact);
  if (!abi.length) {
    console.error("GameVault ABI not found");
    process.exitCode = 1;
    return;
  }
  const provider = new ethers.JsonRpcProvider("https://rpc.mainnet.lukso.network");
  let tableIdOnchain;
  try {
    tableIdOnchain = BigInt(tableIdRaw);
  } catch (_) {
    tableIdOnchain = BigInt(ethers.keccak256(ethers.toUtf8Bytes(tableIdRaw)));
  }
  const vault = new ethers.Contract("0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F", abi, provider);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 6000);
  const filter = vault.filters.Withdrawn(null, null, tableIdOnchain);
  const events = await vault.queryFilter(filter, fromBlock, latest);
  console.log(`Found ${events.length} Withdrawn events in blocks [${fromBlock}, ${latest}]`);
  for (const ev of events.slice(-10)) {
    const { player, token, amount } = ev.args;
    console.log({
      block: ev.blockNumber,
      txHash: ev.transactionHash,
      player,
      token,
      amount: amount.toString(),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
