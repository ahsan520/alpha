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
      <td><div class="fbar"><span style="color:${nfC};min-width:32px;font-size:9px;">${d.nf > 0 ? '+' : ''}${d.nf}</span><div class="fbar-bg"><div class="fbar-fill" style="width:${Math.min(100, Math.abs(d.nf))}%;background:${nfC}"></div></div></div></td>
      <td>${lsH}</td>
      <td style="color:${frC};font-size:9px;">${frStr}</td>
      <td>${liqH}</td>
      <td style="font-size:9px;font-weight:700;color:${d.emaTrend === 'ABOVE' ? 'var(--bull)' : d.emaTrend === 'BELOW' ? 'var(--bear)' : 'var(--text-dim)'};">${d.emaTrend || '—'}</td>
      <td style="font-size:9px;font-weight:700;color:${d.fundingFlagC};">${d.fundingFlag || '—'}</td>
      <td style="font-size:9px;font-weight:700;color:${d.oiDivC};">${d.oiDiv || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.dipLabelC};" title="Score: ${d.dipScore || 0}">${d.dipLabel || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.bias4hC};" title="4H score: ${d.bias4hScore || 0}">${d.bias4h || '—'}</td>
      <td style="font-size:10px;font-weight:700;color:${d.biasDayC};" title="Daily score: ${d.biasDayScore || 0}">${d.biasDay || '—'}</td>
      <td><span class="sig ${d.sigC}"><span class="sig-dot" style="background:${sdotC}"></span>${d.sig}</span></td>
      <td style="font-size:9px;color:var(--text-dim);">${d.sup || '—'}</td>
      <td style="font-size:9px;color:var(--text-dim);">${d.res || '—'}</td>
      <td><a href="https://finance.yahoo.com/quote/${s.replace('BINANCE:', '').replace('USDT', '')}" target="_blank" style="color:var(--accent);text-decoration:none;font-size:9px;">⬡</a></td>
      <td class="td-reason" title="${d.reason}">${d.reason}</td>
    </tr>`;
  }).join('');

  requestAnimationFrame(() => {
    sorted.forEach(s => {
      const h = PH[s] || [];
      if (h.length > 1) drawSpark('sp_' + s.replace(/[^a-z0-9]/gi, '_'), h);
      const d = DS[s];
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
  const bulls = newsItems.filter(n => n.sent === 'bullish').length;
  const bears = newsItems.filter(n => n.sent === 'bearish').length;
  document.getElementById('news-badge').textContent = newsItems.length + ' articles';
  document.getElementById('bull-n').textContent = '▲ ' + bulls;
  document.getElementById('bear-n').textContent = '▼ ' + bears;
  document.getElementById('bnews-body').innerHTML = newsItems.map(n => `
    <div class="ni" onclick="window.open('${n.url}','_blank')">
      <div class="ni-hl">${n.title}</div>
      <div class="ni-meta"><span class="ni-src">${n.source}</span><span>${n.time}</span><span class="ntag ${n.sent}">${n.sent.toUpperCase()}</span></div>
    </div>`).join('');
}

function updateTicker() {
  document.getElementById('ticker-inner').innerHTML = STATE.newsItems.map(n =>
    `<span class="ti"><span class="${n.sent === 'bullish' ? 'ti-b' : 'ti-s'}">${n.sent === 'bullish' ? '▲' : '▼'}</span> <a href="${n.url}" target="_blank">${n.title}</a> <span style="color:var(--text-dim)"> · ${n.source}</span></span>`
  ).join('');
}
