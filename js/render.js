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
function renderNews() {
  const { newsItems } = STATE;
  const activeTag = STATE.activeNewsTag || 'ALL';
  const filtered = activeTag === 'ALL' ? newsItems : newsItems.filter(n => n.tag === activeTag);
  const bulls = filtered.filter(n => n.sent === 'bullish').length;
  const bears = filtered.filter(n => n.sent === 'bearish').length;
  document.getElementById('news-badge').textContent = filtered.length + ' items';
  document.getElementById('bull-n').textContent = '▲ ' + bulls;
  document.getElementById('bear-n').textContent = '▼ ' + bears;

  // Render tag filter buttons
  const allTags = ['ALL', 'CRYPTO', 'TECH', 'ENERGY', 'METAL', 'COMMODITY', 'TSX'];
  const tagBar = document.getElementById('news-tag-bar');
  if (tagBar) {
    tagBar.innerHTML = allTags.map(tag => {
      const tc = tag === 'ALL' ? 'var(--text-dim)' : (TAG_COLORS[tag] || 'var(--text-dim)');
      const active = activeTag === tag;
      return `<button class="news-tag-btn${active ? ' active' : ''}" 
        style="${active ? `background:${tc};color:#000;border-color:${tc};` : `color:${tc};border-color:${tc};`}"
        onclick="setNewsTag('${tag}')">${tag}</button>`;
    }).join('');
  }

  if (!filtered.length) {
    document.getElementById('bnews-body').innerHTML = '<div style="padding:20px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Loading ' + activeTag + ' news… refreshes every 5 min</div>';
    return;
  }

  document.getElementById('bnews-body').innerHTML = filtered.map(n => {
    const tc = TAG_COLORS[n.tag] || 'var(--text-dim)';
    return `
    <div class="ni" onclick="window.open('${n.url}','_blank')">
      <div class="ni-hl">${n.title}</div>
      <div class="ni-meta">
        <span class="ni-tag" style="color:${tc};border-color:${tc}">${n.tag || n.source}</span>
        <span class="ni-src">${n.source !== n.tag ? n.source : ''}</span>
        <span>${n.time}</span>
        ${n.sent !== 'neutral' ? `<span class="ntag ${n.sent}">${n.sent.toUpperCase()}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function setNewsTag(tag) {
  STATE.activeNewsTag = tag;
  renderNews();
}

// Tag colour map for the scrolling ticker
const TAG_COLORS = { CRYPTO:'#7b61ff', ENERGY:'#ff8c00', COMMODITY:'#c9a84c', TECH:'#00b4d8', TSX:'#00e5a0', METAL:'#c0c0c0' };

function updateTicker() {
  document.getElementById('ticker-inner').innerHTML = STATE.newsItems.map(n => {
    const tc = TAG_COLORS[n.tag] || 'var(--text-dim)';
    const sentArrow = n.sent === 'bullish' ? `<span class="ti-b">▲</span>` : n.sent === 'bearish' ? `<span class="ti-s">▼</span>` : '';
    return `<span class="ti"><span class="ti-tag" style="color:${tc};border-color:${tc}">${n.tag || n.source}</span>${sentArrow} <a href="${n.url}" target="_blank">${n.title}</a></span>`;
  }).join('');
}
