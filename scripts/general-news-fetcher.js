// ══════════════════════════════════════════════════════════════════════════════
// general-news-fetcher.js — server-side GNews.io poller
// --------------------------------------------------------------------------
// Runs inside the GitHub Actions job (Job A / "fetch" mode), where
// GNEWS_API_KEY is available as a real env var. The browser never sees the
// key — it only ever reads the committed scripts/general-news-data.json
// output file.
//
// Same rationale as sentiment-fetcher.js: the old client-side approach
// (js/general-news.js calling GNews directly with a key from env.js) never
// worked, because env.js is wiped back to blanks before that commit is ever
// served by GitHub Pages.
//
// Rate-limit gating: GNews free tier is 100 requests/day. Job A ("fetch"
// mode) runs every 5 min (288 runs/day), so we only actually call out once
// per ~30-minute window (matching the old client poll interval), keeping
// usage around ~48 requests/day.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

const OUT_PATH = path.join(process.cwd(), 'general-news-data.json');

const GNEWS_QUERY        = '"Iran" OR "White House" OR "Federal Reserve" OR "interest rate" OR "jobs report" OR crypto OR bitcoin';
const GNEWS_MAX_ARTICLES = 25;
const GNEWS_WINDOW_MIN   = 30; // only fetch once per this many minutes

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
  catch { return { fetchedAt: 0, items: [] }; }
}

function saveOutput(data) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
}

async function main() {
  const apiKey = process.env.GNEWS_API_KEY || '';
  const existing = loadExisting();

  if (!apiKey) {
    console.log('GNEWS_API_KEY not set — leaving general-news-data.json untouched');
    return;
  }

  const now = new Date();
  const minute = now.getUTCMinutes();
  if (minute % GNEWS_WINDOW_MIN >= 5) {
    console.log(`Minute ${minute} outside fetch window (every ${GNEWS_WINDOW_MIN}m, first 5m) — skipping (quota gate)`);
    return;
  }

  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(GNEWS_QUERY)}&lang=en&max=${GNEWS_MAX_ARTICLES}&sortby=publishedAt&token=${encodeURIComponent(apiKey)}`;

  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    data = await r.json();
  } catch (e) {
    console.log(`GNews fetch failed: ${e.message} — keeping cached items`);
    return;
  }

  if (data?.errors) {
    const msg = Array.isArray(data.errors) ? data.errors.join('; ') : String(data.errors);
    console.log(`GNews error: ${msg} — keeping cached items`);
    return;
  }

  const articles = Array.isArray(data.articles) ? data.articles : [];
  if (!articles.length) {
    console.log('GNews returned no articles — keeping cached items');
    return;
  }

  const items = articles.map(a => ({
    title:  a.title,
    url:    a.url,
    source: a.source?.name || 'GNews',
    time:   (() => { try { return new Date(a.publishedAt).toLocaleTimeString(); } catch { return ''; } })(),
  }));

  saveOutput({ fetchedAt: Date.now(), items });
  console.log(`General news: ${items.length} items`);
}

main().catch(e => { console.error('general-news-fetcher fatal error:', e); process.exit(0); });
