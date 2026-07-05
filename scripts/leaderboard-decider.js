// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min)
// v11.0
//
// KEY CHANGE from v10.9:
//   Added monitorPositions() — runs every Job B cycle BEFORE buy signal scan.
//   For every open position in positions.json it:
//     1. Reads live price from market-data.json
//     2. Checks stop / T1 / T2 (price-based, immediate)
//     3. Computes exit score (CVD + OI + FR + RSI) → marks 'exiting'
//     4. Removes positions that have been in terminal state long enough
//   This means positions.json is always up to date even when the browser
//   is never opened. Telegram alerts fire for every status change.
//
//   Previously Job B only swept stale 'watching' positions — it never
//   detected stops or computed exit scores headlessly.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { calcConviction, getSetupMode } from './leaderboard-scanner.js';
import { buildSymKey, cooldownKey } from './exchange-registry.js';
import { mexcMarketBuy, mexcMarketSell, mexcFreeBalance, getBaseSizePrecision, floorToStep } from './mexc-client.js';

const MARKET_DATA_PATH    = path.join(process.cwd(), 'market-data.json');
const POSITIONS_PATH      = path.join(process.cwd(), 'positions.json');
const LB_ALERT_STATE_PATH = path.join(process.cwd(), 'lb-alert-state.json');
const AUDIT_PATH          = path.join(process.cwd(), 'audit.json');
const COOLDOWN_STATE_PATH = path.join(process.cwd(), '.lb-scan-state.json');
const CVD_STATE_PATH      = path.join(process.cwd(), '.cvd-decline-state.json');
const SYMBOL_HISTORY_PATH = path.join(process.cwd(), 'symbol-history.json');
const TRADE_STATE_PATH    = path.join(process.cwd(), 'trade-state.json');

const DRY_RUN    = process.argv.includes('--dry-run');
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

const LB_MIN_SCORE       = parseInt(process.env.LB_MIN_SCORE       || '9');
const LB_BULL_CONF_MIN   = parseInt(process.env.LB_BULL_CONF_MIN   || '5');
const LB_COOLDOWN_MIN    = parseInt(process.env.LB_COOLDOWN_MIN    || '60');
const LB_HOLD_LOCK       = parseInt(process.env.LB_HOLD_LOCK       || '20');
const LB_STALE_WATCH_HRS = parseFloat(process.env.LB_STALE_WATCH_HRS || '24');
const LB_EXIT_CVD_CYCLES = parseInt(process.env.LB_EXIT_CVD_CYCLES || '3');
const LB_EXIT_SCORE_MIN  = parseInt(process.env.LB_EXIT_SCORE_MIN  || '3');
const ALLOW_PRE_MARKET   = (process.env.LB_ALLOW_PRE_MARKET || 'false') === 'true';
const ALLOW_AH           = (process.env.LB_ALLOW_AH         || 'false') === 'true';
const ALERT_STATE_TTL    = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

// ── Multi-signal recommendation (top N by past spike history) ──
const RECO_MIN_SIGNALS   = parseInt(process.env.LB_RECO_MIN_SIGNALS    || '3');   // only annotate when this many+ fire in one cycle
const RECO_TOP_N         = parseInt(process.env.LB_RECO_TOP_N          || '3');   // how many to star as recommended
const RECO_LOOKBACK_DAYS = parseFloat(process.env.LB_RECO_LOOKBACK_DAYS|| '30');  // history window used for win-rate
const HISTORY_RETENTION_DAYS = parseFloat(process.env.LB_HISTORY_RETENTION_DAYS || '45'); // how long symbol-history.json keeps rows
const HISTORY_MAX_ROWS    = parseInt(process.env.LB_HISTORY_MAX_ROWS || '1500'); // hard cap regardless of days — safety net vs. size blowup

// ── MEXC auto-trading — top-ranked pick only, gated by TRADE_MODE ──
// off   → no exchange calls at all, alerts only (default-safe if unset)
// paper → logs what would have traded, no exchange calls
// live  → places real MEXC orders — requires MEXC_API_KEY/MEXC_API_SECRET
const MEXC_API_KEY      = process.env.MEXC_API_KEY    || '';
const MEXC_API_SECRET   = process.env.MEXC_API_SECRET || '';
const TRADE_MODE        = (process.env.TRADE_MODE || 'paper').toLowerCase();
const TRADE_USD_SIZE    = parseFloat(process.env.TRADE_USD_SIZE || '25');
const TRADE_MAX_LIVE    = parseInt(process.env.TRADE_MAX_CONCURRENT_LIVE || '1');

// ── How long terminal positions stay in positions.json before removal ──
const TERMINAL_EVICT_MS = {
  stopped:  5  * 60 * 1000,   //  5 min
  tp2_hit:  8  * 60 * 1000,   //  8 min
  tp1_hit:  20 * 60 * 1000,   // 20 min (still watching T2)
  exiting:  10 * 60 * 1000,   // 10 min
};

const SKIP_SETUPS = new Set(['SHORT SETUP']);

// ── I/O helpers ──
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, o)  { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

const loadMarketData = () => loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} });
const saveMarketData = d  => saveJSON(MARKET_DATA_PATH, d);
const loadPositions  = () => loadJSON(POSITIONS_PATH, {});
const savePositions  = p  => saveJSON(POSITIONS_PATH, p);
const loadAlertState = () => loadJSON(LB_ALERT_STATE_PATH, {});
const saveAlertState = s  => saveJSON(LB_ALERT_STATE_PATH, s);
const loadCooldowns  = () => loadJSON(COOLDOWN_STATE_PATH, {});
const saveCooldowns  = s  => saveJSON(COOLDOWN_STATE_PATH, s);
const loadCvdState   = () => loadJSON(CVD_STATE_PATH, {});
const saveCvdState   = s  => saveJSON(CVD_STATE_PATH, s);
const loadHistory     = () => loadJSON(SYMBOL_HISTORY_PATH, []);
const saveHistory     = h  => fs.writeFileSync(SYMBOL_HISTORY_PATH, JSON.stringify(h)); // compact — it's log data, not something you hand-edit

const loadTradeState = () => loadJSON(TRADE_STATE_PATH, { tradingEnabled: true, lastUpdateId: 0, changedAt: 0 });
const saveTradeState = s  => saveJSON(TRADE_STATE_PATH, s);

// ── Telegram kill-switch — /pause and /resume from the configured chat ──
// Only gates NEW buy execution. Existing live positions' stop/T2 sells keep
// firing regardless of pause state — pausing is meant to stop taking on new
// risk, not to strand an already-open position without its safety net.
// Latency note: this is only checked once per Job B cycle (every ~15 min),
// same as everything else headless — not an instant kill switch.
async function pollTelegramCommands(state) {
  if (!TG_TOKEN || !TG_CHAT) return state;
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=0`);
    const data = await res.json();
    if (!data.ok) return state;

    for (const upd of data.result || []) {
      state.lastUpdateId = upd.update_id;
      const msg    = upd.message || upd.edited_message;
      const text   = (msg?.text || '').trim().toLowerCase();
      const chatId = String(msg?.chat?.id || '');
      if (chatId !== String(TG_CHAT)) continue; // only the configured chat can control trading

      if (text === '/pause' || text === '/stop_trading') {
        state.tradingEnabled = false;
        state.changedAt = Date.now();
        await sendTelegram(
          '⏸ *Auto-trading PAUSED* — new ⭐ top-pick buys are suspended until /resume.\n' +
          '_Already-open live positions still get their stop/T2 exits — this only blocks new entries._'
        );
      } else if (text === '/resume' || text === '/start_trading') {
        state.tradingEnabled = true;
        state.changedAt = Date.now();
        await sendTelegram('▶️ *Auto-trading RESUMED* — the next ⭐ top-ranked buy alert may place a live order again.');
      }
    }
  } catch (e) {
    console.log('[telegram-commands] poll failed:', e.message);
  }
  return state;
}

function countLiveOpenPositions(positions) {
  return Object.values(positions).filter(
    p => p.liveOrder?.mode === 'live' && !p.liveOrder?.closedAt && !['stopped', 'tp2_hit'].includes(p.status)
  ).length;
}

// ── Closes a live MEXC position when a stop or T2 fires headlessly ──
// Re-checks actual exchange balance before selling (never trusts the
// locally-tracked qty alone — fees or manual intervention could have
// changed it) and floors to the exchange's lot-size step so the order
// isn't rejected for too many decimals.
async function closeLiveOrder(pos, reason, telegramAlerts) {
  if (pos.liveOrder?.mode !== 'live' || pos.liveOrder.closedAt) return;
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
  } catch (e) {
    telegramAlerts.push(`🚨 *LIVE SELL FAILED* — ${pos.base} ${reason} but MEXC order errored: ${e.message} — CLOSE MANUALLY on the exchange.`);
    logAudit('mexc_sell_failed', { sym: symbol, reason, error: e.message });
  }
}

// ── Audit ──
function logAudit(action, details = {}) {
  const entry = { timestamp: new Date().toISOString(), job: 'leaderboard-decider', action, ...details };
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); if (!Array.isArray(logs)) logs = []; } catch {}
  logs.push(entry);
  logs = logs.filter(e => new Date(e.timestamp).getTime() >= Date.now() - 3_600_000);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
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
  const stop  = (p - atr * 1.5).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

async function sendTelegram(msg) {
  if (DRY_RUN)     { console.log('[DRY-RUN] TG:', msg.slice(0, 120)); return; }
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

async function pushPositionsToGitHub(positions) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_POSITIONS_PATH || 'scripts/positions.json';

  if (!token || !repo) {
    console.log('[positions-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    let sha = null;
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha || null;
    else if (getRes.status !== 404) throw new Error(`GET ${getRes.status}`);

    const body = {
      message: `chore: positions update (${Object.keys(positions).length} open) [skip ci]`,
      content: Buffer.from(JSON.stringify(positions, null, 2)).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
    }
    console.log(`[positions-push] ✓ ${Object.keys(positions).length} position(s) pushed`);
    logAudit('positions_pushed', { count: Object.keys(positions).length });
  } catch (e) {
    console.warn(`[positions-push] ⚠ ${e.message}`);
    logAudit('positions_push_failed', { error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// monitorPositions — runs every Job B cycle
//
// For each open position in positions.json:
//   1. Look up live price + signals from market-data.json
//   2. Check stop / T1 / T2 (price-based, immediate)
//   3. Compute exit score (CVD + OI + FR + RSI) → mark 'exiting'
//   4. Remove positions past their terminal eviction window
//   5. Remove positions that have been 'watching' past LB_STALE_WATCH_HRS
//
// Returns { positions, changed, telegramAlerts[] }
// Caller saves positions.json and pushes to GitHub.
// ══════════════════════════════════════════════════════════════════════════════
async function monitorPositions(positions, marketSymbols) {
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

    // T2 hit (only if T1 already hit)
    if (isBull && t2 > 0 && price >= t2 && pos.status === 'tp1_hit') {
      console.log(`  🏆  T2 HIT — ${pos.base} price:${price} t2:${t2}`);
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
      continue;
    }

    // T1 hit (only when still watching)
    if (isBull && t1 > 0 && price >= t1 && pos.status === 'watching') {
      console.log(`  ✅  T1 HIT — ${pos.base} price:${price} t1:${t1}`);
      pos.status          = 'tp1_hit';
      pos.statusChangedAt = now;
      changed = true;
      logAudit('tp1_hit', { sym, price, t1, entry, pnlPct });
      telegramAlerts.push(
        `✅ *T1 HIT* — ${pos.base} — ${utc}\n` +
        `  T1 $${t1}  Current $${price}  Entry $${entry}\n` +
        `  P&L +${pnlPct}%  Trail stop, watching for T2 $${t2}`
      );
      // Don't continue — still run exit score below
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

  const market  = loadMarketData();
  const entries = Object.entries(market.symbols || {});

  if (!entries.length) {
    console.log('[leaderboard-decider] market-data.json empty — has market-fetcher run yet?');
    logAudit('market_data_empty');
    return;
  }

  const ageMin = (Date.now() - (market.fetchedAt || 0)) / 60000;
  if (ageMin > (market.staleAfterMinutes || 30)) {
    console.log(`[leaderboard-decider] ⚠ market-data.json is ${ageMin.toFixed(1)} min old`);
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
  const openCount = Object.keys(positions).length;

  if (openCount > 0) {
    console.log(`\n📊  Monitoring ${openCount} open position(s)...`);
    const monitored = await monitorPositions(positions, market.symbols || {});
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
  // STEP 2 — Scan for new BUY signals
  // ══════════════════════════════════════════════════════
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
    console.log('\n✅  Job B complete.\n');
    return;
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
    const sym = buildSymKey(pair);
    const existingPos = positions[sym];
    if (existingPos) {
      const isTerminal = ['stopped', 'tp2_hit'].includes(existingPos.status);
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
      // Past eviction window — clear it now
      console.log(`  ♻️  ${pair} — clearing terminal (${existingPos.status}), slot available`);
      delete positions[sym];
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
  // ══════════════════════════════════════════════════════════════════════════
  // MEXC AUTO-TRADE
  //
  // Two execution strategies (set via GUI toggle → trade-state.json):
  //   'top1'  — buy only the ⭐ #1 ranked symbol, full TRADE_USD_SIZE
  //   'topN'  — buy every ⭐ starred symbol, TRADE_USD_SIZE split equally
  //             e.g. $75 / 3 starred picks = $25 each
  //
  // Gates (per-symbol, all must pass):
  //   1. TRADE_MODE is 'paper' or 'live' (not 'off')
  //   2. tradingEnabled flag (Telegram /pause kill-switch)
  //   3. Symbol is in the ⭐ recommended set (showRecoTags fired)
  //   4. Not already holding too many live open trades (TRADE_MAX_CONCURRENT_LIVE)
  //   5. Idempotency: positions[sym].liveOrder not already set
  // ══════════════════════════════════════════════════════════════════════════
  let tradeState = loadTradeState();
  tradeState = await pollTelegramCommands(tradeState);
  saveTradeState(tradeState);

  // GUI toggle writes `tradeMode` and `execStrategy` to trade-state.json —
  // both take precedence over env vars so the browser control works without
  // a repo-variable change.
  const effectiveTradeMode     = tradeState.tradeMode     || TRADE_MODE;
  const effectiveExecStrategy  = tradeState.execStrategy  || 'top1'; // 'top1' | 'topN'
  const effectiveUsdSize       = tradeState.usdSize       || TRADE_USD_SIZE;
  const effectiveMaxLive       = tradeState.maxLive       || TRADE_MAX_LIVE;

  if (effectiveTradeMode !== 'off' && showRecoTags) {
    // Determine the picks for this cycle based on strategy
    const allStarred   = ranked.filter(r => r.recommended);
    const picks        = effectiveExecStrategy === 'topN' ? allStarred : allStarred.slice(0, 1);
    const perPickUsd   = effectiveExecStrategy === 'topN' && picks.length > 1
      ? parseFloat((effectiveUsdSize / picks.length).toFixed(2))
      : effectiveUsdSize;

    console.log(`  ⚡  Exec strategy: ${effectiveExecStrategy} — ${picks.length} pick(s) @ $${perPickUsd} each`);

    if (!tradeState.tradingEnabled) {
      console.log(`  🚫  Auto-trade blocked — trading paused via Telegram /pause`);
      logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: ['paused'] });
    } else {
      const liveLock = countLiveOpenPositions(positions);

      for (const { a: pick } of picks) {
        const pos    = positions[pick.sym];
        const symbol = pick.pair.replace(/[^A-Z]/g, '') + (pick.pair.includes('USDT') ? '' : 'USDT');

        const blockedReasons = [
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
  }

  savePositions(positions);
  saveCooldowns(cooldowns);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));
  await pushPositionsToGitHub(positions);

  // Telegram BUY alerts
  const utc   = new Date().toUTCString().slice(17, 22) + ' UTC';

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
  logAudit('job_complete');
  console.log('\n✅  Job B complete.\n');
}

main().catch(err => {
  console.error('[leaderboard-decider] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
