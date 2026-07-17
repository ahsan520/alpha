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

import { mexcMarketBuy, mexcMarketSell, mexcFreeBalance, mexcGetAllBalances, getBaseSizePrecision, floorToStep, mexcPlaceStopLimit } from './mexc-client.js';
import { closeLiveOrder, countLiveOpenPositions } from './position-monitor.js';
import { sendTelegram } from './telegram-commands.js';
import {
  logAudit, MEXC_API_KEY, MEXC_API_SECRET,
  loadTradeLog, recordTradeOpen, pushTradeLogToGitHub,
  loadPaperBalance, adjustPaperBalance,
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

// ── Minimum grade required to actually move real money ──
// 'recommended' (top-ranked by rankScore = conviction + bullConf, plus a
// history bonus) does NOT by itself require a strong grade — a symbol can
// rank #1 this cycle purely on current signal strength while its own
// grade (calcGrade, from bullConf + whaleScore) still reads B or C. This
// gate adds a hard floor so buys and rotation-sells only fire on A/A+
// setups; a weaker recommended pick still shows up starred in the
// Telegram alert and Position Tracker as informational, it just isn't
// traded. Especially important with LB_RECO_MIN_SIGNALS=1, where a single
// mediocre-grade signal would otherwise be enough to rotate and buy.
// Set via repo Variable EXEC_MIN_GRADE: 'A' (default — A or A+ both pass),
// 'A+' (A+ only), or 'off' (no gate — every recommended pick is tradeable).
const EXEC_MIN_GRADE = (process.env.EXEC_MIN_GRADE || 'A').toUpperCase();
function meetsGradeGate(grade) {
  if (EXEC_MIN_GRADE === 'OFF') return true;
  if (EXEC_MIN_GRADE === 'A+')  return grade === 'A+';
  return grade === 'A' || grade === 'A+';
}

// Never treat these as "open positions" to rotate out of — they're buying
// power, not a trade.
const QUOTE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'FDUSD']);


// ── Rotation — sell anything held that's not in THIS cycle's buy alert ──
// Fires on ANY cycle where a star-pick/topN buy alert actually fires. Rule
// is strict and uniform for every currently-held position (tracked or not):
//   - base symbol IS one of this cycle's buy-alert candidates → PROTECTED,
//     left alone.
//   - base symbol is NOT one of this cycle's candidates → sold now, to fund
//     the new pick(s) — including a position that's already hit T1 and is
//     being held for T2. Only a symbol actually named in today's alert
//     survives; "still looks strong on its own" is not enough.
// In LIVE mode this is reconciled against the REAL MEXC account balance, not
// just positions.json — so a coin bought manually outside the bot (which the
// bot would otherwise have no idea about) is still seen and rotated exactly
// like a bot-opened position. Paper mode has no real balance to check
// against, so it still uses positions.json only.
// Stop-loss exits are entirely separate (position-monitor.js) and are
// unaffected by any of this — but note the exchange-side stop for a
// rotated-out position gets cancelled here via closeLiveOrder's own
// reconciliation logic before the rotation sell executes.
async function executeRotation({ ranked, showRecoTags, effectiveExecStrategy, effectiveTopNCount, positions, market, tradeState, effectiveTradeMode, closedOutcomes, utc }) {
  let changed = false;

  const allStarred = (ranked || []).filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && meetsGradeGate(r.a.entry.grade)
  );
  const rotationPicks = effectiveExecStrategy === 'topN'
    ? (effectiveTopNCount ? allStarred.slice(0, effectiveTopNCount) : allStarred)
    : allStarred.slice(0, 1);

  const shouldRotate = showRecoTags
    && rotationPicks.length > 0
    && effectiveTradeMode !== 'off'
    && tradeState.tradingEnabled;

  const rotationCandidates = rotationPicks.map(r => r.a); // shape compatible with old {pair, entry} usage below

  if (!shouldRotate) return { changed, rotationCandidates: [] };

  // Bases that qualify as this cycle's top A/A+ picks — anything currently
  // held that's already one of these is left alone; everything else gets
  // sold to fund the new picks. Protection is strict: a held symbol must be
  // one of THIS cycle's actual buy-alert candidates to survive. A symbol
  // that merely still reads A/A+ grade on its own (but isn't in today's
  // alert) is NOT protected — it gets sold like anything else, including a
  // position that's already hit T1. This applies uniformly whether the
  // held position was ever tracked by the bot or bought manually.
  const topBases = new Set(rotationCandidates.map(c => c.pair.replace(/[^A-Z]/g, '').replace(/USDT$/, '')));
  const gradeStillTop = (base) => topBases.has(base);

  const sellTargets = []; // [{ base, sym, freeQty?, pos?, key? }]

  if (effectiveTradeMode === 'live') {
    // Reconcile against the REAL exchange, not just positions.json — this is
    // what lets rotation see a coin bought manually outside the bot (or one
    // whose tracked qty drifted from reality) as a genuine open position.
    let balances = [];
    try {
      balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
    } catch (e) {
      console.log(`  ⚠️  Rotation: couldn't fetch MEXC balances (${e.message}) — falling back to tracked positions only`);
    }
    const seenBases = new Set();
    for (const bal of balances) {
      const base = bal.asset;
      if (QUOTE_ASSETS.has(base) || isNoTradeSymbol(base + 'USDT')) continue;
      if (gradeStillTop(base)) continue; // protected — still a top pick, leave it
      seenBases.add(base);
      const trackedEntry = Object.entries(positions).find(
        ([, p]) => p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      );
      sellTargets.push({ base, sym: base + 'USDT', freeQty: bal.free, pos: trackedEntry?.[1], key: trackedEntry?.[0] });
    }
    // A tracked live position that didn't show up in the balance query at
    // all (already at 0 on the exchange, but positions.json still has it
    // open) still needs resolving so it doesn't sit stuck — route it through
    // closeLiveOrder below, which reports "0 balance" clearly instead of
    // leaving a ghost entry.
    for (const [key, p] of Object.entries(positions)) {
      if (p.assetType !== 'crypto' || p.liveOrder?.mode !== 'live' || p.liveOrder?.closedAt) continue;
      if (['stopped', 'tp2_hit'].includes(p.status)) continue;
      if (seenBases.has(p.base) || gradeStillTop(p.base)) continue;
      sellTargets.push({ base: p.base, sym: p.base + 'USDT', freeQty: 0, pos: p, key });
    }
  } else {
    // Paper mode has no real exchange balance to reconcile against — use
    // tracked positions.json only, same as before.
    for (const [key, p] of Object.entries(positions)) {
      if (p.assetType !== 'crypto' || p.liveOrder?.mode !== 'paper' || p.liveOrder?.closedAt) continue;
      if (['stopped', 'tp2_hit'].includes(p.status)) continue;
      if (gradeStillTop(p.base)) continue;
      sellTargets.push({ base: p.base, sym: p.base + 'USDT', pos: p, key });
    }
  }

  if (!sellTargets.length) return { changed, rotationCandidates };

  console.log(`  🔄  ROTATION — ${rotationCandidates.map(c => c.pair).join(', ')} qualify → selling ${sellTargets.length} position(s) first`);
  const rotationSells = [];

  for (const target of sellTargets) {
    const { base, sym, pos, key } = target;
    const sellAlerts = [];
    const wasHoldingT1 = pos?.status === 'tp1_hit' && !pos?.exitPrice;
    const mData = (market.symbols || {})[sym];
    const marketPrice = parseFloat(mData?.d?.p || pos?.entryPrice || 0);

    if (pos) {
      // Tracked position — reuse the existing safe closeLiveOrder path (handles
      // paper vs live, re-checks the real balance, records the trade-log close).
      pos.exitPrice = marketPrice;
      const closeResult = await closeLiveOrder(pos, wasHoldingT1 ? 'rotation — no longer top grade' : 'rotation', sellAlerts);
      const isLiveCrypto = pos.assetType === 'crypto' && pos.liveOrder?.mode === 'live';

      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;
        rotationSells.push({ base, skipped: true, reason: closeResult.reason });
        for (const m of sellAlerts) await sendTelegram(m);
        continue;
      }

      const finalExitPrice = pos.liveOrder?.exitFillPrice || marketPrice;
      const pnlPct = pos.entryPrice > 0
        ? parseFloat(((finalExitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2))
        : 0;

      closedOutcomes.push({
        base, pair: base + 'USDT',
        outcome: wasHoldingT1 ? 'rotation_t1_downgrade' : 'rotation', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct, closedAt: Date.now(),
      });
      rotationSells.push({ base, pnlPct, wasHoldingT1 });

      if (wasHoldingT1) {
        // No longer top-grade — remove now rather than waiting on the usual
        // TERMINAL_EVICT_MS window, so the slot/capital frees immediately.
        delete positions[key];
      } else {
        pos.status          = 'stopped'; // treated as a close
        pos.statusChangedAt = Date.now();
        pos.exitPrice       = finalExitPrice;
        pos.rotatedOut      = true;
      }
      changed = true;
      for (const m of sellAlerts) await sendTelegram(m);
    } else {
      // Untracked — a real MEXC balance with no matching positions.json entry
      // (e.g. bought manually outside the bot). Sell it directly; there's no
      // buy record in the trade journal for it since the bot never placed
      // that buy, so this can't be logged as a P&L close, only as a sell.
      try {
        const step    = await getBaseSizePrecision(sym);
        const sellQty = floorToStep(target.freeQty, step);
        if (sellQty <= 0) {
          rotationSells.push({ base, skipped: true, reason: 'zero_balance' });
          continue;
        }
        const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, sym, sellQty);
        logAudit('mexc_sell_untracked', { sym, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId });
        await sendTelegram(
          `🟢 *LIVE SELL (untracked)* — closed ${sellQty} ${base} @ $${sell.fillPrice.toFixed(6)} on MEXC\n` +
          `  _No matching bot buy record for this — likely bought manually. Sold to make room for the new A/A+ pick(s); no P&L entry in the journal._`
        );
        rotationSells.push({ base, untracked: true });
        changed = true;
      } catch (e) {
        logAudit('mexc_sell_untracked_failed', { sym, error: e.message });
        await sendTelegram(`🚨 *LIVE SELL FAILED (untracked)* — ${base}: ${e.message} — CLOSE MANUALLY on MEXC.`);
        rotationSells.push({ base, skipped: true, reason: 'error' });
      }
    }
  }

  const sellSummary = rotationSells
    .map(r => r.skipped
      ? `${r.base} SKIPPED (${r.reason === 'zero_balance' ? '0 balance' : r.reason})`
      : r.untracked
        ? `${r.base} sold (untracked)`
        : `${r.base} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%${r.wasHoldingT1 ? ' (T1 hold, lost A/A+)' : ''}`)
    .join(', ');
  const anySkipped = rotationSells.some(r => r.skipped);
  await sendTelegram(
    `🔄 *ROTATION* — ${utc}\n` +
    `  ${sellSummary}\n` +
    `  Rotating into: ${rotationCandidates.map(c => c.entry.grade + ' ' + c.pair.replace('USDT', '')).join(', ')}\n` +
    (anySkipped ? `  ⚠️ _Some sells were skipped — see alert above. That position stays tracked/open and will retry next cycle._\n` : '') +
    `  _Fresh topN buy alert — rotating positions_`
  );
  logAudit('rotation_sell', { sold: rotationSells, into: rotationCandidates.map(c => c.pair) });

  return { changed, rotationCandidates };
}

// ── Adopts manually-bought MEXC holdings into bot tracking ──
// A coin bought directly on MEXC (outside the bot) has no positions.json
// entry, no bot-placed stop, and is invisible to monitorPositions' T1/T2/
// stop/exit checks — those only ever look at positions.json. Left
// untracked, it would only ever get sold as a side effect of ROTATION
// (see executeRotation's "untracked" branch above), and only once a
// DIFFERENT symbol becomes the new pick — never on its own T1/T2/exit
// signal, and never protected by a stop.
//
// Called every live-mode cycle, before the buy-signal scan: any live MEXC
// balance with no matching non-terminal positions.json entry gets a
// synthetic tracking record created for it — entry price = current market
// price, since the bot has no way to know the real historical buy price —
// plus an immediate real exchange-side stop. From the next monitorPositions
// pass onward it's managed exactly like a bot-opened position: T1/T2/stop/
// exit-signal all apply normally. It also can never get double-bought,
// since the open-position gate in the scan loop sees it as already-tracked
// the moment this function runs.
//
// P&L on an adopted position is measured from the ADOPTION price, not the
// real cost basis — the Telegram alert says so explicitly so it's never
// mistaken for the real entry/PnL.
export async function adoptManualHoldings({ positions, market, evaluateSymbol, calcEntryLevels }) {
  let changed = false;
  let balances = [];
  try {
    balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
  } catch (e) {
    console.log(`  ⚠️  Manual-holding adoption: couldn't fetch MEXC balances (${e.message})`);
    return { positions, changed };
  }

  for (const bal of balances) {
    const base = bal.asset;
    if (QUOTE_ASSETS.has(base) || isNoTradeSymbol(base + 'USDT')) continue;
    if (bal.free <= 0) continue; // nothing sellable — fully locked elsewhere, skip
    const sym = base + 'USDT';

    const alreadyTracked = Object.values(positions).some(p =>
      p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      && !['stopped', 'tp2_hit'].includes(p.status)
      && !(p.status === 'tp1_hit' && p.exitPrice)
    );
    if (alreadyTracked) continue; // bot-bought or already adopted — leave it

    const entry = (market.symbols || {})[sym];
    if (!entry || entry.assetType !== 'crypto') {
      console.log(`  ⚠️  ${base} held on MEXC but not in market-data.json — can't compute stop/T1/T2, skipping adoption this cycle`);
      continue;
    }

    const evald  = evaluateSymbol(entry);
    const levels = calcEntryLevels(entry.price, evald.shock);

    const usdSizeEst = parseFloat((bal.free * entry.price).toFixed(2));
    positions[sym] = {
      sym, base, assetType: 'crypto',
      exchangePrefix: entry.exchangePrefix, session: entry.session,
      setup: evald.setup.label, dir: evald.setup.label === 'SHORT SETUP' ? 'bear' : 'bull',
      alertedAt: Date.now(), holdLockUntil: 0,
      entryPrice: parseFloat(levels.entry), stop: parseFloat(levels.stop),
      t1: parseFloat(levels.t1), t2: parseFloat(levels.t2),
      score: evald.conv, spikeScore: evald.shock,
      exitAlertedAt: null, tier1AlertedAt: null,
      status: 'watching', source: 'manual_adopted', scoreSource: evald.source,
      recommended: false,
      liveOrder: {
        mode: 'live', buyAt: Date.now(), usdSize: usdSizeEst,
        qty: bal.free, fillPrice: entry.price, buyOrderId: `MANUAL_ADOPTED_${Date.now()}`,
        adopted: true,
      },
    };
    logAudit('manual_position_adopted', { sym, base, qty: bal.free, entryPrice: entry.price, stop: levels.stop });
    changed = true;

    recordTradeOpen(positions[sym], {
      mode: 'live', orderId: positions[sym].liveOrder.buyOrderId,
      qty: bal.free, fillPrice: entry.price, usdSize: usdSizeEst,
    });
    await pushTradeLogToGitHub(loadTradeLog());

    await placeExchangeStop(positions[sym], sym);

    await sendTelegram(
      `🔍 *MANUAL POSITION ADOPTED* — ${base}\n` +
      `  Found ${bal.free} ${base} on MEXC with no bot tracking — now under bot management.\n` +
      `  Adoption price $${entry.price}  Stop $${levels.stop}  T1 $${levels.t1}  T2 $${levels.t2}\n` +
      (positions[sym].liveOrder.stopOrderId
        ? `  🛡 Exchange stop placed.\n`
        : `  ⚠️ Exchange stop NOT placed — software stop check will cover it as a fallback.\n`) +
      `  _P&L tracked from this adoption price, not your real buy price — the bot has no way to know your actual cost basis._`
    );
  }

  return { positions, changed };
}

// ── Star-pick auto-buy ──
//
// Two execution strategies (GUI toggle → trade-state.json, OR repo Variables
// EXEC_STRATEGY / EXEC_TOP_N_COUNT as the durable default the GUI overrides):
//   'top1'  — buy only the ⭐ #1 ranked symbol, full order size
//   'topN'  — buy the top EXEC_TOP_N_COUNT starred symbols (e.g. 2 or 3;
//             unset/0 = every currently-starred symbol, uncapped),
//             order size split equally
//             e.g. $75 / 3 picks = $25 each — this split is a fixed rule,
//             not a separate config value (top1 is always 100% of size)
//
// Order size itself has two modes (TRADE_SIZE_MODE / GUI toggle):
//   'usd'     — fixed-dollar TRADE_USD_SIZE, unchanged from before
//   'percent' — TRADE_SIZE_PCT% of available balance, fetched fresh each
//               cycle (live: real MEXC USDT balance; paper: tracked virtual
//               balance in paper-balance.json). 100% + topN splits the WHOLE
//               balance across picks. A profitable close feeds straight back
//               into the balance, so the NEXT buy compounds automatically.
//
// Gates (per-symbol, all must pass):
//   1. TRADE_MODE is 'paper' or 'live' (not 'off')
//   2. tradingEnabled flag (Telegram /pause kill-switch)
//   3. Symbol is in the ⭐ recommended set (showRecoTags fired)
//   4. Not already holding too many live open trades (TRADE_MAX_CONCURRENT_LIVE)
//   5. Idempotency: positions[sym].liveOrder not already set
// ── Places an exchange-side stop-loss immediately after a live buy fills ──
// Failure here does NOT fail the buy — the position stays open and the
// existing 15-min software stop check (position-monitor.js) still watches
// it as a fallback. But it does mean that fallback is the ONLY protection
// until the next successful attempt, so this alerts loudly on failure.
const STOP_SLIPPAGE_PAD = parseFloat(process.env.MEXC_STOP_SLIPPAGE_PAD || '0.005'); // 0.5% below stop
async function placeExchangeStop(pos, symbol) {
  if (!pos.stop || pos.stop <= 0) return;
  try {
    const step = await getBaseSizePrecision(symbol);
    const qty  = floorToStep(pos.liveOrder.qty, step);
    if (qty <= 0) return;
    const dp         = pos.stop < 1 ? 6 : pos.stop < 10 ? 4 : 2;
    const stopPrice  = pos.stop.toFixed(dp);
    const limitPrice = (pos.stop * (1 - STOP_SLIPPAGE_PAD)).toFixed(dp);
    const order = await mexcPlaceStopLimit(MEXC_API_KEY, MEXC_API_SECRET, symbol, qty, stopPrice, limitPrice);
    pos.liveOrder.stopOrderId = order.orderId;
    pos.liveOrder.stopPrice   = parseFloat(stopPrice);
    pos.liveOrder.stopLimit   = parseFloat(limitPrice);
    logAudit('mexc_stop_placed', { sym: symbol, qty, stopPrice, limitPrice, orderId: order.orderId });
  } catch (e) {
    logAudit('mexc_stop_place_failed', { sym: symbol, error: e.message });
    await sendTelegram(
      `⚠️ *STOP ORDER NOT PLACED* — ${pos.base}\n` +
      `  Buy succeeded but the exchange-side stop failed: ${e.message}\n` +
      `  _The 15-min software stop check is still watching this position as a fallback — verify manually on MEXC if you rely on the exchange stop._`
    );
  }
}

async function executeAutoBuys({
  ranked, showRecoTags, positions, tradeState,
  effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount, effectiveUsdSize, effectiveMaxLive,
  effectiveSizeMode, effectiveSizePct, effectiveGuardSizeMult = 1,
  utc,
}) {
  if (effectiveTradeMode === 'off' || !showRecoTags) return;

  // MEXC is crypto-only — stocks/ETFs can be starred/recommended for the
  // Telegram alert and GUI, but must never be routed to a MEXC order. Without
  // this filter, a starred stock pick (e.g. TSX:ETHY.TO) would fall through
  // to the symbol-building logic below and produce a garbage MEXC pair.
  const allStarred = ranked.filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && meetsGradeGate(r.a.entry.grade)
  );

  // Recommended picks that exist but got filtered out purely on grade —
  // surfaced once here so "nothing bought" has an obvious explanation
  // instead of looking like a silent failure.
  const gradeSkipped = ranked.filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && !meetsGradeGate(r.a.entry.grade)
  );
  if (gradeSkipped.length && !allStarred.length) {
    const list = gradeSkipped.map(r => `${r.a.pair.replace('USDT','')} (${r.a.entry.grade || '—'})`).join(', ');
    console.log(`  🚫  No buy — recommended pick(s) below EXEC_MIN_GRADE=${EXEC_MIN_GRADE}: ${list}`);
    logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`grade below EXEC_MIN_GRADE (${EXEC_MIN_GRADE})`], symbols: gradeSkipped.map(r => r.a.pair) });
    await sendTelegram(`🚫 *NO BUY* — ${list} ranked #1 but grade is below EXEC_MIN_GRADE (${EXEC_MIN_GRADE}) — skipped, no positions touched.`);
  }
  // 'topN' buys effectiveTopNCount picks (e.g. 2 or 3) if that repo Variable
  // is set; unset/0 falls back to the original behavior of every starred
  // symbol, uncapped.
  const picks = effectiveExecStrategy === 'topN'
    ? (effectiveTopNCount ? allStarred.slice(0, effectiveTopNCount) : allStarred)
    : allStarred.slice(0, 1);

  // ── Total USD allocated this cycle ──
  // 'usd'     → effectiveUsdSize is already a fixed dollar figure (unchanged
  //             behavior).
  // 'percent' → effectiveSizePct% of available balance, fetched fresh each
  //             cycle. 100% + topN naturally splits the WHOLE balance across
  //             picks below, same as the dollar case. Live mode reads the
  //             real MEXC USDT balance (so a profitable close compounds
  //             straight into the next buy's size); paper mode reads the
  //             tracked virtual paper balance (credited/debited by
  //             position-monitor.js) for the same compounding behavior.
  let totalUsd = effectiveUsdSize;
  if (effectiveSizeMode === 'percent') {
    const balance = effectiveTradeMode === 'live'
      ? await mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, 'USDT')
      : loadPaperBalance();
    totalUsd = parseFloat((balance * (effectiveSizePct / 100) * effectiveGuardSizeMult).toFixed(2));
    console.log(`  💰  Sizing: ${effectiveSizePct}% of ${effectiveTradeMode} balance $${balance.toFixed(2)}${effectiveGuardSizeMult < 1 ? ` ×${effectiveGuardSizeMult} (market guard)` : ''} = $${totalUsd}`);
    if (totalUsd <= 0) {
      console.log(`  🚫  Skipping buys — $0 available (balance $${balance.toFixed(2)})`);
      logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`zero balance (${effectiveTradeMode})`] });
      return;
    }
  }

  const perPickUsd = effectiveExecStrategy === 'topN' && picks.length > 1
    ? parseFloat((totalUsd / picks.length).toFixed(2))
    : totalUsd;

  console.log(`  ⚡  Exec strategy: ${effectiveExecStrategy} (${effectiveSizeMode === 'percent' ? effectiveSizePct + '%' : '$' + effectiveUsdSize}) — ${picks.length} pick(s) @ $${perPickUsd} each`);

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
      if (effectiveSizeMode === 'percent') adjustPaperBalance(-perPickUsd);
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
          qtyEstimated: buy.estimated || false,
        };
        logAudit('mexc_live_buy', { sym: symbol, usdSize: perPickUsd, qty: buy.executedQty, fillPrice: buy.fillPrice, orderId: buy.orderId, estimated: buy.estimated });
        recordTradeOpen(pos, {
          mode: 'live', orderId: buy.orderId,
          qty: buy.executedQty, fillPrice: buy.fillPrice, usdSize: perPickUsd,
        });
        await pushTradeLogToGitHub(loadTradeLog());

        // Exchange-side stop-loss — placed right after the buy fills so the
        // position is protected on MEXC itself, not just by the 15-min
        // software check. Skipped if buy.estimated — we don't yet trust the
        // qty enough to size a resting sell order off it; the software stop
        // still covers the position until a later cycle confirms the real
        // fill quantity.
        if (!buy.estimated) await placeExchangeStop(pos, symbol);

        await sendTelegram(
          `⚡ *LIVE BUY PLACED* — ${pick.pair.replace('USDT','')} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty}${buy.estimated ? ' (estimated — MEXC did not report a fill qty)' : ''} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${perPickUsd} USDT  Order ID: \`${buy.orderId}\`\n` +
          (effectiveExecStrategy === 'topN' ? `  Strategy: top${picks.length} split ($${effectiveUsdSize} ÷ ${picks.length})\n` : '') +
          (pos.liveOrder.stopOrderId
            ? `  🛡 Exchange stop placed: sell ${buy.executedQty} @ trigger $${pos.liveOrder.stopPrice} (limit $${pos.liveOrder.stopLimit})\n`
            : `  ⚠️ Exchange stop NOT placed — see warning above. Software stop check still active.\n`) +
          `  Stop/T2 exits will close this position automatically.\n` +
          (buy.estimated ? `  ⚠️ _MEXC didn't confirm a fill quantity yet — verify the actual holding on MEXC matches before trusting auto-sells._\n` : '') +
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
