import { ethers } from 'ethers';

const RPC = 'https://rpc.mainnet.lukso.network';
// Prod addresses from frontend/public/deployments/prod.json
const VAULT = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F';
const WBSTR = '0xec718d31590e2015837e22a10df96ff466da2a14';

const ABI = [
  'function smallestUnitsPerChip(address token) view returns (uint256)',
  'function isTokenAllowed(address token) view returns (bool)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const vault = new ethers.Contract(VAULT, ABI, provider);
  const [wbstrUnits, wbstrAllowed, lyxUnits] = await Promise.all([
    vault.smallestUnitsPerChip(WBSTR),
    vault.isTokenAllowed(WBSTR),
    vault.smallestUnitsPerChip(ethers.ZeroAddress)
  ]);
  console.log(JSON.stringify({
    network: 'lukso-mainnet',
    vault: VAULT,
    wbstr: WBSTR,
    wbstrUnitsPerChip: wbstrUnits.toString(),
    wbstrAllowed,
    lyxUnitsPerChip: lyxUnits.toString()
  }, null, 2));
}

main().catch((e) => { console.error('check_vault_config error:', e?.reason || e?.message || e); process.exit(1); });
