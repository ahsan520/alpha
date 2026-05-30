// ══════════════════════════════════════════════
// signals.js — AI signal processing engine
// All column data computed here, stored in STATE.DS
// ══════════════════════════════════════════════

function processAI(s, p, chg, ex) {
  const isCrypto = s.includes('BINANCE:');
  const { DS, PH } = STATE;

  const shock = ex.stockMeta ? ex.stockMeta.volShock : (0.7 + Math.random() * 1.4).toFixed(2);
  const nf = Math.max(-100, Math.min(100, parseFloat((chg * 8 + (Math.random() - .5) * 20).toFixed(1))));

  let lp = 50, sp = 50;
  if (isCrypto) {
    lp = Math.min(90, Math.max(10, Math.round(50 + chg * 3 + (Math.random() - .5) * 12)));
    sp = 100 - lp;
  } else if (ex.obi) {
    lp = Math.round(parseFloat(ex.obi.bidPct));
    sp = 100 - lp;
  }

  const fr = isCrypto ? ((chg * .003) + (Math.random() - .5) * .02).toFixed(4) : 'N/A';

  const obi = ex.obi || null;
  const obiR = obi ? parseFloat(obi.ratio) : 1;
  const obiScore = obi ? (obiR > 1.2 ? 1 : obiR < 0.8 ? -1 : 0) : 0;

  const cvd = ex.cvd || null;
  const cvdScore = cvd ? (cvd.trending === 'up' ? 1 : -1) : 0;

  const mtf = ex.mtf || [null, null, null];
  const r15 = mtf[0] ?? Math.min(95, Math.max(5, Math.round(50 + chg * 3 + (Math.random() - .5) * 10)));
  const r1h = mtf[1] ?? Math.min(95, Math.max(5, Math.round(50 + chg * 2 + (Math.random() - .5) * 8)));
  const r4h = mtf[2] ?? Math.min(95, Math.max(5, Math.round(50 + chg * 1.5 + (Math.random() - .5) * 6)));

  const liq = isCrypto ? liqEstimate(p, fr, lp) : null;

  // ── EMA TREND ──
  const ph = PH[s] || [];
  let emaTrend = '—', emaVal = null;
  if (ph.length >= 10) {
    const period = Math.min(200, ph.length);
    const k = 2 / (period + 1);
    let ema = ph[ph.length - period];
    for (let i = ph.length - period + 1; i < ph.length; i++) ema = ph[i] * k + ema * (1 - k);
    emaVal = ema;
    emaTrend = p > ema ? 'ABOVE' : 'BELOW';
  }

  // ── FUNDING ZONE ──
  const frNum = parseFloat(fr) || 0;
  let fundingFlag = '—', fundingFlagC = 'var(--text-dim)';
  if (isCrypto && fr !== 'N/A') {
    if (frNum <= -0.03) { fundingFlag = '⚡ DIP ZONE'; fundingFlagC = 'var(--bull)'; }
    else if (frNum <= -0.01) { fundingFlag = '↓ LOW FR'; fundingFlagC = '#00cc8a'; }
    else if (frNum >= 0.05) { fundingFlag = '🔥 BLOW-OFF'; fundingFlagC = 'var(--bear)'; }
    else if (frNum >= 0.025) { fundingFlag = '↑ HIGH FR'; fundingFlagC = '#ff8c00'; }
    else { fundingFlag = 'NEUTRAL'; fundingFlagC = 'var(--text-dim)'; }
  }

  // ── OI DIVERGENCE ──
  let oiDiv = '—', oiDivC = 'var(--text-dim)';
  const priceUp = parseFloat(chg) > 0;
  const longHeavy = lp > 55;
  if (isCrypto || ex.obi) {
    if (priceUp && !longHeavy) { oiDiv = '⚠ OI DROP'; oiDivC = 'var(--bear)'; }
    else if (!priceUp && longHeavy) { oiDiv = '💎 DIP BUY'; oiDivC = 'var(--bull)'; }
    else if (priceUp && longHeavy) { oiDiv = '✓ CONFIRM'; oiDivC = 'var(--bull)'; }
    else { oiDiv = '↓ BEAR OI'; oiDivC = 'var(--bear)'; }
  }

  // ── DIP SCORE ──
  let dipScore = 0;
  if (emaTrend === 'ABOVE') dipScore += 1; else if (emaTrend === 'BELOW') dipScore -= 1;
  if (isCrypto) {
    if (frNum <= -0.03) dipScore += 2; else if (frNum <= -0.01) dipScore += 1;
    else if (frNum >= 0.05) dipScore -= 2; else if (frNum >= 0.025) dipScore -= 1;
  }
  if (oiDiv === '💎 DIP BUY') dipScore += 2;
  else if (oiDiv === '✓ CONFIRM') dipScore += 1;
  else if (oiDiv === '⚠ OI DROP') dipScore -= 1;
  else if (oiDiv === '↓ BEAR OI') dipScore -= 1;
  if (cvdScore > 0) dipScore += 1; else if (cvdScore < 0) dipScore -= 1;
  if (r15 < 30 && r1h < 40) dipScore += 2; else if (r15 > 70 && r1h > 65) dipScore -= 2;
  if (parseFloat(chg) < -2 && dipScore > 0) dipScore += 1;
  if (obiScore > 0) dipScore += 1; else if (obiScore < 0) dipScore -= 1;

  let dipLabel, dipLabelC;
  if (dipScore >= 5) { dipLabel = '🟢 BUY DIP'; dipLabelC = 'var(--bull)'; }
  else if (dipScore >= 3) { dipLabel = '↗ ACCUMULATE'; dipLabelC = '#00cc8a'; }
  else if (dipScore >= 1) { dipLabel = '◎ WATCH'; dipLabelC = 'var(--accent)'; }
  else if (dipScore <= -4) { dipLabel = '🔴 EXIT NOW'; dipLabelC = 'var(--bear)'; }
  else if (dipScore <= -2) { dipLabel = '↘ REDUCE'; dipLabelC = '#ff8c00'; }
  else { dipLabel = '— HOLD'; dipLabelC = 'var(--text-dim)'; }

  // ── BASE SIGNAL SCORE ──
  let score = 0;
  if (chg > 1.5) score += 2; else if (chg > .5) score += 1; else if (chg < -1.5) score -= 2; else if (chg < -.5) score -= 1;
  if (parseFloat(shock) > 1.6) score += 1;
  score += obiScore; score += cvdScore;
  if (nf > 20) score += 1; else if (nf < -20) score -= 1;
  if (r15 < 30 && r1h < 35) score += 1; if (r15 > 70 && r1h > 65) score -= 1;
  if (emaTrend === 'ABOVE') score += 1; else if (emaTrend === 'BELOW') score -= 1;
  if (isCrypto) {
    if (frNum <= -0.03) score += 2; else if (frNum <= -0.01) score += 1;
    else if (frNum >= 0.05) score -= 2; else if (frNum >= 0.025) score -= 1;
  }
  if (oiDiv === '💎 DIP BUY') score += 2; else if (oiDiv === '✓ CONFIRM') score += 1;
  else if (oiDiv === '⚠ OI DROP') score -= 1; else if (oiDiv === '↓ BEAR OI') score -= 1;

  // ── REASON PARTS ──
  const reasonParts = [];
  if (emaTrend === 'ABOVE') reasonParts.push('above EMA'); else if (emaTrend === 'BELOW') reasonParts.push('below EMA');
  if (oiDiv === '💎 DIP BUY') reasonParts.push('buyers holding dip');
  else if (oiDiv === '✓ CONFIRM') reasonParts.push('OI confirms');
  else if (oiDiv === '⚠ OI DROP') reasonParts.push('weak rally');
  else if (oiDiv === '↓ BEAR OI') reasonParts.push('OI bearish');
  if (fundingFlag === '⚡ DIP ZONE') reasonParts.push('funding capitulation');
  else if (fundingFlag === '🔥 BLOW-OFF') reasonParts.push('funding euphoria');
  else if (fundingFlag === '↑ HIGH FR') reasonParts.push('funding elevated');
  if (cvdScore > 0) reasonParts.push('CVD bullish'); else if (cvdScore < 0) reasonParts.push('CVD bearish');
  if (obiScore > 0) reasonParts.push('OBI bid-heavy'); else if (obiScore < 0) reasonParts.push('OBI ask-heavy');
  if (r15 < 30 && r1h < 35) reasonParts.push('RSI oversold'); else if (r15 > 70 && r1h > 65) reasonParts.push('RSI overbought');
  if (nf > 20) reasonParts.push('strong inflow'); else if (nf < -20) reasonParts.push('outflow pressure');
  if (parseFloat(shock) > 2) reasonParts.push('vol spike');

  // ── 4H BIAS ──
  const k4h = ex.k4h || null;
  let bias4h = '—', bias4hC = 'var(--text-dim)', bias4hScore = 0;
  if (k4h) {
    if (k4h.aboveEma8) bias4hScore += 2; else bias4hScore -= 2;
    if (k4h.recentUp) bias4hScore += 1; else bias4hScore -= 1;
    if (k4h.volUp && k4h.recentUp) bias4hScore += 1;
    if (k4h.volUp && !k4h.recentUp) bias4hScore -= 1;
    if (k4h.cvd4h >= 2) bias4hScore += 2; else if (k4h.cvd4h >= 1) bias4hScore += 1;
    else if (k4h.cvd4h <= -2) bias4hScore -= 2; else if (k4h.cvd4h <= -1) bias4hScore -= 1;
    if (k4h.rsi4h !== null) { if (k4h.rsi4h < 35) bias4hScore += 1; else if (k4h.rsi4h > 65) bias4hScore -= 1; }
    if (bias4hScore >= 4) { bias4h = '🟢 BULL 4H'; bias4hC = 'var(--bull)'; }
    else if (bias4hScore >= 2) { bias4h = '↗ LEAN BULL'; bias4hC = '#00cc8a'; }
    else if (bias4hScore <= -4) { bias4h = '🔴 BEAR 4H'; bias4hC = 'var(--bear)'; }
    else if (bias4hScore <= -2) { bias4h = '↘ LEAN BEAR'; bias4hC = '#ff8c00'; }
    else { bias4h = '◎ NEUTRAL'; bias4hC = 'var(--text-dim)'; }
  } else {
    if (r4h > 55 && emaTrend === 'ABOVE') { bias4h = '↗ LEAN BULL'; bias4hC = '#00cc8a'; }
    else if (r4h < 45 && emaTrend === 'BELOW') { bias4h = '↘ LEAN BEAR'; bias4hC = '#ff8c00'; }
    else { bias4h = '◎ NEUTRAL'; bias4hC = 'var(--text-dim)'; }
  }

  // ── DAILY BIAS ──
  const kDay = ex.kDay || null;
  let biasDay = '—', biasDayC = 'var(--text-dim)', biasDayScore = 0;
  if (kDay) {
    if (kDay.aboveEma7) biasDayScore += 2; else biasDayScore -= 2;
    if (kDay.chg7d > 5) biasDayScore += 2; else if (kDay.chg7d > 1) biasDayScore += 1;
    else if (kDay.chg7d < -5) biasDayScore -= 2; else if (kDay.chg7d < -1) biasDayScore -= 1;
    if (kDay.volSurge && kDay.chg7d > 0) biasDayScore += 1;
    if (kDay.volSurge && kDay.chg7d < 0) biasDayScore -= 1;
    if (kDay.cvdDaily >= 4) biasDayScore += 2; else if (kDay.cvdDaily >= 2) biasDayScore += 1;
    else if (kDay.cvdDaily <= -4) biasDayScore -= 2; else if (kDay.cvdDaily <= -2) biasDayScore -= 1;
    if (kDay.rsiDaily !== null) { if (kDay.rsiDaily < 35) biasDayScore += 1; else if (kDay.rsiDaily > 65) biasDayScore -= 1; }
    if (emaTrend === 'ABOVE') biasDayScore += 1; else if (emaTrend === 'BELOW') biasDayScore -= 1;
    if (biasDayScore >= 5) { biasDay = '🟢 BULL DAY'; biasDayC = 'var(--bull)'; }
    else if (biasDayScore >= 2) { biasDay = '↗ LEAN BULL'; biasDayC = '#00cc8a'; }
    else if (biasDayScore <= -5) { biasDay = '🔴 BEAR DAY'; biasDayC = 'var(--bear)'; }
    else if (biasDayScore <= -2) { biasDay = '↘ LEAN BEAR'; biasDayC = '#ff8c00'; }
    else { biasDay = '◎ NEUTRAL'; biasDayC = 'var(--text-dim)'; }
  } else {
    const c = parseFloat(chg);
    if (emaTrend === 'ABOVE' && c > 0) { biasDay = '↗ LEAN BULL'; biasDayC = '#00cc8a'; }
    else if (emaTrend === 'BELOW' && c < 0) { biasDay = '↘ LEAN BEAR'; biasDayC = '#ff8c00'; }
    else { biasDay = '◎ NEUTRAL'; biasDayC = 'var(--text-dim)'; }
  }

  score += Math.round(bias4hScore * 0.4);
  score += Math.round(biasDayScore * 0.3);
  if (bias4h !== '—' && bias4h !== '◎ NEUTRAL') reasonParts.push(`4H: ${bias4h.replace(/[🟢🔴]/g, '').trim()}`);
  if (biasDay !== '—' && biasDay !== '◎ NEUTRAL') reasonParts.push(`Day: ${biasDay.replace(/[🟢🔴]/g, '').trim()}`);

  // ── FINAL SIGNAL ──
  const reason = reasonParts.length ? reasonParts.join(' · ') : 'Awaiting data';
  let sig, sigC, whale = 'Quiet';
  if (score >= 6) {
    sig = 'STRONG BUY'; sigC = 's-sb'; whale = '🐋 ACCUM';
    playAlertSound();
    logAlertItem('buy', `STRONG BUY: ${s.replace('BINANCE:', '').replace('USDT', '')} — ${reason}`);
  } else if (score >= 3) {
    sig = 'BULLISH'; sigC = 's-b';
  } else if (score <= -6) {
    sig = 'STRONG SELL'; sigC = 's-ss'; whale = '🐻 DIST';
    logAlertItem('sell', `STRONG SELL: ${s.replace('BINANCE:', '').replace('USDT', '')} — ${reason}`);
  } else if (score <= -3) {
    sig = 'BEARISH'; sigC = 's-be';
  } else {
    sig = 'WAIT'; sigC = 's-w';
  }

  DS[s] = {
    p: p.toFixed(p < 1 ? 5 : p < 10 ? 3 : 2), chg: chg.toFixed(2),
    r15, r1h, r4h, shock, nf, lp, sp, fr, whale, sig, sigC, reason, score,
    obi, cvd: cvd ? { value: cvd.value, trending: cvd.trending, series: cvd.series } : null, liq,
    emaTrend, emaVal, fundingFlag, fundingFlagC, oiDiv, oiDivC, dipScore, dipLabel, dipLabelC,
    bias4h, bias4hC, bias4hScore, biasDay, biasDayC, biasDayScore
  };

  // ── CHECK ALERT RULES ──
  checkAlertRules(s, DS[s], shock, bias4h);
}

// ── Check configured alert rules ──
function checkAlertRules(sym, d, shock, bias4h) {
  const cfg = STATE.alertCfg;
  if (!cfg.rules) return;
  const name = sym.replace('BINANCE:', '').replace('USDT', '');

  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;
    let triggered = false;
    let msg = '';

    if (rule.id === 'vol_bull_4h') {
      const shockNum = parseFloat(shock);
      const isBull4h = bias4h && (bias4h.includes('BULL') || bias4h.includes('LEAN BULL'));
      if (shockNum > 1.5 && isBull4h) {
        triggered = true;
        msg = `🔔 ${name}: Vol Shock ${shockNum}x + 4H Bias = ${bias4h}`;
      }
    } else if (rule.id === 'strong_buy' && d.sig === 'STRONG BUY') {
      triggered = true;
      msg = `🐋 ${name}: STRONG BUY signal — ${d.reason}`;
    } else if (rule.id === 'strong_sell' && d.sig === 'STRONG SELL') {
      triggered = true;
      msg = `🐻 ${name}: STRONG SELL signal — ${d.reason}`;
    }

    if (triggered) {
      // Dedupe: only fire once per 5 min per rule+sym
      const dedupeKey = `alert_last_${rule.id}_${sym}`;
      const lastFired = parseInt(localStorage.getItem(dedupeKey) || '0');
      if (Date.now() - lastFired < 300000) continue;
      localStorage.setItem(dedupeKey, Date.now());

      logAlertItem('info', `[ALERT] ${msg}`);
      if (rule.channels.includes('email')) sendEmailAlert(msg);
      if (rule.channels.includes('telegram')) sendTelegramAlert(msg);
    }
  }
}
