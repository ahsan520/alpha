// Standalone test — verifies fapi.binance.com (futures API) is reachable
// from THIS runner, isolated from the rest of the pipeline.
//
// Run manually via the "Test FAPI Reachability" workflow (workflow_dispatch)
// or locally: node scripts/test-fapi.js

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

async function testSymbol(sym) {
  const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`;
  console.log(`\n→ Testing ${sym}`);
  console.log(`  URL: ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = JSON.parse(body);
      console.log(`  ✅ SUCCESS — lastFundingRate: ${data.lastFundingRate}`);
    } else {
      console.log(`  ❌ FAILED — body: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  ❌ THREW — ${e.message}`);
  }
}

async function main() {
  console.log('════════════════════════════════════════');
  console.log('  fapi.binance.com reachability test');
  console.log('════════════════════════════════════════');
  for (const sym of SYMBOLS) {
    await testSymbol(sym);
  }
  console.log('\n════════════════════════════════════════');
  console.log('If all 3 show ✅ SUCCESS, the host-routing fix is confirmed working.');
  console.log('If all 3 show 403/451, fapi.binance.com is geo-blocked on this runner');
  console.log('the same way api.binance.com was for spot — same class of problem,');
  console.log('different host. In that case, switch fetchFundingRate/premiumIndex');
  console.log('calls to Bybit or OKX public funding-rate endpoints instead.');
  console.log('════════════════════════════════════════');
}

main();
