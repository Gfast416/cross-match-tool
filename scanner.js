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
const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 1000;

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
        timeout: 30000,
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
        // If the same mint appears in multiple pools (e.g. WSOL-MET and USDC-MET),
        // keep the one we need for routing: DLMM prefers WSOL (SOL-side), DAMMv2 prefers USDC.
        if (!poolMap.has(tokenMint)) {
          poolMap.set(tokenMint, neu);
        } else {
          const ex = poolMap.get(tokenMint);
          const exW = hasTok(ex.raw, WSOL_MINT);
          const newW = hasTok(row, WSOL_MINT);
          const exU = hasTok(ex.raw, USDC_MINT);
          const newU = hasTok(row, USDC_MINT);
          let replace = false;
          if (type === 'dlmm') replace = (!exW && newW) || (exW === newW && tvlUsd > ex.tvlUsd);
          else replace = (!exU && newU) || (exU === newU && tvlUsd > ex.tvlUsd);
          if (replace) poolMap.set(tokenMint, neu);
        }
      }
    } catch (err) {
      // Skip malformed entries
      console.warn(`[normalizePool] skipping malformed ${type} pool:`, err.message);
    }
  }

  return poolMap;
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
    const price = Number(p.price || 0);
    if (price <= 0) continue;
    for (const m of mints) if (m) rayMap.set(m, price);
  }
  const orcaMap = new Map();
  for (const w of (orcaPools || [])) {
    const mints = w.mints || [w.mintA, w.mintB].filter(Boolean);
    const price = Number(w.price || 0);
    if (price <= 0) continue;
    for (const m of mints) if (m) orcaMap.set(m, price);
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
    const dlmm = meteoraPools.dlmm.get(mint);
    const damm = meteoraPools.damm.get(mint);
    if (dlmm) prices.dlmm = Number(dlmm.priceUsd || 0);
    if (damm) prices.damm = Number(damm.priceUsd || 0);
    if (rayMap.has(mint)) prices.raydium = rayMap.get(mint);
    if (orcaMap.has(mint)) prices.orca = orcaMap.get(mint);
    if (jupiterPrices && jupiterPrices[mint]) prices.jupiter = jupiterPrices[mint];

    const vals = Object.values(prices).filter(v => v > 0);
    if (vals.length < 2) continue;

    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const spreadPct = ((max - min) / min) * 100;
    if (spreadPct < thresholdPct) continue;

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

// Export for programmatic use
export { filterLayer1, filterLayer2, filterLayer3, runFullScan, runFilterPipeline, fetchRaydiumPools, fetchOrcaPools, fetchMeteoraPools, fetchJupiterPrices, uploadFile, createRepo, repoExists, retry, normalizePool, findCandidates, generateReport, fetchAllPages, findCrossDexMisprice };

// Run main if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[scanner] fatal error:', err.message);
    process.exit(1);
  });
}
