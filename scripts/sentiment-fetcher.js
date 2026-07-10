// ══════════════════════════════════════════════════════════════════════════════
// sentiment-fetcher.js — server-side Alpha Vantage NEWS_SENTIMENT poller
// --------------------------------------------------------------------------
// Runs inside the GitHub Actions job (Job A / "fetch" mode), where AV_API_KEY
// is available as a real env var. The browser never sees the key — it only
// ever reads the committed scripts/sentiment-data.json output file.
//
// Replaces the old client-side approach (js/sentiment.js calling Alpha
// Vantage directly using a key injected into env.js). That approach never
// actually worked from the browser: env.js is wiped back to blanks and
// committed BEFORE GitHub Pages ever serves the new commit, so
// window.__AV_KEY was always ''.
//
// Rate-limit gating: Alpha Vantage free tier is ~25 requests/day, and this
// script makes 2 calls per run (watchlist tickers + general market topics).
// We only actually call out during the same clustered UTC hours the old
// client-side poller used (7 windows/day × 2 calls = 14/day, safely under
// quota). Outside those hours this is a fast no-op that leaves the existing
// sentiment-data.json untouched.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

const WATCHLIST_PATH = path.join(process.cwd(), '..', 'watchlist.json');
const OUT_PATH        = path.join(process.cwd(), 'sentiment-data.json');

const AV_POLL_HOURS_UTC   = [0, 1, 6, 8, 12, 13, 16, 18, 20, 21, 22, 23];
const AV_MAX_TICKERS      = 40; // headroom above a ~30-symbol mixed watchlist
const AV_MARKET_TOPICS    = 'blockchain,financial_markets';
const AV_BULLISH_THRESHOLD = 0.35;
const AV_BEARISH_THRESHOLD = -0.35;

// Exchange suffixes used elsewhere in the repo (exchange-registry.js) for
// non-US listings. AV's NEWS_SENTIMENT ticker coverage is effectively
// US-equity + crypto + forex — it does not recognize these suffixes, so we
// strip them and pass the bare symbol as a best-effort match. Foreign-listed
// names (TSX/LSE/XETRA/TSE/HKEX/NSE) will often still return zero ticker
// hits since AV likely has no sentiment coverage for that specific listing —
// that's an AV data-coverage gap, not a bug in this script.
const FOREIGN_SUFFIXES = ['.TO', '.L', '.DE', '.T', '.HK', '.NS'];

// ── Build the AV `tickers=` value for one watchlist symbol ──
// Returns { avTicker, displayBase } or null if the symbol can't be mapped.
//   crypto  BINANCE:BTCUSDT  → CRYPTO:BTC        (display: BTC)
//   US eq   AAPL             → AAPL              (display: AAPL)
//   foreign SHOP.TO          → SHOP (best effort) (display: SHOP.TO)
function toAvTicker(sym) {
  if (sym.startsWith('BINANCE:')) {
    const base = sym.replace('BINANCE:', '').replace(/USDT?$/, '');
    return { avTicker: 'CRYPTO:' + base, displayBase: base };
  }
  const suffix = FOREIGN_SUFFIXES.find(s => sym.toUpperCase().endsWith(s));
  if (suffix) {
    const bare = sym.slice(0, sym.length - suffix.length);
    return { avTicker: bare, displayBase: sym };
  }
  // Bare US-style symbol (stock or ETF)
  return { avTicker: sym, displayBase: sym };
}

function _sentLabel(score) {
  if (score >= AV_BULLISH_THRESHOLD) return 'Bullish';
  if (score >= 0.15) return 'Somewhat-Bullish';
  if (score <= AV_BEARISH_THRESHOLD) return 'Bearish';
  if (score <= -0.15) return 'Somewhat-Bearish';
  return 'Neutral';
}

// Returns array of { avTicker, displayBase } across ALL asset types on the
// watchlist (crypto, stocks, ETFs) — not just BINANCE: crypto pairs.
function loadWatchlistTickers() {
  try {
    const raw  = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    const mapped = list.map(toAvTicker).filter(Boolean);
    // De-dupe by avTicker (two watchlist entries could collapse to the same one)
    const seen = new Set();
    const deduped = [];
    for (const m of mapped) {
      if (seen.has(m.avTicker)) continue;
      seen.add(m.avTicker);
      deduped.push(m);
    }
    return deduped.slice(0, AV_MAX_TICKERS);
  } catch {
    return [{ avTicker: 'CRYPTO:BTC', displayBase: 'BTC' }, { avTicker: 'CRYPTO:ETH', displayBase: 'ETH' }];
  }
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
  catch { return { fetchedAt: 0, items: [], bySymbol: {}, marketNewsItems: [] }; }
}

function saveOutput(data) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
}

function parseTime(raw) {
  try {
    return new Date(raw.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6'
    )).getTime();
  } catch { return 0; }
}

async function avRequest(params) {
  const url = `https://www.alphavantage.co/query?${params}&apikey=${encodeURIComponent(process.env.AV_API_KEY)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  if (data?.Information || data?.Note || data?.['Error Message']) {
    throw new Error(data.Information || data.Note || data['Error Message']);
  }
  return Array.isArray(data.feed) ? data.feed : [];
}

async function main() {
  const apiKey = process.env.AV_API_KEY || '';
  const existing = loadExisting();

  if (!apiKey) {
    console.log('AV_API_KEY not set — leaving sentiment-data.json untouched');
    return;
  }

  const now = new Date();
  const hour = now.getUTCHours();
  if (!AV_POLL_HOURS_UTC.includes(hour)) {
    console.log(`UTC hour ${hour} not in poll window ${JSON.stringify(AV_POLL_HOURS_UTC)} — skipping (quota gate)`);
    return;
  }

  // Job A runs every 5 min, so a bare hour-of-day check alone would fire
  // ~12 times within the same allowed hour. Persist which hour-slot we've
  // already fired so each window only ever costs 2 calls, not up to 24.
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${hour}`;
  if (existing.lastFiredHourKey === hourKey) {
    console.log(`Already fired for window ${hourKey} — skipping (quota gate)`);
    return;
  }

  const tickerEntries = loadWatchlistTickers();
  let items = existing.items || [];
  let bySymbol = existing.bySymbol || {};
  let marketNewsItems = existing.marketNewsItems || [];

  // ── Watchlist ticker sentiment (crypto + stocks + ETFs) ──
  if (tickerEntries.length) {
    try {
      const tickers = tickerEntries.map(t => t.avTicker).join(',');
      const feed = await avRequest(`function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&limit=50`);
      items = feed.slice(0, 40).map(a => ({
        title:  a.title,
        url:    a.url,
        source: a.source || 'AlphaVantage',
        time:   new Date(parseTime(a.time_published)).toLocaleTimeString(),
        ts:     parseTime(a.time_published),
        score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
        label:  a.overall_sentiment_label || 'Neutral',
        tickerSentiments: Array.isArray(a.ticker_sentiment) ? a.ticker_sentiment : [],
      }));

      const next = {};
      for (const { avTicker, displayBase } of tickerEntries) {
        let weightSum = 0, scoreSum = 0, count = 0;
        for (const item of items) {
          const hit = item.tickerSentiments.find(t => t.ticker === avTicker);
          if (!hit) continue;
          const rel = parseFloat(hit.relevance_score) || 0;
          const sc  = parseFloat(hit.ticker_sentiment_score) || 0;
          weightSum += rel; scoreSum += sc * rel; count++;
        }
        if (count > 0) {
          const avgScore = weightSum > 0 ? scoreSum / weightSum : 0;
          next[displayBase] = { score: avgScore, label: _sentLabel(avgScore), count };
        }
      }
      bySymbol = next;
      console.log(`Sentiment: ${items.length} items, ${Object.keys(bySymbol).length}/${tickerEntries.length} symbols scored`);
    } catch (e) {
      console.log(`Sentiment fetch failed: ${e.message} — keeping cached items`);
    }
  }

  // ── Watchlist-independent general market news ──
  try {
    const feed = await avRequest(`function=NEWS_SENTIMENT&topics=${encodeURIComponent(AV_MARKET_TOPICS)}&limit=50`);
    marketNewsItems = feed.slice(0, 30).map(a => ({
      title:  a.title,
      url:    a.url,
      source: a.source || 'AlphaVantage',
      time:   new Date(parseTime(a.time_published)).toLocaleTimeString(),
      score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
      label:  a.overall_sentiment_label || 'Neutral',
    }));
    console.log(`Market news: ${marketNewsItems.length} items`);
  } catch (e) {
    console.log(`Market news fetch failed: ${e.message} — keeping cached items`);
  }

  saveOutput({ fetchedAt: Date.now(), items, bySymbol, marketNewsItems, lastFiredHourKey: hourKey });
}

main().catch(e => { console.error('sentiment-fetcher fatal error:', e); process.exit(0); });
