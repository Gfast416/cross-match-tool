// src/pool/normalize.js — universal pool normalizer (venue-agnostic shape).
import { WSOL_MINT, USDC_MINT, USDT_MINT } from '../config.js';

export { WSOL_MINT, USDC_MINT, USDT_MINT };

/** @returns {object|null} NormalizedPool */
export function normalizeMeteora(row, venue) {
  const mintA = row.token_x?.address || row.tokenX?.address || row.token_a_mint || '';
  const mintB = row.token_y?.address || row.tokenY?.address || row.token_b_mint || '';
  if (!mintA || !mintB) return null;
  const tvlUsd = Number(row.tvl || row.tvlUsd || 0);
  const volume24h = Number(row.volume?.['24h'] || row.volume24h || 0);
  const price = Number(row.current_price || row.currentPrice || 0);
  return {
    id: `${venue}:${row.address || row.pubkey || (mintA + mintB)}`,
    address: String(row.address || row.pubkey || ''),
    venue,
    mintA,
    mintB,
    price,            // raw ratio A/B (Meteora DLMM: price of A in B)
    priceUsdA: 0,     // enriched later from Jupiter
    priceUsdB: 0,
    tvlUsd,
    volume24h,
    feeRate: Number(row.base_fee_pct || row.fee || 0.0025),
    binStep: row.bin_step ?? row.binStep ?? null,
    raw: row
  };
}

/** @returns {object|null} */
export function normalizeRaydium(p) {
  const mintA = p.mintA?.address || p.mintA || '';
  const mintB = p.mintB?.address || p.mintB || '';
  if (!mintA || !mintB) return null;
  return {
    id: `raydium:${p.id || p.poolId}`,
    address: String(p.id || p.poolId || ''),
    venue: 'raydium',
    mintA,
    mintB,
    price: Number(p.price || 0),     // usually A/B ratio, not USD
    priceUsdA: 0,
    priceUsdB: 0,
    tvlUsd: Number(p.tvl || p.liquidity || 0),
    volume24h: Number(p.volume24h || p.day?.volume || 0),
    feeRate: Number(p.feeRate || 0.0025),
    binStep: null,
    raw: p
  };
}

/** @returns {object|null} */
export function normalizeOrca(w) {
  const mintA = w.tokenMintA || w.mintA || '';
  const mintB = w.tokenMintB || w.mintB || '';
  if (!mintA || !mintB) return null;
  return {
    id: `orca:${w.address || w.whirlpool}`,
    address: String(w.address || w.whirlpool || ''),
    venue: 'orca',
    mintA,
    mintB,
    price: Number(w.price || 0),
    priceUsdA: 0,
    priceUsdB: 0,
    tvlUsd: Number(w.tvlUsdc || w.tvl || 0),
    volume24h: Number(w.stats?.['24h']?.volume || w.volume24h || 0),
    feeRate: Number(w.feeRate || w.lpFeeRate || 0.0004),
    binStep: null,
    raw: w
  };
}
