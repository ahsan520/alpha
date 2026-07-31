// ══════════════════════════════════════════════════════════════════════════════
// job-state.js — shared I/O layer for the Job B pipeline
//
// Every module in the split (leaderboard-decider, position-monitor, mexc-trader,
// telegram-commands) reads/writes the same handful of JSON state files and the
// same handful of env-derived constants. Centralizing them here avoids each
// module re-declaring its own copy of MEXC_API_KEY, TERMINAL_EVICT_MS, etc. —
// and avoids a circular-import mess between the other four files.
//
// This file has NO business logic — just paths, env constants, load/save,
// logAudit, and the GitHub positions.json push.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

// ── Paths ──
const MARKET_DATA_PATH    = path.join(process.cwd(), 'market-data.json');
const POSITIONS_PATH      = path.join(process.cwd(), 'positions.json');
const LB_ALERT_STATE_PATH = path.join(process.cwd(), 'lb-alert-state.json');
const AUDIT_PATH          = path.join(process.cwd(), 'audit.json');
const COOLDOWN_STATE_PATH = path.join(process.cwd(), '.lb-scan-state.json');
const CVD_STATE_PATH      = path.join(process.cwd(), '.cvd-decline-state.json');
const SYMBOL_HISTORY_PATH = path.join(process.cwd(), 'symbol-history.json');
const TRADE_STATE_PATH    = path.join(process.cwd(), 'trade-state.json');
const TRADE_LOG_PATH      = path.join(process.cwd(), 'trade-log.json');
const PAPER_BALANCE_PATH  = path.join(process.cwd(), 'paper-balance.json');
const LIVE_BALANCES_PATH  = path.join(process.cwd(), 'mexc-live-balances.json');
const HEARTBEAT_PATH      = path.join(process.cwd(), 'heartbeat.json');

// ── Shared env constants ──
export const DRY_RUN    = process.argv.includes('--dry-run');
export const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
export const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || '';
export const TG_ENABLED = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

// off   → no exchange calls at all, alerts only (default-safe if unset)
// paper → logs what would have traded, no exchange calls
// live  → places real MEXC orders — requires MEXC_API_KEY/MEXC_API_SECRET
export const MEXC_API_KEY    = process.env.MEXC_API_KEY    || '';
export const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
export const TRADE_MODE      = (process.env.TRADE_MODE || 'paper').toLowerCase();
export const TRADE_USD_SIZE  = parseFloat(process.env.TRADE_USD_SIZE || '25');
export const TRADE_MAX_LIVE  = parseInt(process.env.TRADE_MAX_CONCURRENT_LIVE || '1');

// ── Percentage-based order sizing ──
// 'usd'     → fixed-dollar sizing (TRADE_USD_SIZE), original behavior
// 'percent' → TRADE_SIZE_PCT% of available balance is allocated each cycle
//             (100% = full balance; split equally across picks in topN mode),
//             so a profitable close compounds into a bigger next buy.
//   - live mode  → available balance = real MEXC USDT free balance (fetched
//     fresh each cycle via mexcFreeBalance — automatically reflects gains).
//   - paper mode → no real balance exists, so a virtual balance is tracked
//     in paper-balance.json, seeded from PAPER_STARTING_BALANCE, debited on
//     paper buy and credited back (qty × exitPrice) on paper close.
export const TRADE_SIZE_MODE          = (process.env.TRADE_SIZE_MODE || 'usd').toLowerCase();
export const TRADE_SIZE_PCT           = parseFloat(process.env.TRADE_SIZE_PCT || '100');
export const PAPER_STARTING_BALANCE   = parseFloat(process.env.PAPER_STARTING_BALANCE || '1000');

// ── How long terminal positions stay in positions.json before removal ──
export const TERMINAL_EVICT_MS = {
  stopped:  5  * 60 * 1000,   //  5 min
  tp2_hit:  8  * 60 * 1000,   //  8 min
  tp1_hit:  5  * 60 * 1000,   //  5 min — now a full sell at T1, slot freed immediately
  exiting:  10 * 60 * 1000,   // 10 min
};

export const SKIP_SETUPS = new Set(['SHORT SETUP']);

// ── Generic I/O helpers ──
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, o)  { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

export const loadMarketData = () => loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} });
export const saveMarketData = d  => saveJSON(MARKET_DATA_PATH, d);
export const loadPositions  = () => loadJSON(POSITIONS_PATH, {});
export const savePositions  = p  => saveJSON(POSITIONS_PATH, p);
export const loadAlertState = () => loadJSON(LB_ALERT_STATE_PATH, {});
export const saveAlertState = s  => saveJSON(LB_ALERT_STATE_PATH, s);
export const loadCooldowns  = () => loadJSON(COOLDOWN_STATE_PATH, {});
export const saveCooldowns  = s  => saveJSON(COOLDOWN_STATE_PATH, s);
export const loadCvdState   = () => loadJSON(CVD_STATE_PATH, {});
export const saveCvdState   = s  => saveJSON(CVD_STATE_PATH, s);
export const loadHistory    = () => loadJSON(SYMBOL_HISTORY_PATH, []);
export const saveHistory    = h  => fs.writeFileSync(SYMBOL_HISTORY_PATH, JSON.stringify(h)); // compact — it's log data, not something you hand-edit

export const loadTradeState = () => loadJSON(TRADE_STATE_PATH, { tradingEnabled: true, lastUpdateId: 0, changedAt: 0 });
export const saveTradeState = s  => saveJSON(TRADE_STATE_PATH, s);

// ── Virtual paper-trading balance (only used when TRADE_SIZE_MODE=percent) ──
// Real balance isn't available in paper mode (no exchange account involved),
// so this file stands in for it: seeded once from PAPER_STARTING_BALANCE,
// then debited on every paper buy and credited back (qty × exit price) on
// every paper close — so percentage sizing compounds in paper mode the same
// way it will once you're live and pulling the real MEXC USDT balance.
export const loadPaperBalance = () => loadJSON(PAPER_BALANCE_PATH, { balance: PAPER_STARTING_BALANCE, updatedAt: 0 }).balance;
export function adjustPaperBalance(delta) {
  const state = loadJSON(PAPER_BALANCE_PATH, { balance: PAPER_STARTING_BALANCE, updatedAt: 0 });
  state.balance   = Math.max(0, parseFloat((state.balance + delta).toFixed(2)));
  state.updatedAt = Date.now();
  saveJSON(PAPER_BALANCE_PATH, state);
  return state.balance;
}

// ══════════════════════════════════════════════════════════════════════════════
// trade-log.json — PERMANENT record of every API buy/sell placed by the
// MEXC auto-trader (paper or live). Unlike positions.json, entries here are
// never evicted — this is the durable audit trail the GUI "API Trades" panel
// should read for full history, since positions.json only keeps a position
// around for 5-20 min after it closes (TERMINAL_EVICT_MS) before deleting it.
// ══════════════════════════════════════════════════════════════════════════════
export const loadTradeLog = () => loadJSON(TRADE_LOG_PATH, []);
export const saveTradeLog = t  => saveJSON(TRADE_LOG_PATH, t);

// Called the moment a buy (paper or live) is placed.
export function recordTradeOpen(pos, { mode, orderId, qty, fillPrice, usdSize }) {
  const log = loadTradeLog();
  log.push({
    id:          `${pos.sym}_${orderId}`,
    sym:         pos.sym,
    base:        pos.base,
    assetType:   pos.assetType,
    setup:       pos.setup,
    mode,
    status:      'open',
    buyAt:       Date.now(),
    buyOrderId:  orderId,
    buyQty:      qty,
    buyPrice:    fillPrice,
    usdSize,
    sellAt:      null,
    sellOrderId: null,
    sellQty:     null,
    sellPrice:   null,
    reason:      null,
    pnlPct:      null,
  });
  saveTradeLog(log);
  return log;
}

// Called the moment a position closes (stop/T1/T2/exit/rotation), for both
// paper and live trades. Matches the open entry by buyOrderId, falling back
// to the most recent still-open entry for the same symbol.
export function recordTradeClose(pos, reason, sell = {}) {
  const log      = loadTradeLog();
  const orderId  = pos.liveOrder?.buyOrderId;
  let   entry    = log.find(t => t.status === 'open' && t.buyOrderId === orderId);
  if (!entry) {
    entry = [...log].reverse().find(t => t.status === 'open' && t.sym === pos.sym);
  }
  if (!entry) return log; // no matching open trade — nothing to record

  entry.status      = 'closed';
  entry.sellAt      = Date.now();
  entry.sellOrderId = sell.orderId || null;
  entry.sellQty     = sell.qty ?? entry.buyQty;
  entry.sellPrice   = sell.fillPrice ?? null;
  entry.reason      = reason;
  entry.pnlPct      = (entry.buyPrice && entry.sellPrice)
    ? parseFloat(((entry.sellPrice - entry.buyPrice) / entry.buyPrice * 100).toFixed(2))
    : null;

  saveTradeLog(log);
  return log;
}

// ── Push trade-log.json to GitHub so the GUI's API Trades panel can read
// the full permanent history (same pattern as pushPositionsToGitHub) ──
export async function pushTradeLogToGitHub(tradeLog) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH         || 'main';
  const fpath  = process.env.GH_TRADE_LOG_PATH || 'scripts/trade-log.json';

  if (!token || !repo) {
    console.log('[trade-log-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
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
      message: `chore: trade log update (${tradeLog.length} trades) [skip ci]`,
      content: Buffer.from(JSON.stringify(tradeLog, null, 2)).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
    }
    console.log(`[trade-log-push] ✓ ${tradeLog.length} trade(s) on record`);
    logAudit('trade_log_pushed', { count: tradeLog.length });
  } catch (e) {
    console.warn(`[trade-log-push] ⚠ ${e.message}`);
    logAudit('trade_log_push_failed', { error: e.message });
  }
}

// ── Audit ──
// Kept as a count-based cap rather than a time window — a 1-hour window
// used to mean almost nothing survived between 15-min cron runs' worth of
// useful history. 3000 entries is roughly several days of activity at
// typical per-cycle volume, which is what the GUI's API Audit tab needs to
// show something meaningful rather than just the last run or two.
const AUDIT_MAX_ROWS = 3000;

export function logAudit(action, details = {}) {
  const entry = { timestamp: new Date().toISOString(), job: 'leaderboard-decider', action, ...details };
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); if (!Array.isArray(logs)) logs = []; } catch {}
  logs.push(entry);
  if (logs.length > AUDIT_MAX_ROWS) logs = logs.slice(logs.length - AUDIT_MAX_ROWS);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

export function loadAuditLog() {
  try { const logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); return Array.isArray(logs) ? logs : []; }
  catch { return []; }
}

// ── Push audit.json to GitHub so the GUI's new "API Audit" tab can read
// every API/trade action the headless job has taken (same pattern as
// pushPositionsToGitHub/pushTradeLogToGitHub) ──
export async function pushAuditLogToGitHub(logs) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_AUDIT_PATH    || 'scripts/audit-log.json';

  if (!token || !repo) {
    console.log('[audit-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
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
      message: `chore: audit log update (${logs.length} entries) [skip ci]`,
      content: Buffer.from(JSON.stringify(logs, null, 2)).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
    }
    console.log(`[audit-push] ✓ ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'} pushed`);
  } catch (e) {
    // Deliberately NOT calling logAudit here — a failure to push the audit
    // log logging itself would just grow the very file that failed to push.
    console.warn(`[audit-push] ⚠ ${e.message}`);
  }
}

// ── Push a snapshot of real MEXC account balances to GitHub, so the GUI's
// Trade Journal can cross-check whether a row it thinks is still "open"
// actually still has a matching balance on the exchange — catches drift from
// manual trading, missed sells, etc. that positions.json/trade-log.json
// alone wouldn't reveal. Live mode only; paper mode has no real balance. ──
export async function pushLiveBalancesToGitHub(balances) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH             || 'main';
  const fpath  = process.env.GH_LIVE_BALANCES_PATH || 'scripts/mexc-live-balances.json';

  if (!token || !repo) {
    console.log('[live-balances-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const snapshot = { fetchedAt: new Date().toISOString(), balances };
  const apiUrl   = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers  = {
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
      message: `chore: live balances snapshot (${balances.length} asset(s)) [skip ci]`,
      content: Buffer.from(JSON.stringify(snapshot, null, 2)).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
    }
    console.log(`[live-balances-push] ✓ ${balances.length} asset(s) pushed`);
    logAudit('live_balances_pushed', { count: balances.length });
  } catch (e) {
    console.warn(`[live-balances-push] ⚠ ${e.message}`);
    logAudit('live_balances_push_failed', { error: e.message });
  }
}

// ── Push positions.json to GitHub so the browser GUI stays in sync ──
export async function pushPositionsToGitHub(positions) {
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
// heartbeat.json — records the timestamp of the last successful job completion.
// Committed to the repo (same round-trip pattern as positions.json) so it
// persists across GitHub Actions runs, which otherwise have no memory of
// their own between invocations.
//
// Purpose: the schedule expects this job to run roughly every ~17 minutes
// (see alerts.yml). GitHub Actions scheduled (cron) workflows can silently
// get delayed or skipped during high load, or if the workflow is paused —
// there's no notification for that on GitHub's side. Checking "how long
// since the last successful run" at the START of every run is how the bot
// notices a gap itself, rather than someone discovering it retroactively by
// noticing stale prices or a position that should've rotated but didn't.
// ══════════════════════════════════════════════════════════════════════════════
export const loadHeartbeat = () => loadJSON(HEARTBEAT_PATH, { lastRunAt: 0 });

export async function pushHeartbeatToGitHub(lastRunAt) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_HEARTBEAT_PATH || 'scripts/heartbeat.json';

  if (!token || !repo) {
    console.log('[heartbeat-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
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
      message: `chore: heartbeat ${new Date(lastRunAt).toISOString()} [skip ci]`,
      content: Buffer.from(JSON.stringify({ lastRunAt }, null, 2)).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    let putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });

    // Lost a race with another concurrent run (e.g. a scheduled decide run
    // and a Cloudflare Worker-dispatched decide run landing at the same
    // time — see alerts.yml concurrency group notes) — refetch sha, retry once.
    if (!putRes.ok && putRes.status === 409) {
      const getRes2 = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
      if (getRes2.ok) {
        const j2 = await getRes2.json();
        body.sha = j2.sha || undefined;
        putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
      }
    }

    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
    }
    console.log(`[heartbeat-push] ✓ recorded ${new Date(lastRunAt).toISOString()}`);
  } catch (e) {
    console.warn(`[heartbeat-push] ⚠ ${e.message}`);
    logAudit('heartbeat_push_failed', { error: e.message });
  }
}

// Returns { stale, gapMinutes, lastRunAt } — checked at job start, BEFORE
// this run's own heartbeat gets written, so it reflects the gap since the
// PREVIOUS successful completion. lastRunAt === 0 (first run ever, or file
// missing) is never reported as stale — nothing to compare against yet.
export function checkHeartbeatStale(expectedIntervalMin = 17, thresholdMultiplier = 2.5) {
  const { lastRunAt } = loadHeartbeat();
  if (!lastRunAt) return { stale: false, gapMinutes: 0, lastRunAt: 0 };
  const gapMinutes = (Date.now() - lastRunAt) / 60000;
  const stale = gapMinutes > expectedIntervalMin * thresholdMultiplier;
  return { stale, gapMinutes: parseFloat(gapMinutes.toFixed(1)), lastRunAt };
}

