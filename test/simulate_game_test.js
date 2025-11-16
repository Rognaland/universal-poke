const assert = require('assert');

// Simple deterministic seeded RNG (LCG) for reproducible behavior when needed
function createRng(seed = 123456789) {
  let state = BigInt(seed);
  const modulus = BigInt(2) ** BigInt(64);
  const a = BigInt(6364136223846793005);
  const c = BigInt(1442695040888963407);
  return () => {
    state = (a * state + c) % modulus;
    // return float in [0,1)
    return Number(state % BigInt(1e9)) / 1e9;
  };
}

// Game difficulty configs
const DIFFICULTIES = {
  easy: { bonusRate: 0.10 },
  medium: { bonusRate: 0.20 },
  hard: { bonusRate: 0.50 }
};

// Single-hand simulation function that applies win or loss
// balances is an object { house: number, player: number }
function simulateHand({ balances, wager, difficulty, outcome }) {
  const cfg = DIFFICULTIES[difficulty];
  if (!cfg) throw new Error('Unknown difficulty ' + difficulty);
  const bonusRate = cfg.bonusRate;

  if (outcome === 'lose') {
    // player loses wager -> house gains wager
    if (balances.player < wager) throw new Error('Player has insufficient funds to wager');
    balances.player -= wager;
    balances.house += wager;
    return { transferredToHouse: wager, transferredToPlayer: 0 };
  }

  if (outcome === 'win') {
    // house pays wager + bonus to player
    const bonus = Math.floor(wager * bonusRate);
    const payout = wager + bonus; // principal returned + bonus
    if (balances.house < payout) throw new Error('House has insufficient funds to pay out');
    balances.house -= payout;
    balances.player += payout;
    return { transferredToHouse: 0, transferredToPlayer: payout, bonus };
  }

  throw new Error('Unknown outcome ' + outcome);
}

async function runTests() {
  console.log('Starting deterministic simulate_game_test...');
  const rng = createRng(42424242); // not used here but available for expansion

  const initialHouse = 1000;
  const initialPlayer = 100;
  const wager = 10;

  for (const diff of Object.keys(DIFFICULTIES)) {
    // Test loss case
    const balancesLoss = { house: initialHouse, player: initialPlayer };
    const resLoss = simulateHand({ balances: balancesLoss, wager, difficulty: diff, outcome: 'lose' });
    console.log(`[${diff}] LOSS -> transferredToHouse=${resLoss.transferredToHouse}, balances: house=${balancesLoss.house}, player=${balancesLoss.player}`);
    assert.strictEqual(resLoss.transferredToHouse, wager, 'Loss transfer amount mismatch');
    assert.strictEqual(balancesLoss.house, initialHouse + wager, 'House balance should increase by wager on loss');
    assert.strictEqual(balancesLoss.player, initialPlayer - wager, 'Player balance should decrease by wager on loss');

    // Test win case
    const balancesWin = { house: initialHouse, player: initialPlayer };
    const resWin = simulateHand({ balances: balancesWin, wager, difficulty: diff, outcome: 'win' });
    console.log(`[${diff}] WIN -> transferredToPlayer=${resWin.transferredToPlayer}, bonus=${resWin.bonus || 0}, balances: house=${balancesWin.house}, player=${balancesWin.player}`);
    const expectedBonus = Math.floor(wager * DIFFICULTIES[diff].bonusRate);
    const expectedPayout = wager + expectedBonus;
    assert.strictEqual(resWin.transferredToPlayer, expectedPayout, 'Payout amount mismatch');
    assert.strictEqual(resWin.bonus, expectedBonus, 'Bonus mismatch');
    assert.strictEqual(balancesWin.house, initialHouse - expectedPayout, 'House should decrease by payout on win');
    assert.strictEqual(balancesWin.player, initialPlayer + expectedPayout, 'Player should increase by payout on win');
  }

  console.log('All simulate_game_test checks passed.');
}

runTests().catch((err) => {
  console.error('simulate_game_test failed:', err);
  process.exit(2);
});
