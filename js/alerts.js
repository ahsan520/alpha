// ══════════════════════════════════════════════
// alerts.js — alert config, dispatch, checklist rules
// ══════════════════════════════════════════════

// ── Overnight checklist conditions (evaluated together as 1 combined alert) ──
const OVN_BUY_CONDITIONS = [
  { id: 'ovn_buy_4h',     required: true,  enabled: true,  label: '4H Bias',      desc: 'BULL 4H or LEAN BULL',        tip: 'MUST — 4H structure must be bullish before entering overnight longs.' },
  { id: 'ovn_buy_daily',  required: true,  enabled: true,  label: 'Daily Bias',   desc: 'BULL / LEAN BULL / NEUTRAL',  tip: 'MUST — Daily must not be bearish. BEAR DAY / LEAN BEAR disqualifies.' },
  { id: 'ovn_buy_signal', required: false, enabled: true,  label: 'Signal',       desc: 'STRONG BUY or BULLISH',       tip: 'OPTIONAL — Tick to require signal confirmation before alerting.' },
  { id: 'ovn_buy_oi',     required: false, enabled: false, label: 'OI / Funding', desc: 'OI DROP or CONFIRM',          tip: 'OPTIONAL — Tick to enforce OI/funding filter on overnight longs.' },
];

const OVN_SELL_CONDITIONS = [
  { id: 'ovn_sell_daily',  required: true,  enabled: true,  label: 'Daily Bias',  desc: 'LEAN BEAR or BEAR DAY',          tip: 'MUST — Daily must confirm bearish. Do not short a bull trend overnight.' },
  { id: 'ovn_sell_4h',     required: true,  enabled: true,  label: '4H Bias',     desc: 'NEUTRAL / LEAN BEAR / BEAR 4H',  tip: 'MUST — 4H must have flipped or neutralised before entering shorts.' },
  { id: 'ovn_sell_signal', required: false, enabled: true,  label: 'Signal',      desc: 'BEARISH or definitive WAIT',      tip: 'OPTIONAL — Tick to require bearish signal confirmation.' },
  { id: 'ovn_sell_oi',     required: false, enabled: false, label: 'OI Div',      desc: 'BEAR OI or OI DROP',              tip: 'OPTIONAL — Tick to enforce aggressive distribution trigger.' },
  { id: 'ovn_sell_ls',     required: false, enabled: false, label: 'L/S Ratio',   desc: '≥65% Longs (squeeze target)',    tip: 'OPTIONAL — Tick to target long-skewed squeeze setups only.' },
];

// ── Signal rules ──
// All signal and overnight rules are OFF by default.
// Only the position tracker (leaderboard buy/exit alerts) sends Telegram by default.
// Enable rules manually in the Alert Configuration panel and click Save All.
const DEFAULT_RULES = [
  { id: 'vol_bull_4h', label: 'Vol Shock > 1.5× AND 4H Bias = Bullish', group: 'signals', action: 'buy',  enabled: false, channels: ['email','telegram'] },
  { id: 'strong_buy',  label: 'Signal = STRONG BUY',                     group: 'signals', action: 'buy',  enabled: false, channels: ['email','telegram'] },
  { id: 'strong_sell', label: 'Signal = STRONG SELL / BEARISH',          group: 'signals', action: 'sell', enabled: false, channels: ['email','telegram'] },
  { id: 'bearish_day', label: '4H = BEAR + Daily = BEAR DAY',            group: 'signals', action: 'sell', enabled: false, channels: ['telegram'] },
  { id: 'dip_buy',     label: 'Dip Score = BUY DIP (score ≥ 5)',        group: 'signals', action: 'buy',  enabled: false, channels: ['telegram'] },

  // Combined overnight alerts (single rule per direction)
  {
    id: 'overnight_buy',
    label: 'Overnight BUY — all must-have conditions met',
    group: 'overnight_buy',
    action: 'buy',
    enabled: false,
    channels: ['telegram'],
    minRequired: 2,   // both MUST HAVE conditions
    minOptional: 1,   // at least 1 of the optional confirmations
  },
  {
    id: 'overnight_sell',
    label: 'Overnight SELL — all must-have conditions met',
    group: 'overnight_sell',
    action: 'sell',
    enabled: false,
    channels: ['telegram'],
    minRequired: 2,
    minOptional: 1,
  },
];

// ── Config version — bump this whenever DEFAULT_RULES enabled states change. ──
// On load, if the saved version doesn't match, rule enabled states are reset
// to the new defaults. Credentials (bot token, chat ID, email) are always kept.
const ALERT_CFG_VERSION = 3; // bumped: telegram enabled=true, cooldown=1h by default

function mergeRules(saved, resetEnabled) {
  // resetEnabled=true: ignore saved enabled states, use DEFAULT_RULES as-is.
  // resetEnabled=false: normal merge — saved enabled wins (user explicitly changed it).
  const savedMap = Object.fromEntries((saved || []).map(r => [r.id, r]));
  return DEFAULT_RULES.map(def => {
    const s = savedMap[def.id];
    if (!s || resetEnabled) return { ...def };
    return { ...def, enabled: s.enabled, channels: s.channels,
      minRequired: s.minRequired ?? def.minRequired,
      minOptional: s.minOptional ?? def.minOptional };
  });
}

function mergeConditions(defaults, saved) {
  if (!saved || !saved.length) return defaults.map(c => ({ ...c }));
  const savedMap = Object.fromEntries(saved.map(c => [c.id, c]));
  return defaults.map(def => savedMap[def.id]
    ? { ...def, enabled: savedMap[def.id].enabled }
    : def
  );
}

function initAlertCfg() {
  const raw = JSON.parse(localStorage.getItem(`${_REPO_NS}_alertcfg`) || '{}');

  // Version check — if saved config is from an older version, reset rule
  // enabled states to current defaults but keep all credentials intact.
  const savedVersion  = raw._version || 0;
  const versionMismatch = savedVersion < ALERT_CFG_VERSION;
  if (versionMismatch) {
    console.log(`[alerts] Config version ${savedVersion} → ${ALERT_CFG_VERSION}: resetting rule enabled states to defaults`);
  }

  // On version mismatch: keep credentials but reset enabled states and cooldown
  const tgBase = raw.telegram || {};
  STATE.alertCfg = {
    email:    { enabled: false, address: '', emailjsServiceId: '', emailjsTemplateId: '', emailjsPublicKey: '', ...(raw.email || {}) },
    telegram: {
      // Always default enabled to true. On version mismatch force it true.
      // On normal load, respect saved value but default to true if never set.
      enabled:  versionMismatch ? true : (tgBase.enabled !== false ? true : false),
      // Fall back to window.__TG_TOKEN / __TG_CHAT injected by env.js (GitHub Actions).
      // This means leaderboard + position tracker alerts work from GitHub secrets alone
      // without the user ever having to paste credentials into the GUI.
      botToken: tgBase.botToken || window.__TG_TOKEN || '',
      chatId:   tgBase.chatId   || window.__TG_CHAT  || '',
    },
    rules:        mergeRules(raw.rules || [], versionMismatch),
    digestMode:   raw.digestMode !== false,
    cooldownHours: versionMismatch ? 1 : (raw.cooldownHours ?? 1),
    ovnBuyConditions:  mergeConditions(OVN_BUY_CONDITIONS,  raw.ovnBuyConditions),
    ovnSellConditions: mergeConditions(OVN_SELL_CONDITIONS, raw.ovnSellConditions),
    _version: ALERT_CFG_VERSION,
  };

  // Persist the migrated config immediately so the next load sees the new version
  if (versionMismatch) {
    localStorage.setItem(`${_REPO_NS}_alertcfg`, JSON.stringify(STATE.alertCfg));
  }
}

// ── Alert log ──
function logAlertItem(type, msg) {
  // Infer display type from message content so the log is colour-coded
  // without requiring every call site to pass the right type.
  let displayType = type;
  if (msg.startsWith('🔕') || msg.includes('cooldown') || msg.includes('suppressed') || msg.includes('SKIPPED')) {
    displayType = 'suppressed';
  } else if (msg.startsWith('🟢') || msg.includes('[BUY]') || msg.includes('OVERNIGHT BUY') || msg.includes('🌙🟢')) {
    displayType = 'buy';
  } else if (msg.startsWith('🔴') || msg.includes('[SELL]') || msg.includes('OVERNIGHT SELL') || msg.includes('🌙🔴')) {
    displayType = 'sell';
  } else if (msg.startsWith('✈') || msg.includes('Telegram sent')) {
    displayType = 'sent';
  }
  STATE.alertLog.unshift({ type: displayType, msg, time: new Date().toLocaleTimeString() });
  if (STATE.alertLog.length > 120) STATE.alertLog.pop();
  const strip = document.getElementById('alert-strip');
  if (strip) {
    strip.innerHTML = STATE.alertLog.map(a =>
      `<div class="alert-item ${a.type}"><span class="at">${a.time}</span><span> ${a.msg}</span></div>`
    ).join('');
  }
  renderAlertLog();
}

// ── Email ──
async function sendEmailAlert(msg) {
  const { email } = STATE.alertCfg;
  if (!email.enabled || !email.emailjsPublicKey) return;
  try {
    if (!window.emailjs) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
      window.emailjs.init({ publicKey: email.emailjsPublicKey });
    }
    await window.emailjs.send(email.emailjsServiceId, email.emailjsTemplateId, {
      to_email: email.address, subject: '🔔 Alpha Terminal Alert',
      message: msg, time: new Date().toLocaleString()
    });
    logAlertItem('info', `✉ Email sent: ${msg.substring(0,60)}…`);
  } catch(e) { logAlertItem('info', `✉ Email FAILED: ${e.message}`); }
}

// ── Telegram ──
async function sendTelegramAlert(msg) {
  // Browser-side pause toggle — set from Position Tracker header button
  if (STATE.browserAlertsPaused) {
    logAlertItem('info', `[TG PAUSED] ${msg.substring(0,60)}…`);
    return;
  }
  const { telegram } = STATE.alertCfg;
  // Fall back to window globals injected by env.js (GitHub Actions secrets)
  const token  = telegram.botToken || window.__TG_TOKEN || '';
  const chatId = telegram.chatId   || window.__TG_CHAT  || '';
  if ((!telegram.enabled && !window.__TG_TOKEN) || !token || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId,
        text: `🔔 *Alpha Terminal*\n\n${msg}\n\n_${new Date().toLocaleString()}_`,
        parse_mode: 'Markdown' })
    });
    const d = await r.json();
    if (d.ok) logAlertItem('info', `✈ Telegram sent: ${msg.substring(0,60)}…`);
    else       logAlertItem('info', `✈ Telegram FAILED: ${d.description}`);
  } catch(e) { logAlertItem('info', `✈ Telegram FAILED: ${e.message}`); }
}

function dispatchAlert(rule, msg, sym) {
  logAlertItem('info', `[ALERT] ${msg}`);
  if (rule.channels.includes('email'))    sendEmailAlert(msg);
  // ── Alert filter: only send Telegram if ticker has alerts enabled ──
  if (rule.channels.includes('telegram')) {
    if (!sym || (typeof isAlertEnabled === 'function' && isAlertEnabled(sym))) {
      sendTelegramAlert(msg);
    } else {
      logAlertItem('info', `[TG SKIPPED] ${sym} — alerts disabled in Watchlist Manager`);
    }
  }
}

// ── Evaluate a single overnight condition ──
function evalOvnCond(condId, d, shock) {
  const { bias4h, biasDay, sig, oiDiv, lp } = d;
  switch (condId) {
    case 'ovn_buy_4h':     return !!(bias4h  && (bias4h.includes('BULL 4H')    || bias4h.includes('LEAN BULL')));
    case 'ovn_buy_daily':  return !!(biasDay && (biasDay.includes('BULL') || biasDay.includes('LEAN BULL') || biasDay.includes('NEUTRAL')));
    case 'ovn_buy_signal': return sig === 'STRONG BUY' || sig === 'BULLISH';
    case 'ovn_buy_oi':     return !!(oiDiv   && (oiDiv.includes('OI DROP')     || oiDiv.includes('CONFIRM')));
    case 'ovn_sell_daily': return !!(biasDay && (biasDay.includes('LEAN BEAR') || biasDay.includes('BEAR DAY')));
    case 'ovn_sell_4h':    return !!(bias4h  && (bias4h.includes('NEUTRAL')    || bias4h.includes('LEAN BEAR') || bias4h.includes('BEAR 4H')));
    case 'ovn_sell_signal':return sig === 'BEARISH' || sig === 'STRONG SELL' || sig === 'WAIT';
    case 'ovn_sell_oi':    return !!(oiDiv   && (oiDiv.includes('BEAR OI')     || oiDiv.includes('OI DROP')));
    case 'ovn_sell_ls':    return (lp || 50) >= 65;
    default: return false;
  }
}

// ── Evaluate signal rules ──
function evalSignalRule(ruleId, d, shock) {
  const { bias4h, biasDay, sig, oiDiv, dipLabel } = d;
  switch (ruleId) {
    case 'vol_bull_4h':  return parseFloat(shock) > 1.5 && !!(bias4h && (bias4h.includes('BULL') || bias4h.includes('LEAN BULL')));
    case 'strong_buy':   return sig === 'STRONG BUY';
    case 'strong_sell':  return sig === 'STRONG SELL' || sig === 'BEARISH';
    case 'bearish_day':  return !!(bias4h && bias4h.includes('BEAR') && biasDay && biasDay.includes('BEAR'));
    case 'dip_buy':      return !!(dipLabel && dipLabel.includes('BUY DIP'));
    default: return false;
  }
}

// ── Build a checklist status string for the alert message ──
function buildChecklistMsg(sym, conditions, d, shock) {
  const name = sym.replace('BINANCE:','').replace('USDT','');
  return conditions.map(c => {
    const hit = evalOvnCond(c.id, d, shock);
    const icon = hit ? '✅' : (c.required ? '❌' : '⬜');
    return `${icon} ${c.label}: ${c.desc}`;
  }).join('\n');
}

// ── Cooldown helpers (fingerprint = rule + sym + direction) ──
// The fingerprint encodes WHAT fired, not just which rule+sym.
// This means: if ETHY.TO was BUY and flips to SELL, that is a NEW fingerprint
// → fires immediately regardless of cooldown.
// If ETHY.TO stays BUY → same fingerprint → cooldown suppresses repeat TG, but
//   the result still appears in the alert log every cycle.

function _fpKey(ruleId, sym, direction) {
  // direction: 'buy' | 'sell' | 'overnight_buy' | 'overnight_sell'
  return `a49_fp_${ruleId}_${sym}_${direction}`;
}

function _isCoolingDown(ruleId, sym, direction) {
  const key = _fpKey(ruleId, sym, direction);
  const ts  = parseInt(localStorage.getItem(key) || '0');
  if (!ts) return false;
  const cooldownMs = (STATE.alertCfg?.cooldownHours ?? 4) * 3600000;
  return (Date.now() - ts) < cooldownMs;
}

function _markFired(ruleId, sym, direction) {
  localStorage.setItem(_fpKey(ruleId, sym, direction), String(Date.now()));
}

function _clearFingerprint(ruleId, sym, direction) {
  localStorage.removeItem(_fpKey(ruleId, sym, direction));
}

function _cooldownRemaining(ruleId, sym, direction) {
  const key = _fpKey(ruleId, sym, direction);
  const ts  = parseInt(localStorage.getItem(key) || '0');
  if (!ts) return 0;
  const cooldownMs = (STATE.alertCfg?.cooldownHours ?? 4) * 3600000;
  const remaining  = cooldownMs - (Date.now() - ts);
  return remaining > 0 ? remaining : 0;
}

// ── Main checker called from signals.js ──
function checkAlertRules(sym, d, shock, bias4h) {
  const cfg = STATE.alertCfg;
  if (!cfg || !cfg.rules) return;
  const name = sym.replace('BINANCE:','').replace('USDT','');

  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;

    // ── Signal rules ──
    if (rule.group === 'signals') {
      const triggered = evalSignalRule(rule.id, d, shock);

      if (!triggered) {
        // Signal gone — clear fingerprint so it can re-fire when it returns
        _clearFingerprint(rule.id, sym, rule.action);
        continue;
      }

      // Signal is active — always log it so the alert log shows every cycle
      const actionEmoji = rule.action === 'buy' ? '🟢' : '🔴';
      const msg = `${actionEmoji} ${name} [${rule.action.toUpperCase()}] — ${rule.label}`;

      if (_isCoolingDown(rule.id, sym, rule.action)) {
        // Same direction still in cooldown — log with suppression notice, skip TG
        const remaining = _cooldownRemaining(rule.id, sym, rule.action);
        const hLeft = (remaining / 3600000).toFixed(1);
        logAlertItem('info', `🔕 ${name} [${rule.action.toUpperCase()}] — ${rule.id} · cooldown ${hLeft}h left · logged only`);
        continue;
      }

      // Not cooling down — send TG and mark fired
      _markFired(rule.id, sym, rule.action);
      dispatchAlert(rule, msg, sym);
      continue;
    }

    // ── Overnight rules ──
    const isOvnBuy = rule.id === 'overnight_buy';
    const isOvnSell = rule.id === 'overnight_sell';
    if (!isOvnBuy && !isOvnSell) continue;

    const conds      = isOvnBuy ? (cfg.ovnBuyConditions || OVN_BUY_CONDITIONS)
                                : (cfg.ovnSellConditions || OVN_SELL_CONDITIONS);
    const activeConds = conds.filter(c => c.enabled !== false);
    const allPass     = activeConds.every(c => evalOvnCond(c.id, d, shock));
    const hasMust     = activeConds.some(c => c.required);
    const direction   = isOvnBuy ? 'overnight_buy' : 'overnight_sell';

    if (!(hasMust && allPass)) {
      // Conditions no longer met — clear fingerprint so next qualifying run fires fresh
      _clearFingerprint(rule.id, sym, direction);
      continue;
    }

    // Conditions met — always log
    const icon    = isOvnBuy ? '🌙🟢' : '🌙🔴';
    const dirStr  = isOvnBuy ? 'BUY'  : 'SELL';
    const checklist = buildChecklistMsg(sym, conds, d, shock);
    const passCount = activeConds.length;
    const fullMsg   = `${icon} OVERNIGHT ${dirStr} — ${name}\n\n${checklist}\n\n✅ ${passCount}/${activeConds.length} active conditions passed`;

    if (cfg.digestMode) {
      bufferDigest(rule, sym, d);
      if (_isCoolingDown(rule.id, sym, direction)) {
        const remaining = _cooldownRemaining(rule.id, sym, direction);
        const hLeft = (remaining / 3600000).toFixed(1);
        logAlertItem('info', `🔕 ${name} [OVN ${dirStr}] — digest cooldown ${hLeft}h left · logged only`);
        continue;
      }
      _markFired(rule.id, sym, direction);
    } else {
      logAlertItem('info', fullMsg);
      if (_isCoolingDown(rule.id, sym, direction)) {
        const remaining = _cooldownRemaining(rule.id, sym, direction);
        const hLeft = (remaining / 3600000).toFixed(1);
        logAlertItem('info', `🔕 ${name} [OVN ${dirStr}] — cooldown ${hLeft}h left · logged only`);
        continue;
      }
      _markFired(rule.id, sym, direction);
      dispatchAlert(rule, fullMsg, sym);
    }
  }
}

// ── Save ──
// ── API Trading mode toggle (live in-tab, no page reload) ──
function setApiTradeMode(mode) {
  STATE._apiTradeMode = mode;
  if (!STATE.alertCfg.apiTrading) STATE.alertCfg.apiTrading = {};
  STATE.alertCfg.apiTrading.mode = mode;
  switchCfgTab('apitrading');
}

function setApiExecStrategy(strategy) {
  STATE._apiExecStrategy = strategy;
  if (!STATE.alertCfg.apiTrading) STATE.alertCfg.apiTrading = {};
  STATE.alertCfg.apiTrading.execStrategy = strategy;
  switchCfgTab('apitrading');
}

// ── Save API Trading settings + push trade-state.json to GitHub ──
async function saveApiTradingCfg() {
  const result = document.getElementById('api-trade-save-result');
  if (result) result.textContent = 'Saving…';

  // Collect values
  const mode     = STATE._apiTradeMode     || STATE.alertCfg.apiTrading?.mode         || 'off';
  const strategy = STATE._apiExecStrategy  || STATE.alertCfg.apiTrading?.execStrategy || 'top1';
  const usdSize  = parseFloat(document.getElementById('api-usd-size')?.value) || 25;
  const maxLive  = parseInt(document.getElementById('api-max-live')?.value) || 1;

  if (!STATE.alertCfg.apiTrading) STATE.alertCfg.apiTrading = {};
  STATE.alertCfg.apiTrading = { mode, execStrategy: strategy, usdSize, maxLive };

  // Persist to localStorage via the normal saveAlertCfg path
  const cfg = STATE.alertCfg;
  cfg._version = ALERT_CFG_VERSION;
  localStorage.setItem(`${_REPO_NS}_alertcfg`, JSON.stringify(cfg));

  // Also push a minimal trade-state.json update to GitHub so the headless
  // runner picks up the new mode within the next 15-min Job B cycle.
  // We GET the current file first to preserve `lastUpdateId` and other fields.
  try {
    const ghCfg       = typeof loadGhSyncCfg === 'function' ? loadGhSyncCfg() : {};
    const token       = ghCfg.token || window.__GH_PAT || '';
    const repo        = ghCfg.repo  || window.__GH_REPO || '';
    const branch      = ghCfg.branch || 'main';
    const fpath       = 'scripts/trade-state.json';
    const apiBase     = `https://api.github.com/repos/${repo}/contents/${fpath}`;
    const headers     = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (!token || !repo) throw new Error('GitHub token/repo not configured in Sync settings');

    // GET existing to read sha + merge fields
    let sha  = null;
    let prev = { tradingEnabled: true, lastUpdateId: 0, changedAt: 0 };
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha;
      try { prev = JSON.parse(atob((j.content || '').replace(/\n/g,''))); } catch {}
    }

    const newState = { ...prev, tradeMode: mode, execStrategy: strategy, usdSize, maxLive, modeChangedAt: Date.now() };
    const content  = btoa(unescape(encodeURIComponent(JSON.stringify(newState, null, 2))));
    const body     = { message: `chore: api trade mode → ${mode} [skip ci]`, content, branch };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json().catch(()=>({}));
      throw new Error(`GitHub PUT ${putRes.status}: ${e.message || ''}`);
    }

    if (result) result.textContent = `✓ Saved — mode set to ${mode.toUpperCase()}. Job B picks this up within 15 min.`;
    logAlertItem('info', `⚡ API trade mode → ${mode.toUpperCase()} (USDT: $${usdSize}, max live: ${maxLive})`);
  } catch (e) {
    if (result) result.style.color = 'var(--bear)';
    if (result) result.textContent = `✓ Saved locally — GitHub push failed: ${e.message}. TRADE_MODE var in repo still controls headless behavior.`;
    logAlertItem('warn', `⚡ API trade cfg local only — GitHub push failed: ${e.message}`);
  }

  renderAlertCfgPage();
}

function saveAlertCfg() {
  // Track leaderboard score changes in audit before saving
  try {
    const prevLb  = JSON.parse(localStorage.getItem(`${_REPO_NS}_lb_alert_cfg`) || '{}');
    const newScoreEl = document.getElementById('lb-min-score');
    if (newScoreEl && prevLb.minScore !== undefined) {
      const newScore = parseInt(newScoreEl.value);
      if (prevLb.minScore !== newScore) {
        logBrowserAudit('lb_score_changed', { from: prevLb.minScore, to: newScore });
      }
    }
  } catch {}
  const cfg = STATE.alertCfg;
  cfg.email.enabled           = document.getElementById('al-email-on').checked;
  cfg.email.address           = document.getElementById('al-email-addr').value.trim();
  cfg.email.emailjsPublicKey  = document.getElementById('al-ejs-pubkey').value.trim();
  cfg.email.emailjsServiceId  = document.getElementById('al-ejs-svc').value.trim();
  cfg.email.emailjsTemplateId = document.getElementById('al-ejs-tpl').value.trim();
  cfg.telegram.enabled        = document.getElementById('al-tg-on').checked;
  cfg.telegram.botToken       = document.getElementById('al-tg-token').value.trim();
  cfg.telegram.chatId         = document.getElementById('al-tg-chat').value.trim();
  cfg.cooldownHours           = parseFloat(document.getElementById('al-cooldown').value) || 1;
  cfg.digestMode              = document.getElementById('al-digest').checked;

  // API Trading settings — only present when the apitrading tab has been rendered
  const apiModeBtns = document.querySelectorAll('[onclick^="setApiTradeMode"]');
  if (apiModeBtns.length) {
    if (!cfg.apiTrading) cfg.apiTrading = {};
    cfg.apiTrading.mode         = STATE._apiTradeMode     || cfg.apiTrading.mode         || 'off';
    cfg.apiTrading.execStrategy = STATE._apiExecStrategy  || cfg.apiTrading.execStrategy || 'top1';
    cfg.apiTrading.usdSize      = parseFloat(document.getElementById('api-usd-size')?.value) || 25;
    cfg.apiTrading.maxLive      = parseInt(document.getElementById('api-max-live')?.value) || 1;
  }

  // Save per-condition enabled state + rule channels
  [
    { ruleId: 'overnight_buy',  condKey: 'ovnBuyConditions',  defs: OVN_BUY_CONDITIONS  },
    { ruleId: 'overnight_sell', condKey: 'ovnSellConditions', defs: OVN_SELL_CONDITIONS },
  ].forEach(({ ruleId, condKey, defs }) => {
    const rule = cfg.rules.find(r => r.id === ruleId);
    const emailCb = document.getElementById(`rule-ch-email-${ruleId}`);
    const tgCb    = document.getElementById(`rule-ch-tg-${ruleId}`);
    if (rule) {
      rule.channels = [];
      if (emailCb && emailCb.checked) rule.channels.push('email');
      if (tgCb    && tgCb.checked)    rule.channels.push('telegram');
    }
    // Save per-condition enabled checkboxes
    if (!cfg[condKey]) cfg[condKey] = defs.map(c => ({ ...c }));
    cfg[condKey].forEach(c => {
      const cb = document.getElementById(`cond-en-${c.id}`);
      if (cb) c.enabled = cb.checked;
    });
  });

  // Signal rule channels
  cfg.rules.filter(r => r.group === 'signals').forEach(rule => {
    const emailCb = document.getElementById(`rule-ch-email-${rule.id}`);
    const tgCb    = document.getElementById(`rule-ch-tg-${rule.id}`);
    rule.channels = [];
    if (emailCb && emailCb.checked) rule.channels.push('email');
    if (tgCb    && tgCb.checked)    rule.channels.push('telegram');
  });

  cfg._version = ALERT_CFG_VERSION;
  localStorage.setItem(`${_REPO_NS}_alertcfg`, JSON.stringify(cfg));
  logAlertItem('info', '💾 Alert config saved.');
  renderAlertCfgPage();
}

async function testEmail()    { logAlertItem('info','📤 Sending test email…');    await sendEmailAlert('🧪 Test — Alpha Terminal email channel OK!'); }
async function testTelegram() {
  // Read directly from the form fields so the test works even before Save All is clicked
  const token  = document.getElementById('al-tg-token')?.value.trim() || STATE.alertCfg?.telegram?.botToken || '';
  const chatId = document.getElementById('al-tg-chat')?.value.trim()  || STATE.alertCfg?.telegram?.chatId   || '';
  if (!token || !chatId) {
    const rd0 = document.getElementById('tg-test-result');
    if (rd0) rd0.innerHTML = '<span style="color:#ff9800">⚠ Enter Bot Token and Chat ID first</span>';
    logAlertItem('info', '⚠ Telegram test — enter Bot Token and Chat ID first, then test.');
    return;
  }
  logAlertItem('info', '📤 Sending test Telegram…');
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🔔 *Alpha Terminal*\n\n🧪 Test message — Telegram connected OK!\n\n_${new Date().toLocaleString()}_`,
        parse_mode: 'Markdown'
      })
    });
    const d = await r.json();
    if (d.ok) {
      const rd = document.getElementById('tg-test-result');
    if (rd) rd.innerHTML = '<span style="color:var(--bull)">✅ Sent! Check your Telegram.</span>';
    logAlertItem('info', '✅ Telegram test sent successfully! Check your chat.');
      // Auto-save token/chatId into STATE if test passes
      if (STATE.alertCfg) {
        STATE.alertCfg.telegram.botToken = token;
        STATE.alertCfg.telegram.chatId   = chatId;
        STATE.alertCfg.telegram.enabled  = true;
        localStorage.setItem(`${_REPO_NS}_alertcfg`, JSON.stringify(STATE.alertCfg));
        renderAlertCfgPage();
      }
    } else {
      const rd2 = document.getElementById('tg-test-result');
    if (rd2) rd2.innerHTML = `<span style="color:var(--bear)">❌ Failed: ${d.description || 'check token/chatId'}</span>`;
    logAlertItem('info', `❌ Telegram test FAILED: ${d.description || JSON.stringify(d)}`);
    }
  } catch(e) {
    const rd3 = document.getElementById('tg-test-result');
    if (rd3) rd3.innerHTML = `<span style="color:var(--bear)">❌ Error: ${e.message}</span>`;
    logAlertItem('info', `❌ Telegram test error: ${e.message}`);
  }
}

function toggleRule(id) {
  const rule = STATE.alertCfg.rules.find(r => r.id === id);
  if (rule) rule.enabled = !rule.enabled;
  localStorage.setItem(`${_REPO_NS}_alertcfg`, JSON.stringify(STATE.alertCfg));
  renderAlertCfgPage();
}

function bufferDigest(rule, sym, d) {
  if (!STATE.digestPending) STATE.digestPending = {};
  if (!STATE.digestPending[rule.id]) {
    STATE.digestPending[rule.id] = { rule, matches: [] };
  }
  const name    = sym.replace('BINANCE:','').replace('USDT','');
  const bias4h  = d.bias4h  || '-';
  const biasDay = d.biasDay || '-';
  const sig     = d.sig     || '-';
  STATE.digestPending[rule.id].matches.push({ sym, name, bias4h, biasDay, sig });
}

async function flushDigest() {
  if (!STATE.digestPending) return;
  const pending = STATE.digestPending;
  STATE.digestPending = {};

  for (const [ruleId, { rule, matches }] of Object.entries(pending)) {
    if (!matches.length) continue;
    const isBuy     = ruleId === 'overnight_buy';
    const icon      = isBuy ? '🌙🟢' : '🌙🔴';
    const dir       = isBuy ? 'BUY' : 'SELL';
    const direction = isBuy ? 'overnight_buy' : 'overnight_sell';

    // ── Always log every matched ticker (alert log shows everything) ──
    logAlertItem('info', `${icon} OVERNIGHT ${dir} — ${matches.length} ticker(s) matched`);

    if (!rule.channels.includes('telegram') && !rule.channels.includes('email')) continue;

    // ── Filter: watchlist-manager alert enable, then per-ticker cooldown ──
    const toSend = [];
    const suppressed = [];

    for (const m of matches) {
      // 1. Watchlist-manager gate
      if (typeof isAlertEnabled === 'function' && !isAlertEnabled(m.sym)) {
        suppressed.push({ m, reason: 'disabled' });
        continue;
      }
      // 2. Cooldown gate per ticker (fingerprint = rule+sym+direction)
      if (_isCoolingDown(ruleId, m.sym, direction)) {
        const rem  = _cooldownRemaining(ruleId, m.sym, direction);
        const hLeft = (rem / 3600000).toFixed(1);
        suppressed.push({ m, reason: `cooldown ${hLeft}h left` });
        logAlertItem('info', `  🔕 ${m.name} [OVN ${dir}] — cooldown ${hLeft}h left · logged only`);
        continue;
      }
      toSend.push(m);
    }

    if (suppressed.length && toSend.length === 0) {
      logAlertItem('info', `  ⏭ All ${suppressed.length} ticker(s) suppressed — no TG sent`);
    }

    // ── Send TG digest only for non-suppressed tickers ──
    if (toSend.length > 0 && rule.channels.includes('telegram')) {
      const header = `${icon} OVERNIGHT ${dir} — ${toSend.length} asset${toSend.length > 1 ? 's' : ''} matched`;
      const rows   = toSend.map(m =>
        '✅ *' + m.name + '*\n' +
        '  4H: ' + m.bias4h + '\n' +
        '  Daily: ' + m.biasDay + '\n' +
        '  Signal: ' + m.sig
      ).join('\n\n');
      const tgMsg = header + '\n\n' + rows + '\n\n_' + new Date().toLocaleString() + '_';
      await sendTelegramAlert(tgMsg);
      // Mark fired for each sent ticker
      toSend.forEach(m => _markFired(ruleId, m.sym, direction));
      if (suppressed.length) {
        logAlertItem('info', `  ℹ ${suppressed.length} ticker(s) suppressed from this digest`);
      }
    }

    // ── Email uses full match list (email doesn't have per-ticker cooldown) ──
    if (toSend.length > 0 && rule.channels.includes('email')) {
      const header = `${icon} OVERNIGHT ${dir} — ${toSend.length} asset${toSend.length > 1 ? 's' : ''} matched`;
      const rows   = toSend.map(m =>
        '✅ ' + m.name + '\n' +
        '  4H: ' + m.bias4h + '\n' +
        '  Daily: ' + m.biasDay + '\n' +
        '  Signal: ' + m.sig
      ).join('\n\n');
      await sendEmailAlert(header + '\n\n' + rows);
    }
  }
}

function switchCfgTab(tab) {
  STATE._cfgTab = tab;
  const ALL_TABS = ['telegram','rules','leaderboard','sync','positions','tracker','audit','apitrading'];
  ALL_TABS.forEach(t => {
    const panel = document.getElementById('cfg-panel-' + t);
    if (panel) {
      panel.style.display       = t === tab ? 'flex' : 'none';
      panel.style.flexDirection = 'column';
    }
  });
  // Update tab highlight without full re-render
  document.querySelectorAll('#cfg-tabs button').forEach((btn, i) => {
    const active = ALL_TABS[i] === tab;
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.color             = active ? 'var(--accent)' : 'var(--text-dim)';
    btn.style.fontWeight        = active ? '700' : '400';
  });
  // Load data panels on demand
  if (tab === 'positions'   && typeof refreshHeadlessPositions === 'function') refreshHeadlessPositions();
  if (tab === 'audit'       && typeof refreshAuditLog          === 'function') refreshAuditLog();
  if (tab === 'apitrading') renderAlertCfgPage(); // re-render so mode/strategy buttons reflect current STATE
}

// ── Browser-side Telegram alert pause/resume ──
// Persisted to localStorage so it survives a page refresh.
// Only gates browser-triggered sendTelegramAlert() calls —
// headless Job B alerts are completely unaffected.
(function _restoreBrowserAlertsPaused() {
  STATE.browserAlertsPaused = localStorage.getItem(`${_REPO_NS}_browser_alerts_paused`) === 'true';
})();

function toggleBrowserAlerts() {
  STATE.browserAlertsPaused = !STATE.browserAlertsPaused;
  localStorage.setItem(`${_REPO_NS}_browser_alerts_paused`, STATE.browserAlertsPaused);
  logAlertItem('info', STATE.browserAlertsPaused
    ? '⏸ Browser Telegram alerts PAUSED — headless Job B alerts still active'
    : '▶️ Browser Telegram alerts RESUMED');
  // Re-render the tracker panel so the button state updates immediately
  if (typeof renderPositionTracker === 'function') renderPositionTracker();
}

function resetSuppression() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('a49_fp_') || k.startsWith('alert_state_') || k.startsWith('alert_ts_'));
  keys.forEach(k => localStorage.removeItem(k));
  logAlertItem('info', `🔄 Suppression cleared for ${keys.length} alert(s) — next match will fire immediately.`);
}

// ══════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════
function renderAlertCfgPage() {
  if (!STATE.alertCfg) initAlertCfg();
  const cfg = STATE.alertCfg;
  const el  = document.getElementById('tab-alerts');
  if (!el) return;

  const tgOk    = cfg.telegram.enabled && cfg.telegram.botToken && cfg.telegram.chatId;
  const emailOk = cfg.email.enabled && cfg.email.emailjsPublicKey;

  const statusBadge = (ok, label) =>
    `<span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:4px;font-weight:700;
      background:${ok ? 'var(--bull-dim)' : 'rgba(100,100,100,.12)'};
      color:${ok ? 'var(--bull)' : '#555'};
      border:1px solid ${ok ? 'rgba(0,229,160,.3)' : '#2a2a2a'};">${ok ? '✓ ' : ''}${label}</span>`;

  // ── signal rule row ──
  function signalRuleRow(r) {
    const isBuy   = r.action === 'buy';
    const ac      = isBuy ? 'var(--bull)' : 'var(--bear)';
    const borderC = r.enabled ? ac : 'var(--border2)';
    return `
    <div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${borderC};
                border-radius:6px;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
      <div style="flex:1;min-width:180px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-family:var(--mono);font-size:8px;font-weight:700;padding:1px 7px;border-radius:3px;
          background:${isBuy ? 'var(--bull-dim)' : 'var(--bear-dim)'};color:${ac};
          border:1px solid ${isBuy ? 'rgba(0,229,160,.25)' : 'rgba(255,69,96,.25)'};letter-spacing:1px;white-space:nowrap;">
          ${isBuy ? '▲ BUY' : '▼ SELL'}
        </span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--text-bright);">${r.label}</span>
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-family:var(--mono);font-size:8px;color:var(--text-dim);">
          <input type="checkbox" id="rule-ch-email-${r.id}" ${r.channels.includes('email') ? 'checked' : ''} style="width:auto;margin:0;accent-color:var(--accent);"> ✉
        </label>
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-family:var(--mono);font-size:8px;color:var(--text-dim);">
          <input type="checkbox" id="rule-ch-tg-${r.id}" ${r.channels.includes('telegram') ? 'checked' : ''} style="width:auto;margin:0;accent-color:#29b6f6;"> ✈
        </label>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:8px;padding:2px 7px;border-radius:3px;font-weight:700;
          background:${r.enabled ? 'var(--bull-dim)' : 'rgba(100,100,100,.12)'};
          color:${r.enabled ? 'var(--bull)' : '#555'};
          border:1px solid ${r.enabled ? 'rgba(0,229,160,.3)' : '#2a2a2a'};">${r.enabled ? 'ACTIVE' : 'OFF'}</span>
        <button onclick="toggleRule('${r.id}')"
          style="background:none;border:1px solid ${r.enabled ? 'var(--bear)' : 'var(--bull)'};
                 color:${r.enabled ? 'var(--bear)' : 'var(--bull)'};
                 padding:3px 10px;border-radius:4px;cursor:pointer;font-size:8px;font-family:var(--mono);">
          ${r.enabled ? 'DISABLE' : 'ENABLE'}
        </button>
      </div>
    </div>`;
  }

  // ── overnight combined rule card ──
  function overnightCard(ruleId, direction) {
    const isBuy   = direction === 'buy';
    const rule    = cfg.rules.find(r => r.id === ruleId);
    const conds   = isBuy ? (cfg.ovnBuyConditions  || OVN_BUY_CONDITIONS)
                           : (cfg.ovnSellConditions || OVN_SELL_CONDITIONS);
    const ac      = isBuy ? 'var(--bull)' : 'var(--bear)';
    const acDim   = isBuy ? 'var(--bull-dim)' : 'var(--bear-dim)';
    const acBrd   = isBuy ? 'rgba(0,229,160,.25)' : 'rgba(255,69,96,.25)';
    const icon    = isBuy ? '🌙🟢' : '🌙🔴';
    const title   = isBuy ? 'OVERNIGHT BUY — Combined Alert' : 'OVERNIGHT SELL — Combined Alert';
    const info    = isBuy
      ? 'Fires ONE alert per asset when ALL ticked conditions pass. Untick any condition to exclude it from evaluation.'
      : 'Fires ONE alert per asset when ALL ticked conditions pass. Untick optional conditions to loosen the filter.';
    const borderC = rule && rule.enabled ? ac : 'var(--border2)';
    const activeCnt = conds.filter(c => c.enabled !== false).length;

    // ── Per-condition row with checkbox ──
    const condRows = conds.map(c => {
      const isEnabled = c.enabled !== false;
      const isMust    = c.required;
      return `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.04);
                  opacity:${isEnabled ? '1' : '0.45'};">
        <!-- Enabled checkbox -->
        <label title="${isMust ? 'Required — cannot be disabled' : 'Tick to include this condition in alert logic'}"
          style="display:flex;align-items:center;cursor:${isMust ? 'not-allowed' : 'pointer'};flex-shrink:0;margin-top:2px;">
          <input type="checkbox" id="cond-en-${c.id}"
            ${isEnabled ? 'checked' : ''}
            ${isMust ? 'disabled' : ''}
            style="width:14px;height:14px;margin:0;accent-color:${ac};cursor:${isMust ? 'not-allowed' : 'pointer'};">
        </label>
        <!-- MUST / OPT badge -->
        <span style="font-family:var(--mono);font-size:8px;padding:1px 7px;border-radius:3px;white-space:nowrap;flex-shrink:0;margin-top:2px;
          background:${isMust ? 'rgba(255,160,0,.12)' : 'rgba(100,100,100,.12)'};
          color:${isMust ? '#ffb300' : 'var(--text-dim)'};
          border:1px solid ${isMust ? 'rgba(255,160,0,.3)' : '#2a2a2a'};">
          ${isMust ? 'MUST' : 'OPT'}
        </span>
        <!-- Content -->
        <div style="flex:1;min-width:0;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text-bright);font-weight:700;">${c.label}</div>
          <div style="font-family:var(--mono);font-size:8px;color:${isEnabled ? ac : 'var(--text-dim)'};margin-top:1px;">${c.desc}</div>
          <div style="font-family:var(--mono);font-size:7.5px;color:var(--text-dim);margin-top:2px;line-height:1.5;">${c.tip}</div>
        </div>
      </div>`;
    }).join('');

    return `
    <div style="background:var(--bg2);border:1px solid var(--border);border-left:4px solid ${borderC};border-radius:8px;padding:14px 16px;margin-bottom:10px;">
      <!-- Header row -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;">${icon}</span>
          <span style="font-family:var(--mono);font-size:10px;font-weight:700;color:${ac};letter-spacing:1px;">${title}</span>
          <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">(${activeCnt} active)</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-family:var(--mono);font-size:8px;color:var(--text-dim);">
            <input type="checkbox" id="rule-ch-email-${ruleId}" ${rule && rule.channels.includes('email') ? 'checked' : ''} style="width:auto;margin:0;accent-color:var(--accent);"> ✉ Email
          </label>
          <label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-family:var(--mono);font-size:8px;color:var(--text-dim);">
            <input type="checkbox" id="rule-ch-tg-${ruleId}" ${rule && rule.channels.includes('telegram') ? 'checked' : ''} style="width:auto;margin:0;accent-color:#29b6f6;"> ✈ Telegram
          </label>
          <span style="font-family:var(--mono);font-size:8px;padding:2px 7px;border-radius:3px;font-weight:700;
            background:${rule && rule.enabled ? acDim : 'rgba(100,100,100,.12)'};
            color:${rule && rule.enabled ? ac : '#555'};
            border:1px solid ${rule && rule.enabled ? acBrd : '#2a2a2a'};">${rule && rule.enabled ? 'ACTIVE' : 'OFF'}</span>
          <button onclick="toggleRule('${ruleId}')"
            style="background:none;border:1px solid ${rule && rule.enabled ? 'var(--bear)' : ac};
                   color:${rule && rule.enabled ? 'var(--bear)' : ac};
                   padding:3px 10px;border-radius:4px;cursor:pointer;font-size:8px;font-family:var(--mono);">
            ${rule && rule.enabled ? 'DISABLE' : 'ENABLE'}
          </button>
        </div>
      </div>

      <!-- Info -->
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.6;">
        ${info}
      </div>

      <!-- Conditions: checkbox per row -->
      <div>${condRows}</div>

      <!-- Fire logic summary -->
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-top:12px;
                  display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">🔔 Alert fires when:</span>
        <span style="font-family:var(--mono);font-size:8px;color:#ffb300;font-weight:700;">ALL ticked conditions pass</span>
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">for the same asset · ${activeCnt} currently active</span>
      </div>
    </div>`;
  }
  el.innerHTML = `
  <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--card);
              display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px;flex-wrap:wrap;">
    <span class="pt">◆ ALERT CONFIGURATION</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${statusBadge(tgOk,'✈ TG')} ${statusBadge(emailOk,'✉ EMAIL')}
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-family:var(--mono);font-size:8px;color:var(--text-dim);">
        <input type="checkbox" id="al-digest" ${cfg.digestMode !== false ? 'checked' : ''} style="width:auto;margin:0;accent-color:var(--accent);"> 📋 Digest
      </label>
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">🔕 Cooldown:</span>
      <select id="al-cooldown"
        style="background:var(--bg2);border:1px solid var(--border2);color:var(--text-bright);
               padding:3px 8px;border-radius:4px;font-family:var(--mono);font-size:8px;outline:none;">
        ${[0.25,0.5,1,2,4,6,8,12,24].map(h =>
          `<option value="${h}" ${(cfg.cooldownHours??4)===h?'selected':''}>${h < 1 ? h*60+'m' : h+'h'}</option>`
        ).join('')}
      </select>
      <button onclick="saveAlertCfg()"
        style="background:var(--accent);border:none;color:#fff;
               padding:6px 16px;border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;">
        💾 SAVE ALL
      </button>
    </div>
  </div>

  <!-- ── Mobile tab bar ───────────────────────────────────────────────────── -->
  <div id="cfg-tabs" style="display:flex;border-bottom:1px solid var(--border);background:var(--bg);overflow-x:auto;flex-shrink:0;">
    ${['telegram','rules','leaderboard','sync','positions','tracker','audit','apitrading'].map((t,i) => {
      const labels = ['✈ Telegram','📡 Rules','🏆 Leaderboard','☁ Sync','🤖 Tracker Alerts','📍 Tracker','📋 Audit','⚡ API Trading'];
      const active = (STATE._cfgTab || 'telegram') === t;
      return `<button onclick="switchCfgTab('${t}')"
        style="flex:1;min-width:70px;padding:10px 6px;border:none;border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};
               background:transparent;color:${active ? 'var(--accent)' : 'var(--text-dim)'};
               font-family:var(--mono);font-size:9px;font-weight:${active ? '700' : '400'};
               cursor:pointer;white-space:nowrap;letter-spacing:.5px;transition:color .15s;">${labels[i]}</button>`;
    }).join('')}
  </div>

  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;flex:1;">

  <!-- ══ TAB: TELEGRAM ══ -->
  <div id="cfg-panel-telegram" style="display:${(STATE._cfgTab||'telegram')==='telegram'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #29b6f6;border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#29b6f6;letter-spacing:2px;margin-bottom:10px;">✈ TELEGRAM</div>
      <div class="info-box" style="font-size:8px;line-height:1.9;margin-bottom:14px;">
        <b>1.</b> Message <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent);">@BotFather</a> → /newbot → copy <b>Token</b><br>
        <b>2.</b> Start chat with your bot, then visit:<br>
        <code style="color:var(--accent);font-size:7.5px;word-break:break-all;">api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code><br>
        copy the <b>chat_id</b> from the response
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text);margin-bottom:14px;">
        <input type="checkbox" id="al-tg-on" ${cfg.telegram.enabled ? 'checked' : ''} style="width:16px;height:16px;margin:0;accent-color:#29b6f6;"> Enable Telegram Alerts
      </label>
      <label style="font-family:var(--mono);font-size:9px;color:var(--text-dim);display:block;margin-bottom:4px;">BOT TOKEN</label>
      <input type="password" id="al-tg-token" value="${cfg.telegram.botToken}" placeholder="123456789:ABCDef…"
        style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
               padding:10px 12px;border-radius:6px;font-size:13px;font-family:var(--mono);outline:none;margin-bottom:12px;box-sizing:border-box;">
      <label style="font-family:var(--mono);font-size:9px;color:var(--text-dim);display:block;margin-bottom:4px;">CHAT ID</label>
      <input type="text" id="al-tg-chat" value="${cfg.telegram.chatId}" placeholder="-100xxxxxxxxxx"
        style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
               padding:10px 12px;border-radius:6px;font-size:13px;font-family:var(--mono);outline:none;margin-bottom:16px;box-sizing:border-box;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button onclick="testTelegram()"
          style="flex:1;background:#29b6f6;border:none;color:#000;padding:12px;font-weight:700;
                 border-radius:6px;cursor:pointer;font-size:11px;font-family:var(--mono);">
          📤 Send Test Message
        </button>
        <button onclick="saveAlertCfg()"
          style="flex:1;background:var(--accent);border:none;color:#000;padding:12px;font-weight:700;
                 border-radius:6px;cursor:pointer;font-size:11px;font-family:var(--mono);">
          💾 Save
        </button>
      </div>
      <div id="tg-test-result" style="font-family:var(--mono);font-size:10px;margin-top:10px;min-height:18px;"></div>
    </div>

    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #ff9800;border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#ff9800;letter-spacing:2px;margin-bottom:10px;">✉ EMAIL (EmailJS)</div>
      <div class="info-box" style="font-size:8px;line-height:1.9;margin-bottom:14px;">
        <b>1.</b> <a href="https://www.emailjs.com" target="_blank" style="color:var(--accent);">emailjs.com</a> → Email Services → connect Gmail/Outlook → copy <b>Service ID</b><br>
        <b>2.</b> Templates → use vars <code style="color:var(--accent);">{{message}}</code> <code style="color:var(--accent);">{{time}}</code> → copy <b>Template ID</b><br>
        <b>3.</b> Account → API Keys → copy <b>Public Key</b>
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text);margin-bottom:14px;">
        <input type="checkbox" id="al-email-on" ${cfg.email.enabled ? 'checked' : ''} style="width:16px;height:16px;margin:0;accent-color:#ff9800;"> Enable Email Alerts
      </label>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px;">
        ${[['al-email-addr','RECIPIENT EMAIL','email',cfg.email.address,'you@example.com'],
           ['al-ejs-pubkey','PUBLIC KEY','password',cfg.email.emailjsPublicKey,'user_xxxxxxx'],
           ['al-ejs-svc','SERVICE ID','text',cfg.email.emailjsServiceId,'service_xxxxxxx'],
           ['al-ejs-tpl','TEMPLATE ID','text',cfg.email.emailjsTemplateId,'template_xxxxxxx']
          ].map(([id,lbl,type,val,ph]) => `
          <div>
            <label style="font-family:var(--mono);font-size:9px;color:var(--text-dim);display:block;margin-bottom:4px;">${lbl}</label>
            <input type="${type}" id="${id}" value="${val}" placeholder="${ph}"
              style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                     padding:10px 12px;border-radius:6px;font-size:13px;font-family:var(--mono);outline:none;box-sizing:border-box;">
          </div>`).join('')}
      </div>
      <button onclick="testEmail()"
        style="width:100%;background:none;border:1px solid #ff9800;color:#ff9800;padding:12px;
               border-radius:6px;cursor:pointer;font-size:11px;font-family:var(--mono);font-weight:700;">
        📤 Send Test Email
      </button>
    </div>
  </div>

  <!-- ══ TAB: SIGNAL RULES ══ -->
  <div id="cfg-panel-rules" style="display:${(STATE._cfgTab||'telegram')==='rules'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:2px;margin-bottom:12px;">📡 SIGNAL RULES</div>
      ${cfg.rules.filter(r => r.group === 'signals').map(signalRuleRow).join('')}
    </div>
  </div>

  <!-- ══ TAB: LEADERBOARD ══ -->
  <div id="cfg-panel-leaderboard" style="display:${(STATE._cfgTab||'telegram')==='leaderboard'?'flex':'none'};flex-direction:column;gap:12px;">
    ${typeof renderLbAlertCard === 'function' ? renderLbAlertCard() : ''}
  </div>

  <!-- ══ TAB: GITHUB SYNC ══ -->
  <div id="cfg-panel-sync" style="display:${(STATE._cfgTab||'telegram')==='sync'?'flex':'none'};flex-direction:column;gap:12px;">
    ${typeof renderGithubSyncCard === 'function' ? renderGithubSyncCard() : ''}
  </div>

  <!-- ══ TAB: HEADLESS POSITIONS (positions.json — machine written) ══ -->
  <div id="cfg-panel-positions" style="display:${(STATE._cfgTab||'telegram')==='positions'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid var(--accent);border-radius:8px;padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:2px;">🤖 TRACKER ALERTS</div>
        <button onclick="refreshHeadlessPositions()"
          style="background:none;border:1px solid var(--border2);color:var(--text-dim);
                 padding:4px 12px;border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:8px;">
          ↻ Refresh
        </button>
      </div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
        Shows <code style="color:var(--accent);">scripts/positions.json</code> from your GitHub repo.<br>
        Written by GitHub Actions every 15 min + by Option A sync when you save positions.<br>
        <span style="color:var(--text-dim);">Repo: <code style="color:var(--accent);">${_deriveRepo() || 'not detected — set in Sync tab'}</code></span>
      </div>
      <div id="headless-positions-panel">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">Loading from repo…</div>
      </div>
    </div>
  </div>

  <!-- ══ TAB: TRACKER (tracker.json — GUI written) ══ -->
  <div id="cfg-panel-tracker" style="display:${(STATE._cfgTab||'telegram')==='tracker'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #ffd700;border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#ffd700;letter-spacing:2px;margin-bottom:8px;">
        📍 TRACKER
      </div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:14px;line-height:1.7;">
        Local browser cache — positions stored in this browser's localStorage.<br>
        Use <b>Option A sync</b> (☁ Sync tab) to push these to <code>positions.json</code> so<br>
        the headless runner can monitor them for stop/T1/T2/exit alerts.<br>
        <span style="color:#ffd700;">Live P&amp;L updates while this tab is open.</span>
      </div>
      <div id="position-tracker-panel"></div>
    </div>

    <!-- Overnight Buy -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--bull);letter-spacing:2px;margin-bottom:4px;">🌙 ▲ OVERNIGHT BUY</div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;">All conditions evaluated together → fires <b style="color:var(--bull)">1 combined alert</b> with a full checklist summary</div>
      ${overnightCard('overnight_buy','buy')}
    </div>

    <!-- Overnight Sell -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--bear);letter-spacing:2px;margin-bottom:4px;">🌙 ▼ OVERNIGHT SELL</div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;">All conditions evaluated together → fires <b style="color:var(--bear)">1 combined alert</b> with a full checklist summary</div>
      ${overnightCard('overnight_sell','sell')}
    </div>

    <!-- Save footer -->
    <div style="display:flex;gap:12px;align-items:center;padding-bottom:12px;">
      <button onclick="saveAlertCfg()"
        style="background:var(--accent);border:none;color:#fff;padding:9px 24px;
               border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;">
        💾 SAVE ALL CONFIG
      </button>
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Saved to localStorage · persists across sessions</span>
      <button onclick="resetSuppression()"
        style="background:none;border:1px solid var(--border2);color:var(--text-dim);
               padding:6px 14px;border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:8px;">
        🔄 Reset Suppression
      </button>
    </div>

    <!-- Session alert log -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--text-bright);letter-spacing:2px;margin-bottom:10px;">◆ ALERT LOG</div>
      <div id="alert-cfg-log" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;max-height:180px;overflow-y:auto;">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px;">No alerts yet this session.</div>
      </div>
    </div>
  </div>

  <!-- ══ TAB: AUDIT LOG (audit.json — runner written, 1h rolling) ══ -->
  <div id="cfg-panel-audit" style="display:${(STATE._cfgTab||'telegram')==='audit'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #29b6f6;border-radius:8px;padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#29b6f6;letter-spacing:2px;">📋 RUNNER AUDIT LOG</div>
        <button onclick="refreshAuditLog()"
          style="background:none;border:1px solid var(--border2);color:var(--text-dim);
                 padding:4px 12px;border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:8px;">
          ↻ Refresh
        </button>
      </div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
        Live view of <code>scripts/audit.json</code> — rolling 1-hour window of runner activity.<br>
        Updated every 5 min (Job A fetch) and every 15 min (Job B decide).<br>
        <span style="color:#29b6f6;">Most recent entries shown first.</span>
      </div>
      <div id="audit-log-panel">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">Loading from repo…</div>
      </div>
    </div>
  </div>

  <!-- ══ TAB: API TRADING ══ -->
  ${(() => {
    const at    = cfg.apiTrading || {};
    const mode  = at.mode || 'off';
    const strategy = at.execStrategy || 'top1';
    const isOff  = mode === 'off';
    const isPaper= mode === 'paper';
    const isLive = mode === 'live';
    const modeColor = isLive ? '#3dff78' : isPaper ? '#f0c040' : 'var(--text-dim)';
    const modeDesc  = isLive
      ? '⚡ LIVE — real MEXC orders will be placed when the ⭐ top-ranked alert fires.'
      : isPaper
      ? '📝 PAPER — trades are simulated and logged. No real orders are sent.'
      : '⏹ OFF — auto-trading is disabled. Signals still send Telegram alerts.';
    return `
  <div id="cfg-panel-apitrading" style="display:${(STATE._cfgTab||'telegram')==='apitrading'?'flex':'none'};flex-direction:column;gap:12px;">
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid ${modeColor};border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:${modeColor};letter-spacing:2px;margin-bottom:4px;">⚡ MEXC API TRADING</div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:14px;line-height:1.7;">
        Auto-trades the <b style="color:var(--text-bright)">⭐ top-ranked buy signal(s)</b> each cycle via MEXC Spot API.<br>
        Mode is written to <code>scripts/trade-state.json</code> in your repo and picked up by the headless Job B runner.<br>
        You can also send <code>/pause</code> or <code>/resume</code> in Telegram at any time.
      </div>

      <!-- Mode toggle row -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
        <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);letter-spacing:1px;min-width:44px;">MODE</span>
        ${['off','paper','live'].map(m => {
          const active = mode === m;
          const col = m === 'live' ? '#3dff78' : m === 'paper' ? '#f0c040' : 'var(--text-dim)';
          return `<button onclick="setApiTradeMode('${m}')"
            style="padding:6px 18px;border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1px;transition:.15s;
                   background:${active ? `rgba(${m==='live'?'61,255,120':m==='paper'?'240,192,64':'120,120,120'},.12)` : 'transparent'};
                   color:${active ? col : 'var(--text-dim)'};
                   border:1px solid ${active ? col : 'var(--border2)'};">
            ${m.toUpperCase()}
          </button>`;
        }).join('')}
      </div>

      <!-- Current mode description -->
      <div id="api-mode-desc" style="font-family:var(--mono);font-size:9px;color:${modeColor};
           background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;
           padding:10px 14px;margin-bottom:16px;line-height:1.6;">
        ${modeDesc}
      </div>

      <!-- Execution strategy -->
      <div style="margin-bottom:16px;">
        <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);letter-spacing:1px;margin-bottom:8px;">EXECUTION STRATEGY (when 3+ signals fire)</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${[['top1','⭐ Top #1 only','Buy only the highest-ranked pick, full order size'],
             ['topN','⭐⭐⭐ Top N split','Buy all starred picks, USDT split equally between them']].map(([val, label, desc]) => {
            const active = strategy === val;
            return `<div onclick="setApiExecStrategy('${val}')"
              style="flex:1;min-width:160px;padding:10px 14px;border-radius:6px;cursor:pointer;transition:.15s;
                     background:${active ? 'rgba(61,155,255,0.08)' : 'var(--bg)'};
                     border:1px solid ${active ? 'rgba(61,155,255,0.4)' : 'var(--border2)'};">
              <div style="font-family:var(--mono);font-size:9px;font-weight:700;color:${active ? 'var(--accent)' : 'var(--text-bright)'};margin-bottom:3px;">${label}</div>
              <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);line-height:1.5;">${desc}</div>
            </div>`;
          }).join('')}
        </div>
        <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-top:8px;line-height:1.7;" id="api-strategy-note">
          ${strategy === 'topN'
            ? '💡 Split example: $75 total ÷ 3 starred picks = <b style="color:var(--text-bright)">$25 each</b>. If only 1 signal fires, it gets the full amount.'
            : '💡 If fewer than 3 signals fire, top #1 always gets the full order size.'}
        </div>
      </div>

      <!-- Position size -->
      <div style="margin-bottom:12px;">
        <label style="font-family:var(--mono);font-size:8px;color:var(--text-dim);letter-spacing:1px;display:block;margin-bottom:4px;">
          ${strategy === 'topN' ? 'TOTAL ORDER SIZE (split equally across picks)' : 'ORDER SIZE (USDT per buy)'}
        </label>
        <input type="number" id="api-usd-size" value="${at.usdSize || 25}" min="1" step="1"
          style="width:140px;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:8px 12px;border-radius:5px;font-family:var(--mono);font-size:12px;outline:none;">
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-left:8px;">USDT</span>
      </div>

      <!-- Max concurrent live trades -->
      <div style="margin-bottom:16px;">
        <label style="font-family:var(--mono);font-size:8px;color:var(--text-dim);letter-spacing:1px;display:block;margin-bottom:4px;">MAX CONCURRENT LIVE TRADES</label>
        <select id="api-max-live"
          style="background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:5px;font-family:var(--mono);font-size:10px;outline:none;">
          ${[1,2,3,5].map(n => `<option value="${n}" ${(at.maxLive||1)===n?'selected':''}>${n}</option>`).join('')}
        </select>
      </div>

      <!-- LIVE-only warning -->
      <div style="display:${isLive?'block':'none'};background:rgba(255,69,96,.08);border:1px solid rgba(255,69,96,.3);
                  border-radius:6px;padding:10px 14px;margin-bottom:16px;font-family:var(--mono);font-size:8px;
                  color:var(--bear);line-height:1.7;" id="api-live-warn">
        ⚠ <b>LIVE MODE</b> — real money at risk.<br>
        Add <code>MEXC_API_KEY</code> and <code>MEXC_API_SECRET</code> as GitHub repository secrets.<br>
        Set IP whitelist on the MEXC key to your GitHub Actions IP range (or leave open, rotate quarterly).<br>
        Start with a small order size until you've verified the first few fills.
      </div>

      <!-- How mode is applied note -->
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);line-height:1.7;margin-bottom:14px;">
        💾 Saving pushes a <code>trade-state.json</code> update to GitHub — picked up by the next Job B cycle (≤15 min).<br>
        The Telegram kill-switch (<code>/pause</code> / <code>/resume</code>) overrides this setting without a save.
      </div>

      <button onclick="saveApiTradingCfg()"
        style="background:var(--accent);border:none;color:#000;padding:10px 24px;border-radius:5px;
               cursor:pointer;font-family:var(--mono);font-size:10px;font-weight:700;width:100%;">
        💾 SAVE API TRADING SETTINGS
      </button>
      <div id="api-trade-save-result" style="font-family:var(--mono);font-size:9px;margin-top:10px;min-height:16px;color:var(--bull);"></div>
    </div>
  </div>`;
  })()}

  </div>`;

  renderAlertLog();
  if (typeof renderPositionTracker === 'function') setTimeout(renderPositionTracker, 0);

  // Auto-load data panels when their tab is active
  const _activeTab = STATE._cfgTab || 'telegram';
  if (_activeTab === 'positions') refreshHeadlessPositions();
  if (_activeTab === 'audit')     refreshAuditLog();
}

// ── Derive repo slug (window.__GH_REPO or GitHub Pages URL) ─────────────────
function _deriveRepo() {
  // Priority: 1) window.__GH_REPO (env.js) 2) github-sync cfg 3) Pages URL auto-detect
  if (window.__GH_REPO) return window.__GH_REPO;
  // Check github-sync saved config (Option A or B)
  try {
    const ghCfg = JSON.parse(localStorage.getItem(`${_REPO_NS}_gh_sync_cfg`) || '{}');
    if (ghCfg.repo) return ghCfg.repo;
  } catch {}
  // Auto-derive from GitHub Pages URL
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m) {
    const owner = m[1];
    const repo  = location.pathname.split('/').filter(Boolean)[0] || '';
    if (repo) return `${owner}/${repo}`;
  }
  return '';
}

// ── Browser-side audit logging ────────────────────────────────────────────────
// Writes browser events to scripts/audit.json via GitHub API (Option A only).
// Events: sync ok/fail, leaderboard score changes, manual position changes.
async function logBrowserAudit(action, details = {}) {
  try {
    const repo  = _deriveRepo();
    const ghCfg = JSON.parse(localStorage.getItem(`${_REPO_NS}_gh_sync_cfg`) || '{}');
    const token = ghCfg.token || window.__GH_PAT || '';
    if (!repo || !token) return; // needs Option A PAT to write

    const branch = ghCfg.branch || 'main';
    const apiUrl = `https://api.github.com/repos/${repo}/contents/scripts/audit.json`;
    const hdrs   = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const entry  = { timestamp: new Date().toISOString(), job: 'browser', action, ...details };

    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers: hdrs });
    let existing = [], sha = null;
    if (getRes.ok) {
      const j = await getRes.json(); sha = j.sha;
      try { existing = JSON.parse(atob(j.content.replace(/\n/g, ''))); } catch {}
    }
    if (!Array.isArray(existing)) existing = [];
    existing.push(entry);
    const cutoff = Date.now() - 3600000;
    existing = existing.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
    const putBody = { message: 'chore: browser audit [skip ci]', content, branch };
    if (sha) putBody.sha = sha;
    await fetch(apiUrl, { method: 'PUT', headers: hdrs, body: JSON.stringify(putBody) });
  } catch {} // silently fail — audit is best-effort
}

// ── Headless positions panel (positions.json — machine written) ──────────────
async function refreshHeadlessPositions() {
  const el = document.getElementById('headless-positions-panel');
  if (!el) return;
  el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">Fetching…</div>`;

  try {
    const repo = _deriveRepo();
    if (!repo) throw new Error('Cannot derive repo — set GH_REPO or deploy via GitHub Pages');
    // Get branch from github-sync cfg or default to main
    let _branch = 'main';
    try { const c = JSON.parse(localStorage.getItem(`${_REPO_NS}_gh_sync_cfg`) || '{}'); _branch = c.branch || 'main'; } catch {}
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${_branch}/scripts/positions.json?t=${Date.now()}`;
    const res    = await fetch(rawUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const positions = await res.json();
    const entries   = Object.values(positions || {});

    if (!entries.length) {
      el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">
        No headless positions open — runner creates entries here when a buy signal fires.</div>`;
      return;
    }

    const statusColor = s => ({ watching:'var(--bull)', tp1_hit:'#ffd700', tp2_hit:'#ffd700', exiting:'#ffa500', stopped:'var(--bear)' }[s] || 'var(--text-dim)');
    const statusLabel = s => ({ watching:'👁 WATCHING', tp1_hit:'✅ T1 HIT', tp2_hit:'🏆 T2 HIT', exiting:'🟡 EXITING', stopped:'🔴 STOPPED' }[s] || s);

    el.innerHTML = entries.map(pos => {
      const age      = Math.floor((Date.now() - (pos.alertedAt || 0)) / 60000);
      const ageStr   = age < 60 ? `${age}m ago` : `${Math.floor(age/60)}h ${age%60}m ago`;
      const liveD    = (STATE._ranked || []).find(r => r.sym === pos.sym)?.d || {};
      const price    = parseFloat(liveD.p || pos.entryPrice || 0);
      const pnlPct   = pos.entryPrice > 0 ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : '—';
      const pnlColor = parseFloat(pnlPct) >= 0 ? 'var(--bull)' : 'var(--bear)';
      const baseName = pos.base || (pos.sym || '').replace('BINANCE:','').replace('USDT','');

      return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${statusColor(pos.status)};
                  border-radius:6px;padding:10px 12px;margin-bottom:8px;font-family:var(--mono);font-size:9px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:4px;">
          <span style="color:var(--text-bright);font-weight:700;font-size:10px;">${baseName}</span>
          <span style="color:${statusColor(pos.status)};font-size:8px;letter-spacing:1px;">${statusLabel(pos.status)}</span>
          <span style="color:var(--text-dim);font-size:7px;">🤖 headless · ${ageStr}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px;">
          <div><div style="color:var(--text-dim);font-size:7px;">SETUP</div><div style="color:var(--accent);">${pos.setup || '—'}</div></div>
          <div><div style="color:var(--text-dim);font-size:7px;">ENTRY</div><div>$${pos.entryPrice || '—'}</div></div>
          <div><div style="color:var(--text-dim);font-size:7px;">STOP</div><div style="color:var(--bear);">$${pos.stop || '—'}</div></div>
          <div><div style="color:var(--text-dim);font-size:7px;">T1</div><div style="color:var(--bull);">$${pos.t1 || '—'}</div></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <span>Score: <b style="color:var(--accent);">${pos.score || '—'}</b></span>
          ${price ? `<span>Live: <b>$${price}</b></span>
          <span style="color:${pnlColor};font-weight:700;">${parseFloat(pnlPct)>=0?'+':''}${pnlPct}%</span>` : ''}
          <span style="color:var(--text-dim);font-size:7px;">${pos.scoreSource === 'peak' ? '⚡ peak catch' : 'latest'}</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--bear);padding:10px 0;">
      ⚠ Failed to load positions.json: ${e.message}</div>`;
  }
}

// ── Audit log panel (audit.json — runner written, 1h rolling) ───────────────
async function refreshAuditLog() {
  const el = document.getElementById('audit-log-panel');
  if (!el) return;
  el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">Fetching…</div>`;

  try {
    const repo = _deriveRepo();
    if (!repo) throw new Error('Cannot derive repo — set GH_REPO or deploy via GitHub Pages');
    const rawUrl = `https://raw.githubusercontent.com/${repo}/main/scripts/audit.json?t=${Date.now()}`;
    const res    = await fetch(rawUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();

    if (!Array.isArray(entries) || !entries.length) {
      el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px 0;">
        No audit entries yet — entries appear after the first fetch/decide run.</div>`;
      return;
    }

    const sorted = [...entries].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const actionColor = a => ({
      // market-fetcher (Job A)
      fetch_complete:           'var(--bull)',
      no_symbols:               '#ffa500',
      // leaderboard-decider (Job B)
      position_opened:          'var(--accent)',
      positions_pushed:         'var(--bull)',
      positions_push_failed:    'var(--bear)',
      buy_cycle_complete:       'var(--text)',
      market_data_empty:        '#ffa500',
      // alert-runner (positions monitor)
      positions_check:          'var(--text-dim)',
      stop_hit:                 'var(--bear)',
      t1_hit:                   'var(--bull)',
      t2_hit:                   '#ffd700',
      tier1_watch:              '#ffa500',
      exit_signal:              '#ffa500',
      stale_position:           '#ffa500',
      positions_sweep_start:    'var(--text-dim)',
      positions_sweep_pushed:   'var(--bull)',
      positions_sweep_failed:   'var(--bear)',
      positions_sweep_skipped:  'var(--text-dim)',
      // shared
      job_start:                'var(--text-dim)',
      job_complete:             'var(--text-dim)',
      fatal_error:              'var(--bear)',
      browser_sync_ok:          'var(--bull)',
      browser_sync_failed:      'var(--bear)',
      lb_score_changed:         '#8957e5',
      position_closed_manual:   'var(--text-dim)',
    }[a] || 'var(--text-dim)');

    const actionIcon = a => ({
      // market-fetcher
      fetch_complete:           '📡',
      no_symbols:               '⚠',
      // leaderboard-decider
      position_opened:          '🟢',
      positions_pushed:         '☁',
      positions_push_failed:    '🔴',
      buy_cycle_complete:       '✅',
      market_data_empty:        '⚠',
      // alert-runner
      positions_check:          '📍',
      stop_hit:                 '🔴',
      t1_hit:                   '✅',
      t2_hit:                   '🏆',
      tier1_watch:              '⚠',
      exit_signal:              '🟡',
      stale_position:           '⏰',
      positions_sweep_start:    '🗑',
      positions_sweep_pushed:   '🗑',
      positions_sweep_failed:   '⚠',
      positions_sweep_skipped:  '⏭',
      // shared
      job_start:                '▶',
      job_complete:             '■',
      fatal_error:              '🔴',
      browser_sync_ok:          '☁',
      browser_sync_failed:      '🔴',
      lb_score_changed:         '⚙',
      position_closed_manual:   '✕',
    }[a] || '·');

    el.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;
                max-height:480px;overflow-y:auto;font-family:var(--mono);">
      ${sorted.map(e => {
        const ts      = new Date(e.timestamp);
        const timeStr = ts.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        const dateStr = ts.toLocaleDateString([], { month:'short', day:'numeric' });
        const col     = actionColor(e.action);
        const icon    = actionIcon(e.action);

        const details = [];
        // job_start — show config snapshot
        if (e.action === 'job_start') {
          if (e.minScore    !== undefined) details.push(`minScore:${e.minScore}`);
          if (e.ghRepo)                    details.push(`repo:${e.ghRepo}`);
          if (e.ghToken)                   details.push(`token:${e.ghToken}`);
          if (e.tgToken)                   details.push(`tg:${e.tgToken}`);
          if (e.dryRun)                    details.push('DRY-RUN');
        }
        // general fields
        if (e.successCount  !== undefined) details.push(`${e.successCount}/${e.totalPairs} ok`);
        if (e.pair)                        details.push(e.pair);
        if (e.setup)                       details.push(e.setup);
        if (e.from !== undefined && e.to !== undefined) details.push(`${e.from} → ${e.to}`);
        if (e.count    !== undefined)      details.push(`${e.count} positions`);
        if (e.error)                       details.push(e.error);
        if (e.score)                       details.push(`score:${e.score}`);
        if (e.count         !== undefined) details.push(`${e.count} pos`);
        if (e.signalsFound  !== undefined) details.push(`${e.signalsFound} signals`);
        if (e.positionsOpened > 0)         details.push(`${e.positionsOpened} opened`);
        if (e.total         !== undefined) details.push(`${e.total} total`);
        if (e.monitored     !== undefined) details.push(`${e.monitored} active`);
        if (e.swept         !== undefined) details.push(`${e.swept} swept`);
        if (e.remaining     !== undefined) details.push(`${e.remaining} remain`);
        if (e.pnlPct)                      details.push(`P&L ${e.pnlPct}%`);
        if (e.price)                       details.push(`$${e.price}`);
        if (e.exitScore)                   details.push(`exit ${e.exitScore}/6`);
        if (e.signals)                     details.push(e.signals);
        if (e.ageHours)                    details.push(`${e.ageHours}h old`);
        if (e.reason)                      details.push(e.reason);
        if (e.error)                       details.push(`⚠ ${e.error}`);

        const jobLabel = e.job === 'market-fetcher' ? 'Job A'
                       : e.job === 'leaderboard-decider' ? 'Job B'
                       : e.job === 'alert-runner' ? 'Monitor'
                       : e.job || '?';

        return `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 10px;
                    border-bottom:1px solid rgba(255,255,255,.04);font-size:8px;">
          <span style="color:${col};flex-shrink:0;font-size:10px;">${icon}</span>
          <span style="color:var(--text-dim);flex-shrink:0;min-width:110px;">${dateStr} ${timeStr}</span>
          <span style="color:var(--text-dim);flex-shrink:0;min-width:55px;font-size:7px;padding-top:1px;">${jobLabel}</span>
          <span style="color:${col};font-weight:700;flex-shrink:0;min-width:130px;">${e.action}</span>
          <span style="color:var(--text-dim);">${details.join(' · ')}</span>
        </div>`;
      }).join('')}
    </div>
    <div style="font-family:var(--mono);font-size:7px;color:var(--text-dim);margin-top:8px;text-align:right;">
      ${sorted.length} entries · rolling 1h window · last: ${new Date(sorted[0]?.timestamp).toLocaleTimeString()}
    </div>`;
  } catch (e) {
    el.innerHTML = `<div style="font-family:var(--mono);font-size:9px;color:var(--bear);padding:10px 0;">
      ⚠ Failed to load audit.json: ${e.message}</div>`;
  }
}

function renderAlertLog() {
  const el = document.getElementById('alert-cfg-log');
  if (!el || !STATE.alertLog.length) return;
  const colorMap = {
    buy:        'var(--bull)',
    sell:       'var(--bear)',
    sent:       '#4caf50',
    suppressed: '#444',
    info:       'var(--text-dim)',
  };
  el.innerHTML = STATE.alertLog.map(a => {
    const color = colorMap[a.type] || 'var(--text-dim)';
    const bg    = a.type === 'suppressed' ? 'rgba(20,20,20,.3)' :
                  a.type === 'buy'        ? 'rgba(0,200,100,.04)' :
                  a.type === 'sell'       ? 'rgba(255,60,60,.04)' : 'transparent';
    return `<div style="display:flex;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(30,37,48,.5);font-family:var(--mono);font-size:8px;background:${bg};">
      <span style="color:var(--text-dim);white-space:nowrap;flex-shrink:0;">${a.time}</span>
      <span style="color:${color};white-space:pre-wrap;">${a.msg}</span>
    </div>`;
  }).join('');
}
