// Frontend chain services: client-side deposits for LYX and LSP7 WBSTR
// Uses ethers v6 with a LUKSO-compatible provider injected.

import { ethers } from 'ethers';
import ERC725, { encodePermissions, decodePermissions } from '@erc725/erc725.js';
import LSP6_SCHEMA from '@erc725/erc725.js/schemas/LSP6KeyManager.json' assert { type: 'json' };
import {
  GAME_ENTRY_ADDRESS,
  VAULT_ADDRESS,
  WBSTR_TOKEN_ADDRESS,
  ZERO_ADDRESS,
  PRIZE_DISTRIBUTOR_ADDRESS,
  GAME_ENTRY_ABI,
  GAME_VAULT_ABI,
  PRIZE_DISTRIBUTOR_ABI,
  LSP7_MIN_ABI
} from './config.onchain.js';

const ZERO_HEX = '0x';
const KEY_MANAGER_FORBIDDEN_ERROR = '0xbb370b2b';
const ADDRESS_PERMISSIONS_ARRAY_KEY = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const ADDRESS_PERMISSIONS_ALLOWED_CALLS_PREFIX = '0x4b80742de2bf393a64c70000';
const ADDRESS_PERMISSIONS_PERMISSIONS_PREFIX = '0x4b80742de2bf393a64c70001';
const INTERFACE_ID_WILDCARD = '0xffffffff';
const CALLTYPE_VALUE = '0x00000002';
const AUTH_OPERATOR_SELECTOR_2ARGS = `0x${ethers.id('authorizeOperator(address,uint256)').slice(2, 10)}`;
const AUTH_OPERATOR_SELECTOR_3ARGS = `0x${ethers.id('authorizeOperator(address,uint256,bytes)').slice(2, 10)}`;
const DEFAULT_WBSTR_UNITS_PER_CHIP = 1000000000000000000000n; // 1000 WBSTR (18 decimals) per chip

const UNIVERSAL_PROFILE_ABI = [
  'function owner() view returns (address)',
  'function setData(bytes32 key, bytes value) external',
  'function setData(bytes32[] calldata keys, bytes[] calldata values) external',
  'function execute(uint256 operationType, address target, uint256 value, bytes data) external payable returns (bytes memory)'
];

const KEY_MANAGER_ABI = [
  'function execute(bytes calldata payload) external payable returns (bytes memory)'
];

// Internal: helpers to construct contracts
function getVaultContract(signerOrProvider) {
  return new ethers.Contract(VAULT_ADDRESS, GAME_VAULT_ABI, signerOrProvider);
}

function getGameEntryContract(signerOrProvider) {
  return new ethers.Contract(GAME_ENTRY_ADDRESS, GAME_ENTRY_ABI, signerOrProvider);
}

function getLsp7Contract(tokenAddress, signerOrProvider) {
  return new ethers.Contract(tokenAddress, LSP7_MIN_ABI, signerOrProvider);
}

// PrizeDistributor contract instance
export function getPrizeDistributor(signerOrProvider) {
  return new ethers.Contract(PRIZE_DISTRIBUTOR_ADDRESS, PRIZE_DISTRIBUTOR_ABI, signerOrProvider);
}

function normalizeTokenAddress(value) {
  if (!value) return ZERO_ADDRESS;
  try {
    return ethers.getAddress(value);
  } catch (_) {
    const str = String(value || '').trim();
    if (!str) return ZERO_ADDRESS;
    if (str === '0x0' || str === '0') return ZERO_ADDRESS;
    return str;
  }
}

function getProvider() {
  if (!window.ethereum && !window.lukso) throw new Error('No LUKSO provider found');
  const anyProv = window.lukso || window.ethereum;
  return new ethers.BrowserProvider(anyProv);
}

export async function getSigner() {
  // Prefer using the raw provider request first (more compatible with some UP wallets)
  const raw = (typeof window !== 'undefined') ? (window.lukso || window.ethereum) : undefined;
  if (!raw) throw new Error('No LUKSO provider found. Please install the Universal Profile extension.');
  try {
    const provider = new ethers.BrowserProvider(raw);
    // If we already have an address cached, return signer without prompting
    if (window.__upAddress) {
      return await provider.getSigner();
    }
    // Check existing accounts first to avoid popup
    let accounts = [];
    try { accounts = await provider.send('eth_accounts', []); } catch (_) { accounts = []; }
    if (!accounts || accounts.length === 0) {
      // Request accounts only if not connected
      try {
        if (typeof raw.request === 'function') {
          await raw.request({ method: 'eth_requestAccounts' });
        } else {
          await provider.send('eth_requestAccounts', []);
        }
      } catch (e) {
        throw e;
      }
    }
    return await provider.getSigner();
  } catch (e) {
    console.error('Failed to get signer:', e);
    throw e;
  }
}

// Convert Firestore string tableId -> on-chain uint256 tableId
// Strategy: if raw is numeric-like, use it; otherwise keccak256(utf8(raw)) as uint256
function toOnchainTableId(rawId) {
  try {
    return ethers.toBigInt(rawId);
  } catch (_) {
    const h = ethers.keccak256(ethers.toUtf8Bytes(String(rawId)));
    return ethers.toBigInt(h);
  }
}

function isUserRejectedError(err) {
  const code = err?.code || err?.error?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const message = String(err?.reason || err?.message || '').toLowerCase();
  return message.includes('user rejected') || message.includes('denied');
}

function isKeyManagerForbiddenError(err) {
  const data = err?.data || err?.error?.data;
  if (typeof data === 'string' && data.toLowerCase().startsWith(KEY_MANAGER_FORBIDDEN_ERROR)) {
    return true;
  }
  const reason = String(err?.reason || err?.error?.reason || err?.message || '').toLowerCase();
  if (!reason) return false;
  return reason.includes('key manager') || reason.includes('keymanager') || reason.includes('not allowed') || reason.includes('notauthorised') || reason.includes('lsp6');
}

async function safeLsp6GetData(lsp6, request) {
  try {
    const response = await lsp6.getData(request);
    if (response && Object.prototype.hasOwnProperty.call(response, 'value') && response.value === null) {
      return undefined;
    }
    return response;
  } catch (err) {
    const msg = err?.message || String(err ?? '');
    if (msg.includes('Cannot read properties of null') || msg.includes('Cannot read property') || msg.includes('Cannot read properties of undefined')) {
      return undefined;
    }
    throw err;
  }
}

function normalizeHex(value, length) {
  let hex = (value || '').toString().toLowerCase();
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (length && hex.length > length) {
    hex = hex.slice(hex.length - length);
  }
  if (length) {
    hex = hex.padStart(length, '0');
  } else if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return hex;
}

function ensureBytes4(value, fallback = '0x00000000') {
  if (!value && value !== 0) return fallback;
  let hex = typeof value === 'string' ? value : ethers.hexlify(value);
  if (!hex.startsWith('0x')) hex = `0x${hex}`;
  const trimmed = hex.slice(2).padStart(8, '0').slice(0, 8);
  return `0x${trimmed.toLowerCase()}`;
}

function decodeAllowedCalls(raw) {
  if (!raw || raw === ZERO_HEX) return [];
  if (Array.isArray(raw)) {
    return raw.map((tuple) => ({
      callType: ensureBytes4(tuple?.[0] ?? CALLTYPE_VALUE, CALLTYPE_VALUE),
      target: tuple?.[1] ? ethers.getAddress(tuple[1]) : ZERO_ADDRESS,
      functionSelector: ensureBytes4(tuple?.[2] ?? INTERFACE_ID_WILDCARD, INTERFACE_ID_WILDCARD),
      interfaceId: ensureBytes4(tuple?.[3] ?? INTERFACE_ID_WILDCARD, INTERFACE_ID_WILDCARD)
    }));
  }

  let hex = raw.toLowerCase();
  if (hex.startsWith('0x')) hex = hex.slice(2);
  const entries = [];
  let offset = 0;
  while (offset + 4 <= hex.length) {
    const lenHex = hex.slice(offset, offset + 4);
    const len = parseInt(lenHex, 16);
    if (!len || Number.isNaN(len)) {
      offset += 4;
      continue;
    }
    const start = offset + 4;
    const end = start + len * 2;
    if (end > hex.length) break;
    const body = hex.slice(start, end);
    const callType = ensureBytes4(`0x${body.slice(0, 8)}`, CALLTYPE_VALUE);
    const targetHex = `0x${body.slice(8, 48)}`;
    let target = ZERO_ADDRESS;
    try { target = ethers.getAddress(targetHex); } catch (_) {}
    const functionSelector = ensureBytes4(`0x${body.slice(48, 56)}`, INTERFACE_ID_WILDCARD);
    const interfaceId = ensureBytes4(`0x${body.slice(56, 64)}`, INTERFACE_ID_WILDCARD);
    entries.push({ callType, target, functionSelector, interfaceId });
    offset = end;
  }
  return entries;
}

function encodeAllowedCalls(entries) {
  if (!entries || !entries.length) return [];
  return entries.map((entry, idx) => {
    if (!entry) {
      throw new Error(`Invalid allowed call entry at index ${idx}`);
    }
    const callType = ensureBytes4(entry.callType ?? CALLTYPE_VALUE, CALLTYPE_VALUE);
    const interfaceId = ensureBytes4(entry.interfaceId ?? INTERFACE_ID_WILDCARD, INTERFACE_ID_WILDCARD);
    let normalizedTarget = ZERO_ADDRESS;
    if (entry.target) {
      normalizedTarget = ethers.getAddress(entry.target);
    }
    const functionSelector = ensureBytes4(entry.functionSelector ?? INTERFACE_ID_WILDCARD, INTERFACE_ID_WILDCARD);
    return {
      callType,
      target: normalizedTarget,
      functionSelector,
      interfaceId
    };
  });
}

function hasAllowedCall(entries, tokenAddress, selector) {
  if (!entries || !entries.length) return false;
  const target = ethers.getAddress(tokenAddress);
  const desiredSelector = ensureBytes4(selector, INTERFACE_ID_WILDCARD);
  return entries.some((entry) => {
    if (!entry || !entry.target) return false;
    try {
      if (ethers.getAddress(entry.target) !== target) return false;
    } catch (_) {
      return false;
    }
    const fnSelector = ensureBytes4(entry.functionSelector ?? INTERFACE_ID_WILDCARD, INTERFACE_ID_WILDCARD);
    if (fnSelector === INTERFACE_ID_WILDCARD) return true;
    return fnSelector === desiredSelector;
  });
}

function getActiveControllerAddress() {
  const account = window?.lukso?.selectedAccount || window?.lukso?.account || window?.lukso?.selectedController;
  if (!account) return undefined;
  const fields = [
    account.controllerAddress,
    account.controller,
    account.addressController,
    account.owner,
    account.controllerKey
  ];
  for (const value of fields) {
    if (!value) continue;
    try {
      return ethers.getAddress(value);
    } catch (_) {}
  }
  return undefined;
}

async function _handlePermissionFix({ signer, tokenAddress, authorizeInputs, controllerAddress }) {
  const provider = signer?.provider;
  if (!provider) {
    return {
      status: 'missing-provider',
      message: 'Automatic fix not possible because Ethereum provider is unavailable. Please reconnect your Universal Profile wallet.'
    };
  }

  const upAddress = await signer.getAddress();
  if (!upAddress) {
    return {
      status: 'missing-up-address',
      message: 'Unable to get Universal Profile address. Please try reconnecting the extension.'
    };
  }

  const upContract = new ethers.Contract(upAddress, UNIVERSAL_PROFILE_ABI, provider);
  let keyManagerAddress;
  try {
    keyManagerAddress = await upContract.owner();
  } catch (err) {
    console.warn('Unable to read Key Manager owner() from UP', err);
    return {
      status: 'no-key-manager',
      message: 'Universal Profile does not have a Key Manager address set. Please check your profile configuration in the extension.'
    };
  }

  if (!keyManagerAddress || keyManagerAddress === ZERO_ADDRESS) {
    return {
      status: 'no-key-manager',
      message: 'Universal Profile does not have a Key Manager address set. Please check your profile configuration in the extension.'
    };
  }

  const lsp6 = new ERC725(LSP6_SCHEMA, upAddress, provider);

  let controllers = [];
  try {
    const arrayRes = await safeLsp6GetData(lsp6, ADDRESS_PERMISSIONS_ARRAY_KEY);
    if (Array.isArray(arrayRes?.value)) {
      controllers = arrayRes.value.map((addr) => {
        try { return ethers.getAddress(addr); } catch (_) { return null; }
      }).filter(Boolean);
    } else if (typeof arrayRes?.value === 'string' && arrayRes.value) {
      try { controllers = [ethers.getAddress(arrayRes.value)]; } catch (_) { controllers = []; }
    }
  } catch (err) {
    console.warn('Failed to load AddressPermissions[] array', err);
  }

  let activeController = controllerAddress || getActiveControllerAddress();
  try {
    activeController = activeController ? ethers.getAddress(activeController) : null;
  } catch (_) {
    activeController = null;
  }

  const lowerSeen = new Set();
  controllers = controllers.filter((addr) => {
    const lower = addr.toLowerCase();
    if (lowerSeen.has(lower)) return false;
    lowerSeen.add(lower);
    return true;
  });

  if (activeController) {
    const activeLower = activeController.toLowerCase();
    if (!lowerSeen.has(activeLower)) {
      controllers.unshift(activeController);
      lowerSeen.add(activeLower);
    }
  }

  const targetController = activeController || controllers[0];

  if (!targetController) {
    return { status: 'no-controllers', message: 'Unable to determine the active controller in your Universal Profile.' };
  }

  let normalizedTokenAddress;
  try {
    normalizedTokenAddress = ethers.getAddress(tokenAddress);
  } catch (_) {
    normalizedTokenAddress = tokenAddress;
  }

  const selectorsToEnsure = [AUTH_OPERATOR_SELECTOR_2ARGS];
  if (authorizeInputs >= 3) selectorsToEnsure.push(AUTH_OPERATOR_SELECTOR_3ARGS);

  const controllerHex = normalizeHex(targetController, 40);
  const permissionsKey = `${ADDRESS_PERMISSIONS_PERMISSIONS_PREFIX}${controllerHex}`;
  const allowedCallsKey = `${ADDRESS_PERMISSIONS_ALLOWED_CALLS_PREFIX}${controllerHex}`;

  let permissions = {};
  try {
    const res = await safeLsp6GetData(lsp6, permissionsKey);
    if (res?.value) {
      permissions = decodePermissions(res.value) || {};
    }
  } catch (err) {
    console.warn(`Failed to decode permissions for controller ${targetController}`, err);
  }

  if (!permissions.SETDATA) {
    return {
      status: 'missing-setdata',
      controller: targetController,
      message: 'Automatic fix not possible because the active controller in Universal Profile does not have SETDATA permission. Please set permissions manually in the extension.'
    };
  }

  let permissionsChanged = false;
  if (!permissions.CALL) {
    permissions.CALL = true;
    permissionsChanged = true;
  }

  let allowedCalls = [];
  let allowedCallsChanged = false;
  try {
    const res = await safeLsp6GetData(lsp6, allowedCallsKey);
    allowedCalls = decodeAllowedCalls(res?.value);
  } catch (err) {
    console.warn(`Failed to decode allowed calls for controller ${targetController}`, err);
    allowedCalls = [];
  }

  for (const selector of selectorsToEnsure) {
    if (!hasAllowedCall(allowedCalls, normalizedTokenAddress, selector)) {
      allowedCalls.push({
        callType: CALLTYPE_VALUE,
        target: normalizedTokenAddress,
        functionSelector: selector,
        interfaceId: INTERFACE_ID_WILDCARD
      });
      allowedCallsChanged = true;
    }
  }

  if (allowedCallsChanged) {
    const deduped = [];
    const seen = new Set();
    for (const entry of allowedCalls) {
      if (!entry || !entry.target) continue;
      const key = `${entry.target.toLowerCase()}-${ensureBytes4(entry.functionSelector, INTERFACE_ID_WILDCARD)}-${ensureBytes4(entry.callType, CALLTYPE_VALUE)}-${ensureBytes4(entry.interfaceId, INTERFACE_ID_WILDCARD)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    allowedCalls = deduped;
  }

  const dataEntries = [];
  if (permissionsChanged) {
    dataEntries.push({ key: permissionsKey, value: encodePermissions(permissions) });
  }
  if (allowedCallsChanged) {
    dataEntries.push({ key: allowedCallsKey, value: encodeAllowedCalls(allowedCalls) });
  }

  if (!dataEntries.length) {
    return { status: 'no-changes-needed', controller: targetController };
  }

  let encoded;
  try {
    encoded = lsp6.encodeData(dataEntries);
  } catch (err) {
    console.error('Failed to encode permission updates via ERC725', err);
    return { status: 'encode-failed', error: err };
  }

  const keyManager = new ethers.Contract(keyManagerAddress, KEY_MANAGER_ABI, signer);
  const upInterface = new ethers.Interface(UNIVERSAL_PROFILE_ABI);
  const payload = upInterface.encodeFunctionData('setData', [encoded.keys, encoded.values]);

  try {
    const tx = await keyManager.execute(payload);
    const receipt = await tx.wait();
    return { status: 'fix-applied', receipt, controller: targetController };
  } catch (err) {
    if (isUserRejectedError(err)) {
      return { status: 'user-rejected', error: err };
    }
    if (isKeyManagerForbiddenError(err)) {
      return { status: 'forbidden', error: err };
    }
    console.error('Permission fix execute() failed', err);
    return { status: 'execute-failed', error: err };
  }
}


// LYX deposit: route through GameEntry.buyInLYX with msg.value = chips * unitsPerChip
export async function depositLyx(tableId, chips, unitMultiplier) {
  const signer = await getSigner();
  if (!signer) {
    throw new Error('Wallet not connected. Please connect your wallet first.');
  }
  if (!GAME_ENTRY_ADDRESS || GAME_ENTRY_ADDRESS === ZERO_ADDRESS) {
    throw new Error('GameEntry contract address is not configured.');
  }
  const vault = getVaultContract(signer);
  const entry = getGameEntryContract(signer);
  if (unitMultiplier == null) {
    unitMultiplier = await vault.smallestUnitsPerChip(ethers.ZeroAddress);
  }
  const onchainId = toOnchainTableId(tableId);
  const chipsBn = ethers.toBigInt(String(chips));
  const unitsPerChip = ethers.toBigInt(String(unitMultiplier));
  const value = unitsPerChip * chipsBn;
  try {
    const tx = await entry.buyInLYX(onchainId, { value });
    const rc = await tx.wait();
    
    // Track table ID for later withdrawal
    const playerAddr = await signer.getAddress();
    trackTableId(tableId, playerAddr);
    
    return rc;
  } catch (e) {
    const msg = e?.reason || e?.message || 'buyInLYX failed';
    throw new Error(msg);
  }
}

// Part 2: Intelligent WBSTR deposit flow with automatic permission repair for Universal Profiles.
export async function depositWbstr(
  tableId,
  chips,
  unitMultiplier,
  tokenAddress = WBSTR_TOKEN_ADDRESS,
  authorizeMultiplier = 10n,
  options = {}
) {
  const { onStatus } = options || {};
  const notify = (code, detail) => {
    if (typeof onStatus === 'function') {
      try {
        onStatus(code, detail);
      } catch (err) {
        console.warn('depositWbstr onStatus handler raised:', err);
      }
    }
  };

  notify('checking-permissions');

  const signer = await getSigner();
  if (!tokenAddress || tokenAddress === ZERO_ADDRESS) {
    throw new Error('WBSTR token address is not configured.');
  }

  const lsp7 = getLsp7Contract(tokenAddress, signer);
  const vault = getVaultContract(signer);
  const entry = getGameEntryContract(signer);

  if (unitMultiplier == null) {
    unitMultiplier = await vault.smallestUnitsPerChip(tokenAddress);
  }

  // Preflight: ensure vault allows this token to be deposited.
  try {
    const allowed = await vault.isTokenAllowed(tokenAddress);
    if (!allowed) {
      throw new Error('WBSTR token is currently not allowed by the GameVault. Please ask the operator to enable it on-chain (setTokenAllowed).');
    }
  } catch (_) {
    // ignore if the method isn't present on older vaults
  }

  const chipsBn = ethers.toBigInt(String(chips));
  let unitsPerChip = ethers.toBigInt(String(unitMultiplier));
  try {
    const normalizedToken = tokenAddress ? ethers.getAddress(tokenAddress).toLowerCase() : null;
    const wbstrNormalized = WBSTR_TOKEN_ADDRESS ? ethers.getAddress(WBSTR_TOKEN_ADDRESS).toLowerCase() : null;
    if (normalizedToken && wbstrNormalized && normalizedToken === wbstrNormalized && unitsPerChip <= 1n) {
      unitsPerChip = DEFAULT_WBSTR_UNITS_PER_CHIP;
    }
  } catch (_) {
    // If normalization fails, continue with existing multiplier value
  }
  const amount = unitsPerChip * chipsBn;
  const onchainId = toOnchainTableId(tableId);
  const fromAddr = await signer.getAddress();

  // Basic sanity: make sure the connected account actually has WBSTR to cover the deposit.
  const provider = signer.provider;
  if (!provider) {
    throw new Error('Signer is missing a provider instance. Please reconnect your wallet.');
  }
  const code = await provider.getCode(fromAddr);
  const isUniversalProfile = !!code && code !== ZERO_HEX;

  let currentBalance = 0n;
  try {
    currentBalance = await lsp7.balanceOf(fromAddr);
  } catch (_) {
    currentBalance = 0n;
  }
  if (currentBalance < amount) {
    const hint = isUniversalProfile
      ? 'Insufficient WBSTR balance on selected Universal Profile. Switch to a profile with WBSTR tokens or top up your balance.'
      : 'Insufficient WBSTR balance on selected EOA account. Switch to a Universal Profile with WBSTR or transfer tokens to this account.';
    throw new Error(hint);
  }

  let authMult = authorizeMultiplier;
  if (typeof authMult === 'number') {
    authMult = BigInt(Math.max(1, Math.floor(authMult)));
  }
  if (typeof authMult !== 'bigint' || authMult < 1n) {
    authMult = 10n;
  }
  const targetAuth = amount * authMult;

  const authorizeWithDataFn = lsp7['authorizeOperator(address,uint256,bytes)'];
  const authorizeSimpleFn = lsp7['authorizeOperator(address,uint256)'] || lsp7.authorizeOperator?.bind(lsp7);
  const authorizeInputs = authorizeWithDataFn ? 3 : 2;

  const callAuthorize = async () => {
    if (authorizeWithDataFn) {
      return authorizeWithDataFn(GAME_ENTRY_ADDRESS, targetAuth, ZERO_HEX);
    }
    if (!authorizeSimpleFn) {
      throw new Error('authorizeOperator function is not available on the selected token contract.');
    }
    return authorizeSimpleFn(GAME_ENTRY_ADDRESS, targetAuth);
  };

  const hasSufficientAuthorization = async () => {
    try {
      if (typeof lsp7.authorizedAmountFor === 'function') {
        const already = await lsp7.authorizedAmountFor(GAME_ENTRY_ADDRESS, fromAddr);
        if (already != null) {
          const big = typeof already === 'bigint' ? already : BigInt(already);
          if (big >= amount) return true;
        }
      }
    } catch (_) {}
    try {
      if (typeof lsp7.isOperatorFor === 'function') {
        const res = await lsp7.isOperatorFor(GAME_ENTRY_ADDRESS, fromAddr);
        if (typeof res === 'boolean') return res;
        if (res != null) {
          const val = typeof res === 'bigint' ? res : BigInt(res);
          return val >= amount;
        }
      }
    } catch (_) {}
    return false;
  };

  let permissionFixStatus = null;

  if (await hasSufficientAuthorization()) {
    console.log('Operator already authorized for sufficient amount, skipping authorizeOperator.');
    notify('already-authorized');
  } else {
    try {
      console.log(`Authorizing GameEntry (${GAME_ENTRY_ADDRESS}) as operator for ${targetAuth.toString()} of ${tokenAddress}`);
      notify('authorize-operator', { tokenAddress, targetAuth });
      const tx = await callAuthorize();
      await tx.wait();
      console.log('Operator authorized.');
      notify('operator-authorized');
    } catch (err) {
      if (isKeyManagerForbiddenError(err)) {
        console.warn('authorizeOperator blocked by Key Manager. Attempting automated permission fix…');
        notify('permission-fix-start', { error: err });
        const controllerAddress = getActiveControllerAddress();
  const fixResult = await _handlePermissionFix({ signer, tokenAddress, authorizeInputs, controllerAddress });
  permissionFixStatus = fixResult || null;

        if (fixResult?.status === 'fix-applied') {
          console.log('Permission fix applied. Retrying authorizeOperator…');
          notify('permission-fix-applied', fixResult);
          try {
            const retryTx = await callAuthorize();
            await retryTx.wait();
            console.log('Operator authorized after permission fix.');
            notify('operator-authorized');
          } catch (retryErr) {
            if (isUserRejectedError(retryErr)) {
              throw new Error('User rejected the authorizeOperator retry. Please confirm the request and try again.');
            }
            const msg = retryErr?.reason || retryErr?.message || 'authorizeOperator retry failed.';
            throw new Error(`authorizeOperator still failed after automatic permission fix: ${msg}`);
          }
        } else if (fixResult?.status === 'missing-setdata') {
          const manualMessage = fixResult?.message || 'The active controller in your Universal Profile does not have SETDATA permission, so automatic permission fix is not possible.';
          throw new Error(manualMessage);
        } else if (fixResult?.status === 'user-rejected') {
          throw new Error('Permission fix was rejected. Please approve the request in your extension and try again.');
        } else if (fixResult?.status === 'forbidden') {
          throw new Error('Key Manager still rejects the transaction even after the fix attempt. Please set permissions manually in the Universal Profile extension.');
        } else if (fixResult?.status === 'no-changes-needed') {
          console.warn('Permission fix reported no changes needed, yet authorizeOperator failed. Escalating to manual guidance.');
          const normalizedTokenAddress = (() => {
            try { return ethers.getAddress(tokenAddress); } catch (_) { return tokenAddress; }
          })();
          throw new Error(`Universal Profile rejects authorizeOperator. Please manually add CALL permission and Allowed Call for ${normalizedTokenAddress} in the extension.`);
        } else if (fixResult?.status === 'missing-provider' || fixResult?.status === 'missing-up-address' || fixResult?.status === 'no-key-manager') {
          throw new Error('Automatic permission fix not available (could not access Key Manager). Please set permissions manually in the Universal Profile extension.');
        } else if (fixResult?.status === 'execute-failed' || fixResult?.status === 'encode-failed') {
          const msg = fixResult?.error?.reason || fixResult?.error?.message || 'unknown error';
          throw new Error(`Automatic permission fix failed (${msg}). Please set permissions manually and try again.`);
        } else if (fixResult?.message) {
          throw new Error(fixResult.message);
        } else {
          const normalizedTokenAddress = (() => {
            try { return ethers.getAddress(tokenAddress); } catch (_) { return tokenAddress; }
          })();
          const steps = [
            'Universal Profile rejected the authorizeOperator transaction.',
            'Open the LUKSO extension → "Manage controllers".',
            'Select the active controller (the account you are using in the browser) and enable CALL permission.',
            `In the Allowed Calls section, add the WBSTR contract (${normalizedTokenAddress}) and include the authorizeOperator function (or Allow All).`,
            'Save settings, confirm all pending signatures, and then retry the deposit.'
          ].join('\n');
          throw new Error(steps);
        }
      } else {
        if (isUserRejectedError(err)) {
          throw new Error('User rejected the authorizeOperator transaction.');
        }
        const uiMsg = err?.reason || err?.message || 'Authorization failed';
        throw new Error(`Failed to obtain GameEntry permission for WBSTR. Please confirm the request in your wallet and try again. (${uiMsg})`);
      }
    }
  }

  // 2) Deposit into the vault. This will require a second wallet confirmation.
  let buyInPermissionFixStatus = null;
  try {
    let amountDescription = `${amount.toString()} units`;
    try {
      const normalizedToken = tokenAddress ? ethers.getAddress(tokenAddress) : null;
      const wbstrNormalized = WBSTR_TOKEN_ADDRESS ? ethers.getAddress(WBSTR_TOKEN_ADDRESS) : null;
      if (normalizedToken && wbstrNormalized && normalizedToken === wbstrNormalized) {
        const formatted = ethers.formatUnits(amount, 18);
        amountDescription = `${amount.toString()} units (~${formatted} WBSTR)`;
      }
    } catch (_) {
      // ignore formatting issues and keep fallback description
    }
    console.log(`Depositing ${amountDescription} (${chipsBn.toString()} chips) via GameEntry for table ${tableId}`);
    notify('depositing', { amount, tableId });
    
    const executeBuyIn = async () => {
      return await entry.buyInLSP7(tokenAddress, onchainId, amount);
    };
    
    let tx2;
    try {
      tx2 = await executeBuyIn();
    } catch (buyInErr) {
      // Check if KeyManager blocked the call
      if (isKeyManagerForbiddenError(buyInErr)) {
        console.warn('buyInLSP7 blocked by Key Manager. Attempting automated permission fix…');
        notify('permission-fix-start', { error: buyInErr });
        const controllerAddress = getActiveControllerAddress();
        // buyInLSP7(address,uint256,uint256) has 3 inputs
        const fixResult = await _handlePermissionFix({ 
          signer, 
          tokenAddress: GAME_ENTRY_ADDRESS,  // target is GameEntry, not token
          authorizeInputs: 3,  // buyInLSP7 selector
          controllerAddress 
        });
        buyInPermissionFixStatus = fixResult || null;

        if (fixResult?.status === 'fix-applied') {
          console.log('Permission fix applied. Retrying buyInLSP7…');
          notify('permission-fix-applied', fixResult);
          try {
            tx2 = await executeBuyIn();
          } catch (retryErr) {
            if (isUserRejectedError(retryErr)) {
              throw new Error('User rejected the buyInLSP7 retry. Please confirm the request and try again.');
            }
            const msg = retryErr?.reason || retryErr?.message || 'buyInLSP7 retry failed.';
            throw new Error(`buyInLSP7 still failed after automatic permission fix: ${msg}`);
          }
        } else if (fixResult?.status === 'missing-setdata') {
          const manualMessage = fixResult?.message || 'The active controller in your Universal Profile does not have SETDATA permission, so automatic permission fix is not possible.';
          throw new Error(manualMessage);
        } else if (fixResult?.status === 'user-rejected') {
          throw new Error('Permission fix was rejected. Please approve the request in your extension and try again.');
        } else if (fixResult?.status === 'forbidden') {
          throw new Error('Key Manager still rejects buyInLSP7 even after the fix attempt. Please set permissions manually in the Universal Profile extension.');
        } else {
          const normalizedGameEntry = (() => {
            try { return ethers.getAddress(GAME_ENTRY_ADDRESS); } catch (_) { return GAME_ENTRY_ADDRESS; }
          })();
          const steps = [
            'Universal Profile rejected the buyInLSP7 transaction.',
            'Open the LUKSO extension → "Manage controllers".',
            'Select the active controller and enable CALL permission.',
            `In the Allowed Calls section, add the GameEntry contract (${normalizedGameEntry}) and include the buyInLSP7 function (selector: 0xb1a142f6).`,
            'Save settings, confirm all pending signatures, and then retry the deposit.'
          ].join('\n');
          throw new Error(steps);
        }
      } else {
        if (isUserRejectedError(buyInErr)) {
          throw new Error('User rejected the buyInLSP7 transaction.');
        }
        const uiMsg = buyInErr?.reason || buyInErr?.message || 'Buy-in failed';
        throw new Error(`WBSTR deposit via GameEntry failed: ${uiMsg}`);
      }
    }
    
    const receipt = await tx2.wait();
    console.log('Buy-in successful.');
    
    // Track table ID for later withdrawal
    const playerAddr = await signer.getAddress();
    trackTableId(tableId, playerAddr);
    
    notify('success', { receipt, permissionFixStatus: permissionFixStatus || buyInPermissionFixStatus });
    return {
      status: 'success',
      receipt,
      permissionFixStatus: permissionFixStatus || buyInPermissionFixStatus
    };
  } catch (e) {
    console.error('Error during `buyInLSP7`:', e);
    throw new Error(`WBSTR deposit via GameEntry failed: ${e.message || e}`);
  }
}

// Read how much is authorized for the connected user on a given token
export async function getAuthorizedPayout(tokenAddress, userAddress) {
  const provider = getProvider();
  const pd = getPrizeDistributor(provider);
  let addr = userAddress;
  if (!addr) {
    const signer = await provider.getSigner();
    addr = await signer.getAddress();
  }
  const amt = await pd.authorizedPayouts(tokenAddress || ZERO_ADDRESS, addr);
  return amt; // ethers v6 BigInt
}

// Claim prize for a given token (LYX = ZERO_ADDRESS, LSP7 = token address)
export async function claimPrize(tokenAddress) {
  const signer = await getSigner();
  const pd = getPrizeDistributor(signer);
  const normalized = normalizeTokenAddress(tokenAddress);
  const tx = await pd.claimPrize(normalized);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error('Claim transaction failed on-chain');
  }
  return { txHash: tx.hash, receipt };
}

// Claim multiple tokens in one tx (uses PD.claimMultiple)
export async function claimMultiple(tokenAddresses) {
  const signer = await getSigner();
  const pd = getPrizeDistributor(signer);
  const unique = new Set();
  const arr = [];
  for (const token of tokenAddresses || []) {
    const normalized = normalizeTokenAddress(token);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    arr.push(normalized);
  }
  if (!arr.length) throw new Error('No token addresses provided');
  const tx = await pd.claimMultiple(arr);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error('Claim-all transaction failed on-chain');
  }
  return { txHash: tx.hash, receipt };
}

// Helper: default token list (LYX + WBSTR if configured)
export function getDefaultPrizeTokens() {
  const list = [ZERO_ADDRESS];
  if (WBSTR_TOKEN_ADDRESS && WBSTR_TOKEN_ADDRESS !== ZERO_ADDRESS) list.push(WBSTR_TOKEN_ADDRESS);
  return list;
}

// New: Fetch wallet balances for LYX and WBSTR
export async function getBalances(userAddress) {
  const provider = getProvider();
  let addr = userAddress;
  if (!addr) {
    try { const s = await provider.getSigner(); addr = await s.getAddress(); } catch (_) {}
  }
  if (!addr) throw new Error('No address available');
  // LYX balance
  const lyx = await provider.getBalance(addr);
  // WBSTR balance (+decimals if available)
  let wbstr = 0n;
  let wbstrDecimals = 18;
  try {
    const lsp7 = getLsp7Contract(WBSTR_TOKEN_ADDRESS, provider);
    try { const d = await lsp7.decimals(); wbstrDecimals = Number(d); } catch (_) { wbstrDecimals = 18; }
    wbstr = await lsp7.balanceOf(addr);
  } catch (_) {
    // If WBSTR not configured or call fails, keep zeros
  }
  return { address: addr, lyx, wbstr, wbstrDecimals };
}

/**
 * Get player's locked balance in GameVault for a specific table
 * @param {number|string} tableId - The onchain table ID (can be string or BigInt)
 * @param {string} playerAddress - Player's address
 * @param {string} tokenAddress - Token address (use ZERO_ADDRESS for LYX)
 * @returns {Promise<bigint>} Locked balance
 */
export async function getVaultBalance(tableId, playerAddress, tokenAddress = ZERO_ADDRESS) {
  const provider = getProvider();
  const vault = getVaultContract(provider);
  const normalizedToken = normalizeTokenAddress(tokenAddress);
  // Ensure tableId is BigInt (handle both string and number safely)
  const tableIdBigInt = typeof tableId === 'string' ? BigInt(tableId) : BigInt(tableId);
  const balance = await vault.balanceOf(tableIdBigInt, playerAddress, normalizedToken);
  return balance;
}

/**
 * Withdraw player's locked balance from GameVault
 * Requires PrizeDistributor authorization
 * @param {number|string} tableId - The onchain table ID (can be string or BigInt)
 * @param {string} tokenAddress - Token address (use ZERO_ADDRESS for LYX)
 * @param {bigint} amount - Amount to withdraw
 * @returns {Promise<{txHash: string}>}
 */
export async function withdrawFromVault(tableId, tokenAddress, amount) {
  console.log('🏦 withdrawFromVault called:', { tableId, tokenAddress, amount: amount.toString() });
  const signer = await getSigner();
  const vault = getVaultContract(signer);
  const normalizedToken = normalizeTokenAddress(tokenAddress);
  
  // Ensure tableId is BigInt (handle both string and number safely)
  const tableIdBigInt = typeof tableId === 'string' ? BigInt(tableId) : BigInt(tableId);
  
  console.log('📝 Calling vault.withdraw with:', { tableId: tableIdBigInt.toString(), normalizedToken, amount: amount.toString() });
  const tx = await vault.withdraw(tableIdBigInt, normalizedToken, amount);
  console.log('✅ Withdraw transaction sent:', tx.hash);
  console.log('✅ Withdraw transaction sent:', tx.hash);
  
  await tx.wait();
  console.log('✅ Withdraw transaction confirmed:', tx.hash);
  
  return { txHash: tx.hash };
}

/**
 * Helper: Track table IDs where player has deposited funds
 * Stored in localStorage for claim withdrawal purposes
 */
function trackTableId(tableId, playerAddress) {
  if (!playerAddress || !tableId) return;
  try {
    const onchainId = toOnchainTableId(tableId).toString(); // BigInt to string (safe)
    const key = `poker_tables_${playerAddress.toLowerCase()}`;
    const existing = localStorage.getItem(key);
    const tables = existing ? JSON.parse(existing) : [];
    
    // Store both IDs for easy lookup
    const exists = tables.find(t => t.firestoreId === tableId || t.onchainId === onchainId);
    if (!exists) {
      tables.push({ firestoreId: tableId, onchainId });
      localStorage.setItem(key, JSON.stringify(tables));
    }
  } catch (err) {
    console.warn('Failed to track table ID:', err);
  }
}

/**
 * Get list of table IDs where player has deposited
 */
export function getPlayerTableIds(playerAddress) {
  if (!playerAddress) return [];
  try {
    const key = `poker_tables_${playerAddress.toLowerCase()}`;
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    
    const parsed = JSON.parse(stored);
    
    // MIGRATION: Convert old string array to new object array
    if (parsed.length > 0 && typeof parsed[0] === 'string') {
      console.log('🔄 Migrating old table ID format...');
      const migrated = parsed.map(id => ({
        firestoreId: id,
        onchainId: toOnchainTableId(id).toString() // BigInt to string (safe)
      }));
      localStorage.setItem(key, JSON.stringify(migrated));
      return migrated;
    }
    
    return parsed;
  } catch (err) {
    console.warn('Failed to get player table IDs:', err);
    return [];
  }
}