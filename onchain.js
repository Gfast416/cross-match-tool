// onchain.js — reverse-engineer token prices directly from pool RESERVES (on-chain),
// NOT from external price APIs (which lag 30-60s and miss new tokens).
//
// Why: arbitrage bots that profit read pool reserves in real time via RPC/WebSocket and
// compute price = reserveBase / reserveQuote. Our old scanner used CoinGecko (laggy) +
// Meteora `current_price` (quote-relative, not USD) -> fake/missing spreads. This module
// fixes that by deriving USD from on-chain reserves + a single SOL/USDC anchor.
//
// Flow:
//   priceOnChain(A, in terms of B) = reserveB / reserveA  (adjusted for decimals)
//   anchor USD via WSOL (from CoinGecko/Jupiter once) OR via a USDC pool directly.
//   Compare on-chain price vs Jupiter swap quote -> real mispricing, executable NOW.

import { Connection, PublicKey } from '@solana/web3.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const DAMMV2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

// Compute price of token X expressed in token Y from raw reserves + decimals.
// reserveX/reserveY are integer lamports-like amounts (already include decimals).
export function priceFromReserves(reserveX, reserveY, decX = 9, decY = 9) {
  if (!reserveX || !reserveY) return 0;
  const rx = Number(reserveX) / Math.pow(10, decX);
  const ry = Number(reserveY) / Math.pow(10, decY);
  if (rx <= 0) return 0;
  return ry / rx; // price of X in terms of Y
}

// Read Meteora DLMM pool reserves on-chain and return { priceXinY, reserveX, reserveY, tokenX, tokenY }.
export async function readDlmmReserves(connection, poolAddress) {
  const dlmmMod = await import('@meteora-ag/dlmm');
  const DLMM = dlmmMod.default || dlmmMod.DLMM;
  const pool = await DLMM.create(connection, new PublicKey(poolAddress), { cluster: 'mainnet-beta' });
  const lb = pool.lbPair;
  return {
    tokenX: pool.tokenX.publicKey.toBase58(),
    tokenY: pool.tokenY.publicKey.toBase58(),
    reserveX: lb.reserveX,
    reserveY: lb.reserveY,
    decX: pool.tokenX.decimals,
    decY: pool.tokenY.decimals,
    priceXinY: priceFromReserves(lb.reserveX, lb.reserveY, pool.tokenX.decimals, pool.tokenY.decimals)
  };
}

// Read Meteora DAMMv2 pool reserves on-chain.
export async function readDammReserves(connection, poolAddress) {
  const cpMod = await import('@meteora-ag/cp-amm-sdk');
  const CpAmm = cpMod.default || cpMod.CpAmm;
  const cp = new CpAmm(connection);
  const ps = await cp.fetchPoolState(new PublicKey(poolAddress));
  const tokenX = ps.tokenAMint?.toBase58?.() || ps.tokenA?.address;
  const tokenY = ps.tokenBMint?.toBase58?.() || ps.tokenB?.address;
  const decX = ps.tokenADecimal || ps.tokenA?.decimals || 9;
  const decY = ps.tokenBDecimal || ps.tokenB?.decimals || 9;
  return {
    tokenX, tokenY,
    reserveX: ps.tokenAAmount,
    reserveY: ps.tokenBAmount,
    decX, decY,
    priceXinY: priceFromReserves(ps.tokenAAmount, ps.tokenBAmount, decX, decY)
  };
}

// Derive a USD price for `mint` by combining an on-chain pool (mint<->quote) with a
// USD anchor for the quote token. quoteMint should be WSOL or USDC (or any with known USD).
// Returns USD price of `mint` (0 if cannot determine).
export function usdFromOnChainPool(onchain, quoteUsdPrice) {
  if (!onchain || !quoteUsdPrice) return 0;
  // onchain.priceXinY = price of tokenX in terms of tokenY (quote).
  // If tokenX === mint: mint_usd = priceXinY * quoteUsd.
  // If tokenY === mint: mint_usd = quoteUsd / priceXinY.
  if (onchain.tokenX && onchain.tokenY) {
    // caller passes which is mint; we return both for flexibility
  }
  return onchain.priceXinY * quoteUsdPrice;
}

// Convenience: given a pool and which side is the target mint, return mint USD price.
export function mintUsdFromPool(onchain, mint, quoteUsdPrice) {
  if (!onchain || !quoteUsdPrice) return 0;
  if (onchain.tokenX === mint) return onchain.priceXinY * quoteUsdPrice;
  if (onchain.tokenY === mint) return quoteUsdPrice / onchain.priceXinY;
  return 0;
}

export { WSOL_MINT, USDC_MINT, DLMM_PROGRAM, DAMMV2_PROGRAM };
