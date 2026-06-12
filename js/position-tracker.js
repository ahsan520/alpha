// ══════════════════════════════════════════════════════════════════
// position-tracker.js — Leaderboard alert engine + position monitor
// v1.0
//
// FLOW:
//   renderLeaderboard() → checkLeaderboardAlerts(ranked)
//     ├─ New card appears (SQUEEZE NOW / BREAKOUT) → BUY alert
//     │    - 20min hold lock stamped
//     │    - Position written to a49_positions
//     │    - 1hr cooldown per sym
//     └─ Each sync → monitorOpenPositions()
//          ├─ Inside 20min lock → skip exit scoring
//          ├─ T1/T2 hit → Tier 3 immediate
//          ├─ Price < entry → Tier 3 stop hit
//          ├─ Exit score ≥ 3 (CVD required) → Tier 2 sell alert
//          └─ Overheating only → Tier 1 watch alert
// ══════════════════════════════════════════════════════════════════

const POSITION_KEY  = 'a49_positions';
const LB_ALERT_KEY  = 'a49_lb_alert_cfg';

// ── Default leaderboard alert config ──
const DEFAULT_LB_ALERT_CFG = {
  enabled:           true,
  squeezeEnabled:    true,
  breakoutEnabled:   true,
  trendingEnabled:   false,   // too slow-moving for actionable alerts
  shortEnabled:      false,   // off by default — noisy in crypto uptrends
  minScore:          14,      // min conv score to alert (out of 20)
  cooldownMins:      60,      // 1hr buy cooldown per symbol
  holdLockMins:      20,      // no exit alerts in first 20min after entry
  exitCvdCycles:     3,       // CVD must decline this many consecutive cycles
};

// ── Load/save config ──
function loadLbAlertCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(LB_ALERT_KEY) || '{}');
    return { ...DEFAULT_LB_ALERT_CFG, ...raw };
  } catch { return { ...DEFAULT_LB_ALERT_CFG }; }
}

function saveLbAlertCfg(cfg) {
  localStorage.setItem(LB_ALERT_KEY, JSON.stringify(cfg));
}

// ── Position store (localStorage) ──
function loadPositions() {
  try { return JSON.parse(localStorage.getItem(POSITION_KEY) || '{}'); }
  catch { return {}; }
}

function savePositions(pos) {
  localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
}

// ── Buy cooldown (separate from overnight alert cooldown) ──
function _lbBuyCooldownKey(sym) { return `a49_lb_buy_${sym}`; }

function _lbIsOnCooldown(sym, cooldownMins) {
  const ts = parseInt(localStorage.getItem(_lbBuyCooldownKey(sym)) || '0');
  if (!ts) return false;
  return (Date.now() - ts) < cooldownMins * 60000;
}

function _lbMarkBuyFired(sym) {
  localStorage.setItem(_lbBuyCooldownKey(sym), String(Date.now()));
}

function _lbCooldownRemaining(sym, cooldownMins) {
  const ts = parseInt(localStorage.getItem(_lbBuyCooldownKey(sym)) || '0');
  if (!ts) return 0;
  const remaining = cooldownMins * 60000 - (Date.now() - ts);
  return remaining > 0 ? remaining : 0;
}

// ── CVD decline tracker (per symbol, in-memory) ──
if (!window._cvdDeclineCount) window._cvdDeclineCount = {};

function _trackCvdDecline(sym, cvdTrending) {
  if (cvdTrending === 'down') {
    window._cvdDeclineCount[sym] = (window._cvdDeclineCount[sym] || 0) + 1;
  } else {
    window._cvdDeclineCount[sym] = 0; // reset on any up/flat bar
  }
  return window._cvdDeclineCount[sym];
}

// ── Previous leaderboard fingerprint (to detect new card appearances) ──
let _prevLbSyms = new Set();

// ══════════════════════════════════════════════════════════════════
// MAIN ENTRY — called from renderLeaderboard() after ranked is built
// ══════════════════════════════════════════════════════════════════
async function checkLeaderboardAlerts(ranked) {
  const cfg = loadLbAlertCfg();
  if (!cfg.enabled) return;

  // Check if Telegram is configured at all
  const tgReady = STATE.alertCfg?.telegram?.enabled
    && STATE.alertCfg?.telegram?.botToken
    && STATE.alertCfg?.telegram?.chatId;

  const currentSyms = new Set(ranked.map(r => r.sym));

  // ── 1. Detect NEW cards (not in previous render) ──
  const newCards = ranked.filter(r => !_prevLbSyms.has(r.sym));
  _prevLbSyms = currentSyms;

  // ── 2. Process buy alerts for new cards ──
  const buyAlerts = [];

  for (const r of newCards) {
    const { sym, d, conv, dir, lane } = r;
    const setup = getSetupMode(d, conv, r.isCapitulation || false, lane);
    const base  = sym.replace('BINANCE:','').replace('USDT','').replace('.TO','');

    // Setup type gate
    const isAlertableSetup =
      (cfg.squeezeEnabled  && setup.label === 'SQUEEZE NOW') ||
      (cfg.breakoutEnabled && setup.label === 'BREAKOUT')    ||
      (cfg.trendingEnabled && setup.label === 'TRENDING')    ||
      (cfg.shortEnabled    && setup.label === 'SHORT SETUP' && dir === 'bear');

    if (!isAlertableSetup) continue;

    // Min score gate
    if (conv < cfg.minScore) continue;

    // Cooldown gate
    if (_lbIsOnCooldown(sym, cfg.cooldownMins)) {
      const remMins = Math.ceil(_lbCooldownRemaining(sym, cfg.cooldownMins) / 60000);
      logAlertItem('info', `🔕 ${base} [LB ${setup.label}] — cooldown ${remMins}min left`);
      continue;
    }

    // Watchlist alert gate
    if (typeof isAlertEnabled === 'function' && !isAlertEnabled(sym)) continue;

    // ── Calculate entry levels ──
    const levels  = calcEntryLevels(d);
    const entryP  = levels ? parseFloat(levels.entry) : parseFloat(d.p || 0);
    const stopP   = levels ? parseFloat(levels.stop)  : 0;
    const t1P     = levels ? parseFloat(levels.t1)    : 0;
    const t2P     = levels ? parseFloat(levels.t2)    : 0;

    // ── Write position to tracker ──
    const positions = loadPositions();
    const now = Date.now();
    positions[sym] = {
      sym,
      base,
      setup:        setup.label,
      dir,
      alertedAt:    now,
      holdLockUntil: now + cfg.holdLockMins * 60000,
      entryPrice:   entryP,
      stop:         stopP,
      t1:           t1P,
      t2:           t2P,
      score:        conv,
      session:      getSessionLabel?.() || '—',
      exitAlertedAt: null,
      tier1AlertedAt: null,
      status:       'watching',  // watching | tp1_hit | tp2_hit | stopped | exiting
    };
    savePositions(positions);
    _lbMarkBuyFired(sym);

    buyAlerts.push({ r, setup, levels, entryP, stopP, t1P, t2P, conv, base });
    logAlertItem('buy', `🟢 LB BUY — ${base} [${setup.label}] score:${conv} entry:$${entryP}`);
  }

  // ── 3. Send digested BUY alert ──
  if (buyAlerts.length > 0 && tgReady) {
    await _sendBuyDigest(buyAlerts, cfg);
  }

  // ── 4. Monitor open positions for exit signals ──
  await monitorOpenPositions(ranked, cfg, tgReady);
}

// ══════════════════════════════════════════════════════════════════
// BUY DIGEST
// ══════════════════════════════════════════════════════════════════
async function _sendBuyDigest(alerts, cfg) {
  const session  = getSessionLabel?.() || '—';
  const regime   = document.getElementById('hcl-regime')?.textContent || '—';
  const cascade  = document.getElementById('hcl-cascade-hdr')?.textContent || '—';
  const utc      = new Date().toUTCString().slice(17, 22) + ' UTC';

  const rows = alerts.map(({ base, setup, levels, entryP, stopP, t1P, t2P, conv, r }) => {
    const d      = r.d;
    const cvdDir = d.cvd?.trending === 'up' ? '↑ up' : '↓ dn';
    const oiStr  = d.oiDiv || '—';
    const fr     = parseFloat(d.fr || 0);
    const frStr  = (fr >= 0 ? '+' : '') + fr.toFixed(3) + '%';
    const rsiStr = d.r15 ? `${Math.round(d.r15)}/15m` : '—';
    const rrDen  = entryP - stopP;
    const rrStr  = (rrDen > 0.000001 && t1P > entryP)
      ? '1:' + ((t1P - entryP) / rrDen).toFixed(1)
      : '—';

    return [
      `${setup.emoji} *${base}* — ${setup.label}  [${conv}/20]`,
      `  Entry $${entryP}  Stop $${stopP}  T1 $${t1P}  T2 $${t2P}`,
      `  R:R ${rrStr}  CVD ${cvdDir}  OI ${oiStr}  FR ${frStr}  RSI ${rsiStr}`,
    ].join('\n');
  }).join('\n\n');

  const msg = [
    `🟢 *LEADERBOARD BUY ALERT* — ${utc}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    rows,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Session: ${session} · Regime: ${regime}`,
    `Cascade: ${cascade}`,
    `_Exit monitoring active — sell alert fires separately_`,
  ].join('\n');

  await sendTelegramAlert(msg);
}

// ══════════════════════════════════════════════════════════════════
// POSITION MONITOR — exit scoring
// ══════════════════════════════════════════════════════════════════
async function monitorOpenPositions(ranked, cfg, tgReady) {
  const positions = loadPositions();
  if (!Object.keys(positions).length) return;

  const now         = Date.now();
  const tier2Alerts = []; // exit signals to digest
  const tier3Alerts = []; // immediate price-based exits
  let   changed     = false;

  for (const [sym, pos] of Object.entries(positions)) {
    if (pos.status === 'stopped' || pos.status === 'tp2_hit') continue;

    // Find current data for this symbol
    const lbEntry = ranked.find(r => r.sym === sym);
    const d       = lbEntry?.d || STATE.DS?.[sym];
    if (!d) continue;

    const price    = parseFloat(d.p || 0);
    const entry    = pos.entryPrice;
    const stop     = pos.stop;
    const t1       = pos.t1;
    const t2       = pos.t2;
    const isBull   = pos.dir === 'bull' || pos.dir !== 'bear';

    // ── TIER 3: Hard price-based exits (immediate, no lock) ──
    if (isBull && stop > 0 && price <= stop && pos.status !== 'stopped') {
      pos.status        = 'stopped';
      pos.exitAlertedAt = now;
      changed = true;
      const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
      tier3Alerts.push({
        sym, base: pos.base, type: 'STOP HIT',
        emoji: '🔴', color: 'stop',
        lines: [
          `🔴 *STOP HIT* — ${pos.base}`,
          `  Entry $${entry}  Stop $${stop}  Current $${price}`,
          `  P&L ${pnlPct}%  Setup was: ${pos.setup}`,
        ],
      });
      logAlertItem('sell', `🔴 STOP HIT — ${pos.base} @ $${price} (entry $${entry})`);
      continue;
    }

    if (isBull && t1 > 0 && price >= t1 && pos.status === 'watching') {
      pos.status        = 'tp1_hit';
      pos.exitAlertedAt = now;
      changed = true;
      const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
      tier3Alerts.push({
        sym, base: pos.base, type: 'T1 HIT',
        emoji: '✅', color: 'tp',
        lines: [
          `✅ *T1 HIT* — ${pos.base}`,
          `  T1 $${t1}  Current $${price}  Entry $${entry}`,
          `  P&L +${pnlPct}%  → Trail stop, watch for T2 $${t2}`,
        ],
      });
      logAlertItem('buy', `✅ T1 HIT — ${pos.base} @ $${price} (+${pnlPct}%)`);
      continue;
    }

    if (isBull && t2 > 0 && price >= t2 && pos.status === 'tp1_hit') {
      pos.status        = 'tp2_hit';
      pos.exitAlertedAt = now;
      changed = true;
      const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
      tier3Alerts.push({
        sym, base: pos.base, type: 'T2 HIT',
        emoji: '🏆', color: 'tp',
        lines: [
          `🏆 *T2 HIT* — ${pos.base}`,
          `  T2 $${t2}  Current $${price}  Entry $${entry}`,
          `  P&L +${pnlPct}%  → Full target reached`,
        ],
      });
      logAlertItem('buy', `🏆 T2 HIT — ${pos.base} @ $${price} (+${pnlPct}%)`);
      continue;
    }

    // ── Hold lock: no Tier 1/2 alerts within first N minutes ──
    if (now < pos.holdLockUntil) {
      const lockRemMins = Math.ceil((pos.holdLockUntil - now) / 60000);
      // Silent — don't spam log every cycle
      continue;
    }

    // ── Compute exit score ──
    // CVD is the gatekeeper — must be declining N consecutive cycles
    const cvdTrending  = d.cvd?.trending || 'up';
    const cvdDeclines  = _trackCvdDecline(sym, cvdTrending);
    const cvdConfirmed = cvdDeclines >= cfg.exitCvdCycles; // hard gate

    // Supporting signals
    const fr    = parseFloat(d.fr || 0);
    const r15   = parseFloat(d.r15 || 50);
    const oiStr = (d.oiDiv || '').toLowerCase();

    // OI dropping while price is flat/down (not just shorts covering)
    const priceFlat  = Math.abs(parseFloat(d.chg || 0)) < 0.5;
    const priceFalling = isBull && price < entry * 1.005; // within 0.5% of entry
    const oiExiting  = (oiStr.includes('bear oi') || oiStr.includes('oi drop'))
                       && (priceFlat || priceFalling);

    // Funding overheated AND rising (not just a spike)
    const fundingHot = fr > 0.08; // >0.08% = overheated for crypto perps

    // RSI context (only meaningful when combined with CVD)
    const rsiExtended = r15 > 75;

    // Exit score — CVD must confirm, others are supporting
    let exitScore = 0;
    if (cvdConfirmed)  exitScore += 2; // hard gate AND score contribution
    if (oiExiting)     exitScore += 2;
    if (fundingHot)    exitScore += 1;
    if (rsiExtended && cvdDeclines >= 1) exitScore += 1; // RSI only counts with any CVD weakness

    // ── TIER 1: Overheating watch (no CVD required) ──
    const tier1Threshold = 2; // funding hot + RSI extended = tighten stop
    const tier1Triggered = (fundingHot && rsiExtended) && !cvdConfirmed;
    const tier1Cooldown  = 2 * 60 * 60000; // 2hr between tier1 alerts

    if (tier1Triggered
        && pos.status === 'watching'
        && (!pos.tier1AlertedAt || (now - pos.tier1AlertedAt) > tier1Cooldown)) {
      pos.tier1AlertedAt = now;
      changed = true;
      const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
      logAlertItem('info',
        `⚠ WATCH ${pos.base} — FR ${fr.toFixed(3)}% + RSI ${Math.round(r15)} — consider tightening stop`);
      if (tgReady && typeof isAlertEnabled === 'function' && isAlertEnabled(sym)) {
        const msg = [
          `⚠ *WATCH — Overheating* — ${pos.base}`,
          `  Funding ${fr.toFixed(3)}%  RSI 15m ${Math.round(r15)}`,
          `  CVD still up — no exit yet, but tighten stop`,
          `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%`,
          `  _CVD must confirm decline before exit alert fires_`,
        ].join('\n');
        await sendTelegramAlert(msg);
      }
    }

    // ── TIER 2: Distribution confirmed — exit signal ──
    const tier2Threshold = 3;
    const tier2Cooldown  = 2 * 60 * 60000;

    if (cvdConfirmed
        && exitScore >= tier2Threshold
        && pos.status !== 'exiting'
        && (!pos.exitAlertedAt || (now - pos.exitAlertedAt) > tier2Cooldown)) {
      pos.status        = 'exiting';
      pos.exitAlertedAt = now;
      changed = true;
      const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';
      const signals = [
        cvdConfirmed ? `CVD ↓ ${cvdDeclines} cycles` : null,
        oiExiting    ? `OI distributing` : null,
        fundingHot   ? `FR ${fr.toFixed(3)}%` : null,
        rsiExtended  ? `RSI ${Math.round(r15)}` : null,
      ].filter(Boolean).join(' · ');

      tier2Alerts.push({
        sym, base: pos.base, setup: pos.setup,
        exitScore, price, entry, pnlPct, signals,
        t2: pos.t2,
      });
      logAlertItem('sell',
        `🟡 EXIT SIGNAL — ${pos.base} score:${exitScore}/6 [${signals}]`);
    }
  }

  if (changed) savePositions(positions);

  // ── Send Tier 3 immediate alerts (one per event) ──
  for (const a of tier3Alerts) {
    if (!tgReady) continue;
    const sym = a.sym;
    if (typeof isAlertEnabled === 'function' && !isAlertEnabled(sym)) continue;
    const session = getSessionLabel?.() || '—';
    const msg = [...a.lines, `_${session} · ${new Date().toUTCString().slice(17,22)} UTC_`].join('\n');
    await sendTelegramAlert(msg);
  }

  // ── Send Tier 2 digested sell alert ──
  if (tier2Alerts.length > 0 && tgReady) {
    await _sendSellDigest(tier2Alerts);
  }
}

// ══════════════════════════════════════════════════════════════════
// SELL DIGEST
// ══════════════════════════════════════════════════════════════════
async function _sendSellDigest(alerts) {
  const session = getSessionLabel?.() || '—';
  const utc     = new Date().toUTCString().slice(17, 22) + ' UTC';

  const rows = alerts.map(a => [
    `🟡 *${a.base}* — Exit score ${a.exitScore}/6`,
    `  ⚠ ${a.signals}`,
    `  Current $${a.price}  Entry $${a.entry}  P&L ${a.pnlPct}%`,
    a.t2 > a.price
      ? `  T2 $${a.t2} not yet hit — consider partial exit or trail stop`
      : `  → Consider full exit`,
  ].join('\n')).join('\n\n');

  const msg = [
    `🟡 *EXIT SIGNAL* — ${utc}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    rows,
    `━━━━━━━━━━━━━━━━━━━━`,
    `CVD decline confirmed · Distribution detected`,
    `Session: ${session}`,
    `_Tier 1 watch fired earlier if overheating was detected_`,
  ].join('\n');

  await sendTelegramAlert(msg);
}

// ══════════════════════════════════════════════════════════════════
// UI — Position tracker panel rendered inside Alerts tab
// ══════════════════════════════════════════════════════════════════
function renderPositionTracker() {
  const el = document.getElementById('position-tracker-panel');
  if (!el) return;
  const positions = loadPositions();
  const cfg       = loadLbAlertCfg();
  const entries   = Object.values(positions);

  if (!entries.length) {
    el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:12px;">
      No active positions — leaderboard buy alert will create entries here.</div>`;
    return;
  }

  const statusColor = s => ({
    watching: 'var(--bull)',
    tp1_hit:  '#ffd700',
    tp2_hit:  '#ffd700',
    exiting:  '#ffa500',
    stopped:  'var(--bear)',
  }[s] || 'var(--text-dim)');

  const statusLabel = s => ({
    watching: '👁 WATCHING',
    tp1_hit:  '✅ T1 HIT',
    tp2_hit:  '🏆 T2 HIT',
    exiting:  '🟡 EXITING',
    stopped:  '🔴 STOPPED',
  }[s] || s);

  el.innerHTML = entries.map(pos => {
    const price   = parseFloat(STATE.DS?.[pos.sym]?.p || pos.entryPrice);
    const pnlPct  = pos.entryPrice > 0
      ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)
      : '—';
    const pnlColor = parseFloat(pnlPct) >= 0 ? 'var(--bull)' : 'var(--bear)';
    const age     = Math.floor((Date.now() - pos.alertedAt) / 60000);
    const locked  = Date.now() < pos.holdLockUntil;
    const lockRem = locked ? Math.ceil((pos.holdLockUntil - Date.now()) / 60000) : 0;

    return `
    <div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${statusColor(pos.status)};
                border-radius:6px;padding:10px 12px;margin-bottom:8px;font-family:var(--mono);font-size:9px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="color:var(--text-bright);font-weight:700;font-size:10px;">${pos.base}</span>
        <span style="color:${statusColor(pos.status)};font-size:8px;letter-spacing:1px;">${statusLabel(pos.status)}</span>
        <button onclick="removePosition('${pos.sym}')"
          style="background:none;border:1px solid var(--border2);color:var(--text-dim);
                 padding:1px 7px;border-radius:3px;cursor:pointer;font-size:8px;">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px;">
        <div><div style="color:var(--text-dim);font-size:7px;">SETUP</div><div style="color:var(--accent);">${pos.setup}</div></div>
        <div><div style="color:var(--text-dim);font-size:7px;">ENTRY</div><div>$${pos.entryPrice}</div></div>
        <div><div style="color:var(--text-dim);font-size:7px;">STOP</div><div style="color:var(--bear);">$${pos.stop}</div></div>
        <div><div style="color:var(--text-dim);font-size:7px;">T1</div><div style="color:var(--bull);">$${pos.t1}</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <span>Current: <b>$${price}</b></span>
        <span style="color:${pnlColor};font-weight:700;">${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%</span>
        <span style="color:var(--text-dim);font-size:8px;">${age}min ago</span>
        ${locked ? `<span style="color:#ffa500;font-size:8px;">⏳ Hold lock: ${lockRem}min</span>` : ''}
        ${window._cvdDeclineCount?.[pos.sym] > 0
          ? `<span style="color:var(--bear);font-size:8px;">CVD↓ ${window._cvdDeclineCount[pos.sym]}/${cfg.exitCvdCycles}</span>`
          : ''}
      </div>
    </div>`;
  }).join('');
}

function removePosition(sym) {
  const positions = loadPositions();
  delete positions[sym];
  savePositions(positions);
  // Clear CVD counter
  if (window._cvdDeclineCount) delete window._cvdDeclineCount[sym];
  renderPositionTracker();
  logAlertItem('info', `🗑 Position removed: ${sym.replace('BINANCE:','').replace('USDT','')}`);
}

// ══════════════════════════════════════════════════════════════════
// LB ALERT CONFIG CARD — rendered inside renderAlertCfgPage()
// ══════════════════════════════════════════════════════════════════
function renderLbAlertCard() {
  const cfg = loadLbAlertCfg();
  return `
  <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid var(--accent);
              border-radius:8px;padding:16px;" id="lb-alert-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:2px;">
        📊 LEADERBOARD ALERTS
      </div>
      <span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:4px;font-weight:700;
        background:${cfg.enabled ? 'var(--bull-dim)' : 'rgba(100,100,100,.12)'};
        color:${cfg.enabled ? 'var(--bull)' : '#555'};
        border:1px solid ${cfg.enabled ? 'rgba(0,229,160,.3)' : '#2a2a2a'};">
        ${cfg.enabled ? 'ACTIVE' : 'OFF'}
      </span>
    </div>
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:14px;">
      Fires a digested BUY alert when a new card appears on the leaderboard.<br>
      Exit monitoring runs every sync — sell alert fires when distribution is confirmed.
    </div>

    <!-- Master enable -->
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-family:var(--mono);font-size:9px;
                  color:var(--text);margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);">
      <input type="checkbox" id="lb-enabled" ${cfg.enabled ? 'checked' : ''}
        style="width:auto;margin:0;accent-color:var(--accent);"> Enable Leaderboard Alerts
    </label>

    <!-- Setup types -->
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:6px;letter-spacing:1px;">ALERT ON SETUP TYPE</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;">
      ${[
        ['lb-squeeze', 'squeezeEnabled', '🚀 SQUEEZE NOW', 'Compression + vol spike — highest urgency'],
        ['lb-breakout', 'breakoutEnabled', '⚡ BREAKOUT', 'EMA reclaim + momentum — strong entry'],
        ['lb-trending', 'trendingEnabled', '📈 TRENDING', 'Sustained bull — slower, less urgent'],
        ['lb-short', 'shortEnabled', '🔻 SHORT SETUP', 'Bear setups — only enable in bear markets'],
      ].map(([id, key, label, tip]) => `
        <label title="${tip}" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);
                        font-size:8px;color:var(--text);padding:7px 10px;background:var(--bg2);
                        border:1px solid var(--border);border-radius:4px;">
          <input type="checkbox" id="${id}" ${cfg[key] ? 'checked' : ''}
            style="width:auto;margin:0;accent-color:var(--accent);"> ${label}
        </label>`).join('')}
    </div>

    <!-- Numeric settings -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
      ${[
        ['lb-min-score', 'Min Score (0–20)', cfg.minScore, 0, 20, 1,
         'Minimum conviction score to alert. 14+ = high conviction only.'],
        ['lb-cooldown', 'Buy Cooldown (min)', cfg.cooldownMins, 15, 480, 15,
         'Min minutes between buy alerts for the same symbol. 60 = 1hr.'],
        ['lb-holdlock', 'Hold Lock (min)', cfg.holdLockMins, 5, 60, 5,
         'No exit alerts in first N minutes after entry. Prevents panic on retest.'],
      ].map(([id, lbl, val, min, max, step, tip]) => `
        <div title="${tip}">
          <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">${lbl}</label>
          <input type="number" id="${id}" value="${val}" min="${min}" max="${max}" step="${step}"
            style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                   padding:6px 8px;border-radius:4px;font-size:10px;font-family:var(--mono);outline:none;box-sizing:border-box;">
        </div>`).join('')}
    </div>

    <!-- Exit settings -->
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:6px;letter-spacing:1px;">EXIT SIGNAL SETTINGS</div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;
                font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:14px;">
      <div style="margin-bottom:4px;"><b style="color:var(--text);">CVD decline cycles required:</b>
        <input type="number" id="lb-cvd-cycles" value="${cfg.exitCvdCycles}" min="1" max="8" step="1"
          style="width:50px;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:3px 6px;border-radius:3px;font-size:9px;font-family:var(--mono);margin-left:8px;">
        <span style="color:var(--text-dim);margin-left:6px;">(3 = 45s of declining CVD — recommended)</span>
      </div>
      <div style="margin-top:8px;line-height:1.8;color:#666;">
        Exit score ≥ 3 required to fire sell alert:<br>
        CVD down N cycles = +2 (hard gate — required)<br>
        OI distributing + price flat/falling = +2<br>
        Funding &gt; 0.08% = +1 · RSI &gt;75 + any CVD weakness = +1
      </div>
    </div>

    <button onclick="saveLbAlertCfgFromUI()"
      style="background:var(--accent);border:none;color:#fff;padding:8px 20px;
             border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;">
      💾 SAVE LEADERBOARD ALERT CONFIG
    </button>
  </div>`;
}

function saveLbAlertCfgFromUI() {
  const cfg = {
    enabled:        document.getElementById('lb-enabled')?.checked  ?? true,
    squeezeEnabled: document.getElementById('lb-squeeze')?.checked  ?? true,
    breakoutEnabled:document.getElementById('lb-breakout')?.checked ?? true,
    trendingEnabled:document.getElementById('lb-trending')?.checked ?? false,
    shortEnabled:   document.getElementById('lb-short')?.checked    ?? false,
    minScore:       parseInt(document.getElementById('lb-min-score')?.value)  || 14,
    cooldownMins:   parseInt(document.getElementById('lb-cooldown')?.value)   || 60,
    holdLockMins:   parseInt(document.getElementById('lb-holdlock')?.value)   || 20,
    exitCvdCycles:  parseInt(document.getElementById('lb-cvd-cycles')?.value) || 3,
  };
  saveLbAlertCfg(cfg);
  logAlertItem('info', '💾 Leaderboard alert config saved.');
  renderAlertCfgPage();
}
