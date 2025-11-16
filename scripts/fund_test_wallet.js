// Fund the test wallet from Hardhat's default account
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://hardhat:8545";
const SENDER_PK = process.env.FUND_SENDER_PK || '';
const RECIPIENT = process.env.FUND_RECIPIENT || "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const AMOUNT = ethers.parseEther("1.0"); // 1 ETH

async function main() {
  if (!SENDER_PK) throw new Error('FUND_SENDER_PK is not set. Set FUND_SENDER_PK in env for fund-wallet service.');
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(SENDER_PK, provider);
  console.log(`Funding ${RECIPIENT} with 1 ETH from ${wallet.address}`);
  const tx = await wallet.sendTransaction({
    to: RECIPIENT,
    value: AMOUNT,
  });
  await tx.wait();
  console.log(`Tx sent: ${tx.hash}`);
}

main().catch((e) => {
  console.error("Funding failed:", e);
  process.exit(1);
});
