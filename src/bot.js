// src/bot.js — PRO orchestrator: ingest -> enrich -> find -> quote -> rank -> execute.
import { PoolStore } from './pool/store.js';
import { fetchMeteoraDlmm } from './pool/ingestors/meteoraDlmm.js';
import { fetchMeteoraDamm } from './pool/ingestors/meteoraDamm.js';
import { fetchRaydium } from './pool/ingestors/raydium.js';
import { fetchOrca } from './pool/ingestors/orca.js';
import { findOpportunities } from './path/finder.js';
import { fetchJupiterPrices, quoteSameTokenArb, VENUE_TO_JUP } from './quote/quoter.js';
import { initExecutor, executeSameTokenArb } from './executor/jupiter.js';
import {
  MODE, TRADE_AMOUNT_SOL, MIN_TVL, MIN_MISPRICING, MIN_PROFIT_PCT, SLIPPAGE_PCT,
  SCAN_INTERVAL_MS, WSOL_MINT, QUOTE_MINTS, rpcEndpoints, WALLET_PRIVATE_KEY,
  log, warn, dbg
} from './config.js';

const store = new PoolStore();

async function enrichUsdPrices() {
  const mints = [...store.byMint.keys()];
  const prices = await fetchJupiterPrices(mints.slice(0, 400));
  let enriched = 0;
  for (const p of store.getAll()) {
    if (p.mintA && prices[p.mintA]) { p.priceUsdA = prices[p.mintA]; enriched++; }
    if (p.mintB && prices[p.mintB]) { p.priceUsdB = prices[p.mintB]; }
  }
  dbg(`enriched ${enriched}/${store.getAll().length} pools with Jupiter USD`);
  return prices;
}

async function ingestAll() {
  store.clear();
  const [dlmm, damm, ray, orca] = await Promise.all([
    fetchMeteoraDlmm({ minTvl: MIN_TVL }).catch(() => []),
    fetchMeteoraDamm({ minTvl: MIN_TVL }).catch(() => []),
    fetchRaydium({ minTvl: MIN_TVL }).catch(() => []),
    fetchOrca({ minTvl: MIN_TVL }).catch(() => [])
  ]);
  store.addMany([...dlmm, ...damm, ...ray, ...orca]);
  return store.stats();
}

async function cycle() {
  const stats = await ingestAll();
  log(`\n🔄 PRO cycle | MODE=${MODE} | minTVL=$${MIN_TVL} minSpread=${MIN_MISPRICING}%`);
  log(`   [ingest] ${JSON.stringify(stats)}`);

  const prices = await enrichUsdPrices();
  const opps = findOpportunities(store, prices, {
    minSpreadPct: MIN_MISPRICING, minTvl: MIN_TVL, quoteMints: QUOTE_MINTS
  });
  log(`   [scan] ${opps.length} same-token opportunities`);

  const ranked = [];
  for (const opp of opps.slice(0, 15)) { // limit quotes to avoid rate limit
    try {
      const q = await quoteSameTokenArb({
        tokenMint: opp.tokenMint,
        buyVenue: opp.buyPool.venue,
        sellVenue: opp.sellPool.venue,
        amountLamports: BigInt(Math.floor(TRADE_AMOUNT_SOL * 1e9)),
        slippageBps: Math.round(SLIPPAGE_PCT * 100)
      });
      if (q.netPct >= MIN_PROFIT_PCT) ranked.push({ ...opp, quote: q });
    } catch (e) {
      dbg(`quote failed ${opp.tokenMint.slice(0,6)}: ${e.message}`);
    }
  }
  ranked.sort((a, b) => b.quote.netPct - a.quote.netPct);

  for (const r of ranked.slice(0, 3)) {
    log(`   ✅ ${r.symbol} | ${r.buyPool.venue}→${r.sellPool.venue} | spread ${r.spreadPct.toFixed(2)}% | net ${r.quote.netPct.toFixed(2)}% (${r.quote.netSol.toFixed(5)} SOL)`);
    if (MODE === 'live') {
      try {
        const res = await executeSameTokenArb({
          tokenMint: r.tokenMint, buyVenue: r.buyPool.venue, sellVenue: r.sellPool.venue,
          startLamports: BigInt(Math.floor(TRADE_AMOUNT_SOL * 1e9)), slippageBps: Math.round(SLIPPAGE_PCT * 100)
        });
        log(`      📨 executed: ${res.sigs.join(' , ')}${res.salvaged ? ' (salvaged)' : ''}`);
        for (const s of res.sigs) log(`      https://solscan.io/tx/${s}`);
      } catch (e) {
        warn(`      execute failed: ${e.message}`);
      }
    }
  }
}

export async function runPro() {
  if (MODE === 'live') {
    if (!WALLET_PRIVATE_KEY) { warn('LIVE mode needs WALLET_PRIVATE_KEY — exiting.'); process.exit(1); }
    const { Connection, Keypair } = await import('@solana/web3.js');
    const eps = rpcEndpoints();
    if (!eps.length) { warn('LIVE mode needs RPC_URLS — exiting.'); process.exit(1); }
    const conn = new Connection(eps[0], { commitment: 'confirmed' });
    let secret;
    try { secret = Uint8Array.from(JSON.parse(Buffer.from(WALLET_PRIVATE_KEY, 'base64').toString('utf8'))); }
    catch { try { const bs58 = (await import('bs58')).default; secret = bs58.decode(WALLET_PRIVATE_KEY); } catch { warn('WALLET_PRIVATE_KEY unparseable'); process.exit(1); } }
    const wallet = Keypair.fromSecretKey(secret);
    initExecutor(conn, wallet);
  }
  await cycle();
  if (MODE !== 'live') return; // dry-run: single pass
  setInterval(cycle, SCAN_INTERVAL_MS);
}
