// ══════════════════════════════════════════════
// api.js — v13.2 — all fetch, proxy, and data functions
// v13.2 removes api.codetabs.com from the proxy chain. v13.1's console log
// showed it returning a hard 400 on every single request (not a rate limit),
// matching other developers' independent reports that the service is
// currently broken — it was just a slow, guaranteed-failing hop in front of
// proxies that might otherwise succeed. Chain is back to corsproxy.io (both
// URL formats) + allorigins.win, matching the original v12.9 chain that was
// confirmed working, with the `?url=` format added as a second corsproxy.io
// attempt.
//
// v13.1 fixed a latency REGRESSION from v13.0: the proxy concurrency cap (4)
// and per-proxy retry made the page SLOWER than v12.9 for visitors whose
// direct Binance calls are CORS-blocked on every request (proxy fallback is
// their primary path, not an occasional one). Cap raised 4→12, retry removed.
// See inline comments at PROXY_MAX_CONCURRENT / fetchProxy for detail.
//
// Key changes from v12.9 (unchanged from original v13.0):
//   • fetchCryptoExtra() no longer refetches 4h/daily klines on every 15s
//     cycle — those are cached per-pair with a TTL (4h klines: 4min,
//     daily klines: 15min) since they cannot meaningfully change inside
//     a 15s window. Only depth + 15m klines (CVD/MTF, genuinely fast-moving)
//     are fetched live every call. This cuts steady-state Binance/proxy
//     calls by ~50% with zero loss of signal freshness.
//   • In-flight request coalescing: if the staggered per-symbol sync loop
//     (app.js) requests the same URL while a previous call for it is still
//     pending, the second caller awaits the same promise instead of firing
//     a duplicate network request / proxy hit.
//   • fetchCryptoExtra() still fires Promise.allSettled in parallel; MTF RSI
//     is derived from the 15m klines so no separate 1h/4h kline calls are
//     needed. Old single-endpoint functions kept as thin stubs.
// ══════════════════════════════════════════════

// Proxy order: matches the original v12.9 chain that was working reliably —
// corsproxy.io (bare-query format) then allorigins.win. v13.0/13.1 added
// api.codetabs.com and a second corsproxy.io URL format, but the latest
// console log shows codetabs.com returning a consistent 400 on every single
// request (not a rate limit — a hard rejection), which matches other
// developers independently reporting api.codetabs.com/v1/proxy as broken
// recently. It added a slow, guaranteed-failing hop in front of proxies
// that might otherwise succeed, so it's removed here. The `?url=` format
// of corsproxy.io is kept as a second corsproxy.io attempt since it's
// their currently-documented format, ahead of allorigins.win.
const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
];

// ── In-flight request coalescing ──
// Keyed by raw target URL. While a fetchBinance/fetchProxy call for a given
// URL is in flight, any additional caller for that exact URL awaits the
// same promise instead of starting a second network/proxy request. This
// matters because the adaptive sync loop staggers symbols only 100ms apart,
// so overlapping calls for shared endpoints (e.g. ticker/24hr) were common.
const _inflight = new Map();

function _coalesce(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── Global proxy concurrency limiter ──
// v13.0 shipped this capped at 4, assuming proxy fallback was a rare path
// (most requests succeed direct, proxy only kicks in occasionally). For a
// visitor whose direct Binance calls are CORS-blocked on every request,
// proxy fallback IS the primary path — capping at 4 turned a parallel
// fan-out (v12.9: all ~30-60 calls fire at once) into a slow queue and made
// the page slower than v12.9, not faster. Raised to 12 — still a sane
// ceiling that avoids ever firing 60 simultaneous proxy requests on a cold
// load, but no longer serializes a normal sync cycle when proxy is the
// only path available.
const PROXY_MAX_CONCURRENT = 12;
let _proxyActive = 0;
const _proxyQueue = [];

function _withProxySlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _proxyActive++;
      fn().then(resolve, reject).finally(() => {
        _proxyActive--;
        if (_proxyQueue.length) _proxyQueue.shift()();
      });
    };
    if (_proxyActive < PROXY_MAX_CONCURRENT) run();
    else _proxyQueue.push(run);
  });
}

// v13.0 originally retried each proxy once before falling through (2
// attempts × 3 proxies = up to 6 round trips, ~8s timeout each = 48s worst
// case for a single field). That assumed failures were rare blips. When
// proxy is the primary path, a slow/struggling proxy now takes 2x as long
// to fail through to the next one for every single request. Retry removed
// — single attempt per proxy, fall through immediately on any failure.
async function fetchProxy(url) {
  return _withProxySlot(async () => {
    let lastErr;
    for (const fn of PROXIES) {
      try {
        const r = await fetch(fn(url), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { lastErr = new Error('proxy HTTP ' + r.status); continue; }
        const txt = await r.text();
        try { const o = JSON.parse(txt); return o && o.contents !== undefined ? JSON.parse(o.contents) : o; }
        catch { return JSON.parse(txt); }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All proxies failed');
  });
}

async function fetchDirect(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchBinance(url) {
  return _coalesce(url, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const d = await r.json(); if (d && !d.code) return d; }
    } catch {}
    return fetchProxy(url);
  });
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

  // Attempt Binance batch ticker — single request covers all symbols.
  // syncOne() calls batchCrypto([s]) once per symbol in the staggered loop,
  // but they all hit this exact same URL — fetchBinance's in-flight
  // coalescing means only ONE real request/proxy hit happens per tick
  // regardless of how many symbols are mid-sync, instead of N.
  // Skip pairs known to be delisted from Binance (e.g. XMRUSDT removed Feb 2024)
  const binancePairs = pairs.filter(p => !BINANCE_DELISTED.has(p));
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr`;
    const data = await fetchBinance(url);
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

// ── Crypto market microstructure — BATCHED parallel fetch ──
// v12.9: replaces 5 sequential awaits (fetchOBI/CVD/MTF/fetch4hKlines/fetchDailyKlines)
// with 3 parallel requests fired via Promise.allSettled. Wall-clock time per symbol
// drops from ~5–8 s to ~1–2 s; CORS proxy fallbacks are isolated per-request so one
// failure never blocks the rest.
//
// Internal helpers (compute4hBias / computeDailyBias) kept private — only
// fetchCryptoExtra is exported to syncOne.

function _computeOBI(depthData) {
  if (!depthData?.bids?.length) return null;
  const bv = depthData.bids.reduce((s, x) => s + parseFloat(x[1]), 0);
  const av = depthData.asks.reduce((s, x) => s + parseFloat(x[1]), 0);
  const tot = bv + av;
  return { bidPct: (bv / tot * 100).toFixed(1), askPct: (av / tot * 100).toFixed(1), ratio: (bv / av).toFixed(2) };
}

function _computeCVDandMTF(klines15m) {
  if (!Array.isArray(klines15m) || klines15m.length < 10) return { cvd: null, mtf: [null, null, null] };
  let acc = 0;
  const series = klines15m.map(c => {
    const vol = parseFloat(c[5]), o = parseFloat(c[1]), cl = parseFloat(c[4]);
    acc += cl >= o ? vol : -vol;
    return acc;
  });
  const last = series.at(-1), prev5 = series.at(-6) ?? series[0];
  const cvd = { value: last, series: series.slice(-20), trending: last > prev5 ? 'up' : 'down' };

  // Derive MTF RSI from the same 15m bars — saves 2 extra round-trips vs old fetchMTF
  const closes = klines15m.map(c => parseFloat(c[4]));
  const mtf = [
    calcRSI(closes.slice(-20), 14),  // ~5h window  → 15m RSI proxy
    calcRSI(closes.slice(-30), 14),  // ~7.5h window → 1h RSI proxy
    calcRSI(closes,            14),  // full window  → 4h RSI proxy
  ];
  return { cvd, mtf };
}

function _compute4hBias(klines4h) {
  if (!Array.isArray(klines4h) || klines4h.length < 5) return null;
  const closes  = klines4h.map(c => parseFloat(c[4]));
  const volumes = klines4h.map(c => parseFloat(c[5]));
  const n = closes.length;
  const recentUp = closes[n - 1] > closes[n - 4];
  const volUp    = volumes[n - 1] > ((volumes[n - 2] + volumes[n - 3] + volumes[n - 4]) / 3);
  const rsi4h    = calcRSI(closes, 14);
  const k2 = 2 / (8 + 1); let ema8 = closes[0];
  for (let i = 1; i < n; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
  let cvd4h = 0;
  for (let i = n - 4; i < n; i++) { const o = parseFloat(klines4h[i][1]); cvd4h += closes[i] > o ? 1 : -1; }
  return { rsi4h, recentUp, volUp, aboveEma8: closes[n - 1] > ema8, cvd4h, lastClose: closes[n - 1], prevClose: closes[n - 4] };
}

function _computeDailyBias(klinesDay) {
  if (!Array.isArray(klinesDay) || klinesDay.length < 7) return null;
  const closes  = klinesDay.map(c => parseFloat(c[4]));
  const volumes = klinesDay.map(c => parseFloat(c[5]));
  const n = closes.length;
  const rsiDaily = calcRSI(closes, 14);
  const k2 = 2 / (7 + 1); let ema7 = closes[0];
  for (let i = 1; i < n; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
  const avgVol   = volumes.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1);
  const volSurge = volumes[n - 1] > avgVol * 1.5;
  const chg7d    = ((closes[n - 1] - closes[n - 7]) / closes[n - 7] * 100).toFixed(1);
  const chg1d    = closes[n - 2] > 0 ? parseFloat(((closes[n - 1] - closes[n - 2]) / closes[n - 2] * 100).toFixed(2)) : null;
  let cvdDaily = 0;
  for (let i = n - 7; i < n; i++) { const o = parseFloat(klinesDay[i][1]); cvdDaily += closes[i] > o ? 1 : -1; }
  const dailyBars = klinesDay.map(c => ({ h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]) }));
  return { rsiDaily, aboveEma7: closes[n - 1] > ema7, volSurge, chg7d: parseFloat(chg7d), chg1d, cvdDaily, _barsDay: dailyBars };
}

// ── TTL cache for slow-moving kline data ──
// 4h candles can't produce a meaningfully different bias inside a 15s
// resync window, and daily candles even less so. Re-requesting them on
// every syncOne() call was pure waste — half of fetchCryptoExtra's network
// load with zero signal benefit. Cached per-pair; depth + 15m klines
// (genuinely live: order book + CVD/MTF) are NOT cached and still fetch
// every call.
const _klineCache = new Map(); // key: `${pair}:${interval}` → { data, fetchedAt }
const KLINE_TTL = {
  k4h:  4  * 60 * 1000,  // 4 minutes — 4h candle has ~16 fresh closes/day, no need for 15s polling
  kDay: 15 * 60 * 1000,  // 15 minutes — daily candle changes meaningfully even less often
};

async function _fetchCached(pair, intervalKey, url) {
  const cacheKey = `${pair}:${intervalKey}`;
  const cached = _klineCache.get(cacheKey);
  const ttl = KLINE_TTL[intervalKey];
  if (cached && (Date.now() - cached.fetchedAt) < ttl) return cached.data;

  const data = await _fetchOneRaw(url);
  if (data) _klineCache.set(cacheKey, { data, fetchedAt: Date.now() });
  // On failure, fall back to stale cache rather than nothing — a slightly
  // old 4h/daily bias is far better than blanking the field out.
  return data ?? cached?.data ?? null;
}

// Helper: try direct first, fall back to proxy chain, coalescing in-flight
// duplicates — same pattern as fetchBinance but without the d.code check
// (klines/depth responses are arrays, not error objects).
async function _fetchOneRaw(url) {
  return _coalesce(url, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const d = await r.json(); if (d) return d; }
    } catch {}
    return fetchProxy(url);
  });
}

// Single entry-point: fires 2 LIVE Binance requests (depth, 15m klines) every
// call, plus 2 TTL-cached requests (4h, daily klines) that only actually hit
// the network when their cache has expired. Returns the same
// { obi, cvd, mtf, k4h, kDay } shape that syncOne / processAI already expect.
async function fetchCryptoExtra(pair) {
  const BASE = 'https://api.binance.com/api/v3';
  const urls = {
    depth:   `${BASE}/depth?symbol=${pair}&limit=20`,
    k15m:    `${BASE}/klines?symbol=${pair}&interval=15m&limit=60`,
    k4h:     `${BASE}/klines?symbol=${pair}&interval=4h&limit=20`,
    kDay:    `${BASE}/klines?symbol=${pair}&interval=1d&limit=14`,
  };

  // Fire all 4 in parallel — total wall-clock time = slowest single request.
  // depth/k15m always hit the network; k4h/kDay resolve instantly from
  // cache most cycles (cache miss only every 4min / 15min per pair).
  const [depth, k15m, k4h, kDay] = await Promise.allSettled([
    _fetchOneRaw(urls.depth),
    _fetchOneRaw(urls.k15m),
    _fetchCached(pair, 'k4h', urls.k4h),
    _fetchCached(pair, 'kDay', urls.kDay),
  ]);

  const val = r => r.status === 'fulfilled' ? r.value : null;

  const obi              = _computeOBI(val(depth));
  const { cvd, mtf }    = _computeCVDandMTF(val(k15m));
  const k4hBias          = _compute4hBias(val(k4h));
  const kDayBias         = _computeDailyBias(val(kDay));

  return { obi, cvd, mtf, k4h: k4hBias, kDay: kDayBias };
}

// ── Legacy single-endpoint stubs kept for any external callers ──
// (Not used by syncOne in v13.0 — fetchCryptoExtra replaces them all)
async function fetchOBI(pair) {
  const extra = await fetchCryptoExtra(pair);
  return extra.obi;
}
async function fetchCVD(pair) {
  const extra = await fetchCryptoExtra(pair);
  return extra.cvd;
}
async function fetchMTF(pair) {
  const extra = await fetchCryptoExtra(pair);
  return extra.mtf;
}
async function fetch4hKlines(pair) {
  const extra = await fetchCryptoExtra(pair);
  return extra.k4h;
}
async function fetchDailyKlines(pair) {
  const extra = await fetchCryptoExtra(pair);
  return extra.kDay;
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
    // ── Daily OHLC (interval=1440) — 20 bars — TTL cached, same as fetchCryptoExtra ──
    const dayUrl = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=1440&count=20`;
    const dayRaw = await _fetchCached(pair, 'kDay', dayUrl);
    // Kraken response: { error:[], result: { XMRUSD: [[time,o,h,l,c,vwap,vol,count], ...], last: N } }
    const dayKey = Object.keys(dayRaw?.result || {}).find(k => k !== 'last');
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

    // ── 4h OHLC (interval=240) — 20 bars — TTL cached, same as fetchCryptoExtra ──
    let k4h = null;
    try {
      const h4Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=240&count=20`;
      const h4Raw = await _fetchCached(pair, 'k4h', h4Url);
      const h4Key = Object.keys(h4Raw?.result || {}).find(k => k !== 'last');
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

    // ── MTF RSI + CVD — single 15m OHLC fetch shared by both ──
    // v13.0: previously fetched the same interval=15 series twice (once for
    // MTF at count=60, once for CVD at count=48) — pure duplication since
    // count=60 is a superset. One fetch now backs both calculations.
    let mtf = [null, null, null];
    let cvd = null;
    try {
      const m15Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=15&count=60`;
      const m15Raw = await _fetchOneRaw(m15Url);
      const m15Key = Object.keys(m15Raw?.result || {}).find(k => k !== 'last');
      if (m15Key) {
        const rows = m15Raw.result[m15Key];
        const m15Closes = rows.map(r => parseFloat(r[4]));
        const r15 = calcRSI(m15Closes.slice(-20),  14);
        const r1h = calcRSI(m15Closes.slice(-30),  14); // ~7.5h of 15m bars
        const r4h = calcRSI(m15Closes,             14); // full 15h window
        mtf = [r15, r1h, r4h];

        let cvdAcc = 0;
        const cvdSeries = rows.slice(-48).map(r => {
          const vol = parseFloat(r[6]), o = parseFloat(r[1]), c = parseFloat(r[4]);
          cvdAcc += c >= o ? vol : -vol;
          return cvdAcc;
        });
        const cvdLast = cvdSeries[cvdSeries.length - 1];
        const cvdPrev = cvdSeries[Math.max(0, cvdSeries.length - 6)];
        cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };
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
//   GOLD   → XAU/USD spot via stooq xauusd (Yahoo GC=F fallback)
//   SILVER → XAG/USD spot via stooq xagusd (Yahoo SI=F fallback)
//   DXY    → stooq dx-y.nyb (ICE DXY index, ~24h; Yahoo DX-Y.NYB fallback)
//   BONDS  → stooq ^tnx (10Y Treasury yield — more useful than TLT ETF price)
//   WTI    → Yahoo CL=F (stooq cl.f was returning stale/wrong prices)
//   BRENT  → Yahoo BZ=F (stooq lco.f was returning stale/wrong prices)
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
  { id: 'mp-GLD', sym: 'xauusd',   stooq: true,  yahoo: 'GC=F'      },   // Gold spot XAU/USD
  { id: 'mp-SLV', sym: 'xagusd',   stooq: true,  yahoo: 'SI=F'      },   // Silver spot XAG/USD
  { id: 'mp-UUP', sym: 'dx-y.nyb', stooq: true,  yahoo: 'DX-Y.NYB'  },   // ICE DXY index
  { id: 'mp-TLT', sym: '^tnx',     stooq: true,  yahoo: '%5ETNX'    },   // 10Y Treasury yield
  { id: 'mp-USO', sym: 'CL=F',     stooq: false, yahoo: 'CL=F'      },   // WTI crude — Yahoo primary (stooq cl.f stale)
  { id: 'mp-BRT', sym: 'BZ=F',     stooq: false, yahoo: 'BZ=F'      },   // Brent crude — Yahoo primary (stooq lco.f stale)
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
  // v13.0: routed through fetchBinance so this coalesces with any concurrent
  // batchCrypto() ticker/24hr call instead of firing a second one.
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr`;
    const data = await fetchBinance(url);
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
      // Fallback: Yahoo for any index/macro that Stooq misses
      const yahooMap = {
        '^spx':     '%5EGSPC',
        '^ndx':     '%5EIXIC',
        '^dji':     '%5EDJI',
        '^tnx':     '%5ETNX',
        'xauusd':   'GC=F',       // Gold spot → Yahoo gold futures (close enough)
        'xagusd':   'SI=F',       // Silver spot → Yahoo silver futures
        'dx-y.nyb': 'DX-Y.NYB',  // DXY index
      };
      const yTicker = pill.yahoo || yahooMap[pill.sym] || pill.sym;
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
