// ══════════════════════════════════════════════════════════════════════════════
// market-fetcher.js — Job A (runs every 5 min)
// v10.2
//
// WHY: leaderboard setups (SQUEEZE NOW / BREAKOUT / DIP BUY) are gated partly
// by `shock` (15m volume spike) and `obi` (order book imbalance) — both of
// which can appear and fade within a single 15-min window, faster than even
// a 5-min poll reliably samples. Job B only runs every 15 min (v10.2: 2,19,36,53),
// so if it simply read "shock right now" it could land after a spike already faded
// and never know it happened.
//
// FIX: Job A runs every 5 min (3x per Job B cycle) and tracks the PEAK
// shock/obi seen *since the last time Job B consumed this file* — not just
// the latest snapshot. Job B reads the peak values (alongside the latest
// score/setup), then resets the peak tracking so the next window starts fresh.
// This means a spike that fades between polls still gets caught, without
// raising the poll rate (and Binance call volume) further.
//
// v10.2: Fixed path resolution for Actions runner compatibility + audit logging.
//
// Reuses scoreSymbol() from leaderboard-scanner.js — same scoring logic the
// GUI and Job B already rely on, no duplicate implementation.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { scoreSymbol } from './leaderboard-scanner.js';

// Use process.cwd() for reliable path resolution in GitHub Actions
const WATCHLIST_PATH    = path.join(process.cwd(), '..', 'watchlist.json');
const MARKET_DATA_PATH  = path.join(process.cwd(), 'market-data.json');
const AUDIT_PATH        = path.join(process.cwd(), 'audit.json');

// Market data older than this is considered stale by any consumer — purely
// a staleness signal via `fetchedAt`, not a rotation/deletion mechanism.
// (The file is fully overwritten every run regardless.)
const STALE_MINUTES = 30;

function loadWatchlistPairs() {
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    return list.filter(s => s.startsWith('BINANCE:')).map(s => s.replace('BINANCE:', ''));
  } catch {
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  }
}

// ── Load existing market-data.json so we can carry forward peak tracking ──
function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(MARKET_DATA_PATH, 'utf8'));
  } catch {
    return { fetchedAt: 0, symbols: {} };
  }
}

function saveMarketData(data) {
  fs.writeFileSync(MARKET_DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Audit logging ──
function logAudit(action, details = {}) {
  const audit = { timestamp: new Date().toISOString(), job: 'market-fetcher', action, ...details };
  
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

async function main() {
  const pairs = loadWatchlistPairs();
  if (!pairs.length) {
    console.log('[market-fetcher] No crypto symbols in watchlist — nothing to fetch.');
    logAudit('no_symbols', { count: 0 });
    return;
  }

  console.log(`[market-fetcher] Fetching ${pairs.length} symbol(s)...`);
  const existing = loadExisting();
  const now = Date.now();

  const results = await Promise.all(pairs.map(scoreSymbol));

  const symbols = {};
  let okCount = 0;
  const fetchResults = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const r    = results[i];
    const prev = existing.symbols?.[pair];

    if (!r) {
      // Fetch failed this cycle — carry forward the previous entry (if any)
      // rather than dropping the symbol, so a single failed poll doesn't
      // blank out peak tracking that's still within its window.
      if (prev) symbols[pair] = prev;
      console.log(`  ⚠  ${pair} — fetch failed, carrying forward previous data`);
      fetchResults.push({ pair, status: 'failed_carried_forward' });
      continue;
    }

    okCount++;
    const shock = r.d.shock || 1;
    const obi   = r.d.obi   || 0;

    // Peak tracking — max absolute shock/obi seen since Job B last reset
    // this entry (peakSince). If there's no previous entry, this cycle's
    // value is both the latest and the peak so far.
    const peakShock = Math.max(shock, prev?.peakShock ?? shock);
    const peakObi   = Math.abs(obi) > Math.abs(prev?.peakObi ?? 0) ? obi : (prev?.peakObi ?? obi);

    symbols[pair] = {
      pair,
      price: r.price,
      chg: r.chg,
      conv: r.conv,
      setup: r.setup,        // { label, emoji } — latest cycle's setup
      d: r.d,                // full indicator set — latest cycle's values
      peakShock,              // max shock since last Job B reset
      peakObi,                // max |obi| since last Job B reset (signed)
      peakSince: prev?.peakSince ?? now, // when this peak window started
      updatedAt: now,
    };
    
    fetchResults.push({ pair, status: 'success', conv: r.conv, setup: r.setup.label });
  }

  const out = { fetchedAt: now, staleAfterMinutes: STALE_MINUTES, symbols };
  saveMarketData(out);
  
  logAudit('fetch_complete', { totalPairs: pairs.length, successCount: okCount, failureCount: pairs.length - okCount, results: fetchResults });
  
  console.log(`[market-fetcher] Wrote market-data.json — ${okCount}/${pairs.length} symbol(s) updated.`);
}

main().catch(err => { 
  console.error('[market-fetcher] Fatal:', err); 
  logAudit('fatal_error', { error: err.message });
  process.exit(1); 
});

