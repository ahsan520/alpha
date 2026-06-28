// ══════════════════════════════════════════════════════════════════════════════
// watchlist-manager.js — v2.1
// Changes from v2.0:
//   - renderWatchlistManager() shows exchange name + currency + session badge
//     for every ticker, using exchangeName() / exchangeCurrency() /
//     getMarketSession() from exchange-registry-browser.js.
//   - Session badge colours: open=green, prepost=amber, closed/lunch=dim.
//   - addTicker() type dropdown now has explicit options for stock exchanges
//     (TSX, LSE, XETRA, TSE, HKEX, NSE, US) — auto-appends correct suffix hint.
//   - No changes to alert-enable logic or localStorage keys.
// ══════════════════════════════════════════════════════════════════════════════

// ── Alert enable/disable sets ──
function loadAlertEnabled()  { try { return new Set(JSON.parse(localStorage.getItem('a49_alert_enabled')  || 'null') || []); } catch { return new Set(); } }
function loadAlertDisabled() { try { return new Set(JSON.parse(localStorage.getItem('a49_alert_disabled') || 'null') || []); } catch { return new Set(); } }
function saveAlertSets(enabled, disabled) {
  localStorage.setItem('a49_alert_enabled',  JSON.stringify([...enabled]));
  localStorage.setItem('a49_alert_disabled', JSON.stringify([...disabled]));
}

function initAlertFilterState() {
  STATE._alertEnabled  = loadAlertEnabled();
  STATE._alertDisabled = loadAlertDisabled();
  STATE._baseWatchlist = [];
}

function isAlertEnabled(sym) {
  if (!STATE._alertEnabled || !STATE._alertDisabled) initAlertFilterState();
  return STATE._baseWatchlist.includes(sym)
    ? !STATE._alertDisabled.has(sym)
    :  STATE._alertEnabled.has(sym);
}

function setTickerAlertEnabled(sym, on) {
  if (!STATE._alertEnabled) initAlertFilterState();
  if (STATE._baseWatchlist.includes(sym)) {
    if (on) STATE._alertDisabled.delete(sym); else STATE._alertDisabled.add(sym);
  } else {
    if (on) STATE._alertEnabled.add(sym); else STATE._alertEnabled.delete(sym);
  }
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  renderWatchlistManager();
}

// ── Session badge HTML ──
// Shown inline next to each ticker in the watchlist manager grid.
function _sessionBadge(sym) {
  if (!sym) return '';
  const session = typeof getMarketSession !== 'undefined' ? getMarketSession(sym) : 'open';
  if (session === '24/7' || session === 'open')  return '<span class="wm-sess open">OPEN</span>';
  if (session === 'pre_market')                  return '<span class="wm-sess prepost">PRE</span>';
  if (session === 'after_hours')                 return '<span class="wm-sess prepost">AH</span>';
  if (session === 'lunch_break')                 return '<span class="wm-sess closed">LUNCH</span>';
  return '<span class="wm-sess closed">CLOSED</span>';
}

// ── Exchange info badge ──
function _exchangeBadge(sym) {
  if (!sym) return '';
  const name = typeof exchangeName     !== 'undefined' ? exchangeName(sym)     : '';
  const cur  = typeof exchangeCurrency !== 'undefined' ? exchangeCurrency(sym) : '';
  if (!name) return '';
  return `<span class="wm-badge exch" title="${name}">${cur}</span>`;
}

// ── Ticker row HTML ──
function _tickerRowHTML(sym, badgeType) {
  const on      = isAlertEnabled(sym);
  const sessBadge = _sessionBadge(sym);
  const exchBadge = _exchangeBadge(sym);
  return `
    <div class="wm-ticker-row ${on ? 'alert-on' : 'alert-off'}">
      <label class="wm-chk-label">
        <input type="checkbox" ${on ? 'checked' : ''}
          onchange="setTickerAlertEnabled('${sym}', this.checked)">
        <span class="wm-sym">${sym}</span>
      </label>
      ${exchBadge}
      ${sessBadge}
      <span class="wm-badge ${badgeType}">${badgeType.toUpperCase()}</span>
      <span class="wm-badge ${on ? 'tg-on' : 'tg-off'}">${on ? '🔔 TG ON' : '🔕 TG OFF'}</span>
      ${badgeType === 'local' ? `<button class="wm-del" onclick="removeLocalTicker('${sym}')" title="Remove">✕</button>` : ''}
    </div>`;
}

// ── Render Watchlist Manager tab ──
function renderWatchlistManager() {
  const el = document.getElementById('tab-watchlist-mgr');
  if (!el) return;

  const base  = STATE._baseWatchlist || [];
  const added = STATE.watchlist.filter(s => !base.includes(s));

  el.innerHTML = `
    <div class="wm-wrap">

      <!-- ── Section 1: watchlist.json ── -->
      <div class="wm-section">
        <div class="wm-section-hdr">
          <span class="pt">◆ WATCHLIST.JSON</span>
          <span class="wm-sub">GitHub Actions alerts on these. Uncheck to suppress Telegram for a ticker.</span>
        </div>
        <div class="wm-legend">
          <span class="wm-leg-item"><span class="wm-badge json">JSON</span> committed to repo · runner picks up automatically</span>
          <span class="wm-leg-item"><span class="wm-sess open">OPEN</span> live &nbsp;|&nbsp; <span class="wm-sess prepost">PRE/AH</span> extended &nbsp;|&nbsp; <span class="wm-sess closed">CLOSED</span> frozen</span>
        </div>
        <div class="wm-ticker-grid" id="wm-json-grid">
          ${base.length === 0
            ? '<div class="wm-empty">watchlist.json not loaded</div>'
            : base.map(sym => _tickerRowHTML(sym, 'json')).join('')}
        </div>
        <div class="wm-actions">
          <button class="bsm" onclick="exportWL()">↓ EXPORT JSON</button>
          <button class="bsm" onclick="document.getElementById('wlFile').click()">↑ IMPORT JSON</button>
          <input type="file" id="wlFile" style="display:none" onchange="importWL(this)">
          <button class="bsm wm-btn-all"  onclick="setAllBaseAlerts(true)">Enable All TG</button>
          <button class="bsm wm-btn-none" onclick="setAllBaseAlerts(false)">Disable All TG</button>
        </div>
        <div class="wm-info-box">
          <strong>ℹ️ To add/remove from GitHub Actions runner:</strong>
          Export → edit <code>watchlist.json</code> → commit to repo.
        </div>
      </div>

      <!-- ── Section 2: Local cache ── -->
      <div class="wm-section">
        <div class="wm-section-hdr">
          <span class="pt">◆ LOCAL CACHE</span>
          <span class="wm-sub">Added via + ADD. Visible in the matrix but <em>not</em> in watchlist.json.</span>
        </div>
        <div class="wm-ticker-grid" id="wm-local-grid">
          ${added.length === 0
            ? '<div class="wm-empty">No local-only tickers yet.<br>Use + ADD in the Signal Matrix tab.</div>'
            : added.map(sym => _tickerRowHTML(sym, 'local')).join('')}
        </div>
        ${added.length > 0 ? `
        <div class="wm-actions">
          <button class="bsm wm-btn-all"  onclick="setAllLocalAlerts(true)">Enable All TG</button>
          <button class="bsm wm-btn-none" onclick="setAllLocalAlerts(false)">Disable All TG</button>
          <button class="bsm" onclick="removeAllLocalTickers()" style="color:#ff4444;">✕ Remove All Local</button>
        </div>` : ''}
        <div class="wm-info-box">
          <strong>💡 Tip:</strong> Export <code>watchlist.json</code>, add the symbol, commit to repo.
        </div>
      </div>

      <!-- ── Section 3: Exchange coverage ── -->
      <div class="wm-section">
        <div class="wm-section-hdr"><span class="pt">◆ EXCHANGE COVERAGE</span></div>
        <div class="wm-exchange-grid">
          ${[
            { key:'BINANCE', label:'Binance Crypto', note:'24/7 · Binance + Kraken fallback' },
            { key:'TSX',     label:'TSX (.TO)',       note:'09:30–16:00 ET · Yahoo + Stooq' },
            { key:'NYSE',    label:'NYSE/NASDAQ',     note:'09:30–16:00 ET + AH · Yahoo + Stooq' },
            { key:'LSE',     label:'LSE (.L)',        note:'08:00–16:30 London · Yahoo + Stooq' },
            { key:'XETRA',   label:'XETRA (.DE)',     note:'09:00–17:30 Berlin · Yahoo + Stooq' },
            { key:'TSE',     label:'TSE (.T)',        note:'09:00–15:30 Tokyo + lunch · Yahoo + Stooq' },
            { key:'HKEX',    label:'HKEX (.HK)',      note:'09:30–16:00 HK + lunch · Yahoo + Stooq' },
            { key:'NSE',     label:'NSE India (.NS)', note:'09:15–15:30 IST · Yahoo only' },
          ].map(ex => {
            const count = STATE.watchlist.filter(s => {
              const e = typeof resolveExchange !== 'undefined' ? resolveExchange(s) : null;
              return e && Object.entries(EXCHANGES ?? {}).find(([k, v]) => k === ex.key && v === e);
            }).length;
            return `
              <div class="wm-exch-row">
                <span class="wm-exch-label">${ex.label}</span>
                <span class="wm-exch-note">${ex.note}</span>
                <span class="wm-exch-count">${count} symbol${count !== 1 ? 's' : ''}</span>
              </div>`;
          }).join('')}
        </div>
      </div>

      <!-- ── Section 4: Summary ── -->
      <div class="wm-section wm-summary">
        <div class="wm-section-hdr"><span class="pt">◆ ALERT SUMMARY</span></div>
        <div class="wm-summary-grid">
          <div class="wm-stat"><span class="wm-stat-val">${base.length}</span><span class="wm-stat-lbl">JSON tickers</span></div>
          <div class="wm-stat"><span class="wm-stat-val">${added.length}</span><span class="wm-stat-lbl">Local-only</span></div>
          <div class="wm-stat wm-stat-on">
            <span class="wm-stat-val">${STATE.watchlist.filter(s => isAlertEnabled(s)).length}</span>
            <span class="wm-stat-lbl">🔔 TG ON</span>
          </div>
          <div class="wm-stat wm-stat-off">
            <span class="wm-stat-val">${STATE.watchlist.filter(s => !isAlertEnabled(s)).length}</span>
            <span class="wm-stat-lbl">🔕 TG OFF</span>
          </div>
        </div>
      </div>

    </div>
  `;
}

function setAllBaseAlerts(on) {
  const base = STATE._baseWatchlist || [];
  if (on) base.forEach(s => STATE._alertDisabled.delete(s));
  else    base.forEach(s => STATE._alertDisabled.add(s));
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  renderWatchlistManager();
}

function setAllLocalAlerts(on) {
  const added = STATE.watchlist.filter(s => !(STATE._baseWatchlist || []).includes(s));
  if (on) added.forEach(s => STATE._alertEnabled.add(s));
  else    added.forEach(s => STATE._alertEnabled.delete(s));
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  renderWatchlistManager();
}

function removeLocalTicker(sym) {
  delT(sym);
  STATE._alertEnabled.delete(sym);
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  renderWatchlistManager();
}

function removeAllLocalTickers() {
  if (!confirm('Remove all local-cache tickers?')) return;
  const added = STATE.watchlist.filter(s => !(STATE._baseWatchlist || []).includes(s));
  added.forEach(s => {
    STATE.watchlist = STATE.watchlist.filter(x => x !== s);
    STATE._alertEnabled.delete(s);
    delete STATE.DS[s];
    delete STATE.PH[s];
  });
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  if (STATE.watchlist.length) switchT(STATE.watchlist[0]);
  render();
  renderWatchlistManager();
}
