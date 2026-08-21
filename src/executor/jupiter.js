// src/executor/jupiter.js — execute a same-token arb via Jupiter (multi-hop sequential).
// NOT atomic (3 separate tx). Has salvage: if the final sell fails, dump token->SOL.
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { jupiterQuote } from '../quote/quoter.js';
import { WSOL_MINT, VENUE_TO_JUP, warn } from '../config.js';

const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';

let connection, wallet;
export function initExecutor(conn, wal) { connection = conn; wallet = wal; }

async function executeJupiterSwap(inputMint, outputMint, amount, { dexes = null, slippageBps = 50, prioFee = 2000 } = {}) {
  if (!wallet || !wallet.publicKey) throw new Error('executor wallet not initialized');
  if (!connection) throw new Error('executor connection not initialized');
  const quote = await jupiterQuote(inputMint, outputMint, amount, { slippageBps, dexes });
  const res = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: prioFee
    })
  });
  if (!res.ok) throw new Error(`jup swap ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
  tx.sign([wallet]);
  // simulate guard (free) — skip if unsupported
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`simulate FAILED: ${JSON.stringify(sim.value.err)}`);
  } catch (e) {
    if (e.message.includes('simulate FAILED')) throw e;
  }
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`confirm err: ${JSON.stringify(conf.value.err)}`);
  return { sig, outAmount: quote.outAmount };
}

/**
 * Execute SOL -> token (buyVenue) -> SOL (sellVenue).
 * Returns { sigs, salvaged }.
 */
export async function executeSameTokenArb({ tokenMint, buyVenue, sellVenue, startLamports, slippageBps = 50 }) {
  const buyDex = VENUE_TO_JUP[buyVenue] || buyVenue;
  const sellDex = VENUE_TO_JUP[sellVenue] || sellVenue;
  const sigs = [];
  const h1 = await executeJupiterSwap(WSOL_MINT, tokenMint, startLamports, { dexes: buyDex, slippageBps });
  sigs.push(h1.sig);
  await new Promise(r => setTimeout(r, 1200));
  try {
    const h2 = await executeJupiterSwap(tokenMint, WSOL_MINT, h1.outAmount, { dexes: sellDex, slippageBps });
    sigs.push(h2.sig);
  } catch (e) {
    warn(`[executor] sell hop failed: ${e.message} — salvage dumping ${tokenMint.slice(0,6)}->SOL`);
    try {
      const h2b = await executeJupiterSwap(tokenMint, WSOL_MINT, h1.outAmount, { dexes: null, slippageBps: 500 });
      sigs.push(h2b.sig);
      return { sigs, salvaged: true };
    } catch (e2) {
      warn(`[executor] SALVAGE FAILED — token ${tokenMint.slice(0,6)} may be stuck. Manual sell needed.`);
      return { sigs, salvaged: false, stuck: true };
    }
  }
  return { sigs, salvaged: false };
}
