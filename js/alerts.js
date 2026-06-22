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
function saveAlertCfg() {
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
      logAlertItem('info', `❌ Telegram test FAILED: ${d.description || JSON.stringify(d)}`);
    }
  } catch(e) {
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

  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;flex:1;">

    <!-- ① ACCOUNTS -->
    <div style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--text-dim);letter-spacing:2px;">① ACCOUNT SETUP</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">

      <!-- TELEGRAM -->
      <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #29b6f6;border-radius:8px;padding:16px;">
        <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#29b6f6;letter-spacing:2px;margin-bottom:10px;">✈ TELEGRAM</div>
        <div class="info-box" style="font-size:7.5px;line-height:1.8;margin-bottom:12px;">
          <b>1.</b> Message <a href="https://t.me/BotFather" target="_blank">@BotFather</a> → /newbot → copy <b>Token</b><br>
          <b>2.</b> Start chat with your bot, then visit:<br>
          <code style="color:var(--accent);word-break:break-all;font-size:7px;">api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code><br>
          and copy the <b>chat_id</b> from the response
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:9px;color:var(--text);margin-bottom:10px;">
          <input type="checkbox" id="al-tg-on" ${cfg.telegram.enabled ? 'checked' : ''} style="width:auto;margin:0;accent-color:#29b6f6;"> Enable Telegram Alerts
        </label>
        <label style="font-family:var(--mono);font-size:8px;color:var(--text-dim);display:block;margin-bottom:3px;">BOT TOKEN</label>
        <input type="password" id="al-tg-token" value="${cfg.telegram.botToken}" placeholder="123456789:ABCDef…"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:10px;font-family:var(--mono);outline:none;margin-bottom:10px;box-sizing:border-box;">
        <label style="font-family:var(--mono);font-size:8px;color:var(--text-dim);display:block;margin-bottom:3px;">CHAT ID</label>
        <input type="text" id="al-tg-chat" value="${cfg.telegram.chatId}" placeholder="-100xxxxxxxxxx"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:10px;font-family:var(--mono);outline:none;margin-bottom:12px;box-sizing:border-box;">
        <button onclick="testTelegram()"
          style="background:none;border:1px solid #29b6f6;color:#29b6f6;padding:6px 14px;
                 border-radius:4px;cursor:pointer;font-size:9px;font-family:var(--mono);">
          📤 Send Test Message
        </button>
      </div>

      <!-- EMAIL -->
      <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #ff9800;border-radius:8px;padding:16px;">
        <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#ff9800;letter-spacing:2px;margin-bottom:10px;">✉ EMAIL (EmailJS)</div>
        <div class="info-box" style="font-size:7.5px;line-height:1.8;margin-bottom:12px;">
          <b>1.</b> <a href="https://www.emailjs.com" target="_blank">emailjs.com</a> → Email Services → connect Gmail/Outlook → copy <b>Service ID</b><br>
          <b>2.</b> Email Templates → use vars <code style="color:var(--accent);">{{message}}</code> <code style="color:var(--accent);">{{time}}</code> → copy <b>Template ID</b><br>
          <b>3.</b> Account → API Keys → copy <b>Public Key</b>
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:9px;color:var(--text);margin-bottom:10px;">
          <input type="checkbox" id="al-email-on" ${cfg.email.enabled ? 'checked' : ''} style="width:auto;margin:0;accent-color:#ff9800;"> Enable Email Alerts
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${[['al-email-addr','RECIPIENT EMAIL','email',cfg.email.address,'you@example.com'],
             ['al-ejs-pubkey','PUBLIC KEY','password',cfg.email.emailjsPublicKey,'user_xxxxxxx'],
             ['al-ejs-svc','SERVICE ID','text',cfg.email.emailjsServiceId,'service_xxxxxxx'],
             ['al-ejs-tpl','TEMPLATE ID','text',cfg.email.emailjsTemplateId,'template_xxxxxxx']
            ].map(([id,lbl,type,val,ph]) => `
            <div>
              <label style="font-family:var(--mono);font-size:8px;color:var(--text-dim);display:block;margin-bottom:3px;">${lbl}</label>
              <input type="${type}" id="${id}" value="${val}" placeholder="${ph}"
                style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                       padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
            </div>`).join('')}
        </div>
        <button onclick="testEmail()"
          style="background:none;border:1px solid #ff9800;color:#ff9800;padding:6px 14px;
                 border-radius:4px;cursor:pointer;font-size:9px;font-family:var(--mono);margin-top:12px;">
          📤 Send Test Email
        </button>
      </div>
    </div>

    <!-- ② RULES -->
    <div style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--text-dim);letter-spacing:2px;padding-top:6px;border-top:1px solid var(--border);">② RULE SETUP — BUY / SELL CONDITIONS</div>

    <!-- Signal Rules -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:2px;margin-bottom:12px;">📡 SIGNAL RULES</div>
      ${cfg.rules.filter(r => r.group === 'signals').map(signalRuleRow).join('')}
    </div>

    <!-- Leaderboard Alerts -->
    ${typeof renderLbAlertCard === 'function' ? renderLbAlertCard() : ''}

    <!-- GitHub Position Sync -->
    ${typeof renderGithubSyncCard === 'function' ? renderGithubSyncCard() : ''}

    <!-- Position Tracker -->
    <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #ffd700;border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#ffd700;letter-spacing:2px;margin-bottom:8px;">
        📍 POSITION TRACKER
      </div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:10px;">
        Auto-populated when leaderboard buy alert fires. Shows live P&L and exit signal progress.
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

    <!-- Log -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--text-bright);letter-spacing:2px;margin-bottom:10px;">◆ ALERT LOG</div>
      <div id="alert-cfg-log" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;max-height:180px;overflow-y:auto;">
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:10px;">No alerts yet this session.</div>
      </div>
    </div>

  </div>`;

  renderAlertLog();
  if (typeof renderPositionTracker === 'function') setTimeout(renderPositionTracker, 0);
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
