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

import { mexcMarketBuy, mexcMarketSell, mexcFreeBalance, mexcGetAllBalances, getBaseSizePrecision, floorToStep } from './mexc-client.js';
import { closeLiveOrder, countLiveOpenPositions } from './position-monitor.js';
import { buildSymKey } from './exchange-registry.js';
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

// Same threshold + env var as position-monitor.js's closeLiveOrder dust
// guard — a balance worth less than this can't be sold on MEXC at all, so
// skip attempting it here too rather than retrying (and re-alerting) a
// doomed order every rotation cycle.
const MIN_SELL_NOTIONAL_USDT = parseFloat(process.env.MEXC_MIN_SELL_NOTIONAL_USDT || '1');


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

  // Bases that qualify as this cycle's top A/A+ picks — the STRICT rule:
  // anything currently held that's already one of these is always left
  // alone, at any hold time.
  const topBases = new Set(rotationCandidates.map(c => c.pair.replace(/[^A-Z]/g, '').replace(/USDT$/, '')));
  const gradeStillTop = (base) => topBases.has(base);

  // ── Guard 1: minimum hold time ──
  // Stage 1 (< ROTATION_MIN_HOLD_MIN since buy): UNCONDITIONALLY protected
  // — a fresh buy is never rotated out purely because a different symbol
  // outranks it one cycle later. Stage 2 (past the window): this
  // protection expires; only gradeStillTop (above) and Guard 2 (below) can
  // still protect it.
  const ROTATION_MIN_HOLD_MIN = parseFloat(process.env.ROTATION_MIN_HOLD_MIN || '30');
  const withinMinHold = (pos) => {
    if (!pos?.liveOrder?.buyAt || ROTATION_MIN_HOLD_MIN <= 0) return false;
    return (Date.now() - pos.liveOrder.buyAt) / 60000 < ROTATION_MIN_HOLD_MIN;
  };

  // ── Guard 2: never rotate out a position that isn't MEANINGFULLY profitable ──
  // Rotation may only sell a held position to fund a new A/A+ pick if that
  // position's CURRENT price clears its own buy price by at least
  // ROTATION_MIN_PROFIT_PCT. A position at/below that margin is left alone
  // regardless of rank/grade — it can only be closed by its own stop, T1,
  // or T2 (evaluated separately, upstream, in monitorPositions/STEP 1 —
  // never by rotation). This trades "may hold a stale/mediocre position
  // longer, occupying a live slot" for "never lock in a rotation-driven
  // loss on a position that hasn't hit its own stop" — a deliberate choice
  // given the trade-log review showing rotation churn (not stop hits) as
  // the more frequent source of small losses.
  //
  // The margin matters, not just the sign: a rotation sell is a real market
  // order paying real fees on both legs (the original buy + this sell),
  // plus slippage. A position that's only fractionally above its fill price
  // (the old ">= buyPrice" check) reads as "profitable" on paper but nets a
  // realized LOSS the instant fees are applied — exactly the outcome this
  // guard exists to prevent. ROTATION_MIN_PROFIT_PCT sets the buffer above
  // fill price required before rotation is allowed to touch it; tune it to
  // comfortably clear your actual MEXC round-trip fee + expected slippage.
  //
  // Requires a current price from market.symbols to evaluate; if
  // unavailable, this guard has no opinion (falls through to the other
  // guards) rather than blocking or allowing by default.
  const ROTATION_MIN_PROFIT_PCT = parseFloat(process.env.ROTATION_MIN_PROFIT_PCT || '0.5');
  const currentlyAtOrAboveBuy = (base, pos) => {
    const buyPrice = pos?.liveOrder?.fillPrice;
    if (!buyPrice) return null; // no opinion — no buy price on record to compare against
    const cur = (market.symbols || {})[base + 'USDT']?.price;
    if (cur === undefined || cur === null) return null; // no opinion — no current price available
    return parseFloat(cur) >= parseFloat(buyPrice) * (1 + ROTATION_MIN_PROFIT_PCT / 100);
  };

  // ── Guard 3: holding for T2, and still shows up as A/A+ today ──
  // A position that already hit T1 and is being held for T2 (status
  // 'tp1_hit' with NO exitPrice — see position-monitor.js's dual-state
  // handling; a tp1_hit WITH exitPrice is already closed and not a live
  // position at all) is protected from rotation if it appears ANYWHERE on
  // today's A/A+ starred list — NOT just the capacity-limited top-N slice
  // (topBases/gradeStillTop, above). This is the meaningful difference
  // from gradeStillTop: a T1-holding position that still reads A/A+ but
  // ranked #3 when only the top 2 get bought (EXEC_TOP_N_COUNT) would
  // otherwise lose protection purely due to a slot-count limit, not
  // because today's signal actually stopped liking it. A T1-holding
  // position that's dropped OUT of the A/A+ starred list entirely still
  // falls through to Guard 2 (protected if at/above buy price — which,
  // having passed T1, it almost certainly still is) or its own stop/T2
  // exit upstream.
  const allStarredBases = new Set(allStarred.map(r => r.a.pair.replace(/[^A-Z]/g, '').replace(/USDT$/, '')));
  const isHoldingT1AndStillStarred = (base, pos) =>
    pos?.status === 'tp1_hit' && !pos?.exitPrice && allStarredBases.has(base);

  // Combined: protected if it's today's actual top pick, OR still within
  // the hold window, OR currently below its own buy price (Guard 2 returns
  // null = "no opinion" when it can't evaluate, which correctly does NOT
  // protect — falls through to selling, same as previous behavior when
  // price/buyPrice data is simply unavailable).
  const isProtected = (base, pos) => {
    if (gradeStillTop(base)) return true;
    if (withinMinHold(pos)) return true;
    if (isHoldingT1AndStillStarred(base, pos)) return true;
    const atOrAboveBuy = currentlyAtOrAboveBuy(base, pos);
    if (atOrAboveBuy === false) return true; // below buy price — protected from rotation, only own stop/T1/T2 can close it
    return false;
  };

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
      const trackedEntry = Object.entries(positions).find(
        ([, p]) => p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      );
      if (isProtected(base, trackedEntry?.[1])) continue; // protected — top pick, recent buy, or currently below buy price
      seenBases.add(base);
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
      if (seenBases.has(p.base) || isProtected(p.base, p)) continue;
      sellTargets.push({ base: p.base, sym: p.base + 'USDT', freeQty: 0, pos: p, key });
    }
  } else {
    // Paper mode has no real exchange balance to reconcile against — use
    // tracked positions.json only, same as before.
    for (const [key, p] of Object.entries(positions)) {
      if (p.assetType !== 'crypto' || p.liveOrder?.mode !== 'paper' || p.liveOrder?.closedAt) continue;
      if (['stopped', 'tp2_hit'].includes(p.status)) continue;
      if (isProtected(p.base, p)) continue;
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

        // ── Dust guard — checked BEFORE the zero-balance branch below ──
        // Evaluated against the REAL freeQty, not sellQty — a tiny leftover
        // that floors to 0 sellable units still needs to be recognized as
        // dust (not "zero balance, retry forever"). Same fix as
        // closeLiveOrder in position-monitor.js.
        const estNotional = target.freeQty * marketPrice;
        if (marketPrice > 0 && target.freeQty > 0 && estNotional < MIN_SELL_NOTIONAL_USDT) {
          logAudit('mexc_sell_skipped_dust', { sym, reason: 'rotation_untracked', freeQty: target.freeQty, estNotional });
          await sendTelegram(
            `🧹 *DUST IGNORED (untracked)* — ${target.freeQty} ${base} (~$${estNotional.toFixed(4)}) is below MEXC's $${MIN_SELL_NOTIONAL_USDT} minimum sell (or its lot-size step) — leaving it on the exchange.`
          );
          rotationSells.push({ base, skipped: true, reason: 'dust_ignored' });
          continue;
        }

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
        // Fallback: MEXC itself rejected it as under-minimum even though our
        // pre-check (stale/zero marketPrice) didn't catch it — treat the same.
        if (/minimum transaction volume/i.test(e.message || '')) {
          logAudit('mexc_sell_skipped_dust', { sym, reason: 'rotation_untracked', error: e.message });
          await sendTelegram(`🧹 *DUST IGNORED (untracked)* — ${base}: MEXC rejected the sell as below its minimum notional — leaving it on the exchange.`);
          rotationSells.push({ base, skipped: true, reason: 'dust_ignored' });
          continue;
        }
        logAudit('mexc_sell_untracked_failed', { sym, error: e.message });
        await sendTelegram(`🚨 *LIVE SELL FAILED (untracked)* — ${base}: ${e.message} — CLOSE MANUALLY on MEXC.`);
        rotationSells.push({ base, skipped: true, reason: 'error' });
      }
    }
  }

  const reasonLabel = (r) => {
    if (r.reason === 'zero_balance')  return '0 balance';
    if (r.reason === 'dust_ignored')  return 'dust, below min sell';
    return r.reason;
  };
  const sellSummary = rotationSells
    .map(r => r.skipped
      ? `${r.base} SKIPPED (${reasonLabel(r)})`
      : r.untracked
        ? `${r.base} sold (untracked)`
        : `${r.base} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%${r.wasHoldingT1 ? ' (T1 hold, lost A/A+)' : ''}`)
    .join(', ');
  const anySkipped = rotationSells.some(r => r.skipped && r.reason !== 'dust_ignored');
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
    const bareSym = base + 'USDT';
    const sym = buildSymKey(bareSym); // normalized key (e.g. 'BINANCE:LINKUSDT') —
    // matches the format used by the buy-scan/leaderboard pipeline, so a
    // manually-adopted holding and a later signal for the same symbol land
    // under the SAME positions[] key instead of creating a duplicate
    // tracked entry. market.symbols itself is keyed by the BARE pair
    // (confirmed against market-data.json), so that lookup below
    // deliberately still uses bareSym, not sym.

    const alreadyTracked = Object.values(positions).some(p =>
      p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      && !['stopped', 'tp2_hit'].includes(p.status)
      && !(p.status === 'tp1_hit' && p.exitPrice)
    );
    if (alreadyTracked) continue; // bot-bought or already adopted — leave it

    const entry = (market.symbols || {})[bareSym];
    if (!entry || entry.assetType !== 'crypto') {
      console.log(`  ⚠️  ${base} held on MEXC but not in market-data.json — can't compute stop/T1/T2, skipping adoption this cycle`);
      continue;
    }

    // Dust guard — checked BEFORE adoption, not after. Without this, a
    // balance too small to ever sell (e.g. a leftover fraction from a
    // previous partial sell) gets adopted and alerted about, then
    // immediately closed out as dust by the sell-side guard on its very
    // next monitoring pass, then re-adopted again next cycle since
    // adoption has no memory of having already dismissed it — an endless
    // loop of "MANUAL POSITION ADOPTED" noise for a balance that will
    // never be worth anything. Same threshold used by every other dust
    // check in this codebase (MEXC_MIN_SELL_NOTIONAL_USDT, default $1).
    const estNotionalPreAdopt = bal.free * (entry.price || 0);
    if (entry.price > 0 && estNotionalPreAdopt < MIN_SELL_NOTIONAL_USDT) {
      logAudit('adoption_skipped_dust', { sym, base, free: bal.free, estNotional: estNotionalPreAdopt });
      continue; // silent, no Telegram alert — this is expected/routine, not worth a message every cycle
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

    await sendTelegram(
      `🔍 *MANUAL POSITION ADOPTED* — ${base}\n` +
      `  Found ${bal.free} ${base} on MEXC with no bot tracking — now under bot management.\n` +
      `  Adoption price $${entry.price}  Stop $${levels.stop}  T1 $${levels.t1}  T2 $${levels.t2}\n` +
      `  🛡 Watched by the 15-min software stop check.\n` +
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
// ── NOTE: exchange-side stop-loss removed ──
// MEXC's /api/v3/order endpoint only accepts type LIMIT or MARKET — there is
// no stopPrice param and no OCO/stop endpoint in MEXC's documented spot v3
// API (confirmed against MEXC's own API docs). The previous STOP_LOSS_LIMIT
// attempt here was Binance-endpoint naming that MEXC has never supported, so
// it failed on every single live buy (HTTP 400 "invalid type"). Removed —
// the 15-min software stop check in position-monitor.js is the only stop
// mechanism MEXC's API allows, and is now PRIMARY, not a fallback.

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
    // Reserve a small buffer even at TRADE_SIZE_PCT=100 — with zero margin,
    // independent .toFixed(2) rounding on totalUsd and each perPickUsd slice
    // can sum to a cent or two MORE than the real balance, and MEXC's own
    // internal balance check for a quoteOrderQty buy can be marginally
    // stricter than the "free" figure this just queried. Without a buffer,
    // that reliably surfaces as "Insufficient position" (MEXC code 30004 —
    // actually insufficient funds, not a real "position" issue) on the
    // SECOND (or later) buy in a multi-pick cycle, since the first buy
    // already consumed real balance before this rounding gap gets exposed.
    const SIZING_BUFFER_PCT = parseFloat(process.env.MEXC_SIZING_BUFFER_PCT || '1');
    const bufferedPct = Math.max(0, effectiveSizePct - SIZING_BUFFER_PCT);
    totalUsd = parseFloat((balance * (bufferedPct / 100) * effectiveGuardSizeMult).toFixed(2));
    console.log(`  💰  Sizing: ${bufferedPct}% of ${effectiveTradeMode} balance $${balance.toFixed(2)} (${effectiveSizePct}% target − ${SIZING_BUFFER_PCT}% buffer)${effectiveGuardSizeMult < 1 ? ` ×${effectiveGuardSizeMult} (market guard)` : ''} = $${totalUsd}`);
    if (totalUsd <= 0) {
      console.log(`  🚫  Skipping buys — $0 available (balance $${balance.toFixed(2)})`);
      logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`zero balance (${effectiveTradeMode})`] });
      return;
    }
  }

  const perPickUsd = effectiveExecStrategy === 'topN' && picks.length > 1
    ? Math.floor((totalUsd / picks.length) * 100) / 100 // floor, not round — slices must never sum above totalUsd
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

      // Alert specifically for max-live — this is the one case where a
      // starred, grade-passing pick gets silently dropped for a reason
      // that isn't obvious from the buy alert itself (unlike "already
      // holding this symbol", which is expected/routine every cycle).
      if (liveLock >= effectiveMaxLive) {
        await sendTelegram(
          `🚫 *NO BUY* — ${pick.pair.replace('USDT','')} ranked but already ${liveLock}/${effectiveMaxLive} live trades open — skipped, no positions touched.\n` +
          `  _Raise TRADE_MAX_CONCURRENT_LIVE if you want more concurrent positions._`
        );
      }
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

        await pushTradeLogToGitHub(loadTradeLog());

        await sendTelegram(
          `⚡ *LIVE BUY PLACED* — ${pick.pair.replace('USDT','')} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty}${buy.estimated ? ' (estimated — MEXC did not report a fill qty)' : ''} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${perPickUsd} USDT  Order ID: \`${buy.orderId}\`\n` +
          (effectiveExecStrategy === 'topN' ? `  Strategy: top${picks.length} split ($${effectiveUsdSize} ÷ ${picks.length})\n` : '') +
          `  🛡 Watched by the 15-min software stop check.\n` +
          `  Stop/T2 exits will close this position automatically.\n` +
          (buy.estimated ? `  ⚠️ _MEXC didn't confirm a fill quantity yet — verify the actual holding on MEXC matches before trusting auto-sells._\n` : '') +
          `  _Send /pause to halt further auto-buys_`
        );
      } catch (e) {
        logAudit('mexc_live_buy_failed', { sym: symbol, error: e.message });

        // The leaderboard-decider step earlier this cycle already created
        // a `positions[pick.sym]` tracking entry (status: 'watching',
        // entryPrice/stop/t1/t2 set) BEFORE this buy attempt ran — that's
        // how the buy-alert Telegram message and rank/caution tags get
        // written. If the real MEXC order then fails, that entry must not
        // be left behind: exit-monitoring doesn't distinguish "actually
        // holding this" from "was tracked, buy failed" — it would go on to
        // watch price against that phantom entryPrice/stop and eventually
        // fire a real stop-loss or T1 alert for a coin that was never
        // actually bought. Safe to delete unconditionally here: a symbol
        // only reaches this point if it was a brand-new signal this cycle
        // (any pre-existing open position for it would have been skipped
        // earlier in leaderboard-decider.js, never reaching buy execution
        // at all) — so this is always the just-created watching entry,
        // never a real prior holding.
        delete positions[pick.sym];

        await sendTelegram(`🚨 *LIVE BUY FAILED* — ${symbol}\n  Error: ${e.message}\n  _No position opened on MEXC — tracking entry removed, no phantom stop/T1 alerts will follow. Check API key and USDT balance._`);
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
