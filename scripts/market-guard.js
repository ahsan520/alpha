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
//   Layer 6 — BTC 4H market-regime buy gate (Phase 1)
//     BTC's own 4H bias is BEAR/LEAN BEAR → skip new buys entirely
//     (~95-99% of altcoins tend to follow BTC in sustained downtrends).
//     NEW-BUY GATE ONLY — never touches existing positions' exits.
//     STOP_LOSS_PCT always closes a hit stop unconditionally regardless
//     of this gate. See checkBtcRegimeGate() below. On by default
//     (GUARD_BTC_BUY_GATE=true); a future-reserved stop-override flag
//     (GUARD_BTC_STOP_OVERRIDE) exists in config but is NOT wired into
//     any exit logic yet — disabled by default, Phase 2+ work.
//
// Returns are always structured so callers can log exactly WHY a gate fired.
// ══════════════════════════════════════════════════════════════════════════════

// ── Tunable env vars (all optional — defaults are conservative but not paranoid) ──
const BTC_CLOSE_PCT        = parseFloat(process.env.GUARD_BTC_CLOSE_PCT        || '-3');   // BTC 15m drop % → close ALL live positions (hard gate, unchanged)
const CIRCUIT_BREAKER_PCT  = parseFloat(process.env.GUARD_CIRCUIT_BREAKER_PCT  || '-5');   // portfolio unrealised P&L % → close all
const FEAR_BLOCK_THRESHOLD = parseFloat(process.env.GUARD_FEAR_BLOCK           || '20');   // F&G ≤ this → divergence-only hard gate (unchanged, NOT a sizing input)
const BLACKOUT_WINDOWS     = (process.env.GUARD_BLACKOUT_WINDOWS || '').split(',').filter(Boolean);
// GUARD_BLACKOUT_WINDOWS format: "13:30-14:30,20:00-20:30" (UTC, comma-separated)
// Leave empty (default) = no blackout

// ── Continuous sizing curve endpoints (replace old discrete cliffs) ──
// Each guard now returns a sizeMult that scales SMOOTHLY between a "no
// concern" point (mult = 1) and a "max concern" point (mult = floor for
// that layer), instead of jumping in fixed steps. See lerpMult() below.
const FEAR_FULL_FG          = parseFloat(process.env.GUARD_FEAR_FULL_FG          || '25');  // F&G ≥ this → no fear-based cut (100%)
const FEAR_REDUCED_MULT     = parseFloat(process.env.GUARD_FEAR_REDUCED_MULT      || '0.5'); // F&G between FEAR_BLOCK_THRESHOLD and FEAR_FULL_FG (21-24) → flat size cut (not a gradient — explicit spec)
const FEAR_EXTREME_MULT     = parseFloat(process.env.GUARD_FEAR_EXTREME_MULT      || '0.25'); // F&G ≤ FEAR_BLOCK_THRESHOLD (Extreme Fear, ≤20) → separate, lower flat cut

const BTC_FULL_PCT          = parseFloat(process.env.GUARD_BTC_FULL_PCT          || '-0.5'); // BTC 15m chg ≥ this → no BTC-based cut
const BTC_FLOOR_PCT         = parseFloat(process.env.GUARD_BTC_FLOOR_PCT         || '-3');   // BTC 15m chg ≤ this → BTC layer at its floor (matches close threshold)
const BTC_FLOOR_MULT        = parseFloat(process.env.GUARD_BTC_FLOOR_MULT        || '0.2');  // BTC layer's own floor

// ── Layer 6 — BTC 4H market-regime buy gate (Phase 1 of the BTC Market
// Regime Filter proposal) ──
// Distinct from Layer 1 (BTC_CLOSE_PCT etc.) above: that layer reacts to
// FAST, short-term BTC moves (15m % change) as a panic/volatility signal.
// This layer reacts to BTC's own SLOWER 4H trend bias (bias4h field,
// already computed for every symbol including BTC — see
// market-fetcher.js's global.btcBias4h) as a market-regime filter: when
// the broader market (proxied by BTC) is in a sustained 4H downtrend,
// skip new buys entirely, since ~95-99% of altcoins tend to follow BTC
// during sustained bearish trends.
//
// This is a NEW BUY gate only — it does not touch existing open
// positions' exits (see GUARD_BTC_STOP_OVERRIDE below, disabled by
// default, reserved for a future phase). STOP_LOSS_PCT continues to
// close positions unconditionally, exactly as before — this gate never
// overrides or delays a stop-loss.
const BTC_BUY_GATE          = (process.env.GUARD_BTC_BUY_GATE || 'true') !== 'false';
const BTC_BEAR_VALUES       = (process.env.GUARD_BTC_BEAR_VALUES || 'BEAR 4H,LEAN BEAR')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── BTC Stop Override — DISABLED BY DEFAULT, reserved for a future phase ──
// When (eventually) enabled, this would let a hit stop-loss continue
// holding rather than close immediately, UNLESS BTC itself is bearish —
// see STOP_OVERRIDE_MAX_LOSS_PCT below for the hard ceiling that would
// always apply regardless. NOT wired into any exit logic yet in this
// phase — present here only so the config surface exists ahead of time.
// STOP_LOSS_PCT (leaderboard-decider.js etc.) is UNAFFECTED by this flag
// and always closes a position the moment its stop is hit, full stop.
const BTC_STOP_OVERRIDE           = (process.env.GUARD_BTC_STOP_OVERRIDE || 'false') === 'true';
const STOP_OVERRIDE_MAX_LOSS_PCT  = parseFloat(process.env.GUARD_STOP_OVERRIDE_MAX_LOSS_PCT || '1.5');

// Returns { blocked, reason } — used by the buy-scan gate, NOT by rotation
// or exits. BTC's own bias fields come from market.global (written once
// per fetch cycle by market-fetcher.js), so this is a cheap in-memory
// check, no extra API calls.
export function checkBtcRegimeGate(global = {}) {
  if (!BTC_BUY_GATE) return { blocked: false, reason: null };
  const bias4h = global.btcBias4h;
  if (!bias4h) return { blocked: false, reason: null }; // no data yet — don't block on missing data
  const isBear = BTC_BEAR_VALUES.some(v => bias4h.includes(v));
  if (!isBear) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason: `BTC 4H bias is ${bias4h} — new buys paused (market-regime gate)`,
  };
}

// ── Phase 2 — Alpha Exception ──
// When Layer 6 above blocks new buys for BTC-bearish reasons, a candidate
// can still be allowed through if it independently clears ALL of these
// conditions simultaneously — real relative strength strong enough to be
// worth a bet even against the broader market regime, not just noise.
// Each REQUIRE_* flag can be individually turned off (e.g. if the
// candidate's own bias4h shouldn't matter, only whale/volume/CVD) —
// default is all required, matching the design proposal's "all
// conditions satisfied" wording.
const ALPHA_EXCEPTION_ENABLED   = (process.env.GUARD_BTC_ALLOW_ALPHA_EXCEPTION || 'true') !== 'false';
const ALPHA_SCORE_MIN           = parseFloat(process.env.GUARD_BTC_ALPHA_SCORE_MIN        || '8');
const ALPHA_MIN_WHALE           = parseFloat(process.env.GUARD_BTC_ALPHA_MIN_WHALE        || '70');
const ALPHA_MIN_VOLUME          = parseFloat(process.env.GUARD_BTC_ALPHA_MIN_VOLUME       || '1.8');
const ALPHA_REQUIRE_OI_CONFIRM  = (process.env.GUARD_BTC_ALPHA_REQUIRE_OI_CONFIRM  || 'true') !== 'false';
const ALPHA_REQUIRE_POSITIVE_CVD= (process.env.GUARD_BTC_ALPHA_REQUIRE_POSITIVE_CVD|| 'true') !== 'false';
const ALPHA_REQUIRE_EMA_ABOVE   = (process.env.GUARD_BTC_ALPHA_REQUIRE_EMA_ABOVE   || 'true') !== 'false';
const ALPHA_REQUIRE_4H_BULL     = (process.env.GUARD_BTC_ALPHA_REQUIRE_4H_BULL     || 'true') !== 'false';
const ALPHA_REQUIRE_DAILY_BULL  = (process.env.GUARD_BTC_ALPHA_REQUIRE_DAILY_BULL  || 'false') === 'true';

// How many of the FLEXIBLE checks (4H bull bias, daily bull bias, EMA
// above, OI confirm, positive CVD) must pass, out of however many of
// them are individually enabled via the REQUIRE_* flags above. Demanding
// all 5 simultaneously (the original design) proved too strict in
// practice — a genuinely strong setup rarely clears every one of these
// 5 secondary trend/confirmation signals at once, even when the core
// strength signals (whale, volume, score, bullConf) are clearly there.
// whale/volume/score/bullConf/persistence remain UNCONDITIONALLY
// required regardless of this setting — only the 5 checks in the
// "flexible" group below are affected.
const ALPHA_FLEXIBLE_MIN_PASS   = parseInt(process.env.GUARD_BTC_ALPHA_FLEXIBLE_MIN_PASS || '3', 10);

// ── 4H trend persistence (reduces false signals from short-lived flips) ──
// bull4hCount is maintained by market-fetcher.js (see buildEntry) — this
// file only CONSUMES it, never recalculates or increments it, per spec:
// the scanner/fetcher is the single source of truth for the count itself.
//
// Two independent thresholds: a looser one for regular buys, a stricter
// one for the Alpha Exception (since bypassing a BTC-bearish regime
// warrants a higher bar of confirmed persistence, not just the same
// bar as a normal buy).
const BUY_REQUIRE_BULL4H_COUNT      = (process.env.BUY_REQUIRE_BULL4H_COUNT || 'true') !== 'false';
const BUY_BULL4H_COUNT_MIN          = parseInt(process.env.BUY_BULL4H_COUNT_MIN || '2', 10);
const BTC_ALPHA_REQUIRE_BULL4H_COUNT= (process.env.BTC_ALPHA_REQUIRE_BULL4H_COUNT || 'true') !== 'false';
const BTC_ALPHA_BULL4H_COUNT_MIN    = parseInt(process.env.BTC_ALPHA_BULL4H_COUNT_MIN || '3', 10);

// Regular-buy persistence check — independent of the BTC regime gate
// entirely. Called for EVERY candidate on EVERY buy attempt (not just
// when BTC is bearish), to filter out a bias4h reading that only just
// flipped to "BULL 4H" this cycle and may reverse next cycle. Returns
// {allowed, count} rather than throwing/blocking directly, so the caller
// decides how to log/skip.
export function checkBull4hPersistence(entry) {
  if (!BUY_REQUIRE_BULL4H_COUNT) return { allowed: true, count: entry?.bull4hCount ?? 0 };
  const count = entry?.bull4hCount ?? 0;
  return { allowed: count >= BUY_BULL4H_COUNT_MIN, count };
}


// Returns { allowed, failedChecks[], passedChecks[] } — call ONLY when
// checkBtcRegimeGate() has already blocked (no reason to run this
// otherwise). `entry` is the same per-symbol evaluated object
// leaderboard-decider.js already has in its candidate loop (entry.d,
// entry.whale, entry.bullConf, entry.conv — all fields already computed
// by leaderboard-scanner.js, nothing new needed here).
export function checkBtcAlphaException(entry) {
  if (!ALPHA_EXCEPTION_ENABLED) return { allowed: false, failedChecks: ['alpha exception disabled'], passedChecks: [] };

  const d          = entry.d || {};
  const whaleScore = entry.whale?.score ?? 0;
  const bullConf   = entry.bullConf ?? 0;
  const conv       = entry.conv ?? 0;
  const shock      = d.shock ?? 0;
  const bull4hCount = entry.bull4hCount ?? 0;

  // ── Core checks — UNCONDITIONALLY required, no N-of-M leniency here.
  // These are the strongest, most predictive signals; loosening these
  // specifically would undermine the whole point of the exception.
  const coreChecks = [
    { name: `Volume shock ≥${ALPHA_MIN_VOLUME}x`, pass: shock >= ALPHA_MIN_VOLUME },
    { name: `Whale ≥${ALPHA_MIN_WHALE}`,          pass: whaleScore >= ALPHA_MIN_WHALE },
    { name: `Score ≥${ALPHA_SCORE_MIN}`,          pass: conv >= ALPHA_SCORE_MIN },
    { name: `BullConf ≥7`,                        pass: bullConf >= 7 },
    ...(BTC_ALPHA_REQUIRE_BULL4H_COUNT
      ? [{ name: `4H persistence ≥${BTC_ALPHA_BULL4H_COUNT_MIN} cycles`, pass: bull4hCount >= BTC_ALPHA_BULL4H_COUNT_MIN }]
      : []),
  ];

  // ── Flexible checks — only ALPHA_FLEXIBLE_MIN_PASS of whichever of
  // these are individually enabled (via their own REQUIRE_* flag) need
  // to actually pass. A REQUIRE_*=false flag removes that check from
  // the pool entirely (same as before) rather than counting it as an
  // automatic pass or fail.
  const flexibleChecks = [
    ALPHA_REQUIRE_4H_BULL      ? { name: '4H bull bias',    pass: (d.bias4h  || '').includes('BULL') } : null,
    ALPHA_REQUIRE_DAILY_BULL   ? { name: 'Daily bull bias', pass: (d.biasDay || '').includes('BULL') } : null,
    ALPHA_REQUIRE_EMA_ABOVE    ? { name: 'EMA above',       pass: d.emaTrend === 'ABOVE' } : null,
    ALPHA_REQUIRE_OI_CONFIRM   ? { name: 'OI confirm',      pass: d.oiDiv === 'CONFIRM' || d.oiDiv === 'DIP BUY' } : null,
    ALPHA_REQUIRE_POSITIVE_CVD ? { name: 'Positive CVD',    pass: d.cvdTrend === 'up' } : null,
  ].filter(Boolean);

  const failedCore = coreChecks.filter(c => !c.pass).map(c => c.name);
  const passedCore = coreChecks.filter(c => c.pass).map(c => c.name);

  const passedFlexible = flexibleChecks.filter(c => c.pass);
  const failedFlexible = flexibleChecks.filter(c => !c.pass);
  // Effective threshold can't exceed how many flexible checks are even
  // enabled — e.g. asking for 3-of-5 when only 2 are enabled would make
  // this unpassable; cap it at the pool size instead.
  const effectiveMinPass = Math.min(ALPHA_FLEXIBLE_MIN_PASS, flexibleChecks.length);
  const flexiblePassed   = passedFlexible.length >= effectiveMinPass;

  const failedChecks = [
    ...failedCore,
    ...(flexiblePassed ? [] : [`flexible checks: only ${passedFlexible.length}/${flexibleChecks.length} passed (need ${effectiveMinPass}) — failed: ${failedFlexible.map(c => c.name).join(', ')}`]),
  ];
  const passedChecks = [...passedCore, ...passedFlexible.map(c => c.name)];

  return { allowed: failedCore.length === 0 && flexiblePassed, failedChecks, passedChecks };
}

// ── Phase 2 — Relative Strength vs BTC ──
// coinReturn - btcReturn over the configured lookback. Positive RS above
// GUARD_BTC_RS_MIN means the coin is genuinely outperforming BTC, not
// just moving with (or less than) the broader market. Informational by
// default — NOT wired into the Alpha Exception's required checks above,
// since the proposal lists it as a separate signal, not one of the
// "all conditions satisfied" gate items. Exposed here so
// leaderboard-decider.js can log/display it and optionally use it later.
const RS_ENABLED   = (process.env.GUARD_BTC_RS_ENABLED || 'true') !== 'false';
const RS_MIN        = parseFloat(process.env.GUARD_BTC_RS_MIN || '2.0');

export function calcRelativeStrength(entry, global = {}) {
  if (!RS_ENABLED) return { rs: null, strong: false };
  // Both sides use the SAME timeframe (24h % change) for a fair
  // comparison — entry.chg/entry.d.chg comes from Binance's 24h ticker
  // (priceChangePercent), and global.btcChg24h is the same field read
  // from BTC's own entry (see market-fetcher.js). Deliberately NOT mixing
  // r4h (which is 4H RSI, not a % change) or btcChg15m (a much shorter
  // window) — either would compare different things and produce a
  // meaningless number.
  const coinChg = parseFloat(entry.d?.chg ?? entry.chg ?? NaN);
  const btcChg  = parseFloat(global.btcChg24h ?? NaN);
  if (isNaN(coinChg) || isNaN(btcChg)) return { rs: null, strong: false };
  const rs = coinChg - btcChg;
  return { rs: parseFloat(rs.toFixed(2)), strong: rs >= RS_MIN };
}


const VOL_FULL_PCT          = parseFloat(process.env.GUARD_VOL_FULL_PCT          || '2');   // BTC candle range ≤ this → no vol-based cut
const VOL_FLOOR_PCT         = parseFloat(process.env.GUARD_VOL_FLOOR_PCT         || '8');   // BTC candle range ≥ this → vol layer at its floor
const VOL_FLOOR_MULT        = parseFloat(process.env.GUARD_VOL_FLOOR_MULT        || '0.2'); // vol layer's own floor

const GLOBAL_FLOOR_MULT     = parseFloat(process.env.GUARD_GLOBAL_FLOOR_MULT     || '0.15'); // absolute minimum size, no matter how many layers compound

// ── Linear interpolation helper ──
// Maps `value` from the range [goodPoint, badPoint] to [1, floorMult].
// Works whether badPoint > goodPoint (e.g. F&G, low = bad) or
// badPoint < goodPoint (e.g. BTC chg, negative = bad) — direction-agnostic.
// Clamped at both ends so out-of-range inputs don't overshoot.
function lerpMult(value, goodPoint, badPoint, floorMult) {
  if (value === null || value === undefined) return 1;
  const span = badPoint - goodPoint;
  if (span === 0) return 1; // misconfigured — don't divide by zero
  let t = (value - goodPoint) / span; // 0 at goodPoint, 1 at badPoint
  t = Math.max(0, Math.min(1, t));    // clamp
  return 1 - t * (1 - floorMult);
}

// ── Layer 1 — BTC short-term change ──
// Hard gate (closeAll) is UNCHANGED — BTC crashing fast still closes
// everything regardless of the sizing curve below.
// Sizing is now continuous: scales from full size at BTC_FULL_PCT down to
// BTC_FLOOR_MULT at BTC_FLOOR_PCT (which matches the close threshold, so
// the curve naturally bottoms out right where the hard gate takes over).
export function checkBtcGuard(global = {}) {
  const btcChg15m = global.btcChg15m ?? null;

  if (btcChg15m === null) return { pass: true, sizeMult: 1, reason: null };

  if (btcChg15m <= BTC_CLOSE_PCT) return {
    pass:          false,
    closeAll:      true,
    sizeMult:      BTC_FLOOR_MULT,
    reason:        `BTC 15m: ${btcChg15m.toFixed(2)}% ≤ ${BTC_CLOSE_PCT}% — market panic, closing all positions`,
    level:         'PANIC',
  };

  const sizeMult = lerpMult(btcChg15m, BTC_FULL_PCT, BTC_FLOOR_PCT, BTC_FLOOR_MULT);

  if (sizeMult < 1) return {
    pass:          true,
    closeAll:      false,
    sizeMult,
    reason:        `BTC 15m: ${btcChg15m.toFixed(2)}% — scaling size to ${(sizeMult * 100).toFixed(0)}%`,
    level:         'BTC_STRESS',
  };

  return { pass: true, sizeMult: 1, reason: null };
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
// Two SEPARATE things happen here, deliberately kept apart:
//
// 1. SIZING: F&G 21-24 (between FEAR_BLOCK_THRESHOLD and FEAR_FULL_FG) is a
//    FLAT ${FEAR_REDUCED_MULT} cut — not a gradient. This band is explicitly
//    a two-step function per spec, unlike the BTC/volatility layers which
//    still use a continuous curve. F&G ≥ FEAR_FULL_FG (default 25) → 100%,
//    no cut at all.
//
// 2. SIGNAL QUALITY (still a hard step, unchanged): at or below
//    FEAR_BLOCK_THRESHOLD (default 20), a candidate is only allowed through
//    AT ALL if it's diverging from BTC (rising while BTC falls). This isn't
//    a sizing decision — it's "is this candidate's signal even trustworthy
//    right now" — so it stays a hard gate, separate from the sizing step
//    above. Conflating the two would mean a barely-passing size cut could
//    still let through non-diverging, low-conviction buys in extreme fear.
export function checkFearGreed(global = {}) {
  const fg = global.fearGreed ?? null;

  if (fg === null) return { pass: true, sizeMult: 1, fearRegime: false, reason: null };

  const fearRegime = fg <= FEAR_BLOCK_THRESHOLD;
  const sizeMult    = fearRegime ? FEAR_EXTREME_MULT
                     : fg >= FEAR_FULL_FG ? 1
                     : FEAR_REDUCED_MULT;

  if (fearRegime) return {
    pass:        true,           // NOT a hard block — per-symbol divergence check in caller
    sizeMult,
    fearRegime:  true,           // signals: only let diverging symbols through
    btcChg:      global.btcChg15m ?? global.btcChg24h ?? null,
    reason:      `Fear & Greed: ${fg} (Extreme Fear) — only symbols diverging from BTC allowed, sizing at ${(sizeMult * 100).toFixed(0)}%`,
    level:       'EXTREME_FEAR',
  };

  if (sizeMult < 1) return {
    pass:        true,
    sizeMult,
    fearRegime:  false,          // fear but not extreme — no divergence check needed
    reason:      `Fear & Greed: ${fg} — sizing at ${(sizeMult * 100).toFixed(0)}%`,
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

  const sizeMult = lerpMult(btcVolatility, VOL_FULL_PCT, VOL_FLOOR_PCT, VOL_FLOOR_MULT);

  if (sizeMult < 1) return {
    sizeMult,
    reason:   `BTC candle range ${btcVolatility.toFixed(2)}% — scaling size to ${(sizeMult * 100).toFixed(0)}%`,
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
// canBuy:     false → at least one gate is blocking buys this cycle (circuit
//             breaker / blackout / BTC panic / BTC regime — see hardBlocked
//             below for which kind)
// hardBlocked:false → canBuy is false ONLY because of the BTC 4H regime gate
//             (Layer 6) — caller should still let individual symbols attempt
//             the Alpha Exception rather than returning immediately.
//             true  → a genuine hard stop fired (BTC panic closeAll, circuit
//             breaker, or time blackout) — caller should return immediately,
//             no per-symbol exception applies.
// closeAll:   true  → close all live MEXC positions before doing anything else
// sizeMult:   0-1   → multiply effective USD size by this (1 = full size)
// fearRegime: true  → F&G ≤ FEAR_BLOCK_THRESHOLD — caller must check per-symbol divergence
// btcChg:     BTC 15m change % (for divergence check in caller)
// btcRegimeBlocked: true → specifically Layer 6 (BTC 4H bias) caused the block,
//             so callers can distinguish this from other canBuy=false reasons if needed
// reasons:    list of strings explaining every gate that fired
//
// SIZING COMBINATION: sizeMult layers now COMPOUND multiplicatively
// (fgMult × btcMult × volMult) instead of taking the single worst factor.
// Three independent moderate-stress signals firing together is a stronger
// "something is genuinely wrong" signal than any one of them alone, and
// compounding reflects that. A GLOBAL_FLOOR_MULT stops this from ever
// compounding all the way to a near-zero/locked-up size.
// ══════════════════════════════════════════════════════════════════════════════
export function runAllBuyGuards(market, positions) {
  const global     = market.global || {};
  const reasons    = [];
  let   canBuy     = true;
  let   hardBlocked= false; // true only for genuine hard stops (Layers 1/2/5) —
                             // NOT for a pure BTC 4H regime block (Layer 6), which
                             // the caller should still let individual symbols
                             // bypass via the per-candidate Alpha Exception.
  let   closeAll   = false;
  let   fearRegime = false;
  const btcChg     = global.btcChg15m ?? null;

  // Layer 1 — BTC (hard closeAll gate unchanged; sizing now continuous)
  const btc = checkBtcGuard(global);
  if (!btc.pass) {
    canBuy = false;
    hardBlocked = true;
    reasons.push(btc.reason);
    if (btc.closeAll) closeAll = true;
  } else if (btc.reason) {
    reasons.push(btc.reason);
  }

  // Layer 2 — Circuit breaker
  const cb = checkCircuitBreaker(positions);
  if (!cb.pass) {
    closeAll = true;
    canBuy   = false;
    hardBlocked = true;
    reasons.push(cb.reason);
  }

  // Layer 3 — F&G (sets fearRegime flag — hard divergence gate, unchanged;
  // sizing contribution is now continuous)
  const fg = checkFearGreed(global);
  if (fg.fearRegime) fearRegime = true;
  if (fg.reason) reasons.push(fg.reason);

  // Layer 4 — Volatility (sizing only, now continuous)
  const vol = checkVolatility(global);
  if (vol.reason) reasons.push(vol.reason);

  // Layer 5 — Time blackout
  const time = checkTimeBlackout();
  if (!time.pass) {
    canBuy = false;
    hardBlocked = true;
    reasons.push(time.reason);
  }

  // Layer 6 — BTC 4H market-regime buy gate (Phase 1). NEW-BUY GATE ONLY —
  // deliberately does not set closeAll and never touches existing
  // positions; STOP_LOSS_PCT elsewhere continues to close a hit stop
  // unconditionally regardless of this gate's state.
  const btcRegime = checkBtcRegimeGate(global);
  let btcRegimeBlocked = false;
  if (btcRegime.blocked) {
    canBuy = false;
    btcRegimeBlocked = true;
    reasons.push(btcRegime.reason);
  }

  // ── Combine sizing layers multiplicatively, then apply the global floor ──
  const rawSizeMult = btc.sizeMult * fg.sizeMult * vol.sizeMult;
  const sizeMult     = Math.max(GLOBAL_FLOOR_MULT, rawSizeMult);

  if (rawSizeMult < GLOBAL_FLOOR_MULT) {
    reasons.push(`Combined size ${(rawSizeMult * 100).toFixed(1)}% floored to global minimum ${(GLOBAL_FLOOR_MULT * 100).toFixed(0)}%`);
  }

  return { canBuy, hardBlocked, closeAll, sizeMult, fearRegime, btcChg, btcRegimeBlocked, reasons };
}
