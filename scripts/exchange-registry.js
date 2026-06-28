// ══════════════════════════════════════════════════════════════════════════════
// exchange-registry.js — v1.0
// Single source of truth for exchange metadata used by the headless pipeline.
//
// Covers:
//   BINANCE  — crypto, 24/7
//   TSX      — Toronto Stock Exchange (.TO)
//   NYSE     — New York Stock Exchange / NASDAQ (no suffix, or .NYSE)
//   LSE      — London Stock Exchange (.L)
//   XETRA    — Frankfurt / Deutsche Börse (.DE)
//   TSE      — Tokyo Stock Exchange (.T)
//   HKEX     — Hong Kong Exchange (.HK)
//   NSE      — National Stock Exchange India (.NS)
//
// Each exchange entry defines:
//   suffixes     — symbol suffixes used for auto-detection
//   tz           — IANA timezone for session times
//   currency     — ISO 4217 currency code (informational)
//   sessions     — named session windows { open: 'HH:MM', close: 'HH:MM' }
//                  null = session does not exist for this exchange
//   providers    — ordered list of data sources to try
//                  'yahoo'  = Yahoo Finance v8 chart API (needs crumb/cookie)
//                  'stooq'  = stooq.com CSV (free, no auth, 15-min delay)
//   stooqSuffix  — suffix to append when building Stooq symbol (lowercase)
//
// getMarketSession(sym) returns one of:
//   '24/7'        — crypto, always tradeable
//   'open'        — regular session is live
//   'pre_market'  — US pre-market (04:00–09:30 ET)
//   'after_hours' — US AH (16:00–20:00 ET)
//   'lunch_break' — TSE / HKEX midday pause
//   'closed'      — weekend or outside all sessions
// ══════════════════════════════════════════════════════════════════════════════

export const EXCHANGES = {
  BINANCE: {
    name:        'Binance',
    suffixes:    [],           // detected by 'BINANCE:' prefix, not suffix
    tz:          'UTC',
    currency:    'USD',
    sessions:    { regular: null }, // null = 24/7
    providers:   { price: ['binance'], extras: ['binance'] },
    stooqSuffix: null,
  },
  TSX: {
    name:        'Toronto Stock Exchange',
    suffixes:    ['.TO'],
    tz:          'America/New_York',  // TSX trades in ET
    currency:    'CAD',
    sessions: {
      regular:     { open: '09:30', close: '16:00' },
      pre_market:  null,
      after_hours: null,              // TSX has no AH session
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.to',
  },
  NYSE: {
    name:        'NYSE / NASDAQ',
    suffixes:    [],                  // detected by absence of any known suffix
    tz:          'America/New_York',
    currency:    'USD',
    sessions: {
      pre_market:  { open: '04:00', close: '09:30' },
      regular:     { open: '09:30', close: '16:00' },
      after_hours: { open: '16:00', close: '20:00' },
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.us',
  },
  LSE: {
    name:        'London Stock Exchange',
    suffixes:    ['.L'],
    tz:          'Europe/London',
    currency:    'GBP',
    sessions: {
      regular:     { open: '08:00', close: '16:30' },
      pre_market:  null,
      after_hours: null,
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.uk',
  },
  XETRA: {
    name:        'XETRA / Frankfurt',
    suffixes:    ['.DE'],
    tz:          'Europe/Berlin',
    currency:    'EUR',
    sessions: {
      regular:     { open: '09:00', close: '17:30' },
      pre_market:  null,
      after_hours: null,
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.de',
  },
  TSE: {
    name:        'Tokyo Stock Exchange',
    suffixes:    ['.T'],
    tz:          'Asia/Tokyo',
    currency:    'JPY',
    sessions: {
      morning:     { open: '09:00', close: '11:30' },
      afternoon:   { open: '12:30', close: '15:30' },
      pre_market:  null,
      after_hours: null,
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.jp',
  },
  HKEX: {
    name:        'Hong Kong Exchange',
    suffixes:    ['.HK'],
    tz:          'Asia/Hong_Kong',
    currency:    'HKD',
    sessions: {
      morning:     { open: '09:30', close: '12:00' },
      afternoon:   { open: '13:00', close: '16:00' },
      pre_market:  null,
      after_hours: null,
    },
    providers:   { price: ['yahoo', 'stooq'], extras: ['yahoo'] },
    stooqSuffix: '.hk',
  },
  NSE: {
    name:        'National Stock Exchange of India',
    suffixes:    ['.NS'],
    tz:          'Asia/Kolkata',
    currency:    'INR',
    sessions: {
      regular:     { open: '09:15', close: '15:30' },
      pre_market:  null,
      after_hours: null,
    },
    providers:   { price: ['yahoo'], extras: ['yahoo'] }, // Stooq coverage patchy for NSE
    stooqSuffix: null,
  },
};

// ── Resolve exchange from symbol string ──────────────────────────────────────
// Returns the exchange object or null if unrecognised.
export function resolveExchange(sym) {
  // Crypto: BINANCE:BTCUSDT or bare BTCUSDT (no dot, no known suffix)
  if (sym.startsWith('BINANCE:') || (!sym.includes('.') && !sym.includes(':'))) {
    return EXCHANGES.BINANCE;
  }

  // Strip any exchange prefix (e.g. TSX:ETHY.TO → ETHY.TO)
  const bare = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;

  // Match by suffix — longest match first to avoid .T matching .TO
  const byLength = Object.values(EXCHANGES)
    .filter(ex => ex.suffixes && ex.suffixes.length > 0)
    .sort((a, b) => (b.suffixes[0]?.length ?? 0) - (a.suffixes[0]?.length ?? 0));

  for (const ex of byLength) {
    if (ex.suffixes.some(s => bare.toUpperCase().endsWith(s.toUpperCase()))) return ex;
  }

  // No suffix matched — assume US listing
  return EXCHANGES.NYSE;
}

// ── Get current market session for a symbol ──────────────────────────────────
// Returns: '24/7' | 'open' | 'pre_market' | 'after_hours' | 'lunch_break' | 'closed'
export function getMarketSession(sym) {
  const ex = resolveExchange(sym);
  if (!ex) return 'closed';

  // Crypto: always open
  if (ex.sessions.regular === null) return '24/7';

  const now  = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: ex.tz }));
  const dow   = local.getDay(); // 0=Sun 6=Sat

  if (dow === 0 || dow === 6) return 'closed';

  const mins = local.getHours() * 60 + local.getMinutes();

  function toMins(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function inWindow(session) {
    if (!session) return false;
    return mins >= toMins(session.open) && mins < toMins(session.close);
  }

  const s = ex.sessions;

  // Regular / split sessions
  if (inWindow(s.regular))   return 'open';
  if (inWindow(s.morning))   return 'open';
  if (inWindow(s.afternoon)) return 'open';

  // Extended sessions (US only currently)
  if (inWindow(s.pre_market))  return 'pre_market';
  if (inWindow(s.after_hours)) return 'after_hours';

  // Lunch break — between morning close and afternoon open
  if (s.morning && s.afternoon) {
    if (mins >= toMins(s.morning.close) && mins < toMins(s.afternoon.open)) {
      return 'lunch_break';
    }
  }

  return 'closed';
}

// ── Build TradingView-style sym key ─────────────────────────────────────────
// e.g. BINANCE:BTCUSDT, TSX:ETHY.TO, LSE:VOD.L
export function buildSymKey(sym) {
  if (sym.includes(':')) return sym; // already prefixed
  const ex = resolveExchange(sym);
  if (!ex || ex === EXCHANGES.BINANCE) {
    // bare crypto pair — add BINANCE: prefix
    return sym.startsWith('BINANCE:') ? sym : `BINANCE:${sym}`;
  }
  const prefix = Object.entries(EXCHANGES).find(([, v]) => v === ex)?.[0] ?? 'NYSE';
  return `${prefix}:${sym}`;
}

// ── Date-keyed cooldown helpers ───────────────────────────────────────────────
// Crypto: time-based key (expires after LB_COOLDOWN_MIN)
// Stocks: date-keyed (resets at midnight local exchange time → one alert per trading day)
export function cooldownKey(sym, assetType) {
  if (assetType === 'crypto') return `lb_buy_${sym}`;
  const ex = resolveExchange(sym);
  const tz = ex?.tz || 'America/New_York';
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const date  = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
  return `lb_buy_${sym}_${date}`;
}

// ── Stooq symbol conversion ───────────────────────────────────────────────────
// Yahoo: ETHY.TO → Stooq: ethy.to
// Yahoo: VOD.L   → Stooq: vod.uk
// Yahoo: SIE.DE  → Stooq: sie.de
// Yahoo: 7203.T  → Stooq: 7203.jp
export function toStooqSymbol(sym) {
  const bare = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
  const ex   = resolveExchange(sym);
  if (!ex || !ex.stooqSuffix) return null;

  // Remove Yahoo suffix and replace with Stooq suffix
  let base = bare;
  for (const s of (ex.suffixes || [])) {
    if (base.toUpperCase().endsWith(s.toUpperCase())) {
      base = base.slice(0, base.length - s.length);
      break;
    }
  }
  return (base + ex.stooqSuffix).toLowerCase();
}
