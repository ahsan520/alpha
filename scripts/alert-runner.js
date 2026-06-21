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

// ── Config from environment ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN  || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID    || '';
const COOLDOWN_HOURS  = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '4');
const DIGEST_MODE     = (process.env.DIGEST_MODE || 'true') === 'true';

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
    const d = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
    return { price: parseFloat(d.lastPrice), chgPct: parseFloat(d.priceChangePercent) };
  } catch { return null; }
}

async function fetchCrypto4h(pair) {
  try {
    const k = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=50`);
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
  } catch { return null; }
}

async function fetchCryptoDaily(pair) {
  try {
    const k = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=14`);
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
  } catch { return null; }
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
    const [ticker, k4h, kDay] = await Promise.all([
      fetchCryptoTicker(sym),
      fetchCrypto4h(sym),
      fetchCryptoDaily(sym),
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
  if (DRY_RUN) { console.log('[DRY-RUN] Telegram:', msg); return; }
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
      const k = await fetchJSON(
        \`https://api.binance.com/api/v3/klines?symbol=\${bare}&interval=15m&limit=6\`
      );
      if (!Array.isArray(k) || k.length < 3) return 'up';
      const bearCount = k.filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;
      return bearCount >= 4 ? 'down' : 'up';
    }
  } catch {}
  return 'up'; // conservative default for stocks (no 15m data from Yahoo)
}

async function fetchFundingRate(sym) {
  const bare = stripExchangePrefix(sym);
  if (!isCrypto(bare)) return 0;
  try {
    const d = await fetchJSON(
      \`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=\${bare}\`
    );
    return parseFloat(d.lastFundingRate || 0) * 100; // convert to % like GUI
  } catch { return 0; }
}

async function fetchRsi15(sym) {
  const bare = stripExchangePrefix(sym);
  try {
    if (isCrypto(bare)) {
      const k = await fetchJSON(
        \`https://api.binance.com/api/v3/klines?symbol=\${bare}&interval=15m&limit=30\`
      );
      if (!Array.isArray(k) || k.length < 15) return 50;
      const closes = k.map(c => parseFloat(c[4]));
      return calcRSI(closes, 14) || 50;
    }
  } catch {}
  return 50;
}

async function checkPositions(state) {
  const positions = await loadPositions();
  const entries   = Object.entries(positions);

  if (!entries.length) {
    console.log('\n📍  positions.json — no open positions to monitor.');
    return;
  }

  console.log(\`\n📍  Monitoring \${entries.length} GUI-tracked position(s) [headless]...\`);

  const EXIT_CVD_CYCLES  = 3;   // mirrors GUI default exitCvdCycles
  const HOLD_LOCK_MINS   = 20;  // mirrors GUI default holdLockMins
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
    catch (e) { console.log(\`  ⚠  \${sym} price fetch failed: \${e.message}\`); }

    if (price == null || !isFinite(price)) {
      console.log(\`  ⚠  \${sym} — no price, skipping\`);
      continue;
    }

    const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
    console.log(\`  \${sym} [\${pos.status}] price=\${price} entry=\${entry} stop=\${stop} t1=\${t1} t2=\${t2} pnl=\${pnlPct}%\`);

    // ── TIER 3: Hard price exits — no hold lock, highest priority ──
    if (stop > 0 && price <= stop) {
      const key = posFireKey(sym, alertedAt, 'stop');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(\`  🔴  STOP HIT — \${base} @ \${price}\`);
        await sendTelegram(
          \`🔴 *STOP HIT* — \${base}\n\` +
          \`  Entry $\${entry}  Stop $\${stop}  Current $\${price}\n\` +
          \`  P&L \${pnlPct}%  Setup: \${pos.setup || '—'}\n\` +
          \`  _Headless — reopen GUI to update position status_\`
        );
      }
      continue;
    }

    if (t1 > 0 && price >= t1 && pos.status === 'watching') {
      const key = posFireKey(sym, alertedAt, 't1');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(\`  ✅  T1 HIT — \${base} @ \${price}\`);
        await sendTelegram(
          \`✅ *T1 HIT* — \${base}\n\` +
          \`  T1 $\${t1}  Current $\${price}  Entry $\${entry}\n\` +
          \`  P&L +\${pnlPct}%  → Trail stop, watch T2 $\${t2}\`
        );
      }
    }

    if (t2 > 0 && price >= t2 && (pos.status === 'watching' || pos.status === 'tp1_hit')) {
      const key = posFireKey(sym, alertedAt, 't2');
      if (!isPosFired(state, key)) {
        markPosFired(state, key);
        console.log(\`  🏆  T2 HIT — \${base} @ \${price}\`);
        await sendTelegram(
          \`🏆 *T2 HIT* — \${base}\n\` +
          \`  T2 $\${t2}  Current $\${price}  Entry $\${entry}\n\` +
          \`  P&L +\${pnlPct}%  → Full target reached\`
        );
      }
    }

    // ── Hold lock: no Tier 1/2 in first N minutes after entry ──
    const holdLockUntil = (pos.holdLockUntil) || (alertedAt + HOLD_LOCK_MINS * 60000);
    if (now < holdLockUntil) {
      const remMins = Math.ceil((holdLockUntil - now) / 60000);
      console.log(\`  ⏳  \${base} — hold lock \${remMins}min remaining, skip exit scoring\`);
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

    console.log(\`  📊  \${base} exit score=\${exitScore}/6 cvd=\${cvdTrending}(\${cvdDeclines}) fr=\${fr.toFixed(3)}% rsi15=\${Math.round(r15)}\`);

    // ── TIER 1: Overheating — tighten stop warning ──
    const tier1Key    = posFireKey(sym, alertedAt, 'tier1');
    const tier1FiredAt = state[\`\${tier1Key}_ts\`] || 0;
    const tier1Cooldownok = (now - tier1FiredAt) > TIER1_COOLDOWN;

    if (fundingHot && rsiExtended && !cvdConfirmed
        && pos.status === 'watching'
        && tier1Cooldownok) {
      state[\`\${tier1Key}_ts\`] = now;
      console.log(\`  ⚠  TIER1 WATCH — \${base} FR=\${fr.toFixed(3)}% RSI=\${Math.round(r15)}\`);
      await sendTelegram(
        \`⚠ *WATCH — Overheating* — \${base}\n\` +
        \`  Funding \${fr.toFixed(3)}%  RSI 15m \${Math.round(r15)}\n\` +
        \`  CVD still up — no exit yet, tighten stop\n\` +
        \`  Current $\${price}  Entry $\${entry}  P&L \${pnlPct}%\n\` +
        \`  _Headless monitor — CVD decline will trigger exit alert_\`
      );
    }

    // ── TIER 2: Distribution confirmed — exit signal ──
    const tier2Key     = posFireKey(sym, alertedAt, 'tier2');
    const tier2FiredAt = state[\`\${tier2Key}_ts\`] || 0;
    const tier2Cooldownok = (now - tier2FiredAt) > TIER2_COOLDOWN;

    if (cvdConfirmed && exitScore >= 3
        && pos.status !== 'exiting'
        && tier2Cooldownok) {
      state[\`\${tier2Key}_ts\`] = now;
      const signals = [
        cvdConfirmed ? \`CVD ↓ \${cvdDeclines} cycles\` : null,
        oiExiting    ? 'OI distributing'              : null,
        fundingHot   ? \`FR \${fr.toFixed(3)}%\`         : null,
        rsiExtended  ? \`RSI \${Math.round(r15)}\`        : null,
      ].filter(Boolean).join(' · ');

      console.log(\`  🟡  EXIT SIGNAL — \${base} score:\${exitScore}/6 [\${signals}]\`);
      await sendTelegram(
        \`🟡 *EXIT SIGNAL* — \${base}\n\` +
        \`  Exit score \${exitScore}/6\n\` +
        \`  ⚠ \${signals}\n\` +
        \`  Current $\${price}  Entry $\${entry}  P&L \${pnlPct}%\n\` +
        (t2 > price ? \`  T2 $\${t2} not yet hit — consider partial exit or trail stop\` : \`  → Consider full exit\`) + \`\n\` +
        \`  _Headless — CVD decline confirmed server-side_\`
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
  console.log(`Pairs: ${WATCHLIST.join(', ')}`);
  console.log(`Cooldown: ${COOLDOWN_HOURS}h | Digest: ${DIGEST_MODE} | Dry-run: ${DRY_RUN}`);
  console.log('═'.repeat(60));

  // Init Yahoo Finance session if we have any non-crypto tickers — check both
  // the watchlist and any GUI-synced positions, since a position symbol may
  // not be in watchlist.json at all.
  const positionSyms = Object.keys(await loadPositions()).map(stripExchangePrefix);
  const hasStocks = WATCHLIST.some(s => !isCrypto(s)) || positionSyms.some(s => !isCrypto(s));
  if (hasStocks) {
    console.log('\n📡  Initialising Yahoo Finance session...');
    await initYahoo();
  }

  const state  = loadState();
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

  // ── Monitor GUI-synced positions for stop/T1/T2 ──
  await checkPositions(state);

  saveState(state);
  console.log('\n✅  Run complete.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
