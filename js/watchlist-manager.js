// ══════════════════════════════════════════════════════════════════════════════
// watchlist-manager.js — v3.0
//
// Changes from v2.1:
//   - Rebuilt around STATE.namedWatchlists (the { listName: { SYMBOL: tgOn } }
//     map) as the single source of truth for both list membership AND
//     per-symbol Telegram on/off — replaces the old parallel
//     a49_alert_enabled / a49_alert_disabled localStorage sets and the
//     base-vs-local-cache split, which tracked TG state independently of
//     which named list a symbol actually belonged to (and, critically,
//     never left the browser — the old TG state had no way to reach
//     watchlist.json at all).
//   - Shows every named list in one table, grouped by list name, instead of
//     a single base list + a separate "local cache, not yet in
//     watchlist.json" staging section — syncWatchlistsToGitHub() pushes the
//     full structure to watchlist-source.json live, so there's no staging
//     step anymore.
//   - Export/Import now round-trip watchlist-source.json (full multi-list +
//     TG state) via exportWL()/importWL() in app.js. A separate "Export
//     Computed watchlist.json" button (exportComputedWatchlist() in app.js)
//     downloads exactly what the backend-facing flat file would be — for
//     hand-committing directly if the sync pipeline is down.
//   - Session badges, exchange badges, Exchange Coverage table, and Alert
//     Summary stats are UNCHANGED from v2.1 — same functions, same layout,
//     just fed from the new per-list TG map instead of the old sets.
//
// Changes from v3.0:
//   - "+ New List" button wired to createWatchlist() (app.js) — was already
//     implemented there but had no button in this tab.
//   - "Delete List" button per list block, wired to deleteWatchlist(name)
//     (app.js) — same story, function existed, no hook in this UI.
//   - Per-symbol ✕ is now hover-only (was always visible) — a one-time
//     <style> injection (_ensureWmHoverStyle()) fades it in on row hover so
//     the grid reads cleaner at rest.
// ══════════════════════════════════════════════════════════════════════════════

// ── One-time CSS injection for hover-to-reveal ✕ ──
// Keeps this file self-contained (no dependency on an external stylesheet
// having the right rule). Runs once; safe to call on every render.
function _ensureWmHoverStyle() {
  if (document.getElementById('wm-hover-style')) return;
  const style = document.createElement('style');
  style.id = 'wm-hover-style';
  style.textContent = `
    .wm-ticker-row .wm-del { opacity: 0; transition: opacity .12s ease; }
    .wm-ticker-row:hover .wm-del { opacity: 1; }
    .wm-ticker-row .wm-del:focus { opacity: 1; }
  `;
  document.head.appendChild(style);
}

// ── Session badge HTML ──
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

// ── Ticker row HTML — one row per symbol within a named list ──
function _tickerRowHTML(listName, sym, on) {
  const sessBadge = _sessionBadge(sym);
  const exchBadge = _exchangeBadge(sym);
  return `
    <div class="wm-ticker-row ${on ? 'alert-on' : 'alert-off'}">
      <label class="wm-chk-label">
        <input type="checkbox" ${on ? 'checked' : ''}
          onchange="toggleSymbolTg('${listName}', '${sym}')">
        <span class="wm-sym">${sym}</span>
      </label>
      ${exchBadge}
      ${sessBadge}
      <span class="wm-badge ${on ? 'tg-on' : 'tg-off'}">${on ? '🔔 TG ON' : '🔕 TG OFF'}</span>
      <button class="wm-del" onclick="removeTickerFromList('${listName}', '${sym}')" title="Remove from ${listName}">✕</button>
    </div>`;
}

// ── One block per named list ──
function _listBlockHTML(listName, symMap) {
  const symbols = Object.keys(symMap);
  const onCount = symbols.filter(s => symMap[s]).length;
  return `
    <div class="wm-list-block">
      <div class="wm-list-hdr">
        <span class="wm-list-name">${listName}</span>
        <span class="wm-list-count">${symbols.length} symbol${symbols.length === 1 ? '' : 's'} · ${onCount} TG-on</span>
        <span class="wm-list-actions">
          <button class="bsm wm-btn-all"  onclick="setAllTgForList('${listName}', true)">All TG On</button>
          <button class="bsm wm-btn-none" onclick="setAllTgForList('${listName}', false)">All TG Off</button>
          <button class="bsm wm-btn-del-list" onclick="deleteWatchlist('${listName}')" title="Delete this watchlist" style="color:#ff4444;">🗑 Delete List</button>
        </span>
      </div>
      <div class="wm-ticker-grid">
        ${symbols.length === 0
          ? '<div class="wm-empty">No symbols in this list yet. Use + ADD in the Signal Matrix tab.</div>'
          : symbols.map(sym => _tickerRowHTML(listName, sym, symMap[sym])).join('')}
      </div>
    </div>`;
}

// ── Render Watchlist Manager tab ──
function renderWatchlistManager() {
  const el = document.getElementById('tab-watchlist-mgr');
  if (!el) return;

  _ensureWmHoverStyle();

  const namedLists = STATE.namedWatchlists || {};
  const listNames  = Object.keys(namedLists);
  const allSymbols = new Set(listNames.flatMap(n => Object.keys(namedLists[n])));
  const allEntries = listNames.flatMap(n => Object.entries(namedLists[n]));
  const tgOnCount  = allEntries.filter(([, on]) => on).length;
  const tgOffCount = allEntries.length - tgOnCount;

  el.innerHTML = `
    <div class="wm-wrap">

      <!-- ── Section 1: all named lists, per-symbol TG ── -->
      <div class="wm-section">
        <div class="wm-section-hdr">
          <span class="pt">◆ WATCHLISTS</span>
          <span class="wm-sub">Every named list, synced live to watchlist-source.json. Uncheck to suppress Telegram for a ticker — the Cloudflare Worker only includes TG-on symbols in watchlist.json.</span>
          <button class="bsm wm-btn-new-list" onclick="createWatchlist()">+ New List</button>
        </div>
        <div class="wm-legend">
          <span class="wm-leg-item"><span class="wm-badge json">SOURCE</span> watchlist-source.json — pushed live on every edit</span>
          <span class="wm-leg-item"><span class="wm-sess open">OPEN</span> live &nbsp;|&nbsp; <span class="wm-sess prepost">PRE/AH</span> extended &nbsp;|&nbsp; <span class="wm-sess closed">CLOSED</span> frozen</span>
        </div>

        ${listNames.length === 0
          ? '<div class="wm-empty">No watchlists yet.</div>'
          : listNames.map(name => _listBlockHTML(name, namedLists[name])).join('')}

        <div class="wm-actions">
          <button class="bsm" onclick="exportWL()">↓ EXPORT SOURCE</button>
          <button class="bsm" onclick="document.getElementById('wlFile').click()">↑ IMPORT SOURCE</button>
          <input type="file" id="wlFile" style="display:none" onchange="importWL(this)">
          <button class="bsm wm-btn-all"  onclick="setAllTgGlobal(true)">Enable All TG</button>
          <button class="bsm wm-btn-none" onclick="setAllTgGlobal(false)">Disable All TG</button>
        </div>

        <div class="wm-info-box">
          <strong>ℹ️ Normal operation:</strong> just edit here or in the Signal Matrix — it syncs to
          <code>watchlist-source.json</code> automatically, and the alpha-watchlist-sync Cloudflare
          Worker recomputes <code>watchlist.json</code> (TG-on symbols only) on its own schedule.
          No manual steps needed.
        </div>
        <div class="wm-info-box" style="border-color:#a66;">
          <strong>🛟 If the Cloudflare Worker is down:</strong>
          <button class="bsm" onclick="exportComputedWatchlist()">↓ EXPORT COMPUTED watchlist.json</button>
          downloads exactly what the Worker would have written — hand-commit it directly to unblock
          the bot while you fix the Worker. Re-import via <strong>IMPORT SOURCE</strong> above once
          it's editable again (accepts either shape — a flat array or the full source structure).
        </div>
      </div>

      <!-- ── Section 2: Exchange coverage ── -->
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
            const count = [...allSymbols].filter(s => {
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

      <!-- ── Section 3: Summary ── -->
      <div class="wm-section wm-summary">
        <div class="wm-section-hdr"><span class="pt">◆ ALERT SUMMARY</span></div>
        <div class="wm-summary-grid">
          <div class="wm-stat"><span class="wm-stat-val">${listNames.length}</span><span class="wm-stat-lbl">Watchlists</span></div>
          <div class="wm-stat"><span class="wm-stat-val">${allSymbols.size}</span><span class="wm-stat-lbl">Unique symbols</span></div>
          <div class="wm-stat wm-stat-on">
            <span class="wm-stat-val">${tgOnCount}</span>
            <span class="wm-stat-lbl">🔔 TG ON</span>
          </div>
          <div class="wm-stat wm-stat-off">
            <span class="wm-stat-val">${tgOffCount}</span>
            <span class="wm-stat-lbl">🔕 TG OFF</span>
          </div>
        </div>
      </div>

    </div>
  `;
}

// ── Per-list bulk TG toggle ──
function setAllTgForList(listName, on) {
  if (!STATE.namedWatchlists || !STATE.namedWatchlists[listName]) return;
  for (const sym of Object.keys(STATE.namedWatchlists[listName])) {
    STATE.namedWatchlists[listName][sym] = !!on;
  }
  _persistNamedWatchlists();
  renderWatchlistManager();
}

// ── Remove a symbol from a specific named list (not just the active one) ──
function removeTickerFromList(listName, sym) {
  if (!STATE.namedWatchlists || !STATE.namedWatchlists[listName]) return;
  delete STATE.namedWatchlists[listName][sym];
  _persistNamedWatchlists();
  if (STATE.activeWatchlistName === listName) {
    STATE.watchlist = STATE.watchlist.filter(x => x !== sym);
    delete STATE.DS[sym];
    delete STATE.PH[sym];
    if (STATE.currentS === sym) { STATE.currentS = null; _renderChartPlaceholder(); }
    render();
  }
  renderWatchlistManager();
}
