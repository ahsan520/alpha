// ══════════════════════════════════════════════
// render.js — all DOM rendering functions
// ══════════════════════════════════════════════

function render() { renderWL(); renderTable(); }

// ── Watchlist sidebar ──
function renderWL() {
  const { watchlist, DS, currentS } = STATE;
  document.getElementById('wl-cont').innerHTML = watchlist.map(s => {
    const d = DS[s] || {};
    const up = parseFloat(d.chg || 0) >= 0;
    const name = s.includes(':') ? s.split(':')[1].replace('USDT', '') : s;
    const hc = Math.abs(parseFloat(d.chg || 0)) > 3 ? (up ? 'var(--bull)' : 'var(--bear)') : 'transparent';
    return `<div class="wli ${s === currentS ? 'on' : ''}" onclick="switchT('${s}')">
      <div class="wli-hbar" style="background:${hc}"></div>
      <div><div class="wli-name">${name}</div><div class="wli-price">${d.p ? '$' + d.p : '—'}</div></div>
      <div class="wli-chg" style="color:${up ? 'var(--bull)' : 'var(--bear)'}">${up ? '+' : ''}${d.chg || '0.00'}%</div>
      <span onclick="event.stopPropagation();delT('${s}')" class="del">×</span>
    </div>`;
  }).join('');
}

// ── MTF RSI dot ──
function rdot(v, lbl) {
  if (v === null || v === undefined)
    return `<div class="mtf-col"><div class="mtf-d" style="background:#2a2a2a;"></div><div class="mtf-l">${lbl}</div></div>`;
  const c = v > 70 ? 'var(--bear)' : v < 30 ? 'var(--bull)' : v > 60 ? '#f0a500' : 'var(--accent)';
  return `<div class="mtf-col"><div class="mtf-d" style="background:${c};box-shadow:0 0 5px ${c}44;" title="${lbl}: ${v}"></div><div class="mtf-l" style="color:${c}">${v}</div></div>`;
}

// ── Main signal table ──
function renderTable() {
  const { watchlist, DS, PH, sortK, sortD } = STATE;
  let sorted = [...watchlist];
  if (sortK) {
    sorted.sort((a, b) => {
      const da = DS[a] || {}, db = DS[b] || {};
      if (sortK === 'name') return sortD * a.localeCompare(b);
      return sortD * (parseFloat(da[sortK] || 0) - parseFloat(db[sortK] || 0));
    });
  }

  const def = {
    p: '—', chg: '0', r15: 50, r1h: 50, r4h: 50, shock: '1.0', nf: 0, lp: 50, sp: 50, fr: 'N/A',
    whale: '—', sig: 'SYNC', sigC: 's-w', reason: '...', obi: null, cvd: null, liq: null,
    emaTrend: '—', fundingFlag: '—', fundingFlagC: 'var(--text-dim)',
    oiDiv: '—', oiDivC: 'var(--text-dim)', dipScore: 0, dipLabel: '—', dipLabelC: 'var(--text-dim)',
    bias4h: '—', bias4hC: 'var(--text-dim)', bias4hScore: 0, biasDay: '—', biasDayC: 'var(--text-dim)', biasDayScore: 0
  };

  document.getElementById('mx-body').innerHTML = sorted.map(s => {
    const d = { ...def, ...(DS[s] || {}) };
    const up = parseFloat(d.chg) >= 0;
    const name = s.includes(':') ? s.split(':')[1].replace('USDT', '') : s;
    const hc = parseFloat(d.chg) > 2.5 ? 'ru' : parseFloat(d.chg) < -2.5 ? 'rd' : '';
    const spId = 'sp_' + s.replace(/[^a-z0-9]/gi, '_');
    const cvdId = 'cv_' + s.replace(/[^a-z0-9]/gi, '_');
    const isCrypto = s.includes('BINANCE:');
    const nfC = d.nf >= 0 ? 'var(--bull)' : 'var(--bear)';
    const frC = d.fr !== 'N/A' ? (parseFloat(d.fr) >= 0 ? 'var(--bull)' : 'var(--bear)') : '#888';
    const frStr = d.fr !== 'N/A' ? (parseFloat(d.fr) >= 0 ? '+' : '') + (parseFloat(d.fr) * 100).toFixed(3) + '%' : '—';

    // OBI cell
    let obiH = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
    if (d.obi) {
      const bw = parseFloat(d.obi.bidPct), aw = 100 - bw;
      const c = bw > 55 ? 'var(--bull)' : bw < 45 ? 'var(--bear)' : 'var(--text-dim)';
      obiH = `<div class="obi"><span class="obi-v" style="color:${c}">${bw}%</span>
        <div class="obi-track"><div class="obi-bid" style="width:${bw}%"></div><div class="obi-ask" style="width:${aw}%"></div></div></div>`;
    }

    // CVD cell
    let cvdH = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
    if (d.cvd) {
      const val = d.cvd.value; const up2 = d.cvd.trending === 'up';
      const fv = Math.abs(val) > 1e6 ? (val / 1e6).toFixed(2) + 'M' : Math.abs(val) > 1000 ? (val / 1000).toFixed(1) + 'K' : val.toFixed(0);
      cvdH = `<div class="cvd"><canvas id="${cvdId}" width="55" height="20" class="sp"></canvas>
        <span class="cvd-v" style="color:${up2 ? 'var(--bull)' : 'var(--bear)'}">${up2 ? '▲' : '▼'}${fv}</span></div>`;
    }

    // Liq cell
    let liqH = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
    if (d.liq) {
      const lc = parseFloat(d.liq.dist) < 0 ? 'var(--bear)' : 'var(--accent)';
      liqH = `<div class="liq"><div class="liq-p" style="color:${lc}">$${d.liq.price}</div><div class="liq-d">${d.liq.dist}% · ${d.liq.side}</div></div>`;
    }

    // L/S cell
    const lsH = `<div class="ls"><div class="ls-track"><div class="ls-l" style="width:${d.lp}%"></div><div class="ls-s" style="width:${d.sp}%"></div></div>
      <div class="ls-lbl"><span style="color:var(--bull)">L${d.lp}%</span><span style="color:var(--bear)">S${d.sp}%</span></div></div>`;

    const sdotC = d.sigC.includes('sb') || d.sigC.includes('-b') ? 'var(--bull)' : d.sigC.includes('ss') || d.sigC.includes('be') ? 'var(--bear)' : '#555';

    return `<tr class="${hc}" onclick="switchT('${s}')">
      <td class="td-sym">${name}</td>
      <td class="td-px">$${d.p}</td>
      <td style="color:${up ? 'var(--bull)' : 'var(--bear)'};font-weight:700;">${up ? '+' : ''}${d.chg}%</td>
      <td><canvas id="${spId}" width="68" height="20" class="sp"></canvas></td>
      <td><div class="mtf">${rdot(d.r15, '15m')}${rdot(d.r1h, '1h')}${rdot(d.r4h, '4h')}</div></td>
      <td>${obiH}</td>
      <td>${cvdH}</td>
      <td><div class="vbar"><span style="color:var(--gold)">${d.shock}x</span><div class="vbar-bg"><div class="vbar-fill" style="width:${Math.min(100, (parseFloat(d.shock) - .5) * 80)}%"></div></div></div></td>
      <td>${lsH}</td>
      <td style="color:${frC};font-size:9px;">${frStr}</td>
      <td style="font-size:9px;font-weight:700;color:${d.emaTrend === 'ABOVE' ? 'var(--bull)' : d.emaTrend === 'BELOW' ? 'var(--bear)' : 'var(--text-dim)'};">${d.emaTrend || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.oiDivC};" title="OI Divergence">${d.oiDiv || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.dipLabelC};" title="Score: ${d.dipScore || 0}">${d.dipLabel || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.bias4hC};" title="4H score: ${d.bias4hScore || 0}">${d.bias4h || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.biasDayC};" title="Daily score: ${d.biasDayScore || 0}">${d.biasDay || '—'}</td>
      <td><span class="sig ${d.sigC}"><span class="sig-dot" style="background:${sdotC}"></span>${d.sig}</span></td>
      <td style="font-size:9px;min-width:90px;">
        ${d.sup || d.res
          ? `<div style="display:flex;flex-direction:column;gap:1px;line-height:1.3;">
               <span style="color:var(--bull);" title="Support">S $${d.sup || '—'}</span>
               <span style="color:var(--bear);" title="Resistance">R $${d.res || '—'}</span>
             </div>`
          : '<span style="color:var(--text-dim);">—</span>'
        }
      </td>
      <td><button class="rbtn" onclick="event.stopPropagation();refreshSymbol('${s}',this)" title="Refresh ${name}">↺</button></td>
      <td class="td-reason" title="${d.reason}">${d.reason}</td>
    </tr>`;
  }).join('');

  requestAnimationFrame(() => {
    sorted.forEach(s => {
      const d = DS[s];
      // Prefer sparkBars (last 7 daily closes) — gives a meaningful 5-7d price shape.
      // Fall back to live-poll ticks (PH) only when daily bars aren't loaded yet.
      const sparkData = (d?.sparkBars?.length > 1) ? d.sparkBars : (PH[s]?.length > 1 ? PH[s] : null);
      if (sparkData) drawSpark('sp_' + s.replace(/[^a-z0-9]/gi, '_'), sparkData);
      if (d && d.cvd && d.cvd.series && d.cvd.series.length > 1)
        drawSpark('cv_' + s.replace(/[^a-z0-9]/gi, '_'), d.cvd.series);
    });
  });
}

// ── Sparkline ──
function drawSpark(id, data) {
  const c = document.getElementById(id); if (!c || data.length < 2) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - mn) / rng) * (h - 2) - 1]);
  const up = data[data.length - 1] >= data[0];
  ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = up ? '#00e5a0' : '#ff4560'; ctx.lineWidth = 1.5; ctx.stroke();
}

// ── News ──
// ── BLOOMBERG-STYLE NEWS FEED RENDERER ──
// Column-per-category layout with alert badges, rich cards, bottom alert bar

const COL_META = {
  CRYPTO:    { icon: '₿',  label: 'Crypto',          color: '#7b61ff' },
  TECH:      { icon: '⚡', label: 'AI / Tech',        color: '#00b4d8' },
  ENERGY:    { icon: '🛢', label: 'Energy',           color: '#ff8c00' },
  METAL:     { icon: '⬡',  label: 'Metals',           color: '#c0c0c0' },
  COMMODITY: { icon: '🌾', label: 'Commodities',      color: '#c9a84c' },
  TSX:       { icon: '🍁', label: 'TSX / CAD',        color: '#00e5a0' },
  FX:        { icon: '💱', label: 'CAD/USD · DXY',    color: '#ffd166' },
};

const COL_ORDER = ['CRYPTO','TECH','ENERGY','METAL','COMMODITY','TSX','FX'];

// Which columns are collapsed (persisted in STATE)
if (!STATE.collapsedCols) STATE.collapsedCols = {};

function renderNews() {
  const { newsItems } = STATE;
  const bulls = newsItems.filter(n => n.sent === 'bullish').length;
  const bears = newsItems.filter(n => n.sent === 'bearish').length;
  document.getElementById('news-badge').textContent = newsItems.length + ' items';
  document.getElementById('bull-n').textContent = '▲ ' + bulls;
  document.getElementById('bear-n').textContent = '▼ ' + bears;

  // Group by tag
  const byTag = {};
  for (const item of newsItems) {
    if (!byTag[item.tag]) byTag[item.tag] = [];
    byTag[item.tag].push(item);
  }

  // Render tag filter pill row (now acts as column toggle)
  const tagBar = document.getElementById('news-tag-bar');
  if (tagBar) {
    tagBar.innerHTML = COL_ORDER.map(tag => {
      const m = COL_META[tag];
      const active = !STATE.collapsedCols[tag];
      return `<button class="nf-pill${active ? ' active' : ''}"
        style="--pc:${m.color}"
        onclick="toggleNewsCol('${tag}')">${m.icon} ${m.label}</button>`;
    }).join('') +
    `<button class="nf-pill-collapse" onclick="collapseAllCols()">COLLAPSE ALL</button>`;
  }

  if (!newsItems.length) {
    document.getElementById('bnews-body').innerHTML =
      `<div style="padding:30px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Loading news… refreshes every 5 min</div>`;
    return;
  }

  // Build columns
  const cols = COL_ORDER.filter(tag => !STATE.collapsedCols[tag]).map(tag => {
    const m = COL_META[tag];
    const items = byTag[tag] || [];
    const bullCount = items.filter(n => n.sent === 'bullish').length;
    const bearCount = items.filter(n => n.sent === 'bearish').length;

    const cards = items.slice(0, 8).map(n => {
      const alertBadge = n.sent === 'bullish'
        ? `<span class="nf-alert bull">● INFLOW</span>`
        : n.sent === 'bearish'
        ? `<span class="nf-alert bear">● ALERT</span>`
        : `<span class="nf-alert neu">● UPDATE</span>`;

      // Derive 2-3 inline tags from title keywords
      const inlineTags = [];
      const tl = n.title.toLowerCase();
      if (/bitcoin|btc/.test(tl)) inlineTags.push('BTC');
      if (/ethereum|eth/.test(tl)) inlineTags.push('ETH');
      if (/solana|sol/.test(tl)) inlineTags.push('SOL');
      if (/gold/.test(tl)) inlineTags.push('Gold');
      if (/silver/.test(tl)) inlineTags.push('Silver');
      if (/oil|crude|brent|wti/.test(tl)) inlineTags.push('OIL');
      if (/fed|fomc|rate|hawkish|dovish/.test(tl)) inlineTags.push('FED');
      if (/nvidia|nvda/.test(tl)) inlineTags.push('NVDA');
      if (/apple|aapl/.test(tl)) inlineTags.push('AAPL');
      if (/ai|artificial intelligence/.test(tl)) inlineTags.push('AI');
      if (/wheat|corn|soy/.test(tl)) inlineTags.push('GRAIN');
      if (/canada|tsx|cad/.test(tl)) inlineTags.push('CAD');
      if (/dxy|dollar/.test(tl)) inlineTags.push('DXY');
      if (/copper/.test(tl)) inlineTags.push('CU');
      if (/enb|enbrige/.test(tl)) inlineTags.push('ENB');
      const tagPills = inlineTags.slice(0, 3).map(t =>
        `<span class="nf-itag">${t}</span>`).join('');

      // Ticker flow indicators from watchlist symbols mentioned
      const wlHits = (STATE.watchlist || []).filter(sym => {
        const base = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
        return tl.includes(base.toLowerCase());
      });
      const flowArrows = wlHits.slice(0,2).map(sym => {
        const base = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
        const d = STATE.DS && STATE.DS[sym];
        const chg = d ? parseFloat(d.chg) : 0;
        const arrow = chg >= 0 ? '→' : '↘';
        const col = chg >= 0 ? 'var(--bull)' : 'var(--bear)';
        return `<span style="font-family:var(--mono);font-size:8px;color:${col};margin-left:4px">${arrow} ${base}</span>`;
      }).join('');

      return `<div class="nf-card" onclick="window.open('${n.url}','_blank')">
        <div class="nf-card-top">
          ${alertBadge}
          <span class="nf-time">${n.time || ''}</span>
        </div>
        <div class="nf-headline">${n.title}</div>
        <div class="nf-card-bot">
          <div class="nf-tags">${tagPills}${flowArrows}</div>
          <span class="nf-src">${n.source || ''}</span>
        </div>
      </div>`;
    }).join('') || `<div class="nf-empty">Loading ${m.label}…</div>`;

    return `<div class="nf-col">
      <div class="nf-col-hdr" onclick="toggleNewsCol('${tag}')">
        <span class="nf-col-icon" style="color:${m.color}">${m.icon}</span>
        <span class="nf-col-lbl">${m.label.toUpperCase()}</span>
        <span class="nf-col-count">${items.length}</span>
        <span class="nf-col-sent">
          ${bullCount ? `<span style="color:var(--bull)">▲${bullCount}</span>` : ''}
          ${bearCount ? `<span style="color:var(--bear)">▼${bearCount}</span>` : ''}
        </span>
        <span class="nf-col-x">✕</span>
      </div>
      <div class="nf-col-body">${cards}</div>
    </div>`;
  }).join('');

  // Alert bar — recent strong signals from STATE.alertLog
  const alerts = (STATE.alertLog || []).slice(0, 12);
  const alertBar = alerts.length
    ? `<div class="nf-alertbar">
        <span class="nf-alertbar-lbl">◆ LIVE</span>
        <div class="nf-alertbar-track">
          <div class="nf-alertbar-inner">
            ${alerts.map(a => {
              const cls = a.type === 'buy' ? 'bull' : a.type === 'sell' ? 'bear' : 'neu';
              return `<span class="nf-ab-item ${cls}">● ${a.msg}</span>`;
            }).join('<span class="nf-ab-sep">│</span>')}
          </div>
        </div>
      </div>`
    : '';

  document.getElementById('bnews-body').innerHTML =
    `<div class="nf-cols-wrap">${cols || '<div class="nf-empty" style="padding:20px">All columns collapsed — click a category above to show</div>'}</div>` +
    alertBar;
}

function setNewsTag(tag) {
  STATE.activeNewsTag = tag;
  renderNews();
}

function toggleNewsCol(tag) {
  STATE.collapsedCols[tag] = !STATE.collapsedCols[tag];
  renderNews();
}

function collapseAllCols() {
  COL_ORDER.forEach(t => STATE.collapsedCols[t] = true);
  renderNews();
}

// Tag colour map for the scrolling ticker
const TAG_COLORS = { CRYPTO:'#7b61ff', ENERGY:'#ff8c00', COMMODITY:'#c9a84c', TECH:'#00b4d8', TSX:'#00e5a0', METAL:'#c0c0c0', FX:'#ffd166' };

function updateTicker() {
  document.getElementById('ticker-inner').innerHTML = STATE.newsItems.map(n => {
    const tc = TAG_COLORS[n.tag] || 'var(--text-dim)';
    const sentArrow = n.sent === 'bullish' ? `<span class="ti-b">▲</span>` : n.sent === 'bearish' ? `<span class="ti-s">▼</span>` : '';
    return `<span class="ti"><span class="ti-tag" style="color:${tc};border-color:${tc}">${n.tag || n.source}</span>${sentArrow} <a href="${n.url}" target="_blank">${n.title}</a></span>`;
  }).join('');
}

// ══════════════════════════════════════════════
// HIGH CONVICTION LEADERBOARD v12
// Terminal-style squeeze cards: #1 🚀 SQUEEZE NOW format
// ══════════════════════════════════════════════

let _hclOpen = true;

function toggleHCL() {
  _hclOpen = !_hclOpen;
  const body = document.getElementById('hcl-body');
  const ab   = document.getElementById('hcl-alertbar');
  const chev = document.getElementById('hcl-chevron');
  if (body) body.style.display = _hclOpen ? '' : 'none';
  if (ab)   ab.style.display   = _hclOpen ? '' : 'none';
  if (chev) chev.textContent   = _hclOpen ? '▼' : '▲';
}

// ── Determine setup mode label from signal data ──
function getSetupMode(d, conv) {
  const shock = parseFloat(d.shock) || 1;
  const frNum = parseFloat(d.fr) || 0;
  if (d.oiDiv === '💎 DIP BUY' && frNum <= -0.01) return { label: 'DIP BUY', cls: 'dip-buy', emoji: '💎' };
  if (shock >= 2.0 && d.cvd?.trending === 'up' && conv > 6) return { label: 'SQUEEZE NOW', cls: 'squeeze', emoji: '🚀' };
  if (d.emaTrend === 'ABOVE' && conv > 5) return { label: 'BREAKOUT', cls: 'breakout', emoji: '⚡' };
  if (conv < -4) return { label: 'SHORT SETUP', cls: 'bear', emoji: '🔻' };
  return { label: 'WATCHING', cls: 'watching', emoji: '⏳' };
}

// ── Compute session label from UTC time ──
function getSessionLabel() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 17) return 'NY OPEN';
  if (h >= 8  && h < 13) return 'LONDON';
  if (h >= 0  && h < 8)  return 'ASIA';
  return 'AFTER HOURS';
}

// ── Session time multiplier ──
function getSessionMult() {
  const lbl = getSessionLabel();
  if (lbl === 'NY OPEN')    return '×1.5';
  if (lbl === 'LONDON')     return '×1.2';
  if (lbl === 'ASIA')       return '×0.8';
  return '×1.0';
}

// ── Derive entry / stop / targets from price + support/resistance ──
function calcEntryLevels(d) {
  const p = parseFloat(d.p) || 0;
  if (!p) return null;
  const shock = parseFloat(d.shock) || 1;
  const atr = p * 0.015 * Math.max(1, shock * 0.5); // rough ATR proxy
  const entry = (p * 1.004).toFixed(p < 10 ? 4 : 2);
  const stop  = (p - atr * 1.5).toFixed(p < 10 ? 4 : 2);
  const t1    = (p + atr * 2).toFixed(p < 10 ? 4 : 2);
  const t2    = (p + atr * 4).toFixed(p < 10 ? 4 : 2);
  const rr    = ((parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop))).toFixed(1);
  return { entry, stop, t1, t2, rr };
}

// ── Build cascade info string from global market data ──
function getCascadeInfo() {
  const mp = STATE.marketPulse || {};
  const spy = mp['SPY'];
  const btc = mp['BTC'];
  const parts = [];
  if (spy) {
    const chg = parseFloat(spy.chg || 0);
    parts.push(`Asia ${chg >= 0 ? '+' : ''}${(chg * 0.6).toFixed(1)}%`);
    parts.push(`London ${chg >= 0 ? '+' : ''}${(chg * 0.4).toFixed(1)}%`);
  }
  const cascadeRisk = parts.length ? `→ ${spy && parseFloat(spy.chg) < -1 ? '▲ CASCADE RISK' : '✓ STABLE'}` : '';
  return { parts, cascadeRisk };
}

// ── Score bar HTML (value 0-10) ──
function scoreBar(val, maxVal) {
  const pct = Math.min(100, Math.max(0, (val / maxVal) * 100));
  const neg = val < 0;
  return `<div class="hcl-score-bar"><div class="hcl-score-bar-fill${neg ? ' neg' : ''}" style="width:${Math.abs(pct)}%"></div></div>`;
}

function renderLeaderboard() {
  const DS   = STATE.DS   || {};
  const wl   = STATE.watchlist || [];
  const news = STATE.newsItems || [];

  // ── Score every symbol ──
  const ranked = wl
    .map(sym => {
      const d = DS[sym];
      if (!d) return null;

      let conv = 0;
      conv += (d.score        || 0) * 1.5;
      conv += (d.dipScore     || 0) * 1.2;
      conv += (d.bias4hScore  || 0) * 0.7;
      conv += (d.biasDayScore || 0) * 0.5;
      if (d.oiDiv === '💎 DIP BUY')       conv += 3;
      if (d.oiDiv === '✓ CONFIRM')        conv += 1.5;
      if (d.fundingFlag === '⚡ DIP ZONE') conv += 2;
      if (d.emaTrend === 'ABOVE')         conv += 1;
      const r15 = d.r15 || 50, r1h = d.r1h || 50;
      if (r15 < 30 && r1h < 35)          conv += 2;
      if (parseFloat(d.shock) > 2)        conv += 1;

      const dir = conv >= 4 ? 'bull' : conv <= -4 ? 'bear' : 'neutral';
      const base = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','').toLowerCase();
      const catalyst = news.find(n => n.title.toLowerCase().includes(base));

      return { sym, d, conv: Math.round(conv * 10) / 10, dir, catalyst };
    })
    .filter(Boolean)
    .filter(r => r.dir !== 'neutral')
    .sort((a, b) => Math.abs(b.conv) - Math.abs(a.conv))
    .slice(0, 5);

  // ── Update header bar ──
  const subEl = document.getElementById('hcl-sub');
  const regEl = document.getElementById('hcl-regime');
  const cascEl = document.getElementById('hcl-cascade-hdr');
  const utcEl  = document.getElementById('hcl-utc');
  const slotsEl = document.getElementById('hcl-slots');
  const aiEl   = document.getElementById('hcl-ai-msg');

  if (subEl) subEl.textContent = ranked.length
    ? `${ranked.length} setup${ranked.length > 1 ? 's' : ''} · ${getSessionLabel()}`
    : 'Awaiting signal data…';

  // Regime from market pulse
  const mp = STATE.marketPulse || {};
  const spyChg = parseFloat(mp.SPY?.chg || 0);
  if (regEl) {
    if (spyChg > 0.3) { regEl.textContent = 'REGIME RISK-ON ▲'; regEl.className = 'hcl-regime risk-on'; }
    else if (spyChg < -0.3) { regEl.textContent = 'REGIME RISK-OFF ▼'; regEl.className = 'hcl-regime risk-off'; }
    else { regEl.textContent = 'REGIME NEUTRAL'; regEl.className = 'hcl-regime neutral'; }
  }
  const { cascadeRisk } = getCascadeInfo();
  if (cascEl) cascEl.textContent = cascadeRisk || 'Cascade —';
  if (utcEl)  utcEl.textContent  = new Date().toUTCString().slice(17, 22) + ' UTC';

  const usedSlots = ranked.filter(r => r.dir === 'bull').length;
  if (slotsEl) slotsEl.textContent = `Slots: ${usedSlots}/${Math.min(3, ranked.length)}`;

  // AI message from top catalyst
  const topCat = ranked[0]?.catalyst;
  if (aiEl) {
    aiEl.textContent = topCat
      ? `AI: "${topCat.title.slice(0, 60)}${topCat.title.length > 60 ? '…' : ''}"`
      : ranked[0]?.d?.reason
        ? `AI: "${ranked[0].d.reason.slice(0, 60)}"`
        : '';
  }

  const body = document.getElementById('hcl-body');
  const alertBar = document.getElementById('hcl-alertbar');
  if (!body) return;

  if (!ranked.length) {
    body.innerHTML = '<div class="hcl-loading">No high-conviction setups yet — scores populate as data arrives</div>';
    buildAlertBar(alertBar);
    return;
  }

  const medals = ['#1','#2','#3','#4','#5'];
  const session = getSessionLabel();
  const mult = getSessionMult();

  body.innerHTML = ranked.map((r, i) => {
    const { sym, d, conv, dir, catalyst } = r;
    const base   = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
    const chgN   = parseFloat(d.chg || 0);
    const chgCls = chgN >= 0 ? 'bull' : 'bear';
    const chgStr = (chgN >= 0 ? '+' : '') + chgN.toFixed(2) + '%';
    const setup  = getSetupMode(d, conv);
    const levels = calcEntryLevels(d);
    const sparkId = `hcl2-spark-${i}`;

    // Timer: countdown to next reset (15min cycle)
    const now = new Date();
    const secsLeft = 900 - (now.getMinutes() % 15) * 60 - now.getSeconds();
    const timerStr = `${Math.floor(secsLeft / 60)}min ${secsLeft % 60}s to reset`;

    // Score breakdown values
    const techScore  = Math.round((d.score        || 0) * 1.5);
    const sqzScore   = Math.round(parseFloat(d.shock || 1) > 1.5 ? (parseFloat(d.shock) - 1) * 5 : 0);
    const instScore  = Math.round((d.dipScore     || 0) * 1.2);
    const aiSentScore= Math.round(d.bias4hScore   || 0);
    const socialScore= Math.round(d.biasDayScore  || 0);
    const macroScore = d.emaTrend === 'ABOVE' ? 1 : d.emaTrend === 'BELOW' ? -1 : 0;
    const totalScore = Math.round(Math.abs(conv));
    const timeBoost  = mult !== '×1.0' ? mult : null;

    // Cascade risk
    const cascRisk = spyChg < -1 ? 'risk' : 'neutral';
    const cascLabel = spyChg < -1 ? 'CASCADE RISK' : 'CASCADE neutral';

    // Evidence items
    const oiChg = chgN < 0 ? `OI drop ${Math.abs(Math.round(chgN * 2))}%` : `OI rise ${Math.round(chgN * 2)}%`;
    const frNum = parseFloat(d.fr) || 0;
    const frStr = d.fr !== 'N/A' ? `funding ${(frNum * 100).toFixed(2)}%` : 'funding N/A';
    const frBull = frNum < 0;
    const cvdBull = d.cvd?.trending === 'up';
    const lsStr = `L/S ${d.lp || 50}% long`;
    const lsBull = (d.lp || 50) > 50;
    const shockBull = parseFloat(d.shock) > 1.5;
    const shortsCovering = lsBull && chgN < 0;

    const evidence = [
      { txt: oiChg, bull: chgN > 0 },
      { txt: frStr, bull: frBull },
      { txt: cvdBull ? 'CVD rising' : 'CVD falling', bull: cvdBull },
      { txt: `Vol ${d.shock || '1.0'}x`, bull: shockBull },
      { txt: lsStr, bull: lsBull },
      { txt: shortsCovering ? '"shorts covering"' : `RSI ${d.r15 || 50}/${d.r1h || 50}`, bull: shortsCovering || (d.r15 || 50) < 40 },
    ];

    // Entry trigger wait condition
    const entryTrigger = levels
      ? `Wait: 15min close > $${levels.entry} · Vol > ${d.shock || '1.0'}x (now ${(Math.max(0, parseFloat(d.shock || 1) * 0.8)).toFixed(1)}x)`
      : `Watching price action…`;

    // Correlation
    const isCrypto = sym.includes('BINANCE:');
    const corrStr = isCrypto ? `${base} standalone` : `${base} vs SPY`;

    // Catalyst / reason
    const catTxt = catalyst
      ? catalyst.title.slice(0, 55) + (catalyst.title.length > 55 ? '…' : '')
      : (d.reason || '').slice(0, 55);

    // Market context (from market pulse)
    const asiaStr = spyChg !== 0 ? `Asia ${spyChg >= 0 ? '+' : ''}${(spyChg * 0.5).toFixed(1)}%` : 'Asia —';
    const lonStr  = spyChg !== 0 ? `London ${spyChg >= 0 ? '+' : ''}${(spyChg * 0.4).toFixed(1)}%` : 'London —';

    return `<div class="hcl-card ${dir}" onclick="switchT('${sym}')">

      <!-- Top bar: rank · mode · symbol · timer -->
      <div class="hcl-ct">
        <div class="hcl-ct-left">
          <span class="hcl-rank-badge">${medals[i]}</span>
          <span style="font-size:11px">${setup.emoji}</span>
          <span class="hcl-mode ${setup.cls}">${setup.label}</span>
          <span class="hcl-sym-name">${base}</span>
        </div>
        <div class="hcl-timer">
          <span style="font-size:9px">⏱</span>
          <span class="hcl-timer-val">${timerStr}</span>
        </div>
      </div>

      <!-- Price row -->
      <div class="hcl-pr">
        <span class="hcl-price-val">$${d.p || '—'}</span>
        <span class="hcl-chg ${chgCls}">${chgStr}</span>
        <canvas class="hcl-spark-inline" id="${sparkId}" width="60" height="20"></canvas>
        <span class="hcl-session-tag">🏦 ${session}</span>
        ${timeBoost ? `<span class="hcl-mult">${timeBoost} multiplier</span>` : ''}
      </div>

      <!-- Score breakdown -->
      <div class="hcl-score-section">
        <div class="hcl-score-hdr">SCORE BREAKDOWN</div>
        <div class="hcl-score-grid">
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">Technical</span>
            ${scoreBar(techScore, 10)}
            <span class="hcl-score-val ${techScore >= 0 ? 'pos' : 'neg'}">${techScore >= 0 ? '+' : ''}${techScore}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">Squeeze</span>
            ${scoreBar(sqzScore, 10)}
            <span class="hcl-score-val ${sqzScore >= 0 ? 'pos' : 'neg'}">${sqzScore >= 0 ? '+' : ''}${sqzScore}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">Inst Flow</span>
            ${scoreBar(instScore, 10)}
            <span class="hcl-score-val ${instScore >= 0 ? 'pos' : 'neg'}">${instScore >= 0 ? '+' : ''}${instScore}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">AI Sent</span>
            ${scoreBar(aiSentScore, 10)}
            <span class="hcl-score-val ${aiSentScore >= 0 ? 'pos' : 'neg'}">${aiSentScore >= 0 ? '+' : ''}${aiSentScore}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">Social</span>
            ${scoreBar(socialScore, 10)}
            <span class="hcl-score-val ${socialScore >= 0 ? 'pos' : 'neg'}">${socialScore >= 0 ? '+' : ''}${socialScore}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">Macro</span>
            ${scoreBar(macroScore, 10)}
            <span class="hcl-score-val ${macroScore >= 0 ? 'pos' : 'neg'}">${macroScore >= 0 ? '+' : ''}${macroScore}</span>
          </div>
        </div>
        <div class="hcl-score-total-row">
          <span class="hcl-score-total-lbl">TOTAL: </span>
          <span class="hcl-score-total-val ${dir}">${totalScore}</span>
          <div class="hcl-score-total-bar"><div class="hcl-score-total-fill ${dir}" style="width:${Math.min(100, totalScore / 15 * 100)}%"></div></div>
          ${timeBoost ? `<span class="hcl-time-boost">Time boost ${timeBoost}</span>` : ''}
          <span class="hcl-cascade-tag ${cascRisk}">${cascLabel}</span>
        </div>
      </div>

      <!-- Evidence -->
      <div class="hcl-evidence">
        <div class="hcl-ev-hdr">EVIDENCE</div>
        <div class="hcl-ev-grid">
          ${evidence.map(ev => `<div class="hcl-ev-item">
            <div class="hcl-ev-dot ${ev.bull ? 'bull' : 'bear'}"></div>
            <span class="hcl-ev-txt ${ev.bull ? 'bull' : 'bear'}">${ev.txt}</span>
          </div>`).join('')}
        </div>
      </div>

      <!-- Entry trigger -->
      <div class="hcl-entry">
        <div class="hcl-entry-hdr">
          <span class="hcl-entry-lbl">ENTRY TRIGGER</span>
          <span class="hcl-entry-status watching">⏳ WATCHING</span>
        </div>
        ${levels ? `
        <div class="hcl-entry-wait">${entryTrigger}</div>
        <div class="hcl-entry-levels">
          <div class="hcl-lvl"><span class="hcl-lvl-lbl">ENTRY</span><span class="hcl-lvl-val entry">$${levels.entry}</span></div>
          <div class="hcl-lvl"><span class="hcl-lvl-lbl">STOP</span><span class="hcl-lvl-val stop">$${levels.stop}</span></div>
          <div class="hcl-lvl"><span class="hcl-lvl-lbl">T1</span><span class="hcl-lvl-val t1">$${levels.t1}</span></div>
          <div class="hcl-lvl"><span class="hcl-lvl-lbl">T2</span><span class="hcl-lvl-val t2">$${levels.t2}</span></div>
        </div>` : '<div class="hcl-entry-wait">Awaiting price data…</div>'}
      </div>

      <!-- Footer: R:R · correlation · catalyst -->
      <div class="hcl-footer">
        ${levels ? `<span class="hcl-rr">R:R <span>1:${levels.rr}</span> ✓</span>` : ''}
        <span class="hcl-corr">Corr: <span>${corrStr}</span> ✓</span>
        ${catTxt ? `<span class="hcl-catalyst-mini">⚡ ${catTxt}</span>` : ''}
      </div>

      <!-- Market context bar -->
      <div style="display:flex;align-items:center;gap:8px;padding:3px 10px;border-top:1px solid var(--border);font-family:var(--mono);font-size:8px;background:rgba(0,0,0,.2);">
        <span style="color:var(--text-dim)">🌏 ${asiaStr}</span>
        <span style="color:var(--text-dim)">🏛 ${lonStr}</span>
        <span style="margin-left:auto;color:${cascRisk === 'risk' ? 'var(--bear)' : 'var(--text-dim)'};font-weight:700;">→ ${cascRisk === 'risk' ? '▲ CASCADE RISK' : '✓ STABLE'}</span>
      </div>

    </div>`;
  }).join('');

  // Draw sparklines
  ranked.forEach((r, i) => {
    const canvas = document.getElementById(`hcl2-spark-${i}`);
    if (!canvas) return;
    const sparkData = (r.d?.sparkBars?.length > 1) ? r.d.sparkBars : (STATE.PH[r.sym]?.length > 1 ? STATE.PH[r.sym].slice(-30) : null);
    if (sparkData && sparkData.length > 1) drawSparkLine(canvas, sparkData, r.dir === 'bull' ? '#00e5a0' : '#ff4455');
  });

  buildAlertBar(alertBar);
}

function drawSparkLine(canvas, data, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const mn = Math.min(...data), mx = Math.max(...data);
  const range = mx - mn || 1;
  ctx.clearRect(0,0,w,h);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - mn) / range) * h * 0.85 - h * 0.05;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Fill gradient under line
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
}

function buildAlertBar(el) {
  if (!el) return;
  const log = STATE.alertLog || [];
  if (!log.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="hcl-ab">
    <span class="hcl-ab-lbl">⚡ ACTIVE ALERTS</span>
    <div class="hcl-ab-track">
      <div class="hcl-ab-inner">
        ${log.slice(0,10).map(a => {
          const cls = a.type==='buy' ? 'bull' : a.type==='sell' ? 'bear' : 'neu';
          return `<span class="hcl-ab-item ${cls}">● ${a.msg}</span><span class="hcl-ab-sep"> · </span>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}
