// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-scanner.js — v10.9
// Changes from v10.8:
//   - Imports resolveExchange / getMarketSession / toStooqSymbol from
//     exchange-registry.js — no more hardcoded suffix checks.
//   - scoreStock() now has a Stooq CSV fallback when Yahoo fails.
//     Provider order comes from exchange-registry providers.price array.
//   - exchangePrefix derived from registry (supports LSE, XETRA, TSE, HKEX, NSE).
//   - initYahoo() guard unchanged — called once per process.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveExchange, toStooqSymbol, buildSymKey } from './exchange-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';
const DRY_RUN         = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');
const STATE_PATH      = path.join(__dirname, '.lb-scan-state.json');
const WATCHLIST_PATH  = path.join(__dirname, '..', 'watchlist.json');

// ── Generic fetch with timeout ──
async function fetchJSON(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tid); }
}

async function fetchText(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(tid); }
}

// ── Binance fetch with mirror → direct → proxy fallback ──
const BINANCE_MIRROR = 'https://data-api.binance.vision';
const BINANCE_DIRECT = 'https://api.binance.com';
const PROXY_PREFIX   = 'https://corsproxy.io/?url=';

async function fetchBinance(urlPath, { useMirror = true } = {}) {
  const candidates = [];
  if (useMirror) candidates.push(`${BINANCE_MIRROR}${urlPath}`);
  candidates.push(`${BINANCE_DIRECT}${urlPath}`);
  let lastErr = null;
  for (const url of candidates) {
    try { return await fetchJSON(url); } catch (e) { lastErr = e; }
  }
  try {
    return await fetchJSON(`${PROXY_PREFIX}${encodeURIComponent(`${BINANCE_DIRECT}${urlPath}`)}`);
  } catch (e) { lastErr = e; }
  throw lastErr || new Error('all Binance endpoints failed');
}

// ── Yahoo Finance session ──
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let yahooCookie = '';
let yahooCrumb  = '';
let yahooInited = false;

export async function initYahoo() {
  if (yahooInited) return;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA }, redirect: 'follow',
    });
    const cookieMatch = (r1.headers.get('set-cookie') || '').match(/(A\d=[^;]+)/);
    yahooCookie = cookieMatch ? cookieMatch[1] : '';
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
    });
    yahooCrumb = await r2.text();
    if (!yahooCrumb || yahooCrumb.includes('<') || yahooCrumb.length >= 50) {
      console.log('  ⚠  Yahoo crumb unexpected — Stooq fallback will be used');
      yahooCrumb = '';
    } else {
      console.log(`  📡  Yahoo session ready (crumb ${yahooCrumb.length} chars)`);
    }
  } catch (e) {
    console.log('  ⚠  Yahoo init failed:', e.message);
  }
  yahooInited = true;
}

function yahooHeaders() {
  return { 'User-Agent': YAHOO_UA, Cookie: yahooCookie, Accept: 'application/json' };
}

// ── Stooq CSV fetch → returns bars[] same shape as Yahoo path ──
// Stooq CSV format: Date,Open,High,Low,Close,Volume
async function fetchStooqBars(sym) {
  const stooqSym = toStooqSymbol(sym);
  if (!stooqSym) throw new Error(`no Stooq symbol mapping for ${sym}`);

  // d = daily, 3-month window
  const url = `https://stooq.com/q/d/l/?s=${stooqSym}&i=d`;
  const csv = await fetchText(url, {}, 10000);

  const lines = csv.trim().split('\n').slice(1); // skip header
  if (!lines.length || lines[0].startsWith('No data')) {
    throw new Error(`Stooq returned no data for ${stooqSym}`);
  }

  const bars = [];
  for (const line of lines) {
    const [, o, h, l, c, v] = line.split(',');
    const close = parseFloat(c), open = parseFloat(o), vol = parseFloat(v) || 0;
    if (!isNaN(close) && !isNaN(open)) {
      bars.push({ c: close, o: open, h: parseFloat(h) || close, l: parseFloat(l) || close, v: vol });
    }
  }
  if (bars.length < 10) throw new Error(`Stooq: only ${bars.length} bars for ${stooqSym}`);
  return bars;
}

// ── Yahoo bars fetch ──
async function fetchYahooBars(sym) {
  const crumbSuffix = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  const d = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo${crumbSuffix}`,
    yahooHeaders()
  );
  const r  = d.chart.result[0];
  const qi = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < qi.close.length; i++) {
    if (qi.close[i] != null && qi.open[i] != null) {
      bars.push({
        c: qi.close[i],
        o: qi.open[i],
        h: qi.high?.[i] ?? qi.close[i],
        l: qi.low?.[i]  ?? qi.close[i],
        v: qi.volume?.[i] ?? 0,
      });
    }
  }
  if (bars.length < 10) throw new Error(`Yahoo: only ${bars.length} bars`);
  return bars;
}

// ── Fetch bars with provider fallback chain from registry ──
async function fetchStockBars(sym) {
  const ex        = resolveExchange(sym);
  const providers = ex?.providers?.price ?? ['yahoo', 'stooq'];
  let lastErr     = null;

  for (const provider of providers) {
    try {
      if (provider === 'yahoo') {
        const bars = await fetchYahooBars(sym);
        console.log(`  📥  ${sym} bars via Yahoo (${bars.length} days)`);
        return bars;
      }
      if (provider === 'stooq') {
        const bars = await fetchStooqBars(sym);
        console.log(`  📥  ${sym} bars via Stooq fallback (${bars.length} days)`);
        return bars;
      }
    } catch (e) {
      console.log(`  ⚠  ${sym} ${provider} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error(`all providers failed for ${sym}`);
}

// ── State ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function isOnCooldown(state, key) {
  const ts = state[key] || 0;
  return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
}
function markCooldown(state, key) { state[key] = Date.now(); }

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

// ════════════════════════════════════════════════════════
// SIGNAL MATH (unchanged from v10.8)
// ════════════════════════════════════════════════════════

function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; g += d > 0 ? d : 0; l += d < 0 ? -d : 0; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
    al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcCVD(k15m) {
  if (!k15m || k15m.length < 6) return 'up';
  const bearCount = k15m.slice(-6).filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;
  return bearCount >= 4 ? 'down' : 'up';
}

function calcOBI(depth) {
  if (!depth) return 0;
  const bidVol = (depth.bids || []).slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = (depth.asks || []).slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
  const total  = bidVol + askVol;
  return total > 0 ? ((bidVol - askVol) / total * 100) : 0;
}

function calc4hBias(k4h) {
  if (!k4h || k4h.length < 10) return '—';
  const closes = k4h.map(c => parseFloat(c[4]));
  const ema20  = calcEMA(closes, 20);
  const price  = closes[closes.length - 1];
  const r4h    = calcRSI(closes);
  if (!ema20) return '—';
  if (price > ema20 && r4h > 50) return 'BULL 4H';
  if (price < ema20 && r4h < 50) return 'BEAR 4H';
  return price > ema20 ? 'LEAN BULL' : 'LEAN BEAR';
}

function calcDailyBias(kDay) {
  if (!kDay || kDay.length < 5) return '—';
  const closes = kDay.map(c => parseFloat(c[4]));
  const ema10  = calcEMA(closes, Math.min(10, closes.length));
  const price  = closes[closes.length - 1];
  const r1d    = calcRSI(closes);
  if (!ema10) return '—';
  if (price > ema10 && r1d > 50) return 'BULL DAY';
  if (price < ema10 && r1d < 50) return 'BEAR DAY';
  return price > ema10 ? 'LEAN BULL' : 'LEAN BEAR';
}

export function getSetupMode(d) {
  const shock    = d.shock || 1;
  const frNum    = d.fr    || 0;
  const conv     = d.conv  || 0;
  const cvdUp    = d.cvdTrend === 'up';
  const emaAbove = d.emaTrend === 'ABOVE';
  if (d.oiDiv === 'DIP BUY' && frNum <= -0.01)  return { label: 'DIP BUY',     emoji: '💎' };
  if (shock >= 2.0 && cvdUp && conv > 6)         return { label: 'SQUEEZE NOW', emoji: '🚀' };
  if (emaAbove && conv > 5)                      return { label: 'BREAKOUT',    emoji: '⚡' };
  if (conv < -4)                                 return { label: 'SHORT SETUP', emoji: '🔻' };
  return { label: 'WATCHING', emoji: '⏳' };
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

export function calcConviction(d) {
  let score = 0;
  const chg     = d.chg      || 0;
  const shock   = d.shock    || 1;
  const obi     = d.obi      || 0;
  const cvdUp   = d.cvdTrend === 'up';
  const r15     = d.r15      || 50;
  const r4h     = d.r4h      || 50;
  const fr      = d.fr       || 0;
  const bias4h  = d.bias4h   || '—';
  const biasDay = d.biasDay  || '—';
  const ema     = d.emaTrend || '—';

  if (chg > 1.5) score += 2; else if (chg > 0.5) score += 1;
  else if (chg < -1.5) score -= 2; else if (chg < -0.5) score -= 1;
  if (shock > 1.6) score += 1;
  if (obi > 20) score += 2; else if (obi > 5) score += 1;
  else if (obi < -20) score -= 2; else if (obi < -5) score -= 1;
  if (cvdUp) score += 2; else score -= 1;
  if (r15 < 30 && r4h < 35) score += 1;
  if (r15 > 70 && r4h > 65) score -= 1;
  if (ema === 'ABOVE') score += 1; else if (ema === 'BELOW') score -= 1;
  if (fr <= -0.03) score += 2; else if (fr <= -0.01) score += 1;
  else if (fr >= 0.05) score -= 2; else if (fr >= 0.025) score -= 1;
  if (d.oiDiv === 'DIP BUY') score += 2;
  else if (d.oiDiv === 'CONFIRM') score += 1;
  else if (d.oiDiv === 'OI DROP') score -= 1;
  if (bias4h.includes('BULL 4H')) score += 2;
  else if (bias4h.includes('LEAN BULL')) score += 1;
  else if (bias4h.includes('BEAR 4H')) score -= 2;
  else if (bias4h.includes('LEAN BEAR')) score -= 1;
  if (biasDay.includes('BULL DAY')) score += 1;
  else if (biasDay.includes('BEAR DAY')) score -= 1;
  return Math.round(score);
}

export function calcWhaleScore(d) {
  const fr    = d.fr    || 0;
  const shock = d.shock || 1;
  const obi   = d.obi   || 0;
  const cvdUp = d.cvdTrend === 'up';
  const oiDiv = d.oiDiv || 'NEUTRAL';
  let raw = 50;
  if      (oiDiv === 'DIP BUY') raw += 25;
  else if (oiDiv === 'CONFIRM') raw += 18;
  else if (oiDiv === 'OI DROP') raw -= 15;
  if (cvdUp) raw += 20; else raw -= 20;
  if      (obi > 20)  raw += 15; else if (obi > 5)   raw += 8;
  else if (obi < -20) raw -= 15; else if (obi < -5)  raw -= 8;
  if      (fr <= -0.03) raw += 15; else if (fr <= -0.01) raw += 8;
  else if (fr >= 0.05)  raw -= 15; else if (fr >= 0.025) raw -= 8;
  if      (shock >= 2.5) raw += 15; else if (shock >= 1.8) raw += 10;
  else if (shock >= 1.3) raw += 5;  else if (shock < 0.7)  raw -= 8;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  let zone, emoji;
  if      (score >= 80) { zone = 'Aggressive Accum'; emoji = '🐋'; }
  else if (score >= 60) { zone = 'Smart Money Buy';  emoji = '💚'; }
  else if (score >= 40) { zone = 'Neutral';           emoji = '⚪'; }
  else if (score >= 20) { zone = 'Distribution';      emoji = '🟠'; }
  else                  { zone = 'Heavy Dist';         emoji = '🔴'; }
  return { score, zone, emoji };
}

export function calcCapBuy(d) {
  let capScore = 0;
  const r15  = d.r15 || 50, r1h = d.r1h || 50, fr = d.fr || 0;
  if (r15 < 15) capScore += 2; else if (r15 < 25) capScore += 1;
  if (r1h < 25) capScore += 2; else if (r1h < 35) capScore += 1;
  if (fr < -0.02) capScore += 2; else if (fr < -0.01) capScore += 1;
  if ((d.shock || 1) > 2.5 && d.cvdTrend !== 'up') capScore += 1;
  if (d.oiDiv === 'OI DROP') capScore += 1;
  if (d.cvdTrend === 'up')   capScore += 2;
  if ((d.chg || 0) < -7)    capScore += 1;
  return { isCapBuy: capScore >= 3 && (d.conv || 0) < -1, capScore };
}

export function calcFlow(d, whaleScore) {
  const fr    = d.fr    || 0;
  const shock = d.shock || 1;
  const oiDiv = d.oiDiv || 'NEUTRAL';
  const cvdUp = d.cvdTrend === 'up';
  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (earlyEntry && whaleScore >= 65) return 'Whales Buying';
  if (shock >= 2.0 && fr >= 0.03)     return 'Retail FOMO';
  if (whaleScore <= 35)               return 'Institutional↓';
  if (whaleScore >= 55 && earlyEntry) return 'Smart Accum';
  return 'Mixed Flow';
}

export function calcGrade(bullConf, whaleScore) {
  const stabilityProxy = Math.round(bullConf * 9 + 10);
  const gradeScore = bullConf * 10 + (whaleScore - 50) * 0.3 + (stabilityProxy - 50) * 0.2;
  let grade;
  if      (gradeScore >= 85) grade = 'A+';
  else if (gradeScore >= 70) grade = 'A';
  else if (gradeScore >= 50) grade = 'B';
  else if (gradeScore >= 30) grade = 'C';
  else                       grade = 'D';
  const successProb = Math.max(20, Math.min(92, Math.round(
    bullConf * 6 + (whaleScore - 50) * 0.25 + (stabilityProxy - 50) * 0.1 + 30
  )));
  return { grade, successProb, stabilityProxy };
}

export function calcSetupArchetype(d, whaleScore) {
  const shock = d.shock || 1, fr = d.fr || 0, chg = d.chg || 0;
  const cvdUp = d.cvdTrend === 'up', oiDiv = d.oiDiv || 'NEUTRAL';
  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (whaleScore >= 75 && earlyEntry)       return 'Whale Accumulation';
  if (shock >= 2.0 && d.emaTrend === 'ABOVE') return 'Momentum Breakout';
  if (d.obi > 0 && fr <= -0.01)             return 'Short Squeeze';
  if (chg < -1 && cvdUp && fr < 0)          return 'Mean Reversion';
  return 'Developing';
}

export function calcBullConf(d, whaleScore) {
  const r1h = d.r1h || 50;
  const checks = {
    dailyBiasBull:  (d.biasDay || '').includes('BULL'),
    bias4hBull:     (d.bias4h  || '').includes('BULL'),
    aboveEma:       d.emaTrend === 'ABOVE',
    oiRising:       d.oiDiv === 'CONFIRM' || d.oiDiv === 'DIP BUY',
    cvdRising:      d.cvdTrend === 'up',
    volExpansion:   (d.shock || 1) >= 1.3,
    fundingHealthy: (d.fr || 0) <= 0.01,
    obiBidHeavy:    (d.obi || 0) > 10,
    rsiNotOb:       (d.r15 || 50) < 70 && r1h < 68,
    whaleScore60:   (whaleScore ?? 0) >= 60,
  };
  return { count: Object.values(checks).filter(Boolean).length, checks };
}

// ════════════════════════════════════════════════════════
// CRYPTO SCORER  (Binance)
// ════════════════════════════════════════════════════════
export async function scoreSymbol(pair) {
  try {
    const [ticker, k15m, k1h, k4h, kDay, depth, prem] = await Promise.allSettled([
      fetchBinance(`/api/v3/ticker/24hr?symbol=${pair}`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=15m&limit=60`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1h&limit=30`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=4h&limit=50`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1d&limit=14`),
      fetchBinance(`/api/v3/depth?symbol=${pair}&limit=20`),
      fetchBinance(`/fapi/v1/premiumIndex?symbol=${pair}`, { useMirror: false }),
    ]);

    const val = r => r.status === 'fulfilled' ? r.value : null;
    const t = val(ticker);
    if (!t || t.code) {
      console.log(`  ⚠  ${pair} ticker failed: ${t?.msg || ticker.reason?.message}`);
      return null;
    }

    const k15 = val(k15m), k1 = val(k1h), k4 = val(k4h), kD = val(kDay);
    const dep = val(depth), pData = val(prem);

    const price = parseFloat(t.lastPrice);
    const chg   = parseFloat(t.priceChangePercent);
    const vols  = (k15 || []).slice(-5).map(c => parseFloat(c[5]));
    const avgVol = vols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock  = vols[4] ? vols[4] / avgVol : 1;

    const r15 = calcRSI((k15 || []).map(c => parseFloat(c[4])));
    const r1h = calcRSI((k1  || []).map(c => parseFloat(c[4])));
    const r4h = calcRSI((k4  || []).map(c => parseFloat(c[4])));

    const k4closes = (k4 || []).map(c => parseFloat(c[4]));
    const ema20    = calcEMA(k4closes, 20);
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    const bias4h   = calc4hBias(k4);
    const biasDay  = calcDailyBias(kD);
    const cvdTrend = calcCVD(k15);
    const obi      = calcOBI(dep);
    const fr       = pData ? parseFloat(pData.lastFundingRate) * 100 : 0;

    let oiDiv = 'NEUTRAL';
    if (fr <= -0.01 && chg > 0)    oiDiv = 'DIP BUY';
    else if (fr <= 0 && chg > 0.5)  oiDiv = 'CONFIRM';
    else if (fr > 0.05 && chg < 0)  oiDiv = 'OI DROP';

    const d = { p: price, chg, shock, r15, r1h, r4h, emaTrend, bias4h, biasDay, cvdTrend, obi, fr, oiDiv };
    d.conv = calcConviction(d);

    const setup     = getSetupMode(d);
    const whale     = calcWhaleScore(d);
    const capBuy    = calcCapBuy({ ...d, conv: d.conv });
    const bullConf  = calcBullConf(d, whale.score);
    const flow      = calcFlow(d, whale.score);
    const gradeInfo = calcGrade(bullConf.count, whale.score);
    const archetype = calcSetupArchetype(d, whale.score);
    const finalSetup = capBuy.isCapBuy ? { label: 'CAP BUY', emoji: '💥' } : setup;

    return {
      pair, price, chg, conv: d.conv, setup: finalSetup,
      assetType: 'crypto', exchangePrefix: 'BINANCE',
      d,
      whale: { score: whale.score, zone: whale.zone, emoji: whale.emoji },
      capBuy: { isCapBuy: capBuy.isCapBuy, capScore: capBuy.capScore },
      bullConf: bullConf.count, bullChecks: bullConf.checks,
      flow, grade: gradeInfo.grade, successProb: gradeInfo.successProb, archetype,
    };
  } catch (e) {
    console.log(`  ⚠  ${pair} crypto score failed: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════
// STOCK / ETF SCORER
// Uses provider fallback chain from exchange-registry.
// Works for TSX (.TO), LSE (.L), XETRA (.DE), TSE (.T),
// HKEX (.HK), NSE (.NS), and bare US symbols.
// ════════════════════════════════════════════════════════
export async function scoreStock(sym) {
  try {
    const ex             = resolveExchange(sym);
    const exchangePrefix = Object.entries((await import('./exchange-registry.js')).EXCHANGES)
      .find(([, v]) => v === ex)?.[0] ?? 'NYSE';

    // Fetch bars via provider chain (Yahoo → Stooq)
    let bars;
    try {
      bars = await fetchStockBars(sym);
    } catch (e) {
      console.log(`  ⚠  ${sym} all providers failed: ${e.message}`);
      return null;
    }

    const n       = bars.length;
    const closes  = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);
    const price   = closes[n - 1];
    const prev    = closes[n - 2] || price;
    const chg     = parseFloat(((price - prev) / prev * 100).toFixed(2));

    // Vol shock
    const recentVols = volumes.slice(-5);
    const avgVol4    = recentVols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock      = recentVols[4] ? recentVols[4] / avgVol4 : 1;

    // RSI proxies
    const r15 = calcRSI(closes.slice(-20), 14);
    const r1h = calcRSI(closes.slice(-30), 14);
    const r4h = calcRSI(closes, 14);

    // EMA trend
    const ema20    = calcEMA(closes, Math.min(20, n));
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    // 4H bias proxy (5-day daily window)
    let bias4hScore = 0;
    const recentUp4 = closes[n-1] > closes[Math.max(0, n-5)];
    const volUp4    = recentVols[4] > avgVol4;
    const k2 = 2 / 9;
    let ema8 = closes[Math.max(0, n - 9)];
    for (let i = Math.max(0, n - 8); i < n; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
    let cvd4hCount = 0;
    for (let i = n - 4; i < n; i++) cvd4hCount += bars[i].c >= bars[i].o ? 1 : -1;
    if (closes[n-1] > ema8)  bias4hScore += 2; else bias4hScore -= 2;
    if (recentUp4)            bias4hScore += 1; else bias4hScore -= 1;
    if (volUp4 && recentUp4)  bias4hScore += 1;
    if (cvd4hCount >= 2)      bias4hScore += 2; else if (cvd4hCount >= 1) bias4hScore += 1;
    else if (cvd4hCount <= -2) bias4hScore -= 2; else if (cvd4hCount <= -1) bias4hScore -= 1;
    if (r4h < 35) bias4hScore += 1; else if (r4h > 65) bias4hScore -= 1;

    let bias4h;
    if      (bias4hScore >= 4)  bias4h = 'BULL 4H';
    else if (bias4hScore >= 2)  bias4h = 'LEAN BULL';
    else if (bias4hScore <= -4) bias4h = 'BEAR 4H';
    else if (bias4hScore <= -2) bias4h = 'LEAN BEAR';
    else                        bias4h = 'NEUTRAL';

    // Daily bias
    let biasDayScore = 0;
    const k3 = 2 / 8;
    let ema7 = closes[Math.max(0, n - 8)];
    for (let i = Math.max(0, n - 7); i < n; i++) ema7 = closes[i] * k3 + ema7 * (1 - k3);
    const avgVolD    = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1) || 1;
    const volSurge   = volumes[n-1] > avgVolD * 1.4;
    const chg7d      = closes[n-7] > 0 ? parseFloat(((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1)) : 0;
    let cvdDailyCount = 0;
    for (let i = n - 7; i < n; i++) cvdDailyCount += bars[i].c >= bars[i].o ? 1 : -1;
    if (closes[n-1] > ema7)  biasDayScore += 2; else biasDayScore -= 2;
    if (chg7d > 5) biasDayScore += 2; else if (chg7d > 1) biasDayScore += 1;
    else if (chg7d < -5) biasDayScore -= 2; else if (chg7d < -1) biasDayScore -= 1;
    if (volSurge && chg7d > 0) biasDayScore += 1;
    if (volSurge && chg7d < 0) biasDayScore -= 1;
    if (cvdDailyCount >= 4) biasDayScore += 2; else if (cvdDailyCount >= 2) biasDayScore += 1;
    else if (cvdDailyCount <= -4) biasDayScore -= 2; else if (cvdDailyCount <= -2) biasDayScore -= 1;
    if (r4h < 35) biasDayScore += 1; else if (r4h > 65) biasDayScore -= 1;

    let biasDay;
    if      (biasDayScore >= 5)  biasDay = 'BULL DAY';
    else if (biasDayScore >= 2)  biasDay = 'LEAN BULL';
    else if (biasDayScore <= -5) biasDay = 'BEAR DAY';
    else if (biasDayScore <= -2) biasDay = 'LEAN BEAR';
    else                         biasDay = 'NEUTRAL';

    const cvdTrend  = cvd4hCount >= 0 ? 'up' : 'down';

    // OI divergence proxy
    const longHeavy = bias4hScore > 0;
    const priceUp   = chg >= 0;
    let oiDiv;
    if      ( priceUp && !longHeavy) oiDiv = 'DIP BUY';
    else if (!priceUp &&  longHeavy) oiDiv = 'DIP BUY';
    else if ( priceUp &&  longHeavy) oiDiv = 'CONFIRM';
    else                             oiDiv = 'OI DROP';

    const fr = 0, obi = 0; // not available for stocks

    const d = { p: price, chg, shock, r15, r1h, r4h, emaTrend, bias4h, biasDay, cvdTrend, obi, fr, oiDiv };
    d.conv = calcConviction(d);

    const setup     = getSetupMode(d);
    const whale     = calcWhaleScore(d);
    const bullConf  = calcBullConf(d, whale.score);
    const flow      = calcFlow(d, whale.score);
    const gradeInfo = calcGrade(bullConf.count, whale.score);
    const archetype = calcSetupArchetype(d, whale.score);

    return {
      pair: sym, price, chg, conv: d.conv, setup,
      assetType: 'stock', exchangePrefix,
      d,
      whale: { score: whale.score, zone: whale.zone, emoji: whale.emoji },
      capBuy: { isCapBuy: false, capScore: 0 },
      bullConf: bullConf.count, bullChecks: bullConf.checks,
      flow, grade: gradeInfo.grade, successProb: gradeInfo.successProb, archetype,
    };
  } catch (e) {
    console.log(`  ⚠  ${sym} stock score failed: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════
// STANDALONE LEADERBOARD SCANNER (called from alert-runner)
// ════════════════════════════════════════════════════════
export async function runLeaderboardScanner(state) {
  let watchlist = [];
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    watchlist = Array.isArray(raw) ? raw : raw.symbols || [];
  } catch { watchlist = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']; }

  const cryptoPairs = watchlist.filter(s => s.startsWith('BINANCE:')).map(s => s.replace('BINANCE:', ''));
  const stockSyms   = watchlist.filter(s => !s.startsWith('BINANCE:'));

  const total = cryptoPairs.length + stockSyms.length;
  if (!total) { console.log('\n📡  Leaderboard scanner — no symbols in watchlist'); return; }
  console.log(`\n📡  Leaderboard scanner — ${cryptoPairs.length} crypto + ${stockSyms.length} stock/ETF`);

  if (stockSyms.length) await initYahoo();

  const allResults = [
    ...(await Promise.all(cryptoPairs.map(scoreSymbol))),
    ...(await Promise.all(stockSyms.map(scoreStock))),
  ];

  const scored = allResults.filter(Boolean).filter(r => r.conv >= LB_MIN_SCORE);
  scored.sort((a, b) => b.conv - a.conv);

  const buyAlerts = [];
  for (const r of scored) {
    const { pair, price, conv, setup } = r;
    if (setup.label === 'WATCHING' || setup.label === 'SHORT SETUP') continue;
    if (isOnCooldown(state, pair)) { console.log(`  🔕  ${pair} [${setup.label}] — cooldown`); continue; }
    const levels = calcEntryLevels(price, r.d.shock);
    buyAlerts.push({ pair, conv, setup, price, levels, d: r.d, assetType: r.assetType });
    markCooldown(state, pair);
    console.log(`  🟢  ${pair} [${setup.label}] score:${conv} (${r.assetType})`);
  }

  if (!buyAlerts.length) { console.log('  ✓  No new buy signals'); return; }

  const utc   = new Date().toUTCString().slice(17, 22) + ' UTC';
  const lines = buyAlerts.map(a => {
    const l = a.levels;
    return [
      `${a.setup.emoji} *${a.pair.replace('USDT', '')}* — ${a.setup.label}  [${a.conv}/20]  (${a.assetType})`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}`,
      `  R:R ${l?.rr || '—'}  4H: ${a.d.bias4h}  CVD: ${a.d.cvdTrend}  FR: ${a.d.fr?.toFixed(3) || '0.000'}%`,
    ].join('\n');
  });

  await sendTelegram([
    `🔔 *Alpha Terminal — Leaderboard Scanner*`,
    `_${utc} · ${buyAlerts.length} signal(s) · min score ${LB_MIN_SCORE}_`,
    '', lines.join('\n\n'), '',
    `_Headless scan — open GUI to see live leaderboard_`,
  ].join('\n'));
}

export function isCrypto(sym) { return !sym.includes('.'); }
export { loadState, saveState };
