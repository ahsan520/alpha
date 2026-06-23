// ══════════════════════════════════════════════════════════════
// alert-runner.js  —  GitHub Actions server-side alert checker
// Supports: Binance crypto (BTCUSDT) + Yahoo Finance stocks/ETFs (ETHY.TO)
// ══════════════════════════════════════════════════════════════

import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN    = process.argv.includes('--dry-run');
const STATE_FILE = path.join(__dirname, '.alert-state.json');

// ── Run mode ──────────────────────────────────────────────────────────────
// 'full'      — watchlist signal scan + leaderboard scanner + position
//               tracker. Heavier (klines/depth/funding per symbol). Meant
//               for the hourly schedule, matching the 4h/daily timeframes
//               the scoring logic actually operates on.
// 'positions' — position tracker ONLY (stop/T1/T2 checks on open GUI
//               positions). One ticker call per open position — cheap
//               enough to run every 5-10 min for timely stop alerts
//               without re-running the full multi-symbol indicator scan.
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || '--mode=full').split('=')[1];

// ── Config from environment ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN  || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID    || '';
// TELEGRAM_ENABLED — set as a repo Variable (plain text 'true'/'false').
// Defaults to true when token + chat are present so existing setups keep working.
// Set to 'false' to silence all Telegram without removing the secrets.
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';
// ALERT_COOLDOWN_HOURS — min hours between repeated alerts for the same symbol/rule.
// Default 1h — position tracker fires at most once per hour per event type.
const COOLDOWN_HOURS  = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '1');
const DIGEST_MODE     = (process.env.DIGEST_MODE || 'true') === 'true';

// ── Leaderboard / position tracker tuning (override via repo Variables) ──
// These mirror the GUI leaderboard alert config so the headless runner
// uses the same thresholds without needing the browser open.
const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');   // min conviction score
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');  // min between buy alerts (min)
const LB_HOLD_LOCK    = parseInt(process.env.LB_HOLD_LOCK    || '20');  // hold lock after entry (min)
const LB_CVD_CYCLES   = parseInt(process.env.LB_CVD_CYCLES   || '3');   // CVD decline cycles for exit

// Watchlist — reads from watchlist.json at repo root (single source of truth).
// Override via WATCHLIST env var as a JSON array string (useful for testing).
const WATCHLIST_JSON_PATH = path.join(__dirname, '..', 'watchlist.json');
const WATCHLIST = process.env.WATCHLIST
  ? JSON.parse(process.env.WATCHLIST)
  : (() => {
      try {
        const list = JSON.parse(fs.readFileSync(WATCHLIST_JSON_PATH, 'utf8'));
        console.log(`📋  Loaded ${list.length} tickers from watchlist.json`);
        return list;
      } catch (e) {
        console.warn('⚠  watchlist.json not found — using built-in fallback list');
        return ['ETHY.TO','KILO.TO','GE.TO','XRPP.TO','ETHH.TO','SVR.TO',
                'XBM.TO','XEG.TO','T.TO','CGL.TO','GLCC.TO','ENCC.TO',
                'TXF.TO','HTAE.TO','QMAX.TO'];
      }
    })();

// ── Position loading — Option A or Option B ─────────────────────────────────
//
// Option A (Browser PAT): GUI pushes positions.json to the repo via localStorage
//   PAT. The runner reads the local file (checked out by actions/checkout).
//   Nothing extra needed — loadPositions() reads the file directly.
//
// Option B (GitHub Secrets): No PAT in the browser. The runner fetches
//   positions.json from the GitHub Contents API using GITHUB_TOKEN + GH_REPO.
//   Set GH_REPO (and optionally GH_BRANCH / GH_POSITIONS_PATH) as repo Variables.
//
const POSITIONS_JSON_PATH = path.join(__dirname, 'positions.json');

async function loadPositionsFromGitHub() {
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH || 'main';
  const fpath  = process.env.GH_POSITIONS_PATH || 'scripts/positions.json';
  const token  = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;

  const url = `https://api.github.com/repos/${repo}/contents/${fpath}?ref=${encodeURIComponent(branch)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization':        `Bearer ${token}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      if (res.status === 404) return {}; // no positions file yet = no open positions
      throw new Error(`GitHub API ${res.status}`);
    }
    const j    = await res.json();
    const raw  = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    console.warn(`[Option B] Failed to fetch positions from GitHub: ${e.message}`);
    return null; // fall through to local file
  }
}

function loadPositionsLocal() {
  try {
    const raw = JSON.parse(fs.readFileSync(POSITIONS_JSON_PATH, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
}

async function loadPositions() {
  // Option B: GH_REPO set → fetch from GitHub API (headless, no browser PAT needed)
  if (process.env.GH_REPO) {
    const remote = await loadPositionsFromGitHub();
    if (remote !== null) {
      console.log(`[positions] Loaded from GitHub API (Option B) — ${Object.keys(remote).length} position(s)`);
      return remote;
    }
    console.warn('[positions] GitHub API fetch failed — falling back to local file');
  }
  // Option A: read local checkout (default)
  const local = loadPositionsLocal();
  console.log(`[positions] Loaded from local file (Option A) — ${Object.keys(local).length} position(s)`);
  return local;
}

function stripExchangePrefix(sym) {
  return sym.startsWith('BINANCE:') ? sym.slice('BINANCE:'.length) : sym;
}

// ── Overnight checklist conditions ──
const OVN_BUY_CONDITIONS = [
  { id:'ovn_buy_4h',     required:true,  enabled:true,  label:'4H Bias',    desc:'BULL 4H or LEAN BULL' },
  { id:'ovn_buy_daily',  required:true,  enabled:true,  label:'Daily Bias', desc:'BULL / LEAN BULL / NEUTRAL' },
  { id:'ovn_buy_signal', required:false, enabled:true,  label:'Signal',     desc:'STRONG BUY or BULLISH' },
  { id:'ovn_buy_oi',     required:false, enabled:false, label:'OI / Fund',  desc:'OI DROP or CONFIRM' },
];

const OVN_SELL_CONDITIONS = [
  { id:'ovn_sell_daily', required:true,  enabled:true,  label:'Daily Bias', desc:'LEAN BEAR or BEAR DAY' },
  // FIX Bug 3: ovn_sell_4h was too loose (passed on NEUTRAL → almost everything qualified).
  // Now requires an explicitly bearish 4H (LEAN BEAR or BEAR 4H), not NEUTRAL.
  { id:'ovn_sell_4h',    required:true,  enabled:true,  label:'4H Bias',    desc:'LEAN BEAR or BEAR 4H' },
  // FIX Bug 3 (related): ovn_sell_signal was passing on WAIT (too common).
  // Now only passes on explicitly bearish signals.
  { id:'ovn_sell_signal',required:false, enabled:true,  label:'Signal',     desc:'BEARISH or STRONG SELL' },
  { id:'ovn_sell_oi',    required:false, enabled:false, label:'OI Div',     desc:'BEAR OI or OI DROP' },
  { id:'ovn_sell_ls',    required:false, enabled:false, label:'L/S Ratio',  desc:'≥65% Longs' },
];

// ── Signal & overnight rules — ALL disabled by default. ──────────────────────
// Only the position tracker (checkPositions) sends Telegram alerts by default.
// Enable individual rules here or via repo Variables (ENABLED_RULES) if needed.
const DEFAULT_RULES = [
  { id:'vol_bull_4h',    group:'signals',       action:'buy',  enabled:false },
  { id:'strong_buy',     group:'signals',       action:'buy',  enabled:false },
  { id:'strong_sell',    group:'signals',       action:'sell', enabled:false },
  { id:'bearish_day',    group:'signals',       action:'sell', enabled:false },
  { id:'dip_buy',        group:'signals',       action:'buy',  enabled:false },
  { id:'overnight_buy',  group:'overnight_buy', action:'buy',  enabled:false, minRequired:2, minOptional:1 },
  { id:'overnight_sell', group:'overnight_sell',action:'sell', enabled:false, minRequired:2, minOptional:1 },
];

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════
function isCrypto(sym) {
  // Crypto: no dot suffix (BTCUSDT), stocks have dot (ETHY.TO)
  return !sym.includes('.');
}

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Yahoo Finance requires a session cookie + crumb since late 2023.
// We fetch these once at startup and reuse for all stock requests.
let yahooCookie = '';
let yahooCrumb  = '';

async function initYahoo() {
  try {
    // Step 1: get session cookie
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA },
      redirect: 'follow',
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    // Extract the A3 or A1 cookie
    const cookieMatch = setCookie.match(/(A\d=[^;]+)/);
    yahooCookie = cookieMatch ? cookieMatch[1] : '';

    // Step 2: get crumb
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YAHOO_UA,
        'Cookie': yahooCookie,
      },
    });
    yahooCrumb = await r2.text();
    if (yahooCrumb && !yahooCrumb.includes('<') && yahooCrumb.length < 50) {
      console.log(`  📡  Yahoo crumb obtained (${yahooCrumb.length} chars)`);
    } else {
      console.log('  ⚠  Yahoo crumb fetch returned unexpected value — stock data may fail');
      yahooCrumb = '';
    }
  } catch (e) {
    console.log('  ⚠  Yahoo init failed:', e.message);
  }
}

function yahooHeaders() {
  return {
    'User-Agent': YAHOO_UA,
    'Cookie': yahooCookie,
    'Accept': 'application/json',
  };
}

async function fetchJSON(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tid); }
}

// ── Resilient Binance fetch ───────────────────────────────────────────────
// api.binance.com returns HTTP 451 ("unavailable for legal reasons") for
// requests from US-based datacenter IPs — which is exactly what GitHub-hosted
// runners are. Three-step fallback, same pattern the browser GUI already
// uses in js/api.js (direct → proxy):
//   1. data-api.binance.vision — Binance's own public market-data mirror,
//      intended for this exact use case (no auth, read-only, not subject
//      to the same regional trading restrictions as api.binance.com).
//   2. api.binance.com direct — in case the mirror is ever the one that's
//      down/blocked instead.
//   3. Public CORS proxy (corsproxy.io) — last resort, free but not
//      uptime-guaranteed, mirrors the browser's own proxy fallback.
// NOTE: fapi.binance.com (futures — funding rate) has no public mirror
// equivalent, so it only gets steps 2+3.
const BINANCE_MIRROR = 'https://data-api.binance.vision';
const BINANCE_DIRECT = 'https://api.binance.com';
const PROXY_PREFIX   = 'https://corsproxy.io/?url=';

async function fetchBinance(urlPath, { useMirror = true } = {}) {
  const candidates = [];
  if (useMirror) candidates.push(`${BINANCE_MIRROR}${urlPath}`);
  candidates.push(`${BINANCE_DIRECT}${urlPath}`);

  let lastErr = null;
  for (const url of candidates) {
    try {
      return await fetchJSON(url);
    } catch (e) {
      lastErr = e;
    }
  }
  // Last resort — public CORS proxy around the direct URL.
  try {
    return await fetchJSON(`${PROXY_PREFIX}${encodeURIComponent(`${BINANCE_DIRECT}${urlPath}`)}`);
  } catch (e) {
    lastErr = e;
  }
  throw lastErr || new Error('all Binance endpoints failed');
}

// RSI calculation (mirrors v8 calcRSI)
function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    g += d > 0 ? d : 0; l += d < 0 ? -d : 0;
  }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

// ════════════════════════════════════════════════════
// CRYPTO DATA (Binance)
// ════════════════════════════════════════════════════
async function fetchCryptoTicker(pair) {
  try {
    const d = await fetchBinance(`/api/v3/ticker/24hr?symbol=${pair}`);
    return { price: parseFloat(d.lastPrice), chgPct: parseFloat(d.priceChangePercent) };
  } catch (e) {
    console.log(`  ⚠  fetchCryptoTicker failed for ${pair}: ${e.message}`);
    return null;
  }
}

async function fetchCrypto4h(pair) {
  try {
    const k = await fetchBinance(`/api/v3/klines?symbol=${pair}&interval=4h&limit=50`);
    if (!Array.isArray(k) || k.length < 5) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const vols   = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const recentUp = closes[n-1] > closes[n-4];
    const volUp    = vols[n-1] > (vols[n-2]+vols[n-3]+vols[n-4])/3;
    const k2 = 2/9; let ema8 = closes[0];
    for (let i = 1; i < n; i++) ema8 = closes[i]*k2 + ema8*(1-k2);
    const rsi4h = calcRSI(closes, 14);
    let cvd4h = 0;
    for (let i = n-4; i < n; i++) cvd4h += closes[i] > parseFloat(k[i][1]) ? 1 : -1;
    return { aboveEma8: closes[n-1] > ema8, recentUp, volUp, rsi4h, cvd4h };
  } catch (e) {
    console.log(`  ⚠  fetchCrypto4h failed for ${pair}: ${e.message}`);
    return null;
  }
}

async function fetchCryptoDaily(pair) {
  try {
    const k = await fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1d&limit=14`);
    if (!Array.isArray(k) || k.length < 7) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const vols   = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2/8; let ema7 = closes[0];
    for (let i = 1; i < n; i++) ema7 = closes[i]*k2 + ema7*(1-k2);
    const avgVol = vols.slice(0,n-1).reduce((a,b)=>a+b,0)/(n-1);
    const volSurge = vols[n-1] > avgVol*1.5;
    const chg7d = parseFloat(((closes[n-1]-closes[n-7])/closes[n-7]*100).toFixed(1));
    let cvdDaily = 0;
    for (let i = n-7; i < n; i++) cvdDaily += closes[i] > parseFloat(k[i][1]) ? 1 : -1;
    return { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d, cvdDaily };
  } catch (e) {
    console.log(`  ⚠  fetchCryptoDaily failed for ${pair}: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════
// STOCK / ETF DATA (Yahoo Finance) — ported from v8 api.js
// ════════════════════════════════════════════════════
async function fetchStockTicker(sym) {
  const crumbSuffix = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  // Try v8 chart
  try {
    const d = await fetchJSON(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d${crumbSuffix}`,
      yahooHeaders()
    );
    const r    = d.chart.result[0];
    const p    = r.meta.regularMarketPrice || r.meta.previousClose;
    const prev = r.meta.previousClose || r.meta.chartPreviousClose;
    return { price: p, chgPct: prev ? ((p-prev)/prev*100) : 0 };
  } catch {}
  // Fallback: v7 quote
  try {
    const d = await fetchJSON(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}${crumbSuffix}`,
      yahooHeaders()
    );
    const q = d.quoteResponse.result[0];
    return { price: q.regularMarketPrice, chgPct: q.regularMarketChangePercent };
  } catch {}
  return null;
}

async function fetchStockExtra(sym) {
  const extra = { k4h: null, kDay: null };
  const crumbSuffix = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  try {
    const d = await fetchJSON(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo${crumbSuffix}`,
      yahooHeaders()
    );
    const r  = d.chart.result[0];
    const qi = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < qi.close.length; i++) {
      if (qi.close[i] != null && qi.open[i] != null && qi.volume[i] != null)
        bars.push({ c: qi.close[i], o: qi.open[i], v: qi.volume[i] });
    }
    const n = bars.length;
    if (n < 10) return extra;

    const closes = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);
    const rsiDaily = calcRSI(closes, 14);

    // k4h proxy (recent daily bars stand in for 4H)
    const recentUp = closes[n-1] > closes[n-5];
    const rv = volumes.slice(-5);
    const volUp = rv[4] > (rv.slice(0,4).reduce((a,b)=>a+b,0)/4);
    const k2 = 2/9; let ema8 = closes[Math.max(0,n-9)];
    for (let i = Math.max(0,n-8); i < n; i++) ema8 = closes[i]*k2 + ema8*(1-k2);
    let cvd4h = 0;
    for (let i = n-4; i < n; i++) cvd4h += bars[i].c >= bars[i].o ? 1 : -1;
    extra.k4h = { rsi4h: rsiDaily, recentUp, volUp, aboveEma8: closes[n-1] > ema8, cvd4h };

    // kDay
    const k3 = 2/8; let ema7 = closes[Math.max(0,n-8)];
    for (let i = Math.max(0,n-7); i < n; i++) ema7 = closes[i]*k3 + ema7*(1-k3);
    const avgVol = volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/Math.min(20,volumes.length-1)||1;
    const volSurge = volumes[n-1] > avgVol*1.4;
    const chg7d = closes[n-7] > 0 ? parseFloat(((closes[n-1]-closes[n-7])/closes[n-7]*100).toFixed(1)) : 0;
    let cvdDaily = 0;
    for (let i = n-7; i < n; i++) cvdDaily += bars[i].c >= bars[i].o ? 1 : -1;
    extra.kDay = { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d, cvdDaily };
  } catch (e) {
    console.log(`  ⚠  fetchStockExtra failed for ${sym}: ${e.message}`);
  }
  return extra;
}

// ════════════════════════════════════════════════════
// UNIFIED FETCH
// ════════════════════════════════════════════════════
async function fetchAll(sym) {
  if (isCrypto(sym)) {
    // FIX: Binance's API rejects the "BINANCE:" TradingView-style prefix —
    // strip it before hitting api.binance.com, same as fetchPositionPrice etc. do.
    const bare = stripExchangePrefix(sym);
    const [ticker, k4h, kDay] = await Promise.all([
      fetchCryptoTicker(bare),
      fetchCrypto4h(bare),
      fetchCryptoDaily(bare),
    ]);
    return { ticker, k4h, kDay };
  } else {
    const [ticker, extra] = await Promise.all([
      fetchStockTicker(sym),
      fetchStockExtra(sym),
    ]);
    return { ticker, k4h: extra.k4h, kDay: extra.kDay };
  }
}

// Lightweight price-only lookup for GUI-tracked positions — we only need
// the current price to evaluate stop/T1/T2, not the full bias computation.
async function fetchPositionPrice(sym) {
  const bare = stripExchangePrefix(sym);
  if (isCrypto(bare)) {
    const t = await fetchCryptoTicker(bare);
    return t ? t.price : null;
  }
  const t = await fetchStockTicker(bare);
  return t ? t.price : null;
}


function computeSignals(ticker, k4h, kDay) {
  const chg = ticker.chgPct;

  // ── 4H bias ──
  let bias4hScore = 0;
  if (k4h) {
    if (k4h.aboveEma8) bias4hScore += 2; else bias4hScore -= 2;
    if (k4h.recentUp)  bias4hScore += 1; else bias4hScore -= 1;
    if (k4h.volUp && k4h.recentUp)  bias4hScore += 1;
    if (k4h.volUp && !k4h.recentUp) bias4hScore -= 1;
    if (k4h.cvd4h >= 2) bias4hScore += 2; else if (k4h.cvd4h >= 1) bias4hScore += 1;
    else if (k4h.cvd4h <= -2) bias4hScore -= 2; else if (k4h.cvd4h <= -1) bias4hScore -= 1;
    if (k4h.rsi4h !== null) {
      if (k4h.rsi4h < 35) bias4hScore += 1; else if (k4h.rsi4h > 65) bias4hScore -= 1;
    }
  }
  let bias4h;
  if      (bias4hScore >= 4)  bias4h = 'BULL 4H';
  else if (bias4hScore >= 2)  bias4h = 'LEAN BULL';
  else if (bias4hScore <= -4) bias4h = 'BEAR 4H';
  else if (bias4hScore <= -2) bias4h = 'LEAN BEAR';
  else                        bias4h = 'NEUTRAL';

  // ── Daily bias ──
  let biasDayScore = 0;
  if (kDay) {
    if (kDay.aboveEma7) biasDayScore += 2; else biasDayScore -= 2;
    if (kDay.chg7d > 5) biasDayScore += 2; else if (kDay.chg7d > 1) biasDayScore += 1;
    else if (kDay.chg7d < -5) biasDayScore -= 2; else if (kDay.chg7d < -1) biasDayScore -= 1;
    if (kDay.volSurge && kDay.chg7d > 0) biasDayScore += 1;
    if (kDay.volSurge && kDay.chg7d < 0) biasDayScore -= 1;
    if (kDay.cvdDaily >= 4) biasDayScore += 2; else if (kDay.cvdDaily >= 2) biasDayScore += 1;
    else if (kDay.cvdDaily <= -4) biasDayScore -= 2; else if (kDay.cvdDaily <= -2) biasDayScore -= 1;
    if (kDay.rsiDaily !== null) {
      if (kDay.rsiDaily < 35) biasDayScore += 1; else if (kDay.rsiDaily > 65) biasDayScore -= 1;
    }
  }
  let biasDay;
  if      (biasDayScore >= 5)  biasDay = 'BULL DAY';
  else if (biasDayScore >= 2)  biasDay = 'LEAN BULL';
  else if (biasDayScore <= -5) biasDay = 'BEAR DAY';
  else if (biasDayScore <= -2) biasDay = 'LEAN BEAR';
  else                         biasDay = 'NEUTRAL';

  // ── Overall score ──
  let score = 0;
  score += Math.round(bias4hScore * 0.4);
  score += Math.round(biasDayScore * 0.3);
  if (chg > 1.5) score += 2; else if (chg > 0.5) score += 1;
  else if (chg < -1.5) score -= 2; else if (chg < -0.5) score -= 1;

  let sig;
  if      (score >= 6)  sig = 'STRONG BUY';
  else if (score >= 3)  sig = 'BULLISH';
  else if (score <= -6) sig = 'STRONG SELL';
  else if (score <= -3) sig = 'BEARISH';
  else                  sig = 'WAIT';

  const shock = (0.7 + Math.abs(chg) / 5).toFixed(2);

  const priceUp   = chg >= 0;
  const longHeavy = score > 0;
  let oiDiv;
  if      (priceUp  && !longHeavy) oiDiv = 'OI DROP';
  else if (!priceUp &&  longHeavy) oiDiv = 'DIP BUY';
  else if ( priceUp &&  longHeavy) oiDiv = 'CONFIRM';
  else                             oiDiv = 'BEAR OI';

  let dipScore = 0;
  if (oiDiv === 'DIP BUY') dipScore += 2;
  if (oiDiv === 'CONFIRM') dipScore += 1;
  if (bias4h === 'BULL 4H' || bias4h === 'LEAN BULL') dipScore += 2;
  if (biasDay === 'LEAN BULL') dipScore += 1;
  const dipLabel = dipScore >= 5 ? 'BUY DIP' : dipScore >= 3 ? 'ACCUMULATE' : 'HOLD';

  return { bias4h, bias4hScore, biasDay, biasDayScore, sig, oiDiv, dipLabel, shock };
}

// ════════════════════════════════════════════════════
// CONDITION EVALUATORS
// ════════════════════════════════════════════════════
function evalOvnCond(condId, d) {
  const { bias4h, biasDay, sig, oiDiv, lp = 50 } = d;
  switch (condId) {
    case 'ovn_buy_4h':     return !!(bias4h  && (bias4h.includes('BULL 4H')   || bias4h.includes('LEAN BULL')));
    case 'ovn_buy_daily':  return !!(biasDay && (biasDay.includes('BULL')     || biasDay.includes('LEAN BULL') || biasDay === 'NEUTRAL'));
    case 'ovn_buy_signal': return sig === 'STRONG BUY' || sig === 'BULLISH';
    case 'ovn_buy_oi':     return !!(oiDiv   && (oiDiv.includes('OI DROP')    || oiDiv.includes('CONFIRM')));
    case 'ovn_sell_daily': return !!(biasDay && (biasDay.includes('LEAN BEAR')|| biasDay.includes('BEAR DAY')));
    // FIX Bug 3: Was (NEUTRAL || LEAN BEAR || BEAR 4H) — NEUTRAL is too loose.
    // Now requires an explicitly bearish 4H reading.
    case 'ovn_sell_4h':    return !!(bias4h  && (bias4h.includes('LEAN BEAR') || bias4h.includes('BEAR 4H')));
    // FIX Bug 3 (related): Was (BEARISH || STRONG SELL || WAIT) — WAIT is too common.
    // Now only passes on genuinely bearish signals.
    case 'ovn_sell_signal':return sig === 'BEARISH' || sig === 'STRONG SELL';
    case 'ovn_sell_oi':    return !!(oiDiv   && (oiDiv.includes('BEAR OI')    || oiDiv.includes('OI DROP')));
    case 'ovn_sell_ls':    return lp >= 65;
    default: return false;
  }
}

function evalSignalRule(ruleId, d) {
  const { bias4h, biasDay, sig, dipLabel, shock } = d;
  switch (ruleId) {
    case 'vol_bull_4h':  return parseFloat(shock) > 1.5 && !!(bias4h && (bias4h.includes('BULL') || bias4h.includes('LEAN BULL')));
    case 'strong_buy':   return sig === 'STRONG BUY';
    case 'strong_sell':  return sig === 'STRONG SELL' || sig === 'BEARISH';
    case 'bearish_day':  return !!(bias4h && bias4h.includes('BEAR') && biasDay && biasDay.includes('BEAR'));
    case 'dip_buy':      return !!(dipLabel && dipLabel.includes('BUY DIP'));
    default: return false;
  }
}

// ════════════════════════════════════════════════════
// TELEGRAM
// ════════════════════════════════════════════════════
async function sendTelegram(msg) {
  if (DRY_RUN)    { console.log('[DRY-RUN] Telegram:', msg); return; }
  if (!TG_ENABLED){ console.log('[TG DISABLED] Skipped:', msg.slice(0, 60)); return; }
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('⚠  Telegram not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TG_CHAT,
        text:       `🔔 *Alpha Terminal*\n\n${msg}\n\n_${new Date().toUTCString()}_`,
        parse_mode: 'Markdown',
      }),
    });
    const d = await r.json();
    if (d.ok) console.log('✈  Telegram sent:', msg.substring(0, 80));
    else       console.error('✈  Telegram FAILED:', d.description);
  } catch (e) { console.error('✈  Telegram error:', e.message); }
}

// ════════════════════════════════════════════════════
// COOLDOWN
// ════════════════════════════════════════════════════
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function isSuppressed(state, ruleId, sym) {
  if (state[`alert_state_${ruleId}_${sym}`] !== 'fired') return false;
  return (Date.now() - parseInt(state[`alert_ts_${ruleId}_${sym}`] || '0')) < COOLDOWN_HOURS * 3600000;
}
function markFired(state, ruleId, sym) {
  state[`alert_state_${ruleId}_${sym}`] = 'fired';
  state[`alert_ts_${ruleId}_${sym}`]    = String(Date.now());
}
// FIX Bug 4: Removed clearFired entirely for signal rules.
// The old logic deleted suppression state whenever a signal wasn't triggered,
// which allowed a ticker to re-fire within the cooldown window if the signal
// briefly dropped and came back. Suppression must only expire by time (isSuppressed),
// not be erased by a momentary non-trigger. clearFired is kept only for overnight
// rules (where it reflects a genuine condition change across distinct nightly windows).
function clearFired(state, ruleId, sym) {
  delete state[`alert_state_${ruleId}_${sym}`];
}

// ── Position-instance suppression (separate from the cooldown system above) ──
// Stop/T1/T2 are discrete one-time events for a *specific* open position, not
// a recurring signal — so unlike isSuppressed() there's no time-based expiry.
// Keying on alertedAt means a brand-new position opened later on the same
// symbol (after the old one closed) gets a clean slate automatically.
function posFireKey(sym, alertedAt, tag) {
  return `pos_fired_${sym}_${alertedAt}_${tag}`;
}
function isPosFired(state, key)   { return state[key] === true; }
function markPosFired(state, key) { state[key] = true; }

// ════════════════════════════════════════════════════
// POSITION MONITOR — headless exit scoring for GUI-synced positions.json
//
// Tier 3 (hard price): stop hit, T1, T2 — fires immediately, no lock
// Tier 2 (distribution): CVD + OI + funding + RSI exit score ≥ 3
// Tier 1 (overheating): funding hot + RSI extended, no CVD yet
//
// CVD is approximated server-side from Binance klines: count of recent
// 15-min candles where close < open (bearish pressure). Not identical to
// the GUI's real-time CVD stream but close enough for exit detection.
// ════════════════════════════════════════════════════

// Per-run in-memory CVD decline counter (mirrors GUI window._cvdDeclineCount)
const _cvdDeclineCount = {};

async function fetchCvdTrending(sym) {
  // Approximate CVD trend from last 6 × 15-min candles.
  // Returns 'down' if majority of recent candles are bearish (close < open).
  const bare = stripExchangePrefix(sym);
  try {
    if (isCrypto(bare)) {
      const k = await fetchBinance(`/api/v3/klines?symbol=${bare}&interval=15m&limit=6`);
      if (!Array.isArray(k) || k.length < 3) return 'up';
      const bearCount = k.filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;
      return bearCount >= 4 ? 'down' : 'up';
    }
  } catch (e) {
    console.log(`  ⚠  fetchCvdTrending failed for ${bare}: ${e.message}`);
  }
  return 'up'; // conservative default for stocks (no 15m data from Yahoo)
}

async function fetchFundingRate(sym) {
  const bare = stripExchangePrefix(sym);
  if (!isCrypto(bare)) return 0;
  try {
    // fapi.binance.com (futures) has no public-mirror equivalent — direct + proxy only.
    const d = await fetchBinance(`/fapi/v1/premiumIndex?symbol=${bare}`, { useMirror: false });
    return parseFloat(d.lastFundingRate || 0) * 100; // convert to % like GUI
  } catch (e) {
    console.log(`  ⚠  fetchFundingRate failed for ${bare}: ${e.message}`);
    return 0;
  }
}

async function fetchRsi15(sym) {
  const bare = stripExchangePrefix(sym);
  try {
    if (isCrypto(bare)) {
      const k = await fetchBinance(`/api/v3/klines?symbol=${bare}&interval=15m&limit=30`);
      if (!Array.isArray(k) || k.length < 15) return 50;
      const closes = k.map(c => parseFloat(c[4]));
      return calcRSI(closes, 14) || 50;
    }
  } catch (e) {
    console.log(`  ⚠  fetchRsi15 failed for ${bare}: ${e.message}`);
  }
  return 50;
}

async function checkPositions(state) {
  const positions = await loadPositions();
  const entries   = Object.entries(positions);

  if (!entries.length) {
    console.log('\n📍  positions.json — no open positions to monitor.');
    return;
  }

  console.log(`\n📍  Monitoring ${entries.length} GUI-tracked position(s) [headless]...`);

  const EXIT_CVD_CYCLES  = LB_CVD_CYCLES;   // override via LB_CVD_CYCLES repo Variable
  const HOLD_LOCK_MINS   = LB_HOLD_LOCK;  // override via LB_HOLD_LOCK repo Variable
  const TIER1_COOLDOWN   = 2 * 60 * 60 * 1000;
  const TIER2_COOLDOWN   = 2 * 60 * 60 * 1000;

  const STALE_HOURS = 48; // positions older than this with no close = warn once then skip

  for (const [sym, pos] of entries) {
    if (pos.status === 'stopped' || pos.status === 'tp2_hit') continue;

    const isBull    = pos.dir === 'bull' || pos.dir !== 'bear';
    if (!isBull) continue;

    const base      = pos.base || sym;
    const entry     = parseFloat(pos.entryPrice || 0);
    const stop      = parseFloat(pos.stop || 0);
    const t1        = parseFloat(pos.t1 || 0);
    const t2        = parseFloat(pos.t2 || 0);
    const alertedAt = pos.alertedAt || 0;
    const now       = Date.now();

    // ── Stale position guard ──────────────────────────────────────────────
    // If a position has been open longer than STALE_HOURS with no status
    // update, it was likely closed manually without using the GUI close button.
    // Fire a one-time warning then skip — prevents infinite hourly noise.
    const ageHours = alertedAt > 0 ? (now - alertedAt) / 3_600_000 : 0;
    if (ageHours > STALE_HOURS) {
      const staleKey = posFireKey(sym, alertedAt, 'stale_warn');
      if (!isPosFired(state, staleKey)) {
        markPosFired(state, staleKey);
        console.log(`  ⚠  ${sym} — stale (${Math.round(ageHours)}h open), sending one-time warning`);
        await sendTelegram(
          `⚠ *Stale Position* — ${base}\n` +
          `  Open for ${Math.round(ageHours)}h with no close recorded.\n` +
          `  If you already exited this trade, open the GUI and click Close\n` +
          `  to remove it from positions.json — otherwise monitoring continues.`
        );
      } else {
        console.log(`  ⏭  ${sym} — stale (${Math.round(ageHours)}h), warning already sent, skipping`);
      }
      continue;
    }

    let price = null;
    try { price = await fetchPositionPrice(sym); }
    catch (e) { console.log(`  ⚠  ${sym} price fetch failed: ${e.message}`); }

    if (price == null || !isFinite(price)) {
      console.log(`  ⚠  ${sym} — no price, skipping`);
      continue;
    }

    const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
    console.log(`  ${sym} [${pos.status}] price=${price} entry=${entry} stop=${stop} t1=${t1} t2=${t2} pnl=${pnlPct}%`);

    // ── TIER 3: Hard price exits — no hold lock, highest priority ──
    if (stop > 0 && price <= stop) {
      const key = posFireKey(sym, alertedAt, 'stop');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(`  🔴  STOP HIT — ${base} @ ${price}`);
        await sendTelegram(
          `🔴 *STOP HIT* — ${base}\n` +
          `  Entry $${entry}  Stop $${stop}  Current $${price}\n` +
          `  P&L ${pnlPct}%  Setup: ${pos.setup || '—'}\n` +
          `  _Headless — reopen GUI to update position status_`
        );
      }
      continue;
    }

    if (t1 > 0 && price >= t1 && pos.status === 'watching') {
      const key = posFireKey(sym, alertedAt, 't1');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(`  ✅  T1 HIT — ${base} @ ${price}`);
        await sendTelegram(
          `✅ *T1 HIT* — ${base}\n` +
          `  T1 $${t1}  Current $${price}  Entry $${entry}\n` +
          `  P&L +${pnlPct}%  → Trail stop, watch T2 $${t2}`
        );
      }
    }

    if (t2 > 0 && price >= t2 && (pos.status === 'watching' || pos.status === 'tp1_hit')) {
      const key = posFireKey(sym, alertedAt, 't2');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(`  🏆  T2 HIT — ${base} @ ${price}`);
        await sendTelegram(
          `🏆 *T2 HIT* — ${base}\n` +
          `  T2 $${t2}  Current $${price}  Entry $${entry}\n` +
          `  P&L +${pnlPct}%  → Full target reached`
        );
      }
    }

    // ── Hold lock: no Tier 1/2 in first N minutes after entry ──
    const holdLockUntil = (pos.holdLockUntil) || (alertedAt + HOLD_LOCK_MINS * 60000);
    if (now < holdLockUntil) {
      const remMins = Math.ceil((holdLockUntil - now) / 60000);
      console.log(`  ⏳  ${base} — hold lock ${remMins}min remaining, skip exit scoring`);
      continue;
    }

    // ── Fetch indicators for Tier 1/2 scoring ──
    const [cvdTrending, fr, r15] = await Promise.all([
      fetchCvdTrending(sym),
      fetchFundingRate(sym),
      fetchRsi15(sym),
    ]);

    // CVD decline counter (in-memory per run, resets each GitHub Actions run)
    if (cvdTrending === 'down') {
      _cvdDeclineCount[sym] = (_cvdDeclineCount[sym] || 0) + 1;
    } else {
      _cvdDeclineCount[sym] = 0;
    }
    const cvdDeclines  = _cvdDeclineCount[sym];
    const cvdConfirmed = cvdDeclines >= EXIT_CVD_CYCLES;

    const priceFlat    = Math.abs(((price - entry) / entry) * 100) < 0.5;
    const priceFalling = price < entry * 1.005;
    const fundingHot   = fr > 0.08;
    const rsiExtended  = r15 > 75;
    // OI divergence approximated: funding hot + price flat/falling = distribution signal
    const oiExiting    = fundingHot && (priceFlat || priceFalling);

    let exitScore = 0;
    if (cvdConfirmed) exitScore += 2;
    if (oiExiting)    exitScore += 2;
    if (fundingHot)   exitScore += 1;
    if (rsiExtended && cvdDeclines >= 1) exitScore += 1;

    console.log(`  📊  ${base} exit score=${exitScore}/6 cvd=${cvdTrending}(${cvdDeclines}) fr=${fr.toFixed(3)}% rsi15=${Math.round(r15)}`);

    // ── TIER 1: Overheating — tighten stop warning ──
    const tier1Key    = posFireKey(sym, alertedAt, 'tier1');
    const tier1FiredAt = state[`${tier1Key}_ts`] || 0;
    const tier1Cooldownok = (now - tier1FiredAt) > TIER1_COOLDOWN;

    if (fundingHot && rsiExtended && !cvdConfirmed
        && pos.status === 'watching'
        && tier1Cooldownok) {
      state[`${tier1Key}_ts`] = now;
      console.log(`  ⚠  TIER1 WATCH — ${base} FR=${fr.toFixed(3)}% RSI=${Math.round(r15)}`);
      await sendTelegram(
        `⚠ *WATCH — Overheating* — ${base}\n` +
        `  Funding ${fr.toFixed(3)}%  RSI 15m ${Math.round(r15)}\n` +
        `  CVD still up — no exit yet, tighten stop\n` +
        `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%\n` +
        `  _Headless monitor — CVD decline will trigger exit alert_`
      );
    }

    // ── TIER 2: Distribution confirmed — exit signal ──
    const tier2Key     = posFireKey(sym, alertedAt, 'tier2');
    const tier2FiredAt = state[`${tier2Key}_ts`] || 0;
    const tier2Cooldownok = (now - tier2FiredAt) > TIER2_COOLDOWN;

    if (cvdConfirmed && exitScore >= 3
        && pos.status !== 'exiting'
        && tier2Cooldownok) {
      state[`${tier2Key}_ts`] = now;
      const signals = [
        cvdConfirmed ? `CVD ↓ ${cvdDeclines} cycles` : null,
        oiExiting    ? 'OI distributing'              : null,
        fundingHot   ? `FR ${fr.toFixed(3)}%`         : null,
        rsiExtended  ? `RSI ${Math.round(r15)}`        : null,
      ].filter(Boolean).join(' · ');

      console.log(`  🟡  EXIT SIGNAL — ${base} score:${exitScore}/6 [${signals}]`);
      await sendTelegram(
        `🟡 *EXIT SIGNAL* — ${base}\n` +
        `  Exit score ${exitScore}/6\n` +
        `  ⚠ ${signals}\n` +
        `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%\n` +
        (t2 > price ? `  T2 $${t2} not yet hit — consider partial exit or trail stop` : `  → Consider full exit`) + `\n` +
        `  _Headless — CVD decline confirmed server-side_`
      );
    }
  }
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Alpha Terminal Alert Runner — ${new Date().toUTCString()}`);
  console.log(`Mode: ${MODE} | Cooldown: ${COOLDOWN_HOURS}h | Digest: ${DIGEST_MODE} | Dry-run: ${DRY_RUN}`);
  console.log('═'.repeat(60));

  const state = loadState();

  // ── 'positions' mode — fast path for the tight (5-10 min) schedule. ──
  // Only checks open GUI positions for stop/T1/T2 — one ticker call per
  // position, no full watchlist scan, no leaderboard scoring. Keeps the
  // frequent schedule cheap and avoids re-running expensive klines/depth/
  // funding pulls more often than the underlying 4h/daily signals change.
  if (MODE === 'positions') {
    const positionSyms = Object.keys(await loadPositions()).map(stripExchangePrefix);
    if (positionSyms.some(s => !isCrypto(s))) {
      console.log('\n📡  Initialising Yahoo Finance session (stock position present)...');
      await initYahoo();
    }
    await checkPositions(state);
    saveState(state);
    console.log('\n✅  Run complete (positions mode).\n');
    return;
  }

  console.log(`Pairs: ${WATCHLIST.join(', ')}`);

  // Init Yahoo Finance session if we have any non-crypto tickers — check both
  // the watchlist and any GUI-synced positions, since a position symbol may
  // not be in watchlist.json at all.
  const positionSyms = Object.keys(await loadPositions()).map(stripExchangePrefix);
  const hasStocks = WATCHLIST.some(s => !isCrypto(s)) || positionSyms.some(s => !isCrypto(s));
  if (hasStocks) {
    console.log('\n📡  Initialising Yahoo Finance session...');
    await initYahoo();
  }

  const digest = {};

  for (const sym of WATCHLIST) {
    const type = isCrypto(sym) ? 'crypto' : 'stock/ETF';
    console.log(`\n── ${sym} [${type}]`);

    const { ticker, k4h, kDay } = await fetchAll(sym);

    if (!ticker) { console.log('  ⚠  No ticker data — skipping'); continue; }

    const d = computeSignals(ticker, k4h, kDay);
    console.log(`  price=${ticker.price.toFixed(2)}  chg=${ticker.chgPct.toFixed(2)}%  bias4h=${d.bias4h}  biasDay=${d.biasDay}  sig=${d.sig}`);

    // FIX Bug 1 & 2: Determine whether overnight rules would fire for this ticker
    // BEFORE evaluating signal rules, so we can suppress signal alerts on the same
    // ticker+direction that overnight already covers (or vice versa).
    // Strategy: if a ticker qualifies for overnight (buy or sell), skip the
    // corresponding signal-group alert for that ticker entirely — the overnight
    // digest is the authoritative message for that run.
    const overnightBuyFires  = (() => {
      const rule = DEFAULT_RULES.find(r => r.id === 'overnight_buy');
      if (!rule || !rule.enabled) return false;
      const active = OVN_BUY_CONDITIONS.filter(c => c.enabled !== false);
      return active.every(c => evalOvnCond(c.id, d));
    })();
    const overnightSellFires = (() => {
      const rule = DEFAULT_RULES.find(r => r.id === 'overnight_sell');
      if (!rule || !rule.enabled) return false;
      const active = OVN_SELL_CONDITIONS.filter(c => c.enabled !== false);
      return active.every(c => evalOvnCond(c.id, d));
    })();

    for (const rule of DEFAULT_RULES) {
      if (!rule.enabled) continue;

      if (rule.group === 'signals') {
        const triggered = evalSignalRule(rule.id, d);

        // FIX Bug 4: Do NOT call clearFired when a signal rule is not triggered.
        // Suppression state expires naturally via the cooldown clock in isSuppressed.
        // Erasing it here would allow re-firing within the cooldown window.
        if (!triggered) { continue; }

        // FIX Bug 1 & 2: Skip individual signal alert if overnight already covers
        // this ticker in the same direction — avoids double-alerting.
        if (rule.action === 'buy'  && overnightBuyFires) {
          console.log(`  ⏭  [${rule.id}] skipped — overnight_buy covers this ticker`);
          continue;
        }
        if (rule.action === 'sell' && overnightSellFires) {
          console.log(`  ⏭  [${rule.id}] skipped — overnight_sell covers this ticker`);
          continue;
        }

        if (isSuppressed(state, rule.id, sym)) {
          console.log(`  🔕  [${rule.id}] suppressed (cooldown)`); continue;
        }
        const emoji = rule.action === 'buy' ? '🟢' : '🔴';
        const msg   = `${emoji} ${sym} [${rule.action.toUpperCase()}] — ${rule.id.replace(/_/g,' ').toUpperCase()}\n4H: ${d.bias4h} | Daily: ${d.biasDay} | Signal: ${d.sig}`;
        console.log(`  🔔  [${rule.id}] FIRE`);
        markFired(state, rule.id, sym);
        await sendTelegram(msg);
        continue;
      }

      const isBuy  = rule.id === 'overnight_buy';
      const conds  = isBuy ? OVN_BUY_CONDITIONS : OVN_SELL_CONDITIONS;
      const active = conds.filter(c => c.enabled !== false);
      const allPass = active.every(c => evalOvnCond(c.id, d));
      const hasMust = active.some(c => c.required);

      if (hasMust && allPass) {
        if (DIGEST_MODE) {
          if (isSuppressed(state, rule.id, sym)) {
            console.log(`  🔕  [${rule.id}] suppressed (digest cooldown)`); continue;
          }
          if (!digest[rule.id]) digest[rule.id] = { matches: [] };
          digest[rule.id].matches.push({ sym, ...d });
          markFired(state, rule.id, sym);
          console.log(`  📋  [${rule.id}] buffered for digest`);
        } else {
          if (isSuppressed(state, rule.id, sym)) {
            console.log(`  🔕  [${rule.id}] suppressed (cooldown)`); continue;
          }
          const icon  = isBuy ? '🌙🟢' : '🌙🔴';
          const dir   = isBuy ? 'BUY'  : 'SELL';
          const checklist = active.map(c => {
            const hit  = evalOvnCond(c.id, d);
            return `${hit ? '✅' : (c.required ? '❌' : '⬜')} ${c.label}: ${c.desc}`;
          }).join('\n');
          const msg = `${icon} OVERNIGHT ${dir} — ${sym}\n\n${checklist}\n\n✅ ${active.length}/${active.length} passed`;
          console.log(`  🔔  [${rule.id}] FIRE`);
          markFired(state, rule.id, sym);
          await sendTelegram(msg);
        }
      } else {
        // Overnight conditions genuinely not met — clear suppression so the rule
        // can fire fresh next time conditions align (safe here because overnight
        // is a discrete nightly check, unlike continuous signal polling).
        clearFired(state, rule.id, sym);
      }
    }
  }

  // ── Flush digest ──
  for (const [ruleId, { matches: rawMatches }] of Object.entries(digest)) {
    if (!rawMatches.length) continue;
    // Deduplicate by sym in case ticker appears twice in watchlist
    const seen = new Set();
    const matches = rawMatches.filter(m => { if (seen.has(m.sym)) return false; seen.add(m.sym); return true; });
    const isBuy  = ruleId === 'overnight_buy';
    const icon   = isBuy ? '🌙🟢' : '🌙🔴';
    const dir    = isBuy ? 'BUY'  : 'SELL';
    const header = `${icon} OVERNIGHT ${dir} — ${matches.length} asset${matches.length > 1 ? 's' : ''} matched`;
    const rows   = matches.map(m =>
      `✅ *${m.sym}*\n  4H: ${m.bias4h}\n  Daily: ${m.biasDay}\n  Signal: ${m.sig}`
    ).join('\n\n');
    console.log(`\n📋  Sending digest: ${header}`);
    await sendTelegram(`${header}\n\n${rows}`);
  }

  // ── Headless leaderboard buy scanner ──
  // v10.1: superseded by leaderboard-decider.js (Job B, runs every 15 min
  // against market-fetcher.js's data). Disabled here to avoid two
  // independent scanners with separate cooldown stores both deciding
  // whether to open the same position. Set LB_LEGACY_SCAN=true to restore
  // this hourly path if you ever stop running the new Job A/B pipeline.
  if ((process.env.LB_LEGACY_SCAN || 'false') === 'true') {
    await checkLeaderboardBuys(state);
  }

  // ── Monitor GUI-synced positions for stop/T1/T2 ──
  await checkPositions(state);

  saveState(state);
  console.log('\n✅  Run complete.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

// ══════════════════════════════════════════════════════════════════════════════
// HEADLESS LEADERBOARD BUY SCANNER
// Scores all crypto symbols in watchlist.json — runs as part of the hourly
// full-scan job (MODE=full) using Binance public APIs — no browser needed.
// Sends Telegram buy alerts when conv >= LB_MIN_SCORE.
// Mirrors the browser leaderboard scoring logic from render.js + signals.js.
// ══════════════════════════════════════════════════════════════════════════════

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcOBI(depth) {
  if (!depth) return 0;
  const bid = (depth.bids || []).slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
  const ask = (depth.asks || []).slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
  const tot = bid + ask;
  return tot > 0 ? ((bid - ask) / tot * 100) : 0;
}

function calcCvdTrend(k15m) {
  if (!k15m || k15m.length < 6) return 'up';
  const bearCount = k15m.slice(-6).filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;
  return bearCount >= 4 ? 'down' : 'up';
}

function calc4hBias(k4h) {
  if (!k4h || k4h.length < 10) return '—';
  const closes = k4h.map(c => parseFloat(c[4]));
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, Math.min(50, closes.length));
  const price  = closes.at(-1);
  const r4h    = calcRSI(closes);
  if (!ema20) return '—';
  if (price > ema20 && r4h > 55)   return 'BULL 4H';
  if (price < ema20 && r4h < 45)   return 'BEAR 4H';
  if (price > ema20)                return 'LEAN BULL';
  return 'LEAN BEAR';
}

function calcDayBias(kDay) {
  if (!kDay || kDay.length < 5) return '—';
  const closes = kDay.map(c => parseFloat(c[4]));
  const ema10  = calcEMA(closes, Math.min(10, closes.length));
  const price  = closes.at(-1);
  const r1d    = calcRSI(closes);
  if (!ema10) return '—';
  if (price > ema10 && r1d > 55)  return 'BULL DAY';
  if (price < ema10 && r1d < 45)  return 'BEAR DAY';
  if (price > ema10)              return 'LEAN BULL';
  return 'LEAN BEAR';
}

function calcConviction(d) {
  // Mirrors signals.js calcSpikeScore — same weights, same gates
  let s = 0;
  const { chg, shock, obi, cvd, r15, r4h, fr, oiDiv, bias4h, biasDay, emaTrend } = d;

  // Price momentum
  if (chg > 1.5) s += 2; else if (chg > 0.5) s += 1;
  else if (chg < -1.5) s -= 2; else if (chg < -0.5) s -= 1;

  // Vol shock
  if (shock >= 2.0) s += 2; else if (shock >= 1.5) s += 1;

  // Order book
  if (obi > 20) s += 2; else if (obi > 5) s += 1;
  else if (obi < -20) s -= 2; else if (obi < -5) s -= 1;

  // CVD
  if (cvd === 'up') s += 2; else s -= 1;

  // RSI
  if (r15 < 30 && r4h < 35) s += 1;  // oversold — bounce setup
  if (r15 > 72 && r4h > 68) s -= 1;  // overbought

  // EMA trend
  if (emaTrend === 'ABOVE') s += 1; else if (emaTrend === 'BELOW') s -= 1;

  // Funding
  if (fr <= -0.03) s += 2; else if (fr <= -0.01) s += 1;
  else if (fr >= 0.08) s -= 2; else if (fr >= 0.04) s -= 1;

  // OI divergence
  if (oiDiv === 'DIP_BUY')  s += 2;
  else if (oiDiv === 'CONF') s += 1;
  else if (oiDiv === 'DROP') s -= 1;

  // 4H bias
  if (bias4h === 'BULL 4H')   s += 2; else if (bias4h === 'LEAN BULL') s += 1;
  else if (bias4h === 'BEAR 4H') s -= 2; else if (bias4h === 'LEAN BEAR') s -= 1;

  // Daily bias
  if (biasDay === 'BULL DAY') s += 1; else if (biasDay === 'BEAR DAY') s -= 1;

  return Math.round(s);
}

function lbSetupLabel(d) {
  // Mirrors render.js getSetupMode
  if (d.oiDiv === 'DIP_BUY' && d.fr <= -0.01) return { label: 'CAP BUY',     emoji: '⭐' };
  if (d.shock >= 2.0 && d.cvd === 'up')        return { label: 'SQUEEZE NOW', emoji: '🚀' };
  if (d.emaTrend === 'ABOVE' && d.conv > 5)    return { label: 'BREAKOUT',    emoji: '⚡' };
  if (d.conv < -4)                              return { label: 'SHORT SETUP', emoji: '🔻' };
  return { label: 'WATCHING', emoji: '👁' };
}

function calcEntryLevels(price, shock) {
  // Mirrors render.js calcEntryLevels
  const p   = parseFloat(price) || 0;
  if (!p) return null;
  const atr = p * 0.015 * Math.max(1, shock * 0.5);
  const dp  = p < 0.01 ? 6 : p < 1 ? 4 : p < 100 ? 3 : 2;
  const entry = (p * 1.004).toFixed(dp);
  const stop  = (p - atr * 1.5).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

function lbBuyCooldownKey(sym) { return `lb_buy_${sym}`; }
function isLbOnCooldown(state, sym) {
  return (Date.now() - (state[lbBuyCooldownKey(sym)] || 0)) < LB_COOLDOWN_MIN * 60000;
}
function markLbCooldown(state, sym) { state[lbBuyCooldownKey(sym)] = Date.now(); }

async function scoreCryptoSymbol(pair) {
  try {
    const [ticker, k15r, k4r, kDr, depr, premr, oiCurr, oiPrevr] = await Promise.allSettled([
      fetchBinance(`/api/v3/ticker/24hr?symbol=${pair}`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=15m&limit=60`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=4h&limit=60`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1d&limit=14`),
      fetchBinance(`/api/v3/depth?symbol=${pair}&limit=20`),
      fetchBinance(`/fapi/v1/premiumIndex?symbol=${pair}`, { useMirror: false }),
      fetchBinance(`/fapi/v1/openInterest?symbol=${pair}`, { useMirror: false }),
      fetchBinance(`/fapi/v1/openInterest?symbol=${pair}`, { useMirror: false }), // placeholder for prev OI
    ]);

    const v = r => r.status === 'fulfilled' ? r.value : null;
    const t = v(ticker);
    if (!t || t.code) {
      const reason = ticker.status === 'rejected' ? ticker.reason?.message : (t?.msg || 'invalid response');
      console.log(`  ⚠  scoreCryptoSymbol: ticker fetch failed for ${pair}: ${reason}`);
      return null;
    }

    const k15  = v(k15r) || [];
    const k4   = v(k4r)  || [];
    const kD   = v(kDr)  || [];
    const dep  = v(depr);
    const prem = v(premr);
    const oiNow = v(oiCurr);

    const price = parseFloat(t.lastPrice);
    const chg   = parseFloat(t.priceChangePercent);

    // Vol shock: last 15m candle vol vs avg of previous 4
    const recentVols = k15.slice(-5).map(c => parseFloat(c[5]));
    const avgVol  = recentVols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock   = recentVols[4] ? recentVols[4] / avgVol : 1;

    const k15c = k15.map(c => parseFloat(c[4]));
    const k4c  = k4.map(c => parseFloat(c[4]));
    const kDc  = kD.map(c => parseFloat(c[4]));

    const r15      = calcRSI(k15c);
    const r4h      = calcRSI(k4c);
    const cvd      = calcCvdTrend(k15);
    const obi      = calcOBI(dep);
    const fr       = prem ? parseFloat(prem.lastFundingRate) * 100 : 0;
    const bias4h   = calc4hBias(k4);
    const biasDay  = calcDayBias(kD);
    const ema20    = calcEMA(k4c, Math.min(20, k4c.length));
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    // OI divergence
    let oiDiv = 'NEUTRAL';
    if (fr <= -0.01 && chg > 0)    oiDiv = 'DIP_BUY';
    else if (fr <= 0 && chg > 0.5)  oiDiv = 'CONF';
    else if (fr > 0.05 && chg < 0)  oiDiv = 'DROP';

    const d    = { chg, shock, obi, cvd, r15, r4h, fr, oiDiv, bias4h, biasDay, emaTrend };
    d.conv     = calcConviction(d);
    const setup = lbSetupLabel(d);
    const levels = calcEntryLevels(price, shock);

    return { pair, price, chg, conv: d.conv, setup, levels, d };
  } catch (e) {
    console.log(`  ⚠  ${pair} score error: ${e.message}`);
    return null;
  }
}

async function checkLeaderboardBuys(state) {
  // Filter crypto-only from watchlist
  const cryptoPairs = WATCHLIST
    .filter(s => isCrypto(stripExchangePrefix(s)))
    .map(stripExchangePrefix);

  if (!cryptoPairs.length) {
    console.log('\n📡  Leaderboard scanner — no crypto in watchlist, skipping');
    return;
  }

  console.log(`\n📡  Leaderboard scanner — scoring ${cryptoPairs.length} symbol(s) [min score: ${LB_MIN_SCORE}]...`);

  // Score all symbols concurrently
  const results = (await Promise.all(cryptoPairs.map(scoreCryptoSymbol))).filter(Boolean);

  // Filter: score >= min, not SHORT/WATCHING, not on cooldown
  const SKIP_SETUPS = new Set(['SHORT SETUP', 'WATCHING']);
  const alerts = [];

  for (const r of results.sort((a, b) => b.conv - a.conv)) {
    if (r.conv < LB_MIN_SCORE)              { console.log(`  ⏭  ${r.pair} score:${r.conv} below min:${LB_MIN_SCORE}`); continue; }
    if (SKIP_SETUPS.has(r.setup.label))     { console.log(`  ⏭  ${r.pair} setup:${r.setup.label} skipped`); continue; }
    if (isLbOnCooldown(state, r.pair))      { console.log(`  🔕  ${r.pair} [${r.setup.label}] score:${r.conv} — cooldown`); continue; }

    markLbCooldown(state, r.pair);
    alerts.push(r);
    console.log(`  🟢  ${r.pair} [${r.setup.label}] score:${r.conv} price:$${r.price}`);
  }

  if (!alerts.length) {
    console.log('  ✓  No new leaderboard buy signals this cycle');
    return;
  }

  // Build and send Telegram message
  const utc   = new Date().toUTCString().replace(/.*(\d{2}:\d{2}).*/, '$1') + ' UTC';
  const lines = alerts.map(a => {
    const l = a.levels;
    return [
      `${a.setup.emoji} *${a.pair.replace('USDT', '')}* — ${a.setup.label}  [${a.conv} pts]`,
      `  Price $${a.price}  Chg ${a.chg > 0 ? '+' : ''}${a.chg.toFixed(2)}%`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}`,
      `  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}  R:R ${l?.rr || '—'}`,
      `  4H: ${a.d.bias4h}  Day: ${a.d.biasDay}  CVD: ${a.d.cvd}  FR: ${a.d.fr.toFixed(3)}%`,
    ].join('\n');
  });

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    `_${alerts.length} signal(s) · headless scan · min score ${LB_MIN_SCORE}_`,
    '',
    lines.join('\n\n'),
    '',
    `_Open GUI for live leaderboard · Stop/T1/T2 monitored automatically_`,
  ].join('\n');

  await sendTelegram(msg);
}
