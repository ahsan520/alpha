// Standalone test — verifies Bybit's public tickers endpoint (funding
// rate + open interest) is reachable from THIS runner.
//
// fapi.binance.com was confirmed 451-blocked on GitHub runners on
// 2026-07-23 — this replaces that dependency with Bybit, which is not
// subject to the same US-datacenter restriction (as of this writing).
//
// Run manually via the "Test Bybit Reachability" workflow (workflow_dispatch)
// or locally: node scripts/test-bybit.js

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

async function testSymbol(sym) {
  const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`;
  console.log(`\n→ Testing ${sym}`);
  console.log(`  URL: ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = JSON.parse(body);
      const row = data?.result?.list?.[0];
      if (row) {
        console.log(`  ✅ SUCCESS — fundingRate: ${row.fundingRate}  openInterest: ${row.openInterest}`);
      } else {
        console.log(`  ⚠ 200 OK but no ticker row in response: ${body.slice(0, 300)}`);
      }
    } else {
      console.log(`  ❌ FAILED — body: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  ❌ THREW — ${e.message}`);
  }
}

async function main() {
  console.log('════════════════════════════════════════');
  console.log('  Bybit reachability test (funding rate + OI)');
  console.log('════════════════════════════════════════');
  for (const sym of SYMBOLS) {
    await testSymbol(sym);
  }
  console.log('\n════════════════════════════════════════');
  console.log('If all 3 show ✅ SUCCESS, the Bybit fallback is confirmed working');
  console.log('and alert-runner.js will get real funding-rate data again.');
  console.log('If any show 403/451, Bybit is blocked on this runner too —');
  console.log('OKX (api/v5/public/funding-rate) would be the next fallback to try.');
  console.log('════════════════════════════════════════');
}

main();
