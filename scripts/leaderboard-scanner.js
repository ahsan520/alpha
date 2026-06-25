// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-scanner.js — headless leaderboard buy alert engine
// v10.5: added calcBullConf() — 10-check confirmation count stored in market-data.json
// Mirrors the browser leaderboard scoring using Binance public APIs directly.
// No browser needed — runs hourly via alert-runner.yml (full-scan job).
//
// Data sources (all public, no auth):
//   Binance /ticker/24hr     → price, chg, vol shock proxy
//   Binance /klines 15m      → CVD trend, RSI 15m
//   Binance /klines 4h       → 4H bias, RSI 4h
//   Binance /klines 1d       → daily bias, RSI 1d
//   Binance /depth           → OBI (order book imbalance)
//   Binance /premiumIndex    → funding rate
//   Binance /openInterest    → OI for divergence
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config from environment (mirrors alert-runner.js) ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';
const DRY_RUN         = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');
const STATE_PATH      = path.join(__dirname, '.lb-scan-state.json');
const WATCHLIST_PATH  = path.join(__dirname, '..', 'watchlist.json');

// ── Helpers ──
async function fetchJSON(url, timeout = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ── Resilient Binance fetch — same fallback chain as alert-runner.js ──
// api.binance.com 451s from US-hosted GitHub runners. Mirror first (spot
// data only), then direct, then a public CORS proxy as last resort.
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
  try {
    return await fetchJSON(`${PROXY_PREFIX}${encodeURIComponent(`${BINANCE_DIRECT}${urlPath}`)}`);
  } catch (e) {
    lastErr = e;
  }
  throw lastErr || new Error('all Binance endpoints failed');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function isOnCooldown(state, sym) {
  const ts = state[`lb_buy_${sym}`] || 0;
  return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
}
function markCooldown(state, sym) { state[`lb_buy_${sym}`] = Date.now(); }

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

// ── RSI ──
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

// ── EMA ──
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ── CVD trend from 15m klines ──
function calcCVD(k15m) {
  if (!k15m || k15m.length < 6) return 'up';
  // Each candle: [open, high, low, close, volume, ...]
  // CVD proxy: bearish candles (close < open) = selling pressure
  const recent = k15m.slice(-6);
  const bearCount = recent.filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;
  return bearCount >= 4 ? 'down' : 'up';
}

// ── OBI from order book ──
function calcOBI(depth) {
  if (!depth) return 0;
  const bidVol = (depth.bids || []).slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = (depth.asks || []).slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
  const total  = bidVol + askVol;
  return total > 0 ? ((bidVol - askVol) / total * 100) : 0;
}

// ── 4H bias from 4h klines ──
function calc4hBias(k4h) {
  if (!k4h || k4h.length < 10) return '—';
  const closes = k4h.map(c => parseFloat(c[4]));
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, Math.min(50, closes.length));
  const price  = closes[closes.length - 1];
  const r4h    = calcRSI(closes);
  if (!ema20) return '—';
  if (price > ema20 && r4h > 50) return 'BULL 4H';
  if (price < ema20 && r4h < 50) return 'BEAR 4H';
  if (price > ema20)              return 'LEAN BULL';
  return 'LEAN BEAR';
}

// ── Daily bias ──
function calcDailyBias(kDay) {
  if (!kDay || kDay.length < 5) return '—';
  const closes = kDay.map(c => parseFloat(c[4]));
  const ema10  = calcEMA(closes, Math.min(10, closes.length));
  const price  = closes[closes.length - 1];
  const r1d    = calcRSI(closes);
  if (!ema10) return '—';
  if (price > ema10 && r1d > 50) return 'BULL DAY';
  if (price < ema10 && r1d < 50) return 'BEAR DAY';
  if (price > ema10)              return 'LEAN BULL';
  return 'LEAN BEAR';
}

// ── Setup mode — mirrors render.js getSetupMode ──
function getSetupMode(d) {
  const shock  = d.shock || 1;
  const frNum  = d.fr    || 0;
  const conv   = d.conv  || 0;
  const cvdUp  = d.cvdTrend === 'up';
  const emaAbove = d.emaTrend === 'ABOVE';

  if (d.oiDiv === 'DIP BUY' && frNum <= -0.01)     return { label: 'DIP BUY',     emoji: '💎' };
  if (shock >= 2.0 && cvdUp && conv > 6)            return { label: 'SQUEEZE NOW', emoji: '🚀' };
  if (emaAbove && conv > 5)                         return { label: 'BREAKOUT',    emoji: '⚡' };
  if (conv < -4)                                    return { label: 'SHORT SETUP', emoji: '🔻' };
  return { label: 'WATCHING', emoji: '⏳' };
}

// ── Entry levels — mirrors render.js calcEntryLevels ──
function calcEntryLevels(price, shock) {
  const p   = parseFloat(price) || 0;
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

// ── Conviction score — mirrors signals.js calcSpikeScore core ──
function calcConviction(d) {
  let score = 0;
  const chg   = d.chg  || 0;
  const shock = d.shock || 1;
  const obi   = d.obi  || 0;
  const cvdUp = d.cvdTrend === 'up';
  const r15   = d.r15  || 50;
  const r4h   = d.r4h  || 50;
  const fr    = d.fr   || 0;
  const bias4h  = d.bias4h  || '—';
  const biasDay = d.biasDay || '—';
  const ema   = d.emaTrend || '—';

  // Price momentum
  if (chg > 1.5) score += 2; else if (chg > 0.5) score += 1;
  else if (chg < -1.5) score -= 2; else if (chg < -0.5) score -= 1;

  // Vol shock
  if (shock > 1.6) score += 1;

  // OBI (order book imbalance)
  if (obi > 20) score += 2; else if (obi > 5) score += 1;
  else if (obi < -20) score -= 2; else if (obi < -5) score -= 1;

  // CVD
  if (cvdUp) score += 2; else score -= 1;

  // RSI
  if (r15 < 30 && r4h < 35) score += 1;
  if (r15 > 70 && r4h > 65) score -= 1;

  // EMA trend
  if (ema === 'ABOVE') score += 1; else if (ema === 'BELOW') score -= 1;

  // Funding rate
  if (fr <= -0.03) score += 2; else if (fr <= -0.01) score += 1;
  else if (fr >= 0.05) score -= 2; else if (fr >= 0.025) score -= 1;

  // OI divergence
  if (d.oiDiv === 'DIP BUY')  score += 2;
  else if (d.oiDiv === 'CONFIRM') score += 1;
  else if (d.oiDiv === 'OI DROP') score -= 1;

  // 4H bias
  if (bias4h.includes('BULL 4H'))    score += 2;
  else if (bias4h.includes('LEAN BULL')) score += 1;
  else if (bias4h.includes('BEAR 4H'))   score -= 2;
  else if (bias4h.includes('LEAN BEAR')) score -= 1;

  // Daily bias
  if (biasDay.includes('BULL DAY'))   score += 1;
  else if (biasDay.includes('BEAR DAY')) score -= 1;

  return Math.round(score);
}

// ── Whale Score (0–100) — mirrors signals.js PDF FEATURE 1 ──
// Weights: OI 25% | CVD 20% | OBI 15% | Funding 15% | Vol 15% | (L/S skipped headlessly)
function calcWhaleScore(d) {
  const fr     = d.fr    || 0;
  const shock  = d.shock || 1;
  const obi    = d.obi   || 0;
  const cvdUp  = d.cvdTrend === 'up';
  const oiDiv  = d.oiDiv || 'NEUTRAL';

  let raw = 50;
  // OI (25 pts)
  if      (oiDiv === 'DIP BUY') raw += 25;
  else if (oiDiv === 'CONFIRM') raw += 18;
  else if (oiDiv === 'OI DROP') raw -= 15;
  // CVD (20 pts)
  if (cvdUp) raw += 20; else raw -= 20;
  // OBI (15 pts)
  if      (obi > 20)  raw += 15;
  else if (obi > 5)   raw += 8;
  else if (obi < -20) raw -= 15;
  else if (obi < -5)  raw -= 8;
  // Funding (15 pts)
  if      (fr <= -0.03) raw += 15;
  else if (fr <= -0.01) raw += 8;
  else if (fr >= 0.05)  raw -= 15;
  else if (fr >= 0.025) raw -= 8;
  // Vol shock (15 pts)
  if      (shock >= 2.5) raw += 15;
  else if (shock >= 1.8) raw += 10;
  else if (shock >= 1.3) raw += 5;
  else if (shock < 0.7)  raw -= 8;

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  let zone, emoji;
  if      (score >= 80) { zone = 'Aggressive Accum'; emoji = '🐋'; }
  else if (score >= 60) { zone = 'Smart Money Buy';  emoji = '💚'; }
  else if (score >= 40) { zone = 'Neutral';           emoji = '⚪'; }
  else if (score >= 20) { zone = 'Distribution';      emoji = '🟠'; }
  else                  { zone = 'Heavy Dist';         emoji = '🔴'; }
  return { score, zone, emoji };
}

// ── CAP BUY detector — mirrors render.js capitulation logic ──
// Fires on extreme oversold conditions: RSI crushed + funding negative +
// vol spike + CVD turning up. rawDir must be 'bear' (symbol falling).
// Returns { isCapBuy, capScore }.
function calcCapBuy(d) {
  const r15  = d.r15 || 50;
  const r1h  = d.r1h || 50;
  const fr   = d.fr  || 0;
  const shock = d.shock || 1;
  const chg  = d.chg || 0;

  let capScore = 0;
  if (r15 < 15)                              capScore += 2;
  else if (r15 < 25)                         capScore += 1;
  if (r1h < 25)                              capScore += 2;
  else if (r1h < 35)                         capScore += 1;
  if (fr < -0.02)                            capScore += 2;
  else if (fr < -0.01)                       capScore += 1;
  if (shock > 2.5 && d.cvdTrend !== 'up')   capScore += 1;
  if (d.oiDiv === 'OI DROP')                capScore += 1;
  if (d.cvdTrend === 'up')                  capScore += 2;
  if (chg < -7)                             capScore += 1;

  // CAP BUY requires rawDir=bear (negative conv) — same as GUI
  const rawIsBear = (d.conv || 0) < -1;
  const isCapBuy  = capScore >= 3 && rawIsBear;
  return { isCapBuy, capScore };
}

// ── Flow label — mirrors signals.js Smart Money logic ──
function calcFlow(d, whaleScore) {
  const fr    = d.fr    || 0;
  const shock = d.shock || 1;
  const oiDiv = d.oiDiv || 'NEUTRAL';
  const cvdUp = d.cvdTrend === 'up';

  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (earlyEntry && whaleScore >= 65)      return 'Whales Buying';
  if (shock >= 2.0 && fr >= 0.03)          return 'Retail FOMO';
  if (whaleScore <= 35)                    return 'Institutional↓';
  if (whaleScore >= 55 && earlyEntry)      return 'Smart Accum';
  return 'Mixed Flow';
}

// ── Trade grade + success probability — mirrors signals.js PDF FEATURE 6 ──
// signalStability is estimated from bullConf variance (no rolling history headlessly)
function calcGrade(bullConf, whaleScore) {
  // Headless stability proxy: use bullConf as surrogate (0–10 mapped to 10–100)
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

// ── Setup archetype — mirrors signals.js PDF FEATURE 6 ──
function calcSetupArchetype(d, whaleScore) {
  const shock = d.shock || 1;
  const fr    = d.fr    || 0;
  const chg   = d.chg   || 0;
  const cvdUp = d.cvdTrend === 'up';
  const oiDiv = d.oiDiv || 'NEUTRAL';

  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (whaleScore >= 75 && earlyEntry)                          return 'Whale Accumulation';
  if (shock >= 2.0 && d.emaTrend === 'ABOVE')                 return 'Momentum Breakout';
  if (d.obi > 0 && fr <= -0.01)                               return 'Short Squeeze';
  if (chg < -1 && cvdUp && fr < 0)                           return 'Mean Reversion';
  return 'Developing';
}

// ── Bull confirmation count — mirrors GUI leaderboard 10-check panel ──
// Now includes Whale Score ≥60 as check 10 (replaces proxy).
function calcBullConf(d, whaleScore) {
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
    whaleScore60:   (whaleScore ?? 0) >= 60,  // exact match to GUI check 10
  };
  const count = Object.values(checks).filter(Boolean).length;
  return { count, checks };
}

// ── Score one symbol ──
async function scoreSymbol(pair) {
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

    const t     = val(ticker);
    const k15   = val(k15m);
    const k1    = val(k1h);
    const k4    = val(k4h);
    const kD    = val(kDay);
    const dep   = val(depth);
    const pData = val(prem);

    if (!t || t.code) {
      const reason = ticker.status === 'rejected' ? ticker.reason?.message : (t?.msg || 'invalid response');
      console.log(`  ⚠  ${pair} ticker fetch failed: ${reason}`);
      return null;
    }

    const price  = parseFloat(t.lastPrice);
    const chg    = parseFloat(t.priceChangePercent);
    // Vol shock: current 15m vol vs average of last hour
    const vols   = (k15 || []).slice(-5).map(c => parseFloat(c[5]));
    const avgVol = vols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock  = vols[4] ? vols[4] / avgVol : 1;

    const k15closes = (k15 || []).map(c => parseFloat(c[4]));
    const k1closes  = (k1  || []).map(c => parseFloat(c[4]));
    const k4closes  = (k4  || []).map(c => parseFloat(c[4]));
    const kDcloses  = (kD  || []).map(c => parseFloat(c[4]));

    const r15 = calcRSI(k15closes);
    const r1h = calcRSI(k1closes);
    const r4h = calcRSI(k4closes);

    const ema20   = calcEMA(k4closes, 20);
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    const bias4h  = calc4hBias(k4);
    const biasDay = calcDailyBias(kD);
    const cvdTrend = calcCVD(k15);
    const obi     = calcOBI(dep);
    const fr      = pData ? parseFloat(pData.lastFundingRate) * 100 : 0;

    // OI divergence (simplified): funding negative + price rising = DIP BUY squeeze
    let oiDiv = 'NEUTRAL';
    if (fr <= -0.01 && chg > 0)   oiDiv = 'DIP BUY';
    else if (fr <= 0 && chg > 0.5) oiDiv = 'CONFIRM';
    else if (fr > 0.05 && chg < 0) oiDiv = 'OI DROP';

    const d = { p: price, chg, shock, r15, r1h, r4h, emaTrend, bias4h, biasDay,
                cvdTrend, obi, fr, oiDiv };

    d.conv = calcConviction(d);
    const setup     = getSetupMode(d);
    const whale     = calcWhaleScore(d);
    const capBuy    = calcCapBuy({ ...d, conv: d.conv });
    const bullConf  = calcBullConf(d, whale.score);
    const flow      = calcFlow(d, whale.score);
    const gradeInfo = calcGrade(bullConf.count, whale.score);
    const archetype = calcSetupArchetype(d, whale.score);

    // Override setup to CAP BUY if capitulation detected
    const finalSetup = capBuy.isCapBuy
      ? { label: 'CAP BUY', emoji: '💥' }
      : setup;

    return {
      pair, price, chg, conv: d.conv,
      setup: finalSetup,
      d,
      // ── enriched fields stored in market-data.json ──
      whale:     { score: whale.score, zone: whale.zone, emoji: whale.emoji },
      capBuy:    { isCapBuy: capBuy.isCapBuy, capScore: capBuy.capScore },
      bullConf:  bullConf.count,
      bullChecks: bullConf.checks,
      flow,
      grade:     gradeInfo.grade,
      successProb: gradeInfo.successProb,
      archetype,
    };
  } catch (e) {
    console.log(`  ⚠  ${pair} score failed: ${e.message}`);
    return null;
  }
}

// ── Main scanner ──
export async function runLeaderboardScanner(state) {
  // Load watchlist — crypto only (stocks need different APIs)
  let watchlist = [];
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    watchlist = (Array.isArray(raw) ? raw : raw.symbols || [])
      .filter(s => s.startsWith('BINANCE:'))
      .map(s => s.replace('BINANCE:', ''));
  } catch { watchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']; }

  if (!watchlist.length) { console.log('\n📡  Leaderboard scanner — no crypto symbols in watchlist'); return; }

  console.log(`\n📡  Leaderboard scanner — scoring ${watchlist.length} symbol(s)...`);

  const results = await Promise.all(watchlist.map(scoreSymbol));
  const scored  = results.filter(Boolean).filter(r => r.conv >= LB_MIN_SCORE);

  // Sort by conviction desc
  scored.sort((a, b) => b.conv - a.conv);

  const buyAlerts = [];
  for (const r of scored) {
    const { pair, price, conv, setup } = r;
    if (setup.label === 'WATCHING' || setup.label === 'SHORT SETUP') continue;
    if (isOnCooldown(state, pair)) {
      console.log(`  🔕  ${pair} [${setup.label}] score:${conv} — cooldown`);
      continue;
    }

    const levels = calcEntryLevels(price, r.d.shock);
    buyAlerts.push({ pair, conv, setup, price, levels, d: r.d });
    markCooldown(state, pair);
    console.log(`  🟢  ${pair} [${setup.label}] score:${conv} price:${price}`);
  }

  if (!buyAlerts.length) {
    console.log('  ✓  No new buy signals this cycle');
    return;
  }

  // Send one batched Telegram message
  const utc  = new Date().toUTCString().slice(17, 22) + ' UTC';
  const lines = buyAlerts.map(a => {
    const l = a.levels;
    return [
      `${a.setup.emoji} *${a.pair.replace('USDT','')}* — ${a.setup.label}  [${a.conv}/20]`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}`,
      `  R:R ${l?.rr || '—'}  4H: ${a.d.bias4h}  CVD: ${a.d.cvdTrend}  FR: ${a.d.fr.toFixed(3)}%`,
    ].join('\n');
  });

  const msg = [
    `🔔 *Alpha Terminal — Leaderboard Scanner*`,
    `_${utc} · ${buyAlerts.length} signal(s) · min score ${LB_MIN_SCORE}_`,
    '',
    lines.join('\n\n'),
    '',
    `_Headless scan — open GUI to see live leaderboard_`,
  ].join('\n');

  await sendTelegram(msg);
}

// ── Run standalone (called from alert-runner.js) ──
export { scoreSymbol, loadState, saveState, calcConviction, getSetupMode, calcBullConf, calcWhaleScore, calcCapBuy, calcFlow, calcGrade, calcSetupArchetype };
