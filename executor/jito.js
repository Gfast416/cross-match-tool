// executor/jito.js — atomic multi-tx execution via Jito bundles (per docs.jito.wtf).
//
// Why: cross-dex (SOL->quote->A->quote->SOL) and triangular (SOL->A->B->SOL) are currently
// 3 SEPARATE transactions via Helius. That is NOT atomic — a sandwich or front-run can eat
// the spread between hops. Jito bundles execute up to 5 txs atomically in one block, so the
// whole arb lands or none of it does. Cost = a small tip (min 1000 lamports) — essentially free.
//
// Docs: https://docs.jito.wtf/lowlatencytxnsend/  (sendBundle, getBundleStatuses, getTipAccounts)
// Tip accounts (8, any works): 96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5, HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe,
//   Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY, ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49,
//   DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh, ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt,
//   DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL, 3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT
// Tip program: T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt  (SOL transfer to a tip account = tip)

import { Connection, VersionedTransaction, SystemProgram, TransactionMessage, PublicKey } from '@solana/web3.js';
import { jupQuote } from '../router.js';
const log = (...a) => console.log('[jito]', ...a);
const warn = (...a) => console.warn('[jito]', ...a);

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];

let connection, wallet, jitoEndpoint;
export function initJito(conn, wal, endpoint) {
  connection = conn; wallet = wal;
  // Default: Jito block engine. Can be overridden via JITO_ENDPOINT (e.g. a Helius proxy).
  jitoEndpoint = endpoint || process.env.JITO_ENDPOINT || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
}

/** Build a signed Jupiter swap tx (base64) WITHOUT sending. Returns {b64, outAmount}. */
async function buildSignedSwapTx(inputMint, outputMint, amount, { dexes = null, slippageBps = 50, prioFee = 2000 }) {
  if (!wallet || !wallet.publicKey) throw new Error('jito wallet not initialized');
  if (!connection) throw new Error('jito connection not initialized');
  const quote = await jupiterQuote(inputMint, outputMint, amount, { slippageBps, dexes });
  const res = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: prioFee })
  });
  if (!res.ok) throw new Error(`jup swap ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
  tx.sign([wallet]);
  return { b64: Buffer.from(tx.serialize()).toString('base64'), outAmount: quote.outAmount };
}

/** A standalone tip tx (SOL transfer to a random Jito tip account). */
async function buildTipTx(tipLamports) {
  const tipAcct = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash,
    instructions: [ SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tipAcct, lamports: tipLamports }) ]
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return Buffer.from(tx.serialize()).toString('base64');
}

/**
 * Send a Jito bundle: array of signed base64 txs + a tip tx appended as the last entry.
 * Returns bundle id (uuid).
 */
export async function sendJitoBundle(swapBase64Txs, { tipLamports = 2000 } = {}) {
  if (!swapBase64Txs.length) throw new Error('empty bundle');
  if (swapBase64Txs.length + 1 > 5) throw new Error('bundle exceeds 5 txs (swaps + tip)');
  const tipTx = await buildTipTx(tipLamports);
  const bundle = [...swapBase64Txs, tipTx]; // tip is the final tx
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [bundle, { encoding: 'base64' }] });
  const res = await fetch(jitoEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error(`jito sendBundle ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`jito sendBundle error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Execute a multi-hop route atomically via Jito bundle.
 * route = [SOL, A, B, SOL] (3 swaps) or [SOL, A, SOL] (2 swaps).
 * Returns { bundleId, sigs }.
 */
export async function executeRouteViaJito(route, startLamports, { slippageBps = 50, tipLamports = 2000 } = {}) {
  const signed = [];
  let held = BigInt(startLamports);
  for (let i = 0; i < route.length - 1; i++) {
    const { b64, outAmount } = await buildSignedSwapTx(route[i], route[i + 1], held, { slippageBps });
    signed.push(b64);
    held = BigInt(outAmount); // chain output as next input
    await new Promise(r => setTimeout(r, 150));
  }
  const bundleId = await sendJitoBundle(signed, { tipLamports });
  log(`      📦 Jito bundle sent: ${bundleId}`);
  log(`      https://explorer.jito.wtf/bundle/${bundleId}`);
  return { bundleId, sigs: signed };
}
