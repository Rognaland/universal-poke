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
  const [tableIdRaw, playerRaw, tokenRaw] = process.argv.slice(2);
  if (!tableIdRaw || !playerRaw) {
    console.error("Usage: node scripts/check_vault_balance.cjs <tableId> <playerAddress> [tokenAddress]");
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
  let tableId;
  try {
    tableId = BigInt(tableIdRaw);
  } catch (_) {
    tableId = BigInt(ethers.keccak256(ethers.toUtf8Bytes(tableIdRaw)));
  }
  const player = ethers.getAddress(playerRaw);
  const token = tokenRaw ? ethers.getAddress(tokenRaw) : "0xEC718d31590E2015837e22a10DF96FF466DA2A14";
  const vault = new ethers.Contract("0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F", abi, provider);
  let bal;
  try {
    bal = await vault["balanceOf(uint256,address,address)"](tableId, player, token);
  } catch (err) {
    bal = await vault["balanceOf(uint256,address)"](tableId, player);
  }
  console.log(`balanceOf(${tableIdRaw}, ${player}, ${token}) = ${bal.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
