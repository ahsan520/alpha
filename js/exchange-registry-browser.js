// ══════════════════════════════════════════════════════════════════════════════
// exchange-registry-browser.js — v1.0
// Browser-side version of exchange-registry.js (no ESM imports — plain JS).
// Loaded as a <script> before app.js / api.js / watchlist-manager.js.
//
// Exports (globals):
//   EXCHANGES                  — exchange config map
//   resolveExchange(sym)       — returns exchange object
//   getMarketSession(sym)      — '24/7'|'open'|'pre_market'|'after_hours'|'lunch_break'|'closed'
//   buildTVSymbol(sym)         — TradingView symbol string (e.g. TSX:ETHY, LSE:VOD)
//   exchangeCurrency(sym)      — ISO currency for display (CAD, USD, GBP …)
//   exchangeName(sym)          — human-readable exchange name
// ══════════════════════════════════════════════════════════════════════════════

const EXCHANGES = {
  BINANCE: {
    name: 'Binance', suffixes: [], tz: 'UTC', currency: 'USD',
    sessions: { regular: null }, // null = 24/7
  },
  TSX: {
    name: 'Toronto Stock Exchange', suffixes: ['.TO'],
    tz: 'America/New_York', currency: 'CAD',
    sessions: {
      regular:     { open: '09:30', close: '16:00' },
      pre_market:  null,
      after_hours: null,
    },
  },
  NYSE: {
    name: 'NYSE / NASDAQ', suffixes: [],
    tz: 'America/New_York', currency: 'USD',
    sessions: {
      pre_market:  { open: '04:00', close: '09:30' },
      regular:     { open: '09:30', close: '16:00' },
      after_hours: { open: '16:00', close: '20:00' },
    },
  },
  LSE: {
    name: 'London Stock Exchange', suffixes: ['.L'],
    tz: 'Europe/London', currency: 'GBP',
    sessions: { regular: { open: '08:00', close: '16:30' }, pre_market: null, after_hours: null },
  },
  XETRA: {
    name: 'XETRA / Frankfurt', suffixes: ['.DE'],
    tz: 'Europe/Berlin', currency: 'EUR',
    sessions: { regular: { open: '09:00', close: '17:30' }, pre_market: null, after_hours: null },
  },
  TSE: {
    name: 'Tokyo Stock Exchange', suffixes: ['.T'],
    tz: 'Asia/Tokyo', currency: 'JPY',
    sessions: {
      morning:   { open: '09:00', close: '11:30' },
      afternoon: { open: '12:30', close: '15:30' },
      pre_market: null, after_hours: null,
    },
  },
  HKEX: {
    name: 'Hong Kong Exchange', suffixes: ['.HK'],
    tz: 'Asia/Hong_Kong', currency: 'HKD',
    sessions: {
      morning:   { open: '09:30', close: '12:00' },
      afternoon: { open: '13:00', close: '16:00' },
      pre_market: null, after_hours: null,
    },
  },
  NSE: {
    name: 'NSE India', suffixes: ['.NS'],
    tz: 'Asia/Kolkata', currency: 'INR',
    sessions: { regular: { open: '09:15', close: '15:30' }, pre_market: null, after_hours: null },
  },
};

// ── Resolve exchange from symbol ──────────────────────────────────────────────
function resolveExchange(sym) {
  if (!sym) return EXCHANGES.NYSE;
  if (sym.startsWith('BINANCE:') || (!sym.includes('.') && !sym.includes(':'))) {
    return EXCHANGES.BINANCE;
  }
  const bare = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
  // longest suffix first so .TO doesn't accidentally match .T
  const sorted = Object.values(EXCHANGES)
    .filter(ex => ex.suffixes && ex.suffixes.length)
    .sort((a, b) => (b.suffixes[0]?.length ?? 0) - (a.suffixes[0]?.length ?? 0));
  for (const ex of sorted) {
    if (ex.suffixes.some(s => bare.toUpperCase().endsWith(s.toUpperCase()))) return ex;
  }
  return EXCHANGES.NYSE; // bare US symbol
}

// ── Market session ────────────────────────────────────────────────────────────
// Returns: '24/7' | 'open' | 'pre_market' | 'after_hours' | 'lunch_break' | 'closed'
function getMarketSession(sym) {
  const ex = resolveExchange(sym);
  if (ex.sessions.regular === null) return '24/7';

  const now   = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: ex.tz }));
  const dow   = local.getDay(); // 0=Sun 6=Sat
  if (dow === 0 || dow === 6) return 'closed';

  const mins = local.getHours() * 60 + local.getMinutes();
  const toM  = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const inW  = s => s && mins >= toM(s.open) && mins < toM(s.close);

  const s = ex.sessions;
  if (inW(s.regular))    return 'open';
  if (inW(s.morning))    return 'open';
  if (inW(s.afternoon))  return 'open';
  if (inW(s.pre_market)) return 'pre_market';
  if (inW(s.after_hours)) return 'after_hours';
  if (s.morning && s.afternoon) {
    if (mins >= toM(s.morning.close) && mins < toM(s.afternoon.open)) return 'lunch_break';
  }
  return 'closed';
}

// ── TradingView symbol builder ────────────────────────────────────────────────
// BINANCE:BTCUSDT → 'BINANCE:BTCUSDT' (already correct for TV)
// ETHY.TO         → 'TSX:ETHY'        (TV uses exchange:ticker without suffix)
// VOD.L           → 'LSE:VOD'
// SIE.DE          → 'XETRA:SIE'
// 7203.T          → 'TSE:7203'
// GE (bare US)    → 'NYSE:GE'
function buildTVSymbol(sym) {
  if (!sym) return sym;
  if (sym.includes('BINANCE:')) return sym; // already formatted

  const ex     = resolveExchange(sym);
  const exKey  = Object.entries(EXCHANGES).find(([, v]) => v === ex)?.[0] ?? 'NYSE';
  let bare     = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;

  // Strip Yahoo-style suffix (.TO, .L, .DE, .T, .HK, .NS)
  for (const s of (ex.suffixes || [])) {
    if (bare.toUpperCase().endsWith(s.toUpperCase())) {
      bare = bare.slice(0, bare.length - s.length);
      break;
    }
  }
  return `${exKey}:${bare}`;
}

// ── Convenience helpers ───────────────────────────────────────────────────────
function exchangeCurrency(sym) { return resolveExchange(sym)?.currency ?? 'USD'; }
function exchangeName(sym)     { return resolveExchange(sym)?.name ?? 'Unknown'; }

// ── marketStatus() compatibility shim ────────────────────────────────────────
// Replaces the hardcoded marketStatus() in app.js with registry-backed version.
// Returns 'open' | 'prepost' | 'closed' — same tokens app.js already uses.
function marketStatus(sym) {
  const session = getMarketSession(sym);
  if (session === '24/7' || session === 'open') return 'open';
  if (session === 'pre_market' || session === 'after_hours') return 'prepost';
  return 'closed'; // closed | lunch_break
}
