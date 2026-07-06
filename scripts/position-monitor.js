// ══════════════════════════════════════════════════════════════════════════════
// position-monitor.js — Job B position lifecycle management
//
// Runs every Job B cycle BEFORE the buy signal scan. For every open position
// in positions.json it:
//   1. Reads live price from market-data.json
//   2. Checks stop / T1 / T2 (price-based, immediate)
//   3. Computes exit score (CVD + OI + FR + RSI) → marks 'exiting'
//   4. Removes positions that have been in terminal state long enough
//   5. Removes positions that have been 'watching' past LB_STALE_WATCH_HRS
//
// This means positions.json is always up to date even when the browser is
// never opened. Telegram alerts fire for every status change (caller sends
// the returned telegramAlerts[] — this module never calls sendTelegram
// directly, so it stays decoupled from the Telegram layer).
// ══════════════════════════════════════════════════════════════════════════════

import { mexcMarketSell, mexcFreeBalance, getBaseSizePrecision, floorToStep } from './mexc-client.js';
import {
  logAudit, loadCvdState, saveCvdState, TERMINAL_EVICT_MS, MEXC_API_KEY, MEXC_API_SECRET,
  loadTradeLog, recordTradeClose, pushTradeLogToGitHub,
} from './job-state.js';

const LB_STALE_WATCH_HRS = parseFloat(process.env.LB_STALE_WATCH_HRS || '24');
const LB_HOLD_LOCK       = parseInt(process.env.LB_HOLD_LOCK       || '20');
const LB_EXIT_CVD_CYCLES = parseInt(process.env.LB_EXIT_CVD_CYCLES || '3');
const LB_EXIT_SCORE_MIN  = parseInt(process.env.LB_EXIT_SCORE_MIN  || '3');

export function countLiveOpenPositions(positions) {
  return Object.values(positions).filter(
    p => p.liveOrder?.mode === 'live' && !p.liveOrder?.closedAt && !['stopped', 'tp2_hit'].includes(p.status)
  ).length;
}

// ── Closes a live MEXC position when a stop or T2 fires headlessly ──
// Re-checks actual exchange balance before selling (never trusts the
// locally-tracked qty alone — fees or manual intervention could have
// changed it) and floors to the exchange's lot-size step so the order
// isn't rejected for too many decimals.
export async function closeLiveOrder(pos, reason, telegramAlerts) {
  if (!pos.liveOrder || pos.liveOrder.closedAt) return;

  // Paper trades never touch the exchange — just record the close using the
  // exit price the caller already computed (pos.exitPrice), so the permanent
  // trade log has a full paper buy/sell record too, not just live ones.
  if (pos.liveOrder.mode !== 'live') {
    pos.liveOrder.closedAt      = Date.now();
    pos.liveOrder.exitFillPrice = pos.exitPrice || pos.liveOrder.fillPrice;
    recordTradeClose(pos, reason, { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    return;
  }

  const symbol = pos.base + 'USDT';
  try {
    const [step, free] = await Promise.all([
      getBaseSizePrecision(symbol),
      mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, pos.base),
    ]);
    const sellQty = floorToStep(Math.min(pos.liveOrder.qty || 0, free), step);
    if (sellQty <= 0) {
      telegramAlerts.push(`🚨 *LIVE SELL SKIPPED* — ${pos.base} ${reason} but exchange balance reads 0 — check MEXC manually.`);
      logAudit('mexc_sell_skipped', { sym: symbol, reason, free });
      return;
    }
    const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, symbol, sellQty);
    pos.liveOrder.sellOrderId   = sell.orderId;
    pos.liveOrder.exitFillPrice = sell.fillPrice;
    pos.liveOrder.closedAt      = Date.now();
    telegramAlerts.push(`🟢 *LIVE SELL* — closed ${sellQty} ${pos.base} @ $${sell.fillPrice.toFixed(6)} on MEXC (${reason})`);
    logAudit('mexc_sell', { sym: symbol, reason, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId });
    recordTradeClose(pos, reason, { orderId: sell.orderId, qty: sellQty, fillPrice: sell.fillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
  } catch (e) {
    telegramAlerts.push(`🚨 *LIVE SELL FAILED* — ${pos.base} ${reason} but MEXC order errored: ${e.message} — CLOSE MANUALLY on the exchange.`);
    logAudit('mexc_sell_failed', { sym: symbol, reason, error: e.message });
  }
}

// ── CVD decline tracking (persisted across Job B runs) ──
// Browser uses window._cvdDeclineCount; headless uses .cvd-decline-state.json
function trackCvdDecline(sym, trending) {
  const state = loadCvdState();
  if (trending === 'down') {
    state[sym] = (state[sym] || 0) + 1;
  } else {
    state[sym] = 0;
  }
  saveCvdState(state);
  return state[sym];
}

// Returns { positions, changed, telegramAlerts[], closedOutcomes[] }
// Caller saves positions.json, pushes to GitHub, and sends telegramAlerts.
export async function monitorPositions(positions, marketSymbols) {
  const now           = Date.now();
  const staleMs       = LB_STALE_WATCH_HRS * 60 * 60 * 1000;
  const holdLockMs    = LB_HOLD_LOCK * 60 * 1000;
  let   changed       = false;
  const telegramAlerts = [];
  const closedOutcomes = []; // rows for symbol-history.json — win/loss record per closed position
  const utc = new Date().toUTCString().slice(17, 22) + ' UTC';

  for (const [sym, pos] of Object.entries(positions)) {

    // ── 1. Remove terminal positions past their eviction window ──
    const termDelay = TERMINAL_EVICT_MS[pos.status];
    if (termDelay) {
      const changedAt = pos.statusChangedAt || pos.alertedAt || 0;
      if (now - changedAt >= termDelay) {
        console.log(`  🗑  ${pos.base} (${pos.status}) past eviction window → removed`);
        delete positions[sym];
        changed = true;
        logAudit('position_evicted', { sym, status: pos.status });
      }
      // Don't do any further monitoring on terminal positions
      continue;
    }

    // ── 2. Remove stale watching positions (never hit stop or target) ──
    if (pos.status === 'watching') {
      const openedAt = pos.alertedAt || 0;
      if (now - openedAt >= staleMs) {
        const ageHrs = Math.round((now - openedAt) / 3600000);
        console.log(`  🗑  ${pos.base} stale ${ageHrs}h watching → evicted`);
        delete positions[sym];
        changed = true;
        logAudit('position_stale_evicted', { sym, ageHrs });
        telegramAlerts.push(
          `🗑 *STALE EVICTED* — ${pos.base}\n` +
          `  Watching ${ageHrs}h with no stop/target hit\n` +
          `  Entry $${pos.entryPrice}  Stop $${pos.stop}  ${utc}`
        );
        continue;
      }
    }

    // ── 3. Look up live market data for this position ──
    // positions.json uses BINANCE:BTCUSDT — market-data.json uses BTCUSDT
    const mKey  = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
    const mData = marketSymbols[mKey];
    if (!mData || !mData.d) {
      console.log(`  ⚠  ${pos.base} — no market data found (key: ${mKey})`);
      continue;
    }

    const d      = mData.d;
    const price  = parseFloat(d.p || 0);
    if (!price) { console.log(`  ⚠  ${pos.base} — price is 0, skipping`); continue; }

    const entry  = parseFloat(pos.entryPrice || 0);
    const stop   = parseFloat(pos.stop  || 0);
    const t1     = parseFloat(pos.t1    || 0);
    const t2     = parseFloat(pos.t2    || 0);
    const isBull = pos.dir !== 'bear';
    const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';

    // ── 4. Price-based exits (immediate, no hold lock, no score needed) ──

    // Stop hit
    if (isBull && stop > 0 && price <= stop) {
      console.log(`  🔴  STOP HIT — ${pos.base} price:${price} stop:${stop}`);
      pos.status          = 'stopped';
      pos.statusChangedAt = now;
      pos.exitPrice       = price;
      changed = true;
      logAudit('stop_hit', { sym, price, stop, entry, pnlPct });
      closedOutcomes.push({
        base: pos.base, pair: pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
        outcome: 'stopped', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      telegramAlerts.push(
        `🔴 *STOP HIT* — ${pos.base} — ${utc}\n` +
        `  Entry $${entry}  Stop $${stop}  Current $${price}\n` +
        `  P&L ${pnlPct}%  Setup: ${pos.setup}\n` +
        `  _Position removed in 5 min_`
      );
      await closeLiveOrder(pos, 'stop hit', telegramAlerts);
      continue; // no further checks needed
    }

    // T2 hit — retained for paper/legacy positions that were opened before T1-sell
    // was introduced. In normal operation this is unreachable since T1 now closes
    // the position and the slot is freed before T2 can be checked.
    if (isBull && t2 > 0 && price >= t2 && pos.status === 'tp1_hit') {
      console.log(`  🏆  T2 HIT (legacy) — ${pos.base} price:${price} t2:${t2}`);
      pos.status          = 'tp2_hit';
      pos.statusChangedAt = now;
      pos.exitPrice       = price;
      changed = true;
      logAudit('tp2_hit', { sym, price, t2, entry, pnlPct });
      closedOutcomes.push({
        base: pos.base, pair: pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
        outcome: 'tp2_hit', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      telegramAlerts.push(
        `🏆 *T2 HIT* — ${pos.base} — ${utc}\n` +
        `  T2 $${t2}  Current $${price}  Entry $${entry}\n` +
        `  P&L +${pnlPct}%  Full target reached\n` +
        `  _Position removed in 8 min_`
      );
      await closeLiveOrder(pos, 'T2 hit', telegramAlerts);
      continue;
    }

    // T1 hit — sell full position, take profit, free the slot
    // Strategy: take the guaranteed gain at T1 rather than waiting for T2.
    // The slot immediately re-opens for the next A/A+ signal.
    if (isBull && t1 > 0 && price >= t1 && pos.status === 'watching') {
      console.log(`  ✅  T1 HIT — ${pos.base} price:${price} t1:${t1} — selling full position`);
      pos.status          = 'tp1_hit';
      pos.statusChangedAt = now;
      pos.exitPrice       = price;
      changed = true;
      logAudit('tp1_hit', { sym, price, t1, entry, pnlPct });
      closedOutcomes.push({
        base: pos.base, pair: pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
        outcome: 'tp1_hit', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      telegramAlerts.push(
        `✅ *T1 HIT — SOLD* — ${pos.base} — ${utc}\n` +
        `  T1 $${t1}  Fill ~$${price}  Entry $${entry}\n` +
        `  P&L +${pnlPct}%  Full position closed — slot freed\n` +
        `  _Position removed in 5 min_`
      );
      await closeLiveOrder(pos, 'T1 hit', telegramAlerts);
      continue; // slot freed, skip exit scoring
    }

    // ── 5. Hold lock — no exit score during first N minutes ──
    const holdLockUntil = (pos.alertedAt || 0) + holdLockMs;
    if (now < holdLockUntil) {
      const remMins = Math.ceil((holdLockUntil - now) / 60000);
      console.log(`  ⏳  ${pos.base} — hold lock ${remMins}min remaining`);
      continue;
    }

    // ── 6. Skip exit scoring for exiting positions (already fired) ──
    if (pos.status === 'exiting') {
      const exitedAt = pos.statusChangedAt || 0;
      // Still within eviction window — just log
      console.log(`  🟡  ${pos.base} — exiting, ${Math.round((now - exitedAt)/60000)}min since signal`);
      continue;
    }

    // ── 7. Exit score — CVD + OI + FR + RSI ──
    // CVD is the hard gate: must decline LB_EXIT_CVD_CYCLES consecutive Job B runs
    const cvdTrending  = d.cvd?.trending || d.cvdTrend || 'up';
    const cvdDeclines  = trackCvdDecline(sym, cvdTrending);
    const cvdConfirmed = cvdDeclines >= LB_EXIT_CVD_CYCLES;

    const fr          = parseFloat(d.fr    || 0);
    const r15         = parseFloat(d.r15   || 50);
    const oiStr       = (d.oiDiv || '').toLowerCase();
    const chg         = parseFloat(d.chg   || 0);
    const priceNearEntry = Math.abs(chg) < 0.5 || price < entry * 1.005;
    const oiExiting   = (oiStr.includes('bear oi') || oiStr.includes('oi drop')) && priceNearEntry;
    const fundingHot  = fr > 0.08;
    const rsiExtended = r15 > 75;

    let exitScore = 0;
    if (cvdConfirmed)                       exitScore += 2; // hard gate contribution
    if (oiExiting)                          exitScore += 2;
    if (fundingHot)                         exitScore += 1;
    if (rsiExtended && cvdDeclines >= 1)    exitScore += 1;

    console.log(`  📊  ${pos.base} — price:$${price} pnl:${pnlPct}% exitScore:${exitScore}/6 cvd:${cvdTrending}(${cvdDeclines}) fr:${fr.toFixed(3)}%`);

    // ── Tier 1: Overheating warning (no CVD needed) ──
    const tier1Triggered = fundingHot && rsiExtended && !cvdConfirmed;
    const tier1Cooldown  = 2 * 60 * 60 * 1000;
    if (tier1Triggered && (!pos.tier1AlertedAt || now - pos.tier1AlertedAt > tier1Cooldown)) {
      pos.tier1AlertedAt = now;
      changed = true;
      console.log(`  ⚠  ${pos.base} — OVERHEATING FR:${fr.toFixed(3)}% RSI:${Math.round(r15)}`);
      telegramAlerts.push(
        `⚠ *WATCH — Overheating* — ${pos.base} — ${utc}\n` +
        `  FR ${fr.toFixed(3)}%  RSI 15m ${Math.round(r15)}\n` +
        `  CVD still up — tighten stop, not yet an exit\n` +
        `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%`
      );
    }

    // ── Tier 2: Distribution confirmed — exit signal ──
    const tier2Cooldown = 2 * 60 * 60 * 1000;
    if (cvdConfirmed
        && exitScore >= LB_EXIT_SCORE_MIN
        && (!pos.exitAlertedAt || now - pos.exitAlertedAt > tier2Cooldown)) {
      pos.status          = 'exiting';
      pos.statusChangedAt = now;
      pos.exitAlertedAt   = now;
      changed = true;
      const signals = [
        cvdConfirmed ? `CVD↓ ${cvdDeclines} cycles` : null,
        oiExiting    ? 'OI distributing'             : null,
        fundingHot   ? `FR ${fr.toFixed(3)}%`        : null,
        rsiExtended  ? `RSI ${Math.round(r15)}`      : null,
      ].filter(Boolean).join(' · ');
      console.log(`  🟡  ${pos.base} — EXIT SIGNAL score:${exitScore}/6 [${signals}]`);
      logAudit('exit_signal', { sym, exitScore, signals, price, pnlPct });
      telegramAlerts.push(
        `🟡 *EXIT SIGNAL* — ${pos.base} — ${utc}\n` +
        `  Score ${exitScore}/6 · ${signals}\n` +
        `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%\n` +
        `  T2 $${t2} — consider partial exit or trail stop\n` +
        `  _Position removed in 10 min_`
      );
    }
  }

  return { positions, changed, telegramAlerts, closedOutcomes };
}
