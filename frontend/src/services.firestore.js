// Simple Firestore helpers for poker app
import { db } from './firebase.js';
import { WBSTR_TOKEN_ADDRESS } from './config.onchain.js';
// Re-export WBSTR address; provide an undefined placeholder for deprecated multiplier constant
export { WBSTR_TOKEN_ADDRESS };
// Security rules require a unitMultiplier field on table creation.
// We don't rely on its value on the client (actual on-chain multipliers are queried at deposit time),
// so default to a sentinel string 'auto' to satisfy rules.
export const LSP7_UNIT_MULTIPLIER = 'auto';
import { getFunctionsBase, isProdMode } from './env.js';
import {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
  updateDoc,
  setDoc,
  onSnapshot,
  deleteDoc,
  increment,
} from 'firebase/firestore';

const tablesCol = collection(db, 'tables');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const leaderboardsCol = collection(db, 'leaderboards');
const leaderboardsWeeklyCol = collection(db, 'leaderboards_weekly');
const leaderboardsMonthlyCol = collection(db, 'leaderboards_monthly');

// WBSTR address and multiplier are imported from on-chain config which reads deployments/{env}.json

// tokenAddress: '0x...' (ZERO_ADDRESS => LYX)
// unitMultiplier: string representing multiplier from chips -> smallest unit (e.g., '10000000000000000' for LYX)
export async function createTable({ name = null, host, maxPlayers, sb, bb, stack, tokenAddress = WBSTR_TOKEN_ADDRESS, unitMultiplier = LSP7_UNIT_MULTIPLIER, isPrivate = false, mode = 'public', aiDifficulty = null, rakePct = null, stakeCap = null, hostId, buyin, startAt, type = 'cash', minPlayers = 2, minChips = 0 }) {
  // Ensure all required data is present
  if (!hostId) {
    throw new Error('hostId is required for table creation');
  }

  const payload = {
    name: (name && String(name).trim()) || null,
    host: String(host || ''),
    hostId: String(hostId),
    // numeric coercions
    maxPlayers: Number(maxPlayers || 2),
    sb: Number(sb || 0),
    bb: Number(bb || 0),
    stack: Number(stack || 0),
  tokenAddress: String(tokenAddress || WBSTR_TOKEN_ADDRESS),
  // Always include unitMultiplier to satisfy security rules; client ignores actual value
  unitMultiplier: String(unitMultiplier ?? 'auto'),
    minChips: Math.max(0, Number(minChips||0)),
    status: 'waiting',
    createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
    players: 0,
    buyin: Number(buyin || 0),
    startAt: startAt || null,
  // preserve visibility/mode and optional ai metadata
  isPrivate: Boolean(isPrivate),
  mode: String(mode || 'public'),
  aiDifficulty: aiDifficulty || null,
  rakePct: typeof rakePct === 'number' ? rakePct : null,
  stakeCap: typeof stakeCap === 'number' ? stakeCap : null,
  type: String(type || 'cash'),
  minPlayers: Number(minPlayers || 2),
  };

  // Client-side validation to match security rules and give clearer errors
  if (!payload.host || payload.host.length === 0) throw new Error('host is required');
  if (!Number.isFinite(payload.maxPlayers) || payload.maxPlayers < 2 || payload.maxPlayers > 9) throw new Error('maxPlayers must be a number between 2 and 9');
  if (!Number.isFinite(payload.sb) || payload.sb <= 0) throw new Error('sb must be a number > 0');
  if (!Number.isFinite(payload.bb) || payload.bb <= payload.sb) throw new Error('bb must be a number > sb');
  if (!Number.isFinite(payload.stack) || payload.stack <= 0) throw new Error('stack must be a number > 0');
  // Accept integer string or number-like values for unitMultiplier
  if (payload.unitMultiplier != null && !/^[0-9]+$/.test(String(payload.unitMultiplier))) throw new Error('unitMultiplier must be an integer string representing the smallest-unit multiplier');
  if (!Number.isFinite(payload.buyin) || payload.buyin < 0) throw new Error('buyin must be a number >= 0');
  // Log payload for debugging of security rule failures (remove in production)
  try {
    console.debug('[createTable] payload:', payload);
    const ref = await addDoc(tablesCol, payload);
  // update created doc with server timestamp for authoritative createdAt/updatedAt
  try { await updateDoc(doc(db, 'tables', ref.id), { updatedAt: Timestamp.now() }); } catch (_) {}
    return { id: ref.id, ...payload };
  } catch (err) {
    // Surface Firestore error details in console to diagnose rules rejection
    // Print full error object (some fields can be nested)
    console.error('[createTable] Firestore addDoc failed (full error):', err);
    // Make payload JSON-friendly for console (convert Timestamps)
    try {
      const printable = { ...payload };
      if (printable.createdAt && typeof printable.createdAt.toDate === 'function') {
        printable.createdAt = printable.createdAt.toDate().toISOString();
      }
      console.error('[createTable] payload at failure (printable):', printable);
    } catch (e) {
      console.error('[createTable] failed to serialize payload', e, payload);
    }
    throw err;
  }
}

// Helper: host auto-joins waiting room players subcollection
export async function joinOnCreate(tableId, { name, address }) {
  const tableRef = doc(db, 'tables', tableId);
  const playersColRef = collection(tableRef, 'players');
  const payload = { name, address: address || null, role: 'host', status: 'seated', createdAt: Timestamp.now() };
  const ref = await addDoc(playersColRef, payload);
  // Maintain aggregate players count on table (allowed by security rules during waiting)
  try { await updateDoc(tableRef, { players: increment(1) }); } catch (_) {}
  return { id: ref.id, ...payload };
}

export async function listOpenTables() {
  // Tables are created with status 'waiting' per security rules
  // Only list public (non-private) waiting tables
  const q = query(tablesCol, where('status', '==', 'waiting'), where('isPrivate', '==', false), orderBy('createdAt', 'desc'), limit(20));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listActiveTables() {
  const q = query(tablesCol, where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(20));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Realtime: subscribe to active tables (joinable mid-hand for cash when seats available)
export function subscribeActiveTables(callback, limitN = 20) {
  const q = query(tablesCol, where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(limitN));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(list); } catch (e) { console.error('active tables callback error', e); }
    },
    (err) => {
      console.error('active tables onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

// Realtime: subscribe to open tables list (returns unsubscribe)
export function subscribeOpenTables(callback, limitN = 20) {
  // Tables are considered "open" while in 'waiting' state
  const q = query(tablesCol, where('status', '==', 'waiting'), orderBy('createdAt', 'desc'), limit(limitN));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(list); } catch (e) { console.error('tables callback error', e); }
    },
    (err) => {
      console.error('tables onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

export async function getTable(tableId) {
  const ref = doc(db, 'tables', tableId);
  const s = await getDoc(ref);
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function joinTable(tableId) {
  const ref = doc(db, 'tables', tableId);
  const s = await getDoc(ref);
  if (!s.exists()) throw new Error('Table does not exist');
  const data = s.data();
  const players = (data.players || 0) + 1;
  await updateDoc(ref, { players });
  return { id: tableId, ...data, players };
}

// Waiting room: subscribe to players subcollection for a specific table
export function subscribeTablePlayers(tableId, callback, limitN = 9) {
  const playersCol = collection(doc(db, 'tables', tableId), 'players');
  const q = query(playersCol, orderBy('createdAt', 'asc'), limit(limitN));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(list); } catch (e) { console.error('waiting players cb error', e); }
    },
    (err) => {
      console.error('subscribeTablePlayers error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

// Add/remove a player doc to a specific table (and maintain aggregate count)
export async function addPlayerToTable(tableId, { name, address, role = 'player' }) {
  const tableRef = doc(db, 'tables', tableId);
  const tableSnap = await getDoc(tableRef);
  const tableData = tableSnap.exists() ? tableSnap.data() : null;
  const playersCol = collection(tableRef, 'players');
  // Player status is crucial for game logic on the backend
  // IMPORTANT: Only include fields allowed by security rules
  // Allowed keys: ['name','address','role','status','action','actionAt','betAmount','createdAt']
  const payload = { name, address: address || null, role, status: 'seated', createdAt: Timestamp.now() };
  const ref = await addDoc(playersCol, payload);
  // Maintain aggregate players count on table
  // Only update aggregate during waiting state (security rules restrict this)
  try {
    if (tableData && tableData.status === 'waiting') {
      await updateDoc(tableRef, { players: increment(1) });
    }
  } catch (_) {}
  return { id: ref.id, ...payload };
}

// One-time fetch of seated/playing players for capacity checks
export async function listTablePlayers(tableId, limitN = 100) {
  const playersColRef = collection(doc(db, 'tables', tableId), 'players');
  const qy = query(playersColRef, orderBy('createdAt', 'asc'), limit(limitN));
  const snap = await getDocs(qy);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function removePlayerFromTable(tableId, playerDocId) {
  const tableRef = doc(db, 'tables', tableId);
  const playerRef = doc(db, 'tables', tableId, 'players', playerDocId);
  await deleteDoc(playerRef);
  // Best-effort: if no host remains and table is still waiting, delete the table client-side (backend also enforces cleanup)
  try {
    const tSnap = await getDoc(tableRef);
    if (tSnap.exists()) {
      const t = tSnap.data();
      if (t.status === 'waiting') {
        const playersColRef = collection(tableRef, 'players');
        const hostSnap = await getDocs(query(playersColRef, where('role','==','host'), limit(1)));
        if (hostSnap.empty) {
          // Delete waiting table; subcollections cleaned on backend as well
          await deleteDoc(tableRef);
        }
      }
    }
  } catch (_) {}
}

// Player signals they want to leave the table during a game
export async function signalLeaveGame(tableId, playerDocId) {
  const playerRef = doc(db, 'tables', tableId, 'players', playerDocId);
  // A backend function will observe this status change and handle the logic:
  // - The player folds for the rest of the hand.
  // - At the end of the hand, their remaining stack is authorized for payout.
  await updateDoc(playerRef, { status: 'leaving' });
}

// Subscribe to a single table doc for status/host changes
export function subscribeTable(tableId, callback) {
  const ref = doc(db, 'tables', tableId);
  return onSnapshot(
    ref,
    (snap) => {
      const val = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      try { callback(val); } catch (e) { console.error('subscribeTable cb error', e); }
    },
    (err) => {
      console.error('subscribeTable error', err);
      try { callback(null); } catch (_) {}
    }
  );
}

// --- Chat APIs ---
export function subscribeTableChat(tableId, callback, limitN = 50) {
  const col = collection(doc(db, 'tables', tableId), 'chat');
  const qy = query(col, orderBy('createdAt', 'asc'), limit(limitN));
  return onSnapshot(
    qy,
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(list); } catch (e) { console.error('chat cb error', e); }
    },
    (err) => {
      console.error('subscribeTableChat error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

export async function addChatMessage(tableId, { author, address = null, text }) {
  const col = collection(doc(db, 'tables', tableId), 'chat');
  const payload = { author, address, text, createdAt: Timestamp.now() };
  const ref = await addDoc(col, payload);
  return { id: ref.id, ...payload };
}

// --- Game Play Functions ---

// A player makes an action (e.g., 'fold', 'check', 'bet', 'call', 'raise')
export async function playerAction(tableId, playerDocId, action, amount = 0) {
    const playerRef = doc(db, 'tables', tableId, 'players', playerDocId);
    const payload = {
        action,
        // timestamp for backend to verify it's a recent action
  actionAt: Timestamp.now()
    };
    if (amount > 0) {
        payload.betAmount = amount;
    }
    // This is a "command" pattern. The backend function will listen for changes
    // on the player document and process the game logic.
    await updateDoc(playerRef, payload);
}

// Subscribe to the central game state for a specific table.
// The backend function is responsible for creating and updating this document.
export function subscribeGameState(tableId, callback) {
    const ref = doc(db, 'tables', tableId, 'game', 'state');
    return onSnapshot(
        ref,
        (snap) => {
            const val = snap.exists() ? snap.data() : null;
            try { callback(val); } catch (e) { console.error('subscribeGameState cb error', e); }
        },
        (err) => {
            console.error('subscribeGameState error', err);
            try { callback(null); } catch (_) {}
        }
    );
}

export async function startTable(tableId) {
  const ref = doc(db, 'tables', tableId);
  // Security rules expect transition from 'waiting' -> 'active'
  // Two-step start: set table to 'starting' so clients are prompted to pay buy-in
  // Backend will verify deposits and transition to 'active' when ready.
  const paymentWindowSec = 60;
  await updateDoc(ref, { status: 'starting', startingAt: Timestamp.now(), paymentWindowSec });
}

// --- AI helpers ---

export async function addBotsToTable(tableId, count = 1, { difficulty = 'easy' } = {}) {
  const bots = [];
  for (let i = 0; i < Math.max(0, Math.min(8, count)); i++) {
    // Use deterministic bot names
    const name = `Bot ${i + 1}`;
    // difficulty stored per bot for backend policy if needed
    // mark as bot: true for backend auto-actor
  // NOTE: Security rules restrict allowed fields on create; use role:'bot' only.
  const added = await addPlayerToTable(tableId, { name, address: null, role: 'bot' });
    bots.push(added);
  }
  return bots;
}

export function mapDifficultyToRake(difficulty) {
  const d = String(difficulty || '').toLowerCase();
  if (d === 'hard') return 35;
  if (d === 'medium') return 15;
  return 5; // easy default
}

export async function createAiTable({ host, hostId, maxPlayers, sb, bb, stack, bots = 1, difficulty = 'easy', stakeCap = null }) {
  const rakePct = mapDifficultyToRake(difficulty);
  const created = await createTable({
    host,
  hostId,
    maxPlayers,
    sb,
    bb,
    stack,
    tokenAddress: WBSTR_TOKEN_ADDRESS,
  unitMultiplier: undefined,
    isPrivate: true,
    mode: 'ai',
    aiDifficulty: difficulty,
    rakePct,
    stakeCap,
  });
  // Auto-seat the host as a player too
  let hostPlayer = null;
  try { hostPlayer = await addPlayerToTable(created.id, { name: host || 'UP', address: null, role: 'host' }); } catch (_) {}
  await addBotsToTable(created.id, bots, { difficulty });
  return { ...created, hostPlayerId: hostPlayer?.id || null };
}

// --- Pay & Play helpers for AI flow ---
// Creates a starting AI table (status 'starting') and returns tableId + hostPlayerId
export async function startAiGameCreate({ difficulty = 'easy', buyin = 0, tokenAddress = WBSTR_TOKEN_ADDRESS, unitMultiplier = undefined, hostAddress, hostName, bots }) {
  // If running against local emulator, call the functions emulator directly to avoid hosting rewrite 404s
  const isLocal = (typeof window !== 'undefined' && (window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.host.includes('127.0.0.1') || (window.__firebase_emulator_host_for_debugging__ && window.__firebase_emulator_host_for_debugging__.includes('127.0.0.1')))));
  // projectId used for emulator functions URL (matches firebaseConfig.projectId)
  const projectId = (typeof window !== 'undefined' && window.firebaseConfig && window.firebaseConfig.projectId) ? window.firebaseConfig.projectId : 'poker-4683e';
  // For local testing always use the emulator endpoint
  const endpoint = `${getFunctionsBase()}/startAiGame`;
  const body = { step: 'create', difficulty, buyin, tokenAddress, unitMultiplier, hostAddress: (hostAddress || '').toLowerCase(), hostName, bots };
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`startAiGameCreate failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// Confirms on-chain deposit and activates the AI table
export async function startAiGameConfirm({ tableId, txHash, hostAddress, buyin }) {
  const isLocal = (typeof window !== 'undefined' && (window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || (window.__firebase_emulator_host_for_debugging__ && window.__firebase_emulator_host_for_debugging__.includes('127.0.0.1')))));
  const projectId = (typeof window !== 'undefined' && window.firebaseConfig && window.firebaseConfig.projectId) ? window.firebaseConfig.projectId : 'poker-4683e';
  // For local testing always use the emulator endpoint
  const endpoint = `${getFunctionsBase()}/startAiGame`;
  const body = { step: 'confirm', tableId, txHash, hostAddress: (hostAddress || '').toLowerCase(), buyin };
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) {
    let message = `Deposit confirmation failed (HTTP ${res.status}).`;
    try {
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.error) {
        message = data.error;
        if (data.details) {
          const details = data.details;
          const bits = [];
          if (details.expectedChips != null && details.matchedChips != null) {
            bits.push(`Zahtevanih ${details.expectedChips} žetonov, transakcija je prinesla ${details.matchedChips}.`);
          }
          if (details.reminder) bits.push(details.reminder);
          if (bits.length) message = `${message} ${bits.join(' ')}`.trim();
        }
      }
    } catch (_) {
      if (raw) message = `Deposit confirmation failed: ${raw}`;
    }
    throw new Error(message);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

export async function recordLeaderboardEntry({ user, chipsWon }) {
  // upsert user totals
  const userRef = doc(leaderboardsCol, user);
  const now = serverTimestamp();
  const cur = await getDoc(userRef);
  if (cur.exists()) {
    const prev = cur.data();
    await setDoc(userRef, { user, chipsWon: (prev.chipsWon || 0) + chipsWon, updatedAt: now }, { merge: true });
  } else {
    await setDoc(userRef, { user, chipsWon, createdAt: now, updatedAt: now });
  }
}

export async function topLeaderboard(limitN = 10) {
  // P2E leaderboard ordered by points (desc)
  const q = query(leaderboardsCol, orderBy('points', 'desc'), limit(limitN));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Realtime: subscribe to top leaderboard (returns unsubscribe)
export function subscribeTopLeaderboard(callback, limitN = 10) {
  // P2E leaderboard ordered by points (desc)
  const q = query(leaderboardsCol, orderBy('points', 'desc'), limit(limitN));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(rows); } catch (e) { console.error('leaderboard callback error', e); }
    },
    (err) => {
      console.error('leaderboard onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

// Weekly leaderboard helpers
export async function topLeaderboardWeekly(periodKey, limitN = 10) {
  const q = query(
    leaderboardsWeeklyCol,
    where('period', '==', periodKey),
    orderBy('points', 'desc'),
    limit(limitN)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export function subscribeTopLeaderboardWeekly(callback, periodKey, limitN = 10) {
  const q = query(
    leaderboardsWeeklyCol,
    where('period', '==', periodKey),
    orderBy('points', 'desc'),
    limit(limitN)
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(rows); } catch (e) { console.error('leaderboard weekly cb error', e); }
    },
    (err) => {
      console.error('leaderboard weekly onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

// Monthly leaderboard helpers
export async function topLeaderboardMonthly(periodKey, limitN = 10) {
  const q = query(
    leaderboardsMonthlyCol,
    where('period', '==', periodKey),
    orderBy('points', 'desc'),
    limit(limitN)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export function subscribeTopLeaderboardMonthly(callback, periodKey, limitN = 10) {
  const q = query(
    leaderboardsMonthlyCol,
    where('period', '==', periodKey),
    orderBy('points', 'desc'),
    limit(limitN)
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      try { callback(rows); } catch (e) { console.error('leaderboard monthly cb error', e); }
    },
    (err) => {
      console.error('leaderboard monthly onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}

// === NEW PLAYER STATS LEADERBOARD (Play vs PC) ===
const playerStatsCol = collection(db, 'playerStats');

export function subscribePlayerStatsByCategory(category, callback, limitN = 20) {
  // category can be: 'wins', 'totalRewards', 'totalVolume', 'gamesPlayed'
  const fieldMap = {
    'wins': 'wins',
    'rewards': 'totalRewards',
    'volume': 'totalVolume',
    'games': 'gamesPlayed'
  };
  
  const orderField = fieldMap[category] || 'wins';
  
  const q = query(
    playerStatsCol,
    orderBy(orderField, 'desc'),
    limit(limitN)
  );
  
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(d => ({ address: d.id, ...d.data() }));
      try { callback(rows); } catch (e) { console.error('playerStats callback error', e); }
    },
    (err) => {
      console.error('playerStats onSnapshot error', err);
      try { callback([]); } catch (_) {}
    }
  );
}
