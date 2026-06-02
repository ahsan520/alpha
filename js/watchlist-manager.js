// ══════════════════════════════════════════════════════════════
// watchlist-manager.js — GUI for managing watchlist.json tickers
// and local-cache (localStorage) tickers, with per-ticker alert toggles.
//
// DESIGN:
//   • watchlist.json tickers  → alert-enabled by DEFAULT (GitHub Actions also alerts on these)
//   • Local-cache tickers     → alert-DISABLED by default (display only, no Telegram spam)
//   • a49_alert_enabled  = Set of tickers that SHOULD trigger alerts
//   • a49_alert_disabled = Set of tickers explicitly turned OFF (overrides default for json tickers)
//
// checkAlertRules() in alerts.js calls isAlertEnabled(sym) before dispatching.
// ══════════════════════════════════════════════════════════════

// ── Persistent alert-enable sets ──
function loadAlertEnabled() {
  try { return new Set(JSON.parse(localStorage.getItem('a49_alert_enabled') || 'null') || []); }
  catch { return new Set(); }
}
function loadAlertDisabled() {
  try { return new Set(JSON.parse(localStorage.getItem('a49_alert_disabled') || 'null') || []); }
  catch { return new Set(); }
}
function saveAlertSets(enabled, disabled) {
  localStorage.setItem('a49_alert_enabled',  JSON.stringify([...enabled]));
  localStorage.setItem('a49_alert_disabled', JSON.stringify([...disabled]));
}

// Cache the sets in STATE for fast lookup
function initAlertFilterState() {
  STATE._alertEnabled  = loadAlertEnabled();
  STATE._alertDisabled = loadAlertDisabled();
  STATE._baseWatchlist = []; // filled after watchlist.json fetch
}

/**
 * Returns true if the ticker should fire alerts.
 * Logic:
 *   - If ticker is in base watchlist.json → ON unless explicitly disabled
 *   - If ticker is local-cache-only         → OFF unless explicitly enabled
 */
function isAlertEnabled(sym) {
  if (!STATE._alertEnabled || !STATE._alertDisabled) initAlertFilterState();
  const isBase = STATE._baseWatchlist.includes(sym);
  if (isBase) {
    // JSON tickers: on by default, off if in disabled set
    return !STATE._alertDisabled.has(sym);
  } else {
    // Local-cache tickers: off by default, on if explicitly enabled
    return STATE._alertEnabled.has(sym);
  }
}

function setTickerAlertEnabled(sym, on) {
  if (!STATE._alertEnabled) initAlertFilterState();
  const isBase = STATE._baseWatchlist.includes(sym);
  if (isBase) {
    // For base tickers, track explicit disables
    if (on)  STATE._alertDisabled.delete(sym);
    else     STATE._alertDisabled.add(sym);
  } else {
    // For local tickers, track explicit enables
    if (on)  STATE._alertEnabled.add(sym);
    else     STATE._alertEnabled.delete(sym);
  }
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  renderWatchlistManager();
}

// ── Render the Watchlist Manager tab ──
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
          <span class="wm-sub">GitHub Actions alerts on these tickers. Uncheck to suppress Telegram for a ticker.</span>
        </div>
        <div class="wm-legend">
          <span class="wm-leg-item"><span class="wm-badge json">JSON</span> committed to repo · runner picks up automatically</span>
          <span class="wm-leg-item"><span class="wm-chk-demo">☑</span> Telegram alerts ON &nbsp;|&nbsp; <span class="wm-chk-demo">☐</span> Telegram alerts OFF</span>
        </div>
        <div class="wm-ticker-grid" id="wm-json-grid">
          ${base.length === 0
            ? '<div class="wm-empty">watchlist.json not loaded</div>'
            : base.map(sym => {
                const on = isAlertEnabled(sym);
                return `
                  <div class="wm-ticker-row ${on ? 'alert-on' : 'alert-off'}">
                    <label class="wm-chk-label">
                      <input type="checkbox" ${on ? 'checked' : ''}
                        onchange="setTickerAlertEnabled('${sym}', this.checked)">
                      <span class="wm-sym">${sym}</span>
                    </label>
                    <span class="wm-badge json">JSON</span>
                    <span class="wm-badge ${on ? 'tg-on' : 'tg-off'}">${on ? '🔔 TG ON' : '🔕 TG OFF'}</span>
                  </div>`;
              }).join('')}
        </div>
        <div class="wm-actions">
          <button class="bsm" onclick="exportWL()">↓ EXPORT JSON</button>
          <button class="bsm" onclick="document.getElementById('wlFile').click()">↑ IMPORT JSON</button>
          <input type="file" id="wlFile" style="display:none" onchange="importWL(this)">
          <button class="bsm wm-btn-all" onclick="setAllBaseAlerts(true)">Enable All TG</button>
          <button class="bsm wm-btn-none" onclick="setAllBaseAlerts(false)">Disable All TG</button>
        </div>
        <div class="wm-info-box">
          <strong>ℹ️ To add/remove from GitHub Actions runner:</strong>
          Export → edit <code>watchlist.json</code> → commit to repo.
          The runner reads this file on every schedule run.
        </div>
      </div>

      <!-- ── Section 2: Local Cache tickers ── -->
      <div class="wm-section">
        <div class="wm-section-hdr">
          <span class="pt">◆ LOCAL CACHE</span>
          <span class="wm-sub">Tickers added via the + ADD button. Shown in the matrix but <em>not</em> in watchlist.json — GitHub Actions does NOT alert on these by default.</span>
        </div>
        <div class="wm-legend">
          <span class="wm-leg-item"><span class="wm-badge local">LOCAL</span> browser-only · not committed · cleared on RESET CACHE</span>
          <span class="wm-leg-item">Check to enable Telegram alerts from the browser alert engine.</span>
        </div>
        <div class="wm-ticker-grid" id="wm-local-grid">
          ${added.length === 0
            ? '<div class="wm-empty">No local-only tickers added yet.<br>Use + ADD in the Signal Matrix tab.</div>'
            : added.map(sym => {
                const on = isAlertEnabled(sym);
                return `
                  <div class="wm-ticker-row ${on ? 'alert-on' : 'alert-off'}">
                    <label class="wm-chk-label">
                      <input type="checkbox" ${on ? 'checked' : ''}
                        onchange="setTickerAlertEnabled('${sym}', this.checked)">
                      <span class="wm-sym">${sym}</span>
                    </label>
                    <span class="wm-badge local">LOCAL</span>
                    <span class="wm-badge ${on ? 'tg-on' : 'tg-off'}">${on ? '🔔 TG ON' : '🔕 TG OFF'}</span>
                    <button class="wm-del" onclick="removeLocalTicker('${sym}')" title="Remove from local cache">✕</button>
                  </div>`;
              }).join('')}
        </div>
        ${added.length > 0 ? `
        <div class="wm-actions">
          <button class="bsm wm-btn-all"  onclick="setAllLocalAlerts(true)">Enable All TG</button>
          <button class="bsm wm-btn-none" onclick="setAllLocalAlerts(false)">Disable All TG</button>
          <button class="bsm" onclick="removeAllLocalTickers()" style="color:#ff4444;">✕ Remove All Local</button>
        </div>` : ''}
        <div class="wm-info-box">
          <strong>💡 Tip:</strong> To promote a local ticker to the runner, export
          <code>watchlist.json</code>, add the symbol, commit it to your repo.
          The next scheduled run will pick it up automatically.
        </div>
      </div>

      <!-- ── Section 3: Summary ── -->
      <div class="wm-section wm-summary">
        <div class="wm-section-hdr"><span class="pt">◆ ALERT SUMMARY</span></div>
        <div class="wm-summary-grid">
          <div class="wm-stat">
            <span class="wm-stat-val">${base.length}</span>
            <span class="wm-stat-lbl">JSON tickers</span>
          </div>
          <div class="wm-stat">
            <span class="wm-stat-val">${added.length}</span>
            <span class="wm-stat-lbl">Local-only tickers</span>
          </div>
          <div class="wm-stat wm-stat-on">
            <span class="wm-stat-val">${STATE.watchlist.filter(s => isAlertEnabled(s)).length}</span>
            <span class="wm-stat-lbl">🔔 Telegram alerts ON</span>
          </div>
          <div class="wm-stat wm-stat-off">
            <span class="wm-stat-val">${STATE.watchlist.filter(s => !isAlertEnabled(s)).length}</span>
            <span class="wm-stat-lbl">🔕 Telegram alerts OFF</span>
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
  const base  = STATE._baseWatchlist || [];
  const added = STATE.watchlist.filter(s => !base.includes(s));
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
  if (!confirm('Remove all local-cache tickers from the watchlist?')) return;
  const base  = STATE._baseWatchlist || [];
  const added = STATE.watchlist.filter(s => !base.includes(s));
  added.forEach(s => {
    STATE.watchlist = STATE.watchlist.filter(x => x !== s);
    STATE._alertEnabled.delete(s);
    delete STATE.DS[s];
    delete STATE.PH[s];
  });
  localStorage.setItem('a49_wl_added', JSON.stringify([]));
  saveAlertSets(STATE._alertEnabled, STATE._alertDisabled);
  if (STATE.watchlist.length) switchT(STATE.watchlist[0]);
  render();
  renderWatchlistManager();
}
