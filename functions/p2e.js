// P2E scoring helpers for reuse in runtime and offline backtests

function getISOWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const weekNo = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  const yyyy = date.getUTCFullYear();
  const ww = String(weekNo).padStart(2, '0');
  return `${yyyy}-W${ww}`;
}
function getMonthKey(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function computeHandPoints({ wager = 0, wonAdd = 0, tokenUsed = 'lyx', allowedWbstr = '' }) {
  const isWBSTR = allowedWbstr && String(tokenUsed || '').toLowerCase() === String(allowedWbstr).toLowerCase();
  const tokenMult = isWBSTR ? 1.5 : 1.0;
  const net = (wonAdd || 0) - (wager || 0);
  let pts = 0;
  pts += (wager || 0) * 1.0;
  if (net > 0) pts += net * 0.5;
  if ((wager || 0) > 0) pts += 1; // activity point
  return Math.max(0, Math.floor(pts * tokenMult));
}

module.exports = {
  getISOWeekKey,
  getMonthKey,
  computeHandPoints,
};
