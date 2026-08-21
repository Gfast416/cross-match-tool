// src/quote/quoter.js — real pricing + simulation via Jupiter (pro multi-DEX execution layer).
import { WSOL_MINT } from '../config.js';
import { VENUE_TO_JUP } from '../config.js';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_PRICE = 'https://price.jup.ag/v4/price';

/**
 * Single Jupiter quote with retry/backoff on 429 (rate limit).
 */
export async function jupiterQuote(inputMint, outputMint, amount, {
  slippageBps = 50, dexes = null, onlyDirect = false, maxRetries = 4
} = {}) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amount),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true'
  });
  if (dexes) params.set('dexes', dexes);
  if (onlyDirect) params.set('onlyDirectRoutes', 'true');

  let attempt = 0;
  while (true) {
    const res = await fetch(`${JUP_QUOTE}?${params}`);
    if (res.status === 429) {
      if (++attempt > maxRetries) throw new Error('jup quote 429: rate limited after retries');
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`jup quote ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

/**
 * Enrich USD prices for a list of mints via Jupiter price API (v4).
 * @param {string[]} mints
 * @returns {Object<string,number>} mint -> USD price
 */
export async function fetchJupiterPrices(mints) {
  const prices = {};
  if (!mints.length) return prices;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${JUP_PRICE}?ids=${mints.join(',')}`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      const d = data?.data || {};
      for (const m of mints) if (d[m]?.price) prices[m] = Number(d[m].price);
    }
  } catch { /* non-fatal */ }
  finally { clearTimeout(t); }
  return prices;
}

/**
 * Simulate a same-token arb: buy token on buyVenue, sell on sellVenue.
 * Uses Jupiter quotes restricted to each venue (dexes= filter).
 *
 * @param {object} args
 * @param {string} args.tokenMint
 * @param {string} args.buyVenue   - Jupiter dex name (from VENUE_TO_JUP)
 * @param {string} args.sellVenue
 * @param {bigint|number} args.amountLamports
 * @param {number} [args.slippageBps]
 * @returns {Promise<{inSol:number,outSol:number,netPct:number,netSol:number,q1:object,q2:object}>}
 */
export async function quoteSameTokenArb({
  tokenMint, buyVenue, sellVenue, amountLamports, slippageBps = 50
}) {
  const amt = BigInt(amountLamports);
  // Try with venue restriction first (to honor the detected mispriced venue), but fall back
  // to an unrestricted route if Jupiter can't find one on that specific dex (NO_ROUTES_FOUND).
  const quoteHop = async (inputMint, outputMint, amount, dexes) => {
    try {
      return await jupiterQuote(inputMint, outputMint, amount, { slippageBps, dexes });
    } catch (e) {
      if (dexes && /NO_ROUTES_FOUND|400/.test(e.message)) {
        return await jupiterQuote(inputMint, outputMint, amount, { slippageBps }); // unrestricted retry
      }
      throw e;
    }
  };
  // Hop 1: SOL -> token (buy on cheap venue)
  const q1 = await quoteHop(WSOL_MINT, tokenMint, amt, buyVenue);
  // Hop 2: token -> SOL (sell on pricey venue)
  const q2 = await quoteHop(tokenMint, WSOL_MINT, q1.outAmount, sellVenue);

  const inSol = Number(amt) / 1e9;
  const outSol = Number(q2.outAmount) / 1e9;
  const netPct = ((outSol - inSol) / inSol) * 100;
  return { inSol, outSol, netPct, netSol: outSol - inSol, q1, q2 };
}

export { VENUE_TO_JUP, WSOL_MINT };
