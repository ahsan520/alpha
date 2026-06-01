// ══════════════════════════════════════════════════════════════
// alert-runner.js  —  GitHub Actions server-side alert checker
// Ports the core logic from alerts.js + signals.js to Node.js.
// Runs on a schedule (see .github/workflows/alerts.yml).
// ══════════════════════════════════════════════════════════════

import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN    = process.argv.includes('--dry-run');
const STATE_FILE = path.join(__dirname, '.alert-state.json');

// ── Config from environment (set via GitHub Secrets / Variables) ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN  || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID    || '';
const COOLDOWN_HOURS  = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '4');
const DIGEST_MODE     = (process.env.DIGEST_MODE || 'true') === 'true';

// Default watchlist — override by setting WATCHLIST env var as a JSON array
// e.g.  WATCHLIST='["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]'
const WATCHLIST = process.env.WATCHLIST
  ? JSON.parse(process.env.WATCHLIST)
  : ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];

// ── Overnight checklist conditions (mirrors alerts.js) ──
const OVN_BUY_CONDITIONS = [
  { id:'ovn_buy_4h',     required:true,  enabled:true,  label:'4H Bias',      desc:'BULL 4H or LEAN BULL' },
  { id:'ovn_buy_daily',  required:true,  enabled:true,  label:'Daily Bias',   desc:'BULL / LEAN BULL / NEUTRAL' },
  { id:'ovn_buy_signal', required:false, enabled:true,  label:'Signal',       desc:'STRONG BUY or BULLISH' },
  { id:'ovn_buy_oi',     required:false, enabled:false, label:'OI / Funding', desc:'OI DROP or CONFIRM' },
];

const OVN_SELL_CONDITIONS = [
  { id:'ovn_sell_daily', required:true,  enabled:true,  label:'Daily Bias',  desc:'LEAN BEAR or BEAR DAY' },
  { id:'ovn_sell_4h',    required:true,  enabled:true,  label:'4H Bias',     desc:'NEUTRAL / LEAN BEAR / BEAR 4H' },
  { id:'ovn_sell_signal',required:false, enabled:true,  label:'Signal',      desc:'BEARISH or definitive WAIT' },
  { id:'ovn_sell_oi',    required:false, enabled:false, label:'OI Div',      desc:'BEAR OI or OI DROP' },
  { id:'ovn_sell_ls',    required:false, enabled:false, label:'L/S Ratio',   desc:'≥65% Longs (squeeze target)' },
];

const DEFAULT_RULES = [
  { id:'vol_bull_4h', group:'signals', action:'buy',  enabled:true  },
  { id:'strong_buy',  group:'signals', action:'buy',  enabled:true  },
  { id:'strong_sell', group:'signals', action:'sell', enabled:true  },
  { id:'bearish_day', group:'signals', action:'sell', enabled:false },
  { id:'dip_buy',     group:'signals', action:'buy',  enabled:false },
  { id:'overnight_buy',  group:'overnight_buy',  action:'buy',  enabled:true,
    minRequired:2, minOptional:1 },
  { id:'overnight_sell', group:'overnight_sell', action:'sell', enabled:true,
    minRequired:2, minOptional:1 },
];

// ════════════════════════════════════════════════════
// PERSISTENCE  (replaces localStorage — uses a JSON file)
// ════════════════════════════════════════════════════
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ════════════════════════════════════════════════════
// DATA FETCHING
// ════════════════════════════════════════════════════
async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tid); }
}

/** Fetch 4H klines and compute derived signals */
async function fetch4hData(pair) {
  try {
    const klines = await fetchJSON(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=50`
    );
    if (!klines || !klines.length) return null;

    const closes  = klines.map(k => parseFloat(k[4]));
    const volumes  = klines.map(k => parseFloat(k[5]));
    const last     = closes.length - 1;
    const price    = closes[last];

    // EMA-8 on 4H
    const k8 = 2 / 9;
    let ema8 = closes[0];
    for (let i = 1; i <= last; i++) ema8 = closes[i] * k8 + ema8 * (1 - k8);

    const recentUp = closes[last] > closes[last - 3];
    const volUp    = volumes[last] > volumes[last - 1];
    const aboveEma8 = price > ema8;

    // RSI-14 on 4H
    let gains = 0, losses = 0;
    for (let i = last - 13; i <= last; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const rs = gains / (losses || 1);
    const rsi4h = 100 - (100 / (1 + rs));

    // Simple CVD proxy: count up vs down candles
    let cvd4h = 0;
    for (let i = last - 9; i <= last; i++) {
      if (closes[i] > closes[i - 1]) cvd4h++; else cvd4h--;
    }

    return { aboveEma8, recentUp, volUp, rsi4h, cvd4h };
  } catch { return null; }
}

/** Fetch daily klines */
async function fetchDailyData(pair) {
  try {
    const klines = await fetchJSON(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=20`
    );
    if (!klines || !klines.length) return null;
    const closes = klines.map(k => parseFloat(k[4]));
    const last   = closes.length - 1;
    const price  = closes[last];

    // EMA-20 on daily
    const k20 = 2 / 21;
    let ema20 = closes[0];
    for (let i = 1; i <= last; i++) ema20 = closes[i] * k20 + ema20 * (1 - k20);

    const aboveEma = price > ema20;
    const chg      = (closes[last] - closes[last - 1]) / closes[last - 1];
    return { aboveEma, chg };
  } catch { return null; }
}

/** Fetch 24h ticker */
async function fetchTicker(pair) {
  try {
    const d = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
    return {
      price:  parseFloat(d.lastPrice),
      chgPct: parseFloat(d.priceChangePercent),
      volume: parseFloat(d.quoteVolume),
    };
  } catch { return null; }
}

// ════════════════════════════════════════════════════
// SIGNAL COMPUTATION  (mirrors signals.js processAI)
// ════════════════════════════════════════════════════
function computeSignals(ticker, k4h, kDay) {
  const { chgPct: chg } = ticker;

  // ── 4H bias ──
  let bias4hScore = 0;
  if (k4h) {
    if (k4h.aboveEma8) bias4hScore += 2; else bias4hScore -= 2;
    if (k4h.recentUp)  bias4hScore += 1; else bias4hScore -= 1;
    if (k4h.volUp && k4h.recentUp)  bias4hScore += 1;
    if (k4h.volUp && !k4h.recentUp) bias4hScore -= 1;
    if (k4h.cvd4h >= 2)       bias4hScore += 2;
    else if (k4h.cvd4h >= 1)  bias4hScore += 1;
    else if (k4h.cvd4h <= -2) bias4hScore -= 2;
    else if (k4h.cvd4h <= -1) bias4hScore -= 1;
    if (k4h.rsi4h !== null) {
      if (k4h.rsi4h < 35) bias4hScore += 1;
      else if (k4h.rsi4h > 65) bias4hScore -= 1;
    }
  }

  let bias4h;
  if      (bias4hScore >= 4)  bias4h = 'BULL 4H';
  else if (bias4hScore >= 2)  bias4h = 'LEAN BULL';
  else if (bias4hScore <= -4) bias4h = 'BEAR 4H';
  else if (bias4hScore <= -2) bias4h = 'LEAN BEAR';
  else                        bias4h = 'NEUTRAL';

  // ── Daily bias ──
  let biasDayScore = 0;
  if (kDay) {
    if (kDay.aboveEma) biasDayScore += 3; else biasDayScore -= 3;
    if (kDay.chg > 0)  biasDayScore += 2; else biasDayScore -= 2;
    if (Math.abs(kDay.chg) > 0.03) biasDayScore += (kDay.chg > 0 ? 1 : -1);
  }

  let biasDay;
  if      (biasDayScore >= 5)  biasDay = 'BULL DAY';
  else if (biasDayScore >= 2)  biasDay = 'LEAN BULL';
  else if (biasDayScore <= -5) biasDay = 'BEAR DAY';
  else if (biasDayScore <= -2) biasDay = 'LEAN BEAR';
  else                         biasDay = 'NEUTRAL';

  // ── Overall signal score ──
  let score = 0;
  if (bias4h === 'BULL 4H')   score += 3;
  if (bias4h === 'LEAN BULL') score += 1;
  if (bias4h === 'BEAR 4H')   score -= 3;
  if (bias4h === 'LEAN BEAR') score -= 1;
  if (biasDay === 'BULL DAY') score += 2;
  if (biasDay === 'LEAN BULL') score += 1;
  if (biasDay === 'BEAR DAY') score -= 2;
  if (biasDay === 'LEAN BEAR') score -= 1;
  if (chg > 3) score += 1;
  if (chg < -3) score -= 1;

  let sig;
  if      (score >= 5)  sig = 'STRONG BUY';
  else if (score >= 2)  sig = 'BULLISH';
  else if (score <= -5) sig = 'STRONG SELL';
  else if (score <= -2) sig = 'BEARISH';
  else                  sig = 'WAIT';

  // ── Vol shock proxy ──
  const shock = (0.7 + Math.abs(chg) / 5).toFixed(2);

  // ── OI divergence proxy ──
  const priceUp   = chg >= 0;
  const longHeavy = score > 0;
  let oiDiv;
  if      (priceUp  && !longHeavy) oiDiv = 'OI DROP';
  else if (!priceUp &&  longHeavy) oiDiv = 'DIP BUY';
  else if ( priceUp &&  longHeavy) oiDiv = 'CONFIRM';
  else                             oiDiv = 'BEAR OI';

  // ── Dip score ──
  let dipScore = 0;
  if (oiDiv === 'DIP BUY') dipScore += 2;
  if (oiDiv === 'CONFIRM') dipScore += 1;
  if (bias4h === 'BULL 4H' || bias4h === 'LEAN BULL') dipScore += 2;
  if (biasDay === 'LEAN BULL') dipScore += 1;
  let dipLabel;
  if      (dipScore >= 5) dipLabel = 'BUY DIP';
  else if (dipScore >= 3) dipLabel = 'ACCUMULATE';
  else                    dipLabel = 'HOLD';

  return { bias4h, biasDay, sig, oiDiv, dipLabel, shock };
}

// ════════════════════════════════════════════════════
// CONDITION EVALUATOR  (mirrors alerts.js evalOvnCond)
// ════════════════════════════════════════════════════
function evalOvnCond(condId, d) {
  const { bias4h, biasDay, sig, oiDiv, lp = 50 } = d;
  switch (condId) {
    case 'ovn_buy_4h':     return !!(bias4h  && (bias4h.includes('BULL 4H')  || bias4h.includes('LEAN BULL')));
    case 'ovn_buy_daily':  return !!(biasDay && (biasDay.includes('BULL')    || biasDay.includes('LEAN BULL')  || biasDay.includes('NEUTRAL')));
    case 'ovn_buy_signal': return sig === 'STRONG BUY' || sig === 'BULLISH';
    case 'ovn_buy_oi':     return !!(oiDiv   && (oiDiv.includes('OI DROP')   || oiDiv.includes('CONFIRM')));
    case 'ovn_sell_daily': return !!(biasDay && (biasDay.includes('LEAN BEAR')|| biasDay.includes('BEAR DAY')));
    case 'ovn_sell_4h':    return !!(bias4h  && (bias4h.includes('NEUTRAL')  || bias4h.includes('LEAN BEAR')  || bias4h.includes('BEAR 4H')));
    case 'ovn_sell_signal':return sig === 'BEARISH' || sig === 'STRONG SELL' || sig === 'WAIT';
    case 'ovn_sell_oi':    return !!(oiDiv   && (oiDiv.includes('BEAR OI')   || oiDiv.includes('OI DROP')));
    case 'ovn_sell_ls':    return lp >= 65;
    default: return false;
  }
}

function evalSignalRule(ruleId, d) {
  const { bias4h, biasDay, sig, dipLabel, shock } = d;
  switch (ruleId) {
    case 'vol_bull_4h':  return parseFloat(shock) > 1.5 && !!(bias4h && (bias4h.includes('BULL') || bias4h.includes('LEAN BULL')));
    case 'strong_buy':   return sig === 'STRONG BUY';
    case 'strong_sell':  return sig === 'STRONG SELL' || sig === 'BEARISH';
    case 'bearish_day':  return !!(bias4h && bias4h.includes('BEAR') && biasDay && biasDay.includes('BEAR'));
    case 'dip_buy':      return !!(dipLabel && dipLabel.includes('BUY DIP'));
    default: return false;
  }
}

// ════════════════════════════════════════════════════
// TELEGRAM SENDER
// ════════════════════════════════════════════════════
async function sendTelegram(msg) {
  if (DRY_RUN) { console.log('[DRY-RUN] Telegram:', msg); return; }
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('⚠  Telegram not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TG_CHAT,
        text:       `🔔 *Alpha Terminal*\n\n${msg}\n\n_${new Date().toUTCString()}_`,
        parse_mode: 'Markdown',
      }),
    });
    const d = await r.json();
    if (d.ok) console.log('✈  Telegram sent:', msg.substring(0, 80));
    else       console.error('✈  Telegram FAILED:', d.description);
  } catch (e) { console.error('✈  Telegram error:', e.message); }
}

// ════════════════════════════════════════════════════
// COOLDOWN / SUPPRESSION  (replaces localStorage)
// ════════════════════════════════════════════════════
function isSuppressed(state, ruleId, sym) {
  const sk  = `alert_state_${ruleId}_${sym}`;
  const tsk = `alert_ts_${ruleId}_${sym}`;
  if (state[sk] !== 'fired') return false;
  const ts  = parseInt(state[tsk] || '0');
  const cd  = COOLDOWN_HOURS * 3600000;
  return (Date.now() - ts) < cd;
}

function markFired(state, ruleId, sym) {
  state[`alert_state_${ruleId}_${sym}`] = 'fired';
  state[`alert_ts_${ruleId}_${sym}`]    = String(Date.now());
}

function clearFired(state, ruleId, sym) {
  delete state[`alert_state_${ruleId}_${sym}`];
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Alpha Terminal Alert Runner — ${new Date().toUTCString()}`);
  console.log(`Pairs: ${WATCHLIST.join(', ')}`);
  console.log(`Cooldown: ${COOLDOWN_HOURS}h | Digest: ${DIGEST_MODE} | Dry-run: ${DRY_RUN}`);
  console.log('═'.repeat(60));

  const state   = loadState();
  const digest  = {};   // { overnight_buy: [], overnight_sell: [] }

  for (const pair of WATCHLIST) {
    console.log(`\n── ${pair}`);

    // Fetch data concurrently
    const [ticker, k4h, kDay] = await Promise.all([
      fetchTicker(pair),
      fetch4hData(pair),
      fetchDailyData(pair),
    ]);

    if (!ticker) { console.log('  ⚠  No ticker data — skipping'); continue; }

    const d = computeSignals(ticker, k4h, kDay);
    console.log(`  bias4h=${d.bias4h}  biasDay=${d.biasDay}  sig=${d.sig}  shock=${d.shock}`);

    for (const rule of DEFAULT_RULES) {
      if (!rule.enabled) continue;

      // ── Signal rules ──
      if (rule.group === 'signals') {
        const triggered = evalSignalRule(rule.id, d);

        if (!triggered) {
          clearFired(state, rule.id, pair);
          continue;
        }
        if (isSuppressed(state, rule.id, pair)) {
          console.log(`  🔕  [${rule.id}] suppressed (cooldown)`);
          continue;
        }
        const emoji = rule.action === 'buy' ? '🟢' : '🔴';
        const msg   = `${emoji} ${pair} [${rule.action.toUpperCase()}] — ${rule.id.replace(/_/g,' ').toUpperCase()}\n4H: ${d.bias4h} | Daily: ${d.biasDay} | Signal: ${d.sig}`;
        console.log(`  🔔  [${rule.id}] FIRE`);
        markFired(state, rule.id, pair);
        await sendTelegram(msg);
        continue;
      }

      // ── Overnight combined rules ──
      const isBuy   = rule.id === 'overnight_buy';
      const conds   = isBuy ? OVN_BUY_CONDITIONS : OVN_SELL_CONDITIONS;
      const active  = conds.filter(c => c.enabled !== false);
      const allPass = active.every(c => evalOvnCond(c.id, d));
      const hasMust = active.some(c => c.required);

      if (hasMust && allPass) {
        if (DIGEST_MODE) {
          // Buffer for a single digest message at the end
          if (isSuppressed(state, rule.id, pair)) {
            console.log(`  🔕  [${rule.id}] suppressed (digest cooldown)`);
            continue;
          }
          if (!digest[rule.id]) digest[rule.id] = { rule, matches: [] };
          digest[rule.id].matches.push({ pair, ...d });
          markFired(state, rule.id, pair);
          console.log(`  📋  [${rule.id}] buffered for digest`);
        } else {
          if (isSuppressed(state, rule.id, pair)) {
            console.log(`  🔕  [${rule.id}] suppressed (cooldown)`);
            continue;
          }
          const icon      = isBuy ? '🌙🟢' : '🌙🔴';
          const dir       = isBuy ? 'BUY'  : 'SELL';
          const checklist = active.map(c => {
            const hit  = evalOvnCond(c.id, d);
            const icon = hit ? '✅' : (c.required ? '❌' : '⬜');
            return `${icon} ${c.label}: ${c.desc}`;
          }).join('\n');
          const msg = `${icon} OVERNIGHT ${dir} — ${pair}\n\n${checklist}\n\n✅ ${active.length}/${active.length} active conditions passed`;
          console.log(`  🔔  [${rule.id}] FIRE`);
          markFired(state, rule.id, pair);
          await sendTelegram(msg);
        }
      } else {
        clearFired(state, rule.id, pair);
      }
    }
  }

  // ── Flush digest ──
  for (const [ruleId, { matches }] of Object.entries(digest)) {
    if (!matches.length) continue;
    const isBuy  = ruleId === 'overnight_buy';
    const icon   = isBuy ? '🌙🟢' : '🌙🔴';
    const dir    = isBuy ? 'BUY'  : 'SELL';
    const header = `${icon} OVERNIGHT ${dir} — ${matches.length} asset${matches.length > 1 ? 's' : ''} matched`;
    const rows   = matches.map(m =>
      `✅ *${m.pair}*\n  4H: ${m.bias4h}\n  Daily: ${m.biasDay}\n  Signal: ${m.sig}`
    ).join('\n\n');
    const msg = `${header}\n\n${rows}`;
    console.log(`\n📋  Sending digest: ${header}`);
    await sendTelegram(msg);
  }

  saveState(state);
  console.log('\n✅  Run complete.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
