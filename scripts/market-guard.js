// ══════════════════════════════════════════════════════════════════════════════
// market-guard.js — News-shock & market-dip protection layer
//
// Five layers, all configurable via repo vars (all have safe defaults):
//
//   Layer 1 — BTC short-term change guard
//     BTC drops fast → block buys, or close all live positions
//     Uses btcChg15m from market.global (written by market-fetcher.js)
//
//   Layer 2 — Portfolio circuit breaker
//     Total unrealised P&L across all live positions < -CIRCUIT_BREAKER_PCT
//     → close everything immediately regardless of individual stops
//
//   Layer 3 — Fear & Greed buy gate
//     F&G < FEAR_BLOCK_THRESHOLD (default 20) → block all buys
//     F&G < FEAR_REDUCE_THRESHOLD (default 25) → halve position size
//     Written to market.global by market-fetcher.js each Job A run
//
//   Layer 4 — Volatility-based position sizing
//     If recent BTC candle range > VOLATILITY_REDUCE_PCT → reduce size
//     Uses btcVolatility from market.global
//
//   Layer 5 — Time blackout windows
//     Block new buys during configurable UTC hour ranges
//     (e.g. US market open 13:30-14:30 UTC on high-volatility days)
//     Defaults to no blackout — opt-in only
//
// Returns are always structured so callers can log exactly WHY a gate fired.
// ══════════════════════════════════════════════════════════════════════════════

// ── Tunable env vars (all optional — defaults are conservative but not paranoid) ──
const BTC_WARN_PCT         = parseFloat(process.env.GUARD_BTC_WARN_PCT         || '-2');   // BTC 15m drop % → block new buys
const BTC_CLOSE_PCT        = parseFloat(process.env.GUARD_BTC_CLOSE_PCT        || '-3');   // BTC 15m drop % → close ALL live positions
const CIRCUIT_BREAKER_PCT  = parseFloat(process.env.GUARD_CIRCUIT_BREAKER_PCT  || '-5');   // portfolio unrealised P&L % → close all
const FEAR_BLOCK_THRESHOLD = parseFloat(process.env.GUARD_FEAR_BLOCK           || '20');   // F&G ≤ this → block all buys
const FEAR_REDUCE_THRESHOLD= parseFloat(process.env.GUARD_FEAR_REDUCE          || '25');   // F&G ≤ this → halve position size
const VOLATILITY_REDUCE_PCT= parseFloat(process.env.GUARD_VOLATILITY_REDUCE_PCT|| '4');    // BTC candle range % → halve size
const BLACKOUT_WINDOWS     = (process.env.GUARD_BLACKOUT_WINDOWS || '').split(',').filter(Boolean);
// GUARD_BLACKOUT_WINDOWS format: "13:30-14:30,20:00-20:30" (UTC, comma-separated)
// Leave empty (default) = no blackout

// ── Layer 1 — BTC short-term change ──
export function checkBtcGuard(global = {}) {
  const btcChg15m = global.btcChg15m ?? null;

  if (btcChg15m === null) return { pass: true, reason: null }; // no data yet — don't block

  if (btcChg15m <= BTC_CLOSE_PCT) return {
    pass:          false,
    closeAll:      true,
    reason:        `BTC 15m: ${btcChg15m.toFixed(2)}% ≤ ${BTC_CLOSE_PCT}% — market panic, closing all positions`,
    level:         'PANIC',
  };

  if (btcChg15m <= BTC_WARN_PCT) return {
    pass:          false,
    closeAll:      false,
    reason:        `BTC 15m: ${btcChg15m.toFixed(2)}% ≤ ${BTC_WARN_PCT}% — BTC dropping, blocking new buys`,
    level:         'WARN',
  };

  return { pass: true, reason: null };
}

// ── Layer 2 — Portfolio circuit breaker ──
export function checkCircuitBreaker(positions = {}) {
  const livePositions = Object.values(positions).filter(
    p => p.liveOrder?.mode === 'live'
      && !p.liveOrder?.closedAt
      && !['stopped', 'tp1_hit', 'tp2_hit', 'exiting'].includes(p.status)
      && p.liveOrder?.fillPrice
      && p.entryPrice
  );

  if (!livePositions.length) return { pass: true, reason: null, totalPnlPct: null };

  // Simple average P&L across all live positions — not dollar-weighted
  // (since all positions use equal TRADE_USD_SIZE, simple avg is correct)
  const pnls = livePositions.map(p => {
    const entry = parseFloat(p.liveOrder.fillPrice || p.entryPrice || 0);
    const curr  = parseFloat(p.exitPrice || p.entryPrice || 0); // best current price we have
    return entry > 0 ? (curr - entry) / entry * 100 : 0;
  });

  const avgPnl = pnls.reduce((s, v) => s + v, 0) / pnls.length;

  if (avgPnl <= CIRCUIT_BREAKER_PCT) return {
    pass:         false,
    closeAll:     true,
    reason:       `Circuit breaker: avg live P&L ${avgPnl.toFixed(2)}% ≤ ${CIRCUIT_BREAKER_PCT}% — closing all positions`,
    totalPnlPct:  avgPnl,
    level:        'CIRCUIT_BREAKER',
    affected:     livePositions.map(p => p.base),
  };

  return { pass: true, reason: null, totalPnlPct: avgPnl };
}

// ── Layer 3 — Fear & Greed ──
// Returns a regime descriptor rather than a hard pass/fail — the caller
// (leaderboard-decider.js candidate loop) decides per-symbol whether the
// candidate's own divergence overrides the fear regime.
//
// Divergence override: if F&G ≤ FEAR_BLOCK_THRESHOLD but the symbol is
// rising while BTC is falling, that's real relative strength — allow it
// at reduced size (25% — meaningful position, not a full bet in a fear regime).
// A symbol that is ALSO falling during fear gets blocked regardless.
export function checkFearGreed(global = {}) {
  const fg = global.fearGreed ?? null;

  if (fg === null) return { pass: true, sizeMult: 1, fearRegime: false, reason: null };

  if (fg <= FEAR_BLOCK_THRESHOLD) return {
    pass:        true,           // NOT a hard block — per-symbol divergence check in caller
    sizeMult:    0.25,           // reduced if allowed through
    fearRegime:  true,           // signals: only let diverging symbols through
    btcChg:      global.btcChg15m ?? global.btcChg24h ?? null,
    reason:      `Fear & Greed: ${fg} (Extreme Fear) — only symbols diverging from BTC allowed at 25% size`,
    level:       'EXTREME_FEAR',
  };

  if (fg <= FEAR_REDUCE_THRESHOLD) return {
    pass:        true,
    sizeMult:    0.5,
    fearRegime:  false,          // fear but not extreme — no divergence check needed
    reason:      `Fear & Greed: ${fg} (Fear) — halving position size`,
    level:       'FEAR',
  };

  return { pass: true, sizeMult: 1, fearRegime: false, reason: null };
}

// ── Divergence check — used by leaderboard-decider.js candidate loop ──
// Returns true if the candidate is showing positive divergence vs BTC:
// symbol chg > 0 AND btcChg < 0. If btcChg is unknown, allow through
// (don't block on missing data).
export function isDivergingFromBtc(candidateChg, btcChg) {
  if (btcChg === null || btcChg === undefined) return true; // no BTC data — don't block
  return (candidateChg > 0) && (btcChg < 0);
}

// ── Layer 4 — Volatility-based position sizing ──
export function checkVolatility(global = {}) {
  const btcVolatility = global.btcVolatility ?? null; // recent candle range % from market-fetcher

  if (btcVolatility === null) return { sizeMult: 1, reason: null };

  if (btcVolatility >= VOLATILITY_REDUCE_PCT) return {
    sizeMult: 0.5,
    reason:   `BTC candle range ${btcVolatility.toFixed(2)}% ≥ ${VOLATILITY_REDUCE_PCT}% — high volatility, halving position size`,
    level:    'HIGH_VOLATILITY',
  };

  return { sizeMult: 1, reason: null };
}

// ── Layer 5 — Time blackout windows (UTC) ──
export function checkTimeBlackout() {
  if (!BLACKOUT_WINDOWS.length) return { pass: true, reason: null };

  const now  = new Date();
  const hhmm = now.getUTCHours() * 60 + now.getUTCMinutes();

  for (const window of BLACKOUT_WINDOWS) {
    const [startStr, endStr] = window.trim().split('-');
    if (!startStr || !endStr) continue;
    const [sh, sm] = startStr.split(':').map(Number);
    const [eh, em] = endStr.split(':').map(Number);
    const start    = (sh || 0) * 60 + (sm || 0);
    const end      = (eh || 0) * 60 + (em || 0);
    if (hhmm >= start && hhmm < end) return {
      pass:   false,
      reason: `Time blackout: ${window} UTC — blocking new buys`,
      level:  'BLACKOUT',
    };
  }

  return { pass: true, reason: null };
}

// ══════════════════════════════════════════════════════════════════════════════
// runAllBuyGuards — convenience wrapper used by leaderboard-decider.js
// Returns { canBuy, closeAll, sizeMult, fearRegime, btcChg, reasons[] }
//
// canBuy:     false → skip all buys this cycle (BTC panic / blackout)
// closeAll:   true  → close all live MEXC positions before doing anything else
// sizeMult:   0-1   → multiply TRADE_USD_SIZE by this (1 = full size)
// fearRegime: true  → F&G ≤ 20 — caller must check per-symbol divergence
// btcChg:     BTC 15m change % (for divergence check in caller)
// reasons:    list of strings explaining every gate that fired
// ══════════════════════════════════════════════════════════════════════════════
export function runAllBuyGuards(market, positions) {
  const global     = market.global || {};
  const reasons    = [];
  let   canBuy     = true;
  let   closeAll   = false;
  let   sizeMult   = 1;
  let   fearRegime = false;
  const btcChg     = global.btcChg15m ?? null;

  // Layer 1 — BTC
  const btc = checkBtcGuard(global);
  if (!btc.pass) {
    canBuy = false;
    reasons.push(btc.reason);
    if (btc.closeAll) closeAll = true;
  } else if (btcChg !== null && btcChg <= BTC_WARN_PCT) {
    // BTC in warn range but a diverging symbol may still pass —
    // apply a size reduction even for those (BTC stress = smaller bet)
    sizeMult = Math.min(sizeMult, 0.5);
    reasons.push(`BTC 15m: ${btcChg.toFixed(2)}% — reducing size to 50% for any diverging buys`);
  }

  // Layer 2 — Circuit breaker
  const cb = checkCircuitBreaker(positions);
  if (!cb.pass) {
    closeAll = true;
    canBuy   = false;
    reasons.push(cb.reason);
  }

  // Layer 3 — F&G (sets fearRegime flag, no longer a hard canBuy block)
  const fg = checkFearGreed(global);
  if (fg.fearRegime) {
    fearRegime = true;
    sizeMult   = Math.min(sizeMult, fg.sizeMult); // 0.25 in extreme fear
    reasons.push(fg.reason);
  } else if (fg.sizeMult < 1) {
    sizeMult = Math.min(sizeMult, fg.sizeMult);   // 0.5 in normal fear
    if (fg.reason) reasons.push(fg.reason);
  }

  // Layer 4 — Volatility (size reduction only)
  const vol = checkVolatility(global);
  if (vol.sizeMult < 1) {
    sizeMult = Math.min(sizeMult, vol.sizeMult);
    reasons.push(vol.reason);
  }

  // Layer 5 — Time blackout
  const time = checkTimeBlackout();
  if (!time.pass) {
    canBuy = false;
    reasons.push(time.reason);
  }

  return { canBuy, closeAll, sizeMult, fearRegime, btcChg, reasons };
}
