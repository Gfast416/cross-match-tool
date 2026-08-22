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

import axios from 'axios';
import fs from 'fs';

// Quiet mode by default: suppress per-page / per-pool noise. Set DEBUG=1 to see everything.
const DEBUG = process.env.DEBUG === '1';
if (!DEBUG) {
  const _log = console.log.bind(console);
  console.log = (...a) => {
    const s = a.map(String).join(' ');
    if (/(Page \d|fetched|Fetching up to|Total pools|skipping malformed|starting dynamic scan|Layer \d|total pairs|repo |done —|created repo|already exists|opportunities found)/.test(s)) return;
    _log(...a);
  };
  const _warn = console.warn.bind(console);
  console.warn = (...a) => {
    const s = a.map(String).join(' ');
    if (/(Rejecting|retry|Page .* failed|no jupiter|batch failed|normalizePool)/.test(s)) return;
    _warn(...a);
  };
}

// Config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'Gfast416';
const REPO = 'cross-match-tool';
const RETRY_LIMIT = 2;
const RETRY_DELAY_MS = 500;

// --- Dynamic Data Sources ---
// All endpoints are public, no auth needed, HTTPS only → minimal fees
const RAYDIUM_API = 'https://api-v3.raydium.io/pools/info/list';
const ORCA_API = 'https://api.orca.so/v2/solana/pools';
const METEORA_API = 'https://api.meteora.io/v1/pools';
const JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

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
          poolType: 'all',
          poolSortField: 'liquidity',
          sortType: 'desc',
          pageSize: 200,
          page: 1
        }
      });
    });

    // Raydium v3 wraps pools in res.data.data (array). Each pool: mintA/mintB, price, tvl, volume
    const raw = res.data?.data || res.data || [];
    const pools = Array.isArray(raw) ? raw : (raw.data || []);
    console.log(`[raydium] fetched ${pools.length} pools`);

    return pools.map(p => {
      const mintA = p.mintA?.address || p.mintA;
      const mintB = p.mintB?.address || p.mintB;
      return {
        venue: 'raydium',
        address: p.id || p.poolId || p.lpMint,
        mintA, mintB,
        tokenMint: mintA, // primary; buildRoute uses mints below
        name: p.name || `${mintA?.slice(0,4)}/${mintB?.slice(0,4)}`,
        price: Number(p.price || 0),
        tvl: Number(p.tvl || p.liquidity || p.liquidityUsd || 0),
        volume24h: Number(p.volume24h || p.volume || 0),
        // expose both mints for the cross-dex matcher
        mints: [mintA, mintB].filter(Boolean)
      };
    });
  } catch (err) {
    console.error('[raydium] fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch ALL pools from a paginated API endpoint (up to maxPages)
 * Used by cross_match.js for comprehensive DLMM/DAMM scanning
 * @param {string} apiName - label for logging
 * @param {string} url - base API URL
 * @param {number} maxPages - max number of pages to fetch (default: 5)
 * @param {number} pageSize - pools per page (default: 500)
 * @returns {Promise<Array<Object>>} all pools from all pages
 */
async function fetchAllPages(apiName, url, maxPages = 5, pageSize = 500) {
  console.log(`[${apiName}] Fetching up to ${maxPages} pages (${maxPages * pageSize} pools)...`);

  const allPools = [];
  let totalPools = 0;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const resp = await axios.get(url, {
        params: { page, page_size: pageSize, sort_by: 'tvl:desc' },
        timeout: 8000,
        headers: { 'User-Agent': 'CrossMatchBot/1.0' }
      });

      const pools = resp.data?.data || resp.data || [];
      allPools.push(...pools);
      totalPools += pools.length;

      if (pools.length === 0) {
        console.log(`[${apiName}] Page ${page}: empty, stopping pagination`);
        break;
      }

      console.log(`[${apiName}] Page ${page}/${maxPages}: fetched ${pools.length} pools (total: ${totalPools})`);
    } catch (err) {
      console.warn(`[${apiName}] Page ${page} failed: ${err.message}`);
      break; // Stop pagination on error
    }
  }

  console.log(`[${apiName}] Total pools fetched: ${totalPools}`);
  return allPools;
}

/**
 * Fetch all whirlpools from Orca API dynamically
 * @returns {Promise<Array<Object>>}
 */
async function fetchOrcaPools() {
  try {
    const res = await retry(async () => {
      return await api.get(ORCA_API, {
        params: { minTvl: 10000, sortBy: 'tvl', sortDirection: 'desc', size: 200 }
      });
    });

    // Orca v2: res.data.data is an array of whirlpools; each has tokenMintA/B, price, tvlUsdc, volume
    const raw = res.data?.data || res.data || [];
    const pools = Array.isArray(raw) ? raw : (raw.data || []);
    console.log(`[orca] fetched ${pools.length} pools`);

    return pools.map(w => {
      const mintA = w.tokenMintA;
      const mintB = w.tokenMintB;
      return {
        venue: 'orca',
        address: w.address || w.whirlpool,
        mintA, mintB,
        tokenMint: mintA,
        name: w.name || `${w.tokenA?.symbol || mintA?.slice(0,4)}/${w.tokenB?.symbol || mintB?.slice(0,4)}`,
        price: Number(w.price || 0),
        tvl: Number(w.tvlUsdc || w.tvl || 0),
        volume24h: Number(w.stats?.['24h']?.volume || w.volume24h || 0),
        mints: [mintA, mintB].filter(Boolean)
      };
    });
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

  // Primary oracle: Jupiter price API.
  let primaryOk = false;
  for (let i = 0; i < uniqueMints.length; i += 50) {
    const batch = uniqueMints.slice(i, i + 50).join(',');
    try {
      const res = await retry(async () => api.get(`${JUPITER_PRICE_API}?ids=${batch}`));
      for (const mint in res.data?.data || {}) {
        prices[mint] = Number(res.data.data[mint]?.price || 0);
      }
      primaryOk = true;
    } catch (err) {
      console.warn(`[jupiter] price batch failed for ${batch}:`, err.message);
    }
  }
  if (primaryOk) return prices;

  // Fallback oracle 1: CoinGecko (free, no key) — works on networks where price.jup.ag is blocked.
  try {
    const ids = uniqueMints.join(',');
    const res = await retry(async () => api.get(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${ids}&vs_currencies=usd`));
    for (const mint in res.data || {}) {
      const p = res.data[mint]?.usd;
      if (p) prices[mint] = Number(p);
    }
    if (Object.keys(prices).length) { console.warn(`[oracle] CoinGecko fallback supplied ${Object.keys(prices).length} prices`); return prices; }
  } catch (err) {
    console.warn(`[coingecko] failed:`, err.message);
  }

  // Fallback oracle 2: derive USD from USDC-quoted pools already in the graph (done by caller).
  console.warn('[oracle] all price APIs down — caller must use USDC/USDT pool ratios');
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
 * Normalize pool data from different DEX formats into a uniform structure.
 * Supports DLMM and DAMM pool formats from Meteora.
 * @param {Array<Object>} rows - raw pool data from DEX API
 * @param {string} type - 'dlmm' or 'damm'
 * @param {number} minTvl - minimum TVL threshold
 * @returns {Map<string, Object>} map of tokenMint -> normalized pool data
 */
function normalizePool(rows, type, minTvl = 100) {
  const poolMap = new Map();

  for (const row of rows) {
    try {
      let tokenMint, priceUsd, tvlUsd, volume24h;

      if (type === 'dlmm' || type === 'damm') {
        // Meteora DLMM/DAMM pool format (actual API response)
        // Price is in current_price, TVL in tvl, volume in volume["24h"]
        tokenMint = row.token_x?.address || row.tokenX?.address || row.token_a_mint || row.tokenAMint || row.mint || '';
        priceUsd = Number(row.current_price || row.currentPrice || row.token_x?.price || row.token_y?.price || 0);
        tvlUsd = Number(row.tvl || row.tvlUsd || row.liquidityUsd || row.reserveUsd || 0);
        volume24h = Number(row.volume?.['24h'] || row.volume?.h24 || row.volume24h || row.vol24h || 0);
      } else {
        // Generic fallback for other exchanges
        tokenMint = row.tokenMint || row.mint || row.tokenA || '';
        priceUsd = Number(row.price || row.tokenPrice || row.current_price || 0);
        tvlUsd = Number(row.tvl || row.liquidityUsd || row.reserveUsd || 0);
        volume24h = Number(row.volume24h || row.vol24h || row['24hVolume'] || 0);
      }

      // Only include pools with sufficient TVL, some 24h volume, and valid data.
      // volume24h > 0 filters out dead/illiquid pools (no trading activity).
      if (tokenMint && priceUsd > 0 && tvlUsd >= minTvl && volume24h > 0) {
        const neu = {
          venue: type,
          tokenMint,
          priceUsd,
          tvlUsd,
          volume24h,
          reserve0: Number(row.reserve0 || row.token_x_amount || 0),
          reserve1: Number(row.reserve1 || row.token_y_amount || 0),
          raw: row
        };
        const hasTok = (r, m) => {
          const xs = r?.token_x?.address || r?.tokenX?.address || r?.token_a_mint || '';
          const ys = r?.token_y?.address || r?.tokenY?.address || r?.token_b_mint || '';
          return xs === m || ys === m;
        };
        // FASE 1 (multi-pool): keep ALL pools per token (not just 1). Store as array so the
        // path finder / buildRoute can compare multiple pools (different binStep/fee/quote).
        if (!poolMap.has(tokenMint)) {
          poolMap.set(tokenMint, [neu]);
        } else {
          poolMap.get(tokenMint).push(neu);
        }
        // Index by pool address for direct lookup (used by graph / path finder).
        const addr = row.address || row.poolAddress || row.lp_mint || '';
        if (addr) POOLS_BY_ADDRESS.set(addr, neu);
      }
    } catch (err) {
      // Skip malformed entries
      if (DEBUG) console.warn(`[normalizePool] skipping malformed ${type} pool:`, err.message);
    }
  }

  return poolMap;
}

// Module-level index: pool address -> normalized pool (for graph/path lookups).
const POOLS_BY_ADDRESS = new Map();
export function getPoolByAddress(addr) { return POOLS_BY_ADDRESS.get(addr); }

/**
 * Pick the best pool from a token's pool array for a given routing need.
 * preferMint = the token we want the pool to also contain (e.g. WSOL for SOL-side, USDC for close).
 * Falls back to highest TVL if no preference matches.
 */
export function bestPool(pools, preferMint) {
  if (!Array.isArray(pools) || pools.length === 0) return null;
  if (pools.length === 1) return pools[0];
  const hasTok = (p, m) => {
    const xs = p.raw?.token_x?.address || p.raw?.tokenX?.address || p.raw?.token_a_mint || '';
    const ys = p.raw?.token_y?.address || p.raw?.tokenY?.address || p.raw?.token_b_mint || '';
    return xs === m || ys === m;
  };
  if (preferMint) {
    const pref = pools.filter(p => hasTok(p, preferMint)).sort((a, b) => b.tvlUsd - a.tvlUsd);
    if (pref.length) return pref[0];
  }
  return pools.slice().sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
}

/**
 * Find arbitrage candidates between two pool venues.
 * Compares prices and calculates mispricing percentage.
 * Filters out pools whose price is >30% away from Jupiter reference (dead/stale pool detection).
 * @param {Object} poolA - normalized pool from venue A
 * @param {Object} poolB - normalized pool from venue B
 * @param {number} jupiterPrice - reference price from Jupiter
 * @param {number} minMispricingPct - minimum mispricing percentage threshold
 * @returns {Object|null} candidate object or null if no mispricing or pool appears stale
 */
function findCandidates(poolA, poolB, jupiterPrice, minMispricingPct = 1.0) {
  if (!poolA || !poolB || !jupiterPrice || jupiterPrice <= 0) return null;

  const priceA = Number(poolA.priceUsd || 0);
  const priceB = Number(poolB.priceUsd || 0);

  if (priceA <= 0 || priceB <= 0) return null;

  // ⚠️ Dead pool filter: reject pools >20% away from oracle price
  // This catches stale pools where liquidity migrated elsewhere
  const threshold = jupiterPrice * 0.20;
  const devA = Math.abs(priceA - jupiterPrice);
  const devB = Math.abs(priceB - jupiterPrice);

  if (devA > threshold || devB > threshold) {
    // Log the dead pool detection for debugging
    if (devA > threshold) {
      console.warn(`[findCandidates] Rejecting DLMM pool ${poolA.tokenMint.slice(0,8)} - price ${priceA} deviates ${(devA/jupiterPrice*100).toFixed(1)}% from oracle ${jupiterPrice}`);
    }
    if (devB > threshold) {
      console.warn(`[findCandidates] Rejecting DAMM pool ${poolB.tokenMint.slice(0,8)} - price ${priceB} deviates ${(devB/jupiterPrice*100).toFixed(1)}% from oracle ${jupiterPrice}`);
    }
    return null;
  }

  // Calculate mispricing between venues
  const priceDiff = Math.abs(priceA - priceB);
  const lowerPrice = Math.min(priceA, priceB);
  const mispricingPct = (priceDiff / lowerPrice) * 100;

  // Only consider if mispricing exceeds threshold
  if (mispricingPct < minMispricingPct) return null;

  const direction = priceA > priceB ? 'SELL_A_BUY_B' : 'BUY_A_SELL_B';

  return {
    baseMint: poolA.tokenMint,
    name: `${poolA.raw?.name || poolA.tokenMint.slice(0, 8)}...`,
    direction,
    mispricingPct,
    dlmm: {
      priceUsd: priceA,
      tvlUsd: Number(poolA.tvlUsd || 0),
      volume24h: Number(poolA.volume24h || 0)
    },
    damm: {
      priceUsd: priceB,
      tvlUsd: Number(poolB.tvlUsd || 0),
      volume24h: Number(poolB.volume24h || 0)
    },
    jupiterPrice
  };
}

/**
 * Cross-DEX mispricing detection — compares the SAME token's price across multiple venues
 * (Meteora DLMM, Meteora DAMMv2, Raydium, Orca, Jupiter aggregate) and reports any venue
 * whose price deviates beyond `thresholdPct` from the cross-venue min.
 *
 * Broadens coverage far beyond the internal DLMM-vs-DAMMv2 check: a token may be fairly
 * priced inside Meteora but heavily mispriced vs Raydium/Orca/Jupiter — that gap is arbitrageable
 * by routing through Meteora (buy cheap venues token on Meteora, sell on the expensive one).
 *
 * @param {Object} meteoraPools - { dlmm: Map<mint, pool>, damm: Map<mint, pool> } from normalizePool
 * @param {Object} jupiterPrices - mint -> price (from fetchJupiterPrices)
 * @param {Array} raydiumPools - raw Raydium pools (from fetchRaydiumPools)
 * @param {Array} orcaPools - raw Orca whirlpools (from fetchOrcaPools)
 * @param {number} thresholdPct - min cross-venue spread % to report (e.g. 3)
 * @returns {Array<Object>} candidates
 */
async function findCrossDexMisprice(meteoraPools, jupiterPrices, raydiumPools, orcaPools, thresholdPct = 3) {
  // Build mint->price maps for Raydium & Orca. A pool has TWO mints (A,B); we store
  // each mint's implied price. For a 2-token pool price = pool.price is the A/B ratio,
  // but Orca/Raydium `price` field is already tokenA's USD price — store for both mints
  // using the pool price (good enough for spread detection across venues).
  const rayMap = new Map();
  for (const p of (raydiumPools || [])) {
    const mints = p.mints || [p.mintA, p.mintB].filter(Boolean);
    const price = Number(p.price || 0); // A/B ratio, NOT USD
    if (price <= 0 || mints.length < 2) continue;
    const [a, b] = mints;
    // Store ratio for both mints; 'other' is the counterpart used to convert to USD via Jupiter.
    rayMap.set(a, { ratio: price, other: b, usd: 0 });
    rayMap.set(b, { ratio: 1 / price, other: a, usd: 0 });
  }
  const orcaMap = new Map();
  for (const w of (orcaPools || [])) {
    const mints = w.mints || [w.mintA, w.mintB].filter(Boolean);
    const price = Number(w.price || 0); // A/B ratio, NOT USD
    if (price <= 0 || mints.length < 2) continue;
    const [a, b] = mints;
    orcaMap.set(a, { ratio: price, other: b, usd: 0 });
    orcaMap.set(b, { ratio: 1 / price, other: a, usd: 0 });
  }

  const results = [];
  const allMints = new Set([
    ...meteoraPools.dlmm.keys(),
    ...meteoraPools.damm.keys(),
    ...rayMap.keys(),
    ...orcaMap.keys(),
    ...Object.keys(jupiterPrices || {})
  ]);

  for (const mint of allMints) {
    const prices = {};
    // FASE 1: pick best pool per venue (WSOL/USDC preferred) from the multi-pool arrays.
    const dlmmArr = meteoraPools.dlmm.get(mint);
    const dammArr = meteoraPools.damm.get(mint);
    const dlmm = dlmmArr ? bestPool(dlmmArr, WSOL_MINT) : undefined;
    const damm = dammArr ? bestPool(dammArr, USDC_MINT) : undefined;
    // Meteora priceUsd is already USD (normalized by Meteora from the quote token).
    if (dlmm) prices.dlmm = Number(dlmm.priceUsd || 0);
    if (damm) prices.damm = Number(damm.priceUsd || 0);
    // Raydium/Orca `price` is the A/B ratio (NOT USD) — only usable as USD if the OTHER
    // token in the pool has a known USD price (from Jupiter). We convert below.
    if (rayMap.has(mint)) {
      const p = rayMap.get(mint);
      if (p.usd) prices.raydium = p.usd;
      else if (p.ratio && jupiterPrices[p.other]) prices.raydium = p.ratio * jupiterPrices[p.other];
    }
    if (orcaMap.has(mint)) {
      const p = orcaMap.get(mint);
      if (p.usd) prices.orca = p.usd;
      else if (p.ratio && jupiterPrices[p.other]) prices.orca = p.ratio * jupiterPrices[p.other];
    }
    // Jupiter as the trusted USD oracle for the mispriced token itself.
    if (jupiterPrices && jupiterPrices[mint]) prices.jupiter = jupiterPrices[mint];

    const vals = Object.values(prices).filter(v => v > 0);
    if (vals.length < 2) {
      if (DEBUG && (prices.dlmm || prices.damm) && prices.jupiter) {
        // Meteora + Jupiter present but no 2nd venue — log the raw gap for tuning.
        const m = prices.dlmm || prices.damm;
        const gap = Math.abs(m - prices.jupiter) / prices.jupiter * 100;
        if (gap >= 0.5) console.log(`[xdex] ${mint.slice(0,6)} meteora=${m.toFixed(6)} jup=${prices.jupiter.toFixed(6)} gap=${gap.toFixed(2)}% (no 2nd venue, skipped)`);
      }
      continue;
    }

    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const spreadPct = ((max - min) / min) * 100;
    if (spreadPct < thresholdPct) continue;
    // Sanity cap: >1000% spread almost always means a stale/near-zero-price source.
    if (spreadPct > 1000) continue;

    let cheapVenue = null, expensiveVenue = null, cheapPrice = Infinity, expensivePrice = -Infinity;
    for (const [venue, price] of Object.entries(prices)) {
      if (price <= 0) continue;
      if (price < cheapPrice) { cheapPrice = price; cheapVenue = venue; }
      if (price > expensivePrice) { expensivePrice = price; expensiveVenue = venue; }
    }

    const meteoraInvolved = ('dlmm' in prices) || ('damm' in prices);
    if (!meteoraInvolved) continue;

    // Determine the quote token of the Meteora mispriced pool — the OTHER token in the
    // pool (not the mispriced token itself). This can be USDC, USDT, WSOL, PUMP, BONK, etc.
    // We route SOL -> quoteToken -> A -> quoteToken -> SOL using whatever DEX has the pools.
    let quoteToken = null;
    const mp = dlmm || damm;
    if (mp) {
      const xs = mp.raw?.token_x?.address || mp.raw?.tokenX?.address || mp.raw?.token_a_mint || '';
      const ys = mp.raw?.token_y?.address || mp.raw?.tokenY?.address || mp.raw?.token_b_mint || '';
      // The quote token is whichever of the two pool mints is NOT the mispriced token.
      if (xs && xs !== mint) quoteToken = xs;
      else if (ys && ys !== mint) quoteToken = ys;
    }

    results.push({
      tokenMint: mint,
      symbol: (dlmm?.raw?.name || damm?.raw?.name || mint.slice(0, 6)),
      prices,
      spreadPct,
      cheapVenue,
      expensiveVenue,
      meteoraIsCheap: (prices.dlmm && prices.dlmm <= cheapPrice) || (prices.damm && prices.damm <= cheapPrice),
      quoteToken
    });
  }
  return results;
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

/**
 * Run the full filter pipeline programmatically
 * @param {Array<Object>} rawPairs
 * @returns {Promise<Array<Object>>}
 */
async function runFilterPipeline(rawPairs) {
  const l1 = filterLayer1(rawPairs);
  const l2 = filterLayer2(l1);
  const l3 = await filterLayer3(l2);
  return l3;
}

// ---------- Triangular / multi-hop path finder (A→B→C→A across venues) ----------
// Input: a price graph = Map<mint, Map<venue, priceUsd>> (from all DEXes).
// Finds 3-token cycles (start/end at SOL or any hub) where buying cheap + selling dear
// across venues yields profit after fees. This is the "deeper" arb beyond same-token.

/**
 * Build a price graph: for every pool, record base token -> {venue, quoteToken, usd}.
 * priceUsd is the USD price of the BASE token (already enriched in the bot).
 */
function buildPriceGraph(poolsByMint) {
  // poolsByMint: Map<mint, Array<{venue, tokenMint, priceUsd, tvlUsd, volume24h, raw}>>
  const graph = new Map(); // mint -> Map<venue, {priceUsd, tvlUsd, volume24h}>
  for (const [mint, arr] of poolsByMint) {
    if (!Array.isArray(arr)) continue;
    const byVenue = new Map();
    for (const p of arr) {
      if (p.priceUsd > 0 && p.tvlUsd >= 0) {
        byVenue.set(p.venue, { priceUsd: p.priceUsd, tvlUsd: p.tvlUsd, volume24h: p.volume24h || 0 });
      }
    }
    if (byVenue.size) graph.set(mint, byVenue);
  }
  return graph;
}

/**
 * Find triangular opportunities: hub -> A -> B -> hub (or any 3-token cycle).
 * We start from a hub (WSOL by default), pick two other tokens A,B such that:
 *   hub -(cheap)-> A -(cheap)-> B -(expensive)-> hub  yields > fee profit.
 * Uses venue-specific prices so the route is buildable on real DEX pools.
 */
function findTriangularMisprice(graph, {
  hub = 'So11111111111111111111111111111111111111112',
  minProfitPct = 0.5,
  maxTokens = 250,        // cap search space (top TVL tokens)
  feePct = 0.003,         // per-hop fee estimate (Raydium ~0.25%, Meteora varies)
  sanityCapPct = 100      // anything above this is a data/pricing error, not a real arb
} = {}) {
  const results = [];
  if (!graph.has(hub)) return results;

  // SANITY: if the hub has no valid USD price (e.g. Jupiter price oracle unreachable),
  // every ratio downstream is garbage (we saw 7,000,000% "arbs"). Refuse to compute.
  const hubVenues0 = graph.get(hub);
  const hubUsd = Math.min(...[...hubVenues0.values()].map(v => v.priceUsd));
  if (!(hubUsd > 0)) { console.warn('[triangular] hub has no valid USD price — skipping (pricing oracle down)'); return results; }

  // Rank tokens by TVL to keep search bounded.
  const tokens = [...graph.keys()].filter(t => t !== hub);
  const ranked = tokens
    .map(t => {
      const venues = graph.get(t);
      let tvl = 0;
      for (const v of venues.values()) tvl = Math.max(tvl, v.tvlUsd || 0);
      return { t, tvl };
    })
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, maxTokens)
    .map(x => x.t);

  const hubVenues = graph.get(hub);
  for (const A of ranked) {
    const aVenues = graph.get(A);
    if (!aVenues) continue;
    for (const B of ranked) {
      if (B === A) continue;
      const bVenues = graph.get(B);
      if (!bVenues) continue;

      // We need a path hub->A, A->B, B->hub. Pick the CHEAPEST buy and dearest sell per leg
      // to estimate max arbitrage (best case). Use price ratios.
      // hub->A: 1 hub buys (hubUsd / aUsd) of A. Choose min aUsd (cheapest A).
      const hubToA = Math.min(...[...hubVenues.values()].map(v => v.priceUsd)) /
                     Math.max(...[...aVenues.values()].map(v => v.priceUsd)); // more A if A is cheap
      // A->B: 1 A buys (aUsd / bUsd) of B. Choose best ratio.
      const aToB = Math.max(...[...aVenues.values()].map(v => v.priceUsd)) /
                   Math.min(...[...bVenues.values()].map(v => v.priceUsd));
      // B->hub: 1 B buys (bUsd / hubUsd) of hub. Choose max bUsd (dearest B).
      const bToHub = Math.max(...[...bVenues.values()].map(v => v.priceUsd)) /
                     Math.min(...[...hubVenues.values()].map(v => v.priceUsd));

      const gross = hubToA * aToB * bToHub;
      const feeMult = Math.pow(1 - feePct, 3);
      const net = gross * feeMult;
      const netPct = (net - 1) * 100;

      // Sanity: a real 3-hop arb is rarely > sanityCapPct%. Above that = pricing garbage.
      if (netPct >= minProfitPct && netPct <= sanityCapPct) {
        results.push({
          type: 'triangular',
          hub, A, B,
          netPct,
          grossPct: (gross - 1) * 100,
          route: [hub, A, B, hub]
        });
      }
    }
  }
  results.sort((x, y) => y.netPct - x.netPct);
  return results.slice(0, 20);
}

// Export for programmatic use
export { filterLayer1, filterLayer2, filterLayer3, runFullScan, runFilterPipeline, fetchRaydiumPools, fetchOrcaPools, fetchMeteoraPools, fetchJupiterPrices, uploadFile, createRepo, repoExists, retry, normalizePool, findCandidates, generateReport, fetchAllPages, findCrossDexMisprice, buildPriceGraph, findTriangularMisprice };

// Run main if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[scanner] fatal error:', err.message);
    process.exit(1);
  });
}
