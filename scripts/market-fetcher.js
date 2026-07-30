// ══════════════════════════════════════════════════════════════════════════════
// market-fetcher.js — Job A (runs every 5 min)
// v10.9: uses exchange-registry for session gating and symbol routing.
//
// Changes from v10.8:
//   - getMarketSession() from exchange-registry replaces hardcoded .TO check.
//   - Stocks outside their regular session are frozen with marketClosed:true
//     and session tag — Job B skips them entirely (no stale alerts).
//   - Pre-market / after-hours stocks are scored but tagged session:'pre_market'
//     or 'after_hours' so Job B can respect LB_ALLOW_PRE_MARKET / LB_ALLOW_AH.
//   - Lunch-break stocks (TSE, HKEX) frozen same as closed.
//   - Crypto always scored (24/7).
//   - exchangePrefix derived from registry (LSE, XETRA, TSE, HKEX, NSE all work).
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { scoreSymbol, scoreStock, initYahoo } from './leaderboard-scanner.js';
import { resolveExchange, getMarketSession, EXCHANGES } from './exchange-registry.js';

const WATCHLIST_PATH   = path.join(process.cwd(), '..', 'watchlist.json');
const MARKET_DATA_PATH = path.join(process.cwd(), 'market-data.json');
const AUDIT_PATH       = path.join(process.cwd(), 'audit.json');

const STALE_MINUTES = 30;

// ── Resolve exchange prefix key (BINANCE, TSX, LSE …) ──
function exchangePrefixFor(sym) {
  const ex = resolveExchange(sym);
  return Object.entries(EXCHANGES).find(([, v]) => v === ex)?.[0] ?? 'NYSE';
}

function loadWatchlist() {
  try {
    const raw  = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    const crypto = list.filter(s => s.startsWith('BINANCE:')).map(s => s.replace('BINANCE:', ''));
    const stocks = list.filter(s => !s.startsWith('BINANCE:'));
    return { crypto, stocks };
  } catch {
    return { crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], stocks: [] };
  }
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(MARKET_DATA_PATH, 'utf8')); }
  catch { return { fetchedAt: 0, symbols: {} }; }
}

function saveMarketData(data) {
  fs.writeFileSync(MARKET_DATA_PATH, JSON.stringify(data, null, 2));
}

function logAudit(action, details = {}) {
  const entry = { timestamp: new Date().toISOString(), job: 'market-fetcher', action, ...details };
  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    if (!Array.isArray(logs)) logs = [];
  } catch {}
  logs.push(entry);
  const cutoff = Date.now() - 60 * 60 * 1000;
  logs = logs.filter(e => new Date(e.timestamp).getTime() >= cutoff);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

// ── Build/update a market-data.json entry ──
// Maintains peak shock/obi since Job B last consumed + reset them.
function buildEntry(r, prev, now, session) {
  const shock = r.d.shock || 1;
  const obi   = r.d.obi   || 0;

  // ── Persistent bull4hCount ──
  // Counts CONSECUTIVE fetch cycles (this job runs every 5 min) where
  // bias4h has NOT read as bearish — used downstream by
  // leaderboard-decider.js to require the (non-bearish) trend to have
  // persisted for a minimum number of cycles before buying, rather than
  // acting on a single-cycle flip that may reverse next cycle.
  //
  // Increments on BULL 4H, LEAN BULL, or NEUTRAL — reset to 0 only on an
  // actual bear reading (LEAN BEAR or BEAR 4H). This is intentionally
  // broader than "only full BULL 4H counts" (the original design) —
  // during a genuine recovery, price often transitions bear -> neutral
  // -> lean bull -> bull gradually, and the earlier design meant the
  // neutral/lean-bull phase contributed nothing toward persistence,
  // delaying entries until the LATER, more-confirmed part of the move.
  // Broadening the count lets persistence start building as soon as the
  // bearish pressure itself has actually let up, not only once a full
  // bull reading has already been confirmed.
  // Configurable via BULL4H_COUNT_BEAR_VALUES (comma-separated), so which
  // bias4h readings reset the count can be changed later without a code
  // edit — e.g. add "NEUTRAL" here if you decide neutral should also
  // reset it instead of counting toward persistence. Same
  // comma-separated pattern as GUARD_BTC_BEAR_VALUES in market-guard.js.
  const BEAR_VALUES = (process.env.BULL4H_COUNT_BEAR_VALUES || 'LEAN BEAR,BEAR 4H')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isBearish4h = BEAR_VALUES.includes(r.d.bias4h);
  const bull4hCount  = isBearish4h ? 0 : (prev?.bull4hCount || 0) + 1;

  return {
    pair:           r.pair,
    price:          r.price,
    chg:            r.chg,
    conv:           r.conv,
    setup:          r.setup,
    assetType:      r.assetType,
    exchangePrefix: r.exchangePrefix,
    session,                                        // 'open' | 'pre_market' | 'after_hours' | '24/7'
    marketClosed:   false,
    d:              r.d,
    bullConf:       r.bullConf,
    bullChecks:     r.bullChecks,
    whale:          r.whale,
    capBuy:         r.capBuy,
    flow:           r.flow,
    grade:          r.grade,
    successProb:    r.successProb,
    archetype:      r.archetype,
    peakShock:      Math.max(shock, prev?.peakShock ?? shock),
    peakObi:        Math.abs(obi) > Math.abs(prev?.peakObi ?? 0) ? obi : (prev?.peakObi ?? obi),
    peakSince:      prev?.peakSince ?? now,
    bull4hCount,
    updatedAt:      now,
  };
}

// ── Freeze an entry when market is closed ──
// Carries forward prior data but flags it so Job B ignores it.
function freezeEntry(prev, session) {
  if (!prev) return null;
  return { ...prev, session, marketClosed: true };
}

async function fetchBtcShortTermChange() {
  // Fetch last 4 × 5m candles for BTC to compute 15m change and recent volatility
  // (candle range as a proxy for intraday shock size).
  try {
    const res = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=4',
      { signal: AbortSignal.timeout(5000) }
    );
    const klines = await res.json();
    if (!Array.isArray(klines) || klines.length < 2) return null;

    const latest   = klines[klines.length - 1];
    const oldest   = klines[0];
    const openOld  = parseFloat(oldest[1]);
    const closeNew = parseFloat(latest[4]);
    const btcChg15m = openOld > 0 ? parseFloat(((closeNew - openOld) / openOld * 100).toFixed(3)) : null;

    // Volatility = max high - min low across all 4 candles, as % of close
    const highs = klines.map(k => parseFloat(k[2]));
    const lows  = klines.map(k => parseFloat(k[3]));
    const range = Math.max(...highs) - Math.min(...lows);
    const btcVolatility = closeNew > 0 ? parseFloat((range / closeNew * 100).toFixed(3)) : null;

    return { btcChg15m, btcVolatility };
  } catch (e) {
    console.log(`  ⚠  btcShortTerm fetch failed: ${e.message}`);
    return null;
  }
}

async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1',
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    const val  = parseInt(data?.data?.[0]?.value ?? '-1');
    return val >= 0 ? val : null;
  } catch (e) {
    console.log(`  ⚠  F&G fetch failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const { crypto: cryptoPairs, stocks: stockSyms } = loadWatchlist();
  const totalSymbols = cryptoPairs.length + stockSyms.length;

  if (!totalSymbols) {
    console.log('[market-fetcher] No symbols in watchlist.');
    logAudit('no_symbols');
    return;
  }

  console.log(`[market-fetcher] ${cryptoPairs.length} crypto + ${stockSyms.length} stock/ETF`);

  const existing = loadExisting();
  const now      = Date.now();

  // ── Determine which stocks need scoring vs freezing ──
  const stocksToScore  = [];
  const stocksToFreeze = [];

  for (const sym of stockSyms) {
    const session = getMarketSession(sym);
    if (session === 'closed' || session === 'lunch_break') {
      stocksToFreeze.push({ sym, session });
    } else {
      stocksToScore.push({ sym, session }); // open | pre_market | after_hours
    }
  }

  // Init Yahoo once if any stocks need scoring
  if (stocksToScore.length) await initYahoo();

  // ── Fetch in parallel — symbols + global guard data ──
  const [cryptoResults, stockResults, btcShort, fgVal] = await Promise.all([
    Promise.all(cryptoPairs.map(pair => scoreSymbol(pair, existing.symbols?.[pair]?.d?.fr ?? null))),
    Promise.all(stocksToScore.map(({ sym }) => scoreStock(sym))),
    fetchBtcShortTermChange(),
    fetchFearGreed(),
  ]);

  const symbols      = {};
  let okCount        = 0;
  const fetchResults = [];

  // ── Crypto (always 24/7) ──
  for (let i = 0; i < cryptoPairs.length; i++) {
    const pair = cryptoPairs[i];
    const r    = cryptoResults[i];
    const prev = existing.symbols?.[pair];

    if (!r) {
      if (prev) symbols[pair] = prev;
      console.log(`  ⚠  ${pair} — crypto fetch failed, carrying forward`);
      fetchResults.push({ pair, status: 'failed', assetType: 'crypto' });
      continue;
    }
    okCount++;
    symbols[pair] = buildEntry(r, prev, now, '24/7');
    fetchResults.push({ pair, status: 'ok', conv: r.conv, session: '24/7', assetType: 'crypto' });
  }

  // ── Stocks: freeze closed markets ──
  for (const { sym, session } of stocksToFreeze) {
    const prev   = existing.symbols?.[sym];
    const frozen = freezeEntry(prev, session);
    if (frozen) symbols[sym] = frozen;
    console.log(`  ⏸  ${sym} — ${session}, frozen`);
    fetchResults.push({ pair: sym, status: 'frozen', session, assetType: 'stock' });
  }

  // ── Stocks: scored (open / pre_market / after_hours) ──
  for (let i = 0; i < stocksToScore.length; i++) {
    const { sym, session } = stocksToScore[i];
    const r    = stockResults[i];
    const prev = existing.symbols?.[sym];

    if (!r) {
      if (prev) symbols[sym] = { ...prev, session, marketClosed: false };
      console.log(`  ⚠  ${sym} — fetch failed, carrying forward`);
      fetchResults.push({ pair: sym, status: 'failed', session, assetType: 'stock' });
      continue;
    }
    okCount++;
    symbols[sym] = buildEntry(r, prev, now, session);
    console.log(`  ✓  ${sym} [${session}] conv:${r.conv} setup:${r.setup.label}`);
    fetchResults.push({ pair: sym, status: 'ok', conv: r.conv, session, setup: r.setup.label, assetType: 'stock' });
  }

  // ── Global market guard data ──
  // BTC's own bias4h/emaTrend/etc. are already fully computed above (as
  // part of symbols['BTCUSDT'], via buildEntry -> evaluateSymbol) — no
  // new fetch needed, just surfaced here for cheap access by every other
  // symbol's buy decision (market-guard.js's BTC regime gate).
  const btcEntry = symbols['BTCUSDT'] || {};
  const btcD     = btcEntry.d || {};
  const global = {
    btcChg15m:    btcShort?.btcChg15m    ?? null,
    btcVolatility:btcShort?.btcVolatility ?? null,
    fearGreed:    fgVal,
    btcBias4h:    btcD.bias4h   || null,
    btcBiasDay:   btcD.biasDay  || null,
    btcEmaTrend:  btcD.emaTrend || null,
    btcOiDiv:     btcD.oiDiv    ?? null,
    btcCvdTrend:  btcD.cvdTrend || null,
    // 24h % change, same field/timeframe every other symbol's entry.chg
    // uses (Binance's priceChangePercent) — needed for a fair
    // apples-to-apples comparison in calcRelativeStrength() rather than
    // mixing timeframes (see market-guard.js for why this matters).
    btcChg24h:    btcEntry.chg ?? btcD.chg ?? null,
    btcBull4hCount: btcEntry.bull4hCount ?? 0,
    updatedAt:    now,
  };

  if (btcShort) {
    const arrow = (btcShort.btcChg15m || 0) >= 0 ? '▲' : '▼';
    console.log(`  📊  BTC 15m: ${arrow}${btcShort.btcChg15m}%  volatility: ${btcShort.btcVolatility}%  F&G: ${fgVal ?? '—'}`);
  }

  const out = { fetchedAt: now, staleAfterMinutes: STALE_MINUTES, global, symbols };
  saveMarketData(out);

  logAudit('fetch_complete', {
    totalPairs:    totalSymbols,
    successCount:  okCount,
    cryptoCount:   cryptoPairs.length,
    stockScored:   stocksToScore.length,
    stockFrozen:   stocksToFreeze.length,
    results:       fetchResults,
  });

  console.log(`[market-fetcher] Done — ${okCount} scored, ${stocksToFreeze.length} frozen.`);
}

main().catch(err => {
  console.error('[market-fetcher] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
