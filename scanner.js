#!/usr/bin/env node
/**
 * Cross-Match Scanner — Dynamic Mint & Pool Scanner for Solana DEXes
 * ---------------------------------------------------------
 * Scans ALL token pairs/mints dynamically from:
 *   - Raydium Public API (pools)
 *   - Orca Whirlpool API (pools)
 *   - Meteora Dynamic API (pools)
 *   - Jupiter Price API (cross-check oracle prices)
 *
 * 3-Layer Filtering Pipeline:
 *   Layer 1: TVL > 1,000 USD, reserves > 0, 24h volume > 0
 *   Layer 2: cross-venue price ratio <= 3x (relative to max price in pool group)
 *   Layer 3: Jupiter cross-check — cross-venue discount <= 25%
 *
 * Output: cross-match opportunities pushed to GitHub repo automatically.
 *
 * Fees: minimal HTTPS-only polling (no RPC subscription overhead)
 * Speed: parallel batched fetches for all venues per run
 */

const axios = require('axios');
const fs = require('fs');

// Config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'Gfast416';
const REPO = 'cross-match-tool';
const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 1000;

// --- Dynamic Data Sources ---
// All endpoints are public, no auth needed, HTTPS only → minimal fees
const RAYDIUM_API = 'https://api.raydium.io/v2/main/pools';
const ORCA_API = 'https://api.orca.so/v2/whirlpools';
const METEORA_API = 'https://api.meteora.io/v1/pools';
const JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';

// --- GitHub Headers ---
function ghHeaders() {
  return {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'cross-match-scanner'
  };
}

// --- Retry Helper (keeps it live-ready even under flaky networks) ---
async function retry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[retry] attempt ${attempt}/${RETRY_LIMIT} failed: ${err.message}`);
      if (attempt < RETRY_LIMIT) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

// --- Axios instance with timeout (speed + fee control) ---
const api = axios.create({
  timeout: 10000, // 10s max per request → avoids stuck calls
  headers: { 'User-Agent': 'cross-match-scanner' }
});

/**
 * Layer 1 — Basic liquidity / activity filters.
 * @param {Array<Object>} pairs - token pair data from DEX APIs
 * @returns {Array<Object>} filtered pairs
 */
function filterLayer1(pairs) {
  return pairs.filter(pair => {
    const tvl = Number(pair.tvl || pair.liquidityUsd || pair.reserveUSD || 0);
    const reserves = Number(pair.reserve0 || pair.reserve1 || pair.reserves || 0);
    const vol24h = Number(pair.volume24h || pair.volume || pair.vol24h || pair['24hVolume'] || 0);

    return tvl > 1000 && reserves > 0 && vol24h > 0;
  });
}

/**
 * Layer 2 — Cross-venue price ratio check (<= 3x).
 * Groups pairs by token mint + base mint, compares prices across venues.
 * @param {Array<Object>} pairs
 * @returns {Array<Object>} pairs whose price is within 3x of the max in their group
 */
function filterLayer2(pairs) {
  if (pairs.length === 0) return [];

  // Group by mint pair (tokenA_mint vs tokenB_mint)
  const groups = {};
  pairs.forEach(pair => {
    const key = `${pair.tokenMint || pair.tokenA || pair.token0 || pair.mintPair}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pair);
  });

  let matched = [];
  for (const key in groups) {
    const group = groups[key];
    const prices = group.map(p => Number(p.price || p.tokenPrice || p.apr || 0)).filter(p => p > 0);
    if (prices.length === 0) continue;
    const maxPrice = Math.max(...prices);

    group.forEach(pair => {
      const price = Number(pair.price || pair.tokenPrice || pair.apr || 0);
      if (price <= 0) return;
      const ratio = maxPrice / price;
      if (ratio <= 3) {
        matched.push({ ...pair, groupKey: key, priceRatioToMax: ratio });
      }
    });
  }

  return matched;
}

/**
 * Layer 3 — Jupiter cross-check (cross-venue discount <= 25%).
 * Fetches Jupiter's oracle price for each mint and validates consistency.
 * @param {Array<Object>} pairs
 * @returns {Promise<Array<Object>>} pairs passing Jupiter discount threshold
 */
async function filterLayer3(pairs) {
  const matched = [];

  for (const pair of pairs) {
    const mint = pair.tokenMint || pair.tokenA || pair.token0 || pair.mintPair?.split('_')[0];
    if (!mint) continue;

    try {
      const jupiterRes = await retry(async () => {
        return await api.get(`${JUPITER_PRICE_API}?ids=${mint}`);
      });

      const jupiterPrice = Number(jupiterRes.data?.data?.[mint]?.price || jupiterRes.data?.price || 0);
      const venuePrice = Number(pair.price || pair.tokenPrice || pair.apr || 0);

      if (venuePrice <= 0 || jupiterPrice <= 0) continue;

      // Cross-venue discount = (venue - jupiter) / venue
      const discount = (venuePrice - jupiterPrice) / venuePrice;

      if (discount <= 0.25) {
        matched.push({ ...pair, jupiterPrice, jupiterDiscount: discount });
      }
    } catch (err) {
      // Skip if Jupiter doesn't have price — fail open (don't block cross-match)
      console.warn(`[layer3] no jupiter price for ${mint}, skipping`);
    }
  }

  return matched;
}

/**
 * Fetch all pools from Raydium API dynamically
 * @returns {Promise<Array<Object>>}
 */
async function fetchRaydiumPools() {
  try {
    const res = await retry(async () => {
      return await api.get(RAYDIUM_API, {
        params: {
          page: 1,
          limit: 1000 // Fetch top liquidity pools dynamically
        }
      });
    });

    const pools = res.data?.data || res.data || [];
    console.log(`[raydium] fetched ${pools.length} pools`);

    return pools.map(p => ({
      venue: 'raydium',
      tokenMint: p.id || p.mint,
      name: p.name || `${p.tokenA}/${p.tokenB}`,
      price: p.price || p.tokenPrice,
      tvl: p.tvl || p.liquidityUsd || (Number(p.reserve0) * Number(p.reserve1)),
      reserve0: p.reserve0,
      reserve1: p.reserve1,
      volume24h: p.volume24h || p.vol24h || p['24hVolume'],
      liquidityUsd: p.liquidityUsd || p.tvl
    }));
  } catch (err) {
    console.error('[raydium] fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch all whirlpools from Orca API dynamically
 * @returns {Promise<Array<Object>>}
 */
async function fetchOrcaPools() {
  try {
    const res = await retry(async () => {
      return await api.get(ORCA_API);
    });

    const pools = res.data?.whirlpools || res.data || [];
    console.log(`[orca] fetched ${pools.length} pools`);

    return pools.map(w => ({
      venue: 'orca',
      tokenMint: w.tokenMintA || w.tokenAMint || w.token0Mint,
      name: `${w.tokenA || ''} / ${w.tokenB || ''}`,
      price: w.tokenPrice,
      tvl: w.tvl || w.liquidityUsd || w.liquidity,
      reserve0: w.reserve0,
      reserve1: w.reserve1,
      volume24h: w.volume24h || w.vol24h || w['24hVolume'],
      liquidityUsd: w.liquidityUsd || w.tvl
    }));
  } catch (err) {
    console.error('[orca] fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch all dynamic pools from Meteora API
 * @returns {Promise<Array<Object>>}
 */
async function fetchMeteoraPools() {
  try {
    const res = await retry(async () => {
      return await api.get(METEORA_API);
    });

    const pools = res.data?.pools || res.data || [];
    console.log(`[meteora] fetched ${pools.length} pools`);

    return pools.map(p => ({
      venue: 'meteora',
      tokenMint: p.tokenMint || p.mint || p.token_a_mint,
      name: `${p.token_a || ''} / ${p.token_b || ''}`,
      price: p.price || p.tokenPrice,
      tvl: p.tvl || p.liquidityUsd || p.reserveUsd,
      reserve0: p.reserve0,
      reserve1: p.reserve1,
      volume24h: p.volume24h || p.vol24h || p['24h_volume'],
      liquidityUsd: p.liquidityUsd || p.tvl
    }));
  } catch (err) {
    console.error('[meteora] fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch Jupiter price for a list of mints (batched)
 * @param {Array<string>} mints
 * @returns {Promise<Object>} mint -> price map
 */
async function fetchJupiterPrices(mints) {
  const prices = {};
  const uniqueMints = [...new Set(mints)].filter(Boolean);

  for (let i = 0; i < uniqueMints.length; i += 50) {
    const batch = uniqueMints.slice(i, i + 50).join(',');
    try {
      const res = await retry(async () => api.get(`${JUPITER_PRICE_API}?ids=${batch}`));
      for (const mint in res.data?.data || {}) {
        prices[mint] = Number(res.data.data[mint]?.price || 0);
      }
    } catch (err) {
      console.warn(`[jupiter] batch failed for ${batch}:`, err.message);
    }
  }

  return prices;
}

/**
 * Run the full dynamic scan across all venues
 * @returns {Promise<Array<Object>>} cross-match opportunities
 */
async function runFullScan() {
  console.log('[scanner] starting dynamic scan across all venues...');

  // Fetch all pools in parallel → speed + minimal fee impact
  const [raydiumPairs, orcaPairs, meteoraPairs] = await Promise.all([
    fetchRaydiumPools(),
    fetchOrcaPools(),
    fetchMeteoraPools()
  ]);

  const allPairs = [...raydiumPairs, ...orcaPairs, ...meteoraPairs];
  console.log(`[scanner] total pairs collected: ${allPairs.length}`);

  // Layer 1
  const l1 = filterLayer1(allPairs);
  console.log(`[scanner] Layer 1 (liquidity > 1k): ${l1.length} of ${allPairs.length}`);

  // Layer 2
  const l2 = filterLayer2(l1);
  console.log(`[scanner] Layer 2 (price ratio <= 3x): ${l2.length}`);

  // Layer 3
  const l3 = await filterLayer3(l2);
  console.log(`[scanner] Layer 3 (Jupiter cross-check <= 25%): ${l3.length}`);

  return l3;
}

/**
 * GitHub: Check if repo exists
 */
async function repoExists() {
  try {
    const res = await axios.get(`https://api.github.com/repos/${OWNER}/${REPO}`, {
      headers: ghHeaders()
    });
    return res.status === 200;
  } catch (err) {
    if (err.response && err.response.status === 404) return false;
    throw err;
  }
}

/**
 * GitHub: Create repo if missing
 */
async function createRepo() {
  const res = await axios.post(`https://api.github.com/user/repos`, {
    name: REPO,
    description: 'Dynamic cross-match scanner for Solana DEX token pairs',
    private: false,
    auto_init: false
  }, { headers: ghHeaders() });

  console.log(`[github] created repo ${OWNER}/${REPO} (status ${res.status})`);
}

/**
 * GitHub: Upload file (create or update)
 */
async function uploadFile(path, content, message) {
  const sha = await getFileSha(path);
  const b64 = Buffer.from(content).toString('base64');
  const payload = { message, content: b64 };
  if (sha) payload.sha = sha;

  const res = await axios.put(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    payload,
    { headers: ghHeaders() }
  );

  console.log(`[github] ${sha ? 'updated' : 'created'} ${path} (status ${res.status})`);
  return res.data;
}

async function getFileSha(path) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
      { headers: ghHeaders() }
    );
    return res.data.sha || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

/**
 * Generate cross-match report
 * @param {Array<Object>} matches
 */
function generateReport(matches) {
  const timestamp = new Date().toISOString();
  const lines = matches.map(m => `- **${m.venue.toUpperCase()}** | ${m.name} | Price: $${m.price} | TVL: $${m.tvl} | Vol24h: $${m.volume24h} | Jupiter Discount: ${m.jupiterDiscount ? (m.jupiterDiscount * 100).toFixed(1) + '%' : 'N/A'}`);

  return `# Cross-Match Scanner Report\n\n**Timestamp:** ${timestamp}\n\n**Total Matches:** ${matches.length}\n\n${lines.join('\n') || 'No matches found.'}\n`;
}

/**
 * Main entrypoint
 */
async function main() {
  if (!GITHUB_TOKEN) {
    console.error('[scanner] GITHUB_TOKEN env var required. Export your PAT with repo scope.');
    process.exit(1);
  }

  // Step 1: Scan all venues dynamically
  const matches = await runFullScan();

  // Step 2: Push report to GitHub
  const exists = await repoExists();
  if (!exists) {
    console.log('[scanner] repo not found — creating...');
    await createRepo();
  } else {
    console.log('[scanner] repo already exists.');
  }

  const report = generateReport(matches);
  await uploadFile('cross-match-report.md', report, 'Update cross-match report (dynamic scan)');
  await uploadFile('scanner.js', fs.readFileSync(__filename, 'utf8'), 'Update cross-match scanner (dynamic mint scanning)');

  console.log('[scanner] done — report + scanner.js pushed to GitHub.');
  console.log(`[scanner] ${matches.length} cross-match opportunities found.`);
}

// Export for programmatic use
module.exports = {
  filterLayer1,
  filterLayer2,
  filterLayer3,
  runFullScan,
  runFilterPipeline: async (rawPairs) => {
    const l1 = filterLayer1(rawPairs);
    const l2 = filterLayer2(l1);
    const l3 = await filterLayer3(l2);
    return l3;
  },
  fetchRaydiumPools,
  fetchOrcaPools,
  fetchMeteoraPools,
  fetchJupiterPrices,
  uploadFile,
  createRepo,
  repoExists,
  retry
};

if (require.main === module) {
  main().catch(err => {
    console.error('[scanner] fatal error:', err.message);
    process.exit(1);
  });
}
