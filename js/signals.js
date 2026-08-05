// ══════════════════════════════════════════════
// signals.js — AI signal processing engine
// All column data computed here, stored in STATE.DS
// ══════════════════════════════════════════════

// ── SUPPORT / RESISTANCE from klines ──
// Uses a simple pivot-point method on the available OHLC bars.
// Works for both crypto (k4h / kDay raw klines stored in extra) and
// stocks (fetchStockExtra already returns bar arrays inside kDay/k4h).
//
// Strategy:
//  1. Collect a set of recent high and low pivots from the price bars.
//  2. Cluster nearby pivots (within 0.8% of each other) so we don't show
//     duplicate levels that are basically the same price.
//  3. Levels below current price → support candidates; above → resistance.
//  4. Pick the nearest support and nearest resistance.
function calcSupRes(price, bars) {
  // bars: array of { h, l, c } objects, oldest → newest
  if (!bars || bars.length < 5 || !price) return { sup: null, res: null };

  const n = bars.length;
  const pivots = [];

  // Identify swing highs and swing lows (window ±2)
  for (let i = 2; i < n - 2; i++) {
    const h = bars[i].h, l = bars[i].l;
    const isSwingH = h >= bars[i-1].h && h >= bars[i-2].h && h >= bars[i+1].h && h >= bars[i+2].h;
    const isSwingL = l <= bars[i-1].l && l <= bars[i-2].l && l <= bars[i+1].l && l <= bars[i+2].l;
    if (isSwingH) pivots.push(h);
    if (isSwingL) pivots.push(l);
  }
  // Also always include the recent high/low as reference
  pivots.push(Math.max(...bars.slice(-5).map(b => b.h)));
  pivots.push(Math.min(...bars.slice(-5).map(b => b.l)));

  // Cluster: merge pivots within 0.8% of each other
  const sorted = [...new Set(pivots)].sort((a, b) => a - b);
  const clustered = [];
  for (const v of sorted) {
    if (!clustered.length || (v - clustered[clustered.length - 1]) / clustered[clustered.length - 1] > 0.008) {
      clustered.push(v);
    } else {
      // Average the cluster
      clustered[clustered.length - 1] = (clustered[clustered.length - 1] + v) / 2;
    }
  }

  // Split into support (≤ price) and resistance (> price)
  const supports    = clustered.filter(v => v <= price * 1.001).sort((a, b) => b - a); // nearest first
  const resistances = clustered.filter(v => v > price * 0.999).sort((a, b) => a - b);  // nearest first

  const fmt = v => v == null ? null : (v < 1 ? v.toFixed(4) : v < 10 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : v.toFixed(2));
  return {
    sup: fmt(supports[0] ?? null),
    res: fmt(resistances[0] ?? null),
  };
}

// ── Extract normalised bar array from whatever kline shape is available ──
function extractBars(ex) {
  // Stocks: fetchStockExtra exposes ex._barsDay (all daily bars, OHLCV objects)
  if (ex._barsDay && ex._barsDay.length >= 5) return ex._barsDay;
  // Stocks: shorter 4h-proxy fallback
  if (ex._bars4h && ex._bars4h.length >= 5) return ex._bars4h;
  // Crypto: fetchDailyKlines returns kDay with nested _barsDay
  if (ex.kDay && ex.kDay._barsDay && ex.kDay._barsDay.length >= 5) return ex.kDay._barsDay;
  return [];
}

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
  // Was computed from PH[] — a client-side buffer of live-poll ticks since
  // page load (elsewhere in this file, near sparkBars below, there's
  // already a comment noting PH[] "only has 15-second ticks since page
  // load (minutes of data)"). Worse, its period wasn't even fixed: it used
  // Math.min(200, ph.length), so the effective EMA length silently grew
  // the longer a tab stayed open — never a consistent indicator, and never
  // remotely comparable to what the server actually trades on.
  //
  // The server's real trading decision (scripts/leaderboard-scanner.js):
  //   - crypto  (scoreSymbol):  EMA-20 on 4H candle closes
  //   - stock   (scoreStock):   EMA-20 on DAILY candle closes
  // ex.k4h._bars4h (crypto, added in api.js's _compute4hBias) and
  // ex._barsDay/extractBars(ex) (stocks/fallback) now carry the same real
  // bar data used for sparkBars/support-resistance below — reusing it here
  // for the primary trend badge instead of PH[] makes the dashboard agree
  // with what the headless bot is actually gating on.
  const emaCloses = (isCrypto && ex.k4h?._bars4h?.length >= 5)
    ? ex.k4h._bars4h.map(b => b.c)
    : extractBars(ex).map(b => b.c);
  let emaTrend = '—', emaVal = null;
  if (emaCloses.length >= 20) {
    const period = Math.min(20, emaCloses.length);
    const k = 2 / (period + 1);
    let ema = emaCloses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < emaCloses.length; i++) ema = emaCloses[i] * k + ema * (1 - k);
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

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 1: WHALE ACCUMULATION SCORE (0–100)
  // Combines OI Change, CVD, OB Imbalance, Funding, Vol Shock, L/S
  // Weights: OI 25% | CVD 20% | OBI 15% | Funding 15% | Vol 15% | L/S 10%
  // ══════════════════════════════════════════════════════════════
  let whaleRaw = 50; // baseline neutral

  // OI contribution (25 pts max)
  if      (oiDiv === '✓ CONFIRM')  whaleRaw += 25;
  else if (oiDiv === '💎 DIP BUY') whaleRaw += 18;
  else if (oiDiv === '⚠ OI DROP')  whaleRaw -= 15;
  else if (oiDiv === '↓ BEAR OI')  whaleRaw -= 25;

  // CVD contribution (20 pts max)
  if      (cvdScore > 0)  whaleRaw += 20;
  else if (cvdScore < 0)  whaleRaw -= 20;

  // OBI contribution (15 pts max)
  if      (obiScore > 0)  whaleRaw += 15;
  else if (obiScore < 0)  whaleRaw -= 15;

  // Funding contribution (15 pts max) — negative funding = whale fuel
  if      (frNum <= -0.03) whaleRaw += 15;
  else if (frNum <= -0.01) whaleRaw += 8;
  else if (frNum >= 0.05)  whaleRaw -= 15;
  else if (frNum >= 0.025) whaleRaw -= 8;

  // Vol Shock contribution (15 pts max)
  const shockNum = parseFloat(shock) || 1;
  if      (shockNum >= 2.5) whaleRaw += 15;
  else if (shockNum >= 1.8) whaleRaw += 10;
  else if (shockNum >= 1.3) whaleRaw += 5;
  else if (shockNum < 0.7)  whaleRaw -= 8;

  // L/S contribution (10 pts max) — more shorts = more squeeze fuel
  if      (sp > 55) whaleRaw += 10; // short-heavy = squeeze potential
  else if (lp > 70) whaleRaw -= 10; // retail long-heavy = distribution risk

  const whaleScore = Math.max(0, Math.min(100, Math.round(whaleRaw)));
  let whaleZone, whaleZoneC, whaleZoneEmoji;
  if      (whaleScore >= 80) { whaleZone = 'Aggressive Accum'; whaleZoneC = 'var(--bull)';  whaleZoneEmoji = '🐋'; }
  else if (whaleScore >= 60) { whaleZone = 'Smart Money Buy';  whaleZoneC = '#00cc8a';      whaleZoneEmoji = '💚'; }
  else if (whaleScore >= 40) { whaleZone = 'Neutral';          whaleZoneC = 'var(--text-dim)'; whaleZoneEmoji = '⚪'; }
  else if (whaleScore >= 20) { whaleZone = 'Distribution';     whaleZoneC = '#ff8c00';      whaleZoneEmoji = '🟠'; }
  else                       { whaleZone = 'Heavy Dist';        whaleZoneC = 'var(--bear)';  whaleZoneEmoji = '🔴'; }

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 2: EARLY ENTRY (Institutional) DETECTION
  // OI increasing + CVD rising + Funding neutral/negative + Vol rising
  // ══════════════════════════════════════════════════════════════
  const earlyEntryChecks = {
    oiRising:      oiDiv === '✓ CONFIRM' || oiDiv === '💎 DIP BUY',
    cvdRising:     cvdScore > 0,
    fundingHealthy: frNum <= 0.01,  // not overheated
    volExpanding:  shockNum >= 1.3,
  };
  const earlyEntryCount = Object.values(earlyEntryChecks).filter(Boolean).length;
  const earlyEntryDetected = earlyEntryCount >= 3; // 3/4 = institutional entry detected

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 3: SIGNAL STABILITY (uses score history in PH)
  // Tracks score variance over recent cycles — lower variance = more stable
  // ══════════════════════════════════════════════════════════════
  // ph — a live-tick buffer — is no longer used for indicators (see EMA
  // TREND above); still fine as a lightweight per-cycle counter here.
  if (!STATE.scoreHistory) STATE.scoreHistory = {};
  if (!STATE.scoreHistory[s]) STATE.scoreHistory[s] = [];
  STATE.scoreHistory[s].push({ t: Date.now(), score });
  // Keep last 30 min of history (each cycle ~15s → ~120 entries)
  const cutoff30m = Date.now() - 30 * 60 * 1000;
  STATE.scoreHistory[s] = STATE.scoreHistory[s].filter(x => x.t > cutoff30m);

  const scoreHist = STATE.scoreHistory[s].map(x => x.score);
  let signalStability = 80; // default
  if (scoreHist.length >= 5) {
    const avg = scoreHist.reduce((a, b) => a + b, 0) / scoreHist.length;
    const variance = scoreHist.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / scoreHist.length;
    const stdDev = Math.sqrt(variance);
    // stdDev 0 = 100% stable, stdDev 6+ = very unstable
    signalStability = Math.max(10, Math.min(100, Math.round(100 - (stdDev / 6) * 90)));
  }
  let stabilityLabel, stabilityCls;
  if      (signalStability >= 80) { stabilityLabel = 'Stable';    stabilityCls = 'stab-stable'; }
  else if (signalStability >= 55) { stabilityLabel = 'Moderate';  stabilityCls = 'stab-moderate'; }
  else                            { stabilityLabel = 'Unstable';  stabilityCls = 'stab-unstable'; }

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 4: BULL CONFIRMATION COUNTER (10 checks)
  // ══════════════════════════════════════════════════════════════
  const confirmChecks = [
    { label: 'Daily Bias Bull',    pass: biasDay.includes('BULL') || biasDay.includes('LEAN BULL') },
    { label: '4H Bias Bull',       pass: bias4h.includes('BULL') || bias4h.includes('LEAN BULL')  },
    { label: 'Above EMA',          pass: emaTrend === 'ABOVE' },
    { label: 'OI Rising',          pass: earlyEntryChecks.oiRising },
    { label: 'CVD Rising',         pass: cvdScore > 0 },
    { label: 'Vol Expansion',      pass: shockNum >= 1.3 },
    { label: 'Funding Healthy',    pass: earlyEntryChecks.fundingHealthy },
    { label: 'OBI Bid Heavy',      pass: obiScore > 0 },
    { label: 'RSI Not OB',         pass: r15 < 70 && r1h < 68 },
    { label: 'Whale Score ≥60',    pass: whaleScore >= 60 },
  ];
  const bullConfirmCount = confirmChecks.filter(c => c.pass).length;

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 5: SMART MONEY vs RETAIL
  // ══════════════════════════════════════════════════════════════
  let smartMoneyLabel, smartMoneyC;
  if (earlyEntryDetected && whaleScore >= 65) {
    smartMoneyLabel = 'Whales Buying';   smartMoneyC = 'var(--bull)';
  } else if (shockNum >= 2.0 && lp > 65 && frNum >= 0.03) {
    smartMoneyLabel = 'Retail FOMO';     smartMoneyC = '#ff8c00';
  } else if (whaleScore <= 35) {
    smartMoneyLabel = 'Institutional↓'; smartMoneyC = 'var(--bear)';
  } else if (whaleScore >= 55 && earlyEntryCount >= 2) {
    smartMoneyLabel = 'Smart Accum';    smartMoneyC = '#00cc8a';
  } else {
    smartMoneyLabel = 'Mixed Flow';     smartMoneyC = 'var(--text-dim)';
  }

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 6: TRADE QUALITY + SETUP TYPE
  // ══════════════════════════════════════════════════════════════
  let tradeGrade, tradeGradeC;
  const gradeScore = bullConfirmCount * 10 + (whaleScore - 50) * 0.3 + (signalStability - 50) * 0.2;
  if      (gradeScore >= 85) { tradeGrade = 'A+'; tradeGradeC = '#00e5a0'; }
  else if (gradeScore >= 70) { tradeGrade = 'A';  tradeGradeC = 'var(--bull)'; }
  else if (gradeScore >= 50) { tradeGrade = 'B';  tradeGradeC = '#00cc8a'; }
  else if (gradeScore >= 30) { tradeGrade = 'C';  tradeGradeC = '#ff8c00'; }
  else                       { tradeGrade = 'D';  tradeGradeC = 'var(--bear)'; }

  // Setup archetype
  let setupArchetype;
  if (whaleScore >= 75 && earlyEntryDetected) {
    setupArchetype = 'Whale Accumulation';
  } else if (shockNum >= 2.0 && score >= 4 && emaTrend === 'ABOVE') {
    setupArchetype = 'Momentum Breakout';
  } else if (sp > 55 && frNum <= -0.01) {
    setupArchetype = 'Short Squeeze';
  } else if (dipScore >= 3 && parseFloat(chg) < -1) {
    setupArchetype = 'Mean Reversion';
  } else if (lp > 65 && shockNum >= 1.5) {
    setupArchetype = 'Retail Chase';
  } else {
    setupArchetype = 'Developing';
  }

  // Success probability (simple — based on grade + whale + stability)
  const successProb = Math.max(20, Math.min(92, Math.round(
    bullConfirmCount * 6 + (whaleScore - 50) * 0.25 + (signalStability - 50) * 0.1 + 30
  )));

  // ══════════════════════════════════════════════════════════════
  // PDF FEATURE 8: EARLY WARNING ZONES (Building → Accumulating → Ready → BULLISH)
  // Replaces the binary WAIT → BULLISH jump with a 4-stage pipeline
  // ══════════════════════════════════════════════════════════════
  let earlyWarnZone = null, earlyWarnC = 'var(--text-dim)';
  if (score > 0 && score < 3) {
    if      (whaleScore >= 60 && earlyEntryCount >= 2) { earlyWarnZone = '🟡 READY';       earlyWarnC = '#f5c518'; }
    else if (whaleScore >= 50 || earlyEntryCount >= 2)  { earlyWarnZone = '🔵 ACCUMULATING'; earlyWarnC = '#4da6ff'; }
    else                                                 { earlyWarnZone = '⚪ BUILDING';    earlyWarnC = '#8888aa'; }
  }

  // ══════════════════════════════════════════════════════════════
  // FINAL SIGNAL — now with early warning zones
  // ══════════════════════════════════════════════════════════════
  const reason = reasonParts.length ? reasonParts.join(' · ') : 'Awaiting data';
  let sig, sigC, whale = 'Quiet';
  if (score >= 6) {
    sig = 'STRONG BUY'; sigC = 's-sb'; whale = '🐋 ACCUM';
    playAlertSound();
    logAlertItem('buy', `STRONG BUY: ${s.replace('BINANCE:', '').replace('USDT', '')} — ${reason} | Whale:${whaleScore} Conf:${bullConfirmCount}/10`);
  } else if (score >= 3) {
    sig = 'BULLISH'; sigC = 's-b';
  } else if (score <= -6) {
    sig = 'STRONG SELL'; sigC = 's-ss'; whale = '🐻 DIST';
    logAlertItem('sell', `STRONG SELL: ${s.replace('BINANCE:', '').replace('USDT', '')} — ${reason}`);
  } else if (score <= -3) {
    sig = 'BEARISH'; sigC = 's-be';
  } else {
    sig = earlyWarnZone ? `${earlyWarnZone}` : 'WAIT'; sigC = 's-w';
  }

  // ── SUPPORT / RESISTANCE ──
  // Prefer daily bars (wider swings); fall back to 4h bars for intraday context.
  const srBars = extractBars(ex);
  const { sup, res } = calcSupRes(parseFloat(p), srBars);

  // ── 24h% — prefer kDay.chg1d (derived from freshly-fetched daily bar series)
  // over the raw chg param when available. chg1d = (closes[n-1] - closes[n-2]) /
  // closes[n-2] and is immune to proxy-cached stale previousClose values.
  const kDayEx = ex.kDay || null;
  const chg1dEx = kDayEx?.chg1d;
  const finalChg = (chg1dEx != null) ? chg1dEx : parseFloat(chg);

  // ── Spark data — use last 7 daily closes from bar series, not live-poll ticks.
  // PH[] only has 15-second ticks since page load (minutes of data), which produces
  // a flat or meaningless line. Daily closes give a true 5-7 day price shape.
  let sparkBars = null;
  const barsDay = ex._barsDay || kDayEx?._barsDay || null;
  if (barsDay && barsDay.length >= 5) {
    sparkBars = barsDay.slice(-7).map(b => b.c ?? b);
  }

  // ── RISK FLOW ──
  const _rf = typeof calcRiskFlow === 'function' ? calcRiskFlow({
    cvd, whaleScore, chg: finalChg, oiDiv, fr: parseFloat(fr) || 0,
    shock: parseFloat(shock) || 1, cvdTrend: cvd?.trending,
  }, s) : null;

  DS[s] = {
    p: p.toFixed(p < 1 ? 5 : p < 10 ? 3 : 2), chg: finalChg.toFixed(2),
    r15, r1h, r4h, shock, nf, lp, sp, fr, whale, sig, sigC, reason, score,
    obi, cvd: cvd ? { value: cvd.value, trending: cvd.trending, series: cvd.series } : null, liq,
    emaTrend, emaVal, fundingFlag, fundingFlagC, oiDiv, oiDivC, dipScore, dipLabel, dipLabelC,
    bias4h, bias4hC, bias4hScore, biasDay, biasDayC, biasDayScore,
    sup, res, sparkBars,
    // ── PDF Enhancement Fields ──
    whaleScore, whaleZone, whaleZoneC, whaleZoneEmoji,
    earlyEntryDetected, earlyEntryChecks, earlyEntryCount,
    signalStability, stabilityLabel, stabilityCls,
    confirmChecks, bullConfirmCount,
    smartMoneyLabel, smartMoneyC,
    tradeGrade, tradeGradeC, setupArchetype, successProb,
    earlyWarnZone, earlyWarnC,
    _rf,
  };

  // ── CHECK ALERT RULES ──
  checkAlertRules(s, DS[s], shock, bias4h);

  // ── REFRESH LEADERBOARD ──
  if (typeof renderLeaderboard === 'function') renderLeaderboard();
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


// === ChatGPT TFSA Yield ETF Adjustment ===
// Covered-call / yield ETFs can look artificially weak because
// distributions and option overwriting reduce momentum.
// This helper can be incorporated into the scoring model.
const yieldEtfs = ['ETHY.TO','BTCY.TO','ETHH.TO','XRPP.TO'];

function applyYieldEtfAdjustment(symbol, state){
    if(!yieldEtfs.includes(symbol)) return state;

    // soften extreme sell signals
    if(typeof state.score === 'number') state.score += 2;
    if(typeof state.dipScore === 'number') state.dipScore += 2;

    return state;
}

// Example:
// state = applyYieldEtfAdjustment(symbol, state);

// ══════════════════════════════════════════════════════════════════════════════
// RISK FLOW ENGINE — v2.0
// Works for crypto (full signals), stocks (fr=0, obi proxy),
// and market-pulse-only assets (price change only — no whale/CVD needed).
//
// Three data layers:
//   Layer 1 — STATE.DS       : full scoring (whale, CVD, OBI, funding)
//   Layer 2 — STATE.marketPulse : price-only (chg%) — Gold, Silver, Bonds,
//             Oil, DXY, indices — no watchlist symbol required
//   Layer 3 — velocity history  : 15-min flow delta per sector
//
// Exports:
//   sectorTagFor(sym)           → sector string
//   isSentinel(sym)             → bool
//   calcRiskFlow(d, sym)        → per-symbol { risk, flow, riskC, flowC, riskEmoji }
//   pulseRiskFlow(chg, sector)  → lightweight flow from chg% (pulse layer)
//   calcRiskAppetite()          → cross-asset macro signals
//   calcSectorFlow(allDS)       → full sector array (DS + pulse merged)
//   calcMarketRegime(sectors, appetite) → top-level market regime label
// ══════════════════════════════════════════════════════════════════════════════

// ── Sector tag for watchlist symbols ──
function sectorTagFor(sym) {
  const s = sym.toUpperCase();
  if (s.includes('BINANCE:') || s.endsWith('USDT')) return 'CRYPTO';

  const ETF_SECTORS = {
    // TSX crypto ETFs
    'ETHY.TO':'CRYPTO', 'KILO.TO':'CRYPTO', 'TXF.TO':'CRYPTO',
    'BTCY.TO':'CRYPTO', 'ETHH.TO':'CRYPTO', 'XRPP.TO':'CRYPTO',
    'GLCC.TO':'CRYPTO', 'AGCC.TO':'CRYPTO', 'ENCC.TO':'CRYPTO', 'HTAE.TO':'CRYPTO',
    // TSX equity
    'XEG.TO':'ENERGY',  'ENB.TO':'ENERGY',  'TOU.TO':'ENERGY',
    'XEI.TO':'DIVIDEND','T.TO':'TELECOM',   'BCE.TO':'TELECOM',
    'XBM.TO':'MATERIALS','ABX.TO':'MATERIALS','SVR.TO':'MATERIALS',
    'XFN.TO':'FINANCIALS','RY.TO':'FINANCIALS','TD.TO':'FINANCIALS',
    'GE.TO':'INDUSTRIAL',
    // US tech
    'NVDA':'TECH','CRWD.TO':'TECH','GOOG.TO':'TECH',
    'MSFT.TO':'TECH','TSLA.TO':'TECH','DELL.TO':'TECH','ESTC.TO':'TECH',
    'SPXY.TO':'MIXED',
  };
  if (ETF_SECTORS[sym]) return ETF_SECTORS[sym];

  if (s.endsWith('.L'))  return 'LSE';
  if (s.endsWith('.DE')) return 'EU';
  if (s.endsWith('.T'))  return 'JAPAN';
  if (s.endsWith('.HK')) return 'CHINA';
  if (s.endsWith('.NS')) return 'INDIA';
  return 'US';
}

// ── Sentinel map — always-on rotation coverage, no watchlist symbol needed ──
// These feed into the sector flow panel via STATE.marketPulse (pulse layer).
// The sector panel shows these sectors even if you hold ZERO related symbols.
const SENTINEL_MAP = {
  // Crypto sentinels (also in DS if in watchlist)
  'BINANCE:BTCUSDT': { sector:'CRYPTO',     label:'BTC',        pulse:'BTC'  },
  'BINANCE:ETHUSDT': { sector:'CRYPTO',     label:'ETH',        pulse:'ETH'  },
  'BINANCE:SOLUSDT': { sector:'CRYPTO',     label:'SOL',        pulse:'SOL'  },
  // TSX sentinels
  'XIU.TO': { sector:'TSX_BROAD',  label:'TSX 60',     pulse:null   },
  'XEG.TO': { sector:'ENERGY',     label:'TSX Energy', pulse:null   },
  'XFN.TO': { sector:'FINANCIALS', label:'TSX Fin',    pulse:null   },
  'XBM.TO': { sector:'MATERIALS',  label:'TSX Mats',   pulse:null   },
  // US broad + sector sentinels
  'SPY':    { sector:'US_BROAD',   label:'S&P 500',    pulse:'SPY'  },
  'QQQ':    { sector:'TECH',       label:'NASDAQ 100', pulse:'QQQ'  },
  'IWM':    { sector:'US_SMALL',   label:'Russell 2K', pulse:'IWM'  },
  'XLF':    { sector:'FINANCIALS', label:'US Fin',     pulse:'XLF'  },
  'XLE':    { sector:'ENERGY',     label:'US Energy',  pulse:'XLE'  },
  'XLV':    { sector:'HEALTH',     label:'Healthcare', pulse:'XLV'  },
  'XLB':    { sector:'MATERIALS',  label:'US Mats',    pulse:'XLB'  },
  // Haven sentinels — pulse layer ONLY (no DS scoring possible)
  'GLD':    { sector:'HAVEN',      label:'Gold',       pulse:'GLD'  },
  'SLV':    { sector:'HAVEN',      label:'Silver',     pulse:'SLV'  },
  'TLT':    { sector:'HAVEN',      label:'Bonds/10Y',  pulse:'TLT'  },
  // Commodity sentinels — pulse layer ONLY
  'USO':    { sector:'COMMODITIES',label:'WTI Oil',    pulse:'USO'  },
  'BRT':    { sector:'COMMODITIES',label:'Brent',      pulse:'BRT'  },
  // Currency sentinel — pulse layer ONLY
  'UUP':    { sector:'CURRENCY',   label:'DXY',        pulse:'UUP'  },
};

// Reverse map: pulse key → sentinel config (e.g. 'GLD' → SENTINEL_MAP['GLD'])
const PULSE_KEY_MAP = {};
for (const [sym, cfg] of Object.entries(SENTINEL_MAP)) {
  if (cfg.pulse) PULSE_KEY_MAP[cfg.pulse] = { ...cfg, sym };
}

function isSentinel(sym) { return !!(SENTINEL_MAP[sym]); }

// ── Flow velocity history — persists across render cycles (~60s each) ──
if (!window._sectorFlowHistory) window._sectorFlowHistory = {};

// ── Per-symbol risk flow (full scoring — STATE.DS layer) ──
function calcRiskFlow(d, sym) {
  if (!d) return { risk:'—', flow:'—', riskC:'var(--text-dim)', flowC:'var(--text-dim)', riskEmoji:'' };

  const cvdUp    = d.cvd?.trending === 'up' || d.cvdTrend === 'up';
  const whale    = d.whaleScore ?? 50;
  const chg      = parseFloat(d.chg) || 0;
  const oiDiv    = d.oiDiv || '—';
  const fr       = parseFloat(d.fr) || 0;
  const isCrypto = sym.includes('BINANCE:');

  if (whale >= 65 && cvdUp && fr <= 0.01 && chg > 0.3)
    return { risk:'RISK ON',    flow:'ACCUMULATE', riskC:'var(--bull)',     flowC:'var(--bull)',     riskEmoji:'🟢' };
  if ((oiDiv.includes('DIP BUY') || oiDiv.includes('OI DROP')) && whale >= 55 && cvdUp)
    return { risk:'ROTATE IN',  flow:'INFLOW',     riskC:'var(--accent)',   flowC:'var(--accent)',   riskEmoji:'🔵' };
  if ((oiDiv.includes('CONFIRM') || oiDiv.includes('✓')) && chg < -0.5 && whale <= 40)
    return { risk:'ROTATE OUT', flow:'OUTFLOW',    riskC:'#ff8c00',         flowC:'#ff8c00',         riskEmoji:'🟠' };
  if (whale <= 30 && !cvdUp && (isCrypto ? fr < -0.01 : chg < -0.5))
    return { risk:'RISK OFF',   flow:'EXIT',       riskC:'var(--bear)',     flowC:'var(--bear)',     riskEmoji:'🔴' };
  return   { risk:'NEUTRAL',   flow:'—',          riskC:'var(--text-dim)', flowC:'var(--text-dim)', riskEmoji:'⚪' };
}

// ── Lightweight risk flow from price change only (pulse layer) ──
// Used for Gold, Silver, Bonds, Oil, DXY, indices — no whale/CVD available.
// HAVEN and CURRENCY sectors use inverted logic (see calcSectorFlow).
function pulseRiskFlow(chg) {
  if (chg >  1.5) return { risk:'RISK ON',    score: 2 };
  if (chg >  0.3) return { risk:'ROTATE IN',  score: 1 };
  if (chg < -1.5) return { risk:'RISK OFF',   score:-2 };
  if (chg < -0.3) return { risk:'ROTATE OUT', score:-1 };
  return           { risk:'NEUTRAL',          score: 0 };
}

// ── Cross-asset risk appetite from STATE.marketPulse ──
function calcRiskAppetite() {
  const mp  = (typeof STATE !== 'undefined' && STATE.marketPulse) ? STATE.marketPulse : {};
  const spy = parseFloat(mp.SPY?.chg || 0);
  const iwm = parseFloat(mp.IWM?.chg || 0);
  const gld = parseFloat(mp.GLD?.chg || 0);
  const slv = parseFloat(mp.SLV?.chg || 0);
  const tlt = parseFloat(mp.TLT?.chg || 0);
  const btc = parseFloat(mp.BTC?.chg || 0);
  const eth = parseFloat(mp.ETH?.chg || 0);
  const sol = parseFloat(mp.SOL?.chg || 0);
  const tsx = parseFloat(mp.TSX?.chg || 0);
  const uup = parseFloat(mp.UUP?.chg || 0);  // DXY proxy
  const uso = parseFloat(mp.USO?.chg || 0);  // WTI

  const smallCapLead = parseFloat((iwm - spy).toFixed(2));
  const goldFlight   = gld > 0.5 && spy < -0.3;
  const silverFlight = slv > 0.5 && spy < -0.3;
  const bondFlight   = tlt < -0.1 && spy < -0.3;  // yield dropping = bonds rising
  const dxyRising    = uup > 0.3;
  const cryptoBeta   = parseFloat((btc - spy).toFixed(2));
  const tsxVsSpy     = parseFloat((tsx - spy).toFixed(2));

  // Stablecoin rotation proxy: BTC bleeding but ETH/SOL holding → within-crypto rotation
  const btcBleeding  = btc < -2;
  const altHolding   = (eth > btc + 1) || (sol > btc + 1);
  const stableRotate = btcBleeding && altHolding;

  // Haven convergence: gold AND silver AND bonds all bid simultaneously = real fear
  const havenConvergence = gld > 0.3 && slv > 0.3 && tlt < -0.05;

  // Everything bleeding check
  const equityBleeding = spy < -0.5 && iwm < -0.5;
  const cryptoBleeding = btc < -1 && eth < -1;
  const goldBleeding   = gld < -0.3;
  const bondBleeding   = tlt > 0.2;  // yield rising = bonds falling
  const allBleeding    = equityBleeding && cryptoBleeding && goldBleeding;

  const riskScore =
    (smallCapLead > 1 ? 2 : smallCapLead > 0 ? 1 : smallCapLead < -1 ? -2 : -1) +
    (goldFlight   ? -2 : gld  < -0.3 ?  1 : 0) +
    (bondFlight   ? -2 : 0) +
    (dxyRising    ? -1 : uup  < -0.3 ?  1 : 0) +
    (spy > 0.5    ?  1 : spy  < -0.5 ? -1 : 0);

  let appetiteLabel, appetiteC, appetiteEmoji;
  if      (riskScore >= 3)  { appetiteLabel='HIGH';     appetiteC='var(--bull)';     appetiteEmoji='🟢'; }
  else if (riskScore >= 1)  { appetiteLabel='MODERATE'; appetiteC='#00cc8a';          appetiteEmoji='🔵'; }
  else if (riskScore <= -3) { appetiteLabel='VERY LOW'; appetiteC='var(--bear)';     appetiteEmoji='🔴'; }
  else if (riskScore <= -1) { appetiteLabel='LOW';      appetiteC='#ff8c00';          appetiteEmoji='🟠'; }
  else                      { appetiteLabel='NEUTRAL';  appetiteC='var(--text-dim)'; appetiteEmoji='⚪'; }

  return {
    spy, iwm, gld, slv, tlt, btc, eth, sol, tsx, uup, uso,
    smallCapLead, goldFlight, silverFlight, bondFlight, dxyRising,
    cryptoBeta, tsxVsSpy, stableRotate, havenConvergence,
    equityBleeding, cryptoBleeding, goldBleeding, allBleeding,
    appetiteLabel, appetiteC, appetiteEmoji,
  };
}

// ── Market regime — top-level label derived from all sectors + appetite ──
function calcMarketRegime(sectors, appetite) {
  if (!sectors || !sectors.length) return { regime:'NEUTRAL', emoji:'⚪', c:'var(--text-dim)', note:'No data', prediction:'' };

  const a = appetite || {};
  const allBleeding    = sectors.every(s => s.flowScore <= 0);
  const havenSector    = sectors.find(s => s.sector === 'HAVEN');
  const cryptoSector   = sectors.find(s => s.sector === 'CRYPTO');
  const techSector     = sectors.find(s => s.sector === 'TECH');
  const currencySector = sectors.find(s => s.sector === 'CURRENCY');
  const commSector     = sectors.find(s => s.sector === 'COMMODITIES');
  const havenInflow    = (havenSector?.flowScore ?? 0) > 0;
  const dxyRising      = (currencySector?.flowScore ?? 0) > 0 || a.dxyRising;

  // ── Scenario 1: LIQUIDITY EVENT — everything bleeding including haven ──
  if (allBleeding && !havenInflow && a.goldBleeding && a.cryptoBleeding) {
    return {
      regime:'LIQUIDITY EVENT', emoji:'⚠️', c:'#ff4455',
      note:'Forced selling across ALL assets · No safe haven bid · Check margin calls',
      prediction:'Expect sharp bounce once forced selling exhausts · Watch for BTC stabilisation first · Cash is king short-term',
      alert: true,
    };
  }

  // ── Scenario 2: CASH ROTATION — everything bleeding, DXY rising ──
  if (allBleeding && dxyRising) {
    return {
      regime:'CASH ROTATION', emoji:'🚨', c:'#ff4455',
      note:`Dollar bid ${a.uup >= 0 ? '+' : ''}${(a.uup||0).toFixed(1)}% · All risk assets under pressure`,
      prediction:'Capital parking in USD cash/T-bills · Watch DXY for reversal signal · Crypto typically lags equity recovery by 1–2 sessions',
      alert: true,
    };
  }

  // ── Scenario 3: FLIGHT TO SAFETY — equities + crypto bleeding, haven bid ──
  if (a.equityBleeding && a.cryptoBleeding && havenInflow) {
    const havenStr = [a.goldFlight && 'Gold', a.silverFlight && 'Silver', a.bondFlight && 'Bonds'].filter(Boolean).join(' + ');
    return {
      regime:'FLIGHT TO SAFETY', emoji:'🛡', c:'#ff8c00',
      note:`${havenStr || 'Haven assets'} bid · Risk assets bleeding · Defensive rotation active`,
      prediction:'Institutional de-risking in progress · Haven inflow typically precedes equity bottom by 1–3 sessions · Wait for gold to peak before re-entering risk',
      alert: false,
    };
  }

  // ── Scenario 4: HAVEN CONVERGENCE — gold + silver + bonds all bid ──
  if (a.havenConvergence && !allBleeding) {
    return {
      regime:'HAVEN CONVERGENCE', emoji:'🛡', c:'#ff8c00',
      note:'Gold + Silver + Bonds all bid simultaneously · Smart money hedging',
      prediction:'Hedging behaviour — not necessarily panic yet · Risk assets may hold short-term but downside risk building · Reduce position sizes',
      alert: false,
    };
  }

  // ── Scenario 5: STABLECOIN ROTATION — BTC bleeding, alts holding ──
  if (a.stableRotate) {
    return {
      regime:'BTC DOM DROP', emoji:'🔄', c:'var(--accent)',
      note:'BTC bleeding · ETH/SOL holding · BTC dominance rotating to alts',
      prediction:'Alt season signal · Capital staying within crypto but rotating from BTC → ETH/SOL/alts · Not an exit signal for crypto overall',
      alert: false,
    };
  }

  // ── Scenario 6: CRYPTO → HAVEN (crypto specific outflow) ──
  if ((cryptoSector?.flowScore ?? 0) <= -1 && havenInflow) {
    return {
      regime:'CRYPTO → HAVEN', emoji:'🛡', c:'#ff8c00',
      note:'Crypto outflow into gold/bonds · Defensive rotation',
      prediction:'Crypto likely to continue lower until haven inflow peaks · Watch gold price for reversal · ETH typically recovers before BTC in these rotations',
      alert: false,
    };
  }

  // ── Scenario 7: CRYPTO → TECH (within-risk rotation) ──
  if ((cryptoSector?.flowScore ?? 0) <= -1 && (techSector?.flowScore ?? 0) >= 1) {
    return {
      regime:'CRYPTO → TECH', emoji:'🔄', c:'#4da6ff',
      note:'Risk rotating from crypto into tech equities · Institutional preference shift',
      prediction:'Crypto may stabilise once tech rotation exhausts · Watch QQQ/NVDA for signs of topping · Crypto ETFs (ETHY/KILO) may lag pure equity recovery',
      alert: false,
    };
  }

  // ── Scenario 8: COMMODITY BID (inflation rotation) ──
  if ((commSector?.flowScore ?? 0) >= 1 && (a.uso || 0) > 1) {
    return {
      regime:'COMMODITY BID', emoji:'🛢', c:'#f5c518',
      note:'Oil + commodities bid · Inflation rotation or supply shock',
      prediction:'Energy equities (XEG.TO, XLE) typically follow oil with 1-session lag · TSX outperforms S&P in commodity bids · Crypto neutral to negative in inflation spikes',
      alert: false,
    };
  }

  // ── Scenario 9: Normal rotation — top sector → bottom sector ──
  const topIn  = sectors.find(s => s.flowScore >= 1 && s.sector !== 'HAVEN' && s.sector !== 'CURRENCY');
  const topOut = [...sectors].reverse().find(s => s.flowScore <= -1);
  if (topIn && topOut) {
    return {
      regime:`${topOut.sector} → ${topIn.sector}`, emoji:'💸', c:'var(--accent)',
      note:`Capital rotating from ${topOut.sector} into ${topIn.sector}`,
      prediction:`${topIn.sector} momentum likely to continue 1–2 sessions · ${topOut.sector} may find support once rotation exhausts · Watch velocity for acceleration`,
      alert: false,
    };
  }

  // ── Scenario 10: Broad risk on ──
  if (sectors.filter(s => s.flowScore >= 1).length >= 3) {
    return {
      regime:'BROAD RISK ON', emoji:'🟢', c:'var(--bull)',
      note:'Multiple sectors showing inflow · Risk appetite expanding',
      prediction:'Momentum environment · Breakout setups favoured · Reduce counter-trend bias · Crypto typically lags equity risk-on by 0.5–1 session',
      alert: false,
    };
  }

  return {
    regime:'NEUTRAL', emoji:'⚪', c:'var(--text-dim)',
    note:'No clear directional rotation detected',
    prediction:'Wait for sector divergence to develop · Watch IWM vs SPY and BTC vs ETH for first rotation signal',
    alert: false,
  };
}

// ── Main sector flow aggregation ──
// Merges STATE.DS (full scoring) + STATE.marketPulse (pulse layer).
// Sectors appear even with ZERO watchlist symbols — driven by pulse layer.
function calcSectorFlow(allDS) {
  const sectors = {};
  const now     = Date.now();
  const history = window._sectorFlowHistory;
  const mp      = (typeof STATE !== 'undefined' && STATE.marketPulse) ? STATE.marketPulse : {};

  // ── Helper: ensure sector bucket exists ──
  function ensureSector(key) {
    if (!sectors[key]) sectors[key] = {
      sector: key, syms:[], sentinels:[],
      riskOn:0, riskOff:0, rotateIn:0, rotateOut:0, neutral:0,
      totalWhale:0, totalChg:0, pulseChgs:[], count:0, pulseCount:0,
    };
    return sectors[key];
  }

  // ── Layer 1: STATE.DS — full scoring ──
  for (const [sym, d] of Object.entries(allDS || {})) {
    if (!d || !d.whaleScore) continue;
    const sectorKey = SENTINEL_MAP[sym]?.sector ?? sectorTagFor(sym);
    const s = ensureSector(sectorKey);
    if (SENTINEL_MAP[sym]) s.sentinels.push(SENTINEL_MAP[sym].label);
    else s.syms.push(sym.includes('BINANCE:') ? sym.split(':')[1].replace('USDT','') : sym.replace(/\.\w+$/,''));
    s.count++;
    s.totalWhale += d.whaleScore ?? 50;
    s.totalChg   += parseFloat(d.chg) || 0;
    const rf = calcRiskFlow(d, sym);
    if      (rf.risk === 'RISK ON')    s.riskOn++;
    else if (rf.risk === 'ROTATE IN')  s.rotateIn++;
    else if (rf.risk === 'ROTATE OUT') s.rotateOut++;
    else if (rf.risk === 'RISK OFF')   s.riskOff++;
    else                               s.neutral++;
  }

  // ── Layer 2: STATE.marketPulse — price-only pulse data ──
  // Adds coverage for Gold, Silver, Bonds, Oil, DXY, indices
  // even when those symbols are NOT in the watchlist.
  for (const [pulseKey, cfg] of Object.entries(PULSE_KEY_MAP)) {
    const pulseData = mp[pulseKey];
    if (!pulseData || pulseData.chg == null) continue;
    const chg = parseFloat(pulseData.chg) || 0;
    const s   = ensureSector(cfg.sector);

    // Only add if not already covered by DS layer for this symbol
    const alreadyInDS = (allDS || {})[cfg.sym] != null;
    if (!alreadyInDS) {
      s.pulseCount++;
      s.pulseChgs.push(chg);
      s.totalChg += chg;
      s.count++;
      if (!s.sentinels.includes(cfg.label)) s.sentinels.push(cfg.label + '●');

      // HAVEN and CURRENCY: inverted interpretation
      const prf = pulseRiskFlow(chg);
      let effectiveScore = prf.score;
      if (cfg.sector === 'HAVEN') {
        // Haven inflow = market fear = we keep score as-is for the haven tile
        // but flag it so regime detection knows
      }
      if (cfg.sector === 'CURRENCY') {
        // DXY rising = risk-off for everyone else — invert for currency tile display
        effectiveScore = -prf.score;
      }

      if      (effectiveScore >= 2)  s.riskOn++;
      else if (effectiveScore >= 1)  s.rotateIn++;
      else if (effectiveScore <= -2) s.riskOff++;
      else if (effectiveScore <= -1) s.rotateOut++;
      else                           s.neutral++;
    }
  }

  // ── Build final sector objects ──
  return Object.values(sectors).map(s => {
    const dsCount  = s.count - s.pulseCount;
    const avgWhale = dsCount > 0 ? Math.round(s.totalWhale / dsCount) : null;
    const avgChg   = parseFloat((s.totalChg / s.count).toFixed(2));

    // Flow score: weighted — DS symbols count double (richer signal)
    const flowScore = s.riskOn * 2 + s.rotateIn - s.rotateOut - s.riskOff * 2;

    // Coverage confidence: how many independent data points back this sector reading
    // Single symbol = LOW, 2-3 = MEDIUM, 4+ = HIGH
    const confidence = s.count >= 4 ? 'HIGH' : s.count >= 2 ? 'MED' : 'LOW';
    const confC = confidence === 'HIGH' ? 'var(--bull)' : confidence === 'MED' ? '#f5c518' : 'var(--text-dim)';

    // HAVEN special: inflow = defensive (amber not green)
    let flowLabel, flowC, flowEmoji;
    if (s.sector === 'HAVEN') {
      if      (flowScore >= 2)  { flowLabel='DEFENSIVE'; flowC='#ff8c00';          flowEmoji='🛡'; }
      else if (flowScore >= 1)  { flowLabel='HEDGING';   flowC='#ffa500';          flowEmoji='🛡'; }
      else if (flowScore <= -2) { flowLabel='UNWINDING'; flowC='var(--bull)';      flowEmoji='📈'; }
      else if (flowScore <= -1) { flowLabel='FADING';    flowC='#00cc8a';          flowEmoji='🔵'; }
      else                      { flowLabel='NEUTRAL';   flowC='var(--text-dim)'; flowEmoji='➡️'; }
    } else if (s.sector === 'CURRENCY') {
      if      (flowScore >= 2)  { flowLabel='DXY↑ RISK'; flowC='#ff4455';         flowEmoji='⚠️'; }
      else if (flowScore >= 1)  { flowLabel='DXY FIRM';  flowC='#ff8c00';          flowEmoji='🟠'; }
      else if (flowScore <= -2) { flowLabel='DXY↓ BULL'; flowC='var(--bull)';     flowEmoji='🟢'; }
      else if (flowScore <= -1) { flowLabel='DXY SOFT';  flowC='#00cc8a';          flowEmoji='🔵'; }
      else                      { flowLabel='DXY FLAT';  flowC='var(--text-dim)'; flowEmoji='➡️'; }
    } else {
      if      (flowScore >= 2)  { flowLabel='INFLOW';    flowC='var(--bull)';     flowEmoji='📈'; }
      else if (flowScore >= 1)  { flowLabel='BUILDING';  flowC='#00cc8a';          flowEmoji='🔵'; }
      else if (flowScore <= -2) { flowLabel='OUTFLOW';   flowC='var(--bear)';     flowEmoji='📉'; }
      else if (flowScore <= -1) { flowLabel='FADING';    flowC='#ff8c00';          flowEmoji='🟠'; }
      else                      { flowLabel='NEUTRAL';   flowC='var(--text-dim)'; flowEmoji='➡️'; }
    }

    // ── Velocity: 15-min flow delta ──
    if (!history[s.sector]) history[s.sector] = [];
    history[s.sector].push({ t:now, score:flowScore });
    history[s.sector] = history[s.sector].filter(e => now - e.t < 30 * 60 * 1000);
    const old15 = history[s.sector].find(e => now - e.t >= 14 * 60 * 1000);
    const flowVelocity = old15 ? flowScore - old15.score : 0;
    const velArrow = flowVelocity >= 2 ? '↑↑' : flowVelocity === 1 ? '↑' :
                     flowVelocity <= -2 ? '↓↓' : flowVelocity === -1 ? '↓' : '';
    const velC = flowVelocity > 0 ? 'var(--bull)' : flowVelocity < 0 ? 'var(--bear)' : 'var(--text-dim)';

    return {
      ...s, avgWhale, avgChg, flowScore, confidence, confC,
      flowVelocity, velArrow, velC,
      flowLabel, flowC, flowEmoji,
      isPulseOnly: dsCount === 0,
    };
  }).sort((a, b) => b.flowScore - a.flowScore);
}
