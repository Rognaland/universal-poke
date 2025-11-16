#!/usr/bin/env node
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function env(name, required = false) {
  const value = process.env[name];
  if (typeof value === 'string' && value.length) return value;
  if (required) throw new Error(`${name} env variable is required`);
  return undefined;
}

function loadVaultAbi() {
  const candidates = [
    '../functions/artifacts/contracts/GameVaultV6.sol/GameVaultV6.json',
    '../artifacts/contracts/GameVaultV6.sol/GameVaultV6.json',
    '../functions/artifacts/contracts/GameVaultV3.sol/GameVaultV3.json',
    '../artifacts/contracts/GameVaultV3.sol/GameVaultV3.json'
  ];
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of candidates) {
    try {
      const p = path.resolve(baseDir, rel);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.abi)) return parsed.abi;
    } catch (err) {
      // Skip and try next candidate
    }
  }
  throw new Error('Unable to locate GameVault ABI. Run `npx hardhat compile` first.');
}

function deriveOnchainTableId(raw) {
  if (raw === undefined || raw === null) throw new Error('TABLE_ID env is required');
  const str = String(raw);
  try {
    return BigInt(str);
  } catch (_) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(str));
    return BigInt(hash);
  }
}

function toChecksum(addr) {
  if (!addr) return null;
  try {
    return ethers.getAddress(String(addr));
  } catch (_) {
    return String(addr);
  }
}

async function computeEffectiveRakeBps(vaultReader, tableId, token) {
  const denom = 10000n;
  try {
    const hasTableOverride = await vaultReader.hasTableTokenRakeBps(tableId, token);
    if (hasTableOverride) {
      return BigInt(await vaultReader.tableTokenRakeBps(tableId, token));
    }
    const hasTokenOverride = await vaultReader.hasTokenRakeBps(token);
    if (hasTokenOverride) {
      return BigInt(await vaultReader.tokenRakeBps(token));
    }
    return BigInt(await vaultReader.rakeBps());
  } catch (err) {
    console.warn('manual_withdraw: failed to read rake configuration, assuming 0 bps', err?.message || err);
    return 0n;
  }
}

function computeGross(netAmount, effectiveRakeBps) {
  const denom = 10000n;
  if (netAmount <= 0n) return 0n;
  if (effectiveRakeBps <= 0n) return netAmount;
  if (effectiveRakeBps >= denom) {
    throw new Error(`Invalid rake setting ${effectiveRakeBps} (>=10000)`);
  }
  const divisor = denom - effectiveRakeBps;
  return ((netAmount * denom) + (divisor - 1n)) / divisor;
}

function parseAmount(input, decimals = undefined) {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  if (decimals === undefined) throw new Error('AMOUNT contains decimals; provide TOKEN_DECIMALS to parse it');
  return ethers.parseUnits(trimmed, Number(decimals));
}

async function main() {
  const RPC_URL = env('RPC_URL', true);
  const VAULT_ADDR = env('VAULT', true);
  const TABLE_ID = env('TABLE_ID', true);
  const PLAYER = env('PLAYER', true);
  const TOKEN = env('TOKEN') || ethers.ZeroAddress;
  const PRIZE_POOL_PK = env('PRIZE_POOL_PK', true);
  const TOKEN_DECIMALS = env('TOKEN_DECIMALS');
  const AMOUNT_OVERRIDE = parseAmount(env('AMOUNT'), TOKEN_DECIMALS);
  const PD_ADDR = env('PRIZE_DISTRIBUTOR');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIZE_POOL_PK, provider);

  console.log('Using signer:', await signer.getAddress());
  console.log('Vault:', VAULT_ADDR);
  console.log('Token:', TOKEN);
  console.log('Table ID (raw):', TABLE_ID);

  const onchainTableId = deriveOnchainTableId(TABLE_ID);
  console.log('Table ID (on-chain bigint):', onchainTableId.toString());

  const vaultAbi = loadVaultAbi();
  const vault = new ethers.Contract(VAULT_ADDR, vaultAbi, signer);
  const vaultReader = new ethers.Contract(VAULT_ADDR, vaultAbi, provider);

  const normalizedPlayer = toChecksum(PLAYER);
  const normalizedToken = TOKEN ? toChecksum(TOKEN) : ethers.ZeroAddress;

  let balance = await vault['balanceOf(uint256,address,address)'](onchainTableId, normalizedPlayer, normalizedToken);
  console.log('Vault balance (raw units):', balance.toString());

  let decimalsInt;
  if (TOKEN_DECIMALS !== undefined) {
    decimalsInt = Number(TOKEN_DECIMALS);
  } else if (TOKEN === ethers.ZeroAddress) {
    decimalsInt = 18;
  }
  if (decimalsInt !== undefined) {
    console.log('Vault balance (formatted):', ethers.formatUnits(balance, decimalsInt));
  }

  let authorizedBefore;
  let pdContract;
  if (PD_ADDR) {
    pdContract = new ethers.Contract(PD_ADDR, ['function authorizedPayouts(address token, address winner) view returns (uint256)'], provider);
    authorizedBefore = await pdContract.authorizedPayouts(normalizedToken, normalizedPlayer);
    console.log('PrizeDistributor authorization before (raw units):', authorizedBefore.toString());
    if (decimalsInt !== undefined) {
      console.log('PrizeDistributor authorization before (formatted):', ethers.formatUnits(authorizedBefore, decimalsInt));
    }
  }

  const amount = (() => {
    if (AMOUNT_OVERRIDE !== undefined) return AMOUNT_OVERRIDE;
    if (authorizedBefore !== undefined && authorizedBefore > 0n) return authorizedBefore;
    return BigInt(balance.toString());
  })();
  console.log('Amount to withdraw (raw units):', amount.toString());
  if (decimalsInt !== undefined) {
    console.log('Amount to withdraw (formatted):', ethers.formatUnits(amount, decimalsInt));
  }
  if (amount === 0n) {
    console.log('Nothing to withdraw, exiting.');
    return;
  }

  const ensureVaultHasFunds = async () => {
    const current = BigInt(balance.toString());
    if (current >= amount) return true;
    const missing = amount - current;
    console.log('Vault shortfall detected (raw units):', missing.toString());
    const rakeBps = await computeEffectiveRakeBps(vaultReader, onchainTableId, normalizedToken);
    const gross = computeGross(missing, rakeBps);
    console.log(`Attempting top-up: net ${missing.toString()} requires gross ${gross.toString()} (rakeBps=${rakeBps.toString()})`);
    if (gross <= 0n) throw new Error('Computed gross top-up is zero');
    let topupTx;
    if (normalizedToken === ethers.ZeroAddress) {
      topupTx = await vault.depositLyxFor(onchainTableId, normalizedPlayer, { value: gross });
    } else {
      topupTx = await vault.depositLsp7For(normalizedToken, onchainTableId, normalizedPlayer, gross);
    }
    console.log('Top-up tx hash:', topupTx.hash);
    const topupRc = await topupTx.wait();
    console.log('Top-up receipt status:', topupRc.status);
    balance = await vault['balanceOf(uint256,address,address)'](onchainTableId, normalizedPlayer, normalizedToken);
    console.log('Vault balance after top-up (raw units):', balance.toString());
    if (decimalsInt !== undefined) {
      console.log('Vault balance after top-up (formatted):', ethers.formatUnits(balance, decimalsInt));
    }
    return BigInt(balance.toString()) >= amount;
  };

  const hasFunds = await ensureVaultHasFunds();
  if (!hasFunds) {
    throw new Error('Unable to ensure sufficient vault balance before withdrawal');
  }

  console.log('Submitting withdrawFor transaction...');
  const tx = await vault.withdrawFor(onchainTableId, normalizedPlayer, normalizedToken, amount);
  console.log('Tx hash:', tx.hash);
  const receipt = await tx.wait();
  console.log('Withdraw receipt status:', receipt.status);
  console.log('Gas used:', receipt.gasUsed ? receipt.gasUsed.toString() : 'n/a');

  if (pdContract) {
    const authorizedAfter = await pdContract.authorizedPayouts(normalizedToken, normalizedPlayer);
    console.log('PrizeDistributor authorization after (raw units):', authorizedAfter.toString());
    if (decimalsInt !== undefined) {
      console.log('PrizeDistributor authorization after (formatted):', ethers.formatUnits(authorizedAfter, decimalsInt));
    }
  }

  const balanceAfter = await vault['balanceOf(uint256,address,address)'](onchainTableId, normalizedPlayer, normalizedToken);
  console.log('Vault balance after (raw units):', balanceAfter.toString());
  if (decimalsInt !== undefined) {
    console.log('Vault balance after (formatted):', ethers.formatUnits(balanceAfter, decimalsInt));
  }
}

main().catch((err) => {
  console.error('manual_withdraw error:', err?.message || err);
  process.exit(1);
});
