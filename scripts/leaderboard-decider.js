// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min)
// v11.0 — split build
//
// This file is the ORCHESTRATOR: it loads state, runs the buy-signal scan and
// recommendation ranking (below), and delegates everything else to its sibling
// modules:
//   position-monitor.js   — stop/T1/T2 detection, exit scoring, stale eviction
//   mexc-trader.js         — A/A+ rotation + star-pick auto-buy execution
//   telegram-commands.js   — sendTelegram() + /pause /resume polling
//   job-state.js            — shared I/O, paths, env constants, audit log
//
// KEY CHANGE from v10.9 (unchanged from the monolith): monitorPositions() runs
// every Job B cycle BEFORE the buy signal scan, so positions.json stays
// current even when the browser is never opened.
// ══════════════════════════════════════════════════════════════════════════════

import { calcConviction, getSetupMode } from './leaderboard-scanner.js';
import { buildSymKey, cooldownKey } from './exchange-registry.js';

import {
  logAudit, pushPositionsToGitHub, SKIP_SETUPS, TERMINAL_EVICT_MS,
  TRADE_MODE, TRADE_USD_SIZE, TRADE_MAX_LIVE,
  DRY_RUN, TG_ENABLED,
  MEXC_API_KEY, MEXC_API_SECRET,
  loadMarketData, saveMarketData,
  loadPositions, savePositions,
  loadAlertState, saveAlertState,
  loadCooldowns, saveCooldowns,
  loadHistory, saveHistory,
  loadTradeState, saveTradeState,
  saveTradeLog, pushTradeLogToGitHub,
  loadAuditLog, pushAuditLogToGitHub, pushLiveBalancesToGitHub,
  checkHeartbeatStale, pushHeartbeatToGitHub,
} from './job-state.js';
import { mexcGetAllBalances } from './mexc-client.js';

import { sendTelegram, pollTelegramCommands } from './telegram-commands.js';
import { monitorPositions, reconcileTrackedLiveBalances } from './position-monitor.js';
import { executeTradeCycle, adoptManualHoldings } from './mexc-trader.js';
import { runAllBuyGuards, isDivergingFromBtc, checkBtcAlphaException, calcRelativeStrength, checkBull4hPersistence } from './market-guard.js';

const LB_MIN_SCORE       = parseInt(process.env.LB_MIN_SCORE       || '9');
const LB_BULL_CONF_MIN   = parseInt(process.env.LB_BULL_CONF_MIN   || '5');
const LB_COOLDOWN_MIN    = parseInt(process.env.LB_COOLDOWN_MIN    || '60');
const LB_HOLD_LOCK       = parseInt(process.env.LB_HOLD_LOCK       || '20');
const ALLOW_PRE_MARKET   = (process.env.LB_ALLOW_PRE_MARKET || 'false') === 'true';
const ALLOW_AH           = (process.env.LB_ALLOW_AH         || 'false') === 'true';
const ALERT_STATE_TTL    = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

// Only used for the startup banner/audit log — the actual gating logic for
// these lives in position-monitor.js.
const LB_STALE_WATCH_HRS = parseFloat(process.env.LB_STALE_WATCH_HRS || '24');
const LB_EXIT_CVD_CYCLES = parseInt(process.env.LB_EXIT_CVD_CYCLES || '3');
const LB_EXIT_SCORE_MIN  = parseInt(process.env.LB_EXIT_SCORE_MIN  || '3');

// ── Multi-signal recommendation (top N by past spike history) ──
const RECO_MIN_SIGNALS   = parseInt(process.env.LB_RECO_MIN_SIGNALS    || '3');   // only annotate when this many+ fire in one cycle
const RECO_TOP_N         = parseInt(process.env.LB_RECO_TOP_N          || '3');   // how many to star as recommended
const RECO_LOOKBACK_DAYS = parseFloat(process.env.LB_RECO_LOOKBACK_DAYS|| '30');  // history window used for win-rate
const HISTORY_RETENTION_DAYS = parseFloat(process.env.LB_HISTORY_RETENTION_DAYS || '45'); // how long symbol-history.json keeps rows
const HISTORY_MAX_ROWS    = parseInt(process.env.LB_HISTORY_MAX_ROWS || '1500'); // hard cap regardless of days — safety net vs. size blowup

// ── Cooldown helpers ──
function isOnCooldown(state, cdKey, assetType) {
  const ts = state[cdKey] || 0;
  if (assetType === 'crypto') return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
  return ts > 0; // stocks: date-keyed, any truthy = fired today
}
function markCooldown(state, cdKey) { state[cdKey] = Date.now(); }

function pruneAlertState(state) {
  const cutoff = Date.now() - ALERT_STATE_TTL * 3_600_000;
  for (const [sym, e] of Object.entries(state)) {
    if ((e.lastSeenAt || 0) < cutoff) delete state[sym];
  }
  return state;
}

function calcEntryLevels(price, shock) {
  const p = parseFloat(price) || 0;
  if (!p) return null;
  const atr   = p * 0.015 * Math.max(1, shock * 0.5);
  const dp    = p < 10 ? 4 : 2;
  const entry = (p * 1.004).toFixed(dp);
  // Fixed-percentage stop — deliberately NOT volatility-scaled.
  // Previously (ATR_STOP_MULT) the stop widened automatically on
  // high-shock days, which defeats the purpose of setting a small,
  // predictable max-loss-per-trade: since crypto is close to always
  // volatile, the "floor" behavior rarely applied in practice, and
  // several trades realized 1-2%+ losses despite ATR_STOP_MULT being
  // set to a value implying ~0.1-0.15%. STOP_LOSS_PCT is now a hard,
  // fixed % of entry price, every time, regardless of shock/volatility.
  const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.1');
  const stop  = (p * (1 - STOP_LOSS_PCT / 100)).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

// ══════════════════════════════════════════════════════════════════════════════
// Historical spike-strength ranking — used to recommend top N when several
// buy signals fire in the same cycle. Purely informational (Telegram-only,
// no gating of which positions actually open).
// ══════════════════════════════════════════════════════════════════════════════
function getHistoryStrength(history, base, lookbackDays) {
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const rows = history.filter(e => e.base === base && e.closedAt >= cutoff);
  if (!rows.length) return { winRate: null, sample: 0, avgPnl: null, strength: 0 };

  const wins    = rows.filter(e => e.outcome === 'tp2_hit').length;
  const winRate = wins / rows.length;
  const avgPnl  = rows.reduce((s, e) => s + (e.pnlPct || 0), 0) / rows.length;

  // Confidence-weighted: winRate dampened when sample size is thin (<5),
  // plus a small nudge for average P&L so a 100%-but-tiny sample doesn't
  // automatically beat a well-proven symbol.
  const confidence = Math.min(1, rows.length / 5);
  const strength   = winRate * confidence + Math.max(0, avgPnl) * 0.01;

  return { winRate, sample: rows.length, avgPnl, strength };
}

// ── peak/latest evaluator ──
function evaluateSymbol(entry) {
  const latest    = { conv: entry.conv, setup: entry.setup, shock: entry.d?.shock, obi: entry.d?.obi };
  const peakD     = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
  const peakConv  = calcConviction(peakD);
  const peakSetup = getSetupMode({ ...peakD, conv: peakConv });
  return peakConv > latest.conv && !SKIP_SETUPS.has(peakSetup.label)
    ? { conv: peakConv, setup: peakSetup, source: 'peak', shock: entry.peakShock, obi: entry.peakObi }
    : { ...latest, source: 'latest' };
}

function resetPeaks(market) {
  const now = Date.now();
  for (const entry of Object.values(market.symbols || {})) {
    entry.peakShock = entry.d?.shock ?? entry.peakShock;
    entry.peakObi   = entry.d?.obi   ?? entry.peakObi;
    entry.peakSince = now;
  }
  return market;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Leaderboard Decider v11.0 — ${new Date().toUTCString()}`);
  console.log(`MinScore:${LB_MIN_SCORE} BullConf:${LB_BULL_CONF_MIN} Cooldown:${LB_COOLDOWN_MIN}min StaleHrs:${LB_STALE_WATCH_HRS} DryRun:${DRY_RUN}`);
  console.log('═'.repeat(60));

  logAudit('job_start', {
    minScore: LB_MIN_SCORE, bullConfMin: LB_BULL_CONF_MIN,
    cooldownMin: LB_COOLDOWN_MIN, staleWatchHrs: LB_STALE_WATCH_HRS,
    exitCvdCycles: LB_EXIT_CVD_CYCLES, exitScoreMin: LB_EXIT_SCORE_MIN,
    allowAH: ALLOW_AH, allowPre: ALLOW_PRE_MARKET,
    ghRepo: process.env.GH_REPO || '✗ missing',
    tgEnabled: TG_ENABLED, dryRun: DRY_RUN,
  });

  // ── Heartbeat staleness check ──
  // The schedule expects this job every ~17 min (alerts.yml: minutes
  // 2,19,36,53). GitHub Actions can silently delay or skip scheduled runs
  // with no notification — this is how the bot notices a gap itself rather
  // than someone finding out retroactively. Threshold is 2.5x the expected
  // interval so normal jitter (a run taking a bit longer, GitHub's usual
  // few-minutes cron slop) doesn't false-alarm.
  const heartbeat = checkHeartbeatStale(17, 2.5);
  if (heartbeat.stale) {
    console.log(`  ⚠️  STALE RUN — last successful run was ${heartbeat.gapMinutes} min ago (expected ~17min)`);
    logAudit('heartbeat_stale', { gapMinutes: heartbeat.gapMinutes, lastRunAt: heartbeat.lastRunAt });
    await sendTelegram(
      `⚠️ *STALE RUN DETECTED*\n` +
      `  Last successful run was ${heartbeat.gapMinutes.toFixed(0)} minutes ago (expected ~every 17 min).\n` +
      `  _Check GitHub Actions run history for failed/skipped scheduled runs — positions.json and reconciliation may be out of date until this resolves._`
    );
  }

  const market  = loadMarketData();
  const entries = Object.entries(market.symbols || {});

  if (!entries.length) {
    console.log('[leaderboard-decider] market-data.json empty — has market-fetcher run yet?');
    logAudit('market_data_empty');
    return;
  }

  const ageMin = (Date.now() - (market.fetchedAt || 0)) / 60000;
  const STALE_THRESHOLD_MIN = market.staleAfterMinutes || 30;
  const dataIsStale = ageMin > STALE_THRESHOLD_MIN;
  if (dataIsStale) {
    console.log(`[leaderboard-decider] ⚠ market-data.json is ${ageMin.toFixed(1)} min old — blocking new buys this cycle`);
    logAudit('market_data_stale', { ageMin: parseFloat(ageMin.toFixed(1)), thresholdMin: STALE_THRESHOLD_MIN });
    await sendTelegram(
      `🚨 *STALE MARKET DATA* — ${ageMin.toFixed(0)} min old (threshold ${STALE_THRESHOLD_MIN} min)\n` +
      `  New buy signals are BLOCKED this cycle — won't open a position off outdated prices.\n` +
      `  _Open positions are still monitored for stop/target using this same data — verify current prices manually on MEXC if you're relying on exit timing right now._`
    );
  }

  const cryptoCount = entries.filter(([, e]) => e.assetType === 'crypto').length;
  const stockCount  = entries.filter(([, e]) => e.assetType === 'stock').length;
  const frozenCount = entries.filter(([, e]) => e.marketClosed).length;
  console.log(`[leaderboard-decider] ${entries.length} symbols — ${cryptoCount} crypto, ${stockCount} stock (${frozenCount} frozen)`);

  // ══════════════════════════════════════════════════════
  // STEP 1 — Monitor open positions (exit/stop/stale)
  // Runs BEFORE buy scan so freed slots are available.
  // ══════════════════════════════════════════════════════
  let positions = loadPositions();

  // GUI toggle writes `tradeMode`/`execStrategy`/etc to trade-state.json —
  // these take precedence when set, so the browser control still works
  // without a repo-variable change. BUT trade-state.json itself only ever
  // gets written when someone actually uses the GUI toggle — if it's never
  // touched (or gets reset/cleared), these fall back to repo Variables
  // below rather than a silently different hardcoded default. This means a
  // browser cache clear no longer risks reverting live trading behavior to
  // an unexpected default — the repo Variable is the durable source of
  // truth, and the GUI is an optional session-level override on top of it.
  let tradeState = loadTradeState();
  tradeState = await pollTelegramCommands(tradeState);
  saveTradeState(tradeState);

  const effectiveTradeMode     = tradeState.tradeMode     || TRADE_MODE;
  // EXEC_STRATEGY: 'top1' | 'topN'. Repo Variable, defaults to 'top1' if unset.
  const effectiveExecStrategy  = tradeState.execStrategy  || process.env.EXEC_STRATEGY || 'top1';
  // EXEC_TOP_N_COUNT: how many starred picks 'topN' actually buys (e.g. 2 or
  // 3), rather than every currently-starred symbol. Repo Variable; unset/0
  // keeps the original behavior of buying ALL starred picks (uncapped).
  const effectiveTopNCount     = tradeState.execTopNCount || parseInt(process.env.EXEC_TOP_N_COUNT || '0', 10) || null;
  const effectiveUsdSize       = tradeState.usdSize       || TRADE_USD_SIZE;
  const effectiveMaxLive       = tradeState.maxLive       || TRADE_MAX_LIVE;
  // TRADE_SIZE_MODE: 'usd' (fixed dollar, default) | 'percent' (% of balance,
  // compounds — see mexc-trader.js executeAutoBuys for the balance lookup).
  const effectiveSizeMode      = tradeState.sizeMode      || process.env.TRADE_SIZE_MODE || 'usd';
  const effectiveSizePct       = tradeState.sizePct       || parseFloat(process.env.TRADE_SIZE_PCT || '100');

  // Sizing per pick is NOT a separate variable — it's a fixed rule, always:
  //   top1 → 100% of effectiveUsdSize on the single pick
  //   topN → effectiveUsdSize split EQUALLY across however many picks are
  //          actually bought (capped at effectiveTopNCount if set)
  // See mexc-trader.js's perPickUsd calculation — no config needed for this.

  // ── Fresh start on off/paper → live transition ──
  // Paper (and off) mode can leave behind positions.json entries and
  // trade-log.json rows that mean nothing once real money is involved (paper
  // fills, test qty values, etc.) — and they'd otherwise sit there confusing
  // the "API Trades" journal and occupying live-slot counts the moment you
  // flip to live. Detect the transition once (tracked in trade-state.json so
  // it only fires on the actual switch, not every cycle you stay in live)
  // and wipe both files so live trading always starts from a clean slate.
  // NOTE: this only clears the bot's own tracking — it never touches your
  // real MEXC wallet balance.
  const previousTradeMode = tradeState.lastTradeMode || TRADE_MODE;
  if (previousTradeMode !== 'live' && effectiveTradeMode === 'live') {
    console.log(`  🔄  TRADE MODE CHANGED: ${previousTradeMode} → live — resetting positions.json and trade-log.json`);
    positions = {};
    savePositions(positions);
    await pushPositionsToGitHub(positions);
    saveTradeLog([]);
    await pushTradeLogToGitHub([]);
    logAudit('trade_mode_reset', { from: previousTradeMode, to: 'live' });
    await sendTelegram(
      `🔄 *TRADE MODE → LIVE* — ${new Date().toUTCString().slice(17, 22)} UTC\n` +
      `  Switched from *${previousTradeMode}* to *live*.\n` +
      `  positions.json and the API Trades journal have been reset to start fresh.\n` +
      `  _Your real MEXC wallet balance is untouched — this only clears the bot's own tracking._`
    );
  }
  tradeState.lastTradeMode = effectiveTradeMode;
  saveTradeState(tradeState);
  const openCount = Object.keys(positions).length;

  if (openCount > 0) {
    console.log(`\n📊  Monitoring ${openCount} open position(s)...`);
    const monitored = await monitorPositions(positions, market.symbols || {}, {
      LB_MIN_SCORE, LB_BULL_CONF_MIN,
    });
    positions = monitored.positions;

    if (monitored.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }

    if (monitored.closedOutcomes.length) {
      let history = loadHistory();
      history.push(...monitored.closedOutcomes);
      const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
      history = history.filter(e => e.closedAt >= cutoff);
      if (history.length > HISTORY_MAX_ROWS) history = history.slice(history.length - HISTORY_MAX_ROWS);
      saveHistory(history);
      logAudit('history_recorded', { rows: monitored.closedOutcomes.length, totalKept: history.length });
    }

    // Send all exit/stop/stale Telegram alerts
    for (const msg of monitored.telegramAlerts) {
      await sendTelegram(msg);
    }

    if (monitored.changed) {
      logAudit('monitor_complete', {
        openBefore: openCount,
        openAfter:  Object.keys(positions).length,
        alerts:     monitored.telegramAlerts.length,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.5 — Adopt untracked MEXC holdings (manual buys)
  // Live only — paper mode has no real exchange balance to reconcile.
  // Must run BEFORE the buy scan below so its open-position gate sees any
  // newly-adopted symbol as already-tracked (no duplicate signal/buy).
  // ══════════════════════════════════════════════════════
  if (effectiveTradeMode === 'live') {
    const adopted = await adoptManualHoldings({ positions, market, evaluateSymbol, calcEntryLevels });
    positions = adopted.positions;
    if (adopted.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.6 — Reconcile tracked live positions against REAL MEXC balance
  // Runs every live cycle, independent of whether rotation has a new pick
  // this cycle — otherwise a manually-sold position whose price never
  // crosses its own stop/target could sit "open" in positions.json
  // indefinitely, silently blocking that symbol from future alerts.
  // ══════════════════════════════════════════════════════
  if (effectiveTradeMode === 'live') {
    const reconcileUtc = new Date().toUTCString().slice(17, 22) + ' UTC';
    const reconciled = await reconcileTrackedLiveBalances(positions, effectiveTradeMode, reconcileUtc);
    if (reconciled.telegramAlerts.length) {
      for (const m of reconciled.telegramAlerts) await sendTelegram(m);
    }
    if (reconciled.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 2 — Scan for new BUY signals
  // Skipped entirely if market data is stale (see gate above) — no new
  // position should open off outdated prices. Monitoring/exits in STEP 1
  // already ran regardless, since leaving open positions unwatched during
  // a stale-data window is worse than evaluating exits with a flagged
  // caveat.
  // ══════════════════════════════════════════════════════
  if (dataIsStale) {
    console.log(`\n⏭  Buy scan skipped this cycle — market data too stale.`);
    logAudit('buy_scan_skipped_stale_data', { ageMin: parseFloat(ageMin.toFixed(1)) });
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    await pushAuditLogToGitHub(loadAuditLog());
    console.log('\n✅  Job B complete (buy scan skipped — stale data).\n');
    return;
  }

  console.log(`\n🔍  Scanning for buy signals...`);

  // Pre-screen — bail early if nothing clears min score
  const anyCandidate = entries.some(([, entry]) => {
    if (entry.marketClosed) return false;
    if (entry.conv >= LB_MIN_SCORE && !SKIP_SETUPS.has(entry.setup?.label)) return true;
    const peakD    = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
    const peakConv = calcConviction(peakD);
    return peakConv >= LB_MIN_SCORE && !SKIP_SETUPS.has(getSetupMode({ ...peakD, conv: peakConv }).label);
  });

  if (!anyCandidate) {
    const bestConv = Math.max(...entries.map(([, e]) => e.conv ?? -Infinity));
    console.log(`  Pre-screen: nothing reaches ${LB_MIN_SCORE} (best conv: ${bestConv}) — no buys this cycle.`);
    logAudit('no_candidates', { bestConv });
    saveMarketData(resetPeaks(market));
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    console.log('\n✅  Job B complete.\n');
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET GUARD — 5-layer news-shock / dip protection
  // Runs AFTER monitoring (so fresh position P&L is available for circuit
  // breaker) and BEFORE opening any new positions.
  // ══════════════════════════════════════════════════════════════════════════
  const guard = runAllBuyGuards(market, positions);

  if (guard.reasons.length) {
    console.log('  🛡  Market guard fired:');
    guard.reasons.forEach(r => console.log(`     → ${r}`));
    logAudit('market_guard', { canBuy: guard.canBuy, closeAll: guard.closeAll, sizeMult: guard.sizeMult, reasons: guard.reasons });
  }

  // Layer 2 / BTC panic: close ALL live positions immediately
  if (guard.closeAll && effectiveTradeMode !== 'off') {
    const livePosEntries = Object.entries(positions).filter(
      ([, p]) => p.assetType === 'crypto'
              && p.liveOrder?.mode === effectiveTradeMode
              && !p.liveOrder?.closedAt
              && !['stopped', 'tp1_hit', 'tp2_hit', 'exiting'].includes(p.status)
    );

    if (livePosEntries.length) {
      console.log(`  🚨  Emergency close — ${livePosEntries.length} live position(s)`);
      const guardSells = [];
      for (const [, pos] of livePosEntries) {
        await closeLiveOrder(pos, `market guard: ${guard.reasons[0]}`, guardSells);
        pos.status          = 'stopped';
        pos.statusChangedAt = Date.now();
        pos.rotatedOut      = true;
      }
      savePositions(positions);
      await pushPositionsToGitHub(positions);
      await sendTelegram(
        `🚨 *MARKET GUARD — EMERGENCY CLOSE* — ${new Date().toUTCString().slice(17, 22)} UTC\n` +
        `  Reason: ${guard.reasons[0]}\n` +
        `  Closed ${livePosEntries.length} live position(s)\n` +
        `  _New buys blocked until market stabilises_`
      );
      for (const m of guardSells) await sendTelegram(m);
    }
  }

  // Apply guard size multiplier to the effective USD size for this cycle
  // (only meaningful in 'usd' mode — 'percent' mode recomputes size from
  // live balance in mexc-trader.js's executeAutoBuys, using this same
  // guard.sizeMult passed through as effectiveGuardSizeMult)
  const guardedUsdSize = guard.sizeMult < 1
    ? parseFloat((effectiveUsdSize * guard.sizeMult).toFixed(2))
    : effectiveUsdSize;

  if (guard.sizeMult < 1) {
    if (effectiveSizeMode === 'percent') {
      console.log(`  📉  Market guard active — sizing to ${(effectiveSizePct * guard.sizeMult).toFixed(1)}% of balance (×${guard.sizeMult} guard multiplier)`);
    } else {
      console.log(`  📉  Position size reduced: $${effectiveUsdSize} → $${guardedUsdSize} (×${guard.sizeMult})`);
    }
  }

  // If a genuine hard-stop gate fired (BTC panic closeAll, circuit breaker,
  // time blackout), skip all new buys this cycle — no per-symbol exception
  // applies to these. A pure BTC 4H regime block (guard.canBuy=false but
  // guard.hardBlocked=false) falls through instead, so individual symbols
  // still get evaluated against the Alpha Exception below.
  if (guard.hardBlocked) {
    console.log('  🛡  Buy gates blocked — no new positions opened this cycle.');
    saveMarketData(resetPeaks(market));
    saveCooldowns(loadCooldowns());
    saveAlertState(pruneAlertState(loadAlertState()));
    logAudit('buy_blocked_by_guard', { reasons: guard.reasons });
    await pushHeartbeatToGitHub(Date.now());
    console.log('\n✅  Job B complete (guard active).\n');
    return;
  }
  if (!guard.canBuy && guard.btcRegimeBlocked) {
    console.log('  🛡  BTC 4H regime block active — only symbols passing the Alpha Exception can buy this cycle.');
  }

  const cooldowns  = loadCooldowns();
  const alertState = pruneAlertState(loadAlertState());
  const candidates = [];

  for (const [pair, entry] of entries) {
    // Session gate
    if (entry.marketClosed) continue;
    if (entry.session === 'pre_market'  && !ALLOW_PRE_MARKET) continue;
    if (entry.session === 'after_hours' && !ALLOW_AH) continue;

    // Score gate
    const evald = evaluateSymbol(entry);
    if (evald.conv < LB_MIN_SCORE)          continue;
    if (SKIP_SETUPS.has(evald.setup.label)) continue;

    // 4H trend persistence gate — applies to EVERY buy candidate,
    // independent of BTC regime state. bull4hCount is maintained by
    // market-fetcher.js (this file only consumes it); requiring it to
    // have held for BUY_BULL4H_COUNT_MIN consecutive fetch cycles (~5min
    // each) filters out a bias4h reading that just flipped to "BULL 4H"
    // this cycle and may reverse next cycle, before committing real money.
    if (entry.assetType === 'crypto') {
      const persistence = checkBull4hPersistence(entry);
      if (!persistence.allowed) {
        console.log(`  ⏳  ${pair} — 4H bull trend only ${persistence.count} cycle(s) old (need ≥${process.env.BUY_BULL4H_COUNT_MIN || '2'}) — skipping, possible short-lived flip`);
        continue;
      }
    }

    // BTC market-regime gate (Phase 2 — Alpha Exception) — only relevant
    // when Layer 6 in market-guard.js actually blocked THIS cycle
    // (guard.btcRegimeBlocked). A candidate can still buy despite BTC
    // bearishness if it independently clears every required condition
    // (whale/volume/CVD/OI/EMA/bias/score/bullConf — see
    // checkBtcAlphaException()). This is deliberately evaluated per
    // candidate, not once globally, since "does THIS coin show real
    // relative strength" is a per-symbol question.
    if (guard.btcRegimeBlocked && entry.assetType === 'crypto') {
      const alpha = checkBtcAlphaException({ ...entry, d: entry.d, conv: evald.conv });
      if (!alpha.allowed) {
        console.log(`  🛡  ${pair} — BTC regime block, no Alpha Exception (failed: ${alpha.failedChecks.join(', ')})`);
        continue;
      }
      const rs = calcRelativeStrength(entry, market.global || {});
      console.log(`  ✅  ${pair} — Alpha Exception passed (${alpha.passedChecks.join(', ')})${rs.rs !== null ? ` — RS vs BTC: ${rs.rs > 0 ? '+' : ''}${rs.rs}%` : ''}`);
    }

    // Fear & Greed divergence gate — only active when F&G ≤ FEAR_BLOCK_THRESHOLD
    // (fearRegime flag set by runAllBuyGuards above).
    // If BTC is dropping and this symbol is ALSO dropping → block it.
    // If this symbol is UP while BTC is down → real relative strength → allow.
    // This is how IMX +4.29% would have passed this morning while BTC was red.
    if (guard.fearRegime && entry.assetType === 'crypto') {
      const symChg = parseFloat(entry.d?.chg ?? entry.chg ?? 0);
      if (!isDivergingFromBtc(symChg, guard.btcChg)) {
        console.log(`  🛡  ${pair} — Extreme Fear + no BTC divergence (symChg:${symChg}% btcChg:${guard.btcChg}%) — skipped`);
        continue;
      }
      console.log(`  ✅  ${pair} — Extreme Fear but diverging +${symChg}% vs BTC ${guard.btcChg}% — allowing at ${guard.sizeMult * 100}% size`);
    }

    // CAP BUY bypasses bull confirmation gate
    const isCapBuy = entry.assetType === 'crypto' && (entry.capBuy?.isCapBuy ?? false);
    if (!isCapBuy && (entry.bullConf ?? 0) < LB_BULL_CONF_MIN) {
      console.log(`  ⏭  ${pair} bullConf:${entry.bullConf}/10 < ${LB_BULL_CONF_MIN}`);
      continue;
    }

    // Cooldown gate
    const cdKey = cooldownKey(pair, entry.assetType);
    if (isOnCooldown(cooldowns, cdKey, entry.assetType)) {
      console.log(`  🔕  ${pair} — cooldown`);
      continue;
    }

    // Open position gate — block on active states only
    // Matches by BASE ASSET across ALL tracked keys, not just an exact
    // sym-key match. adoptManualHoldings tracks manually-bought coins under
    // a bare key (e.g. 'LINKUSDT'), while this buy-scan builds its own key
    // via buildSymKey (e.g. 'BINANCE:LINKUSDT') — an exact-key lookup here
    // would miss an existing bare-keyed entry entirely and create a SECOND,
    // duplicate tracked position for the same real asset. A duplicate like
    // that silently occupies an extra TRADE_MAX_CONCURRENT_LIVE slot even
    // after the "real" copy gets sold, since only one of the two keys
    // actually gets closed by a sell.
    const sym = buildSymKey(pair);
    const base = pair.replace('USDT', '').replace(/\.\w+$/, '');
    const existingKey = Object.keys(positions).find(k => {
      const p = positions[k];
      return p.base === base && p.assetType === entry.assetType;
    });
    const existingPos = existingKey ? positions[existingKey] : undefined;
    if (existingPos) {
      // tp1_hit has two sub-states (see position-monitor.js): still holding
      // to T2 (no exitPrice — a real position, do NOT touch it) vs actually
      // sold at T1 (exitPrice set — genuinely terminal). Only the latter is
      // safe to evict/replace here; the former must stay tracked exactly
      // like position-monitor.js already protects it, or this gate would
      // silently delete the live tracking record for a real open position
      // (and open a duplicate) the moment TERMINAL_EVICT_MS elapses.
      const isTerminal = ['stopped', 'tp2_hit'].includes(existingPos.status)
        || (existingPos.status === 'tp1_hit' && !!existingPos.exitPrice);
      if (!isTerminal) {
        console.log(`  ⏭  ${pair} — open position (${existingPos.status})`);
        continue;
      }
      // Terminal but not yet evicted — check if past eviction window
      const termDelay = TERMINAL_EVICT_MS[existingPos.status] || 0;
      const changedAt = existingPos.statusChangedAt || existingPos.alertedAt || 0;
      if (Date.now() - changedAt < termDelay) {
        console.log(`  ⏭  ${pair} — terminal (${existingPos.status}), waiting for eviction`);
        continue;
      }
      // Past eviction window — clear it now (using whichever key it was
      // ACTUALLY tracked under, which may differ from buildSymKey(pair))
      console.log(`  ♻️  ${pair} — clearing terminal (${existingPos.status}), slot available`);
      delete positions[existingKey];
    }

    candidates.push({ pair, sym, entry, evald, cdKey, isCapBuy });
  }

  if (!candidates.length) {
    console.log('  ✓  No new buy signals this cycle (blocked by cooldown/gates)');
    saveMarketData(resetPeaks(market));
    saveCooldowns(cooldowns);
    saveAlertState(alertState);
    logAudit('buy_cycle_complete', { signalsFound: 0 });
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    console.log('\n✅  Job B complete.\n');
    return;
  }

  // Open new positions
  const buyAlerts = [];
  for (const { pair, sym, entry, evald, cdKey } of candidates) {
    markCooldown(cooldowns, cdKey);
    alertState[pair] = { lastLabel: evald.setup.label, lastConv: evald.conv, lastSeenAt: Date.now() };

    const levels = calcEntryLevels(entry.price, evald.shock);
    const now    = Date.now();

    positions[sym] = {
      sym,
      base:           pair.replace('USDT', '').replace(/\.\w+$/, ''),
      assetType:      entry.assetType,
      exchangePrefix: entry.exchangePrefix,
      session:        entry.session,
      setup:          evald.setup.label,
      dir:            evald.setup.label === 'SHORT SETUP' ? 'bear' : 'bull',
      alertedAt:      now,
      holdLockUntil:  now + LB_HOLD_LOCK * 60000,
      entryPrice:     levels ? parseFloat(levels.entry) : entry.price,
      stop:           levels ? parseFloat(levels.stop)  : 0,
      t1:             levels ? parseFloat(levels.t1)    : 0,
      t2:             levels ? parseFloat(levels.t2)    : 0,
      score:          evald.conv,
      spikeScore:     evald.shock,
      exitAlertedAt:  null,
      tier1AlertedAt: null,
      status:         'watching',
      source:         'headless_v11.0',
      scoreSource:    evald.source,
    };

    buyAlerts.push({ pair, sym, levels, evald, price: entry.price, chg: entry.chg, d: entry.d, entry });
    console.log(`  🟢  ${pair} [${evald.setup.label}] score:${evald.conv} → ${sym}`);
    logAudit('position_opened', { pair, sym, setup: evald.setup.label, score: evald.conv });
  }

  // ── Rank by CURRENT signal first, past spike history as a bonus only ──
  // Computed here (before save) so positions.json itself carries the same
  // recommended/rank/caution tags the Telegram message uses — Position
  // Tracker in the browser can then badge ⭐ inline, no separate panel.
  //
  // Why current-first: a symbol's 30d win rate mostly reflects the regime
  // it traded in (BTC/market beta dragging everything down), not whether
  // *this* setup is good. So history can only ADD to the rank (proven
  // repeaters get boosted), never subtract — a real reversal spike with a
  // rough recent record still competes on its own technical merit.
  const history      = loadHistory();
  const showRecoTags = buyAlerts.length >= RECO_MIN_SIGNALS;
  const base = a => a.pair.replace('USDT', '').replace(/\.\w+$/, '');

  const HIST_BOOST_WEIGHT  = parseFloat(process.env.LB_RECO_HIST_BOOST_WEIGHT || '0.5');  // how much a clean track record can add on top of current signal
  const CAUTION_WIN_RATE   = parseFloat(process.env.LB_RECO_CAUTION_WIN_RATE  || '0.3');  // below this win rate → caution note
  const CAUTION_MIN_SAMPLE = parseInt(process.env.LB_RECO_CAUTION_MIN_SAMPLE  || '3');    // need at least this many closes for the caution note to be meaningful

  function currentSignalStrength(a) {
    // Normalize conviction score and bull-confirmation to ~0-1 so they're
    // comparable to the history bonus below.
    const convNorm     = Math.max(0, Math.min(1, (a.evald.conv - LB_MIN_SCORE) / 10));
    const bullConfNorm = Math.max(0, Math.min(1, (a.entry.bullConf || 0) / 10));
    return 0.7 * convNorm + 0.3 * bullConfNorm;
  }

  const ranked = buyAlerts
    .map(a => {
      const hist      = getHistoryStrength(history, base(a), RECO_LOOKBACK_DAYS);
      const curStr     = currentSignalStrength(a);
      const rankScore  = curStr + HIST_BOOST_WEIGHT * Math.max(0, hist.strength); // history floors at 0 — never a penalty
      const caution    = hist.sample >= CAUTION_MIN_SAMPLE && hist.winRate !== null && hist.winRate < CAUTION_WIN_RATE;
      return { a, hist, curStr, rankScore, caution };
    })
    .sort((x, y) => (y.rankScore - x.rankScore) || (y.a.evald.conv - x.a.evald.conv));

  if (showRecoTags) {
    ranked.slice(0, RECO_TOP_N).forEach(r => { r.recommended = true; });
  }

  // ── Tag positions.json with the same ranking, before it's saved ──
  for (const { a, hist, rankScore, recommended, caution } of ranked) {
    const p = positions[a.sym];
    if (!p) continue;
    p.recommended = !!recommended;   // starred in Position Tracker
    p.rankScore   = parseFloat(rankScore.toFixed(3));
    p.histWinRate = hist.winRate;    // null if no history yet
    p.histSample  = hist.sample;
    p.caution     = caution;         // rough recent record — reversal bet, not a repeat pattern
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MEXC AUTO-TRADE — rotation + star-pick buys (delegated to mexc-trader.js)
  // ══════════════════════════════════════════════════════════════════════════
  const utc = new Date().toUTCString().slice(17, 22) + ' UTC';
  // Note: separate from monitor's closedOutcomes above — this was a latent
  // bug in the monolith (rotation referenced an undeclared `closedOutcomes`
  // in main()'s scope, which would have thrown ReferenceError the first time
  // an A/A+ signal fired). Fixed by giving mexc-trader its own outcomes array
  // and recording it to history in a second pass, right after execution.
  const rotationOutcomes = [];

  await executeTradeCycle({
    candidates, positions, market, tradeState,
    closedOutcomes: rotationOutcomes, utc,
    effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount, effectiveUsdSize: guardedUsdSize, effectiveMaxLive,
    effectiveSizeMode, effectiveSizePct, effectiveGuardSizeMult: guard.sizeMult,
    ranked, showRecoTags,
  });

  if (rotationOutcomes.length) {
    let hist = loadHistory();
    hist.push(...rotationOutcomes);
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
    hist = hist.filter(e => e.closedAt >= cutoff);
    if (hist.length > HISTORY_MAX_ROWS) hist = hist.slice(hist.length - HISTORY_MAX_ROWS);
    saveHistory(hist);
    logAudit('history_recorded', { rows: rotationOutcomes.length, totalKept: hist.length, source: 'rotation' });
  }

  savePositions(positions);
  saveCooldowns(cooldowns);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));
  await pushPositionsToGitHub(positions);

  // Telegram BUY alerts
  const lines = ranked.map(({ a, hist, recommended, caution }) => {
    const l          = a.levels;
    const peakNote   = a.evald.source === 'peak' ? ' _(peak)_' : '';
    const assetBadge = a.entry.assetType === 'stock' ? ' 📊' : '';
    const sessionTag = a.entry.session !== 'open' && a.entry.session !== '24/7'
      ? ` _(${a.entry.session})_` : '';
    const star       = recommended ? '⭐ ' : '';
    const histLine    = showRecoTags
      ? (hist.sample > 0
          ? `  📈 Past ${RECO_LOOKBACK_DAYS}d: ${Math.round(hist.winRate * hist.sample)}W-${hist.sample - Math.round(hist.winRate * hist.sample)}L (${Math.round(hist.winRate * 100)}%) avg ${hist.avgPnl >= 0 ? '+' : ''}${hist.avgPnl.toFixed(2)}%`
          : `  📈 No trade history yet — ranked on signal strength`)
      : '';
    const cautionLine = caution
      ? `  ⚠ _Rough recent record (${Math.round(hist.winRate*100)}% win, ${hist.sample} closes) — treat as a reversal bet, not a repeat pattern_`
      : '';
    return [
      `${star}${a.evald.setup.emoji} *${a.pair.replace('USDT','')}*${assetBadge} — ${a.evald.setup.label} [${a.evald.conv} pts]${peakNote}${sessionTag}`,
      a.entry.whale ? `  ${a.entry.whale.emoji} Whale ${a.entry.whale.score}/100 · Flow: ${a.entry.flow||'—'} · Grade: ${a.entry.grade||'—'} (${a.entry.successProb||'—'}% win)` : '',
      `  Setup: ${a.entry.archetype||'—'} · BullConf: ${a.entry.bullConf??'—'}/10`,
      `  Price $${a.price}  Chg ${a.chg>0?'+':''}${a.chg?.toFixed(2)}%`,
      `  Entry $${l?.entry||'—'}  Stop $${l?.stop||'—'}  T1 $${l?.t1||'—'}  T2 $${l?.t2||'—'}  R:R ${l?.rr||'—'}`,
      histLine,
      cautionLine,
      `  _Pos: ${a.sym}_`,
    ].filter(Boolean).join('\n');
  });

  const recoHeader = showRecoTags
    ? `_⭐ Top ${Math.min(RECO_TOP_N, buyAlerts.length)} of ${buyAlerts.length} — ranked on current signal, clean track record adds a bonus (never a penalty)_`
    : `_${buyAlerts.length} signal(s) · v11.0 · min score ${LB_MIN_SCORE}_`;

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    recoHeader,
    '', lines.join('\n\n'), '',
    `_Stop/T1/T2/exit monitored headlessly every 15 min_`,
  ].join('\n');

  await sendTelegram(msg);
  logAudit('buy_cycle_complete', {
    signalsFound: candidates.length,
    positionsOpened: buyAlerts.length,
    recommended: showRecoTags ? ranked.slice(0, RECO_TOP_N).map(r => base(r.a)) : [],
    caution: ranked.filter(r => r.caution).map(r => base(r.a)),
  });

  // ── Live-balances snapshot for the GUI's Trade Journal cross-check ──
  // Only meaningful in live mode — paper has no real exchange balance. Runs
  // every cycle (not just on rotation) so the GUI always has a fresh view of
  // what's actually sitting on MEXC right now, including anything bought
  // manually outside the bot.
  if (effectiveTradeMode === 'live' && MEXC_API_KEY && MEXC_API_SECRET) {
    try {
      const balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
      await pushLiveBalancesToGitHub(balances);
    } catch (e) {
      console.warn(`[live-balances] ⚠ ${e.message}`);
      logAudit('live_balances_fetch_failed', { error: e.message });
    }
  }

  logAudit('job_complete');
  await pushHeartbeatToGitHub(Date.now());
  await pushAuditLogToGitHub(loadAuditLog());
  console.log('\n✅  Job B complete.\n');
}

main().catch(err => {
  console.error('[leaderboard-decider] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
