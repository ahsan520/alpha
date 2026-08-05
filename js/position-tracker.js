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

const POSITION_KEY  = `${_REPO_NS}_positions`;
const LB_ALERT_KEY  = `${_REPO_NS}_lb_alert_cfg`;

// ── Default leaderboard alert config ──
// conv scale reference (calcV2Score max pts):
//   Q1 Technical     0–4
//   Q2 Inst Flow    -5–6
//   Q3 Squeeze       0–4
//   Q4 OB/Sentiment  0–6
//   Sticky buffer   +3 (active slots only)
//   Penalties       -2 to -5 (RSI overbought)
//   Funding bonus   +1.5, News ±3
// Typical active qualifying score: 6–12. 14 was unreachable for most symbols.
// New default: 9 — requires strong flow + squeeze + OB confirmation (less noise).
const DEFAULT_LB_ALERT_CFG = {
  enabled:           true,
  squeezeEnabled:    true,
  breakoutEnabled:   true,
  capBuyEnabled:     true,    // CAP BUY — capitulation bounce, fire immediately (no minScore gate)
  trendingEnabled:   false,   // too slow-moving for actionable alerts
  shortEnabled:      false,   // off by default — noisy in crypto uptrends
  minScore:          9,       // min conv score (out of ~14 realistic max, not 20)
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

// ── Seed localStorage from positions.json on page load ───────────────────────
// Shows any positions written by leaderboard-decider.js (headless) or pushed
// by github-sync.js (Option A/B browser sync) so the Tracker tab is populated
// even after a localStorage wipe or on a new device.
// localStorage remains the live source of truth while the browser is open.
async function seedPositionsFromGitHub() {
  let repo = window.__GH_REPO || '';
  if (!repo) {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (m) repo = `${m[1]}/${location.pathname.split('/').filter(Boolean)[0] || ''}`;
  }
  if (!repo || !repo.includes('/')) return;

  const branch = 'main';
  const fpath  = 'scripts/positions.json';
  const token  = window.__GH_PAT || '';

  try {
    let remote = null;

    // Authenticated Contents API (Option A PAT available)
    if (token) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/contents/${fpath}?ref=${encodeURIComponent(branch)}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
      );
      if (res.ok) {
        const j = await res.json();
        remote = JSON.parse(atob(j.content.replace(/\n/g, '')));
      }
    }

    // Fallback: public raw URL — no auth needed for public repos
    if (!remote) {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${fpath}?t=${Date.now()}`);
      if (res.ok) remote = await res.json();
    }

    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;
    const remoteCount = Object.keys(remote).length;
    if (!remoteCount) return;

    // Merge into localStorage — remote wins only if newer AND not already locally resolved
    const local  = loadPositions();
    const TERMINAL = new Set(['stopped', 'tp2_hit', 'tp1_hit', 'exiting']);
    let   merged = false;
    for (const [sym, pos] of Object.entries(remote)) {
      const existing = local[sym];

      // Never overwrite a locally-resolved position with a stale remote 'watching' entry.
      // e.g. browser marked it stopped, but headless hasn't updated positions.json yet.
      if (existing && TERMINAL.has(existing.status) && pos.status === 'watching') continue;

      // Skip stale remote watching entries — they'll be swept by sweepExpiredPositions
      // after merge, but skip here if staleWatchingMs already elapsed to avoid flash.
      const staleMs  = getStaleWatchingMs();
      const openedAt = pos.alertedAt || 0;
      if (pos.status === 'watching' && Date.now() - openedAt >= staleMs) {
        console.log(`[position-tracker] Skipping stale remote position: ${sym} (${Math.round((Date.now()-openedAt)/3600000)}h old)`);
        continue;
      }

      if (!existing || (pos.alertedAt || 0) > (existing.alertedAt || 0)) {
        local[sym] = pos;
        merged = true;
      }
    }
    if (merged) {
      savePositions(local);
      console.log(`[position-tracker] Seeded ${remoteCount} position(s) from positions.json`);
      renderPositionTracker();
    }
  } catch (e) {
    console.warn('[position-tracker] seed failed:', e.message);
  }
}

// ── Buy cooldown (separate from overnight alert cooldown) ──
function _lbBuyCooldownKey(sym) { return `${_REPO_NS}_lb_buy_${sym}`; }

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

  // Check if Telegram is configured — either via localStorage or env.js (GitHub secrets)
  const _tg = STATE.alertCfg?.telegram || {};
  const tgReady = (_tg.enabled !== false || window.__TG_TOKEN)
    && (_tg.botToken || window.__TG_TOKEN)
    && (_tg.chatId   || window.__TG_CHAT);

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
    // CAP BUY bypasses minScore — capitulation bounces are time-critical;
    // conv here is a flipped bear score, not comparable to bull conv scale.
    const isCapBuy = setup.label === 'CAP BUY';
    const isAlertableSetup =
      (cfg.capBuyEnabled   && isCapBuy)                                       ||
      (cfg.squeezeEnabled  && setup.label === 'SQUEEZE NOW')                  ||
      (cfg.breakoutEnabled && setup.label === 'BREAKOUT')                     ||
      (cfg.trendingEnabled && setup.label === 'TRENDING')                     ||
      (cfg.shortEnabled    && setup.label === 'SHORT SETUP' && dir === 'bear');

    if (!isAlertableSetup) continue;

    // Min score gate — CAP BUY skips (different score scale, time-critical)
    if (!isCapBuy && conv < cfg.minScore) continue;

    // Cooldown gate
    if (_lbIsOnCooldown(sym, cfg.cooldownMins)) {
      const remMins = Math.ceil(_lbCooldownRemaining(sym, cfg.cooldownMins) / 60000);
      logAlertItem('info', `🔕 ${base} [LB ${setup.label}] — cooldown ${remMins}min left`);
      continue;
    }

    // Watchlist alert gate
    if (typeof isAlertEnabled === 'function' && !isAlertEnabled(sym)) continue;

    // ── Open position gate + rotation queue ──
    // If the symbol already has an active (non-terminal) position, skip.
    // If a DIFFERENT symbol is occupying all slots, queue this candidate
    // so it gets promoted automatically when a slot opens.
    {
      const existingPositions = loadPositions();
      const existingPos = existingPositions[sym];
      if (existingPos && !['stopped','tp2_hit'].includes(existingPos.status)) {
        logAlertItem('info', `⏭ ${base} — position already open (${existingPos.status}), skipping`);
        continue;
      }
      // Count active (non-terminal) positions
      const activeCount = Object.values(existingPositions).filter(
        p => !['stopped','tp2_hit'].includes(p.status)
      ).length;
      const MAX_CONCURRENT = parseInt(localStorage.getItem(`${_REPO_NS}_max_positions`) || '4');
      if (activeCount >= MAX_CONCURRENT && !existingPos) {
        // Slots full — queue for rotation
        queueRotationCandidate(sym, conv, setup, d);
        continue;
      }
    }

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
      spikeScore:   (typeof calcSpikeScore === 'function') ? calcSpikeScore(sym, d) : 0,
      session:      getSessionLabel?.() || '—',
      exitAlertedAt: null,
      tier1AlertedAt: null,
      status:       'watching',  // watching | tp1_hit | tp2_hit | stopped | exiting
    };
    savePositions(positions);
    if (typeof scheduleGithubSync === 'function') scheduleGithubSync();
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

    // Find current data — check ranked first, then fall back to STATE.DS.
    // IMPORTANT: previously only ranked was checked, which meant positions
    // whose score dropped below the leaderboard threshold (< minScore) were
    // never monitored — stop/T1/T2 was never detected and the position sat
    // in positions.json/localStorage forever. STATE.DS always has the latest
    // price for every synced symbol regardless of leaderboard score.
    const lbEntry = ranked.find(r => r.sym === sym);
    const dsEntry = STATE.DS?.[sym];
    const d       = lbEntry?.d ?? dsEntry;
    if (!d) {
      console.log(`[position-tracker] No data for ${sym} — skipping monitor`);
      continue;
    }

    const price    = parseFloat(d.p || 0);
    const entry    = pos.entryPrice;
    const stop     = pos.stop;
    const t1       = pos.t1;
    const t2       = pos.t2;
    const isBull   = pos.dir === 'bull' || pos.dir !== 'bear';

    // ── TIER 3: Hard price-based exits (immediate, no lock) ──
    if (isBull && stop > 0 && price <= stop && pos.status !== 'stopped') {
      pos.status        = 'stopped';
      pos.statusChangedAt = now;
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
      if (typeof queueHistoryOutcome === 'function') queueHistoryOutcome(pos, price, 'stopped');
      continue;
    }

    if (isBull && t1 > 0 && price >= t1 && pos.status === 'watching') {
      pos.status        = 'tp1_hit';
      pos.statusChangedAt = now;
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
      pos.statusChangedAt = now;
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
      if (typeof queueHistoryOutcome === 'function') queueHistoryOutcome(pos, price, 'tp2_hit');
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
      pos.statusChangedAt = now;
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
  if (changed && typeof scheduleGithubSync === 'function') scheduleGithubSync();

  // ── Schedule removal of newly-terminal positions ──
  // stopped: removed after 5 min, tp2_hit: after 8 min.
  // We schedule an exact setTimeout rather than waiting for the next
  // sweepExpiredPositions() render cycle — ensures removal happens even
  // if the Alerts tab is closed and renderPositionTracker() isn't running.
  for (const a of [...tier3Alerts]) {
    const pos   = positions[a.sym];
    if (!pos) continue;
    const delay = AUTO_EVICT_MS[pos.status];
    if (!delay) continue;
    setTimeout(async () => {
      const current = loadPositions();
      if (!current[a.sym]) return; // already removed
      if (!['stopped','tp2_hit'].includes(current[a.sym].status)) return; // status changed
      delete current[a.sym];
      if (window._cvdDeclineCount) delete window._cvdDeclineCount[a.sym];
      savePositions(current);
      if (typeof scheduleGithubSync === 'function') scheduleGithubSync();
      logAlertItem('info', `🗑 Removed ${a.base} (${pos.status}) — slot freed`);
      // Promote next queued candidate
      const _cfg     = loadLbAlertCfg();
      const _tgCfg   = STATE.alertCfg?.telegram || {};
      const _tgReady = (_tgCfg.enabled !== false) && !!(_tgCfg.botToken || window.__TG_TOKEN) && !!(_tgCfg.chatId || window.__TG_CHAT);
      await promoteRotationCandidate(_cfg, _tgReady);
      renderPositionTracker();
    }, delay);
  }

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

// ── Auto-eviction delays (ms) ──
// How long a terminal-state position stays in the tracker before removal.
// After removal the slot is freed for the next leaderboard candidate.
const AUTO_EVICT_MS = {
  stopped:  5 * 60 * 1000,   //  5 min — stop hit → free slot fast
  tp2_hit:  8 * 60 * 1000,   //  8 min — full target → celebrate then clear
  tp1_hit: 20 * 60 * 1000,   // 20 min — partial target, still watching T2
  exiting: 10 * 60 * 1000,   // 10 min — distribution confirmed, closing
};

// ── Stale-watching timeout ──
// 'watching' has no entry in AUTO_EVICT_MS because it's the active/open
// state — but if price never tags stop OR target, it sits forever with
// no eviction path. This caps how long a 'watching' position can stay
// open without resolution before being force-closed as STALE and the
// slot freed for rotation. Configurable via localStorage; default 48hr.
function getStaleWatchingMs() {
  const hrs = parseFloat(localStorage.getItem(`${_REPO_NS}_stale_watch_hrs`) || '24');
  return hrs * 60 * 60 * 1000;
}

// ── Rotation queue ──
// When a position is evicted (stop hit or target hit), the next best
// leaderboard candidate is promoted automatically if one is queued.
// Queue entries: { sym, conv, setup, d, timestamp }
if (!window._rotationQueue) window._rotationQueue = [];

const ROTATION_QUEUE_MAX = 10;   // max candidates to buffer
const ROTATION_QUEUE_TTL = 5 * 60 * 1000; // candidates expire after 5 min

// ── Add a candidate to the rotation queue ──
// Called from checkLeaderboardAlerts when a symbol passes all gates
// but an existing position is already open for that slot.
function queueRotationCandidate(sym, conv, setup, d) {
  // Prune expired entries first
  const now = Date.now();
  window._rotationQueue = window._rotationQueue.filter(e => now - e.timestamp < ROTATION_QUEUE_TTL);

  // Don't add if already queued
  if (window._rotationQueue.find(e => e.sym === sym)) return;

  window._rotationQueue.push({ sym, conv, setup, d, timestamp: now });
  // Keep sorted by conviction score desc
  window._rotationQueue.sort((a, b) => b.conv - a.conv);
  // Cap queue size
  if (window._rotationQueue.length > ROTATION_QUEUE_MAX)
    window._rotationQueue = window._rotationQueue.slice(0, ROTATION_QUEUE_MAX);

  const base = sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');
  logAlertItem('info', `📋 Queued ${base} [${setup.label}] conv:${conv} for rotation`);
}

// ── Promote next queued candidate after a slot opens ──
// Called by sweepExpiredPositions after each eviction.
async function promoteRotationCandidate(cfg, tgReady) {
  const now = Date.now();
  // Prune stale entries
  window._rotationQueue = window._rotationQueue.filter(e => now - e.timestamp < ROTATION_QUEUE_TTL);
  if (!window._rotationQueue.length) return;

  // Find best candidate not already on cooldown and not already in positions
  const positions = loadPositions();
  const candidate = window._rotationQueue.find(e =>
    !positions[e.sym] && !_lbIsOnCooldown(e.sym, cfg?.cooldownMins || 60)
  );
  if (!candidate) return;

  // Remove from queue
  window._rotationQueue = window._rotationQueue.filter(e => e.sym !== candidate.sym);

  // Open the position
  const { sym, conv, setup, d } = candidate;
  const base   = sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');
  const levels = typeof calcEntryLevels === 'function' ? calcEntryLevels(d) : null;
  const entryP = levels ? parseFloat(levels.entry) : parseFloat(d.p || 0);
  const stopP  = levels ? parseFloat(levels.stop)  : 0;
  const t1P    = levels ? parseFloat(levels.t1)    : 0;
  const t2P    = levels ? parseFloat(levels.t2)    : 0;

  positions[sym] = {
    sym, base,
    setup:         setup.label,
    dir:           setup.label === 'SHORT SETUP' ? 'bear' : 'bull',
    alertedAt:     now,
    holdLockUntil: now + (cfg?.holdLockMins || 20) * 60000,
    entryPrice:    entryP,
    stop:          stopP,
    t1:            t1P,
    t2:            t2P,
    score:         conv,
    spikeScore:    0,
    session:       typeof getSessionLabel === 'function' ? (getSessionLabel() || '—') : '—',
    exitAlertedAt: null,
    tier1AlertedAt:null,
    status:        'watching',
    rotatedIn:     true,   // flag: this position was promoted from rotation queue
  };
  savePositions(positions);
  _lbMarkBuyFired(sym);
  if (typeof scheduleGithubSync === 'function') scheduleGithubSync();

  logAlertItem('buy', `🔄 ROTATED IN — ${base} [${setup.label}] conv:${conv}`);

  // Send Telegram rotation alert
  if (tgReady && typeof isAlertEnabled === 'function' && isAlertEnabled(sym)) {
    const session = typeof getSessionLabel === 'function' ? (getSessionLabel() || '—') : '—';
    const utc     = new Date().toUTCString().slice(17, 22) + ' UTC';
    const msg = [
      `🔄 *ROTATION — New Position Opened* — ${utc}`,
      `${setup.emoji} *${base}* — ${setup.label}  [${conv}/20]`,
      `  Entry $${entryP}  Stop $${stopP}  T1 $${t1P}  T2 $${t2P}`,
      `  _Slot freed by previous stop/target — next best candidate promoted_`,
      `  Session: ${session}`,
    ].join('\n');
    if (typeof sendTelegramAlert === 'function') await sendTelegramAlert(msg);
  }

  renderPositionTracker();
}

// ── Auto-eviction sweep ──
// Removes positions in terminal state, frees slot, promotes next candidate.
async function sweepExpiredPositions(cfg, tgReady) {
  const positions = loadPositions();
  const now = Date.now();
  let changed = false;
  let slotFreed = false;
  const staleWatchMs = getStaleWatchingMs();

  for (const [sym, pos] of Object.entries(positions)) {
    const base = sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');

    // ── Stale 'watching' — never hit stop or target ──
    if (pos.status === 'watching') {
      const openedAt = pos.alertedAt || 0;
      if (now - openedAt >= staleWatchMs) {
        delete positions[sym];
        if (window._cvdDeclineCount) delete window._cvdDeclineCount[sym];
        const ageHrs = Math.round((now - openedAt) / 3600000);
        logAlertItem('info', `🗑 STALE — ${base} watching ${ageHrs}h → evicted, slot freed`);
        changed   = true;
        slotFreed = true;
      }
      continue;
    }

    // ── Terminal states — remove after eviction window ──
    // Covers: stopped (5min), tp2_hit (8min), tp1_hit (20min), exiting (10min)
    const delay = AUTO_EVICT_MS[pos.status];
    if (!delay) continue; // unknown status — leave alone

    const changedAt = pos.statusChangedAt || pos.alertedAt || 0;
    if (now - changedAt >= delay) {
      delete positions[sym];
      if (window._cvdDeclineCount) delete window._cvdDeclineCount[sym];
      logAlertItem('info', `🗑 Removed ${base} (${pos.status} ${Math.round(delay/60000)}min) → slot freed`);
      changed   = true;
      slotFreed = true;
    }
  }

  if (changed) savePositions(positions);
  if (changed && typeof scheduleGithubSync === 'function') scheduleGithubSync();

  // Promote next candidate if a slot was freed
  if (slotFreed) await promoteRotationCandidate(cfg, tgReady);

  return changed;
}

async function renderPositionTracker() {
  const el = document.getElementById('position-tracker-panel');
  if (!el) return;

  // Sweep expired positions first — may remove entries before render
  // Pass cfg + tgReady so promoteRotationCandidate can fire Telegram if needed
  const _cfg     = loadLbAlertCfg();
  const _tgCfg   = STATE.alertCfg?.telegram || {};
  const _tgReady = (_tgCfg.enabled !== false || window.__TG_TOKEN)
    && (_tgCfg.botToken || window.__TG_TOKEN)
    && (_tgCfg.chatId   || window.__TG_CHAT);
  await sweepExpiredPositions(_cfg, _tgReady);

  const positions = loadPositions();
  const cfg       = loadLbAlertCfg();
  const entries   = Object.values(positions)
    .sort((a, b) => (b.alertedAt || 0) - (a.alertedAt || 0)); // newest alert first

  // ── Rotation queue panel ──
  const queueEntries = (window._rotationQueue || []).filter(
    e => Date.now() - e.timestamp < ROTATION_QUEUE_TTL
  );

  const activeCount = entries.filter(p => !['stopped','tp2_hit'].includes(p.status)).length;
  const MAX_CONCURRENT = parseInt(localStorage.getItem(`${_REPO_NS}_max_positions`) || '4');
  const slotsAvailable = Math.max(0, MAX_CONCURRENT - activeCount);

  // ── Browser alerts pause/resume pill ──
  const paused   = STATE.browserAlertsPaused;
  const pausePill = `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:8px;
                background:${paused ? 'rgba(255,140,0,.07)' : 'rgba(61,255,120,.05)'};
                border:1px solid ${paused ? 'rgba(255,140,0,.3)' : 'rgba(61,255,120,.2)'};
                border-radius:5px;font-family:var(--mono);font-size:8px;">
      <span style="color:${paused ? '#ff8c00' : '#3dff78'};font-weight:700;letter-spacing:1px;">
        ${paused ? '⏸ BROWSER ALERTS PAUSED' : '▶ BROWSER ALERTS ACTIVE'}
      </span>
      <span style="color:var(--text-dim);flex:1;">
        ${paused
          ? 'Telegram alerts from this browser tab are suppressed. Headless Job B alerts still fire.'
          : 'This browser tab will send Telegram alerts when price conditions are met.'}
      </span>
      <button onclick="toggleBrowserAlerts()"
        style="padding:4px 14px;border-radius:4px;cursor:pointer;font-family:var(--mono);
               font-size:8px;font-weight:700;letter-spacing:1px;border:1px solid;
               background:${paused ? 'rgba(61,255,120,.1)' : 'rgba(255,140,0,.1)'};
               color:${paused ? '#3dff78' : '#ff8c00'};
               border-color:${paused ? 'rgba(61,255,120,.4)' : 'rgba(255,140,0,.4)'};">
        ${paused ? '▶ RESUME' : '⏸ PAUSE'}
      </button>
    </div>`;

  // Queue panel HTML
  const queueHTML = queueEntries.length ? `
    <div style="background:rgba(77,166,255,.07);border:1px solid rgba(77,166,255,.2);
                border-radius:5px;padding:8px 10px;margin-bottom:8px;font-family:var(--mono);font-size:8px;">
      <div style="color:#4da6ff;font-weight:700;margin-bottom:5px;letter-spacing:1px;">
        📋 ROTATION QUEUE (${queueEntries.length}) — ${slotsAvailable} slot${slotsAvailable !== 1 ? 's' : ''} free
      </div>
      ${queueEntries.map((e,i) => {
        const qBase = e.sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');
        const ageSec = Math.round((Date.now() - e.timestamp) / 1000);
        const ttlSec = Math.round(ROTATION_QUEUE_TTL / 1000 - ageSec);
        return `<div style="display:flex;gap:8px;align-items:center;padding:2px 0;
                            border-top:${i>0?'1px solid rgba(77,166,255,.1)':'none'};">
          <span style="color:#4da6ff;min-width:16px;">#${i+1}</span>
          <span style="color:var(--text-bright);font-weight:700;">${qBase}</span>
          <span style="color:var(--accent);">${e.setup?.emoji || ''} ${e.setup?.label || ''}</span>
          <span style="color:var(--text-dim);">conv:${e.conv}</span>
          <span style="color:var(--text-dim);margin-left:auto;font-size:7px;">
            ${ttlSec > 0 ? `expires ${ttlSec}s` : 'expiring…'}
          </span>
          <button onclick="dequeueCandidate('${e.sym}')"
            style="background:none;border:1px solid var(--border2);color:var(--text-dim);
                   padding:0 5px;border-radius:3px;cursor:pointer;font-size:7px;">✕</button>
        </div>`;
      }).join('')}
    </div>` : '';

  if (!entries.length && !queueEntries.length) {
    el.innerHTML = pausePill + `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:12px;">
      No active positions — leaderboard buy alert will create entries here.</div>`;
    return;
  }

  // Pause pill — managed element so it doesn't force a full innerHTML wipe
  let pillEl = el.querySelector('.pt-pause-pill');
  if (!pillEl) {
    pillEl = document.createElement('div');
    pillEl.className = 'pt-pause-pill';
    el.prepend(pillEl);
  }
  pillEl.innerHTML = pausePill;

  // Prepend queue panel to output
  const queuePanelEl = el.querySelector('.pt-queue-panel') || (() => {
    const d = document.createElement('div');
    d.className = 'pt-queue-panel';
    pillEl.after(d);
    return d;
  })();
  queuePanelEl.innerHTML = queueHTML;

  if (!entries.length) return; // only queue, no active positions

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

  // Countdown to auto-eviction for terminal states — updates every second
  function evictCountdown(pos) {
    const delay = AUTO_EVICT_MS[pos.status];
    if (!delay) return '';
    const changedAt = pos.statusChangedAt || pos.alertedAt || 0;
    const remaining = Math.max(0, delay - (Date.now() - changedAt));
    const remMins   = Math.ceil(remaining / 60000);
    const remSecs   = Math.ceil(remaining / 1000);
    const id        = `evict-cd-${pos.sym.replace(/[^a-z0-9]/gi,'')}`;
    const txt = remaining <= 0
      ? 'removing…'
      : remaining < 60000 ? `removing in ${remSecs}s`
      :                     `removing in ${remMins}min`;
    // Kick off a live countdown ticker on first render
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el || el._ticking) return;
      el._ticking = true;
      const tick = setInterval(() => {
        const rem2 = Math.max(0, delay - (Date.now() - changedAt));
        if (!document.getElementById(id)) { clearInterval(tick); return; }
        if (rem2 <= 0) { clearInterval(tick); el.textContent = '⏳ removing…'; return; }
        const s = Math.ceil(rem2 / 1000);
        const m = Math.ceil(rem2 / 60000);
        el.textContent = `⏳ ${rem2 < 60000 ? `removing in ${s}s` : `removing in ${m}min`}`;
      }, 1000);
    }, 0);
    return `<span id="${id}" style="color:var(--text-dim);font-size:7px;font-family:var(--mono);opacity:.7;">⏳ ${txt}</span>`;
  }

  el.innerHTML = entries.map(pos => {
    // Pull live data from the leaderboard ranked array (STATE._ranked) instead
    // of STATE.DS — STATE.DS is shared across tabs and bleeds wrong symbols.
    const lbEntry = (STATE._ranked || []).find(r => r.sym === pos.sym);
    const liveD   = lbEntry?.d || {};
    const price   = parseFloat(liveD.p || pos.entryPrice);
    const pnlPct  = pos.entryPrice > 0
      ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)
      : '—';
    const pnlColor = parseFloat(pnlPct) >= 0 ? 'var(--bull)' : 'var(--bear)';
    const age     = Math.floor((Date.now() - pos.alertedAt) / 60000);
    const locked  = Date.now() < pos.holdLockUntil;
    const lockRem = locked ? Math.ceil((pos.holdLockUntil - Date.now()) / 60000) : 0;

    // Live spike potential — recalculated on every render tick
    const liveSpikeScore = (typeof calcSpikeScore === 'function' && liveD.p)
      ? calcSpikeScore(pos.sym, liveD)
      : (pos.spikeScore || 0);
    const spikeInfo = typeof spikeLabelFromScore === 'function'
      ? spikeLabelFromScore(liveSpikeScore) : { label: '—', cls: 'spike-none' };

    // Spike colour inline (position-tracker has no class stylesheet loaded)
    const spikeColor = spikeInfo.cls === 'spike-high' ? '#ffa000'
                     : spikeInfo.cls === 'spike-med'  ? '#00c8ff'
                     : 'var(--text-dim)';

    // Recommendation tags written by leaderboard-decider.js at alert time —
    // undefined on older positions opened before this feature, so guard.
    const recoBadge = pos.recommended
      ? `<span title="Ranked top pick when this alert fired — current signal + history bonus"
               style="color:#ffd700;font-size:8px;font-weight:700;">⭐</span>`
      : '';
    const histTip = pos.histSample
      ? `Past history at alert time: ${Math.round((pos.histWinRate||0) * pos.histSample)}W-${pos.histSample - Math.round((pos.histWinRate||0) * pos.histSample)}L (${Math.round((pos.histWinRate||0)*100)}%)`
      : 'No trade history yet at alert time';
    const cautionBadge = pos.caution
      ? `<span title="${histTip} — rough recent record, treat as a reversal bet not a repeat pattern"
               style="color:#ff8c00;font-size:7px;font-weight:700;border:1px solid #ff8c00;
                      padding:1px 5px;border-radius:3px;">⚠ CAUTION</span>`
      : '';

    // v15 Position Intelligence — written every cycle by position-monitor.js
    // (position-intelligence.js's evaluatePosition) onto pos.lastPI. Absent
    // on positions opened before this feature, or before the first Job B
    // cycle after opening (min position age gate) — guard accordingly.
    const pi = pos.lastPI;
    const piActionColor = pi && (pi.action === 'EMERGENCY_EXIT' ? 'var(--bear)'
                        : pi.action === 'EXIT'      ? 'var(--bear)'
                        : pi.action === 'REDUCE_50' ? '#ff8c00'
                        : pi.action === 'REDUCE_25' ? '#ffa500'
                        : 'var(--text-dim)');
    const piBadge = pi && pi.action && pi.action !== 'HOLD'
      ? `<span title="${(pi.reason || '').replace(/"/g,'&quot;')}"
               style="color:${piActionColor};font-size:7px;font-weight:700;border:1px solid ${piActionColor};
                      padding:1px 5px;border-radius:3px;">🧠 ${pi.action.replace('_',' ')}</span>`
      : '';
    const piRow = pi
      ? `<div style="display:flex;gap:10px;align-items:center;margin-top:4px;font-size:7px;color:var(--text-dim);"
              title="Falling Knife / Thesis Drop / Confidence Decay / Exit Probability — v15 Position Intelligence Engine">
          <span>Knife: <b style="color:${pi.fallingKnifeScore > 70 ? 'var(--bear)' : 'var(--text-dim)'}">${pi.fallingKnifeScore}</b></span>
          <span>Thesis Δ: <b>${pi.thesisDrop != null ? pi.thesisDrop.toFixed(0) : '—'}</b></span>
          <span>Decay: <b>${pi.confidenceDecay}%</b></span>
          <span>Exit prob: <b style="color:${pi.exitProbability > 70 ? 'var(--bear)' : pi.exitProbability > 50 ? '#ff8c00' : 'var(--text-dim)'}">${pi.exitProbability}</b></span>
          ${pi.recovery?.recovering ? `<span style="color:var(--bull);">↗ recovering</span>` : ''}
        </div>`
      : '';

    return `
    <div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${statusColor(pos.status)};
                border-radius:6px;padding:10px 12px;margin-bottom:8px;font-family:var(--mono);font-size:9px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="color:var(--text-bright);font-weight:700;font-size:10px;" title="${pos.histSample ? histTip : ''}">${pos.base}</span>
        ${recoBadge}
        <span style="color:${statusColor(pos.status)};font-size:8px;letter-spacing:1px;">${statusLabel(pos.status)}</span>
        ${cautionBadge}
        ${evictCountdown(pos)}
        ${piBadge}
        <span title="Live spike potential: ${liveSpikeScore}/100 — resistance room + vol + funding + short squeeze fuel"
              style="color:${spikeColor};font-size:7px;font-weight:700;border:1px solid ${spikeColor};
                     padding:1px 5px;border-radius:3px;opacity:.8;">SPIKE ${liveSpikeScore}</span>
        <button onclick="removePosition('${pos.sym}')"
          style="background:none;border:1px solid var(--border2);color:var(--text-dim);
                 padding:1px 7px;border-radius:3px;cursor:pointer;font-size:8px;">✕</button>
        ${pos.status === 'watching' && age > 120 ? `
        <button onclick="forceEvictPosition('${pos.sym}')" title="Force-evict this stale position and free the slot for rotation"
          style="background:rgba(255,140,0,.15);border:1px solid #ff8c00;color:#ff8c00;
                 padding:1px 7px;border-radius:3px;cursor:pointer;font-size:8px;">⚠ STALE</button>` : ''}
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
      ${piRow}
    </div>`;
  }).join('');
}

function removePosition(sym) {
  const positions = loadPositions();
  delete positions[sym];
  savePositions(positions);
  if (typeof scheduleGithubSync === 'function') scheduleGithubSync();
  if (window._cvdDeclineCount) delete window._cvdDeclineCount[sym];
  renderPositionTracker();
  logAlertItem('info', `🗑 Position removed: ${sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'')}`);
}

// ── Remove a single candidate from the rotation queue ──
function dequeueCandidate(sym) {
  window._rotationQueue = (window._rotationQueue || []).filter(e => e.sym !== sym);
  const base = sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');
  logAlertItem('info', `✕ Removed ${base} from rotation queue`);
  renderPositionTracker();
}

// ── Clear entire rotation queue ──
function clearRotationQueue() {
  const count = (window._rotationQueue || []).length;
  window._rotationQueue = [];
  logAlertItem('info', `🗑 Rotation queue cleared (${count} candidate${count !== 1 ? 's' : ''})`);
  renderPositionTracker();
}

// ── Manually force-evict a stale watching position ──
function forceEvictPosition(sym) {
  const positions = loadPositions();
  if (!positions[sym]) return;
  const base = sym.replace('BINANCE:','').replace('USDT','').replace(/\.\w+$/,'');
  delete positions[sym];
  savePositions(positions);
  if (window._cvdDeclineCount) delete window._cvdDeclineCount[sym];
  if (typeof scheduleGithubSync === 'function') scheduleGithubSync();
  logAlertItem('info', `⚠️ Force-evicted ${base} → slot freed`);
  renderPositionTracker();
  // Immediately try to promote from queue
  const _cfg     = loadLbAlertCfg();
  const _tgCfg   = STATE.alertCfg?.telegram || {};
  const _tgReady = (_tgCfg.enabled !== false) && !!(_tgCfg.botToken || window.__TG_TOKEN) && !!(_tgCfg.chatId || window.__TG_CHAT);
  promoteRotationCandidate(_cfg, _tgReady);
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
        ['lb-cap-buy',  'capBuyEnabled',  '💥 CAP BUY',     'Capitulation bounce — fires immediately, no min-score gate'],
        ['lb-squeeze',  'squeezeEnabled', '🚀 SQUEEZE NOW', 'Compression + vol spike — highest urgency'],
        ['lb-breakout', 'breakoutEnabled','⚡ BREAKOUT',     'EMA reclaim + momentum — strong entry'],
        ['lb-trending', 'trendingEnabled','📈 TRENDING',     'Sustained bull — slower, less urgent'],
        ['lb-short',    'shortEnabled',   '🔻 SHORT SETUP',  'Bear setups — only enable in bear markets'],
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
        ['lb-min-score', 'Min Score (0–14)', cfg.minScore, 0, 14, 1,
         'Min conv score. Typical range 6–12. 7 = recommended. CAP BUY ignores this gate.'],
        ['lb-cooldown', 'Buy Cooldown (min)', cfg.cooldownMins, 15, 480, 15,
         'Min minutes between buy alerts for the same symbol. 60 = 1hr.'],
        ['lb-holdlock', 'Hold Lock (min)', cfg.holdLockMins, 5, 60, 5,
         'No exit alerts in first N minutes after entry. Prevents panic on retest.'],
        ['lb-max-pos', 'Max Concurrent Positions', parseInt(localStorage.getItem(`${_REPO_NS}_max_positions`) || '4'), 1, 10, 1,
         'Max open positions before new signals are queued for rotation instead of immediately opened.'],
        ['lb-stale-hrs', 'Stale-Watch Timeout (hrs)', parseFloat(localStorage.getItem(`${_REPO_NS}_stale_watch_hrs`) || '48'), 4, 168, 4,
         'Force-evict a watching position after N hours with no stop or target hit. Fixes the stuck-symbol bug. 48hr = 2 trading days.'],
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
    enabled:        document.getElementById('lb-enabled')?.checked   ?? true,
    capBuyEnabled:  document.getElementById('lb-cap-buy')?.checked   ?? true,
    squeezeEnabled: document.getElementById('lb-squeeze')?.checked   ?? true,
    breakoutEnabled:document.getElementById('lb-breakout')?.checked  ?? true,
    trendingEnabled:document.getElementById('lb-trending')?.checked  ?? false,
    shortEnabled:   document.getElementById('lb-short')?.checked     ?? false,
    minScore:       parseInt(document.getElementById('lb-min-score')?.value)  || 9,
    cooldownMins:   parseInt(document.getElementById('lb-cooldown')?.value)   || 60,
    holdLockMins:   parseInt(document.getElementById('lb-holdlock')?.value)   || 20,
    exitCvdCycles:  parseInt(document.getElementById('lb-cvd-cycles')?.value) || 3,
  };
  saveLbAlertCfg(cfg);
  // max_positions and stale_watch_hrs stored separately (localStorage only — not in positions.json)
  const maxPos   = parseInt(document.getElementById('lb-max-pos')?.value)   || 4;
  const staleHrs = parseFloat(document.getElementById('lb-stale-hrs')?.value) || 48;
  localStorage.setItem(`${_REPO_NS}_max_positions`,  String(maxPos));
  localStorage.setItem(`${_REPO_NS}_stale_watch_hrs`, String(staleHrs));
  logAlertItem('info', `💾 Config saved — max positions: ${maxPos} · stale timeout: ${staleHrs}h`);
  renderAlertCfgPage();
}

// ── On page load: seed positions from GitHub repo (headless-written entries) ──
// Runs once after scripts load. window.__GH_REPO is set by env.js only when
// the page is served mid-workflow; for GitHub Pages it will be blank, so
// seedPositionsFromGitHub() silently no-ops. The repo URL is always public,
// so unauthenticated GET works for public repos — token only needed for private.
document.addEventListener('DOMContentLoaded', () => {
  // Small delay so renderPositionTracker() from app.js initialises first
  setTimeout(() => seedPositionsFromGitHub(), 2000);
});
