// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min v10.7: 2,19,36,53)
// v10.7
//
// Reads market-data.json (populated by Job A every 5 min), evaluates buy
// signals (both latest and peak-substituted) against LB_MIN_SCORE/cooldown/
// setup gates, writes positions to positions.json, sends Telegram, resets
// peak tracking in market-data.json.
//
// v10.3 changes:
//   - pushPositionsToGitHub(): after writing positions.json locally, also
//     pushes it to the repo via GitHub Contents API immediately so the browser
//     GUI can see new positions without waiting for the end-of-job git commit.
//   - Audit rotation changed from count-based (500 entries) to time-based (1h).
//   - positions_pushed / positions_push_failed audit events added.
//
// v10.4 changes:
//   - Early-exit pre-screen at top of processBuySignals(): checks every symbol's
//     conv (latest) and peakConv against LB_MIN_SCORE BEFORE loading cooldown
//     state, alert state, or positions. If nothing clears the threshold the job
//     logs a single 'no_candidates' audit event and stops immediately — no
//     wasted I/O, no noise in the audit log.
//
// v10.5 changes:
//   - SKIP_SETUPS no longer includes 'WATCHING'. Job B now fires on conviction
//     score alone (conv >= LB_MIN_SCORE) rather than requiring getSetupMode()
//     to return SQUEEZE NOW / BREAKOUT etc. at the exact 15-min polling moment.
//     Those labels appear for seconds; conv score persists across cycles.
//   - Added directional sanity gate (replaced in v10.6).
//   - getSetupMode() is now used for alert labeling only, not as a gate.
//
// v10.6 changes:
//   - Directional sanity gate replaced with bullConf gate (LB_BULL_CONF_MIN, default 5/10).
//     market-fetcher.js now computes calcBullConf(d) every 5min and stores bullConf +
//     bullChecks in market-data.json. Job B reads bullConf and skips any symbol below
//     the threshold — mirrors the GUI leaderboard 10-check panel exactly.
//     WATCHING with 2-3/10 conf = blocked. Real setup with 5+/10 = fires.
//   - LB_BULL_CONF_MIN added as GitHub Actions variable (default 5).
//   - no_candidates audit now logs bestBullConf so you can see how close market is.
//
// v10.7 changes:
//   - CAP BUY fast path: entry.capBuy.isCapBuy bypasses score + bullConf gates entirely.
//     Capitulation setups (extreme RSI + neg funding + CVD turning) are time-critical
//     and won't show bullConf >= 5 by definition (symbol is in a downtrend).
//   - Telegram alert enriched with whale score/zone, flow label, grade, successProb,
//     setup archetype, and bullConf count — all sourced from market-data.json.
//   - leaderboard-scanner.js now fetches r1h (1h RSI) for CAP BUY + bullConf accuracy.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { calcConviction, getSetupMode } from './leaderboard-scanner.js';

// Use process.cwd() for reliable path resolution in GitHub Actions
const MARKET_DATA_PATH    = path.join(process.cwd(), 'market-data.json');
const POSITIONS_PATH      = path.join(process.cwd(), 'positions.json');
const LB_ALERT_STATE_PATH = path.join(process.cwd(), 'lb-alert-state.json');
const AUDIT_PATH          = path.join(process.cwd(), 'audit.json');

const DRY_RUN         = process.argv.includes('--dry-run');
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');
const LB_BULL_CONF_MIN = parseInt(process.env.LB_BULL_CONF_MIN || '5'); // min bull confirmations out of 10
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');
const LB_HOLD_LOCK    = parseInt(process.env.LB_HOLD_LOCK    || '20');
const ALERT_STATE_TTL_HOURS = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

// WATCHING is no longer skipped — Job B fires on conviction score alone.
// getSetupMode() is used for labeling only, not as an alert gate.
// Only SHORT SETUP is blocked (bear direction, opposite of our buy logic).
const SKIP_SETUPS = new Set(['SHORT SETUP']);

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function loadMarketData()  { return loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} }); }
function saveMarketData(d) { saveJSON(MARKET_DATA_PATH, d); }
function loadPositions()   { return loadJSON(POSITIONS_PATH, {}); }
function savePositions(p)  { saveJSON(POSITIONS_PATH, p); }
function loadAlertState()  { return loadJSON(LB_ALERT_STATE_PATH, {}); }
function saveAlertState(s) { saveJSON(LB_ALERT_STATE_PATH, s); }

// ── Audit logging — rolling 1-hour window ──
function logAudit(action, details = {}) {
  const audit = { timestamp: new Date().toISOString(), job: 'leaderboard-decider', action, ...details };

  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    if (!Array.isArray(logs)) logs = [];
  } catch {}

  logs.push(audit);
  // Rotate: drop entries older than 1 hour
  const cutoff = Date.now() - 60 * 60 * 1000;
  logs = logs.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

function isOnCooldown(state, sym) {
  const ts = state[`lb_buy_${sym}`] || 0;
  return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
}
function markCooldown(state, sym) { state[`lb_buy_${sym}`] = Date.now(); }

function pruneAlertState(state) {
  const cutoff = Date.now() - ALERT_STATE_TTL_HOURS * 3_600_000;
  let pruned = 0;
  for (const [sym, entry] of Object.entries(state)) {
    if ((entry.lastSeenAt || 0) < cutoff) { delete state[sym]; pruned++; }
  }
  if (pruned) console.log(`[leaderboard-decider] Pruned ${pruned} stale alert-state entry(ies) (>${ALERT_STATE_TTL_HOURS}h).`);
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

// ── Push positions.json to GitHub Contents API ──────────────────────────────
// Uses GITHUB_TOKEN (always available in Actions) + GH_REPO repo variable.
// Writing here means the browser GUI sees the new position immediately —
// before the end-of-job git commit even runs.
async function pushPositionsToGitHub(positions) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_POSITIONS_PATH || 'scripts/positions.json';

  console.log(`[positions-push] token=${token ? '✓' : '✗ MISSING'} repo=${repo || '✗ MISSING'} path=${fpath}`);

  if (!token || !repo) {
    console.log('[positions-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    // GET current sha — required to update an existing file
    let sha = null;
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    console.log(`[positions-push] GET ${getRes.status}`);
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha || null;
      console.log(`[positions-push] existing sha=${sha}`);
    } else if (getRes.status !== 404) {
      throw new Error(`GET ${getRes.status}`);
    }

    const json    = JSON.stringify(positions, null, 2);
    const content = Buffer.from(json, 'utf8').toString('base64');
    const count   = Object.keys(positions).length;
    const body    = {
      message: `chore: headless positions update (${count} open) [skip ci]`,
      content,
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    console.log(`[positions-push] PUT ${putRes.status}`);
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || JSON.stringify(e)}`);
    }
    console.log(`[positions-push] ✓ pushed positions.json to GitHub (${count} position(s))`);
    logAudit('positions_pushed', { count, branch, path: fpath });
  } catch (e) {
    console.warn(`[positions-push] ⚠ failed: ${e.message}`);
    logAudit('positions_push_failed', { error: e.message });
  }
}

function evaluateSymbol(entry) {
  const latest  = { ...entry.d, conv: entry.conv, setup: entry.setup };
  const peakD   = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
  const peakConv  = calcConviction(peakD);
  const peakSetup = getSetupMode({ ...peakD, conv: peakConv });
  const peakIsStronger = peakConv > latest.conv && !SKIP_SETUPS.has(peakSetup.label);
  return peakIsStronger
    ? { conv: peakConv, setup: peakSetup, source: 'peak', shock: entry.peakShock, obi: entry.peakObi }
    : { conv: latest.conv, setup: latest.setup, source: 'latest', shock: entry.d.shock, obi: entry.d.obi };
}

async function processBuySignals() {
  const market  = loadMarketData();
  const symbols = Object.entries(market.symbols || {});

  if (!symbols.length) {
    console.log('[leaderboard-decider] market-data.json empty — has market-fetcher.js run yet?');
    logAudit('market_data_empty');
    return;
  }

  const ageMin = (Date.now() - (market.fetchedAt || 0)) / 60000;
  if (ageMin > (market.staleAfterMinutes || 30)) {
    console.log(`[leaderboard-decider] ⚠ market-data.json is ${ageMin.toFixed(1)} min old — proceeding, but check market-fetcher.js is running.`);
  }

  // ── Pre-screen: bail immediately if nothing clears LB_MIN_SCORE ──────────
  // Checks both latest conv and peak conv for every symbol. This runs BEFORE
  // loading cooldown state, alert state, or positions — so bear-market cycles
  // where nothing is close to the threshold cost almost nothing.
  const anyCandidate = symbols.some(([, entry]) => {
    // Pre-screen: conv threshold + not a pure SHORT SETUP.
    // WATCHING is now allowed through — label gate removed from Job B.
    if (entry.conv >= LB_MIN_SCORE && !SKIP_SETUPS.has(entry.setup?.label)) return true;
    const peakD     = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
    const peakConv  = calcConviction(peakD);
    const peakSetup = getSetupMode({ ...peakD, conv: peakConv });
    return peakConv >= LB_MIN_SCORE && !SKIP_SETUPS.has(peakSetup.label);
  });

  if (!anyCandidate) {
    const maxConv = Math.max(...symbols.map(([, e]) => e.conv ?? -Infinity));
    const bestConf = Math.max(...symbols.map(([, e]) => e.bullConf ?? 0));
    console.log(`[leaderboard-decider] Pre-screen: no symbol reaches min score ${LB_MIN_SCORE} (best conv: ${maxConv}, best bullConf: ${bestConf}/10) — stopping early.`);
    logAudit('no_candidates', { totalSymbols: symbols.length, minScore: LB_MIN_SCORE, bestConv: maxConv, bestBullConf: bestConf });
    return;
  }
  // ── End pre-screen ────────────────────────────────────────────────────────

  const cooldownState = loadJSON(path.join(process.cwd(), '.lb-scan-state.json'), {});
  const alertState    = pruneAlertState(loadAlertState());
  const positions     = loadPositions();

  const candidates = [];
  for (const [pair, entry] of symbols) {
    const evald = evaluateSymbol(entry);
    if (evald.conv < LB_MIN_SCORE)          { continue; }
    if (SKIP_SETUPS.has(evald.setup.label)) { continue; }
    // ── CAP BUY fast path — bypasses all score/conf gates ──
    // Capitulation bounces are time-critical: extreme RSI + negative funding +
    // CVD turning up = rare high-urgency setup. Fire immediately without waiting
    // for bullConf to build (it won't — the symbol is in a downtrend by definition).
    const isCapBuy = entry.capBuy?.isCapBuy ?? false;
    if (isCapBuy) {
      console.log(`  💥  ${pair} [CAP BUY] capScore:${entry.capBuy.capScore} — fast path, skipping score/conf gates`);
      // fall through to candidate — don't continue
    } else {
      // ── Bull confirmation gate — mirrors the GUI leaderboard 10-check panel ──
      // market-fetcher.js computes bullConf every 5min and stores it in market-data.json.
      // Requires at least LB_BULL_CONF_MIN (default 5/10) confirmations to fire.
      // WATCHING with 2-3/10 conf is correctly blocked; real setup will show 5+/10.
      const bullConf = entry.bullConf ?? 0;
      if (bullConf < LB_BULL_CONF_MIN) {
        console.log(`  ⏭  ${pair} [${evald.setup.label}] score:${evald.conv} bullConf:${bullConf}/10 < ${LB_BULL_CONF_MIN} — skipped`);
        continue;
      }
    }
    if (isOnCooldown(cooldownState, pair))  {
      console.log(`  🔕  ${pair} [${evald.setup.label}] score:${evald.conv} — cooldown`);
      continue;
    }

    const sym = `BINANCE:${pair}`;
    if (positions[sym] && positions[sym].status !== 'stopped' && positions[sym].status !== 'tp2_hit') {
      console.log(`  ⏭  ${pair} — already has an open position (status: ${positions[sym].status})`);
      continue;
    }

    candidates.push({ pair, sym, entry, evald });
  }

  if (!candidates.length) {
    // All symbols cleared the pre-screen conv threshold but were blocked by
    // SKIP_SETUPS, cooldown, or an existing open position.
    console.log('  ✓  No new leaderboard buy signals this cycle (blocked by cooldown / setup / open position)');
    saveMarketData(resetPeaks(market));
    saveJSON(path.join(process.cwd(), '.lb-scan-state.json'), cooldownState);
    saveAlertState(alertState);
    logAudit('buy_cycle_complete', { totalSymbols: symbols.length, signalsFound: 0, positionsOpened: 0, note: 'blocked_post_prescreen' });
    return;
  }

  const buyAlerts = [];
  for (const { pair, sym, entry, evald } of candidates) {
    markCooldown(cooldownState, pair);
    alertState[pair] = { lastLabel: evald.setup.label, lastConv: evald.conv, lastSeenAt: Date.now() };

    const levels = calcEntryLevels(entry.price, evald.shock);
    const now    = Date.now();
    const dir    = evald.setup.label === 'SHORT SETUP' ? 'bear' : 'bull';

    positions[sym] = {
      sym,
      base:          pair.replace('USDT', ''),
      setup:         evald.setup.label,
      dir,
      alertedAt:     now,
      holdLockUntil: now + LB_HOLD_LOCK * 60000,
      entryPrice:    levels ? parseFloat(levels.entry) : entry.price,
      stop:          levels ? parseFloat(levels.stop)  : 0,
      t1:            levels ? parseFloat(levels.t1)    : 0,
      t2:            levels ? parseFloat(levels.t2)    : 0,
      score:         evald.conv,
      spikeScore:    evald.shock,
      session:       '—',
      exitAlertedAt: null,
      tier1AlertedAt: null,
      status:        'watching',
      source:        'headless_v10.3',
      scoreSource:   evald.source,
    };

    buyAlerts.push({ pair, levels, evald, entry, price: entry.price, chg: entry.chg, d: entry.d });
    console.log(`  🟢  ${pair} [${evald.setup.label}] score:${evald.conv} (${evald.source}) → position opened`);
    logAudit('position_opened', {
      pair,
      setup:      evald.setup.label,
      score:      evald.conv,
      source:     evald.source,
      entryPrice: levels?.entry,
    });
  }

  // Write positions locally (committed by the workflow git push at job end)
  savePositions(positions);
  saveJSON(path.join(process.cwd(), '.lb-scan-state.json'), cooldownState);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));

  // Also push positions to GitHub immediately via Contents API so the browser
  // GUI can read the new entry without waiting for the end-of-job git commit.
  await pushPositionsToGitHub(positions);

  const utc = new Date().toUTCString().replace(/.*(\d{2}:\d{2}).*/, '$1') + ' UTC';
  const lines = buyAlerts.map(a => {
    const l = a.levels;
    const peakNote = a.evald.source === 'peak' ? '  _(caught via peak — spike faded before check)_' : '';
    return [
      `${a.evald.setup.emoji} *${a.pair.replace('USDT', '')}* — ${a.evald.setup.label}  [${a.evald.conv} pts]${peakNote}`,
      a.entry?.whale ? `  ${a.entry.whale.emoji} Whale ${a.entry.whale.score}/100 (${a.entry.whale.zone})  · Flow: ${a.entry.flow || '—'}  · Grade: ${a.entry.grade || '—'} (${a.entry.successProb || '—'}% win)` : '',
      a.entry?.archetype ? `  Setup: ${a.entry.archetype}  · BullConf: ${a.entry.bullConf ?? '—'}/10` : '',
      `  Price $${a.price}  Chg ${a.chg > 0 ? '+' : ''}${a.chg.toFixed(2)}%`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}  R:R ${l?.rr || '—'}`,
    ].join('\n');
  });

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    `_${buyAlerts.length} signal(s) · headless v10.7 · min score ${LB_MIN_SCORE} · bullConf ≥${LB_BULL_CONF_MIN}/10_`,
    '', lines.join('\n\n'), '',
    `_Position(s) opened automatically — tracked for stop/T1/T2 going forward._`,
  ].join('\n');

  await sendTelegram(msg);
  logAudit('buy_cycle_complete', {
    totalSymbols:    symbols.length,
    signalsFound:    candidates.length,
    positionsOpened: buyAlerts.length,
  });
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

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Leaderboard Decider (Job B) — ${new Date().toUTCString()}`);
  console.log(`Min score: ${LB_MIN_SCORE} | Cooldown: ${LB_COOLDOWN_MIN}min | Alert-state TTL: ${ALERT_STATE_TTL_HOURS}h | Dry-run: ${DRY_RUN}`);
  console.log('═'.repeat(60));

  logAudit('job_start', {
    minScore:    LB_MIN_SCORE,
    bullConfMin: LB_BULL_CONF_MIN,
    cooldownMin: LB_COOLDOWN_MIN,
    ghRepo:      process.env.GH_REPO      || '✗ missing',
    ghToken:     process.env.GITHUB_TOKEN  ? '✓' : '✗ missing',
    tgToken:     process.env.TELEGRAM_BOT_TOKEN ? '✓' : '✗ missing',
    tgEnabled:   TG_ENABLED,
    dryRun:      DRY_RUN,
  });
  await processBuySignals();
  logAudit('job_complete');

  console.log('\n✅  Job B (buy-side) complete.\n');
}

main().catch(err => {
  console.error('[leaderboard-decider] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
