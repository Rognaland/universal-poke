const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const pdAddr = process.env.PRIZE_DISTRIBUTOR;
  if (!pdAddr) throw new Error("PRIZE_DISTRIBUTOR env required");

  const pd = await ethers.getContractAt("PrizeDistributorV3", pdAddr);
  const signer = (await ethers.getSigners())[0];

  const net = await ethers.provider.getNetwork();
  console.log("Network:", net.name || net.chainId);
  console.log("PrizeDistributor:", pd.address);
  console.log("Using signer:", await signer.getAddress());

  const gameServer = await pd.gameServerAddress();
  console.log("gameServerAddress:", gameServer);

  const vault = process.env.VAULT;
  if (vault) {
    const isAuth = await pd.isAuthorizedVault(vault);
    console.log(`isAuthorizedVault(${vault}):`, isAuth);
  } else {
    console.log("VAULT env not set (skip isAuthorizedVault check)");
  }

  const lyxBal = await ethers.provider.getBalance(pd.address);
  console.log("PD LYX balance:", ethers.utils.formatEther(lyxBal));

  const token = process.env.TOKEN || ethers.constants.AddressZero;
  const winner = process.env.WINNER;
  if (winner) {
    const amt = await pd.authorizedPayouts(token, winner);
    console.log(`authorizedPayouts[${token}][${winner}] =`, amt.toString());
  } else {
    console.log("WINNER env not set (skip authorizedPayouts check)");
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
