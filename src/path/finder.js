// src/path/finder.js — opportunity detection over the PoolStore.
//
// Strategy 1 (implemented): SAME-TOKEN cross-venue.
//   A token priced differently across pools/venues. Buy on the cheaper pool,
//   sell on the pricier pool. Works across Raydium/Orca/Meteora (any venue).
//
// Strategy 2 (stub): generic 2-hop / triangular via quote token — add after S1 stable.

/**
 * @param {import('../pool/store.js').PoolStore} store
 * @param {Object<string,number>} jupiterPrices  mint -> USD price
 * @param {object} [opts]
 * @returns {Array} opportunities sorted by spread desc
 */
export function findOpportunities(store, jupiterPrices, {
  minSpreadPct = 0.5,
  minTvl = 100,
  quoteMints = new Set(),
  maxCandidates = 50
} = {}) {
  const results = [];

  // --- 1) Same-token cross-pool / cross-venue ---
  for (const [mint, addrs] of store.byMint) {
    if (quoteMints.has(mint)) continue;

    const pools = [...addrs]
      .map(a => store.byAddress.get(a))
      .filter(p => p && p.tvlUsd >= minTvl);

    if (pools.length < 2) continue; // need at least 2 pools to arbitrage

    // Enrich USD price: prefer Meteora normalized priceUsdA, else Jupiter.
    const withPrice = pools.map(p => {
      const usd = p.priceUsdA || jupiterPrices[p.mintA] || jupiterPrices[mint] || 0;
      return { pool: p, usd };
    }).filter(x => x.usd > 0);

    if (withPrice.length < 2) continue;

    withPrice.sort((a, b) => a.usd - b.usd);
    const cheap = withPrice[0];
    const expensive = withPrice[withPrice.length - 1];
    const spreadPct = ((expensive.usd - cheap.usd) / cheap.usd) * 100;

    if (spreadPct >= minSpreadPct && spreadPct <= 1000) {
      results.push({
        tokenMint: mint,
        symbol: (cheap.pool.raw?.name || expensive.pool.raw?.name || mint.slice(0, 6)),
        buyPool: cheap.pool,    // buy where cheaper
        sellPool: expensive.pool, // sell where pricier
        spreadPct,
        buyPriceUsd: cheap.usd,
        sellPriceUsd: expensive.usd
      });
    }
  }

  results.sort((a, b) => b.spreadPct - a.spreadPct);
  return results.slice(0, maxCandidates);
}
