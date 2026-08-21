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

process.on('unhandledRejection', e => { console.error('[unhandledRejection]', e?.message || e); });
process.on('uncaughtException', e => { console.error('[uncaughtException]', e?.message || e); });

const store = new PoolStore();

async function timed(label, fn) {
  const t0 = Date.now();
  const r = await fn();
  dbg(`${label} took ${Date.now() - t0}ms`);
  return r;
}

async function enrichUsdPrices() {
  const mints = [...store.byMint.keys()];
  const prices = await fetchJupiterPrices(mints.slice(0, 400));
  let enriched = 0;
  // Primary: Jupiter USD (if reachable).
  for (const p of store.getAll()) {
    if (p.mintA && prices[p.mintA]) { p.priceUsdA = prices[p.mintA]; enriched++; }
    if (p.mintB && prices[p.mintB]) { p.priceUsdB = prices[p.mintB]; }
  }
  // Fallback: derive USD from pools quoted in USDC/USDT (ratio * 1 USD) when Jupiter unreachable.
  if (enriched === 0) {
    for (const p of store.getAll()) {
      const isUsdc = (m) => m === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || m === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      if (p.mintA && isUsdc(p.mintB) && p.price > 0) { p.priceUsdA = p.price; enriched++; }
      if (p.mintB && isUsdc(p.mintA) && p.price > 0) { p.priceUsdB = p.price; }
    }
    dbg('Jupiter unreachable — derived USD from USDC/USDT-quoted pools');
  }
  dbg(`enriched ${enriched}/${store.getAll().length} pools with USD`);
  return prices;
}

async function ingestAll() {
  store.clear();
  const [dlmm, damm, ray, orca] = await Promise.all([
    timed('meteora-dlmm', () => fetchMeteoraDlmm({ minTvl: MIN_TVL }).catch(e => { warn('dlmm ingest failed:', e.message); return []; })),
    timed('meteora-damm', () => fetchMeteoraDamm({ minTvl: MIN_TVL }).catch(e => { warn('damm ingest failed:', e.message); return []; })),
    timed('raydium', () => fetchRaydium({ minTvl: MIN_TVL }).catch(e => { warn('raydium ingest failed:', e.message); return []; })),
    timed('orca', () => fetchOrca({ minTvl: MIN_TVL }).catch(e => { warn('orca ingest failed:', e.message); return []; }))
  ]);
  store.addMany([...dlmm, ...damm, ...ray, ...orca]);
  log(`   [ingest-detail] dlmm=${dlmm.length} damm=${damm.length} ray=${ray.length} orca=${orca.length}`);
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
