// ══════════════════════════════════════════════════════════════════════════════
// market-intelligence.js — dashboard reader for scripts/market-state.json
// ------------------------------------------------------------------------------
// READ-ONLY. Never writes anything, never trades, never touches positions.json.
// scripts/market-state.json is written by market-fetcher.js every Job A cycle
// (~5 min), via computeMarketState() in scripts/market-intelligence.js — the
// v15 design doc's Market Intelligence Engine. This module just polls that
// committed file the same way sentiment.js / general-news.js already do
// (raw.githubusercontent.com, bypassing GitHub Pages' CDN cache) and renders:
//   - the header "🧠" pill (BTC Risk Score + regime, always visible)
//   - the MARKET INTEL tile row in #mi-panel (breadth + top-mover momentum)
// ══════════════════════════════════════════════════════════════════════════════

// Uses the same repo-detection logic as position-tracker.js / alerts.js's
// _deriveRepo() (window.__GH_REPO → saved sync config → auto-detect from
// the GitHub Pages hostname/path). NOT hardcoded to a single repo, since
// this file is shared across every Alpha Terminal instance (alpha, test2,
// etc.) — hardcoding one repo here silently pointed every OTHER instance's
// Market Intel panel at the wrong repo's market-state.json.
const MI_DATA_REPO   = () => (typeof _deriveRepo === 'function' ? _deriveRepo() : (window.__GH_REPO || ''));
const MI_DATA_BRANCH = 'main';
const MI_DATA_PATH   = 'scripts/market-state.json';
const MI_POLL_MS     = 60_000; // market-state.json only updates every ~5min (Job A cadence) — poll well under that

window.MI_PAUSED = false;
let _miCache = null;

function toggleMiPause() {
  window.MI_PAUSED = !window.MI_PAUSED;
  if (!window.MI_PAUSED) fetchMarketIntelligence();
}

async function fetchMarketIntelligence() {
  if (window.MI_PAUSED) return;
  const repo = MI_DATA_REPO();
  if (!repo) { renderMarketIntelligence(null, 'GitHub repo not configured — set GH_REPO in sync settings.'); return; }

  const url = `https://raw.githubusercontent.com/${repo}/${MI_DATA_BRANCH}/${MI_DATA_PATH}?t=${Date.now()}`;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { renderMarketIntelligence(null, 'market-state.json not found yet — waiting for first Job A run.'); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _miCache = data;
    renderMarketIntelligence(data);
  } catch (e) {
    // Keep showing the last good read rather than blanking the panel on a
    // transient network hiccup — same philosophy as sentiment.js's cache fallback.
    if (_miCache) renderMarketIntelligence(_miCache, `(stale — last fetch failed: ${e.message})`);
    else renderMarketIntelligence(null, `Fetch failed: ${e.message}`);
  }
}

function _bandColor(band) {
  return band === 'BUY'    ? 'var(--bull)'
       : band === 'REDUCE' ? '#ffa500'
       : band === 'WATCH'  ? '#ff8c00'
       : band === 'BLOCK'  ? 'var(--bear)'
       : '#888';
}
function _regimeColor(regime) {
  return regime === 'RISK_ON' ? 'var(--bull)' : regime === 'RISK_OFF' ? 'var(--bear)' : '#aaa';
}
function _trendColor(trend) {
  return trend === 'ACCELERATING' ? 'var(--bull)' : trend === 'FADING' ? 'var(--bear)' : '#888';
}

function renderMarketIntelligence(data, note) {
  const pill = document.getElementById('mi-pill');
  const btcTile     = document.getElementById('mi-btcrisk');
  const regimeTile  = document.getElementById('mi-regime');
  const breadthTile = document.getElementById('mi-breadth');
  const symbolsEl   = document.getElementById('mi-symbols');
  const updatedEl   = document.getElementById('mi-updated');

  if (!data || data.btcRiskScore == null) {
    if (pill) { pill.textContent = '🧠 —'; pill.style.background = 'rgba(100,100,100,.2)'; pill.style.color = '#888'; pill.title = note || 'No data yet'; }
    if (updatedEl) updatedEl.textContent = note || 'NO DATA';
    return;
  }

  const bandColor   = _bandColor(data.btcRiskBand);
  const regimeColor = _regimeColor(data.marketRegime);

  // ── Header pill ──
  if (pill) {
    pill.textContent = `🧠 ${data.btcRiskScore} · ${data.btcRiskBand}`;
    pill.style.background = data.btcRiskBand === 'BUY' ? 'var(--bull-dim)'
                           : data.btcRiskBand === 'BLOCK' ? 'var(--bear-dim)'
                           : 'rgba(255,140,0,.15)';
    pill.style.color = bandColor;
    pill.title = `BTC Risk ${data.btcRiskScore}/100 (${data.btcRiskBand}) · Regime ${data.marketRegime} · Breadth ${data.breadth?.score ?? '—'}%`;
  }

  // ── Tile row ──
  if (btcTile) {
    btcTile.querySelector('.mp-tile-val').textContent = data.btcRiskScore;
    btcTile.querySelector('.mp-tile-val').style.color = bandColor;
    const chg = btcTile.querySelector('.mp-tile-chg');
    chg.textContent = data.btcRiskBand;
    chg.style.color = bandColor;
  }
  if (regimeTile) {
    regimeTile.querySelector('.mp-tile-val').textContent = data.marketRegime;
    regimeTile.querySelector('.mp-tile-val').style.color = regimeColor;
    regimeTile.querySelector('.mp-tile-chg').textContent = '';
  }
  if (breadthTile) {
    const score = data.breadth?.score;
    const mom   = data.breadthMomentum;
    breadthTile.querySelector('.mp-tile-val').textContent = score != null ? score + '%' : '—';
    breadthTile.querySelector('.mp-tile-val').style.color = score != null ? (score >= 60 ? 'var(--bull)' : score <= 35 ? 'var(--bear)' : '#aaa') : '#888';
    const chg = breadthTile.querySelector('.mp-tile-chg');
    chg.textContent = mom ? `${mom.delta >= 0 ? '+' : ''}${mom.delta} (${mom.trend})` : '—';
    chg.style.color = _trendColor(mom?.trend);
    chg.classList.remove('flat');
  }

  // ── Top movers strip — symbols with the strongest momentum slope this cycle ──
  if (symbolsEl) {
    const syms = Object.entries(data.symbols || {})
      .filter(([, s]) => s.momentumSlope != null)
      .sort((a, b) => Math.abs(b[1].momentumSlope) - Math.abs(a[1].momentumSlope))
      .slice(0, 8);
    symbolsEl.innerHTML = syms.length ? syms.map(([sym, s]) => {
      const base = sym.replace('USDT', '');
      const mColor = s.momentumSlope > 0 ? 'var(--bull)' : s.momentumSlope < 0 ? 'var(--bear)' : '#888';
      return `<span title="CVD: ${s.cvdMomentum?.trend || '—'} · OI(proxy): ${s.oiMomentum?.trend || '—'} · Whale: ${s.whaleMomentum?.trend || '—'} · Setup persistence: ${s.setupPersistence} cycles">
        <b style="color:${mColor};">${base}</b> ${s.momentumSlope > 0 ? '▲' : s.momentumSlope < 0 ? '▼' : '·'}${Math.abs(s.momentumSlope).toFixed(2)}%
      </span>`;
    }).join('') : '<span>No per-symbol history yet</span>';
  }

  if (updatedEl) {
    const ageMin = data.fetchedAt ? Math.round((Date.now() - data.fetchedAt) / 60000) : null;
    updatedEl.textContent = note ? note : (ageMin != null ? `Updated ${ageMin}min ago` : '—');
  }
}
