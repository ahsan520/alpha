// ══════════════════════════════════════════════════════════════════════════════
// telegram-commands.js — all Telegram I/O: sending alerts and polling for
// /pause /resume commands from the configured chat.
// ══════════════════════════════════════════════════════════════════════════════

import { DRY_RUN, TG_TOKEN, TG_CHAT, TG_ENABLED } from './job-state.js';

export async function sendTelegram(msg) {
  if (DRY_RUN)     { console.log('[DRY-RUN] TG:', msg.slice(0, 120)); return; }
  if (!TG_ENABLED) { console.log('[TG DISABLED]'); return; }
  if (!TG_TOKEN || !TG_CHAT) { console.warn('⚠ No TG credentials'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' }),
    });
    const d = await r.json();
    if (!d.ok) console.warn('TG error:', d.description);
  } catch (e) { console.warn('TG fetch error:', e.message); }
}

// ── Telegram kill-switch — /pause and /resume from the configured chat ──
// Only gates NEW buy execution. Existing live positions' stop/T2 sells keep
// firing regardless of pause state — pausing is meant to stop taking on new
// risk, not to strand an already-open position without its safety net.
// Latency note: this is only checked once per Job B cycle (every ~15 min),
// same as everything else headless — not an instant kill switch.
export async function pollTelegramCommands(state) {
  if (!TG_TOKEN || !TG_CHAT) return state;
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=0`);
    const data = await res.json();
    if (!data.ok) return state;

    for (const upd of data.result || []) {
      state.lastUpdateId = upd.update_id;
      const msg    = upd.message || upd.edited_message;
      const text   = (msg?.text || '').trim().toLowerCase();
      const chatId = String(msg?.chat?.id || '');
      if (chatId !== String(TG_CHAT)) continue; // only the configured chat can control trading

      if (text === '/pause' || text === '/stop_trading') {
        state.tradingEnabled = false;
        state.changedAt = Date.now();
        await sendTelegram(
          '⏸ *Auto-trading PAUSED* — new ⭐ top-pick buys are suspended until /resume.\n' +
          '_Already-open live positions still get their stop/T2 exits — this only blocks new entries._'
        );
      } else if (text === '/resume' || text === '/start_trading') {
        state.tradingEnabled = true;
        state.changedAt = Date.now();
        await sendTelegram('▶️ *Auto-trading RESUMED* — the next ⭐ top-ranked buy alert may place a live order again.');
      }
    }
  } catch (e) {
    console.log('[telegram-commands] poll failed:', e.message);
  }
  return state;
}
