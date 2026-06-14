// ══════════════════════════════════════════════
// config.js — constants, shared state, CoinGecko ID map
// ══════════════════════════════════════════════

const APP_VERSION = 'v12.9.5';

// ── SHARED STATE ──
window.STATE = {
  watchlist: [],
  // DS and PH are intentionally left empty here.
  // They are populated in init() after the watchlist is resolved,
  // filtered to only symbols in this tab's watchlist.json — this prevents
  // stale symbols from other open tabs bleeding in via localStorage.
  DS: {},
  PH: {},
  cgCache: JSON.parse(localStorage.getItem('a49_cgc') || '{}'),
  trades: JSON.parse(localStorage.getItem('a49_trades') || '[]'),
  alertCfg: {}, // initialized by alerts.js initAlertCfg()
  currentS: '',
  tvW: null,
  sortK: 'chg',
  sortD: -1,
  alertLog: [],
  newsItems: [],
  newsOpen: true,   // news panel open by default
  wlOpen: false,   // watchlist sidebar starts collapsed on mobile
  alertsOpen: false,  // alert strip hidden by default
  activeNewsTag: 'ALL', // active news sector filter
  newsCache: {},        // per-tag cache; used as fallback when a feed fails
  marketPulse: {},      // latest market pulse tile data keyed by symbol (SPY, BTC, etc.)
};

// ── COINGECKO ID MAP ──
window.CG = {
  'BTCUSDT':'bitcoin','ETHUSDT':'ethereum','SOLUSDT':'solana','BNBUSDT':'binancecoin',
  'XRPUSDT':'ripple','ADAUSDT':'cardano','DOTUSDT':'polkadot','AVAXUSDT':'avalanche-2',
  'ATOMUSDT':'cosmos','NEARUSDT':'near','APTUSDT':'aptos','SUIUSDT':'sui',
  'TONUSDT':'the-open-network','ALGOUSDT':'algorand','ICPUSDT':'internet-computer',
  'FTMUSDT':'fantom','INJUSDT':'injective-protocol','SEIUSDT':'sei-network',
  'TIAUSDT':'celestia','TAOUSDT':'bittensor',
  'MATICUSDT':'matic-network','ARBUSDT':'arbitrum','OPUSDT':'optimism','STRKUSDT':'starknet',
  'UNIUSDT':'uniswap','LINKUSDT':'chainlink','AAVEUSDT':'aave','MKRUSDT':'maker',
  'CRVUSDT':'curve-dao-token','SNXUSDT':'havven','COMPUSDT':'compound-governance-token',
  'LDOUSDT':'lido-dao','JUPUSDT':'jupiter-exchange-solana','RAYUSDT':'raydium',
  'DOGEUSDT':'dogecoin','SHIBUSDT':'shiba-inu','PEPEUSDT':'pepe',
  'WIFUSDT':'dogwifcoin','BONKUSDT':'bonk','FLOKIUSDT':'floki',
  'POPCATUSDT':'popcat','MOODENGUSDT':'moo-deng',
  'RENDERUSDT':'render-token','RNDRUSDT':'render-token',
  'FETUSDT':'fetch-ai','AGIXUSDT':'singularitynet','OCEANUSDT':'ocean-protocol',
  'AKTUSDT':'akash-network','IOTAUSDT':'iota',
  'XMRUSDT':'monero','ZECUSDT':'zcash','DASHUSDT':'dash','SCRTUSDT':'secret',
  'OKBUSDT':'okb','GRTUSDT':'the-graph','FILUSDT':'filecoin','ARUSDT':'arweave',
  'SANDUSDT':'the-sandbox','MANAUSDT':'decentraland','AXSUSDT':'axie-infinity',
  'IMXUSDT':'immutable-x','GALAUSDT':'gala','ENJUSDT':'enjincoin',
  'LTCUSDT':'litecoin','BCHUSDT':'bitcoin-cash','ETCUSDT':'ethereum-classic',
  'XLMUSDT':'stellar','VETUSDT':'vechain','HBARUSDT':'hedera-hashgraph',
  'QNTUSDT':'quant-network','FLOWUSDT':'flow','THETAUSDT':'theta-token',
  'XTZUSDT':'tezos','EOSUSDT':'eos','TRXUSDT':'tron','KSMUSDT':'kusama',
  'RUNEUSDT':'thorchain','CAKEUSDT':'pancakeswap-token','GMXUSDT':'gmx',
  'DYDXUSDT':'dydx','BLURUSDT':'blur','WBTCUSDT':'wrapped-bitcoin',
  'STETHUSDT':'staked-ether','AXLUSDT':'axelar',
};

// Pairs delisted from Binance — routed directly to CoinGecko
// XMR was delisted by Binance in Feb 2024 due to regulatory pressure
window.BINANCE_DELISTED = new Set(['XMRUSDT']);

function defWL() {
  return ['BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT','XEG.TO','KILO.TO'];
}
