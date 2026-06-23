// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-scanner.js — headless leaderboard buy alert engine
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

// ── Score one symbol ──
async function scoreSymbol(pair) {
  try {
    const [ticker, k15m, k4h, kDay, depth, prem] = await Promise.allSettled([
      fetchBinance(`/api/v3/ticker/24hr?symbol=${pair}`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=15m&limit=60`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=4h&limit=50`),
      fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1d&limit=14`),
      fetchBinance(`/api/v3/depth?symbol=${pair}&limit=20`),
      fetchBinance(`/fapi/v1/premiumIndex?symbol=${pair}`, { useMirror: false }),
    ]);

    const val = r => r.status === 'fulfilled' ? r.value : null;

    const t     = val(ticker);
    const k15   = val(k15m);
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
    const k4closes  = (k4  || []).map(c => parseFloat(c[4]));
    const kDcloses  = (kD  || []).map(c => parseFloat(c[4]));

    const r15 = calcRSI(k15closes);
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

    const d = { p: price, chg, shock, r15, r4h, emaTrend, bias4h, biasDay,
                cvdTrend, obi, fr, oiDiv };

    d.conv = calcConviction(d);
    const setup = getSetupMode(d);

    return { pair, price, chg, conv: d.conv, setup, d };
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
export { scoreSymbol, loadState, saveState, calcConviction, getSetupMode };
