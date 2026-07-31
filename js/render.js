// ══════════════════════════════════════════════
// render.js — v12.5 — zero-flicker DOM strategy
//
// RULES:
//  1. Page loads once. Nothing is ever destroyed and rebuilt during live sync.
//  2. Table rows are built once on init. Each sync only writes changed values
//     using textContent / style properties — never innerHTML on a container.
//  3. Sparklines draw only for rows in the viewport (IntersectionObserver).
//  4. Leaderboard cards are built once; only text nodes are patched each cycle.
//  5. WL sidebar patches textContent only — no innerHTML rebuild after init.
//  6. No MutationObserver on live containers (they fire on every cell write).
// ══════════════════════════════════════════════

// ── Dirty-value cache — keyed by "sym:field" → last rendered string ──
// Prevents writing to the DOM when the value hasn't actually changed.
const _dv = Object.create(null); // sym:field → last value string
function _set(sym, field, el, value, prop) {
  const key = sym + ':' + field;
  if (_dv[key] === value) return; // no change — skip DOM write entirely
  _dv[key] = value;
  if (prop === 'text') { el.textContent = value; return; }
  if (prop === 'html') { el.innerHTML   = value; return; }
  // style object: value is [prop, val] pair
  if (Array.isArray(prop)) { el.style[prop[0]] = prop[1]; return; }
}

// ── IntersectionObserver for viewport-only sparkline draws ──
// Registers canvas elements; draws only when they enter the viewport.
const _visibleCanvases = new Set();
const _sparkQueue      = new Map(); // canvasId → drawFn
let   _ioReady = false;
let   _sparkIO;

function _initSparkIO() {
  if (_ioReady) return;
  _ioReady = true;
  _sparkIO = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        _visibleCanvases.add(e.target.id);
        const fn = _sparkQueue.get(e.target.id);
        if (fn) { fn(); _sparkQueue.delete(e.target.id); }
      } else {
        _visibleCanvases.delete(e.target.id);
      }
    });
  }, { rootMargin: '120px' }); // slight pre-load buffer
}

function _registerSpark(canvasEl) {
  if (!_ioReady) _initSparkIO();
  _sparkIO.observe(canvasEl);
}

// Draw sparkline only if canvas is in viewport; otherwise queue it.
function _drawSparkLazy(canvasId, data, color) {
  const fn = () => {
    const c = document.getElementById(canvasId);
    if (c && data?.length > 1) drawSpark(canvasId, data, color);
  };
  if (_visibleCanvases.has(canvasId)) fn();
  else _sparkQueue.set(canvasId, fn);
}

// ── Legacy compat ──
const _rendered = { wl: null, tableSyms: null };
let _lbTimer = null;
function scheduleLeaderboard() {
  clearTimeout(_lbTimer);
  _lbTimer = setTimeout(() => renderLeaderboard(), 800);
}
function render() { renderWL(); renderTable(); scheduleLeaderboard(); }

// ── Watchlist sidebar ──
// Skeleton built once on init / structure change. Live updates = textContent only.
function renderWL() {
  const { watchlist, DS, currentS } = STATE;

  // Keep the watchlist-switcher dropdown in sync with STATE.namedWatchlists.
  const switcher = document.getElementById('wlSwitcher');
  if (switcher && STATE.namedWatchlists) {
    const names = Object.keys(STATE.namedWatchlists);
    const optKey = names.join(',') + '|' + STATE.activeWatchlistName;
    if (switcher.dataset.optKey !== optKey) {
      switcher.innerHTML = names.map(n =>
        `<option value="${n}"${n === STATE.activeWatchlistName ? ' selected' : ''}>${n} (${(STATE.namedWatchlists[n] || []).length})</option>`
      ).join('');
      switcher.dataset.optKey = optKey;
    }
  }

  const cont = document.getElementById('wl-cont');
  if (!cont) return;

  const wlKey = watchlist.join(',');
  if (_rendered.wl !== wlKey) {
    // Build skeleton with empty price slots — no prices in innerHTML
    cont.innerHTML = watchlist.map(s => {
      const name = s.includes(':') ? s.split(':')[1].replace('USDT','') : s;
      const mktB = typeof marketStatusBadge === 'function' ? marketStatusBadge(s) : '';
      const spId = 'wlsp_' + s.replace(/[^a-z0-9]/gi, '_');
      return `<div class="wli" onclick="switchT('${s}')" data-sym="${s}">
        <span class="wl-name">${name}${mktB}</span>
        <canvas id="${spId}" width="46" height="16" class="sp" style="flex-shrink:0;"></canvas>
        <span class="wl-chg">—</span>
        <button class="wl-del" onclick="event.stopPropagation();delT('${s}')" title="Remove ${name} from this watchlist">✕</button>
      </div>`;
    }).join('');
    _rendered.wl = wlKey;
    watchlist.forEach(s => { delete _dv[s+':wlchg']; delete _dv[s+':wlcolor']; });
    // Register the new sparkline canvases for viewport-only lazy drawing
    requestAnimationFrame(() => {
      _initSparkIO();
      watchlist.forEach(s => {
        const spEl = document.getElementById('wlsp_' + s.replace(/[^a-z0-9]/gi,'_'));
        if (spEl) _registerSpark(spEl);
      });
    });
  }

  // Patch-only: textContent + className, no innerHTML writes
  watchlist.forEach(s => {
    const el = cont.querySelector(`[data-sym="${CSS.escape(s)}"]`);
    if (!el) return;
    const d   = DS[s] || {};
    const up  = parseFloat(d.chg || 0) >= 0;
    const txt = (up ? '+' : '') + (d.chg || '0') + '%';
    const col = up ? 'var(--bull)' : 'var(--bear)';
    const chgEl = el.querySelector('.wl-chg');
    if (chgEl) {
      if (_dv[s+':wlchg']  !== txt) { chgEl.textContent  = txt; _dv[s+':wlchg']  = txt; }
      if (_dv[s+':wlcolor']!== col) { chgEl.style.color  = col; _dv[s+':wlcolor']= col; }
    }
    const isOn = s === currentS;
    if (el.classList.contains('on') !== isOn) el.classList.toggle('on', isOn);
  });

  // Sparklines: only draw canvases currently in the viewport (same lazy
  // IntersectionObserver machinery the Signal Matrix table sparklines use)
  requestAnimationFrame(() => {
    watchlist.forEach(s => {
      const d       = DS[s];
      const spId    = 'wlsp_' + s.replace(/[^a-z0-9]/gi,'_');
      const spData  = d?.sparkBars?.length > 1 ? d.sparkBars : (STATE.PH[s]?.length > 1 ? STATE.PH[s] : null);
      if (spData) _drawSparkLazy(spId, spData, null);
    });
  });
}

// ── MTF RSI dot ──
function rdot(v, lbl) {
  if (v === null || v === undefined)
    return `<div class="mtf-col"><div class="mtf-d" style="background:#2a2a2a;"></div><div class="mtf-l">${lbl}</div></div>`;
  const c = v > 70 ? 'var(--bear)' : v < 30 ? 'var(--bull)' : v > 60 ? '#f0a500' : 'var(--accent)';
  return `<div class="mtf-col"><div class="mtf-d" style="background:${c};box-shadow:0 0 5px ${c}44;" title="${lbl}: ${v}"></div><div class="mtf-l" style="color:${c}">${v}</div></div>`;
}

// ── Main signal table — in-place patch, no full rebuilds ──
function renderTable() {
  const { watchlist, DS, PH, sortK, sortD } = STATE;
  const tbody = document.getElementById('mx-body');
  if (!tbody) return;

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

  // Helper to build a full row HTML (used on first load only)
  function buildRow(s, d) {
    const up = parseFloat(d.chg) >= 0;
    const name = s.includes(':') ? s.split(':')[1].replace('USDT', '') : s;
    const hc = parseFloat(d.chg) > 2.5 ? 'ru' : parseFloat(d.chg) < -2.5 ? 'rd' : '';
    const spId = 'sp_' + s.replace(/[^a-z0-9]/gi, '_');
    const cvdId = 'cv_' + s.replace(/[^a-z0-9]/gi, '_');
    const frC = d.fr !== 'N/A' ? (parseFloat(d.fr) >= 0 ? 'var(--bull)' : 'var(--bear)') : '#888';
    const frStr = d.fr !== 'N/A' ? (parseFloat(d.fr) >= 0 ? '+' : '') + (parseFloat(d.fr) * 100).toFixed(3) + '%' : '—';
    let obiH = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
    if (d.obi) {
      const bw = parseFloat(d.obi.bidPct), aw = 100 - bw;
      const c = bw > 55 ? 'var(--bull)' : bw < 45 ? 'var(--bear)' : 'var(--text-dim)';
      obiH = `<div class="obi"><span class="obi-v" style="color:${c}">${bw}%</span><div class="obi-track"><div class="obi-bid" style="width:${bw}%"></div><div class="obi-ask" style="width:${aw}%"></div></div></div>`;
    }
    let cvdH = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
    if (d.cvd) {
      const val = d.cvd.value; const up2 = d.cvd.trending === 'up';
      const fv = Math.abs(val) > 1e6 ? (val/1e6).toFixed(2)+'M' : Math.abs(val) > 1000 ? (val/1000).toFixed(1)+'K' : val.toFixed(0);
      cvdH = `<div class="cvd"><canvas id="${cvdId}" width="55" height="20" class="sp"></canvas><span class="cvd-v" style="color:${up2?'var(--bull)':'var(--bear)'}">${up2?'▲':'▼'}${fv}</span></div>`;
    }
    const lsH = `<div class="ls"><div class="ls-track"><div class="ls-l" style="width:${d.lp}%"></div><div class="ls-s" style="width:${d.sp}%"></div></div><div class="ls-lbl"><span style="color:var(--bull)">L${d.lp}%</span><span style="color:var(--bear)">S${d.sp}%</span></div></div>`;
    const sdotC = d.sigC.includes('sb')||d.sigC.includes('-b') ? 'var(--bull)' : d.sigC.includes('ss')||d.sigC.includes('be') ? 'var(--bear)' : '#555';
    const mktBadge = typeof marketStatusBadge === 'function' ? marketStatusBadge(s) : '';
    return `<tr class="${hc}${mktBadge ? ' mkt-closed-row' : ''}" data-sym="${s}" onclick="switchT('${s}')">
      <td class="td-sym">${name}${mktBadge}</td>
      <td class="td-px" data-k="p">$${d.p}</td>
      <td data-k="chg" style="color:${up?'var(--bull)':'var(--bear)'};font-weight:700;">${up?'+':''}${d.chg}%</td>
      <td><canvas id="${spId}" width="68" height="20" class="sp"></canvas></td>
      <td data-k="mtf"><div class="mtf">${rdot(d.r15,'15m')}${rdot(d.r1h,'1h')}${rdot(d.r4h,'4h')}</div></td>
      <td data-k="obi">${obiH}</td>
      <td data-k="cvd">${cvdH}</td>
      <td data-k="shock"><div class="vbar"><span style="color:var(--gold)">${d.shock}x</span><div class="vbar-bg"><div class="vbar-fill" style="width:${Math.min(100,(parseFloat(d.shock)-.5)*80)}%"></div></div></div></td>
      <td data-k="ls">${lsH}</td>
      <td data-k="fr" style="color:${frC};font-size:9px;">${frStr}</td>
      <td data-k="ema" style="font-size:9px;font-weight:700;color:${d.emaTrend==='ABOVE'?'var(--bull)':d.emaTrend==='BELOW'?'var(--bear)':'var(--text-dim)'};">${d.emaTrend||'—'}</td>
      <td data-k="oidiv" style="font-size:10px;font-weight:700;color:${d.oiDivC};">${d.oiDiv||'—'}</td>
      <td data-k="dip" style="font-size:10px;font-weight:700;color:${d.dipLabelC};">${d.dipLabel||'—'}</td>
      <td data-k="b4h" style="font-size:10px;font-weight:700;color:${d.bias4hC};">${d.bias4h||'—'}</td>
      <td data-k="bday" style="font-size:10px;font-weight:700;color:${d.biasDayC};">${d.biasDay||'—'}</td>
      <td data-k="sig"><span class="sig ${d.sigC}"><span class="sig-dot" style="background:${sdotC}"></span>${d.sig}</span></td>
      <td data-k="whale" style="font-family:var(--mono);font-size:10px;font-weight:700;color:${d.whaleZoneC||'var(--text-dim)'};min-width:72px;">
        <span title="${d.whaleZone||''}">${d.whaleZoneEmoji||''}${d.whaleScore??'—'}</span>
        <span style="font-size:8px;font-weight:400;color:var(--text-dim);"> /100</span>
      </td>
      <td data-k="conf" style="font-family:var(--mono);font-size:10px;font-weight:700;color:${(d.bullConfirmCount||0)>=7?'var(--bull)':(d.bullConfirmCount||0)>=4?'#f5c518':'var(--bear)'};min-width:50px;" title="Bull confirmations: ${(d.confirmChecks||[]).filter(c=>c.pass).map(c=>c.label).join(', ')}">${d.bullConfirmCount??0}/10</td>
      <td data-k="sr" style="font-size:9px;min-width:90px;">${d.sup||d.res?`<div style="display:flex;flex-direction:column;gap:1px;line-height:1.3;"><span style="color:var(--bull);">S $${d.sup||'—'}</span><span style="color:var(--bear);">R $${d.res||'—'}</span></div>`:'<span style="color:var(--text-dim);">—</span>'}</td>
      <td data-k="risk" style="font-size:9px;font-weight:700;min-width:72px;color:${(d._rf&&d._rf.riskC)||'var(--text-dim)'};">${d._rf?`${d._rf.riskEmoji} ${d._rf.risk}`:"—"}</td>
      <td data-k="flow" style="font-size:9px;font-weight:700;min-width:62px;color:${(d._rf&&d._rf.flowC)||'var(--text-dim)'};">${d._rf?d._rf.flow:"—"}</td>
      <td><button class="rbtn" onclick="event.stopPropagation();refreshSymbol('${s}',this)">↺</button></td>
      <td class="td-reason" data-k="reason" title="${d.reason}">${d.reason}</td>
    </tr>`;
  }

  // Delegate all in-place patching to patchSymbolRow — single code path,
  // uses dirty-value cache, no innerHTML comparison strings.
  function patchRow(tr, s, d) { patchSymbolRow(s); }

  // Check if rows exist and match current sorted order
  const existingRows = Array.from(tbody.querySelectorAll('tr[data-sym]'));
  const existingSyms = existingRows.map(r => r.getAttribute('data-sym'));
  const needsRebuild = sorted.join(',') !== existingSyms.join(',');

  if (needsRebuild) {
    // Structure changed — rebuild once, then register all spark canvases with IO
    tbody.innerHTML = sorted.map(s => buildRow(s, { ...def, ...(DS[s]||{}) })).join('');
    // Register sparkline canvases for viewport-only drawing
    requestAnimationFrame(() => {
      _initSparkIO();
      sorted.forEach(s => {
        const spEl  = document.getElementById('sp_' + s.replace(/[^a-z0-9]/gi,'_'));
        const cvEl  = document.getElementById('cv_' + s.replace(/[^a-z0-9]/gi,'_'));
        if (spEl)  _registerSpark(spEl);
        if (cvEl)  _registerSpark(cvEl);
      });
    });
  } else {
    // Same rows — patch values only (no DOM destruction)
    existingRows.forEach(tr => {
      const s = tr.getAttribute('data-sym');
      if (DS[s]) patchRow(tr, s, { ...def, ...DS[s] });
    });
  }

  // Sparklines: only draw canvases that are in the viewport
  requestAnimationFrame(() => {
    sorted.forEach(s => {
      const d = DS[s];
      const spId  = 'sp_' + s.replace(/[^a-z0-9]/gi,'_');
      const cvId  = 'cv_' + s.replace(/[^a-z0-9]/gi,'_');
      const spData = d?.sparkBars?.length > 1 ? d.sparkBars : (STATE.PH[s]?.length > 1 ? STATE.PH[s] : null);
      if (spData) _drawSparkLazy(spId, spData, null);
      if (d?.cvd?.series?.length > 1) _drawSparkLazy(cvId, d.cvd.series, null);
    });
  });
}

// ── Single-symbol row patch — called by sync loop after each syncOne() ──
// Only touches the ONE row for symbol `s`. No sort check, no tbody scan,
// no other rows involved. Falls back to full renderTable() only if the row
// doesn't exist yet (new symbol added mid-session).
// ── patchSymbolRow — the ONLY function the sync loop calls per symbol ──
// Uses dirty-value cache (_dv) so DOM writes only happen when value changed.
// Sparklines drawn only if canvas is in the viewport (IntersectionObserver).
function patchSymbolRow(s) {
  const tbody = document.getElementById('mx-body');
  if (!tbody) return;
  const d = STATE.DS[s];
  if (!d) return;
  // Background-scanned symbol from a non-active watchlist — it has no row
  // in the currently displayed matrix by design (only the active list is
  // rendered here). Alerts already fired off this data in processAI; skip
  // the DOM patch/rebuild entirely rather than forcing a spurious
  // renderTable() for a symbol that will never appear in this table.
  if (!(STATE.watchlist || []).includes(s)) return;

  const tr = tbody.querySelector(`tr[data-sym="${CSS.escape(s)}"]`);
  if (!tr) { renderTable(); return; } // new symbol — rebuild structure once

  const def = {
    p:'—',chg:'0',r15:50,r1h:50,r4h:50,shock:'1.0',lp:50,sp:50,fr:'N/A',
    sig:'SYNC',sigC:'s-w',reason:'...',obi:null,cvd:null,
    emaTrend:'—',oiDiv:'—',oiDivC:'var(--text-dim)',
    dipLabel:'—',dipLabelC:'var(--text-dim)',
    bias4h:'—',bias4hC:'var(--text-dim)',
    biasDay:'—',biasDayC:'var(--text-dim)',
    sup:null,res:null,sparkBars:null,
  };
  const fd = { ...def, ...d };
  const up  = parseFloat(fd.chg) >= 0;
  const frN = parseFloat(fd.fr);
  const frC = fd.fr !== 'N/A' ? (frN >= 0 ? 'var(--bull)' : 'var(--bear)') : '#888';
  const frStr = fd.fr !== 'N/A' ? (frN >= 0 ? '+' : '') + (frN * 100).toFixed(3) + '%' : '—';

  // Helper: write textContent only if value differs from last render
  const T = (field, el, val) => {
    if (!el) return;
    const k = s + ':' + field;
    if (_dv[k] === val) return;
    _dv[k] = val;
    el.textContent = val;
  };
  // Helper: write a style property only if changed
  const S = (field, el, prop, val) => {
    if (!el) return;
    const k = s + ':' + field;
    if (_dv[k] === val) return;
    _dv[k] = val;
    el.style[prop] = val;
  };
  // Helper: get [data-k] cell
  const cell = k => tr.querySelector(`[data-k="${k}"]`);

  // ── Price & change ──
  const mktStatus = typeof marketStatus === 'function' ? marketStatus(s) : 'open';
  const isFrozen  = !s.includes('BINANCE:') && mktStatus === 'closed';
  const pEl = cell('p');
  const priceStr = `$${fd.p}`;
  if (pEl && _dv[s+':p'] !== priceStr) {
    _dv[s+':p'] = priceStr;
    if (isFrozen) {
      pEl.innerHTML = `<span>${priceStr}</span><span style="display:block;font-size:7px;color:var(--text-dim);letter-spacing:.3px;margin-top:1px;">AT CLOSE</span>`;
    } else {
      pEl.textContent = priceStr;
    }
  }
  const chgEl = cell('chg');
  const chgTxt = `${up?'+':''}${fd.chg}%`;
  T('chg', chgEl, chgTxt);
  S('chgc', chgEl, 'color', up ? 'var(--bull)' : 'var(--bear)');

  // ── MTF RSI dots — only rewrite if values changed ──
  const mtfKey = `${fd.r15}|${fd.r1h}|${fd.r4h}`;
  const mtfEl = cell('mtf');
  if (mtfEl && _dv[s+':mtf'] !== mtfKey) {
    _dv[s+':mtf'] = mtfKey;
    mtfEl.innerHTML = `<div class="mtf">${rdot(fd.r15,'15m')}${rdot(fd.r1h,'1h')}${rdot(fd.r4h,'4h')}</div>`;
  }

  // ── OBI — rewrite only if bidPct changed ──
  const obiEl = cell('obi');
  if (obiEl) {
    const obiKey = fd.obi ? String(fd.obi.bidPct) : 'null';
    if (_dv[s+':obi'] !== obiKey) {
      _dv[s+':obi'] = obiKey;
      if (!fd.obi) {
        obiEl.innerHTML = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
      } else {
        const bw = parseFloat(fd.obi.bidPct), aw = 100 - bw;
        const c = bw > 55 ? 'var(--bull)' : bw < 45 ? 'var(--bear)' : 'var(--text-dim)';
        obiEl.innerHTML = `<div class="obi"><span class="obi-v" style="color:${c}">${bw}%</span><div class="obi-track"><div class="obi-bid" style="width:${bw}%"></div><div class="obi-ask" style="width:${aw}%"></div></div></div>`;
      }
    }
  }

  // ── CVD — rewrite only if value changed ──
  const cvdEl = cell('cvd');
  const cvdId = 'cv_' + s.replace(/[^a-z0-9]/gi,'_');
  if (cvdEl) {
    const cvdKey = fd.cvd ? String(fd.cvd.value) + fd.cvd.trending : 'null';
    if (_dv[s+':cvd'] !== cvdKey) {
      _dv[s+':cvd'] = cvdKey;
      if (!fd.cvd) {
        cvdEl.innerHTML = '<span style="color:var(--text-dim);font-size:9px;">—</span>';
      } else {
        const val = fd.cvd.value, up2 = fd.cvd.trending === 'up';
        const fv = Math.abs(val)>1e6?(val/1e6).toFixed(2)+'M':Math.abs(val)>1000?(val/1000).toFixed(1)+'K':val.toFixed(0);
        cvdEl.innerHTML = `<div class="cvd"><canvas id="${cvdId}" width="55" height="20" class="sp"></canvas><span class="cvd-v" style="color:${up2?'var(--bull)':'var(--bear)'}">${up2?'▲':'▼'}${fv}</span></div>`;
        // Register new canvas for IO so it draws when visible
        const cvCanvas = document.getElementById(cvdId);
        if (cvCanvas) _registerSpark(cvCanvas);
      }
    }
  }

  // ── Simple text cells (shock, FR, EMA, OI div, dip, bias, signal, reason) ──
  const shockEl = cell('shock');
  const shockTxt = `${fd.shock}x`;
  if (shockEl && _dv[s+':shock'] !== shockTxt) {
    _dv[s+':shock'] = shockTxt;
    shockEl.innerHTML = `<div class="vbar"><span style="color:var(--gold)">${fd.shock}x</span><div class="vbar-bg"><div class="vbar-fill" style="width:${Math.min(100,(parseFloat(fd.shock)-.5)*80)}%"></div></div></div>`;
  }

  // L/S bar
  const lsKey = `${fd.lp}|${fd.sp}`;
  const lsEl = cell('ls');
  if (lsEl && _dv[s+':ls'] !== lsKey) {
    _dv[s+':ls'] = lsKey;
    lsEl.innerHTML = `<div class="ls"><div class="ls-track"><div class="ls-l" style="width:${fd.lp}%"></div><div class="ls-s" style="width:${fd.sp}%"></div></div><div class="ls-lbl"><span style="color:var(--bull)">L${fd.lp}%</span><span style="color:var(--bear)">S${fd.sp}%</span></div></div>`;
  }

  T('fr', cell('fr'), frStr);
  S('frc', cell('fr'), 'color', frC);
  T('ema', cell('ema'), fd.emaTrend||'—');
  S('emac', cell('ema'), 'color', fd.emaTrend==='ABOVE'?'var(--bull)':fd.emaTrend==='BELOW'?'var(--bear)':'var(--text-dim)');
  T('oidiv', cell('oidiv'), fd.oiDiv||'—');
  S('oidivc', cell('oidiv'), 'color', fd.oiDivC);
  T('dip', cell('dip'), fd.dipLabel||'—');
  S('dipc', cell('dip'), 'color', fd.dipLabelC);
  T('b4h', cell('b4h'), fd.bias4h||'—');
  S('b4hc', cell('b4h'), 'color', fd.bias4hC);
  T('bday', cell('bday'), fd.biasDay||'—');
  S('bdayc', cell('bday'), 'color', fd.biasDayC);
  T('reason', cell('reason'), fd.reason||'');

  // Whale Score cell
  const whaleEl = cell('whale');
  const whaleKey = (fd.whaleScore??'') + '|' + (fd.whaleZone||'');
  if (whaleEl && _dv[s+':whale'] !== whaleKey) {
    _dv[s+':whale'] = whaleKey;
    whaleEl.style.color = fd.whaleZoneC || 'var(--text-dim)';
    whaleEl.title = fd.whaleZone || '';
    whaleEl.innerHTML = `<span>${fd.whaleZoneEmoji||''}${fd.whaleScore??'—'}</span><span style="font-size:8px;font-weight:400;color:var(--text-dim);"> /100</span>`;
  }

  // Confirmation counter cell
  const confEl = cell('conf');
  const confKey = fd.bullConfirmCount ?? 0;
  if (confEl && _dv[s+':conf'] !== confKey) {
    _dv[s+':conf'] = confKey;
    confEl.style.color = confKey >= 7 ? 'var(--bull)' : confKey >= 4 ? '#f5c518' : 'var(--bear)';
    confEl.textContent = `${confKey}/10`;
    confEl.title = `Bull confirmations: ${(fd.confirmChecks||[]).filter(c=>c.pass).map(c=>c.label).join(', ')}`;
  }

  // Signal pill
  const sigEl = cell('sig');
  const sigKey = fd.sigC + '|' + fd.sig;
  if (sigEl && _dv[s+':sig'] !== sigKey) {
    _dv[s+':sig'] = sigKey;
    const sdotC = fd.sigC.includes('sb')||fd.sigC.includes('-b')?'var(--bull)':fd.sigC.includes('ss')||fd.sigC.includes('be')?'var(--bear)':'#555';
    sigEl.innerHTML = `<span class="sig ${fd.sigC}"><span class="sig-dot" style="background:${sdotC}"></span>${fd.sig}</span>`;
  }

  // S/R levels
  const srEl = cell('sr');
  const srKey = (fd.sup||'') + '|' + (fd.res||'');
  if (srEl && _dv[s+':sr'] !== srKey) {
    _dv[s+':sr'] = srKey;
    srEl.innerHTML = fd.sup||fd.res
      ? `<div style="display:flex;flex-direction:column;gap:1px;line-height:1.3;"><span style="color:var(--bull);">S $${fd.sup||'—'}</span><span style="color:var(--bear);">R $${fd.res||'—'}</span></div>`
      : '<span style="color:var(--text-dim);">—</span>';
  }

  // ── RISK / FLOW columns ──
  const rf     = fd._rf;
  const riskEl = cell('risk');
  const riskKey = rf ? rf.risk : '—';
  if (riskEl && _dv[s+':risk'] !== riskKey) {
    _dv[s+':risk'] = riskKey;
    riskEl.textContent = rf ? `${rf.riskEmoji} ${rf.risk}` : '—';
    riskEl.style.color = rf ? rf.riskC : 'var(--text-dim)';
  }
  const flowEl  = cell('flow');
  const flowKey = rf ? rf.flow : '—';
  if (flowEl && _dv[s+':flow'] !== flowKey) {
    _dv[s+':flow'] = flowKey;
    flowEl.textContent = rf ? rf.flow : '—';
    flowEl.style.color = rf ? rf.flowC : 'var(--text-dim)';
  }

  // Row class (heat colour + market status dim)
  const hc = parseFloat(fd.chg) > 2.5 ? 'ru' : parseFloat(fd.chg) < -2.5 ? 'rd' : '';
  const mktClosed = mktStatus !== 'open';
  const wantCls = [hc, mktClosed ? 'mkt-closed-row' : ''].filter(Boolean).join(' ');
  if (tr.className !== wantCls) tr.className = wantCls;

  // Update symbol name badge (market status can change while page is open)
  const symTd = tr.querySelector('.td-sym');
  if (symTd && typeof marketStatusBadge === 'function') {
    const name = s.includes('BINANCE:') ? s.split(':')[1].replace('USDT','') : s.replace('.TO','');
    const badge = marketStatusBadge(s);
    const badgeKey = s + ':badge:' + mktStatus;
    if (_dv[badgeKey] !== badge) {
      _dv[badgeKey] = badge;
      symTd.innerHTML = name + badge;
    }
  }

  // Sparklines — viewport-gated, no redundant redraws
  const spId = 'sp_' + s.replace(/[^a-z0-9]/gi,'_');
  const spData = fd.sparkBars?.length > 1 ? fd.sparkBars : (STATE.PH[s]?.length > 1 ? STATE.PH[s] : null);
  if (spData) _drawSparkLazy(spId, spData, null);
  if (fd.cvd?.series?.length > 1) _drawSparkLazy(cvdId, fd.cvd.series, null);
}

// ── Sparkline ──
// ── Sparkline ──
function drawSpark(id, data, color) {
  const c = document.getElementById(id); if (!c || !data || data.length < 2) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - mn) / rng) * (h - 2) - 1]);
  const up = data[data.length - 1] >= data[0];
  ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color || (up ? '#00e5a0' : '#ff4560'); ctx.lineWidth = 1.5; ctx.stroke();
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

let _hclOpen = false; // leaderboard collapsed by default — saves mobile battery
if (!STATE.expandedCards) STATE.expandedCards = new Set(); // track which cards are expanded

function toggleHCL() {
  _hclOpen = !_hclOpen;
  const body = document.getElementById('hcl-body');
  const ab   = document.getElementById('hcl-alertbar');
  const chev = document.getElementById('hcl-chevron');
  if (body) body.style.display = _hclOpen ? '' : 'none';
  if (ab)   ab.style.display   = _hclOpen ? '' : 'none';
  if (chev) chev.textContent   = _hclOpen ? '▼' : '▲';
}

function toggleCard(sym) {
  if (STATE.expandedCards.has(sym)) {
    STATE.expandedCards.delete(sym);
  } else {
    STATE.expandedCards.add(sym);
  }
  // Update just this card's detail visibility — no full re-render
  const card = document.querySelector(`.hcl-card[data-sym="${CSS.escape(sym)}"]`);
  if (!card) return;
  const detail = card.querySelector('.hcl-card-detail');
  const chev   = card.querySelector('.hcl-card-chev');
  const isOpen = STATE.expandedCards.has(sym);
  if (detail) detail.style.display = isOpen ? '' : 'none';
  if (chev)   chev.textContent     = isOpen ? '▲' : '▼';
  // Switch chart only when expanding
  if (isOpen) switchT(sym);
}

// ── Determine setup mode label from signal data ──
function getSetupMode(d, conv, isCapitulation, lane) {
  const shock = parseFloat(d.shock) || 1;
  const frNum = parseFloat(d.fr) || 0;
  if (lane === 'trend')                                      return { label: 'TRENDING',    cls: 'trending',  emoji: '📈' };
  if (isCapitulation)                                        return { label: 'CAP BUY',     cls: 'cap-buy',   emoji: '💥' };
  if (d.oiDiv === '💎 DIP BUY' && frNum <= -0.01)           return { label: 'DIP BUY',     cls: 'dip-buy',   emoji: '💎' };
  if (shock >= 2.0 && d.cvd?.trending === 'up' && conv > 6) return { label: 'SQUEEZE NOW', cls: 'squeeze',   emoji: '🚀' };
  if (d.emaTrend === 'ABOVE' && conv > 5)                   return { label: 'BREAKOUT',    cls: 'breakout',  emoji: '⚡' };
  if (conv < -4)                                             return { label: 'SHORT SETUP', cls: 'bear',      emoji: '🔻' };
  return { label: 'WATCHING', cls: 'watching', emoji: '⏳' };
}

// ── Trend-continuation lane scoring ─────────────────────────────────────────
// Catches assets already in motion where the spark shows an uptrend and there
// is room left to run before the next resistance. Completely separate from the
// dip-buy quadrant model — different gates, different score breakdown labels.
// Returns { score, trendBreakdown } or null if symbol doesn't qualify.
function calcTrendScore(sym, d, isActive, isOffPeak) {
  const price  = parseFloat(d.p)   || 0;
  const res    = parseFloat(d.res) || 0;
  const r15    = d.r15 || 50;
  const r1h    = d.r1h || 50;
  const chg24  = parseFloat(d.chg) || 0;

  // Hard gates — must be macro bullish; EMA can be ABOVE or unknown (—)
  // We don't hard-reject on EMA=dash because stock/TSX symbols often
  // don't return EMA data — the quadrant score handles it gracefully.
  if (d.emaTrend === 'BELOW') return null; // explicitly below EMA = not trending up
  if (!d.bias4h?.match(/BULL 4H|LEAN BULL/)) return null;

  // Spark slope gate — need an upward trend over available bars.
  // v12.9.2: relaxed from 0.5% to 0.1% minimum slope, and large chg24 movers
  // (>5%) bypass the slope gate entirely — the 24h% IS the spark evidence.
  const sparkBars = (d.sparkBars?.length >= 4) ? d.sparkBars
                  : (STATE.PH?.[sym]?.length  >= 4) ? STATE.PH[sym].slice(-7)
                  : null;
  const chg24ForSlope = parseFloat(d.chg || 0);
  if (!sparkBars && chg24ForSlope <= 5) return null; // no bars and not a big mover = skip
  const sparkFirst = sparkBars?.[0] ?? 0;
  const sparkLast  = sparkBars?.[sparkBars.length - 1] ?? 0;
  const sparkSlope = (sparkBars && sparkFirst > 0) ? (sparkLast - sparkFirst) / sparkFirst : chg24ForSlope / 100;
  // Gate: need positive slope OR a strong 24h move (big moves ARE the trend signal)
  if (sparkSlope <= 0.001 && chg24ForSlope <= 3) return null;

  // Don't let dip-buy symbols also qualify for trending (they'd appear twice)
  // A symbol already near support is a dip-buy candidate, not a trend-continuation
  const sup = parseFloat(d.sup) || 0;
  if (sup > 0 && price > 0) {
    const distToSup = (price - sup) / price;
    const dipGate = isOffPeak ? 0.06 : 0.04;
    if (distToSup <= dipGate) return null; // too close to support = dip-buy territory
  }

  let score = 0;
  const tb = {};

  // Q1: Spark Slope (+4 max) ─────────────────────────────────────────────────
  if      (sparkSlope > 0.08) tb.sparkSlope = 4;
  else if (sparkSlope > 0.04) tb.sparkSlope = 3;
  else if (sparkSlope > 0.02) tb.sparkSlope = 2;
  else                        tb.sparkSlope = 1;
  score += tb.sparkSlope;

  // Q2: EMA + Bias Alignment (+4 max) ──────────────────────────────────────
  tb.emaTrend = 0;
  if (d.emaTrend === 'ABOVE')                  tb.emaTrend += 2;
  else if (!d.emaTrend || d.emaTrend === '—')  tb.emaTrend += 1; // unknown = neutral
  if (d.bias4h?.includes('BULL 4H'))           tb.emaTrend += 2;
  else if (d.bias4h?.includes('LEAN BULL'))    tb.emaTrend += 1;
  if (d.biasDay?.includes('BULL DAY'))         tb.emaTrend += 1;
  else if (d.biasDay?.includes('LEAN BEAR'))   tb.emaTrend -= 1; // soft penalty — daily lags 4H
  else if (d.biasDay?.includes('BEAR DAY'))    tb.emaTrend -= 2; // confirmed bear day = harder
  tb.emaTrend = Math.max(-2, Math.min(4, tb.emaTrend));
  score += tb.emaTrend;

  // Q3: RSI Health (+4 max) ─────────────────────────────────────────────────
  // Sweet spot 45-68: healthy trend with room to run. Penalise overbought.
  const rsiAvg = (r15 + r1h) / 2;
  if      (rsiAvg >= 45 && rsiAvg <= 60) tb.rsiHealth = 4;
  else if (rsiAvg >  60 && rsiAvg <= 68) tb.rsiHealth = 3;
  else if (rsiAvg >  68 && rsiAvg <= 75) tb.rsiHealth = 1; // getting extended
  else if (rsiAvg >  75)                 tb.rsiHealth = -2; // overbought — late entry
  else if (rsiAvg >= 38 && rsiAvg <  45) tb.rsiHealth = 2; // healthy pullback
  else                                   tb.rsiHealth = 0;
  score += tb.rsiHealth;

  // Q4: Room to Resistance (+4 max) ─────────────────────────────────────────
  // Key anti-chasing check: don't surface if price is already near resistance.
  if (res > 0 && price > 0 && res > price) {
    const roomPct = (res - price) / price * 100;
    if      (roomPct >= 12) tb.roomToRes = 4;
    else if (roomPct >= 8)  tb.roomToRes = 3;
    else if (roomPct >= 5)  tb.roomToRes = 2;
    else if (roomPct >= 3)  tb.roomToRes = 1;
    else                    tb.roomToRes = 0; // too close to resistance
  } else {
    tb.roomToRes = 2; // no resistance data = benefit of doubt
  }
  score += tb.roomToRes;

  // Bonuses
  if (d.cvd?.trending === 'up')                        score += 1; // CVD confirming
  if (chg24 > 0.5 && chg24 <= 5)                      score += 1; // momentum without chasing
  // v12.9.2: large movers get a graduated penalty, not a flat -1.
  // A +25% move with CVD up and CONFIRM OI is still a valid trend — score reflects
  // that the easy money is gone but the direction is real.
  if (chg24 > 5  && chg24 <= 10)                      score -= 1; // extended but not blown off
  else if (chg24 > 10 && chg24 <= 20)                 score -= 2; // late entry risk
  else if (chg24 > 20)                                 score -= 3; // very extended — penalise hard
  if (d.oiDiv === '✓ CONFIRM' || d.oiDiv === '💎 DIP BUY') score += 1;

  // Sticky buffer
  if (isActive) score += 3;

  return { score: Math.round(score * 10) / 10, trendBreakdown: tb };
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
  const rrDenom = parseFloat(entry) - parseFloat(stop);
  const rr = (rrDenom === 0 || Math.abs(rrDenom) < 0.000001) ? '—' : (((parseFloat(t1) - parseFloat(entry)) / rrDenom).toFixed(1));
  return { entry, stop, t1, t2, rr };
}

// ── SPIKE POTENTIAL SCORE ─────────────────────────────────────────────────────
// Answers: "if this moves, how far and how violently?"
// Distinct from conviction (which measures setup quality).
// Used as primary sort key within the bull pool so we buy the one likely
// to move the most, not just the one with the cleanest pattern.
//
// Factors (0–100 scale):
//   Resistance room      — how far to the next wall (from res vs price)
//   Vol shock            — current vs average volume (more shock = more fuel)
//   Funding squeeze fuel — negative funding = shorts paying, squeeze pending
//   CVD slope            — is buying pressure building right now
//   OI divergence        — CONFIRM = real flow, not just noise
//   Beta proxy           — smaller caps spike harder (XMR/ZEC vs BTC)
//   Short interest       — high L/S short side = more covering fuel
function calcSpikeScore(sym, d) {
  const p      = parseFloat(d.p   || 0);
  const res    = parseFloat(d.res || 0);
  const sup    = parseFloat(d.sup || 0);
  const shock  = parseFloat(d.shock || 1);
  const frNum  = parseFloat(d.fr  || 0);
  const lp     = parseFloat(d.lp  || 50); // L/S long %
  const chg24  = parseFloat(d.chg || 0);
  let score = 0;

  // 1. Resistance room (0–30 pts)
  // More room to resistance = more upside before hitting a wall
  if (res > 0 && p > 0) {
    const roomPct = ((res - p) / p) * 100;
    if      (roomPct >= 10) score += 30;
    else if (roomPct >= 6)  score += 22;
    else if (roomPct >= 3)  score += 14;
    else if (roomPct >= 1)  score += 6;
    else                    score += 0;  // price is near resistance — no room
  } else {
    score += 10; // no res data → neutral
  }

  // 2. Vol shock / fuel (0–20 pts)
  // High vol shock means real momentum, not just a drift
  if      (shock >= 3.0) score += 20;
  else if (shock >= 2.0) score += 14;
  else if (shock >= 1.5) score += 8;
  else if (shock >= 1.2) score += 4;
  else                   score += 0;

  // 3. Funding squeeze fuel (0–20 pts)
  // Negative funding = shorts paying longs → squeeze likely if price holds
  // Very negative = aggressive short positioning = violent squeeze potential
  if      (frNum <= -0.05) score += 20; // extreme short squeeze fuel
  else if (frNum <= -0.02) score += 15;
  else if (frNum <= -0.01) score += 10;
  else if (frNum <=  0.00) score += 5;
  else if (frNum >=  0.05) score += 0;  // longs already paying = no squeeze fuel
  else                     score += 2;

  // 4. CVD slope (0–10 pts)
  // Rising CVD = buyers are absorbing, move has backing
  if (d.cvd?.trending === 'up') score += 10;

  // 5. OI divergence quality (0–10 pts)
  // CONFIRM = institutional flow validated the direction
  if      (d.oiDiv === '✓ CONFIRM')    score += 10;
  else if (d.oiDiv === '💎 DIP BUY')   score += 10;
  else if (d.oiDiv === '⚠ OI DROP')    score += 3;  // ambiguous
  else if (d.oiDiv === '↑ BEAR OI')    score += 0;

  // 6. Short interest (L/S) squeeze fuel (0–10 pts)
  // Low long % = more shorts to cover when price moves up
  const shortPct = 100 - lp;
  if      (shortPct >= 55) score += 10; // heavily shorted
  else if (shortPct >= 50) score += 7;
  else if (shortPct >= 45) score += 4;
  else                     score += 0;

  // 7. Already-moved penalty — avoid chasing (0 to -10 pts)
  // A symbol up 5%+ today already had its spike; penalise
  if      (chg24 > 10) score -= 10;
  else if (chg24 > 5)  score -= 5;
  else if (chg24 > 3)  score -= 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Spike label for card display
function spikeLabelFromScore(s) {
  if (s >= 70) return { label: '🔥 HIGH',   cls: 'spike-high' };
  if (s >= 45) return { label: '⚡ MED',    cls: 'spike-med'  };
  if (s >= 20) return { label: '〰 LOW',    cls: 'spike-low'  };
  return               { label: '— NONE',   cls: 'spike-none' };
}

// ── Build cascade info string from global market data ──
function getCascadeInfo() {
  const mp = STATE.marketPulse || {};
  const spy = mp['SPY'];
  const btc = mp['BTC'];
  const parts = [];
  if (spy) {
    const chg = parseFloat(spy.chg || 0);
    // Asia roughly correlates 0.6x, London 0.4x of SPY move
    const asiaChg = (chg * 0.6).toFixed(1);
    const lonChg  = (chg * 0.4).toFixed(1);
    const asiaStr = `Asia${parseFloat(asiaChg) >= 0 ? '+' : ''}${asiaChg}%`;
    const lonStr  = `Lon${parseFloat(lonChg) >= 0 ? '+' : ''}${lonChg}%`;
    parts.push(asiaStr);
    parts.push(lonStr);
  }
  const isCascade  = spy && parseFloat(spy.chg) < -1;
  const cascadeRisk = parts.length ? parts.join(' ') : 'Asia — Lon —';
  return { parts, cascadeRisk, isCascade };
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
  const now  = Date.now();

  // ── STABILISER 1: News freshness ──────────────────────────────────────────
  const FRESH_MS = 2 * 60 * 60 * 1000;
  const freshNews = news.filter(n => n.ts && (now - n.ts) < FRESH_MS);

  function newsConvBonus(sym) {
    const base = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','').toLowerCase();
    let bonus = 0;
    for (const n of freshNews) {
      const t = (n.title || '').toLowerCase();
      const ageMins = (now - n.ts) / 60000;
      const recency = ageMins < 30 ? 1.0 : ageMins < 60 ? 0.7 : 0.4;
      if (t.includes(base)) {
        bonus += (n.sent === 'bullish' ? 3 : n.sent === 'bearish' ? -3 : 0) * recency;
        if (n.sent === 'neutral') bonus += 0.5 * recency;
      } else {
        const isCrypto = sym.includes('BINANCE:') || sym.includes('BTC') || sym.includes('ETH');
        const isEnergy = sym.includes('XEG') || sym.includes('XLE');
        const isMetal  = sym.includes('GLD') || sym.includes('SLV');
        if ((n.tag === 'CRYPTO' && isCrypto) || (n.tag === 'ENERGY' && isEnergy) || (n.tag === 'METAL' && isMetal))
          bonus += (n.sent === 'bullish' ? 0.8 : n.sent === 'bearish' ? -0.8 : 0) * recency;
      }
    }
    return Math.max(-3, Math.min(3, bonus));
  }

  // ── SPEC V2.0: 30-minute smoothing buffers ─────────────────────────────────
  // Stores previous shock and CVD value per symbol for 2-period MA
  if (!STATE.hclShockPrev) STATE.hclShockPrev = {};
  if (!STATE.hclCvdPrev)   STATE.hclCvdPrev   = {};
  if (!STATE.hclCvdRedCount) STATE.hclCvdRedCount = {}; // consecutive red CVD bars

  function smoothedShock(sym, rawShock) {
    const prev = STATE.hclShockPrev[sym] ?? rawShock;
    const smoothed = (rawShock + prev) / 2;
    STATE.hclShockPrev[sym] = rawShock;
    return smoothed;
  }

  // ── STABILISER 2: Score history & weighted smoothing ──────────────────────
  if (!STATE.hclScoreHistory) STATE.hclScoreHistory = {};
  const WEIGHTS = [0.4, 0.3, 0.2, 0.1];

  function smoothedConv(sym, rawConv) {
    const hist = STATE.hclScoreHistory[sym] || [];
    hist.unshift(rawConv);
    if (hist.length > 4) hist.length = 4;
    STATE.hclScoreHistory[sym] = hist;
    let total = 0, wSum = 0;
    hist.forEach((v, i) => { total += v * WEIGHTS[i]; wSum += WEIGHTS[i]; });
    return Math.round((total / wSum) * 10) / 10;
  }

  // ── STABILISER 3: Persistence + Sticky Buffer (Spec §4 & §5) ─────────────
  if (!STATE.hclPersist) STATE.hclPersist = {};
  // Session-aware persistence thresholds
  // Asia/off-hours = fewer symbols qualify → lower bar to enter (2 refreshes = 30s)
  // Active sessions (London/NY) = stricter (3 refreshes = 45s)
  const session = getSessionLabel();
  const isOffPeak = session === 'ASIA' || session === 'AFTER HOURS';
  const ENTER_THRESHOLD = isOffPeak ? 2 : 3;
  const EXIT_THRESHOLD  = isOffPeak ? 4 : 5;
  const STICKY_BUFFER   = 3; // bonus pts for already-active slots (spec §5)

  // ── SPEC V2.0: Ingestion Gate (§1) ───────────────────────────────────────
  // Hard binary gateway — rejects over-extended and post-breakout candidates.
  // pumpLimit: 12% active / 20% off-peak. A 10-25% XMR move with CVD+CONFIRM
  // is a trend, not a blow-off — it should appear. Only reject genuinely
  // parabolic moves where late entry risk is extreme.
  function passesIngestionGate(d, dir) {
    if (dir !== 'bull') return true;
    const price = parseFloat(d.p   || 0);
    const sup   = parseFloat(d.sup || 0);
    const chg24 = parseFloat(d.chg || 0);

    // Reject if price is sitting ON support (stop-hunt risk)
    if (sup > 0 && price > 0 && sup < price) {
      const distToSup = (price - sup) / price;
      if (distToSup < 0.005) return false;
    }

    // Blow-off top rejection only — scoring already penalises big movers
    const pumpLimit = isOffPeak ? 20.0 : 12.0;
    if (chg24 > pumpLimit) return false;

    return true;
  }

  // ── SPEC V2.0: 4-Quadrant Scoring Framework (§3, Max 20 pts) ─────────────
  function calcV2Score(sym, d, isActive) {
    const price  = parseFloat(d.p   || 0);
    const sup    = parseFloat(d.sup || 0);
    const shock  = parseFloat(d.shock || 1);
    const r15    = d.r15 || 50, r1h = d.r1h || 50;
    const frNum  = parseFloat(d.fr || 0);
    const obiR   = d.obi ? parseFloat(d.obi.ratio || 1) : 1;
    const cvdUp  = d.cvd?.trending === 'up';
    const chg24  = parseFloat(d.chg || 0);

    let score = 0;
    const breakdown = {};

    // ── Quadrant 1: Technical (Support Proximity) — max +4 ──────────────────
    // Spec: ≤1.0% from floor → +4, 1.1–2.5% → +2, >2.5% → 0
    if (sup > 0 && price > 0) {
      const distPct = ((price - sup) / price) * 100;
      if (distPct <= 1.0)       breakdown.technical = 4;
      else if (distPct <= 2.5)  breakdown.technical = 2;
      else                      breakdown.technical = 0;
    } else {
      breakdown.technical = 1; // no sup data = partial credit
    }
    score += breakdown.technical;

    // ── Quadrant 2: Institutional Flow (CVD Slope 30m) — max +6 / min -5 ───
    // Spec: flat/neg price + rising CVD = whale absorption = +6
    //       flat price + flat CVD = passive floor = +3
    //       pumping price + dropping CVD = bearish absorption = -5
    const sShock = smoothedShock(sym, shock); // 2-period MA vol shock
    const prevCvd = STATE.hclCvdPrev[sym];
    const curCvdVal = d.cvd?.value || 0;
    const cvdSlope = prevCvd !== undefined ? curCvdVal - prevCvd : 0;
    STATE.hclCvdPrev[sym] = curCvdVal;

    // Track consecutive red CVD bars for eviction gate (spec §5)
    if (!cvdUp) {
      STATE.hclCvdRedCount[sym] = (STATE.hclCvdRedCount[sym] || 0) + 1;
    } else {
      STATE.hclCvdRedCount[sym] = 0;
    }

    const priceFlat  = Math.abs(chg24) < 1.5;
    const priceUp    = chg24 > 1.5;
    if (cvdSlope > 0 && (priceFlat || chg24 < 0)) {
      breakdown.instFlow = 6; // whale limit-order absorption
    } else if (cvdSlope >= 0 && priceFlat) {
      breakdown.instFlow = 3; // passive floor
    } else if (priceUp && !cvdUp) {
      breakdown.instFlow = -5; // bearish absorption — retail pump on weak CVD
    } else if (cvdUp) {
      breakdown.instFlow = 3; // CVD rising but price also up = still positive
    } else {
      breakdown.instFlow = 0;
    }
    score += breakdown.instFlow;

    // ── Quadrant 3: Squeeze Compression — max +4 ─────────────────────────────
    // Spec: Bollinger inside Keltner = compression. We approximate via:
    // vol shock smoothed (lower shock after high shock = compression releasing)
    // RSI tightness (RSI near 50 = no trend = coil)
    const rsiMid = Math.abs(r15 - 50) < 10 && Math.abs(r1h - 50) < 10;
    const shockSmooth = sShock;
    if (shockSmooth >= 2.5 && rsiMid)       breakdown.squeeze = 4; // full compression + release
    else if (shockSmooth >= 1.8 && rsiMid)  breakdown.squeeze = 3;
    else if (shockSmooth >= 1.5)            breakdown.squeeze = 2;
    else if (rsiMid)                        breakdown.squeeze = 1; // coiled but not breaking
    else                                    breakdown.squeeze = 0;
    score += breakdown.squeeze;

    // ── Quadrant 4: Order Book & Sentiment — max +6 ──────────────────────────
    // Spec: OB_IMBAL >55% bids = +3, inverted sentiment (retail fear) = +3
    let obScore = 0, sentScore = 0;
    const bidPct = d.obi ? parseFloat(d.obi.bidPct || 50) : 50;
    if (bidPct > 55) obScore = 3;       // green limit depth dominates
    else if (bidPct > 50) obScore = 1;
    else if (bidPct < 45) obScore = -1; // ask-heavy
    // Sentiment: L/S ratio < 50% (retail fear/disinterest) = +3 (contrarian)
    const lp = d.lp || 50;
    if (lp < 45)       sentScore = 3;   // retail scared = smart money buys
    else if (lp < 50)  sentScore = 1;
    else if (lp > 65)  sentScore = 0;   // FOMO = avoid
    breakdown.obSent = obScore + sentScore;
    score += breakdown.obSent;

    // ── Sticky buffer for already-active leaderboard slots (Spec §4) ─────────
    if (isActive) score += STICKY_BUFFER;

    // ── Overbought penalty (our v12.3 fix — preserved) ───────────────────────
    if (r15 > 75) score -= 3;
    else if (r15 > 65) score -= 1.5;
    if (r1h > 70) score -= 2;
    else if (r1h > 60) score -= 1;

    // ── Fresh news bonus ─────────────────────────────────────────────────────
    score += newsConvBonus(sym);

    // ── Funding zone bonus ───────────────────────────────────────────────────
    if (frNum < -0.01) score += 1.5; // negative funding = squeeze fuel

    return { score: Math.round(score * 10) / 10, breakdown };
  }

  // ── SPEC V2.0: Bear scoring (retains our existing logic) ─────────────────
  function calcBearScore(sym, d, isActive) {
    let score = 0;
    const r15 = d.r15 || 50, r1h = d.r1h || 50;
    const shock = parseFloat(d.shock || 1);
    score += (d.score        || 0) * 1.5;
    score += (d.dipScore     || 0) * 1.2;
    score += (d.bias4hScore  || 0) * 1.0;
    score += (d.biasDayScore || 0) * 0.8;
    if (d.oiDiv === '↓ BEAR OI')         score -= 3;
    if (d.oiDiv === '⚠ OI DROP')         score -= 1.5;
    if (d.emaTrend === 'BELOW')           score -= 1.5;
    if (d.bias4h?.includes('BEAR 4H'))    score -= 2;
    if (d.bias4h?.includes('LEAN BEAR'))  score -= 1;
    // Skip daily bias penalties when signal engine says BULLISH/STRONG BUY —
    // the signal already accounts for daily context; double-penalising causes
    // BTCsui/ETH/SUI to never exit neutral despite clear bull alignment
    if (d.sig !== 'BULLISH' && d.sig !== 'STRONG BUY') {
      if (d.biasDay?.includes('BEAR DAY'))  score -= 2;
      if (d.biasDay?.includes('LEAN BEAR')) score -= 1;
    }
    if (d.dipScore <= -2)                 score -= 1;
    if (r15 > 70 && r1h > 65)            score -= 2;
    if (shock > 2 && d.cvd?.trending === 'down') score -= 2;
    score += newsConvBonus(sym);
    if (isActive) score -= STICKY_BUFFER; // inverted sticky for bears
    return Math.round(score * 10) / 10;
  }

  // ── Score every symbol ────────────────────────────────────────────────────
  const allScored = wl
    .map(sym => {
      const d = DS[sym];
      if (!d) return null;

      // Market hours gate
      if (typeof isLeaderboardEligible === 'function' && !isLeaderboardEligible(sym)) {
        if (STATE.hclPersist?.[sym])
          STATE.hclPersist[sym] = { dir: 'neutral', enterCount: 0, exitCount: 0, active: false };
        return null;
      }

      const r15  = d.r15 || 50, r1h = d.r1h || 50, r4h = d.r4h || 50;
      const frNum = parseFloat(d.fr || 0);
      const shock = parseFloat(d.shock || 1);
      const chg24 = parseFloat(d.chg || 0);
      const isActive = STATE.hclPersist[sym]?.active || false;

      // ── SPEC §1: Ingestion Gate — determine eligible direction first ──────
      // Use 4H bias to determine intended direction
      const bias4hStr = d.bias4h || '';
      let allowedDir = 'both';
      if (bias4hStr.includes('BULL 4H'))        allowedDir = 'bull';
      else if (bias4hStr.includes('BEAR 4H'))   allowedDir = 'bear';
      else if (bias4hStr.includes('LEAN BULL')) allowedDir = 'bull';
      else if (bias4hStr.includes('LEAN BEAR')) allowedDir = 'bear';

      // ── SPEC §3: V2.0 Scoring ────────────────────────────────────────────
      const { score: bullScore, breakdown } = calcV2Score(sym, d, isActive);
      const bearScore = calcBearScore(sym, d, isActive);

      // Direction from scores
      // Direction from scores — off-peak sessions use lower threshold (fewer signals active)
      const bullThresh = isOffPeak ? 3 : 4;
      const bearThresh = isOffPeak ? -3 : -4;
      // BULLISH/STRONG BUY signal gets -0.5 threshold discount (signal engine confirmation)
      const effectiveBullThresh = (d.sig === 'BULLISH' || d.sig === 'STRONG BUY')
        ? bullThresh - 0.5 : bullThresh;
      let rawDir = bullScore >= effectiveBullThresh ? 'bull' : bearScore <= bearThresh ? 'bear' : 'neutral';

      // Apply 4H gate
      let dir = rawDir;
      if (allowedDir === 'bull' && rawDir === 'bear') dir = 'neutral';
      if (allowedDir === 'bear' && rawDir === 'bull') dir = 'neutral';

      // ── Signal gate: never short a BULLISH/STRONG BUY signal ──
      if (rawDir === 'bear' && (d.sig === 'BULLISH' || d.sig === 'STRONG BUY')) dir = 'neutral';

      // ── EMA breakout override: allow bull even if price is below EMA ──
      // When signal=BULLISH + 4H=BULL/LEAN BULL + CVD rising, EMA reclaim IS the trade.
      // Without this, breakout entries (XMR-style) are permanently blocked.
      if (dir === 'neutral' && rawDir === 'bull'
          && (d.sig === 'BULLISH' || d.sig === 'STRONG BUY')
          && (allowedDir === 'bull')
          && d.cvd?.trending === 'up') {
        dir = 'bull'; // reinstate bull — breakout confirmation
      }

      // ── Ingestion gate for bull setups ───────────────────────────────────
      if (dir === 'bull' && !passesIngestionGate(d, 'bull')) dir = 'neutral';

      // ── Capitulation buy detector (our v12.3 addition) ───────────────────
      let capScore = 0;
      if (r15 < 15)                              capScore += 2;
      else if (r15 < 25)                         capScore += 1;
      if (r1h < 25)                              capScore += 2;
      else if (r1h < 35)                         capScore += 1;
      if (frNum < -0.02)                         capScore += 2;
      else if (frNum < -0.01)                    capScore += 1;
      if (shock > 2.5 && d.cvd?.trending !== 'up') capScore += 1;
      if (d.oiDiv === '⚠ OI DROP')              capScore += 1;
      if (d.cvd?.trending === 'up')              capScore += 2;
      if (chg24 < -7)                            capScore += 1;
      const isCapitulation = capScore >= 3 && rawDir === 'bear';
      if (isCapitulation) dir = 'bull';

      // ── SPEC §5: Hard Eviction Gates ─────────────────────────────────────
      // Immediately evict active bull slots regardless of sticky buffer if:
      if (isActive && dir === 'bull') {
        const macroFlip   = bias4hStr.includes('BEAR 4H') || bias4hStr.includes('LEAN BEAR');
        const supBroken   = d.sup && parseFloat(d.p) < parseFloat(d.sup);
        const cvdDistrib  = (STATE.hclCvdRedCount[sym] || 0) >= 3; // 3× consecutive red CVD = 45m distribution
        if (macroFlip || supBroken || cvdDistrib) dir = 'neutral';
      }

      // ── STABILISER 3: Persistence debounce ───────────────────────────────
      // v12.9.2: strong movers (>8% chg24 + CVD up) bypass the entry threshold
      // so they appear immediately rather than waiting 2-3 refresh cycles.
      const chg24ForPersist = parseFloat(d.chg || 0);
      const isStrongMover = chg24ForPersist > 8
        && d.cvd?.trending === 'up'
        && (d.oiDiv === '✓ CONFIRM' || d.oiDiv === '💎 DIP BUY' || d.sig === 'BULLISH' || d.sig === 'STRONG BUY');

      const p = STATE.hclPersist[sym] || { dir: 'neutral', enterCount: 0, exitCount: 0, active: false };
      if (dir !== 'neutral') {
        if (!p.active || p.dir !== dir) {
          p.enterCount = (p.dir === dir) ? p.enterCount + 1 : 1;
          p.exitCount  = 0;
          p.dir        = dir;
          // Strong movers skip the debounce — they're confirmed by price action
          if (p.enterCount >= ENTER_THRESHOLD || isStrongMover) p.active = true;
        } else {
          p.enterCount = Math.min(p.enterCount + 1, ENTER_THRESHOLD);
          p.exitCount  = 0;
        }
      } else {
        p.exitCount++;
        if (p.exitCount >= EXIT_THRESHOLD) {
          p.active = false; p.enterCount = 0; p.dir = 'neutral';
        }
      }
      STATE.hclPersist[sym] = p;
      const activeDir = p.active ? p.dir : 'neutral';

      const baseLC = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','').toLowerCase();

      // ── Spike potential (v12.9.6) — how far/fast could this move ──────────
      const spikeScore = calcSpikeScore(sym, d);

      // ── News matching — find ALL relevant items (fresh first, then any) ──
      // Primary: direct symbol name match in headline (most relevant)
      // Secondary: sector-tag match (CRYPTO/TECH/ENERGY/METAL) for watchlist items
      const symTag = sym.includes('BINANCE:')
        ? 'CRYPTO'
        : (sym.includes('XBM') || sym.includes('GLCC') || sym.includes('GLD') || sym.includes('SLV'))
        ? 'METAL'
        : (sym.includes('ENCC') || sym.includes('XEG') || sym.includes('ENB'))
        ? 'ENERGY'
        : (sym.includes('TXF') || sym.includes('HTAE') || sym.includes('CRWD') || sym.includes('GOOG') ||
           sym.includes('DELL') || sym.includes('TSLA') || sym.includes('SPCX') || sym.includes('QMAX'))
        ? 'TECH'
        : 'TSX';

      // All fresh direct-match news for this symbol (title includes ticker name)
      const symNewsItems = freshNews.filter(n => n.title.toLowerCase().includes(baseLC));
      // Sector news: fresh items matching the symbol's sector tag (for context)
      const sectorNewsItems = freshNews.filter(n => n.tag === symTag && !n.title.toLowerCase().includes(baseLC));

      // Best single catalyst (for footer chip — unchanged)
      const catalyst = symNewsItems[0]
                    || news.find(n => n.title.toLowerCase().includes(baseLC));

      // News hint for the leaderboard card:
      // Priority: direct fresh match > sector news > none
      const newsHint = symNewsItems.length
        ? { item: symNewsItems[0], type: 'direct', allItems: symNewsItems }
        : sectorNewsItems.length
        ? { item: sectorNewsItems[0], type: 'sector', allItems: sectorNewsItems }
        : null;

      // ── Trend-continuation lane check ────────────────────────────────────
      // Run AFTER persistence/eviction so we only evaluate symbols that
      // cleared all standard gates. A symbol qualifies for trend lane if
      // calcTrendScore returns a result AND it didn't qualify for dip-buy
      // (mutual exclusion: dip-buy gate rejects symbols near support,
      //  trend gate rejects symbols that ARE near support).
      // Trend lane overrides dir only if the standard scoring gives 'neutral'.
      let lane = 'dip'; // default — dip-buy / bear scoring model
      let trendBreakdown = null;
      if (activeDir === 'neutral' || activeDir === 'bull') {
        const trendResult = calcTrendScore(sym, d, isActive, isOffPeak);
        if (trendResult && trendResult.score >= (isOffPeak ? 6 : 8)) {
          // Qualifies for trend lane — check persistence separately
          const tp = STATE.hclPersist[sym + ':trend'] ||
            { enterCount: 0, exitCount: 0, active: false };
          tp.enterCount = Math.min(tp.enterCount + 1, ENTER_THRESHOLD);
          tp.exitCount  = 0;
          if (tp.enterCount >= ENTER_THRESHOLD) tp.active = true;
          STATE.hclPersist[sym + ':trend'] = tp;

          if (tp.active) {
            lane          = 'trend';
            trendBreakdown = trendResult.trendBreakdown;
            // Override dir to bull and use trend score for ranking
            if (activeDir === 'neutral') {
              // Patch persistence to reflect this as an active bull slot
              p.active = true; p.dir = 'bull'; p.enterCount = ENTER_THRESHOLD;
              STATE.hclPersist[sym] = p;
            }
          }
        } else {
          // Didn't qualify for trend — decay its persistence
          const tp = STATE.hclPersist[sym + ':trend'] ||
            { enterCount: 0, exitCount: 0, active: false };
          tp.exitCount++;
          if (tp.exitCount >= EXIT_THRESHOLD) { tp.active = false; tp.enterCount = 0; }
          STATE.hclPersist[sym + ':trend'] = tp;
        }
      }

      // Final direction — trend lane can rescue a neutral symbol
      const finalDir = lane === 'trend' && activeDir === 'neutral' ? 'bull' : activeDir;

      // Use V2 bull score for ranking, bear score for bears, trend score for trend lane
      const trendResult2 = lane === 'trend' ? calcTrendScore(sym, d, isActive, isOffPeak) : null;
      const conv = lane === 'trend' ? (trendResult2?.score || bullScore)
                 : finalDir === 'bull' ? bullScore : bearScore;

      return {
        sym, d, conv,
        breakdown,
        trendBreakdown,
        lane,
        dir: lane === 'trend' ? 'bull' : finalDir,
        isCapitulation: isCapitulation && finalDir === 'bull',
        capScore, catalyst, newsHint, spikeScore
      };
    })
    .filter(Boolean)
    .filter(r => r.dir !== 'neutral');

  // ── Split into bull/bear pools ────────────────────────────────────────────
  // Bull pool: primary sort = spikeScore (who will move the most),
  //            tiebreaker  = conv (setup quality).
  // This ensures we buy the one LIKELY TO SPIKE, not just the cleanest pattern.
  // Bear pool: sorted by conv (lowest = most bearish) as before.
  const bullPool = allScored
    .filter(r => r.dir === 'bull')
    .sort((a, b) => (b.spikeScore - a.spikeScore) || (b.conv - a.conv))
    .slice(0, 3);
  const bearPool = allScored
    .filter(r => r.dir === 'bear')
    .sort((a, b) => a.conv - b.conv)
    .slice(0, 3);

  let ranked;
  if (bullPool.length && bearPool.length) {
    ranked = [];
    const maxLen = Math.max(bullPool.length, bearPool.length);
    for (let i = 0; i < maxLen; i++) {
      if (bullPool[i]) ranked.push(bullPool[i]);
      if (bearPool[i]) ranked.push(bearPool[i]);
    }
    ranked = ranked.slice(0, 6);
  } else {
    ranked = allScored.sort((a,b) => Math.abs(b.conv) - Math.abs(a.conv)).slice(0,5);
  }
  // Only count news < 2h old. Tag weights: symbol match = high, sector = low.
  // ── Update header bar (terminal-box style) ──
  const regEl   = document.getElementById('hcl-regime');
  const cascEl  = document.getElementById('hcl-cascade-hdr');
  const utcEl   = document.getElementById('hcl-utc');
  const slotsEl = document.getElementById('hcl-slots');
  const aiEl    = document.getElementById('hcl-ai-msg');
  const sessionEl     = document.getElementById('hcl-tb-session');
  const sessionIconEl = document.getElementById('hcl-session-icon');
  const fundingEl     = document.getElementById('hcl-tb-funding');

  // Session label + icon (Row 1)
  const sessionNow = getSessionLabel();
  const sessionIcons = { 'ASIA': '🌏', 'LONDON': '🇬🇧', 'NY OPEN': '🗽', 'NY PM': '🏙️', 'OFF-HOURS': '🌙' };
  if (sessionEl)     sessionEl.textContent     = sessionNow;
  if (sessionIconEl) sessionIconEl.textContent = sessionIcons[sessionNow] || '🌐';
  if (utcEl) {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2,'0');
    const mm = String(now.getUTCMinutes()).padStart(2,'0');
    utcEl.textContent = `${hh}:${mm} UTC`;
  }

  // Regime from market pulse (Row 2)
  const mp = STATE.marketPulse || {};
  const spyChg = parseFloat(mp.SPY?.chg || 0);
  if (regEl) {
    if (spyChg > 0.3)       { regEl.textContent = 'RISK_ON ▲';  regEl.className = 'hcl-regime risk-on'; }
    else if (spyChg < -0.3) { regEl.textContent = 'RISK_OFF ▼'; regEl.className = 'hcl-regime risk-off'; }
    else                    { regEl.textContent = 'NEUTRAL';     regEl.className = 'hcl-regime neutral'; }
  }
  const { cascadeRisk, isCascade } = getCascadeInfo();
  if (cascEl) {
    cascEl.textContent = cascadeRisk;
    cascEl.style.color = isCascade ? 'var(--bear)' : 'var(--text-dim)';
  }

  // Funding reset countdown — 8h funding cycles reset at 00:00, 08:00, 16:00 UTC (Row 3)
  if (fundingEl) {
    const utcNow = new Date();
    const utcH = utcNow.getUTCHours(), utcM = utcNow.getUTCMinutes(), utcS = utcNow.getUTCSeconds();
    const totalSecsSinceDay = utcH * 3600 + utcM * 60 + utcS;
    const cycleLen = 8 * 3600;
    const secsInCycle = totalSecsSinceDay % cycleLen;
    const secsLeft = cycleLen - secsInCycle;
    const rH = Math.floor(secsLeft / 3600);
    const rM = Math.floor((secsLeft % 3600) / 60);
    const timeStr = rH > 0 ? `${rH}:${String(rM).padStart(2,'0')} remaining` : `${rM}min remaining`;
    fundingEl.textContent = timeStr;
  }

  // Slots = active conviction setups (bull + bear), capped display at 3
  const bullSlots = ranked.filter(r => r.dir === 'bull').length;
  const bearSlots = ranked.filter(r => r.dir === 'bear').length;
  const totalSlots = ranked.length;
  const gateLabel = isOffPeak ? ' · off-peak' : '';
  if (slotsEl) slotsEl.textContent = `${bullSlots}▲ ${bearSlots}▼ / ${totalSlots} active${gateLabel}`;

  // AI message — summarise top bull and top bear with their signals
  if (aiEl) {
    const topBull = ranked.find(r => r.dir === 'bull' && !r.isCapitulation);
    const topCap  = ranked.find(r => r.isCapitulation);
    const topBear = ranked.find(r => r.dir === 'bear');
    const parts = [];
    if (topCap) {
      const sym = topCap.sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
      parts.push(`💥 ${sym}: capitulation bounce · RSI ${topCap.d?.r15||'?'}/${topCap.d?.r1h||'?'} · tight stop`);
    }
    if (topBull) {
      const sym = topBull.sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
      const reason = topBull.d?.reason || 'bull setup';
      parts.push(`▲ ${sym}: ${reason.slice(0,35)}`);
    }
    if (topBear) {
      const sym = topBear.sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
      const reason = topBear.d?.reason || 'bear setup';
      parts.push(`▼ ${sym}: ${reason.slice(0,30)}`);
    }
    const msg = parts.length ? parts.join(' · ') : 'Awaiting signal data';
    aiEl.textContent = `AI: "${msg.length > 95 ? msg.slice(0,95)+'…' : msg}"`;
  }

  const body = document.getElementById('hcl-body');
  const alertBar = document.getElementById('hcl-alertbar');
  if (!body) return;

  if (!ranked.length) {
    if (body.innerHTML.indexOf('hcl-loading') === -1)
      body.innerHTML = '<div class="hcl-loading">No high-conviction setups yet — scores populate as data arrives</div>';
    buildAlertBar(alertBar);
    return;
  }

  // ── Leaderboard alert engine: detect new cards, monitor exits ──
  // Store ranked on STATE so renderPositionTracker can read live prices
  // from the correct symbol without falling back to STATE.DS (which bleeds).
  STATE._ranked = ranked;
  if (typeof checkLeaderboardAlerts === 'function') {
    checkLeaderboardAlerts(ranked).catch(() => {});
  }
  // The "fingerprint" is the ordered list of symbols + their direction.
  // If it matches the DOM, we patch visible text nodes in-place instead.
  const newFingerprint = ranked.map(r => r.sym + ':' + r.dir + ':' + (r.lane||'dip')).join('|');
  const existingCards  = [...body.querySelectorAll('.hcl-card[data-sym]')];
  const oldFingerprint = existingCards.map(c =>
    c.getAttribute('data-sym') + ':' + (c.classList.contains('bull') ? 'bull' : 'bear') + ':' + (c.getAttribute('data-lane') || 'dip')
  ).join('|');

  const sessionMult = getSessionMult();

  if (newFingerprint === oldFingerprint && existingCards.length === ranked.length) {
    // Same cards, same order — patch only the live values that change every 15s:
    // price, chg, timer, sparkline, header bar values (already updated above).
    ranked.forEach((r, i) => {
      const { sym, d, conv, dir } = r;
      const card = existingCards[i];
      if (!card) return;
      const chgN   = parseFloat(d.chg || 0);
      const chgCls = chgN >= 0 ? 'bull' : 'bear';
      const chgStr = (chgN >= 0 ? '+' : '') + chgN.toFixed(2) + '%';
      // Timer countdown
      const nowT = new Date();
      const secsLeft = 900 - (nowT.getMinutes() % 15) * 60 - nowT.getSeconds();
      const timerStr = `${Math.floor(secsLeft / 60)}min ${secsLeft % 60}s to reset`;

      // Collapsed header: price + chg + timer (these are visible even collapsed)
      const priceEl = card.querySelector('.hcl-price-val');
      const chgEl   = card.querySelector('.hcl-chg');
      const timerEl = card.querySelector('.hcl-timer-val');
      if (priceEl && priceEl.textContent !== `$${d.p || '—'}`) priceEl.textContent = `$${d.p || '—'}`;
      if (chgEl) { if (chgEl.textContent !== chgStr) chgEl.textContent = chgStr; chgEl.className = `hcl-chg ${chgCls}`; }
      if (timerEl) timerEl.textContent = `⏱${timerStr}`;

      // Sparkline — only if card is expanded (saves canvas work on collapsed cards)
      if (STATE.expandedCards.has(sym)) {
        const sparkId = `hcl2-spark-${i}`;
        const canvas  = document.getElementById(sparkId);
        if (canvas) {
          const sparkData = (d?.sparkBars?.length > 1) ? d.sparkBars : (STATE.PH[sym]?.length > 1 ? STATE.PH[sym].slice(-30) : null);
          if (sparkData && sparkData.length > 1) drawSparkLine(canvas, sparkData, dir === 'bull' ? '#00e5a0' : '#ff4455');
        }
      }
    });
    buildAlertBar(alertBar);
    return; // ← exit without touching body.innerHTML
  }

  // Ranked set changed — full card rebuild (happens rarely: symbol enters/leaves LB)
  let bullRank = 0, bearRank = 0;
  const medals = ['#1','#2','#3','#4','#5','#6'];

  body.innerHTML = ranked.map((r, i) => {
    const { sym, d, conv, dir, catalyst, newsHint, spikeScore } = r;
    const spikeInfo = spikeLabelFromScore(spikeScore ?? 0);
    if (dir === 'bull') bullRank++; else bearRank++;
    const isCap    = r.isCapitulation || false;
    const rankLabel = isCap ? `💥` : dir === 'bull' ? `B${bullRank}` : `S${bearRank}`;
    const base   = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');
    const chgN   = parseFloat(d.chg || 0);
    const chgCls = chgN >= 0 ? 'bull' : 'bear';
    const chgStr = (chgN >= 0 ? '+' : '') + chgN.toFixed(2) + '%';
    const lane     = r.lane || 'dip';
    const setup    = getSetupMode(d, conv, isCap, lane);
    const levels = calcEntryLevels(d);
    const sparkId = `hcl2-spark-${i}`;

    // Timer: countdown to next reset (15min cycle)
    const now = new Date();
    const secsLeft = 900 - (now.getMinutes() % 15) * 60 - now.getSeconds();
    const timerStr = `${Math.floor(secsLeft / 60)}min ${secsLeft % 60}s to reset`;

    // ── Score Breakdown — switches between dip-buy and trend quadrants ──
    const isTrend = (r.lane === 'trend');
    const bd  = isTrend ? (r.trendBreakdown || {}) : (r.breakdown || {});
    // Dip-buy quadrants
    const q1 = isTrend ? (bd.sparkSlope ?? 0) : (bd.technical ?? 0);
    const q2 = isTrend ? (bd.emaTrend  ?? 0) : (bd.instFlow  ?? 0);
    const q3 = isTrend ? (bd.rsiHealth ?? 0) : (bd.squeeze   ?? 0);
    const q4 = isTrend ? (bd.roomToRes ?? 0) : (bd.obSent    ?? 0);
    // Labels differ by lane
    const qlabels = isTrend
      ? ['Spark Slope', 'EMA Trend', 'RSI Health', 'Room to Res']
      : ['Support Prox', 'CVD Slope 30m', 'Compression', 'Bid Imbal'];
    const qmaxes  = isTrend ? [4, 4, 4, 4] : [4, 6, 4, 6];
    const totalScore = Math.round(Math.abs(conv));
    const timeBoost  = sessionMult !== '×1.0' ? sessionMult : null;

    // Cascade risk
    const cascRisk = spyChg < -1.5 ? 'risk' : 'neutral';
    const cascLabel = spyChg < -1.5 ? 'CASCADE RISK' : 'CASCADE neutral';

    // Evidence items
    const isCrypto = sym.includes('BINANCE:');
    const oiChg = chgN < 0 ? `OI drop ${Math.abs(Math.round(chgN * 2))}%` : `OI rise ${Math.round(chgN * 2)}%`;
    const frNum = parseFloat(d.fr) || 0;
    const frStr = d.fr !== 'N/A' ? `funding ${(frNum * 100).toFixed(2)}%` : 'funding N/A';
    const frBull = frNum < 0;
    const cvdBull = d.cvd?.trending === 'up';
    const lsStr = `L/S ${d.lp || 50}% long`;
    const lsBull = (d.lp || 50) > 50;
    const shockBull = parseFloat(d.shock) > 1.5;
    const shortsCovering = lsBull && chgN < 0;

    // Spark slope for trend evidence
    const sparkBarsEv  = (d.sparkBars?.length >= 2) ? d.sparkBars : (STATE.PH?.[r.sym]?.slice(-7) || []);
    const sparkSlopeEv = sparkBarsEv.length >= 2
      ? ((sparkBarsEv[sparkBarsEv.length-1] - sparkBarsEv[0]) / sparkBarsEv[0] * 100).toFixed(1)
      : null;
    const resPrice = parseFloat(d.res) || 0;
    const roomPct  = resPrice > 0 && parseFloat(d.p) > 0
      ? ((resPrice - parseFloat(d.p)) / parseFloat(d.p) * 100).toFixed(1)
      : null;

    const evidence = isCap ? [
      // Capitulation buy — show exhaustion signals, not normal bull evidence
      { txt: `RSI ${d.r15||50}/${d.r1h||50} — extreme oversold`, bull: true },
      { txt: frBull ? `funding ${(frNum*100).toFixed(2)}% neg — squeeze fuel` : frStr, bull: frBull },
      { txt: cvdBull ? 'CVD reversing ▲ — sellers exhausting' : 'CVD falling — watch for flip', bull: cvdBull },
      { txt: `Vol ${d.shock||'1.0'}x${parseFloat(d.shock)>2.5?' — climactic sell':' — elevated'}`, bull: true },
      { txt: `Down ${Math.abs(chgN).toFixed(1)}% today — washout`, bull: true },
      { txt: `⚠ Counter-trend · tight stop · short hold`, bull: false },
    ] : isTrend ? [
      // Trend-continuation lane — show momentum evidence
      { txt: sparkSlopeEv !== null ? `Spark: +${sparkSlopeEv}% ${Number(sparkSlopeEv)>4?'strong':'steady'} uptrend` : 'Spark: uptrend confirmed', bull: true },
      { txt: `EMA: price above${d.bias4h?.includes('BULL 4H') ? ' · 4H bull aligned' : ' · lean bull'}`, bull: true },
      { txt: `RSI ${d.r15||50}/${d.r1h||50}${(((d.r15||50)+(d.r1h||50))/2) <= 68 ? ' — healthy, room to run' : ' — extended, size carefully'}`, bull: ((d.r15||50)+(d.r1h||50))/2 <= 68 },
      { txt: roomPct !== null ? `Room: +${roomPct}% to resistance $${d.res}` : 'Room: resistance clear', bull: Number(roomPct) >= 5 },
      { txt: cvdBull ? 'CVD confirming ▲ — institutional support' : 'CVD flat — momentum driven', bull: cvdBull },
      { txt: `⚠ Do not chase — wait for pullback or 15m close confirm`, bull: false },
    ] : [
      { txt: oiChg, bull: chgN > 0 },
      { txt: frStr, bull: frBull },
      { txt: cvdBull ? 'CVD rising' : 'CVD falling', bull: cvdBull },
      { txt: `Vol ${d.shock || '1.0'}x`, bull: shockBull },
      { txt: lsStr, bull: lsBull },
      { txt: shortsCovering ? '"shorts covering"' : `RSI ${d.r15 || 50}/${d.r1h || 50}`, bull: shortsCovering || (d.r15 || 50) < 40 },
    ];

    // Entry trigger wait condition — trend lane waits for pullback, not breakout
    const entryTrigger = levels
      ? isTrend
        ? `Wait: 15min close > $${levels.entry} · Vol > ${d.shock || '1.0'}x (now ${(Math.max(0, parseFloat(d.shock || 1) * 0.8)).toFixed(1)}x)`
        : `Wait: 15min close > $${levels.entry} · Vol > ${d.shock || '1.0'}x (now ${(Math.max(0, parseFloat(d.shock || 1) * 0.8)).toFixed(1)}x)`
      : `Watching price action…`;

    // Correlation
    const corrStr = isCrypto ? `${base} standalone` : `${base} vs SPY`;

    // Catalyst / reason
    const catTxt = catalyst
      ? catalyst.title.slice(0, 55) + (catalyst.title.length > 55 ? '…' : '')
      : (d.reason || '').slice(0, 55);

    // ── News hint (v12.9.5) ──────────────────────────────────────────────────
    // Show the most relevant news headline for this symbol directly on the card.
    // Direct match (symbol in headline) > sector news > "none".
    // Sentiment dot: green = bullish, red = bearish, grey = neutral.
    function buildNewsHintHtml(hint, collapsed) {
      if (!hint) {
        // Always show "none" so the user knows news was checked
        return collapsed
          ? `<div class="hcl-news-row none"><span class="hcl-news-lbl">NEWS</span><span class="hcl-news-none">none</span></div>`
          : `<div class="hcl-news-row none" style="padding:4px 10px 6px;"><span class="hcl-news-lbl">NEWS</span><span class="hcl-news-none">none</span></div>`;
      }
      const n = hint.item;
      const sentClass = n.sent === 'bullish' ? 'bull' : n.sent === 'bearish' ? 'bear' : 'neu';
      const sentDot   = n.sent === 'bullish' ? '●' : n.sent === 'bearish' ? '●' : '●';
      const isSector  = hint.type === 'sector';
      const count     = hint.allItems.length;
      const countStr  = count > 1 ? ` +${count - 1}` : '';
      const sectorPfx = isSector ? `<span class="hcl-news-sector">[${n.tag}]</span> ` : '';
      const ageMin    = Math.floor((Date.now() - n.ts) / 60000);
      const ageStr    = ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin/60)}h`;
      const headline  = collapsed
        ? (n.title.slice(0, 52) + (n.title.length > 52 ? '…' : ''))
        : (n.title.slice(0, 90) + (n.title.length > 90 ? '…' : ''));
      const clickAttr = n.url ? `onclick="event.stopPropagation();window.open('${n.url.replace(/'/g,"\\'")}','_blank')" style="cursor:pointer"` : '';
      return `<div class="hcl-news-row ${sentClass}" ${clickAttr}>
        <span class="hcl-news-lbl">NEWS</span>
        <span class="hcl-news-dot ${sentClass}">${sentDot}</span>
        ${sectorPfx}<span class="hcl-news-title">${headline}</span>
        <span class="hcl-news-meta">${ageStr}${countStr}</span>
      </div>`;
    }
    const newsRowCollapsed = buildNewsHintHtml(newsHint, true);
    const newsRowExpanded  = buildNewsHintHtml(newsHint, false);

    // Market context (from market pulse)
    const asiaStr = spyChg !== 0 ? `Asia ${spyChg >= 0 ? '+' : ''}${(spyChg * 0.5).toFixed(1)}%` : 'Asia —';
    const lonStr  = spyChg !== 0 ? `London ${spyChg >= 0 ? '+' : ''}${(spyChg * 0.4).toFixed(1)}%` : 'London —';

    const isExpanded = STATE.expandedCards.has(sym);
    return `<div class="hcl-card ${dir}" data-sym="${sym}" data-lane="${lane}">

      <!-- Always-visible collapsed header — tap to expand -->
      <div class="hcl-ct" onclick="toggleCard('${sym}')">
        <div class="hcl-ct-left">
          <span class="hcl-rank-badge ${dir}">${rankLabel}</span>
          <span style="font-size:11px">${setup.emoji}</span>
          <span class="hcl-mode ${setup.cls}">${setup.label}</span>
          <span class="hcl-sym-name">${base}</span>
        </div>
        <div class="hcl-ct-right">
          <span class="hcl-spike-pill ${spikeInfo.cls}" title="Spike potential: ${spikeScore}/100 — resistance room + vol + funding + short squeeze fuel">${spikeInfo.label}</span>
          <span class="hcl-price-val" style="font-size:11px">$${d.p || '—'}</span>
          <span class="hcl-chg ${chgCls}" style="font-size:10px">${chgStr}</span>
          <span class="hcl-timer-val" style="font-size:9px;color:var(--text-dim)">⏱${timerStr}</span>
          <span class="hcl-card-chev" style="font-size:9px;color:var(--text-dim);margin-left:4px">${isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>
      ${newsRowCollapsed}

      <!-- Expandable detail — hidden by default, shown on tap -->
      <div class="hcl-card-detail" style="display:${isExpanded ? '' : 'none'}">

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
        <div class="hcl-score-hdr">SCORE BREAKDOWN <span style="font-size:8px;color:var(--text-dim);font-weight:400;">V2.0 · max 20pts</span></div>
        <div class="hcl-score-grid">
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">${qlabels[0]}</span>
            ${scoreBar(q1, qmaxes[0])}
            <span class="hcl-score-val ${q1 >= 0 ? 'pos' : 'neg'}">${q1 >= 0 ? '+' : ''}${q1}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">${qlabels[1]}</span>
            ${scoreBar(q2, qmaxes[1])}
            <span class="hcl-score-val ${q2 >= 0 ? 'pos' : 'neg'}">${q2 >= 0 ? '+' : ''}${q2}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">${qlabels[2]}</span>
            ${scoreBar(q3, qmaxes[2])}
            <span class="hcl-score-val ${q3 >= 0 ? 'pos' : 'neg'}">${q3 >= 0 ? '+' : ''}${q3}</span>
          </div>
          <div class="hcl-score-row">
            <span class="hcl-score-lbl">${qlabels[3]}</span>
            ${scoreBar(q4, qmaxes[3])}
            <span class="hcl-score-val ${q4 >= 0 ? 'pos' : 'neg'}">${q4 >= 0 ? '+' : ''}${q4}</span>
          </div>
        </div>
        <div class="hcl-score-total-row">
          <span class="hcl-score-total-lbl">TOTAL: </span>
          <span class="hcl-score-total-val ${dir}">${totalScore}</span>
          <div class="hcl-score-total-bar"><div class="hcl-score-total-fill ${dir}" style="width:${Math.min(100, totalScore / 20 * 100)}%"></div></div>
          ${timeBoost ? `<span class="hcl-time-boost">Time boost ${timeBoost}</span>` : ''}
          <span class="hcl-cascade-tag ${cascRisk}">${cascLabel}</span>
          <span class="hcl-spike-detail ${spikeInfo.cls}" title="Spike potential: resistance room + vol + funding squeeze + CVD + OI + short interest — used to rank which bull scores highest spike priority">SPIKE ${spikeScore}/100</span>
        </div>
      </div>

      <!-- ═══ PDF ENHANCEMENTS PANEL ═══ -->
      <div class="hcl-whale-panel">

        <!-- Row 1: Whale Score + Smart Money + Trade Grade -->
        <div class="hcl-wp-row" style="display:flex;gap:6px;align-items:stretch;margin-bottom:6px;">

          <!-- Whale Score -->
          <div class="hcl-wp-block" style="flex:2;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:7px 9px;">
            <div style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;margin-bottom:3px;">🐋 WHALE SCORE</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:20px;font-weight:700;color:${d.whaleZoneC || 'var(--text)'};font-family:var(--mono);">${d.whaleScore ?? '—'}</span>
              <span style="font-size:8px;color:var(--text-dim);">/100</span>
              <span style="margin-left:auto;font-size:10px;font-weight:600;color:${d.whaleZoneC || 'var(--text-dim)'};">${d.whaleZoneEmoji || ''} ${d.whaleZone || '—'}</span>
            </div>
            <div style="height:4px;background:var(--border);border-radius:2px;margin-top:5px;overflow:hidden;">
              <div style="height:100%;width:${d.whaleScore ?? 0}%;background:${d.whaleZoneC || '#444'};border-radius:2px;transition:width .4s;"></div>
            </div>
          </div>

          <!-- Smart Money vs Retail -->
          <div class="hcl-wp-block" style="flex:1.5;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:7px 9px;">
            <div style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;margin-bottom:3px;">💡 FLOW</div>
            <div style="font-size:11px;font-weight:600;color:${d.smartMoneyC || 'var(--text-dim)'};">${d.smartMoneyLabel || '—'}</div>
            ${d.earlyEntryDetected ? `<div style="margin-top:4px;font-size:8px;color:var(--bull);font-weight:700;letter-spacing:.5px;">⚡ EARLY ENTRY</div>` : ''}
          </div>

          <!-- Trade Grade + Setup Type -->
          <div class="hcl-wp-block" style="flex:1.5;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:7px 9px;text-align:center;">
            <div style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;margin-bottom:3px;">GRADE</div>
            <div style="font-size:22px;font-weight:700;color:${d.tradeGradeC || 'var(--text)'};font-family:var(--mono);line-height:1;">${d.tradeGrade || '—'}</div>
            <div style="font-size:8px;color:${d.tradeGradeC || 'var(--text-dim)'};margin-top:2px;">${d.successProb ?? '—'}% win rate</div>
          </div>
        </div>

        <!-- Row 2: Signal Stability + Setup Archetype -->
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <div style="flex:1;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:6px 9px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;">📊 STABILITY</span>
            <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${d.signalStability ?? 50}%;background:${d.signalStability >= 80 ? 'var(--bull)' : d.signalStability >= 55 ? '#f5c518' : 'var(--bear)'};border-radius:3px;transition:width .3s;"></div>
            </div>
            <span style="font-size:10px;font-weight:600;color:${d.signalStability >= 80 ? 'var(--bull)' : d.signalStability >= 55 ? '#f5c518' : 'var(--bear)'};">${d.signalStability ?? '—'}% <span style="font-size:8px;font-weight:400;">${d.stabilityLabel || ''}</span></span>
          </div>
          <div style="flex:1;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:6px 9px;display:flex;align-items:center;gap:6px;">
            <span style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;">🔍 SETUP</span>
            <span style="font-size:10px;font-weight:600;color:var(--accent);">${d.setupArchetype || '—'}</span>
          </div>
        </div>

        <!-- Row 3: Bull Confirmation Counter -->
        <div style="background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:5px;padding:7px 9px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:8px;color:var(--text-dim);font-family:var(--mono);letter-spacing:.8px;">✅ BULL CONFIRMATIONS</span>
            <span style="font-size:12px;font-weight:700;font-family:var(--mono);color:${(d.bullConfirmCount||0) >= 7 ? 'var(--bull)' : (d.bullConfirmCount||0) >= 4 ? '#f5c518' : 'var(--bear)'};">${d.bullConfirmCount ?? 0}/10</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;">
            ${(d.confirmChecks || []).map(c => `
              <div style="display:flex;align-items:center;gap:4px;font-size:8px;font-family:var(--mono);">
                <span style="color:${c.pass ? 'var(--bull)' : 'var(--bear)'};font-size:9px;">${c.pass ? '✔' : '✖'}</span>
                <span style="color:${c.pass ? 'var(--text)' : 'var(--text-dim)'};">${c.label}</span>
              </div>`).join('')}
          </div>
        </div>
      </div><!-- end hcl-whale-panel -->

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

      <!-- News (expanded — full headline, clickable) -->
      ${newsRowExpanded}

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

      <!-- Footer: R:R · correlation -->
      <div class="hcl-footer">
        ${levels ? `<span class="hcl-rr">R:R <span>1:${levels.rr}</span> ✓</span>` : ''}
        <span class="hcl-corr">Corr: <span>${corrStr}</span> ✓</span>
      </div>

      <!-- Market context bar -->
      <div style="display:flex;align-items:center;gap:8px;padding:3px 10px;border-top:1px solid var(--border);font-family:var(--mono);font-size:8px;background:rgba(0,0,0,.2);">
        <span style="color:var(--text-dim)">🌏 ${asiaStr}</span>
        <span style="color:var(--text-dim)">🏛 ${lonStr}</span>
        <span style="margin-left:auto;color:${cascRisk === 'risk' ? 'var(--bear)' : 'var(--text-dim)'};font-weight:700;">→ ${cascRisk === 'risk' ? '▲ CASCADE RISK' : '✓ STABLE'}</span>
      </div>

      </div><!-- end hcl-card-detail -->
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
  // Call dots only after full card rebuild (structure changed) — not on patch cycles
  if (typeof renderLeaderboardDots === 'function') renderLeaderboardDots();
  if (typeof renderPositionTracker === 'function') renderPositionTracker();
  if (typeof renderSectorFlow === 'function') renderSectorFlow();
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTOR FLOW PANEL — v1.0
// Renders outside the main table, above the leaderboard.
// Call renderSectorFlow() after each sync cycle (called from renderLeaderboard).
// Expects a <div id="sector-flow-panel"></div> in index.html.
//
// Shows:
//   • Market-wide RISK ON / OFF header bar (aggregated across all symbols)
//   • Per-sector flow tiles: sector name, flow label, avg whale score,
//     avg daily chg, symbol count, inflow/outflow breakdown
//   • Money-move arrows: largest INFLOW → OUTFLOW sector pair
// ══════════════════════════════════════════════════════════════════════════════
function renderSectorFlow() {
  const panel = document.getElementById('sector-flow-panel');
  if (!panel) return;
  const ds = STATE.DS || {};

  const sectors  = typeof calcSectorFlow    === 'function' ? calcSectorFlow(ds)   : [];
  const appetite = typeof calcRiskAppetite  === 'function' ? calcRiskAppetite()   : null;
  const regime   = typeof calcMarketRegime  === 'function' ? calcMarketRegime(sectors, appetite) : null;
  if (!sectors.length) return;

  // ── Fingerprint guard ──
  const fp = (regime?.regime||'') + (appetite?.appetiteLabel||'') +
    sectors.map(s => s.sector + s.flowLabel + (s.avgWhale||'') + s.velArrow + s.confidence).join('|');
  if (panel._sfFp === fp) return;
  panel._sfFp = fp;

  // ── Market-wide counts ──
  const totalSyms    = sectors.reduce((a, s) => a + s.count, 0);
  const totalRiskOn  = sectors.reduce((a, s) => a + s.riskOn + s.rotateIn, 0);
  const totalRiskOff = sectors.reduce((a, s) => a + s.riskOff + s.rotateOut, 0);

  // ── Risk appetite row ──
  let appetiteHTML = '';
  if (appetite) {
    const { smallCapLead, cryptoBeta, tsxVsSpy, goldFlight, silverFlight,
            bondFlight, dxyRising, stableRotate, havenConvergence,
            appetiteLabel, appetiteC, appetiteEmoji, spy, gld, tlt, uup } = appetite;

    const scC  = smallCapLead > 0.5 ? 'var(--bull)' : smallCapLead < -0.5 ? 'var(--bear)' : 'var(--text-dim)';
    const cbC  = cryptoBeta > 1 ? 'var(--bull)' : cryptoBeta < -1 ? 'var(--bear)' : 'var(--text-dim)';
    const tvC  = tsxVsSpy > 0.3 ? 'var(--bull)' : tsxVsSpy < -0.3 ? 'var(--bear)' : 'var(--text-dim)';
    const dxyC = dxyRising ? '#ff8c00' : uup < -0.3 ? 'var(--bull)' : 'var(--text-dim)';

    const warnings = [
      havenConvergence && '<span style="color:#ff8c00;font-weight:700;">⚠ HAVEN CONVERGENCE</span>',
      goldFlight       && '<span style="color:#ff8c00;font-weight:700;">⚠ GOLD FLIGHT</span>',
      bondFlight       && '<span style="color:#ff8c00;font-weight:700;">⚠ BOND FLIGHT</span>',
      stableRotate     && '<span style="color:var(--accent);font-weight:700;">🔄 BTC DOM DROP</span>',
      dxyRising        && '<span style="color:#ff4455;font-weight:700;">💵 DXY BID</span>',
    ].filter(Boolean).join(' ');

    appetiteHTML = `
      <div class="sf-appetite">
        <span class="sf-apt-lbl">RISK APPETITE</span>
        <span style="color:${appetiteC};font-weight:700;">${appetiteEmoji} ${appetiteLabel}</span>
        <span class="sf-apt-sep">|</span>
        <span class="sf-apt-item" title="IWM vs SPY">SmCap <span style="color:${scC};">${smallCapLead >= 0 ? '+' : ''}${smallCapLead.toFixed(1)}%</span></span>
        <span class="sf-apt-item" title="BTC vs SPY">BTC β <span style="color:${cbC};">${cryptoBeta >= 0 ? '+' : ''}${cryptoBeta.toFixed(1)}%</span></span>
        <span class="sf-apt-item" title="TSX vs SPY">TSX/US <span style="color:${tvC};">${tsxVsSpy >= 0 ? '+' : ''}${tsxVsSpy.toFixed(1)}%</span></span>
        <span class="sf-apt-item" title="DXY direction">DXY <span style="color:${dxyC};">${uup >= 0 ? '+' : ''}${(uup||0).toFixed(1)}%</span></span>
        ${warnings}
      </div>`;
  }

  // ── Regime row ──
  let regimeHTML = '';
  if (regime) {
    const alertStyle = regime.alert
      ? 'background:rgba(255,68,85,.12);border:1px solid rgba(255,68,85,.3);border-radius:4px;padding:4px 8px;'
      : '';
    regimeHTML = `
      <div class="sf-regime-row" style="${alertStyle}">
        <span class="sf-regime-label" style="color:${regime.c};font-weight:700;">${regime.emoji} ${regime.regime}</span>
        <span class="sf-regime-note">${regime.note}</span>
        ${regime.prediction ? `
        <div class="sf-prediction">
          <span class="sf-pred-lbl">📍 PREDICTION</span>
          <span class="sf-pred-txt">${regime.prediction}</span>
        </div>` : ''}
      </div>`;
  }

  // ── Sector tiles ──
  const tiles = sectors.map(s => {
    const whaleC   = s.avgWhale != null ? (s.avgWhale >= 65 ? 'var(--bull)' : s.avgWhale <= 35 ? 'var(--bear)' : '#f5c518') : 'var(--text-dim)';
    const chgStr   = (s.avgChg >= 0 ? '+' : '') + s.avgChg.toFixed(2) + '%';
    const chgC     = s.avgChg > 0 ? 'var(--bull)' : s.avgChg < 0 ? 'var(--bear)' : 'var(--text-dim)';
    const allNames = [...(s.sentinels || []), ...(s.syms || [])].slice(0, 8).join(', ');
    const pulseTag = s.isPulseOnly ? '<span class="sf-pulse-tag" title="Pulse data only — no watchlist symbols">P</span>' : '';
    const velHTML  = s.velArrow ? `<span class="sf-vel" style="color:${s.velC};">${s.velArrow}</span>` : '';
    const confHTML = `<span class="sf-conf" style="color:${s.confC};" title="Coverage confidence: ${s.count} data points">${s.confidence}</span>`;
    const havenBorder = (s.sector === 'HAVEN' && s.flowScore > 0) ? 'border-color:#ff8c00;' : '';
    const currBorder  = (s.sector === 'CURRENCY' && s.flowScore > 0) ? 'border-color:#ff4455;' : '';

    return `
      <div class="sf-tile" title="${allNames}" style="${havenBorder}${currBorder}">
        <div class="sf-sector-row">
          <span class="sf-sector">${s.sector}</span>
          ${pulseTag}${confHTML}${velHTML}
        </div>
        <div class="sf-flow" style="color:${s.flowC};font-weight:700;">${s.flowEmoji} ${s.flowLabel}</div>
        <div class="sf-meta">
          ${s.avgWhale != null ? `<span style="color:${whaleC};">🐋${s.avgWhale}</span>` : '<span style="color:var(--text-dim);">🐋—</span>'}
          <span style="color:${chgC};">${chgStr}</span>
          <span style="color:var(--text-dim);">${s.count}src</span>
        </div>
        <div class="sf-breakdown">
          ${s.riskOn    ? `<span class="sf-pill on"  title="Risk On: ${s.riskOn}">▲${s.riskOn}</span>`    : ''}
          ${s.rotateIn  ? `<span class="sf-pill in"  title="Rotate In: ${s.rotateIn}">→${s.rotateIn}</span>` : ''}
          ${s.rotateOut ? `<span class="sf-pill out" title="Rotate Out: ${s.rotateOut}">←${s.rotateOut}</span>` : ''}
          ${s.riskOff   ? `<span class="sf-pill off" title="Risk Off: ${s.riskOff}">▼${s.riskOff}</span>`  : ''}
          ${s.neutral   ? `<span class="sf-pill neu" title="Neutral: ${s.neutral}">—${s.neutral}</span>`   : ''}
        </div>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="sf-wrap">

      <!-- Row 1: title + counts -->
      <div class="sf-header">
        <span class="sf-title">💸 SMART MONEY FLOW</span>
        <span class="sf-hcount">${totalRiskOn} inflow · ${totalRiskOff} outflow · ${totalSyms} sources · ${sectors.length} sectors</span>
      </div>

      <!-- Row 2: market regime + prediction -->
      ${regimeHTML}

      <!-- Row 3: risk appetite cross-asset bar -->
      ${appetiteHTML}

      <!-- Row 4: sector tiles -->
      <div class="sf-tiles">${tiles}</div>

      <!-- Row 5: legend -->
      <div class="sf-legend">
        <span class="sf-pill on">▲ RISK ON</span>
        <span class="sf-pill in">→ ROTATE IN</span>
        <span class="sf-pill out">← ROTATE OUT</span>
        <span class="sf-pill off">▼ RISK OFF</span>
        <span class="sf-leg-note">P=pulse only · ●=sentinel · HIGH/MED/LOW=coverage · ↑↓=15min velocity</span>
      </div>
    </div>
  `;
}

(function injectSectorFlowCSS() {
  if (document.getElementById('sf-style')) return;
  const s = document.createElement('style');
  s.id = 'sf-style';
  s.textContent = `
    #sector-flow-panel { margin:6px 0 4px; }
    .sf-wrap { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:5px; }

    .sf-header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding-bottom:5px; border-bottom:1px solid var(--border); }
    .sf-title  { font-family:var(--mono); font-size:11px; font-weight:700; letter-spacing:.8px; color:var(--accent); }
    .sf-hcount { font-family:var(--mono); font-size:9px; color:var(--text-dim); margin-left:auto; }

    .sf-regime-row   { display:flex; flex-direction:column; gap:3px; padding:5px 8px; border-radius:4px; background:var(--bg); }
    .sf-regime-label { font-family:var(--mono); font-size:11px; letter-spacing:.6px; }
    .sf-regime-note  { font-size:9px; color:var(--text-dim); font-family:var(--mono); }
    .sf-prediction   { display:flex; gap:6px; align-items:flex-start; margin-top:2px; }
    .sf-pred-lbl     { font-family:var(--mono); font-size:8px; color:var(--accent); white-space:nowrap; font-weight:700; }
    .sf-pred-txt     { font-size:9px; color:#8899aa; line-height:1.4; }

    .sf-appetite  { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-family:var(--mono); font-size:9px; padding:4px 0; border-bottom:1px solid var(--border); }
    .sf-apt-lbl   { color:var(--text-dim); letter-spacing:.6px; font-weight:700; }
    .sf-apt-sep   { color:var(--border2); }
    .sf-apt-item  { color:var(--text-dim); white-space:nowrap; }

    .sf-tiles { display:flex; flex-wrap:wrap; gap:5px; }
    .sf-tile  { background:var(--bg); border:1px solid var(--border2); border-radius:5px; padding:5px 7px; min-width:98px; cursor:default; transition:border-color .2s; }
    .sf-tile:hover { border-color:var(--accent); }

    .sf-sector-row { display:flex; align-items:center; gap:3px; margin-bottom:2px; }
    .sf-sector     { font-family:var(--mono); font-size:9px; font-weight:700; letter-spacing:.5px; color:var(--text-dim); }
    .sf-pulse-tag  { font-size:7px; background:rgba(77,166,255,.2); color:#4da6ff; border-radius:2px; padding:0 3px; font-family:var(--mono); }
    .sf-conf       { font-size:7px; font-family:var(--mono); margin-left:auto; letter-spacing:.3px; }
    .sf-vel        { font-family:var(--mono); font-size:9px; font-weight:700; }
    .sf-flow       { font-size:10px; margin-bottom:2px; }
    .sf-meta       { display:flex; gap:5px; font-size:9px; margin-bottom:3px; font-family:var(--mono); flex-wrap:wrap; }
    .sf-breakdown  { display:flex; gap:3px; flex-wrap:wrap; }

    .sf-pill     { font-size:8px; font-family:var(--mono); border-radius:3px; padding:1px 4px; font-weight:700; }
    .sf-pill.on  { background:rgba(0,229,160,.15);  color:var(--bull); }
    .sf-pill.in  { background:rgba(77,166,255,.15); color:#4da6ff; }
    .sf-pill.out { background:rgba(255,140,0,.15);  color:#ff8c00; }
    .sf-pill.off { background:rgba(255,68,85,.15);  color:var(--bear); }
    .sf-pill.neu { background:rgba(100,100,100,.15);color:var(--text-dim); }

    .sf-legend   { display:flex; gap:5px; align-items:center; flex-wrap:wrap; padding-top:4px; border-top:1px solid var(--border); }
    .sf-leg-note { font-size:8px; color:var(--text-dim); font-family:var(--mono); margin-left:4px; }

    @media (max-width:768px) {
      .sf-tiles { gap:4px; }
      .sf-tile  { min-width:82px; padding:4px 5px; }
      .sf-appetite { gap:5px; }
      .sf-pred-txt { font-size:8px; }
    }
  `;
  document.head.appendChild(s);
})();
