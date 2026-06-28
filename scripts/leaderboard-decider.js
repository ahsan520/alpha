// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min)
// v10.9
//
// Changes from v10.8:
//   - Market session gate: skips entries where marketClosed:true (set by
//     market-fetcher when exchange is outside regular hours).
//   - LB_ALLOW_PRE_MARKET / LB_ALLOW_AH env vars (default false) control
//     whether pre-market and after-hours stock entries are evaluated.
//   - Date-keyed cooldown for stocks: one alert per symbol per trading day,
//     keyed by local exchange date. Resets naturally at midnight local time.
//     Crypto keeps time-based cooldown (LB_COOLDOWN_MIN minutes).
//   - buildSymKey() and cooldownKey() imported from exchange-registry.
//   - CAP BUY fast path restricted to crypto (unchanged from v10.8).
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

const DRY_RUN    = process.argv.includes('--dry-run');
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

const LB_MIN_SCORE     = parseInt(process.env.LB_MIN_SCORE     || '9');
const LB_BULL_CONF_MIN = parseInt(process.env.LB_BULL_CONF_MIN || '5');
const LB_COOLDOWN_MIN  = parseInt(process.env.LB_COOLDOWN_MIN  || '60');
const LB_HOLD_LOCK     = parseInt(process.env.LB_HOLD_LOCK     || '20');
const ALLOW_PRE_MARKET = (process.env.LB_ALLOW_PRE_MARKET || 'false') === 'true';
const ALLOW_AH         = (process.env.LB_ALLOW_AH         || 'false') === 'true';
const ALERT_STATE_TTL  = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

const SKIP_SETUPS = new Set(['SHORT SETUP']);

// ── I/O helpers ──
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, o)  { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

const loadMarketData   = () => loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} });
const saveMarketData   = d  => saveJSON(MARKET_DATA_PATH, d);
const loadPositions    = () => loadJSON(POSITIONS_PATH, {});
const savePositions    = p  => saveJSON(POSITIONS_PATH, p);
const loadAlertState   = () => loadJSON(LB_ALERT_STATE_PATH, {});
const saveAlertState   = s  => saveJSON(LB_ALERT_STATE_PATH, s);
const loadCooldowns    = () => loadJSON(COOLDOWN_STATE_PATH, {});
const saveCooldowns    = s  => saveJSON(COOLDOWN_STATE_PATH, s);

// ── Audit ──
function logAudit(action, details = {}) {
  const entry = { timestamp: new Date().toISOString(), job: 'leaderboard-decider', action, ...details };
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); if (!Array.isArray(logs)) logs = []; } catch {}
  logs.push(entry);
  logs = logs.filter(e => new Date(e.timestamp).getTime() >= Date.now() - 3_600_000);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

// ── Cooldown helpers ──
// Crypto:  time-based key — expires after LB_COOLDOWN_MIN
// Stocks:  date-keyed    — one alert per trading day per symbol
function isOnCooldown(state, cdKey, assetType) {
  const ts = state[cdKey] || 0;
  if (assetType === 'crypto') return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
  // For stocks the date is baked into the key — any truthy value means already fired today
  return ts > 0;
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

async function pushPositionsToGitHub(positions) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_POSITIONS_PATH || 'scripts/positions.json';

  if (!token || !repo) { console.log('[positions-push] Skipping — GITHUB_TOKEN or GH_REPO not set'); return; }

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
      message: `chore: headless positions update (${Object.keys(positions).length} open) [skip ci]`,
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

// ── Evaluate latest vs peak signal, return stronger ──
function evaluateSymbol(entry) {
  const latest   = { conv: entry.conv, setup: entry.setup, shock: entry.d?.shock, obi: entry.d?.obi };
  const peakD    = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
  const peakConv = calcConviction(peakD);
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
async function processBuySignals() {
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

  const cryptoCount  = entries.filter(([, e]) => e.assetType === 'crypto').length;
  const stockCount   = entries.filter(([, e]) => e.assetType === 'stock').length;
  const frozenCount  = entries.filter(([, e]) => e.marketClosed).length;
  console.log(`[leaderboard-decider] ${entries.length} symbols — ${cryptoCount} crypto, ${stockCount} stock (${frozenCount} frozen)`);

  // ── Pre-screen: any symbol could clear min score? ──
  const anyCandidate = entries.some(([, entry]) => {
    if (entry.marketClosed) return false;
    if (entry.conv >= LB_MIN_SCORE && !SKIP_SETUPS.has(entry.setup?.label)) return true;
    const peakD    = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
    const peakConv = calcConviction(peakD);
    return peakConv >= LB_MIN_SCORE && !SKIP_SETUPS.has(getSetupMode({ ...peakD, conv: peakConv }).label);
  });

  if (!anyCandidate) {
    const bestConv = Math.max(...entries.map(([, e]) => e.conv ?? -Infinity));
    console.log(`[leaderboard-decider] Pre-screen: nothing reaches ${LB_MIN_SCORE} (best: ${bestConv}) — stopping early.`);
    logAudit('no_candidates', { bestConv });
    saveMarketData(resetPeaks(market));
    return;
  }

  const cooldowns  = loadCooldowns();
  const alertState = pruneAlertState(loadAlertState());
  const positions  = loadPositions();
  const candidates = [];

  for (const [pair, entry] of entries) {

    // ── 1. Market session gate ──
    if (entry.marketClosed) {
      console.log(`  ⏸  ${pair} — market closed`);
      continue;
    }
    if (entry.session === 'pre_market' && !ALLOW_PRE_MARKET) {
      console.log(`  ⏸  ${pair} — pre-market (LB_ALLOW_PRE_MARKET=false)`);
      continue;
    }
    if (entry.session === 'after_hours' && !ALLOW_AH) {
      console.log(`  ⏸  ${pair} — after-hours (LB_ALLOW_AH=false)`);
      continue;
    }

    // ── 2. Score gate ──
    const evald = evaluateSymbol(entry);
    if (evald.conv < LB_MIN_SCORE)          continue;
    if (SKIP_SETUPS.has(evald.setup.label)) continue;

    // ── 3. CAP BUY fast path (crypto only) ──
    const isCapBuy = entry.assetType === 'crypto' && (entry.capBuy?.isCapBuy ?? false);
    if (!isCapBuy) {
      // ── 4. Bull confirmation gate ──
      if ((entry.bullConf ?? 0) < LB_BULL_CONF_MIN) {
        console.log(`  ⏭  ${pair} bullConf:${entry.bullConf}/10 < ${LB_BULL_CONF_MIN} — skipped`);
        continue;
      }
    }

    // ── 5. Cooldown gate ──
    // Crypto: time-based.  Stocks: date-keyed (one per trading day).
    const cdKey = cooldownKey(pair, entry.assetType);
    if (isOnCooldown(cooldowns, cdKey, entry.assetType)) {
      console.log(`  🔕  ${pair} — cooldown`);
      continue;
    }

    // ── 6. Open position gate ──
    const sym = buildSymKey(pair);
    if (positions[sym]?.status && !['stopped', 'tp2_hit'].includes(positions[sym].status)) {
      console.log(`  ⏭  ${pair} — open position (${positions[sym].status})`);
      continue;
    }

    candidates.push({ pair, sym, entry, evald, cdKey, isCapBuy });
  }

  if (!candidates.length) {
    console.log('  ✓  No new buy signals this cycle');
    saveMarketData(resetPeaks(market));
    saveCooldowns(cooldowns);
    saveAlertState(alertState);
    logAudit('buy_cycle_complete', { signalsFound: 0 });
    return;
  }

  // ── Open positions ──
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
      source:         'headless_v10.9',
      scoreSource:    evald.source,
    };

    buyAlerts.push({ pair, sym, levels, evald, price: entry.price, chg: entry.chg, d: entry.d, entry });
    console.log(`  🟢  ${pair} [${evald.setup.label}] score:${evald.conv} (${evald.source}) ${entry.assetType} session:${entry.session} → ${sym}`);
    logAudit('position_opened', { pair, sym, assetType: entry.assetType, setup: evald.setup.label, score: evald.conv, session: entry.session });
  }

  savePositions(positions);
  saveCooldowns(cooldowns);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));

  await pushPositionsToGitHub(positions);

  // ── Telegram ──
  const utc = new Date().toUTCString().slice(17, 22) + ' UTC';

  const lines = buyAlerts.map(a => {
    const l         = a.levels;
    const peakNote  = a.evald.source === 'peak' ? ' _(peak)_' : '';
    const assetBadge = a.entry.assetType === 'stock' ? ' 📊' : '';
    const sessionTag = a.entry.session !== 'open' && a.entry.session !== '24/7'
      ? ` _(${a.entry.session})_` : '';
    return [
      `${a.evald.setup.emoji} *${a.pair.replace('USDT', '')}*${assetBadge} — ${a.evald.setup.label} [${a.evald.conv} pts]${peakNote}${sessionTag}`,
      a.entry.whale
        ? `  ${a.entry.whale.emoji} Whale ${a.entry.whale.score}/100 · Flow: ${a.entry.flow || '—'} · Grade: ${a.entry.grade || '—'} (${a.entry.successProb || '—'}% win)`
        : '',
      `  Setup: ${a.entry.archetype || '—'} · BullConf: ${a.entry.bullConf ?? '—'}/10`,
      `  Price: ${a.price}  Chg: ${a.chg > 0 ? '+' : ''}${a.chg?.toFixed(2)}%`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}  R:R ${l?.rr || '—'}`,
      `  _Pos: ${a.sym}_`,
    ].filter(Boolean).join('\n');
  });

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    `_${buyAlerts.length} signal(s) · v10.9 · min ${LB_MIN_SCORE} · bullConf≥${LB_BULL_CONF_MIN}/10_`,
    '', lines.join('\n\n'), '',
    `_Position(s) opened — tracked for stop/T1/T2._`,
  ].join('\n');

  await sendTelegram(msg);
  logAudit('buy_cycle_complete', { signalsFound: candidates.length, positionsOpened: buyAlerts.length });
}

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Leaderboard Decider v10.9 — ${new Date().toUTCString()}`);
  console.log(`MinScore:${LB_MIN_SCORE} BullConf:${LB_BULL_CONF_MIN} Cooldown:${LB_COOLDOWN_MIN}min AH:${ALLOW_AH} Pre:${ALLOW_PRE_MARKET} DryRun:${DRY_RUN}`);
  console.log('═'.repeat(60));

  logAudit('job_start', {
    minScore: LB_MIN_SCORE, bullConfMin: LB_BULL_CONF_MIN,
    cooldownMin: LB_COOLDOWN_MIN, allowAH: ALLOW_AH, allowPre: ALLOW_PRE_MARKET,
    ghRepo: process.env.GH_REPO || '✗ missing',
    tgEnabled: TG_ENABLED, dryRun: DRY_RUN,
  });

  await processBuySignals();
  logAudit('job_complete');
  console.log('\n✅  Job B complete.\n');
}

main().catch(err => {
  console.error('[leaderboard-decider] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
