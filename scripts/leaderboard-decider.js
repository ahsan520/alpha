// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min)
// v10.1
//
// WHY: splits the "decide" step away from the "fetch" step (market-fetcher.js,
// every 5 min). Job B does no Binance calls of its own for the BUY side — it
// reads market-data.json, which Job A already refreshed up to 3x since the
// last Job B run. This keeps Job B cheap and lets Job A absorb the API call
// volume at a tighter interval without re-running scoring/decision logic
// that fast.
//
// BUY SIDE (new in v10.1):
//   - Reads each symbol's LATEST score/setup from market-data.json.
//   - Also re-evaluates conviction/setup using PEAK shock/obi seen since the
//     last Job B run (captured by market-fetcher.js) — catches a spike that
//     fired and faded between Job A polls, which the latest-only snapshot
//     would otherwise miss entirely.
//   - Buy/cooldown/scoring thresholds are UNCHANGED from the existing
//     checkLeaderboardBuys() logic in alert-runner.js — only the data
//     source moved (file read vs live fetch). LB_MIN_SCORE, cooldown, and
//     setup-label gating all behave identically.
//   - On a qualifying signal, sends the same Telegram format as before AND
//     (new) writes the position into positions.json using the exact same
//     shape the browser's position-tracker.js already writes — so the
//     existing sell-side checkPositions() logic (untouched) picks it up
//     with no special-casing.
//   - After processing, resets each symbol's peak window in market-data.json
//     so market-fetcher.js starts accumulating a fresh peak for the next
//     15-min cycle.
//
// SELL SIDE: untouched. Delegates straight to checkPositions() exactly as
// alert-runner.js --mode=positions already does. Per explicit instruction,
// buy/sell decision logic itself is not being changed in this script —
// only how the BUY side sources its market data.
//
// DEDUP (lb-alert-state.json): separate from the cooldown in positions.json/
// .alert-state.json. Tracks "last alerted setup label" per symbol so a
// signal that's still in the same buy-worthy label doesn't get an entirely
// new position opened on top of an existing open one. Entries older than
// ALERT_STATE_TTL_HOURS are pruned each run.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calcConviction, getSetupMode } from './leaderboard-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKET_DATA_PATH    = path.join(__dirname, 'market-data.json');
const POSITIONS_PATH      = path.join(__dirname, 'positions.json');
const LB_ALERT_STATE_PATH = path.join(__dirname, 'lb-alert-state.json');

const DRY_RUN         = process.argv.includes('--dry-run');
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

// ── Same thresholds as the existing checkLeaderboardBuys() — unchanged ──
const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');
const LB_HOLD_LOCK    = parseInt(process.env.LB_HOLD_LOCK    || '20');

// ── New: how long to remember "last alerted setup" per symbol before ──
// treating a repeat of the same label as a fresh signal again.
const ALERT_STATE_TTL_HOURS = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

const SKIP_SETUPS = new Set(['SHORT SETUP', 'WATCHING']);

// ── File helpers ──
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function loadMarketData()    { return loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} }); }
function saveMarketData(d)   { saveJSON(MARKET_DATA_PATH, d); }
function loadPositions()     { return loadJSON(POSITIONS_PATH, {}); }
function savePositions(p)    { saveJSON(POSITIONS_PATH, p); }
function loadAlertState()    { return loadJSON(LB_ALERT_STATE_PATH, {}); }
function saveAlertState(s)   { saveJSON(LB_ALERT_STATE_PATH, s); }

// ── Cooldown — mirrors isLbOnCooldown/markLbCooldown from alert-runner.js ──
function isOnCooldown(state, sym) {
  const ts = state[`lb_buy_${sym}`] || 0;
  return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
}
function markCooldown(state, sym) { state[`lb_buy_${sym}`] = Date.now(); }

// ── Prune lb-alert-state.json entries older than the TTL ──
function pruneAlertState(state) {
  const cutoff = Date.now() - ALERT_STATE_TTL_HOURS * 3_600_000;
  let pruned = 0;
  for (const [sym, entry] of Object.entries(state)) {
    if ((entry.lastSeenAt || 0) < cutoff) { delete state[sym]; pruned++; }
  }
  if (pruned) console.log(`[leaderboard-decider] Pruned ${pruned} stale alert-state entry(ies) (>${ALERT_STATE_TTL_HOURS}h).`);
  return state;
}

// ── Entry levels — same formula as leaderboard-scanner.js calcEntryLevels ──
function calcEntryLevels(price, shock) {
  const p = parseFloat(price) || 0;
  if (!p) return null;
  const atr   = p * 0.015 * Math.max(1, shock * 0.5);
  const dp    = p < 10 ? 4 : 2;
  const entry = (p * 1.004).toFixed(dp);
  const stop  = (p - atr * 1.5).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

async function sendTelegram(msg) {
  if (DRY_RUN)     { console.log('[DRY-RUN] TG:', msg.slice(0, 80)); return; }
  if (!TG_ENABLED) { console.log('[TG DISABLED]'); return; }
  if (!TG_TOKEN || !TG_CHAT) { console.warn('⚠ No TG credentials'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' }),
    });
    const d = await r.json();
    if (!d.ok) console.warn('TG error:', d.description);
  } catch (e) { console.warn('TG fetch error:', e.message); }
}

// ── Evaluate a symbol two ways: latest snapshot, and peak-substituted ──
// (peak shock/obi swapped in for the live values, to see whether the
// symbol WOULD have qualified at its peak even if it's faded by now).
// Returns whichever evaluation is stronger (higher conviction / a
// buy-worthy label), so a transient spike between Job A polls isn't lost.
function evaluateSymbol(entry) {
  const latest = { ...entry.d, conv: entry.conv, setup: entry.setup };

  const peakD = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
  const peakConv  = calcConviction(peakD);
  const peakSetup = getSetupMode({ ...peakD, conv: peakConv });

  const peakIsStronger = peakConv > latest.conv && !SKIP_SETUPS.has(peakSetup.label);

  return peakIsStronger
    ? { conv: peakConv, setup: peakSetup, source: 'peak', shock: entry.peakShock, obi: entry.peakObi }
    : { conv: latest.conv, setup: latest.setup, source: 'latest', shock: entry.d.shock, obi: entry.d.obi };
}

// ════════════════════════════════════════════════════
// BUY SIDE
// ════════════════════════════════════════════════════
async function processBuySignals() {
  const market = loadMarketData();
  const symbols = Object.entries(market.symbols || {});

  if (!symbols.length) {
    console.log('[leaderboard-decider] market-data.json empty — has market-fetcher.js run yet?');
    return;
  }

  const ageMin = (Date.now() - (market.fetchedAt || 0)) / 60000;
  if (ageMin > (market.staleAfterMinutes || 30)) {
    console.log(`[leaderboard-decider] ⚠ market-data.json is ${ageMin.toFixed(1)} min old — proceeding, but check market-fetcher.js is running.`);
  }

  const cooldownState = loadJSON(path.join(__dirname, '.lb-scan-state.json'), {});
  const alertState    = pruneAlertState(loadAlertState());
  const positions      = loadPositions();

  const candidates = [];
  for (const [pair, entry] of symbols) {
    const evald = evaluateSymbol(entry);
    if (evald.conv < LB_MIN_SCORE)          { console.log(`  ⏭  ${pair} score:${evald.conv} below min:${LB_MIN_SCORE}`); continue; }
    if (SKIP_SETUPS.has(evald.setup.label)) { console.log(`  ⏭  ${pair} setup:${evald.setup.label} skipped`); continue; }
    if (isOnCooldown(cooldownState, pair))  { console.log(`  🔕  ${pair} [${evald.setup.label}] score:${evald.conv} — cooldown`); continue; }

    // Already an open position for this symbol? Don't open a duplicate —
    // the existing position's own sell-side logic is already watching it.
    const sym = `BINANCE:${pair}`;
    if (positions[sym] && positions[sym].status !== 'stopped' && positions[sym].status !== 'tp2_hit') {
      console.log(`  ⏭  ${pair} — already has an open position (status: ${positions[sym].status})`);
      continue;
    }

    candidates.push({ pair, sym, entry, evald });
  }

  if (!candidates.length) {
    console.log('  ✓  No new leaderboard buy signals this cycle');
    saveMarketData(resetPeaks(market));
    saveJSON(path.join(__dirname, '.lb-scan-state.json'), cooldownState);
    saveAlertState(alertState);
    return;
  }

  const buyAlerts = [];
  for (const { pair, sym, entry, evald } of candidates) {
    markCooldown(cooldownState, pair);
    alertState[pair] = { lastLabel: evald.setup.label, lastConv: evald.conv, lastSeenAt: Date.now() };

    const levels = calcEntryLevels(entry.price, evald.shock);
    const now    = Date.now();
    const dir    = evald.setup.label === 'SHORT SETUP' ? 'bear' : 'bull';

    // ── Write position — same shape position-tracker.js (browser) writes ──
    positions[sym] = {
      sym,
      base:         pair.replace('USDT', ''),
      setup:        evald.setup.label,
      dir,
      alertedAt:    now,
      holdLockUntil: now + LB_HOLD_LOCK * 60000,
      entryPrice:   levels ? parseFloat(levels.entry) : entry.price,
      stop:         levels ? parseFloat(levels.stop)  : 0,
      t1:           levels ? parseFloat(levels.t1)    : 0,
      t2:           levels ? parseFloat(levels.t2)    : 0,
      score:        evald.conv,
      spikeScore:   evald.shock,
      session:      '—',
      exitAlertedAt: null,
      tier1AlertedAt: null,
      status:       'watching',
      source:       'headless_v10.1', // marks this as opened by the headless decider, not the GUI
      scoreSource:  evald.source,      // 'latest' or 'peak' — which evaluation triggered this
    };

    buyAlerts.push({ pair, levels, evald, price: entry.price, chg: entry.chg, d: entry.d });
    console.log(`  🟢  ${pair} [${evald.setup.label}] score:${evald.conv} (${evald.source}) price:$${entry.price} → position opened`);
  }

  savePositions(positions);
  saveJSON(path.join(__dirname, '.lb-scan-state.json'), cooldownState);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));

  // ── Telegram — same message format as the existing checkLeaderboardBuys() ──
  const utc   = new Date().toUTCString().replace(/.*(\d{2}:\d{2}).*/, '$1') + ' UTC';
  const lines = buyAlerts.map(a => {
    const l = a.levels;
    const peakNote = a.evald.source === 'peak' ? '  _(caught via peak — spike faded before this check)_' : '';
    return [
      `${a.evald.setup.emoji} *${a.pair.replace('USDT', '')}* — ${a.evald.setup.label}  [${a.evald.conv} pts]${peakNote}`,
      `  Price $${a.price}  Chg ${a.chg > 0 ? '+' : ''}${a.chg.toFixed(2)}%`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}`,
      `  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}  R:R ${l?.rr || '—'}`,
      `  4H: ${a.d.bias4h}  Day: ${a.d.biasDay}  CVD: ${a.d.cvdTrend}  FR: ${(a.d.fr || 0).toFixed(3)}%`,
    ].join('\n');
  });

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    `_${buyAlerts.length} signal(s) · headless v10.1 · min score ${LB_MIN_SCORE}_`,
    '',
    lines.join('\n\n'),
    '',
    `_Position(s) opened automatically — tracked for stop/T1/T2 going forward._`,
  ].join('\n');

  await sendTelegram(msg);
}

// ── Reset each symbol's peak window — called after Job B consumes the data ──
function resetPeaks(market) {
  const now = Date.now();
  for (const entry of Object.values(market.symbols || {})) {
    entry.peakShock = entry.d?.shock ?? entry.peakShock;
    entry.peakObi   = entry.d?.obi   ?? entry.peakObi;
    entry.peakSince = now;
  }
  return market;
}

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Leaderboard Decider (Job B) — ${new Date().toUTCString()}`);
  console.log(`Min score: ${LB_MIN_SCORE} | Cooldown: ${LB_COOLDOWN_MIN}min | Alert-state TTL: ${ALERT_STATE_TTL_HOURS}h | Dry-run: ${DRY_RUN}`);
  console.log('═'.repeat(60));

  await processBuySignals();

  console.log('\n✅  Job B (buy-side) complete.\n');
}

main().catch(err => { console.error('[leaderboard-decider] Fatal:', err); process.exit(1); });
