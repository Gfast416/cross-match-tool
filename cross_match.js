// cross_match.js — Real-time Cross-Match Arbitrage Detector
// Usage:    node cross_match.js [minTVL] [minMispricingPct]
// Example:  node cross_match.js 100 1.0
//
// Features:
//   - Dynamic mint/token scanning from Meteora DLMM + DAMM APIs (multi-page)
//   - Dead pool detection (>20% deviation from Jupiter oracle = reject)
//   - Noise filter: skips pools whose base token is SOL/USDC/USDT (absurd routes)
//   - 5-second Jupiter price cache (fee-efficient)
//   - Serialized logging (anti-garbled output)
//   - Configurable minTVL / minMispricingPct via CLI args

import axios from 'axios';
import { normalizePool, findCandidates, fetchAllPages } from './scanner.js';

const DLMM_API    = 'https://dlmm.datapi.meteora.ag/pools';
const DAMM_API    = 'https://damm-v2.datapi.meteora.ag/pools';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';

const MIN_TVL        = parseFloat(process.argv[2] || "100");
const MIN_MISPRICING = parseFloat(process.argv[3] || "1.0");
const SCAN_INTERVAL_MS = 30000; // 30 seconds
const MAX_PAGES = 5; // Scan up to 5 pages per venue (2500 pools each)

// Quote/input tokens — a pool whose base is one of these is noise (e.g. SOL-BILLY
// where base = WSOL itself). Skipped so we never report an absurd SOL→WSOL route.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkYWkuDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// --- Serialized Logging (anti-garbled output) ---
let logBuffer = [];
function log(...args) {
  logBuffer.push(args);
  flushLogs();
}
function flushLogs() {
  while (logBuffer.length > 0) {
    console.log(...logBuffer.shift());
  }
}

// --- Price Cache (Jupiter, 5s TTL) ---
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

/**
 * Main refresh cycle — fetch ALL pages, normalize, cross-match, report.
 */
async function refresh() {
  const ts = new Date().toISOString();
  log(`\n${'='.repeat(60)}`);
  log(`[${ts}] 🔄 Starting scan cycle`);
  log(`📊 Filters: minTVL=$${MIN_TVL}, minMispricing=${MIN_MISPRICING}%, maxPages=${MAX_PAGES}`);

  // Step 1: Fetch ALL pages from both venues in parallel
  log(`\n📡 Fetching ALL pools from Meteora DLMM (${MAX_PAGES} pages × 500) + DAMM (${MAX_PAGES} pages × 500)...`);
  const [dlmmRows, dammRows] = await Promise.all([
    fetchAllPages('DLMM', DLMM_API, MAX_PAGES),
    fetchAllPages('DAMM', DAMM_API, MAX_PAGES)
  ]);

  // Step 2: Normalize pools
  log(`\n🧹 Normalizing pools (TVL >= $${MIN_TVL})...`);
  const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
  const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);

  log(`   DLMM: ${dlmmPoolMap.size} valid pools (from ${dlmmRows.length} fetched)`);
  log(`   DAMM: ${dammPoolMap.size} valid pools (from ${dammRows.length} fetched)`);

  // Step 3: Find cross-matched tokens (present in both DLMM and DAMM)
  const dlmmMints = [...dlmmPoolMap.keys()];
  const dammMints = new Set([...dammPoolMap.keys()]);
  const commonTokens = dlmmMints.filter(mint => dammPoolMap.has(mint));

  log(`\n🔗 Cross-matched tokens: ${commonTokens.length}`);
  if (commonTokens.length > 0) {
    log(`   Tokens: ${commonTokens.map(t => t.slice(0, 8) + '...').join(', ')}`);
  }

  // Step 4: Check each common token for arbitrage
  log(`\n🎯 Checking arbitrage opportunities (minMispricing=${MIN_MISPRICING}%)...`);
  const candidates = [];

  for (let i = 0; i < commonTokens.length; i++) {
    const mint = commonTokens[i];
    const dlmmPool = dlmmPoolMap.get(mint);
    const dammPool = dammPoolMap.get(mint);
    const jupiterPrice = await fetchTokenPrice(mint);

    if (!dlmmPool || !dammPool || !jupiterPrice) continue;

    const candidate = findCandidates(dlmmPool, dammPool, jupiterPrice, MIN_MISPRICING);
    if (candidate) {
      // Noise filter: skip if the base token is one of our quote/input tokens
      // (e.g. SOL-BILLY where base = WSOL → absurd SOL→WSOL route).
      if (QUOTE_MINTS.has(candidate.baseMint)) {
        log(`   ⚪ Skipping ${candidate.name} — base is ${candidate.baseMint.slice(0, 6)} (SOL/USDC/USDT), not a real arb target`);
        continue;
      }
      candidates.push(candidate);
      log(`   ✅ Candidate found: ${candidate.name} | Mispricing: ${candidate.mispricingPct.toFixed(2)}%`);
    }

    // Progress indicator for long loops
    if ((i + 1) % 10 === 0) {
      log(`   Progress: ${i + 1}/${commonTokens.length} tokens checked...`);
    }
  }

  // Step 5: Report results
  log(`\n🏆 Final Results: Found ${candidates.length} arbitrage candidate(s)`);

  if (candidates.length > 0) {
    log(`\n${'-'.repeat(60)}`);
    candidates.slice(0, 20).forEach((c, i) => {
      log(`  ${i + 1}. Token: ${c.baseMint.slice(0, 8)}...${c.baseMint.slice(-4)} (${c.name})`);
      log(`     Direction: ${c.direction}`);
      log(`     Mispricing: ${c.mispricingPct.toFixed(2)}%`);
      log(`     ├─ DLMM  Price: ${c.dlmm.priceUsd.toExponential(4)} | TVL: $${c.dlmm.tvlUsd.toFixed(0)} | Vol24h: $${c.dlmm.volume24h.toFixed(0)}`);
      log(`     ├─ DAMM  Price: ${c.damm.priceUsd.toExponential(4)} | TVL: $${c.damm.tvlUsd.toFixed(0)} | Vol24h: $${c.damm.volume24h.toFixed(0)}`);
      log(`     └─ Jupiter Ref: $${c.jupiterPrice.toFixed(6)}`);
      log('');
    });

    if (candidates.length > 20) {
      log(`   ... and ${candidates.length - 20} more (showing top 20)`);
    }
  }

  log(`\n⏰ Next scan in ${SCAN_INTERVAL_MS / 1000} seconds...`);
  log(`Cycle complete.\n`);
}

// --- Main Entry ---
console.log('🚀 Cross Match Token Real Time — Starting...');
console.log('   GitHub: https://github.com/Gfast416/cross-match-tool');
console.log(`   Mode: Real-time arbitrage detection (interval: ${SCAN_INTERVAL_MS / 1000}s, pages: ${MAX_PAGES})`);

async function start() {
  try {
    await refresh();
  } catch (err) {
    log(`\n❌ FATAL ERROR in scan cycle: ${err.message}`);
    log(`   Stack: ${err.stack}`);
    log(`   Continuing to next cycle...`);
  }
}

// Initial run
start();

// Repeat every SCAN_INTERVAL_MS
setInterval(async () => {
  await start();
}, SCAN_INTERVAL_MS);
