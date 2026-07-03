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

const MARKET_DATA_PATH    = path.join(process.cwd(), 'market-data.json');
const POSITIONS_PATH      = path.join(process.cwd(), 'positions.json');
const LB_ALERT_STATE_PATH = path.join(process.cwd(), 'lb-alert-state.json');
const AUDIT_PATH          = path.join(process.cwd(), 'audit.json');
const COOLDOWN_STATE_PATH = path.join(process.cwd(), '.lb-scan-state.json');
const CVD_STATE_PATH      = path.join(process.cwd(), '.cvd-decline-state.json');
const SYMBOL_HISTORY_PATH = path.join(process.cwd(), 'symbol-history.json');

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
