// ══════════════════════════════════════════════════════════════════════════════
// sentiment-fetcher.js — server-side Alpha Vantage NEWS_SENTIMENT poller
// --------------------------------------------------------------------------
// Runs inside the GitHub Actions job (Job A / "fetch" mode). Uses TWO separate
// Alpha Vantage API keys, each with its own independent 25/day quota:
//   AV_API_KEY       — watchlist ticker sentiment, ONE symbol per hourly run,
//                       round-robin through the watchlist (see below for why)
//   AV_API_KEY_NEWS  — general market news (topics=blockchain,financial_markets)
//
// IMPORTANT — why one ticker per call, not all of them combined: confirmed by
// manual testing against the live API that AV's `tickers=` param combines
// multiple values with AND logic, not OR. tickers=CRYPTO:BTC alone reliably
// returns dozens of articles; tickers=CRYPTO:BTC,CRYPTO:ETH,... (all at once)
// matched ZERO articles on every single run, because no article mentions all
// of the watchlist's symbols simultaneously. So each hourly run queries just
// the next symbol in rotation and merges its result into the accumulated
// bySymbol/items state (rather than overwriting it) — with N symbols and 24
// calls/day, each one refreshes roughly every N hours.
//
// The browser never sees either key — it only ever reads the committed
// scripts/sentiment-data.json output file.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

const WATCHLIST_PATH = path.join(process.cwd(), '..', 'watchlist.json');
const OUT_PATH        = path.join(process.cwd(), 'sentiment-data.json');

const AV_MAX_TICKERS      = 40; // headroom above a ~30-symbol mixed watchlist
const AV_MARKET_TOPICS    = 'blockchain,financial_markets';
const AV_BULLISH_THRESHOLD = 0.35;
const AV_BEARISH_THRESHOLD = -0.35;

// Alpha Vantage's NEWS_SENTIMENT crypto coverage is effectively limited to a
// small set of major coins. Mixing an unsupported small-cap ticker (e.g.
// RENDER, GALA, SUI, APT, IMX) into the same `tickers=` request appears to
// invalidate the ENTIRE request ("Invalid inputs..."), not just drop that
// one symbol. loadWatchlistTickers() below pre-filters crypto entries
// against this allowlist BEFORE ever calling the API, so unsupported alts
// never enter the request in the first place (and don't waste a call
// finding that out via a failed response).
const AV_KNOWN_GOOD_CRYPTO = ['BTC', 'ETH', 'DOGE', 'XRP', 'SOL', 'LINK', 'LTC', 'XMR'];

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
    return { avTicker: 'CRYPTO:' + base, displayBase: base, isCrypto: true };
  }
  const suffix = FOREIGN_SUFFIXES.find(s => sym.toUpperCase().endsWith(s));
  if (suffix) {
    const bare = sym.slice(0, sym.length - suffix.length);
    return { avTicker: bare, displayBase: sym, isCrypto: false };
  }
  // Bare US-style symbol (stock or ETF)
  return { avTicker: sym, displayBase: sym, isCrypto: false };
}

function _sentLabel(score) {
  if (score >= AV_BULLISH_THRESHOLD) return 'Bullish';
  if (score >= 0.15) return 'Somewhat-Bullish';
  if (score <= AV_BEARISH_THRESHOLD) return 'Bearish';
  if (score <= -0.15) return 'Somewhat-Bearish';
  return 'Neutral';
}

// Returns array of { avTicker, displayBase, isCrypto } across ALL asset
// types on the watchlist — stocks/ETFs pass through unfiltered; crypto is
// pre-filtered to AV_KNOWN_GOOD_CRYPTO, since mixing an unsupported
// small-cap coin (RENDER, GALA, SUI, APT, IMX, ...) into the same
// `tickers=` request appears to invalidate the ENTIRE request, not just
// drop that one symbol. Filtering here avoids wasting a call finding that out.
function loadWatchlistTickers() {
  try {
    const raw  = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    const mapped = list
      .map(toAvTicker)
      .filter(Boolean)
      .filter(t => {
        if (!t.isCrypto) return true; // stocks/ETFs always pass through
        const supported = AV_KNOWN_GOOD_CRYPTO.includes(t.displayBase);
        if (!supported) console.log(`  ⏭  ${t.displayBase} — not in AV_KNOWN_GOOD_CRYPTO, skipping (unsupported by AV NEWS_SENTIMENT)`);
        return supported;
      });
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
    return [{ avTicker: 'CRYPTO:BTC', displayBase: 'BTC', isCrypto: true }, { avTicker: 'CRYPTO:ETH', displayBase: 'ETH', isCrypto: true }];
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

async function avRequest(params, apiKey) {
  const url = `https://www.alphavantage.co/query?${params}&apikey=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  if (data?.Information || data?.Note || data?.['Error Message']) {
    throw new Error(data.Information || data.Note || data['Error Message']);
  }
  // Diagnostic: log the raw shape of the response (not the full payload —
  // that could be large) so we can tell "API call succeeded but genuinely
  // has 0 matching articles" apart from "something silently went wrong" in
  // the workflow logs, without needing to reproduce the issue locally.
  const feed = Array.isArray(data.feed) ? data.feed : [];
  console.log(`  ↳ AV response: feed=${feed.length} items, top-level keys=[${Object.keys(data).join(',')}]`);
  return feed;
}

async function main() {
  const tickerKey = process.env.AV_API_KEY      || '';
  const newsKey   = process.env.AV_API_KEY_NEWS || '';
  const existing  = loadExisting();

  const now = new Date();
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;

  let items          = existing.items || [];
  let bySymbol       = existing.bySymbol || {};
  let marketNewsItems = existing.marketNewsItems || [];
  let tickerFiredHourKey = existing.tickerFiredHourKey || null;
  let newsFiredHourKey   = existing.newsFiredHourKey   || null;

  // ── Watchlist ticker sentiment — own key, own hourly gate ──
  //
  // IMPORTANT: Alpha Vantage's `tickers=` filter combines multiple values
  // with AND logic, not OR — an article must mention ALL listed tickers
  // simultaneously to match. A single ticker (tickers=CRYPTO:BTC) reliably
  // returns plenty of articles; our old combined 7-ticker request
  // (tickers=CRYPTO:BTC,CRYPTO:ETH,...) matched essentially nothing, every
  // single run, because no article mentions all 7 coins at once. Confirmed
  // by manual testing against the live API.
  //
  // Fix: query ONE ticker per hourly run, round-robin through the
  // watchlist-derived list, and MERGE each result into the accumulated
  // bySymbol/items state rather than overwriting it. With N known-good
  // symbols and 24 calls/day, each symbol refreshes roughly every N hours
  // instead of getting zero data forever.
  let tickerRotationIndex = existing.tickerRotationIndex || 0;

  if (!tickerKey) {
    console.log('AV_API_KEY not set — skipping watchlist ticker sentiment');
  } else if (tickerFiredHourKey === hourKey) {
    console.log(`Ticker sentiment already fired for window ${hourKey} — skipping (quota gate)`);
  } else {
    const tickerEntries = loadWatchlistTickers();
    if (tickerEntries.length) {
      const rotationIndex = tickerRotationIndex % tickerEntries.length;
      const current = tickerEntries[rotationIndex];
      try {
        const timeFrom = new Date(Date.now() - 7 * 24 * 3600 * 1000)
          .toISOString().replace(/[-:]/g, '').slice(0, 13); // YYYYMMDDTHHMM
        const feed = await avRequest(`function=NEWS_SENTIMENT&tickers=${encodeURIComponent(current.avTicker)}&time_from=${timeFrom}&sort=LATEST&limit=50`, tickerKey);

        const newItems = feed.slice(0, 20).map(a => ({
          title:  a.title,
          url:    a.url,
          source: a.source || 'AlphaVantage',
          time:   new Date(parseTime(a.time_published)).toLocaleTimeString(),
          ts:     parseTime(a.time_published),
          score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
          label:  a.overall_sentiment_label || 'Neutral',
          tickerSentiments: Array.isArray(a.ticker_sentiment) ? a.ticker_sentiment : [],
        }));

        // Merge into accumulated headline feed, de-duped by URL, newest first
        const merged = [...newItems, ...items];
        const seenUrls = new Set();
        items = merged.filter(it => {
          if (seenUrls.has(it.url)) return false;
          seenUrls.add(it.url);
          return true;
        }).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);

        // Re-score just this cycle's symbol from its own articles, merge into bySymbol
        let weightSum = 0, scoreSum = 0, count = 0;
        for (const item of newItems) {
          const hit = item.tickerSentiments.find(t => t.ticker === current.avTicker);
          if (!hit) continue;
          const rel = parseFloat(hit.relevance_score) || 0;
          const sc  = parseFloat(hit.ticker_sentiment_score) || 0;
          weightSum += rel; scoreSum += sc * rel; count++;
        }
        if (count > 0) {
          const avgScore = weightSum > 0 ? scoreSum / weightSum : 0;
          bySymbol[current.displayBase] = { score: avgScore, label: _sentLabel(avgScore), count };
        }

        tickerFiredHourKey = hourKey;
        console.log(`Sentiment: ${current.displayBase} (${rotationIndex + 1}/${tickerEntries.length} in rotation) — ${newItems.length} article(s), ${count} tagged`);
      } catch (e) {
        console.log(`Sentiment fetch failed for ${current.displayBase}: ${e.message} — keeping cached items`);
        tickerFiredHourKey = hourKey; // still advance rotation past this symbol
      }
      tickerRotationIndex = (rotationIndex + 1) % tickerEntries.length;
    }
  }

  // ── Watchlist-independent general market news — separate key, own hourly gate ──
  if (!newsKey) {
    console.log('AV_API_KEY_NEWS not set — skipping general market news');
  } else if (newsFiredHourKey === hourKey) {
    console.log(`General market news already fired for window ${hourKey} — skipping (quota gate)`);
  } else {
    try {
      const feed = await avRequest(`function=NEWS_SENTIMENT&topics=${encodeURIComponent(AV_MARKET_TOPICS)}&limit=50`, newsKey);
      marketNewsItems = feed.slice(0, 30).map(a => ({
        title:  a.title,
        url:    a.url,
        source: a.source || 'AlphaVantage',
        time:   new Date(parseTime(a.time_published)).toLocaleTimeString(),
        score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
        label:  a.overall_sentiment_label || 'Neutral',
      }));
      newsFiredHourKey = hourKey;
      console.log(`Market news: ${marketNewsItems.length} items`);
    } catch (e) {
      console.log(`Market news fetch failed: ${e.message} — keeping cached items`);
    }
  }

  saveOutput({
    fetchedAt: Date.now(), items, bySymbol, marketNewsItems,
    tickerFiredHourKey, newsFiredHourKey, tickerRotationIndex,
  });
}

main().catch(e => { console.error('sentiment-fetcher fatal error:', e); process.exit(0); });
