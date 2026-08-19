// cross_match.js — Real-time Cross-Match Arbitrage Detector
// Usage:    node cross_match.js [minTVL] [minMispricingPct]
// Example:  node cross_match.js 100 1.0

import axios from 'axios';
import { normalizePool, findCandidates } from './scanner.js';

const DLMM_API = 'https://dlmm.datapi.meteora.ag/pools';
const DAMM_API = 'https://damm-v2.datapi.meteora.ag/pools';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';

const MIN_TVL = parseFloat(process.argv[2] || "100");
const MIN_MISPRICING = parseFloat(process.argv[3] || "1.0");

// Cache harga via Jupiter (5s TTL)
const priceCache = new Map();
async function fetchTokenPrice(mint) {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.ts < 5000) return cached.price;
  try {
    const resp = await axios.get(`${JUPITER_PRICE_API}?ids=${mint}`, { timeout: 8000 });
    const price = parseFloat(resp.data?.[mint]?.usdPrice) || 0;
    priceCache.set(mint, { price, ts: Date.now() });
    return price;
  } catch { return 0; }
}

async function fetchPage(url, page, pageSize) {
  const resp = await axios.get(url, {
    params: { page, page_size: pageSize, sort_by: 'tvl:desc' },
    timeout: 30000,
    headers: { 'User-Agent': 'CrossMatchBot/1.0' }
  });
  return resp.data;
}

async function refresh() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] 🔍 Fetching pools...`);

  const [dlmmFirst, dammFirst] = await Promise.all([
    fetchPage(DLMM_API, 1, 200),
    fetchPage(DAMM_API, 1, 200)
  ]);

  const dlmmRows = dlmmFirst.data || [];
  const dammRows = dammFirst.data || [];
  console.log(`📦 Pools fetched: ${dlmmRows.length} DLMM, ${dammRows.length} DAMM`);

  const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
  const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);

  console.log(`🧹 Valid pools: ${dlmmPoolMap.size} DLMM, ${dammPoolMap.size} DAMM`);

  const commonTokens = [...dlmmPoolMap.keys()].filter(mint => dammPoolMap.has(mint));
  console.log(`🔗 Cross-matched tokens: ${commonTokens.length}`);

  const candidates = [];
  for (const mint of commonTokens) {
    const dlmmPool = dlmmPoolMap.get(mint);
    const dammPool = dammPoolMap.get(mint);
    const jupiterPrice = await fetchTokenPrice(mint);
    if (!dlmmPool || !dammPool || !jupiterPrice) continue;

    const candidate = findCandidates(dlmmPool, dammPool, jupiterPrice, MIN_MISPRICING);
    if (candidate) candidates.push(candidate);
  }

  console.log(`\n🎯 Found ${candidates.length} arbitrage candidate(s):`);
  candidates.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i+1}. Token: ${c.baseMint.slice(0,8)}... | ${c.direction} | Mispricing: ${c.mispricingPct.toFixed(2)}%`);
    console.log(`     DLMM: ${c.dlmm.priceUsd.toExponential(3)} | TVL: $${c.dlmm.tvlUsd.toFixed(0)} | Vol24h: ${c.dlmm.volume24h.toFixed(0)}`);
    console.log(`     DAMM: ${c.damm.priceUsd.toExponential(3)} | TVL: $${c.damm.tvlUsd.toFixed(0)} | Vol24h: ${c.damm.volume24h.toFixed(0)}`);
    console.log(`     Jupiter ref: $${jupiterPrice.toFixed(6)}`);
  });

  console.log(`\n⏰ Next check in 30 seconds...\n`);
}

console.log('🚀 Cross Match Token Real Time — Starting...');
console.log('📊 Filter: TVL>=$' + MIN_TVL + ', Mispricing>=' + MIN_MISPRICING + '%');

await refresh();
setInterval(refresh, 30000);
