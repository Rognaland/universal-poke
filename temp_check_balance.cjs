const { ethers } = require("ethers");
const artifact = require("./functions/artifacts/contracts/GameVaultV6.sol/GameVaultV6.json");
const abi = Array.isArray(artifact.abi)
  ? artifact.abi
  : Array.isArray(artifact.default?.abi)
    ? artifact.default.abi
    : artifact;

const provider = new ethers.JsonRpcProvider("https://rpc.mainnet.lukso.network");
const tableIdRaw = "7AzTp6bGC6mQ0ylRjNOR";
const player = "0xB25CE199DeB849E593D335D2e30A293D1d695821";
const token = "0xec718D31590E2015837e22a10Df96fF466DA2A14";

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
  const bal = await contract["balanceOf(uint256,address,address)"](tableIdOnchain, player, token);
  const total = await contract.totalTokenBalances(token);
  console.log("table balance", bal.toString());
  console.log("total token balance", total.toString());
})();
