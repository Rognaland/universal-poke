const { ethers } = require("ethers");
const artifact = require("./functions/artifacts/contracts/GameVaultV6.sol/GameVaultV6.json");
const abi = Array.isArray(artifact.abi)
  ? artifact.abi
  : Array.isArray(artifact.default?.abi)
    ? artifact.default.abi
    : artifact;

const provider = new ethers.JsonRpcProvider("https://rpc.mainnet.lukso.network");
const tableIdRaw = "7AzTp6bGC6mQ0ylRjNOR";

let tableIdOnchain;
try {
  tableIdOnchain = BigInt(tableIdRaw);
} catch (err) {
  tableIdOnchain = BigInt(ethers.keccak256(ethers.toUtf8Bytes(tableIdRaw)));
}

(async () => {
  const contract = new ethers.Contract(
    "0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F",
    abi,
    provider
  );
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 5000);
  const filter = contract.filters.Withdrawn(null, null, tableIdOnchain);
  const events = await contract.queryFilter(filter, fromBlock, latest);
  console.log("block window", fromBlock, latest, "events", events.length);
  for (const ev of events.slice(-5)) {
    const { player, token, amount } = ev.args;
    console.log(
      JSON.stringify({
        txHash: ev.transactionHash,
        block: ev.blockNumber,
        player,
        token,
        amount: amount.toString(),
      })
    );
  }
})();
