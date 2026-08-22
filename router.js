// router.js — adaptive cross-DEX arbitrage router.
//
// Solves the "bot skips non-WSOL pools" problem: if a mispriced pool is quoted in
// USDC/USDT (e.g. METEORA USDC-A) instead of WSOL (SOL-A), we build a transit route:
//   SOL -> USDC (transit, any DEX) -> A (misprice venue) -> SOL (transit, any DEX)
// Execution uses Jupiter's swap API (optimized CU/fees, dexes filter) so gas stays cheap
// and we don't need to hand-build every DEX's swap instruction.

import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';

const warn = (...a) => console.warn('[router]', ...a);

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';

let connection, wallet;
export function initRouter(conn, wal) { connection = conn; wallet = wal; }

/**
 * Fetch a Jupiter quote for a single hop, with retry + backoff on rate-limit (429).
 */
export async function jupQuote(inputMint, outputMint, amount, opts = {}) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amount),
    slippageBps: String(opts.slippageBps ?? 50),
    maxAccounts: '64',
    restrictIntermediateTokens: 'true'
  });
  if (opts.dexes) params.append('dexes', opts.dexes);
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${JUP_QUOTE}?${params}`);
      if (res.status === 429) {
        attempt++;
        if (attempt > 4) throw new Error(`jup quote 429: rate limited after retries`);
        const wait = 1000 * attempt; // 1s, 2s, 3s, 4s
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`jup quote ${res.status}: ${await res.text()}`);
      return res.json();
    } catch (e) {
      if (e.message.includes('429')) throw e;
      throw e;
    }
  }
}

/**
 * Build + send a Jupiter swap tx. Returns signature.
 */
export async function executeJupiterSwap(inputMint, outputMint, amount, opts = {}) {
  if (!wallet || !wallet.publicKey) throw new Error('router wallet not initialized — call initRouter(conn, wallet) after initLive()');
  if (!connection) throw new Error('router connection not initialized — call initRouter(conn, wallet)');
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
  // PRO guard: simulate before paying (free). Catches reverts without burning SOL.
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = (sim.value.logs || []).slice(-6).join('\n');
      throw new Error(`jup swap simulate FAILED: ${JSON.stringify(sim.value.err)}\n${logs}`);
    }
  } catch (e) {
    if (e.message.includes('simulate FAILED')) throw e;
    // simulate may be unsupported on some RPC; proceed.
  }
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // hop1: SOL -> quote
  const h1 = await executeJupiterSwap(WSOL, quoteToken, startLamports, { dexes: undefined });
  sigs.push(h1.sig);
  await sleep(1200); // throttle to avoid Jupiter 429
  // hop2: quote -> A (force the mispriced venue)
  const h2 = await executeJupiterSwap(quoteToken, tokenMint, h1.outAmount, { dexes: mispriceVenueDexes });
  sigs.push(h2.sig);
  await sleep(1200);
  // hop3: A -> SOL
  try {
    const h3 = await executeJupiterSwap(tokenMint, WSOL, h2.outAmount, { dexes: undefined });
    sigs.push(h3.sig);
  } catch (e) {
    // hop3 failed but hop1+hop2 succeeded → token A is stuck in wallet.
    // Salvage: sell A -> SOL so funds aren't trapped (still a loss from fees, but recoverable).
    warn(`[cross-dex] hop3 (A->SOL) failed: ${e.message} — attempting salvage sell ${tokenMint.slice(0,6)}->SOL`);
    try {
      const h3b = await executeJupiterSwap(tokenMint, WSOL, h2.outAmount, { dexes: undefined, slippageBps: 500 });
      sigs.push(h3b.sig);
      warn(`[cross-dex] salvage done: ${h3b.sig}`);
    } catch (e2) {
      warn(`[cross-dex] salvage FAILED — token ${tokenMint.slice(0,6)} may be stuck. Manual sell needed. Err: ${e2.message}`);
    }
  }
  return sigs;
}

/**
 * Simulate a same-token arb (buy on buyVenue, sell on sellVenue) using Jupiter quotes.
 * Used in dry-run to show REAL net profit instead of guessing. Falls back to an unrestricted
 * route if the venue-restricted one returns NO_ROUTES_FOUND (some tokens have no route on that dex).
 */
export async function quoteSameTokenArb({ tokenMint, buyVenue, sellVenue, startLamports, slippageBps = 50 }) {
  const amt = BigInt(startLamports);
  const quoteHop = async (inputMint, outputMint, amount, dexes) => {
    try {
      return await jupQuote(inputMint, outputMint, amount, { slippageBps, dexes });
    } catch (e) {
      if (dexes && /NO_ROUTES_FOUND|400/.test(e.message)) {
        return await jupQuote(inputMint, outputMint, amount, { slippageBps });
      }
      throw e;
    }
  };
  const q1 = await quoteHop(WSOL, tokenMint, amt, buyVenue);
  const q2 = await quoteHop(tokenMint, WSOL, q1.outAmount, sellVenue);
  const inSol = Number(amt) / 1e9;
  const outSol = Number(q2.outAmount) / 1e9;
  const netPct = ((outSol - inSol) / inSol) * 100;
  return { inSol, outSol, netPct, netSol: outSol - inSol, q1, q2 };
}

export { WSOL, USDC, USDT };

/**
 * Simulate a triangular 3-hop route via Jupiter: SOL -> A -> B -> SOL.
 * route = [SOL, A, B, SOL]. Uses real Jupiter quotes per hop (with NO_ROUTES fallback).
 */
export async function quoteTriangularArb({ route, startLamports, slippageBps = 50 }) {
  const amt = BigInt(startLamports);
  const quoteHop = async (inputMint, outputMint, amount, dexes) => {
    try { return await jupQuote(inputMint, outputMint, amount, { slippageBps, dexes }); }
    catch (e) { if (dexes && /NO_ROUTES_FOUND|400/.test(e.message)) return await jupQuote(inputMint, outputMint, amount, { slippageBps }); throw e; }
  };
  let out = amt;
  const hops = [];
  for (let i = 0; i < route.length - 1; i++) {
    const q = await quoteHop(route[i], route[i + 1], out);
    out = q.outAmount;
    hops.push(q);
  }
  const inSol = Number(amt) / 1e9;
  const outSol = Number(out) / 1e9;
  const netPct = ((outSol - inSol) / inSol) * 100;
  return { inSol, outSol, netPct, netSol: outSol - inSol, hops };
}

/**
 * Execute a triangular 3-hop route via Jupiter (3 separate tx, NOT atomic).
 * Salvage: if any hop fails, dump the held token back to SOL.
 */
export async function executeTriangularRoute({ route, startLamports, slippageBps = 50, prioFee = 2000 }) {
  if (!wallet || !wallet.publicKey) throw new Error('executor wallet not initialized');
  if (!connection) throw new Error('executor connection not initialized');
  const sigs = [];
  let held = BigInt(startLamports);
  for (let i = 0; i < route.length - 1; i++) {
    try {
      const q = await jupQuote(route[i], route[i + 1], held, { slippageBps });
      const res = await fetch(JUP_SWAP, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: prioFee })
      });
      if (!res.ok) throw new Error(`jup swap ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      await connection.confirmTransaction(sig, 'confirmed');
      sigs.push(sig);
      held = BigInt(q.outAmount);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      // salvage: sell whatever we hold back to SOL
      warn(`[triangular] hop ${i} failed: ${e.message} — salvage ${route[i+1].slice(0,6)}->SOL`);
      try {
        const hb = await executeJupiterSwap(route[i + 1], WSOL, held, { dexes: undefined, slippageBps: 500 });
        sigs.push(hb.sig);
      } catch (e2) { warn(`[triangular] salvage FAILED — token ${route[i+1].slice(0,6)} may be stuck: ${e2.message}`); }
      throw e;
    }
  }
  return sigs;
}
