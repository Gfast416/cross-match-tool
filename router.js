// router.js — adaptive cross-DEX arbitrage router.
//
// Solves the "bot skips non-WSOL pools" problem: if a mispriced pool is quoted in
// USDC/USDT (e.g. METEORA USDC-A) instead of WSOL (SOL-A), we build a transit route:
//   SOL -> USDC (transit, any DEX) -> A (misprice venue) -> SOL (transit, any DEX)
// Execution uses Jupiter's swap API (optimized CU/fees, dexes filter) so gas stays cheap
// and we don't need to hand-build every DEX's swap instruction.

import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';

let connection, wallet;
export function initRouter(conn, wal) { connection = conn; wallet = wal; }

/**
 * Fetch a Jupiter quote for a single hop.
 */
export async function jupQuote(inputMint, outputMint, amount, opts = {}) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amount),
    slippageBps: String(opts.slippageBps ?? 50),
    maxAccounts: '64',
    restrictIntermediateTokens: 'true'
  });
  if (opts.dexes) params.append('dexes', opts.dexes);
  const res = await fetch(`${JUP_QUOTE}?${params}`);
  if (!res.ok) throw new Error(`jup quote ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Build + send a Jupiter swap tx. Returns signature.
 */
export async function executeJupiterSwap(inputMint, outputMint, amount, opts = {}) {
  const quote = await jupQuote(inputMint, outputMint, amount, opts);
  const res = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: opts.prioFee ?? 2000
    })
  });
  if (!res.ok) throw new Error(`jup swap ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const txBuf = Buffer.from(data.swapTransaction, 'base64');
  const tx = (await import('@solana/web3.js')).VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`jup swap confirm err: ${JSON.stringify(conf.value.err)}`);
  return { sig, outAmount: quote.outAmount };
}

/**
 * Adaptive 3-hop executor for a cross-DEX mispricing where the mispriced pool is
 * quoted in USDC/USDT (not WSOL).
 *   hop1: SOL -> quoteToken   (Jupiter, any dex)
 *   hop2: quoteToken -> A      (restricted to the misprice venue, e.g. Meteora)
 *   hop3: A -> SOL             (Jupiter, any dex)
 * Returns array of signatures.
 */
export async function executeAdaptiveRoute({ tokenMint, quoteToken, mispriceVenueDexes, startLamports }) {
  const sigs = [];
  // hop1: SOL -> quote
  const h1 = await executeJupiterSwap(WSOL, quoteToken, startLamports, { dexes: undefined });
  sigs.push(h1.sig);
  // hop2: quote -> A (force the mispriced venue)
  const h2 = await executeJupiterSwap(quoteToken, tokenMint, h1.outAmount, { dexes: mispriceVenueDexes });
  sigs.push(h2.sig);
  // hop3: A -> SOL
  const h3 = await executeJupiterSwap(tokenMint, WSOL, h2.outAmount, { dexes: undefined });
  sigs.push(h3.sig);
  return sigs;
}

export { WSOL, USDC, USDT };
