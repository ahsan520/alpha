// ══════════════════════════════════════════════════════════════════════════════
// mexc-trader.js — MEXC auto-trade execution
//
// Two things happen here, in order, both gated by effectiveTradeMode !== 'off':
//
//   1. A/A+ ROTATION — if any NEW candidate this cycle is Grade A or A+ (a
//      combined BullConf + whaleScore signal from leaderboard-scanner.js),
//      sell ALL currently live positions first so their slots free up for
//      the new picks. Paper mode logs the rotation without exchange calls.
//
//   2. STAR-PICK AUTO-BUY — buys the top-ranked ⭐ recommended symbol(s) via
//      MEXC market order (or logs a paper fill), gated by tradingEnabled,
//      idempotency, and the live-position concurrency cap.
//
// Both were previously inline in leaderboard-decider.js's main(). Note: the
// original rotation block referenced a bare `closedOutcomes` array that was
// never declared in main()'s scope (it only existed inside monitorPositions)
// — this would have thrown a ReferenceError the first time an A/A+ signal
// actually fired. Fixed here by taking closedOutcomes as an explicit param.
// ══════════════════════════════════════════════════════════════════════════════

import { mexcMarketBuy } from './mexc-client.js';
import { closeLiveOrder, countLiveOpenPositions } from './position-monitor.js';
import { sendTelegram } from './telegram-commands.js';
import {
  logAudit, MEXC_API_KEY, MEXC_API_SECRET,
  loadTradeLog, recordTradeOpen, pushTradeLogToGitHub,
} from './job-state.js';

// ── Symbols that can alert/star normally but must NEVER be auto-traded ──
// Default: empty — ALL symbols are tradeable unless explicitly listed here.
// These still flow through leaderboard-decider's scan and Telegram messages
// either way; listing a symbol only excludes it from A/A+ rotation and the
// star-pick auto-buy (e.g. so capital stays in alts that spike/dip harder
// than BTC once you decide to exclude it).
// Set via repo Variable MEXC_NO_TRADE_SYMBOLS, e.g. "BTCUSDT,ETHUSDT".
// Leave the variable unset/empty to allow auto-trading on every symbol.
const NO_TRADE_SYMBOLS = (process.env.MEXC_NO_TRADE_SYMBOLS || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function isNoTradeSymbol(pair) {
  const bare = (pair || '').replace(/^BINANCE:/, '').toUpperCase();
  return NO_TRADE_SYMBOLS.includes(bare);
}


// ── A/A+ rotation — sell all live positions to make room for stronger signals ──
async function executeRotation({ candidates, positions, market, tradeState, effectiveTradeMode, closedOutcomes, utc }) {
  let changed = false;

  const rotationCandidates = candidates.filter(c =>
    c.entry.assetType === 'crypto' && (c.entry.grade === 'A+' || c.entry.grade === 'A')
    && !isNoTradeSymbol(c.pair)   // BTC/ETH alert/star fine, but never trigger rotation
  );
  const shouldRotate = rotationCandidates.length > 0
    && effectiveTradeMode !== 'off'
    && tradeState.tradingEnabled;

  if (!shouldRotate) return { changed, rotationCandidates };

  const livePosEntries = Object.entries(positions).filter(
    ([, p]) => p.assetType === 'crypto'              // MEXC is crypto-only — never rotate stocks/ETFs
            && p.liveOrder?.mode === effectiveTradeMode
            && !p.liveOrder?.closedAt
            && !['stopped', 'tp1_hit', 'tp2_hit'].includes(p.status)
  );

  // ── T1-holding positions (status tp1_hit, no exitPrice — genuinely still
  // held, running toward T2) get their own rotation rule, separate from
  // normal open trades above:
  //   - still grades A/A+ itself this cycle → PROTECTED. Left completely
  //     untouched in positions.json; only ever sold at T2/stop/exit-score
  //     (position-monitor.js's own logic), never by rotation.
  //   - no longer grades A/A+ → sold now (same as a normal rotation sell)
  //     AND removed from positions.json immediately (not left for the
  //     usual 5-min TERMINAL_EVICT_MS window), freeing the slot right away
  //     for the star-pick buy that runs immediately after this function.
  // A held symbol never re-appears in `candidates` on its own (the buy-side
  // open-position gate skips symbols that already have an open position),
  // so its current grade has to be read straight from market data here.
  const holdingT1Entries = Object.entries(positions).filter(
    ([, p]) => p.assetType === 'crypto'
            && p.liveOrder?.mode === effectiveTradeMode
            && !p.liveOrder?.closedAt
            && p.status === 'tp1_hit' && !p.exitPrice
  );

  const rotatableT1Entries = holdingT1Entries.filter(([sym]) => {
    const mKey  = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
    const grade = (market.symbols || {})[mKey]?.grade;
    return grade !== 'A' && grade !== 'A+'; // no longer top-grade → eligible to rotate out
  });

  if (holdingT1Entries.length && !rotatableT1Entries.length) {
    console.log(`  🔒  ${holdingT1Entries.length} T1-holding position(s) still grade A/A+ — protected from rotation`);
  }

  const allSellEntries = [...livePosEntries, ...rotatableT1Entries];

  if (allSellEntries.length) {
    console.log(`  🔄  A/A+ ROTATION — ${rotationCandidates.map(c=>c.pair).join(', ')} qualify → selling ${allSellEntries.length} live position(s) first`);
    const rotationSells = [];

    for (const [sym, pos] of allSellEntries) {
      const sellAlerts = [];
      const wasHoldingT1 = pos.status === 'tp1_hit' && !pos.exitPrice;
      await closeLiveOrder(pos, wasHoldingT1 ? 'A/A+ rotation — no longer top grade' : 'A/A+ rotation', sellAlerts);

      // Record the rotation exit in symbol history
      const mKey  = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
      const mData = (market.symbols || {})[mKey];
      const exitPrice = pos.liveOrder?.exitFillPrice || parseFloat(mData?.d?.p || pos.entryPrice || 0);
      const pnlPct    = pos.entryPrice > 0
        ? parseFloat(((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2))
        : 0;

      closedOutcomes.push({
        base: pos.base, pair: pos.base + 'USDT',
        outcome: wasHoldingT1 ? 'rotation_t1_downgrade' : 'rotation', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct, closedAt: Date.now(),
      });
      rotationSells.push({ base: pos.base, pnlPct, wasHoldingT1 });

      if (wasHoldingT1) {
        // No longer top-grade — remove now rather than waiting on the usual
        // TERMINAL_EVICT_MS window, so the slot/capital frees immediately
        // for the star-pick buy that runs right after this function.
        delete positions[sym];
      } else {
        // Mark as evicted immediately — slot freed for rotation buy
        pos.status          = 'stopped'; // treated as a close
        pos.statusChangedAt = Date.now();
        pos.exitPrice       = exitPrice;
        pos.rotatedOut      = true;
      }
      changed = true;

      for (const m of sellAlerts) await sendTelegram(m);
    }

    const sellSummary = rotationSells
      .map(r => `${r.base} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%${r.wasHoldingT1 ? ' (T1 hold, lost A/A+)' : ''}`)
      .join(', ');
    await sendTelegram(
      `🔄 *A/A+ ROTATION* — ${utc}\n` +
      `  Sold: ${sellSummary}\n` +
      `  Rotating into: ${rotationCandidates.map(c => c.entry.grade + ' ' + c.pair.replace('USDT','')).join(', ')}\n` +
      `  _Grade A/A+ signal — upgrading positions_`
    );
    logAudit('rotation_sell', { sold: rotationSells, into: rotationCandidates.map(c=>c.pair) });
  }

  return { changed, rotationCandidates };
}

// ── Star-pick auto-buy ──
//
// Two execution strategies (GUI toggle → trade-state.json, OR repo Variables
// EXEC_STRATEGY / EXEC_TOP_N_COUNT as the durable default the GUI overrides):
//   'top1'  — buy only the ⭐ #1 ranked symbol, full TRADE_USD_SIZE
//   'topN'  — buy the top EXEC_TOP_N_COUNT starred symbols (e.g. 2 or 3;
//             unset/0 = every currently-starred symbol, uncapped),
//             TRADE_USD_SIZE split equally
//             e.g. $75 / 3 picks = $25 each — this split is a fixed rule,
//             not a separate config value (top1 is always 100% of size)
//
// Gates (per-symbol, all must pass):
//   1. TRADE_MODE is 'paper' or 'live' (not 'off')
//   2. tradingEnabled flag (Telegram /pause kill-switch)
//   3. Symbol is in the ⭐ recommended set (showRecoTags fired)
//   4. Not already holding too many live open trades (TRADE_MAX_CONCURRENT_LIVE)
//   5. Idempotency: positions[sym].liveOrder not already set
async function executeAutoBuys({
  ranked, showRecoTags, positions, tradeState,
  effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount, effectiveUsdSize, effectiveMaxLive,
  utc,
}) {
  if (effectiveTradeMode === 'off' || !showRecoTags) return;

  // MEXC is crypto-only — stocks/ETFs can be starred/recommended for the
  // Telegram alert and GUI, but must never be routed to a MEXC order. Without
  // this filter, a starred stock pick (e.g. TSX:ETHY.TO) would fall through
  // to the symbol-building logic below and produce a garbage MEXC pair.
  const allStarred = ranked.filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair)
  );
  // 'topN' buys effectiveTopNCount picks (e.g. 2 or 3) if that repo Variable
  // is set; unset/0 falls back to the original behavior of every starred
  // symbol, uncapped.
  const picks      = effectiveExecStrategy === 'topN'
    ? (effectiveTopNCount ? allStarred.slice(0, effectiveTopNCount) : allStarred)
    : allStarred.slice(0, 1);
  const perPickUsd = effectiveExecStrategy === 'topN' && picks.length > 1
    ? parseFloat((effectiveUsdSize / picks.length).toFixed(2))
    : effectiveUsdSize;

  console.log(`  ⚡  Exec strategy: ${effectiveExecStrategy} — ${picks.length} pick(s) @ $${perPickUsd} each`);

  if (!tradeState.tradingEnabled) {
    console.log(`  🚫  Auto-trade blocked — trading paused via Telegram /pause`);
    logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: ['paused'] });
    return;
  }

  for (const { a: pick } of picks) {
    const pos    = positions[pick.sym];
    const symbol = pick.pair.replace(/[^A-Z]/g, '') + (pick.pair.includes('USDT') ? '' : 'USDT');

    // Re-count AFTER each buy — topN must not exceed effectiveMaxLive
    // even if rotation just freed some slots at the start of this cycle.
    const liveLock = countLiveOpenPositions(positions);

    const blockedReasons = [
      pick.entry?.assetType !== 'crypto' ? `assetType:${pick.entry?.assetType} — MEXC is crypto-only` : null,
      isNoTradeSymbol(pick.pair)         ? `${pick.pair} in MEXC_NO_TRADE_SYMBOLS — alert-only, no auto-buy` : null,
      pos?.liveOrder                    ? 'liveOrder already set (idempotency guard)' : null,
      liveLock >= effectiveMaxLive      ? `already ${liveLock}/${effectiveMaxLive} live trades open` : null,
    ].filter(Boolean);

    if (blockedReasons.length) {
      console.log(`  🚫  ${symbol} skipped — ${blockedReasons.join(', ')}`);
      logAudit('mexc_blocked', { sym: symbol, reasons: blockedReasons });
      continue;
    }

    if (effectiveTradeMode === 'paper') {
      console.log(`  📝  PAPER BUY — ${symbol} $${perPickUsd} USDT`);
      pos.liveOrder = {
        mode: 'paper', buyAt: Date.now(), usdSize: perPickUsd,
        qty: perPickUsd / (pick.levels ? parseFloat(pick.levels.entry) : pick.price),
        fillPrice: pick.levels ? parseFloat(pick.levels.entry) : pick.price,
        buyOrderId: `PAPER_${Date.now()}`,
      };
      logAudit('mexc_paper_buy', { sym: symbol, usdSize: perPickUsd, fillPrice: pos.liveOrder.fillPrice });
      recordTradeOpen(pos, {
        mode: 'paper', orderId: pos.liveOrder.buyOrderId,
        qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.fillPrice, usdSize: perPickUsd,
      });
      await pushTradeLogToGitHub(loadTradeLog());
      await sendTelegram(
        `📝 *PAPER BUY* — ${pick.pair.replace('USDT','')} $${perPickUsd} USDT @ ~$${pos.liveOrder.fillPrice.toFixed(6)}\n` +
        `  Strategy: ${effectiveExecStrategy === 'topN' ? `top${picks.length} split` : 'top 1'}\n` +
        `  _Paper mode — no real order placed. Set TRADE\\_MODE=live to trade for real._`
      );
    } else {
      // Live mode — real MEXC market buy
      console.log(`  ⚡  LIVE BUY — ${symbol} $${perPickUsd} USDT via MEXC...`);
      try {
        const buy = await mexcMarketBuy(MEXC_API_KEY, MEXC_API_SECRET, symbol, perPickUsd);
        pos.liveOrder = {
          mode: 'live', buyAt: Date.now(), usdSize: perPickUsd,
          qty: buy.executedQty, fillPrice: buy.fillPrice, buyOrderId: buy.orderId,
        };
        logAudit('mexc_live_buy', { sym: symbol, usdSize: perPickUsd, qty: buy.executedQty, fillPrice: buy.fillPrice, orderId: buy.orderId });
        recordTradeOpen(pos, {
          mode: 'live', orderId: buy.orderId,
          qty: buy.executedQty, fillPrice: buy.fillPrice, usdSize: perPickUsd,
        });
        await pushTradeLogToGitHub(loadTradeLog());
        await sendTelegram(
          `⚡ *LIVE BUY PLACED* — ${pick.pair.replace('USDT','')} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${perPickUsd} USDT  Order ID: \`${buy.orderId}\`\n` +
          (effectiveExecStrategy === 'topN' ? `  Strategy: top${picks.length} split ($${effectiveUsdSize} ÷ ${picks.length})\n` : '') +
          `  Stop/T2 exits will close this position automatically.\n` +
          `  _Send /pause to halt further auto-buys_`
        );
      } catch (e) {
        logAudit('mexc_live_buy_failed', { sym: symbol, error: e.message });
        await sendTelegram(`🚨 *LIVE BUY FAILED* — ${symbol}\n  Error: ${e.message}\n  _No position opened on MEXC. Check API key and USDT balance._`);
      }
    }
  }
}

// ── Single entry point the orchestrator calls ──
// ctx: { candidates, positions, market, tradeState, closedOutcomes, utc,
//        effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount,
//        effectiveUsdSize, effectiveMaxLive, ranked, showRecoTags }
// Returns { changed } — whether `positions` was mutated (caller persists/pushes either way, but
// this lets the caller log/branch on it if desired).
export async function executeTradeCycle(ctx) {
  const { changed: rotationChanged } = await executeRotation(ctx);

  await executeAutoBuys(ctx);

  return { changed: rotationChanged };
}
