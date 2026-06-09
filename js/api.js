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

  // Fallback: for delisted pairs use Kraken ticker; for others try CoinGecko
  const missing = pairs.filter(p => !res['BINANCE:' + p]);
  if (missing.length) {
    // Kraken-first for known delisted pairs
    const krakenMissing = missing.filter(p => KRAKEN_PAIR[p]);
    await Promise.allSettled(krakenMissing.map(async p => {
      try {
        const kPair = KRAKEN_PAIR[p];
        const url = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
        let d = null;
        try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
        if (!d) d = await fetchProxy(url);
        const key = Object.keys(d.result || {})[0];
        if (key) {
          const t = d.result[key];
          const last = parseFloat(t.c[0]);
          const open = parseFloat(t.o);
          const chg  = open > 0 ? parseFloat(((last - open) / open * 100).toFixed(2)) : 0;
          res['BINANCE:' + p] = { p: last, chg };
        }
      } catch {}
    }));

    // CoinGecko for any still-missing non-Kraken pairs
    const cgMissing = missing.filter(p => !res['BINANCE:' + p]);
    if (cgMissing.length) {
      try {
        const idMap = {};
        await Promise.all(cgMissing.map(async p => { idMap[await cgId(p)] = p; }));
        const ids = Object.keys(idMap).join(',');
        const d = await fetchDirect(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
        for (const [id, pair] of Object.entries(idMap)) {
          if (d[id]) res['BINANCE:' + pair] = { p: d[id].usd, chg: d[id].usd_24h_change || 0 };
        }
      } catch {}
    }
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

// ── Kraken extra data for Binance-delisted pairs (e.g. XMRUSDT) ──
// Kraken has XMR/USD listed, public API, no key required, CORS-friendly via proxy.
// Provides real OHLC at daily + 4h intervals, real volume, and a live ticker.
//
// Kraken pair map for delisted symbols:
const KRAKEN_PAIR = { 'XMRUSDT': 'XMRUSD' };

async function fetchKrakenExtra(pair) {
  const kPair = KRAKEN_PAIR[pair];
  if (!kPair) return null;

  try {
    // ── Daily OHLC (interval=1440) — 20 bars ──
    const dayUrl = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=1440&count=20`;
    let dayRaw = null;
    try { const r = await fetch(dayUrl, { signal: AbortSignal.timeout(8000) }); if (r.ok) dayRaw = await r.json(); } catch {}
    if (!dayRaw) dayRaw = await fetchProxy(dayUrl);
    // Kraken response: { error:[], result: { XMRUSD: [[time,o,h,l,c,vwap,vol,count], ...], last: N } }
    const dayKey = Object.keys(dayRaw.result || {}).find(k => k !== 'last');
    if (!dayKey) return null;
    const dayBars = dayRaw.result[dayKey].map(r => ({
      t: r[0] * 1000, o: parseFloat(r[1]), h: parseFloat(r[2]),
      l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]),
    }));
    if (dayBars.length < 8) return null;

    const closes  = dayBars.map(b => b.c);
    const volumes = dayBars.map(b => b.v);
    const n = closes.length;

    // ── kDay ──
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2 / (7 + 1); let ema7 = closes[0];
    for (let i = 1; i < n; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
    const chg7d  = closes[n - 7] > 0 ? parseFloat(((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1)) : 0;
    const chg1d  = closes[n - 2] > 0 ? parseFloat(((closes[n-1] - closes[n-2]) / closes[n-2] * 100).toFixed(2)) : null;
    const avgVol  = volumes.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1);
    const volSurge = volumes[n - 1] > avgVol * 1.4;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += dayBars[i].c >= dayBars[i].o ? 1 : -1;
    const dailyBars = dayBars.map(b => ({ h: b.h, l: b.l, c: b.c }));
    const kDay = { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d, chg1d, cvdDaily, _barsDay: dailyBars };

    // ── 4h OHLC (interval=240) — 20 bars ──
    let k4h = null;
    try {
      const h4Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=240&count=20`;
      let h4Raw = null;
      try { const r = await fetch(h4Url, { signal: AbortSignal.timeout(8000) }); if (r.ok) h4Raw = await r.json(); } catch {}
      if (!h4Raw) h4Raw = await fetchProxy(h4Url);
      const h4Key = Object.keys(h4Raw.result || {}).find(k => k !== 'last');
      if (h4Key) {
        const h4Bars = h4Raw.result[h4Key].map(r => ({
          o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]),
          c: parseFloat(r[4]), v: parseFloat(r[6]),
        }));
        const rClose = h4Bars.map(b => b.c);
        const rVols  = h4Bars.map(b => b.v);
        const rn = rClose.length;
        const rsi4h = calcRSI(rClose, Math.min(14, rn - 1));
        const k3 = 2 / (8 + 1); let ema8 = rClose[0];
        for (let i = 1; i < rn; i++) ema8 = rClose[i] * k3 + ema8 * (1 - k3);
        const recentUp = rClose[rn-1] > rClose[Math.max(0, rn-4)];
        const avgVol4h = rVols.slice(0, rn - 1).reduce((a, b) => a + b, 0) / (rn - 1);
        const volUp = rVols[rn - 1] > avgVol4h * 1.3;
        let cvd4h = 0;
        for (let i = Math.max(0, rn - 4); i < rn; i++) cvd4h += h4Bars[i].c >= h4Bars[i].o ? 1 : -1;
        k4h = { rsi4h, recentUp, volUp, aboveEma8: rClose[rn-1] > ema8, cvd4h, lastClose: rClose[rn-1], prevClose: rClose[Math.max(0, rn-4)] };
      }
    } catch {}

    // Fallback k4h from daily bars if 4h fetch failed
    if (!k4h) {
      const recent = dayBars.slice(-8);
      const rClose = recent.map(b => b.c);
      const rn = rClose.length;
      const rsi4h = calcRSI(rClose, Math.min(7, rn - 1));
      const k3 = 2 / (8 + 1); let ema8 = rClose[0];
      for (let i = 1; i < rn; i++) ema8 = rClose[i] * k3 + ema8 * (1 - k3);
      const recentUp = rClose[rn-1] > rClose[Math.max(0, rn-4)];
      const recentBodies = recent.map(b => Math.abs(b.c - b.o));
      const volUp = recentBodies[rn-1] > (recentBodies.slice(-4, -1).reduce((a, b) => a + b, 0) / 3);
      let cvd4h = 0;
      for (let i = Math.max(0, rn - 4); i < rn; i++) cvd4h += recent[i].c >= recent[i].o ? 1 : -1;
      k4h = { rsi4h, recentUp, volUp, aboveEma8: rClose[rn-1] > ema8, cvd4h, lastClose: rClose[rn-1], prevClose: rClose[Math.max(0, rn-4)] };
    }

    // ── MTF RSI from 15m klines (interval=15) ──
    let mtf = [null, null, null];
    try {
      const m15Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=15&count=60`;
      let m15Raw = null;
      try { const r = await fetch(m15Url, { signal: AbortSignal.timeout(8000) }); if (r.ok) m15Raw = await r.json(); } catch {}
      if (!m15Raw) m15Raw = await fetchProxy(m15Url);
      const m15Key = Object.keys(m15Raw.result || {}).find(k => k !== 'last');
      if (m15Key) {
        const m15Closes = m15Raw.result[m15Key].map(r => parseFloat(r[4]));
        const r15 = calcRSI(m15Closes.slice(-20),  14);
        const r1h = calcRSI(m15Closes.slice(-30),  14); // ~7.5h of 15m bars
        const r4h = calcRSI(m15Closes,             14); // full 15h window
        mtf = [r15, r1h, r4h];
      }
    } catch {}
    // Fallback MTF from daily closes at different lookbacks
    if (mtf.every(v => v === null)) {
      mtf = [
        calcRSI(closes.slice(-6),  3),
        calcRSI(closes.slice(-10), 5),
        calcRSI(closes.slice(-12), 7),
      ];
    }

    // ── CVD from 15m volume-weighted direction ──
    let cvd = null;
    try {
      const m15Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=15&count=48`;
      let m15Raw = null;
      try { const r = await fetch(m15Url, { signal: AbortSignal.timeout(8000) }); if (r.ok) m15Raw = await r.json(); } catch {}
      if (!m15Raw) m15Raw = await fetchProxy(m15Url);
      const m15Key = Object.keys(m15Raw.result || {}).find(k => k !== 'last');
      if (m15Key) {
        let cvdAcc = 0;
        const cvdSeries = m15Raw.result[m15Key].map(r => {
          const vol = parseFloat(r[6]), o = parseFloat(r[1]), c = parseFloat(r[4]);
          cvdAcc += c >= o ? vol : -vol;
          return cvdAcc;
        });
        const cvdLast = cvdSeries[cvdSeries.length - 1];
        const cvdPrev = cvdSeries[Math.max(0, cvdSeries.length - 6)];
        cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };
      }
    } catch {}
    // Fallback CVD from daily candle direction
    if (!cvd) {
      let cvdAcc = 0;
      const cvdSeries = dayBars.slice(-20).map(b => { cvdAcc += b.c >= b.o ? 1 : -1; return cvdAcc; });
      const cvdLast = cvdSeries[cvdSeries.length - 1];
      const cvdPrev = cvdSeries[Math.max(0, cvdSeries.length - 6)];
      cvd = { value: cvdLast, series: cvdSeries, trending: cvdLast > cvdPrev ? 'up' : 'down' };
    }

    // OBI not available without Binance order book
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
// ── Market Pulse instrument map ──
// INDEX: Stooq index symbols (^spx etc.) — 24h, not ETF-dependent
// SECTOR: ETFs — only meaningful during NY session; show stale gracefully
// MACRO: 24h instruments — gold/silver spot, DXY forex, 10Y yield, WTI + Brent futures
//   GOLD   → XAU/USD spot via stooq xauusd
//   SILVER → XAG/USD spot via stooq xagusd
//   DXY    → stooq dx-y.nyb (ICE DXY index, ~24h)
//   BONDS  → stooq ^tnx (10Y Treasury yield — more useful than TLT ETF price)
//   WTI    → stooq cl.f (WTI front-month futures, nearly 24h)
//   BRENT  → stooq lco.f (Brent crude front-month futures, nearly 24h)
const MPULSE_STOCKS = [
  // INDEX — stooq index tickers, available outside US hours
  { id: 'mp-SPY', sym: '^spx',     stooq: true },
  { id: 'mp-QQQ', sym: '^ndx',     stooq: true },
  { id: 'mp-DIA', sym: '^dji',     stooq: true },
  // SECTOR — US ETFs, NY session only; stooq .us suffix
  { id: 'mp-XLK', sym: 'XLK',      stooq: false },
  { id: 'mp-XLE', sym: 'XLE',      stooq: false },
  { id: 'mp-XLF', sym: 'XLF',      stooq: false },
  { id: 'mp-XLV', sym: 'XLV',      stooq: false },
  // MACRO — 24h instruments via stooq
  { id: 'mp-GLD', sym: 'xauusd',   stooq: true },   // Gold spot XAU/USD
  { id: 'mp-SLV', sym: 'xagusd',   stooq: true },   // Silver spot XAG/USD
  { id: 'mp-UUP', sym: 'dx-y.nyb', stooq: true },   // ICE DXY index
  { id: 'mp-TLT', sym: '^tnx',     stooq: true },   // 10Y Treasury yield
  { id: 'mp-USO', sym: 'cl.f',     stooq: true },   // WTI crude futures
  { id: 'mp-BRT', sym: 'lco.f',    stooq: true },   // Brent crude futures
];

const MPULSE_CRYPTO = [
  { id: 'mp-BTC', sym: 'BTCUSDT' },
  { id: 'mp-ETH', sym: 'ETHUSDT' },
  { id: 'mp-SOL', sym: 'SOLUSDT' },
  { id: 'mp-XMR', sym: 'XMRUSDT' },
];


// ── Stooq fetch — no API key, no rate limits, 24h for index/forex/futures ──
// sym examples: '^spx', 'xauusd', 'cl.f', 'dx-y.nyb', 'XLK.us'
// Returns { p, chg } where chg = day% vs previous close.
async function fetchStooq(sym) {
  // Stooq appends .us for plain uppercase ETF tickers; others pass through
  const s = /^[A-Z]{2,5}$/.test(sym) ? sym.toLowerCase() + '.us' : sym.toLowerCase();
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
  let txt = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(9000) }); if (r.ok) txt = await r.text(); } catch {}
  if (!txt) {
    try {
      const r = await fetch(PROXIES[0](url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) { const raw = await r.text(); try { txt = JSON.parse(raw).contents ?? raw; } catch { txt = raw; } }
    } catch {}
  }
  if (!txt || txt.includes('No data') || txt.trim().split('\n').length < 3) throw new Error('stooq:nodata:' + sym);
  const rows = txt.trim().split('\n').slice(1).filter(Boolean);
  const parse = row => parseFloat(row.split(',')[4]);
  const last = parse(rows[rows.length - 1]);
  const prev = parse(rows[rows.length - 2]);
  if (!last || !prev) throw new Error('stooq:parse:' + sym);
  return { p: last, chg: ((last - prev) / prev) * 100 };
}

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

  // XMR and other delisted: Kraken ticker (no API key, real-time, CORS via proxy)
  const delistedCrypto = MPULSE_CRYPTO.filter(p => BINANCE_DELISTED.has(p.sym));
  await Promise.allSettled(delistedCrypto.map(async pill => {
    const kPair = KRAKEN_PAIR[pill.sym];
    if (!kPair) return;
    try {
      const url = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
      let d = null;
      try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
      if (!d) d = await fetchProxy(url);
      const key = Object.keys(d.result || {})[0];
      if (key) {
        const t = d.result[key];
        const last = parseFloat(t.c[0]);
        const open = parseFloat(t.o);
        const chg  = open > 0 ? parseFloat(((last - open) / open * 100).toFixed(2)) : 0;
        updateMPill(pill.id, last, chg);
      }
    } catch {}
  }));

  // ── Stocks / Indices / Macro ──
  // stooq:true  → 24h instruments (indices, gold, DXY, yield, oil) — always available
  // stooq:false → US ETFs (sectors) — Yahoo cascade, honest — during off-hours
  await Promise.allSettled(MPULSE_STOCKS.map(async pill => {
    if (pill.stooq) {
      // Primary: Stooq (24h, no rate limit)
      try { const { p, chg } = await fetchStooq(pill.sym); if (p != null) { updateMPill(pill.id, p, chg); return; } } catch {}
      // Fallback: Yahoo for any index that Stooq misses
      const yahooMap = { '^spx': '%5EGSPC', '^ndx': '%5EIXIC', '^dji': '%5EDJI', '^tnx': '%5ETNX' };
      const yTicker = yahooMap[pill.sym] || pill.sym;
      try { const { p, chg } = await fetchStock(yTicker); if (p != null) updateMPill(pill.id, p, chg); } catch {}
    } else {
      // US sector ETFs — Yahoo cascade (only meaningful in NY session)
      try { const { p, chg } = await fetchStock(pill.sym); if (p != null) updateMPill(pill.id, p, chg); } catch {}
    }
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

  // Store in STATE.marketPulse keyed by sym (strip 'mp-' prefix)
  const sym = id.replace('mp-', '');
  if (!STATE.marketPulse) STATE.marketPulse = {};
  STATE.marketPulse[sym] = { p: price, chg: chgPct };
}
