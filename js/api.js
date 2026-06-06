// ══════════════════════════════════════════════
// api.js — all fetch, proxy, and data functions
// ══════════════════════════════════════════════

const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
];

async function fetchProxy(url) {
  for (const fn of PROXIES) {
    try {
      const r = await fetch(fn(url), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const txt = await r.text();
      try { const o = JSON.parse(txt); return o && o.contents !== undefined ? JSON.parse(o.contents) : o; }
      catch { return JSON.parse(txt); }
    } catch {}
  }
  throw new Error('All proxies failed');
}

async function fetchDirect(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchBinance(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) { const d = await r.json(); if (d && !d.code) return d; }
  } catch {}
  return fetchProxy(url);
}

// ── CoinGecko ID lookup ──
async function cgId(pair) {
  const { cgCache } = STATE;
  if (CG[pair]) return CG[pair];
  if (cgCache[pair]) return cgCache[pair];
  const base = pair.replace(/USDT|BUSD|USDC$/i, '').toLowerCase();
  try {
    const d = await fetchDirect(`https://api.coingecko.com/api/v3/search?query=${base}`);
    if (d.coins && d.coins[0]) {
      cgCache[pair] = d.coins[0].id;
      localStorage.setItem('a49_cgc', JSON.stringify(cgCache));
      return d.coins[0].id;
    }
  } catch {}
  return base;
}

// ── Batch crypto prices — Binance first for real-time true 24h%, CoinGecko fallback ──
// CoinGecko usd_24h_change can be stale by hours; Binance priceChangePercent is a
// rolling 24h value updated every few seconds and is the authoritative source.
async function batchCrypto(syms) {
  if (!syms.length) return {};
  const pairs = syms.map(s => s.split(':')[1]);
  const res = {};

  // Attempt Binance batch ticker — single request covers all symbols
  // Skip pairs known to be delisted from Binance (e.g. XMRUSDT removed Feb 2024)
  const binancePairs = pairs.filter(p => !BINANCE_DELISTED.has(p));
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr`;
    let data = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) data = await r.json();
    } catch {}
    if (!data) data = await fetchProxy(url);
    if (Array.isArray(data)) {
      const byPair = Object.fromEntries(data.map(t => [t.symbol, t]));
      for (const pair of binancePairs) {
        const t = byPair[pair];
        if (t) res['BINANCE:' + pair] = {
          p: parseFloat(t.lastPrice),
          chg: parseFloat(t.priceChangePercent), // real-time rolling 24h from Binance
        };
      }
      if (pairs.every(p => res['BINANCE:' + p])) return res;
    }
  } catch {}

  // Fallback: CoinGecko for any pairs Binance didn't cover (price + stale 24h%)
  const missing = pairs.filter(p => !res['BINANCE:' + p]);
  if (missing.length) {
    try {
      const idMap = {};
      await Promise.all(missing.map(async p => { idMap[await cgId(p)] = p; }));
      const ids = Object.keys(idMap).join(',');
      const d = await fetchDirect(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      for (const [id, pair] of Object.entries(idMap)) {
        if (d[id]) res['BINANCE:' + pair] = { p: d[id].usd, chg: d[id].usd_24h_change || 0 };
      }
    } catch {}
  }
  return res;
}

// ── Binance fallback for single pair ──
async function binanceFallback(sym) {
  const pair = sym.split(':')[1];
  const d = await fetchProxy(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
  if (d.lastPrice) return { p: parseFloat(d.lastPrice), chg: parseFloat(d.priceChangePercent) };
  throw new Error('no data');
}

// ── Stock price via Yahoo Finance ──
// Source priority for 24h%:
//   1. v7 quote → regularMarketChangePercent  (official exchange day-change, best)
//   2. v8 chart range=2d → (regularMarketPrice - previousClose) / previousClose
//      range=2d guarantees bar[0]=yesterday bar[1]=today; wider ranges can land on
//      a close from several days ago when markets are closed / extended hours.
async function fetchStock(sym) {
  // Primary: Yahoo v7 quote
  try {
    const d = await fetchProxy(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`);
    const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice != null && q?.regularMarketChangePercent != null) {
      return { p: q.regularMarketPrice, chg: q.regularMarketChangePercent };
    }
  } catch {}
  // Fallback: v8 chart with range=2d — only 2 daily bars, so bar[0].close = previousClose
  try {
    const d = await fetchProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`);
    const r = d.chart.result[0];
    const p = r.meta.regularMarketPrice ?? r.meta.previousClose;
    // meta.previousClose is the prior session close — correct anchor for 1-day %
    const prev = r.meta.previousClose ?? r.meta.chartPreviousClose;
    return { p, chg: prev ? ((p - prev) / prev) * 100 : 0 };
  } catch {}
  // Last resort: v8 range=5d via query2
  try {
    const d = await fetchProxy(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`);
    const r = d.chart.result[0];
    const p = r.meta.regularMarketPrice ?? r.meta.previousClose;
    const prev = r.meta.previousClose ?? r.meta.chartPreviousClose;
    return { p, chg: prev ? ((p - prev) / prev) * 100 : 0 };
  } catch {}
  throw new Error('stock failed: ' + sym);
}

// ── Stock extra data (OBI, CVD, MTF, biases) ──
async function fetchStockExtra(sym) {
  const extra = { obi: null, cvd: null, mtf: [null, null, null], k4h: null, kDay: null, stockMeta: null };
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`;
    const d = await fetchProxy(url);
    const r = d.chart.result[0];
    const qi = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < qi.close.length; i++) {
      if (qi.close[i] != null && qi.open[i] != null && qi.volume[i] != null)
        bars.push({ c: qi.close[i], o: qi.open[i], h: qi.high[i] || qi.close[i], l: qi.low[i] || qi.close[i], v: qi.volume[i] });
    }
    const n = bars.length;
    if (n < 10) return extra;
    const closes = bars.map(b => b.c);
    const opens = bars.map(b => b.o);
    const highs = bars.map(b => b.h);
    const lows = bars.map(b => b.l);
    const volumes = bars.map(b => b.v);

    const rsi15 = calcRSI(closes.slice(-5), 4);
    const rsi1h = calcRSI(closes.slice(-15), 7);
    const rsiDaily = calcRSI(closes, 14);
    extra.mtf = [rsi15, rsi1h, rsiDaily];

    let cvd = 0;
    const cvdSeries = bars.map(b => { cvd += b.c >= b.o ? b.v : -b.v; return cvd; });
    const cvdLast = cvdSeries[n - 1], cvdPrev = cvdSeries[Math.max(0, n - 6)];
    extra.cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };

    const rangePos = highs[n - 1] > lows[n - 1] ? (closes[n - 1] - lows[n - 1]) / (highs[n - 1] - lows[n - 1]) : 0.5;
    extra.obi = {
      bidPct: (rangePos * 100).toFixed(1),
      askPct: ((1 - rangePos) * 100).toFixed(1),
      ratio: (rangePos / (1 - rangePos + 0.001)).toFixed(2)
    };

    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1) || 1;
    const volShock = Math.min(3, volumes[n - 1] / avgVol);
    extra.stockMeta = { volShock: volShock.toFixed(2) };

    const recent5 = closes.slice(-5);
    const recentVols = volumes.slice(-5);
    const recentUp = recent5[4] > recent5[0];
    const volUp = recentVols[4] > (recentVols.slice(0, 4).reduce((a, b) => a + b, 0) / 4);
    const k8 = 2 / (8 + 1);
    let ema8 = closes[Math.max(0, n - 9)];
    for (let i = Math.max(0, n - 8); i < n; i++) ema8 = closes[i] * k8 + ema8 * (1 - k8);
    let cvd4h = 0;
    for (let i = n - 4; i < n; i++) cvd4h += bars[i].c >= bars[i].o ? 1 : -1;
    extra.k4h = { rsi4h: rsiDaily, recentUp, volUp, aboveEma8: closes[n - 1] > ema8, cvd4h, lastClose: closes[n - 1], prevClose: closes[n - 4] };

    const k7 = 2 / (7 + 1);
    let ema7 = closes[Math.max(0, n - 8)];
    for (let i = Math.max(0, n - 7); i < n; i++) ema7 = closes[i] * k7 + ema7 * (1 - k7);
    const chg7d  = closes[n - 7] > 0 ? ((closes[n - 1] - closes[n - 7]) / closes[n - 7] * 100) : 0;
    // chg1d: previous close → current close (true single-day change from daily bars)
    const chg1d  = closes[n - 2] > 0 ? ((closes[n - 1] - closes[n - 2]) / closes[n - 2] * 100) : 0;
    const volSurge = volumes[n - 1] > avgVol * 1.4;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += bars[i].c >= bars[i].o ? 1 : -1;
    extra.kDay = { rsiDaily, aboveEma7: closes[n - 1] > ema7, volSurge, chg7d: parseFloat(chg7d.toFixed(1)), chg1d: parseFloat(chg1d.toFixed(2)), cvdDaily };

    // Expose raw OHLC bar arrays so calcSupRes() in signals.js can compute pivots
    extra._barsDay = bars;           // all daily bars (up to ~60 from 3mo range)
    extra._bars4h  = bars.slice(-20); // most-recent 20 as shorter-term context
  } catch {}
  return extra;
}

// ── Crypto market microstructure ──
async function fetchOBI(pair) {
  const url = `https://api.binance.com/api/v3/depth?symbol=${pair}&limit=20`;
  let d = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) d = await r.json(); } catch {}
  if (!d || !d.bids) { try { d = await fetchProxy(url); } catch { return null; } }
  if (!d || !d.bids) return null;
  const bv = d.bids.reduce((s, x) => s + parseFloat(x[1]), 0);
  const av = d.asks.reduce((s, x) => s + parseFloat(x[1]), 0);
  const tot = bv + av;
  return { bidPct: (bv / tot * 100).toFixed(1), askPct: (av / tot * 100).toFixed(1), ratio: (bv / av).toFixed(2) };
}

async function fetchCVD(pair) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=15m&limit=48`;
  let k = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) k = await r.json(); } catch {}
  if (!Array.isArray(k)) { try { k = await fetchProxy(url); } catch { return null; } }
  if (!Array.isArray(k)) return null;
  let cvd = 0;
  const series = k.map(c => { const vol = parseFloat(c[5]), o = parseFloat(c[1]), cl = parseFloat(c[4]); cvd += cl >= o ? vol : -vol; return cvd; });
  const last = series[series.length - 1], prev5 = series[series.length - 6] || series[0];
  return { value: last, series: series.slice(-20), trending: last > prev5 ? 'up' : 'down' };
}

async function fetchMTF(pair) {
  const tfs = ['15m', '1h', '4h'];
  return Promise.all(tfs.map(async tf => {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=30`;
      const k = await fetchBinance(url);
      return calcRSI(k.map(c => parseFloat(c[4])), 14);
    } catch { return null; }
  }));
}

async function fetch4hKlines(pair) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=20`;
    const k = await fetchBinance(url);
    if (!Array.isArray(k) || k.length < 5) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const volumes = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const recentUp = closes[n - 1] > closes[n - 4];
    const volUp = volumes[n - 1] > ((volumes[n - 2] + volumes[n - 3] + volumes[n - 4]) / 3);
    const rsi4h = calcRSI(closes, 14);
    const k2 = 2 / (8 + 1); let ema8 = closes[0];
    for (let i = 1; i < closes.length; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
    let cvd4h = 0;
    for (let i = n - 4; i < n; i++) { const o = parseFloat(k[i][1]); cvd4h += closes[i] > o ? 1 : -1; }
    return { rsi4h, recentUp, volUp, aboveEma8: closes[n - 1] > ema8, cvd4h, lastClose: closes[n - 1], prevClose: closes[n - 4] };
  } catch { return null; }
}

async function fetchDailyKlines(pair) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=14`;
    const k = await fetchBinance(url);
    if (!Array.isArray(k) || k.length < 7) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const volumes = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2 / (7 + 1); let ema7 = closes[0];
    for (let i = 1; i < closes.length; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
    const avgVol = volumes.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1);
    const volSurge = volumes[n - 1] > avgVol * 1.5;
    const chg7d = ((closes[n - 1] - closes[n - 7]) / closes[n - 7] * 100).toFixed(1);
    // chg1d: previous daily close → current close (true 24h from Binance daily bars)
    const chg1d = closes[n - 2] > 0 ? parseFloat(((closes[n - 1] - closes[n - 2]) / closes[n - 2] * 100).toFixed(2)) : null;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) { const o = parseFloat(k[i][1]); cvdDaily += closes[i] > o ? 1 : -1; }
    // Build normalised bar array for calcSupRes pivot detection
    const dailyBars = k.map(c => ({ h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]) }));
    return { rsiDaily, aboveEma7: closes[n - 1] > ema7, volSurge, chg7d: parseFloat(chg7d), chg1d, cvdDaily, _barsDay: dailyBars };
  } catch { return null; }
}

// ── RSI calculation ──
function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; g += d > 0 ? d : 0; l += d < 0 ? -d : 0; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

// ── CoinGecko OHLC fallback for Binance-delisted pairs (e.g. XMRUSDT) ──
// CoinGecko /ohlc returns [[timestamp,o,h,l,c], ...] for 14 days at daily granularity.
// We use this to reconstruct kDay, k4h (approximated), CVD, MTF RSI, and sup/res bars
// so all columns compute correctly even without Binance data.
async function fetchCoinGeckoExtra(pair) {
  const cgid = CG[pair];
  if (!cgid) return null;
  try {
    // 14-day daily OHLC — sufficient for RSI-14, EMA-7, sup/res pivots
    const url = `https://api.coingecko.com/api/v3/coins/${cgid}/ohlc?vs_currency=usd&days=14`;
    let raw = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) raw = await r.json();
    } catch {}
    if (!raw) raw = await fetchProxy(url);
    if (!Array.isArray(raw) || raw.length < 8) return null;

    // raw rows: [timestamp_ms, open, high, low, close]
    const bars = raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
    const closes  = bars.map(b => b.c);
    const n = closes.length;

    // ── kDay ──
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2 / (7 + 1); let ema7 = closes[0];
    for (let i = 1; i < n; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
    const chg7d  = closes[n - 7] > 0 ? parseFloat(((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1)) : 0;
    const chg1d  = closes[n - 2] > 0 ? parseFloat(((closes[n-1] - closes[n-2]) / closes[n-2] * 100).toFixed(2)) : null;
    // CoinGecko OHLC has no volume; approximate CVD from candle direction
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += bars[i].c >= bars[i].o ? 1 : -1;
    // volSurge: use body size of last candle vs avg of prior 6 as a proxy
    const bodySize = i => Math.abs(bars[i].c - bars[i].o);
    const avgBody = bars.slice(n - 7, n - 1).reduce((s, _, ii, a) => s + bodySize(n - 7 + ii), 0) / 6;
    const volSurge = bodySize(n - 1) > avgBody * 1.5;
    const dailyBars = bars.map(b => ({ h: b.h, l: b.l, c: b.c }));
    const kDay = { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d, chg1d, cvdDaily, _barsDay: dailyBars };

    // ── k4h proxy — use last 8 daily bars split into pseudo-4h segments ──
    // (CoinGecko free tier doesn't offer 4h OHLC without a paid plan)
    const recent = bars.slice(-8);
    const rClose = recent.map(b => b.c);
    const rn = rClose.length;
    const rsi4h = calcRSI(rClose, Math.min(7, rn - 1));
    const k3 = 2 / (8 + 1); let ema8 = rClose[0];
    for (let i = 1; i < rn; i++) ema8 = rClose[i] * k3 + ema8 * (1 - k3);
    const recentUp = rClose[rn-1] > rClose[rn-4];
    // vol proxy: last candle body vs prior 3 average
    const recentBodies = recent.map(b => Math.abs(b.c - b.o));
    const volUp = recentBodies[rn-1] > (recentBodies.slice(-4, -1).reduce((a, b) => a + b, 0) / 3);
    let cvd4h = 0;
    for (let i = rn - 4; i < rn; i++) cvd4h += recent[i].c >= recent[i].o ? 1 : -1;
    const k4h = { rsi4h, recentUp, volUp, aboveEma8: rClose[rn-1] > ema8, cvd4h, lastClose: rClose[rn-1], prevClose: rClose[rn-4] };

    // ── MTF RSI — derived from the same daily bar series at different lookbacks ──
    // True 15m/1h/4h bars aren't available from CoinGecko free tier.
    // We approximate using different RSI periods on daily closes:
    //   r15 (≈ short-term) → RSI-3 on last 6 bars
    //   r1h (≈ mid-term)   → RSI-5 on last 10 bars
    //   r4h (≈ swing)      → RSI-7 on last 12 bars
    const r15 = calcRSI(closes.slice(-6),  3);
    const r1h = calcRSI(closes.slice(-10), 5);
    const r4h = calcRSI(closes.slice(-12), 7);
    const mtf = [r15, r1h, r4h];

    // ── CVD approximation (candle-direction proxy) ──
    let cvdAcc = 0;
    const cvdSeries = bars.slice(-20).map(b => { cvdAcc += b.c >= b.o ? 1 : -1; return cvdAcc; });
    const cvdLast = cvdSeries[cvdSeries.length - 1];
    const cvdPrev = cvdSeries[Math.max(0, cvdSeries.length - 6)];
    const cvd = { value: cvdLast, series: cvdSeries, trending: cvdLast > cvdPrev ? 'up' : 'down' };

    // ── OBI: not available without Binance order book — return null ──
    // (will show — in the OBI column, which is correct)
    const obi = null;

    return { obi, cvd, mtf, k4h, kDay, _barsDay: dailyBars };
  } catch { return null; }
}

// ── Liq cluster estimate (crypto only) ──
function liqEstimate(price, fr, lp) {
  if (!price) return null;
  const f = parseFloat(fr) || 0;
  let dist, side;
  if (lp > 60) { dist = -(3 + Math.abs(f) * 500 + (lp - 50) * .15); side = 'LONG LIQ'; }
  else if (lp < 40) { dist = +(3 + Math.abs(f) * 500 + (50 - lp) * .15); side = 'SHORT LIQ'; }
  else { dist = lp > 50 ? -(2 + Math.random() * 2) : (2 + Math.random() * 2); side = lp > 50 ? 'LONG LIQ' : 'SHORT LIQ'; }
  const lp2 = price * (1 + dist / 100);
  return { price: lp2.toFixed(lp2 < 1 ? 4 : 2), dist: dist.toFixed(1), side };
}

// ── Global market stats ──
async function fetchGlobal() {
  try {
    const d = await fetchDirect('https://api.coingecko.com/api/v3/global');
    document.getElementById('h-btcdom').textContent = d.data.market_cap_percentage.btc.toFixed(1) + '%';
    document.getElementById('h-mcap').textContent = '$' + (d.data.total_market_cap.usd / 1e12).toFixed(2) + 'T';
    document.getElementById('h-vol').textContent = '$' + (d.data.total_volume.usd / 1e9).toFixed(1) + 'B';
  } catch {}
}

async function fetchFG() {
  try {
    const d = await fetchDirect('https://api.alternative.me/fng/');
    const val = parseInt(d.data[0].value);
    const lbl = d.data[0].value_classification;
    const pill = document.getElementById('fg-pill');
    pill.textContent = 'F&G: ' + val + ' · ' + lbl.toUpperCase();
    if (val <= 25) { pill.style.background = 'var(--bear-dim)'; pill.style.color = 'var(--bear)'; }
    else if (val <= 45) { pill.style.background = 'rgba(255,140,0,.15)'; pill.style.color = '#ff8c00'; }
    else if (val >= 75) { pill.style.background = 'var(--bull-dim)'; pill.style.color = 'var(--bull)'; }
    else { pill.style.background = 'rgba(100,100,100,.2)'; pill.style.color = '#aaa'; }
  } catch {}
}

// ── Market Pulse Panel — indices, sectors, macro, crypto ──
const MPULSE_STOCKS = [
  { id: 'mp-SPY', sym: 'SPY'  },
  { id: 'mp-QQQ', sym: 'QQQ'  },
  { id: 'mp-DIA', sym: 'DIA'  },
  { id: 'mp-IWM', sym: 'IWM'  },
  { id: 'mp-XLK', sym: 'XLK'  },
  { id: 'mp-XLE', sym: 'XLE'  },
  { id: 'mp-XLF', sym: 'XLF'  },
  { id: 'mp-XLV', sym: 'XLV'  },
  { id: 'mp-GLD', sym: 'GLD'  },
  { id: 'mp-UUP', sym: 'UUP'  },
  { id: 'mp-TLT', sym: 'TLT'  },
  { id: 'mp-USO', sym: 'USO'  },
];

const MPULSE_CRYPTO = [
  { id: 'mp-BTC', sym: 'BTCUSDT' },
  { id: 'mp-ETH', sym: 'ETHUSDT' },
  { id: 'mp-SOL', sym: 'SOLUSDT' },
  { id: 'mp-XMR', sym: 'XMRUSDT' },
];

async function fetchMarketPulse() {
  const btn = document.querySelector('.mp-refresh-btn');
  if (btn) btn.classList.add('spinning');

  // Mark all tiles as loading
  [...MPULSE_STOCKS, ...MPULSE_CRYPTO].forEach(p => {
    const el = document.getElementById(p.id);
    if (el) el.classList.add('mp-loading');
  });

  // ── Crypto: single Binance batch (skip delisted) ──
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr`;
    let data = null;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) data = await r.json(); } catch {}
    if (!data) data = await fetchProxy(url);
    if (Array.isArray(data)) {
      const byPair = Object.fromEntries(data.map(t => [t.symbol, t]));
      for (const pill of MPULSE_CRYPTO) {
        if (BINANCE_DELISTED.has(pill.sym)) continue;
        const t = byPair[pill.sym];
        if (t) updateMPill(pill.id, parseFloat(t.lastPrice), parseFloat(t.priceChangePercent));
      }
    }
  } catch {}

  // XMR and other delisted: CoinGecko simple/price
  const delistedCrypto = MPULSE_CRYPTO.filter(p => BINANCE_DELISTED.has(p.sym));
  if (delistedCrypto.length) {
    try {
      const ids = delistedCrypto.map(p => CG[p.sym]).filter(Boolean).join(',');
      const d = await fetchDirect(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      for (const pill of delistedCrypto) {
        const cgid = CG[pill.sym];
        if (d[cgid]) updateMPill(pill.id, d[cgid].usd, d[cgid].usd_24h_change || 0);
      }
    } catch {}
  }

  // ── Stocks/ETFs: 2 batched Yahoo v7 calls instead of 12 parallel ──
  const stockBatches = [
    MPULSE_STOCKS.slice(0, 6),   // SPY QQQ DIA IWM XLK XLE
    MPULSE_STOCKS.slice(6),      // XLF XLV GLD UUP TLT USO
  ];
  await Promise.allSettled(stockBatches.map(async batch => {
    try {
      const syms = batch.map(p => p.sym).join(',');
      const d = await fetchProxy(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}`);
      const results = d?.quoteResponse?.result || [];
      for (const q of results) {
        const pill = batch.find(p => p.sym === q.symbol);
        if (pill && q.regularMarketPrice != null && q.regularMarketChangePercent != null) {
          updateMPill(pill.id, q.regularMarketPrice, q.regularMarketChangePercent);
        }
      }
    } catch {}
  }));

  // Timestamp + stop spinner
  const upd = document.getElementById('mp-updated');
  if (upd) upd.textContent = 'UPD ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (btn) btn.classList.remove('spinning');
}

function updateMPill(id, price, chgPct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('mp-loading');

  const valEl = el.querySelector('.mp-tile-val');
  const chgEl = el.querySelector('.mp-tile-chg');
  if (!valEl || !chgEl) return;

  const pStr = price >= 10000 ? '$' + Math.round(price).toLocaleString('en')
             : price >= 1     ? '$' + price.toFixed(2)
             :                  '$' + price.toFixed(4);
  valEl.textContent = pStr;

  const sign = chgPct >= 0 ? '+' : '';
  chgEl.textContent = sign + chgPct.toFixed(2) + '%';

  const up = chgPct > 0.05, dn = chgPct < -0.05;
  chgEl.className = 'mp-tile-chg ' + (up ? 'up' : dn ? 'dn' : 'flat');
  el.classList.toggle('mp-hot-up', chgPct >  1.5);
  el.classList.toggle('mp-hot-dn', chgPct < -1.5);
}
