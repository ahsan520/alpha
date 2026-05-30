// ══════════════════════════════════════════════
// alerts.js — alert configuration, dispatch, log
// Channels: Email (via EmailJS) + Telegram Bot
// ══════════════════════════════════════════════

// ── Alert log (in-page) ──
function logAlertItem(type, msg) {
  STATE.alertLog.unshift({ type, msg, time: new Date().toLocaleTimeString() });
  if (STATE.alertLog.length > 80) STATE.alertLog.pop();
  const strip = document.getElementById('alert-strip');
  if (strip) {
    strip.innerHTML = STATE.alertLog.map(a =>
      `<div class="alert-item ${a.type}"><span class="at">${a.time}</span><span> ${a.msg}</span></div>`
    ).join('');
  }
  // Also append to alerts tab log
  renderAlertLog();
}

function playAlertSound() {
  new Audio('https://actions.google.com/sounds/v1/scifi/beep_tone.ogg').play().catch(() => {});
}

// ── Email via EmailJS ──
// Docs: https://www.emailjs.com/docs/
// You need a free EmailJS account, a service, and a template with {{message}} variable.
async function sendEmailAlert(msg) {
  const { email } = STATE.alertCfg;
  if (!email.enabled || !email.emailjsPublicKey || !email.emailjsServiceId || !email.emailjsTemplateId) return;
  try {
    // Load EmailJS SDK on demand
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
      to_email: email.address,
      subject: '🔔 Alpha Terminal Alert',
      message: msg,
      time: new Date().toLocaleString()
    });
    logAlertItem('info', `✉ Email sent: ${msg.substring(0, 60)}...`);
  } catch (e) {
    logAlertItem('info', `✉ Email FAILED: ${e.message}`);
  }
}

// ── Telegram Bot ──
// 1. Create bot via @BotFather on Telegram → get bot token
// 2. Start a chat with your bot OR add to a group → get chat_id via getUpdates
// Docs: https://core.telegram.org/bots/api#sendmessage
async function sendTelegramAlert(msg) {
  const { telegram } = STATE.alertCfg;
  if (!telegram.enabled || !telegram.botToken || !telegram.chatId) return;
  try {
    const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegram.chatId, text: `🔔 Alpha Terminal\n\n${msg}\n\n${new Date().toLocaleString()}`, parse_mode: 'Markdown' })
    });
    const d = await r.json();
    if (d.ok) logAlertItem('info', `✈ Telegram sent: ${msg.substring(0, 60)}...`);
    else logAlertItem('info', `✈ Telegram FAILED: ${d.description}`);
  } catch (e) {
    logAlertItem('info', `✈ Telegram FAILED: ${e.message}`);
  }
}

// ── Save alert config ──
function saveAlertCfg() {
  const cfg = STATE.alertCfg;

  // Channel: Email
  cfg.email.enabled = document.getElementById('al-email-on').checked;
  cfg.email.address = document.getElementById('al-email-addr').value.trim();
  cfg.email.emailjsPublicKey = document.getElementById('al-ejs-pubkey').value.trim();
  cfg.email.emailjsServiceId = document.getElementById('al-ejs-svc').value.trim();
  cfg.email.emailjsTemplateId = document.getElementById('al-ejs-tpl').value.trim();

  // Channel: Telegram
  cfg.telegram.enabled = document.getElementById('al-tg-on').checked;
  cfg.telegram.botToken = document.getElementById('al-tg-token').value.trim();
  cfg.telegram.chatId = document.getElementById('al-tg-chat').value.trim();

  localStorage.setItem('a49_alertcfg', JSON.stringify(cfg));
  logAlertItem('info', '💾 Alert config saved.');
  renderAlertCfgPage();
}

// ── Test channels ──
async function testEmail() {
  logAlertItem('info', '📤 Sending test email...');
  await sendEmailAlert('🧪 Test alert from Alpha Terminal — email channel working!');
}
async function testTelegram() {
  logAlertItem('info', '📤 Sending test Telegram message...');
  await sendTelegramAlert('🧪 Test alert from Alpha Terminal — Telegram channel working!');
}

// ── Toggle rule ──
function toggleRule(id) {
  const rule = STATE.alertCfg.rules.find(r => r.id === id);
  if (rule) rule.enabled = !rule.enabled;
  localStorage.setItem('a49_alertcfg', JSON.stringify(STATE.alertCfg));
  renderAlertCfgPage();
}

// ── Render alert config tab ──
function renderAlertCfgPage() {
  const cfg = STATE.alertCfg;
  const el = document.getElementById('tab-alerts');
  if (!el) return;

  el.innerHTML = `
    <div style="padding:14px 20px;border-bottom:1px solid var(--border);background:var(--card);">
      <span class="pt">◆ ALERT CONFIGURATION</span>
    </div>

    <div style="padding:16px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;flex:1;">

      <!-- RULES -->
      <div class="alert-cfg">
        <div class="alert-cfg-title">◆ ALERT RULES</div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);margin-bottom:12px;">
          These rules trigger notifications via your configured channels.
        </div>
        ${cfg.rules.map(r => `
          <div class="alert-rule">
            <div class="alert-rule-label">${r.label}</div>
            <span class="alert-rule-badge ${r.enabled ? 'badge-active' : 'badge-inactive'}">${r.enabled ? 'ENABLED' : 'OFF'}</span>
            <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">
              ${r.channels.map(c => `<span style="margin-right:6px;">${c === 'email' ? '✉' : '✈'} ${c.toUpperCase()}</span>`).join('')}
            </div>
            <button class="toggle-btn ${r.enabled ? 'active' : ''}" onclick="toggleRule('${r.id}')">
              ${r.enabled ? 'DISABLE' : 'ENABLE'}
            </button>
          </div>`).join('')}
      </div>

      <!-- EMAIL SETUP -->
      <div class="alert-cfg">
        <div class="alert-cfg-title">✉ EMAIL ALERTS (via EmailJS)</div>
        <div class="info-box" style="margin-bottom:12px;">
          Uses <a href="https://www.emailjs.com" target="_blank">EmailJS</a> (free tier: 200 emails/month). 
          Sign up → create a service (Gmail/Outlook/etc) → create a template with variables 
          <code style="color:var(--accent)">{{message}}</code>, <code style="color:var(--accent)">{{subject}}</code>, <code style="color:var(--accent)">{{time}}</code> → copy IDs below.
        </div>
        <label><input type="checkbox" id="al-email-on" ${cfg.email.enabled ? 'checked' : ''}
          onchange="STATE.alertCfg.email.enabled=this.checked" style="width:auto;margin-right:6px;">
          Enable Email Alerts</label>
        <br><br>
        <label>RECIPIENT EMAIL</label>
        <input type="email" id="al-email-addr" value="${cfg.email.address}" placeholder="you@example.com">
        <label>EMAILJS PUBLIC KEY</label>
        <input type="text" id="al-ejs-pubkey" value="${cfg.email.emailjsPublicKey}" placeholder="user_xxxxxxxxxxxxxxxxx">
        <label>EMAILJS SERVICE ID</label>
        <input type="text" id="al-ejs-svc" value="${cfg.email.emailjsServiceId}" placeholder="service_xxxxxxx">
        <label>EMAILJS TEMPLATE ID</label>
        <input type="text" id="al-ejs-tpl" value="${cfg.email.emailjsTemplateId}" placeholder="template_xxxxxxx">
        <button class="alert-test-btn" onclick="testEmail()">Send Test Email</button>
      </div>

      <!-- TELEGRAM SETUP -->
      <div class="alert-cfg">
        <div class="alert-cfg-title">✈ TELEGRAM ALERTS</div>
        <div class="info-box" style="margin-bottom:12px;">
          1. Message <a href="https://t.me/BotFather" target="_blank">@BotFather</a> on Telegram → /newbot → copy the <strong>token</strong>.<br>
          2. Start a chat with your new bot (or add it to a group).<br>
          3. Visit <code style="color:var(--accent)">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> to find your <strong>chat_id</strong>.<br>
          4. Paste both below and click Save.
        </div>
        <label><input type="checkbox" id="al-tg-on" ${cfg.telegram.enabled ? 'checked' : ''}
          onchange="STATE.alertCfg.telegram.enabled=this.checked" style="width:auto;margin-right:6px;">
          Enable Telegram Alerts</label>
        <br><br>
        <label>BOT TOKEN</label>
        <input type="text" id="al-tg-token" value="${cfg.telegram.botToken}" placeholder="123456789:ABCDefGHIjklMNOpqrSTUvwxYZ">
        <label>CHAT ID</label>
        <input type="text" id="al-tg-chat" value="${cfg.telegram.chatId}" placeholder="-100xxxxxxxxxx or your user id">
        <button class="alert-test-btn" onclick="testTelegram()">Send Test Message</button>
      </div>

      <!-- SAVE -->
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="save-btn" onclick="saveAlertCfg()">💾 SAVE ALERT CONFIG</button>
        <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);">Config saved to browser localStorage</span>
      </div>

      <!-- LOG -->
      <div class="alert-cfg">
        <div class="alert-cfg-title">◆ ALERT LOG</div>
        <div class="alert-log-wrap" id="alert-cfg-log">
          <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:8px;">No alerts yet this session.</div>
        </div>
      </div>

    </div>`;

  // Repopulate log
  renderAlertLog();
}

function renderAlertLog() {
  const el = document.getElementById('alert-cfg-log');
  if (!el) return;
  if (!STATE.alertLog.length) return;
  el.innerHTML = STATE.alertLog.map(a =>
    `<div class="alert-log-item ${a.type === 'buy' ? 'triggered' : ''}">
      <span class="alt">${a.time}</span>
      <span class="amsg">${a.msg}</span>
    </div>`
  ).join('');
}
