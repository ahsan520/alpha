// ══════════════════════════════════════════════
// config.js — constants, shared state, CoinGecko ID map
// ══════════════════════════════════════════════

const APP_VERSION = 'v49.2';

// ── SHARED STATE ──
window.STATE = {
  watchlist: [],
  DS: JSON.parse(localStorage.getItem('a49_ds') || '{}'),
  PH: JSON.parse(localStorage.getItem('a49_ph') || '{}'),
  cgCache: JSON.parse(localStorage.getItem('a49_cgc') || '{}'),
  trades: JSON.parse(localStorage.getItem('a49_trades') || '[]'),
  alertCfg: JSON.parse(localStorage.getItem('a49_alertcfg') || JSON.stringify({
    email: { enabled: false, address: '', emailjsServiceId: '', emailjsTemplateId: '', emailjsPublicKey: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    rules: [
      { id: 'vol_bull_4h', label: 'Vol Shock > 1.5 × AND 4H Bias = Bullish', enabled: true, channels: ['email', 'telegram'] },
      { id: 'strong_buy', label: 'Signal = STRONG BUY', enabled: true, channels: ['email', 'telegram'] },
      { id: 'strong_sell', label: 'Signal = STRONG SELL', enabled: true, channels: ['email', 'telegram'] },
    ]
  })),
  currentS: '',
  tvW: null,
  sortK: 'chg',
  sortD: -1,
  alertLog: [],
  newsItems: [],
  newsOpen: true,
  alertsOpen: false,
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

function defWL() {
  return ['BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT','XEG.TO','KILO.TO'];
}
