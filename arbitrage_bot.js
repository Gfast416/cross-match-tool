#!/usr/bin/env node
/**
 * arbitrage_bot.js — Meteora DLMM ⇄ DAMMv2 Arbitrage Bot (Termux-ready)
 * =====================================================================
 * Pipeline:
 *   1. SCAN    : reuse scanner.js (DLMM + DAMM APIs) to find mispriced tokens
 *   2. PLAN    : build a 2-hop route  SOL -> JFY(DLMM) -> JFY(DAMMv2) -> USDC
 *               (the closing USDC->SOL leg is optional; mirros your screenshot)
 *   3. EXECUTE : dry-run (simulate PnL) OR live (Meteora SDK) depending on MODE
 *   4. LOOP    : repeat every SCAN_INTERVAL_MS
 *
 * Safety:
 *   - Default MODE=dry-run (NO real funds move, just PnL estimation)
 *   - Live mode requires WALLET_PRIVATE_KEY + RPC_URL and is EXPLICITLY opt-in
 *   - Min profit / TVL / mispricing thresholds are configurable via .env
 *
 * Usage:
 *   node arbitrage_bot.js [minTVL] [minMispricingPct]
 *   node arbitrage_bot.js 500 2.0
 *
 * Env (.env):
 *   MODE               = dry-run | live        (default: dry-run)
 *   WALLET_PRIVATE_KEY = base58 secret key     (required only for live)
 *   RPC_URL            = Solana RPC endpoint    (required only for live)
 *   TRADE_AMOUNT_SOL   = size of each trade     (default: 0.5)
 *   MIN_PROFIT_PCT     = min net profit % to act (default: 1.0)
 *   MIN_TVL            = min pool TVL USD       (default: 500)
 *   MIN_MISPRICING     = min mispricing %       (default: 1.0)
 *   ADD_CLOSE_LEG      = true|false             (default: false — match screenshot)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID = optional notify
 */

import 'dotenv/config';
import BN from 'bn.js';
import { normalizePool, findCandidates, fetchAllPages } from './scanner.js';

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';

// ---------- Config ----------
const MODE = (process.env.MODE || 'dry-run').toLowerCase();
const TRADE_AMOUNT_SOL = parseFloat(process.env.TRADE_AMOUNT_SOL || '0.5');
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '1.0');
const MIN_TVL = parseFloat(process.env.MIN_TVL || process.argv[2] || '500');
const MIN_MISPRICING = parseFloat(process.env.MIN_MISPRICING || process.argv[3] || '1.0');
const ADD_CLOSE_LEG = (process.env.ADD_CLOSE_LEG || 'false').toLowerCase() === 'true';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '3', 10); // Termux-friendly; raise for deeper scans

const DLMM_API = 'https://dlmm.datapi.meteora.ag/pools';
const DAMM_API = 'https://damm-v2.datapi.meteora.ag/pools';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/quote';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkYWkuDt1v';

// ---------- Serialized logging ----------
const logBuffer = [];
function log(...args) {
  logBuffer.push(args);
  while (logBuffer.length) console.log(...logBuffer.shift());
}
function warn(...args) { console.warn('[!]', ...args); }

// ---------- Price cache (Jupiter, 5s) ----------
const priceCache = new Map();
async function fetchTokenPrice(mint) {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.ts < 5000) return cached.price;
  try {
    const resp = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`);
    const data = await resp.json();
    const price = parseFloat(data?.[mint]?.usdPrice) || 0;
    priceCache.set(mint, { price, ts: Date.now() });
    return price;
  } catch { return 0; }
}

// ---------- Optional Telegram notify ----------
async function notify(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'Markdown' })
    });
  } catch (e) { warn('telegram notify failed:', e.message); }
}

// ---------- Scan: reuse your scanner.js ----------
async function scanForCandidates() {
  const [dlmmRows, dammRows] = await Promise.all([
    fetchAllPages('DLMM', DLMM_API, MAX_PAGES),
    fetchAllPages('DAMM', DAMM_API, MAX_PAGES)
  ]);

  const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
  const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);

  const commonTokens = [...dlmmPoolMap.keys()].filter(m => dammPoolMap.has(m));
  const candidates = [];

  for (const mint of commonTokens) {
    const dlmmPool = dlmmPoolMap.get(mint);
    const dammPool = dammPoolMap.get(mint);
    const jupiterPrice = await fetchTokenPrice(mint);
    const c = findCandidates(dlmmPool, dammPool, jupiterPrice, MIN_MISPRICING);
    if (c) candidates.push({ ...c, dlmmPool, dammPool });
  }
  return candidates;
}

// ---------- Build 2-hop route (DLMM -> DAMMv2) ----------
// Direction from findCandidates:
//   BUY_A_SELL_B  => priceA <= priceB  => buy on A (DLMM, cheaper), sell on B (DAMMv2, pricier)
//   SELL_A_BUY_B  => priceA >  priceB  => buy on B (DAMMv2, cheaper), sell on A (DLMM, pricier)
function buildRoute(candidate, startAmountLamports) {
  const buyOnDlmm = candidate.direction === 'BUY_A_SELL_B';
  const tokenMint = candidate.baseMint;
  // prefer a human-readable symbol from the raw pool if present
  const symbol = candidate.dlmmPool?.raw?.name
    || candidate.dammPool?.raw?.name
    || candidate.baseMint.slice(0, 6);
  return {
    tokenMint,
    buyOnDlmm,
    // Leg 1: SOL -> token  (on the cheaper venue)
    leg1Venue: buyOnDlmm ? 'DLMM' : 'DAMMv2',
    leg1Pool: buyOnDlmm ? candidate.dlmmPool : candidate.dammPool,
    // Leg 2: token -> USDC (on the pricier venue)
    leg2Venue: buyOnDlmm ? 'DAMMv2' : 'DLMM',
    leg2Pool: buyOnDlmm ? candidate.dammPool : candidate.dlmmPool,
    // keep refs to both normalized pools for PnL estimation
    dlmmPool: candidate.dlmmPool,
    dammPool: candidate.dammPool,
    symbol,
    startAmountLamports
  };
}

// ---------- Estimate via Jupiter quote API (used by dry-run AND to size live) ----------
async function jupiterQuote(inputMint, outputMint, amountLamports, slippageBps = 50) {
  try {
    const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data; // { inAmount, outAmount, priceImpactPct, ... }
  } catch { return null; }
}

// ---------- DRY RUN: simulate PnL using Meteora pool prices + Jupiter close leg ----------
async function dryRun(route) {
  const startSol = route.startAmountLamports / 1e9;
  const tokenPriceCheap = route.buyOnDlmm ? route.dlmmPool.priceUsd : route.dammPool.priceUsd;
  const tokenPriceExpensive = route.buyOnDlmm ? route.dammPool.priceUsd : route.dlmmPool.priceUsd;

  const usdStart = startSol * (await fetchTokenPrice(WSOL_MINT) || 0);
  if (!usdStart) return null;

  // crude token amount bought (ignores LP fee/price impact)
  const tokenAmount = usdStart / tokenPriceCheap;
  const usdMid = tokenAmount * tokenPriceExpensive; // selling on the pricier venue
  const grossSpreadPct = ((tokenPriceExpensive - tokenPriceCheap) / tokenPriceCheap) * 100;

  let usdEnd = usdMid;
  let closeLeg = null;
  if (ADD_CLOSE_LEG) {
    const closeQuote = await jupiterQuote(USDC_MINT, WSOL_MINT, BigInt(Math.floor(usdMid * 1e6)), 50);
    if (closeQuote) {
      const solBack = Number(closeQuote.outAmount) / 1e9;
      usdEnd = solBack * (await fetchTokenPrice(WSOL_MINT) || 0);
      closeLeg = { solBack, impactPct: closeQuote.priceImpactPct };
    }
  } else {
    // Without closing leg we just report the spread captured in USDC terms
    usdEnd = usdMid;
  }

  const estFeeSol = TRADE_AMOUNT_SOL * 0.003 * 2; // ~2 swaps of 0.3%
  const netUsd = usdEnd - usdStart - (ADD_CLOSE_LEG ? (await fetchTokenPrice(WSOL_MINT) || 0) * estFeeSol : 0);
  const netPct = (netUsd / usdStart) * 100;

  return {
    startSol, usdStart, tokenAmount, usdMid,
    grossSpreadPct, closeLeg, estFeeSol, usdEnd, netUsd, netPct
  };
}

// ---------- LIVE execution (Meteora SDK + Helius low-fee strategy) ----------
import {
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT, TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

let connection = null, wallet = null, CpAmm = null, DLMM = null;

async function initLive() {
  if (connection) return;
  const { default: _DLMM } = await import('@meteora-ag/dlmm');
  const _CpAmm = (await import('@meteora-ag/cp-amm-sdk')).default;
  DLMM = _DLMM;
  CpAmm = _CpAmm;
  // 'finalized' = more reliable on free Helius; 'confirmed' is fine & faster too
  connection = new Connection(process.env.RPC_URL, 'confirmed');
  const secret = JSON.parse(Buffer.from(process.env.WALLET_PRIVATE_KEY, 'base64').toString('utf8'));
  wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
}

/**
 * Low-fee + fast priority fee via Helius `getPriorityFeeEstimate`.
 * Strategy: keep compute unit PRICE minimal but ABOVE 0 so the tx is not
 * dropped by validators, while compute unit LIMIT is tightened per-tx to
 * avoid overpaying. Free Helius supports this JSON-RPC method.
 * Returns micro-lamports-per-CU (usually 0–2000 ≈ $0.00001–$0.0001).
 */
const FEE_CACHE = { value: 0, ts: 0 };
async function getPriorityFeeMicroLamports() {
  const now = Date.now();
  if (now - FEE_CACHE.ts < 15000) return FEE_CACHE.value; // reuse 15s
  try {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate',
      params: [{ options: { priorityLevel: 'Min' } }]
    };
    const res = await fetch(process.env.RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    const micro = Number(json?.result?.priorityFeeEstimate) || 0;
    FEE_CACHE.value = micro; FEE_CACHE.ts = now;
    return micro;
  } catch {
    return 0; // fall back to no priority fee (still lands, just less guaranteed)
  }
}

// Tighten CU limit per tx; swap is ~250k-1M CU depending on venue.
async function addFeeOptimization(tx, estimateCu) {
  const micro = await getPriorityFeeMicroLamports();
  const ixs = [];
  ixs.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: estimateCu })
  );
  // Only add a (tiny) priority fee when the network actually needs it.
  if (micro > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro })
    );
  }
  tx.instructions = [...ixs, ...tx.instructions];
  return tx;
}

// Ensure WSOL ATA exists & wrap SOL into it (needed when SOL is the input).
async function prepareWsol(lamports) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection, wallet, NATIVE_MINT, wallet.publicKey
  );
  const ixs = [];
  // top up WSOL so it can cover the trade
  ixs.push(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata.address, lamports })
  );
  ixs.push(createSyncNativeInstruction(ata.address, TOKEN_PROGRAM_ID));
  return { ata, ixs };
}

// Close the WSOL ATA and recover its lamports back to SOL (only if balance ~0).
async function closeWsol() {
  try {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, wallet, NATIVE_MINT, wallet.publicKey
    );
    const info = await connection.getTokenAccountBalance(ata.address);
    const bal = BigInt(info.value.amount);
    if (bal > 0n) {
      log('      ℹ️ WSOL balance > 0, skipping close (funds in use)');
      return null;
    }
    const ix = createCloseAccountInstruction(
      ata.address, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID
    );
    const tx = new Transaction().add(ix);
    tx.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx = await addFeeOptimization(tx, 150_000);
    return await sendAndConfirm(tx, 'close WSOL');
  } catch (e) {
    warn('closeWsol failed (non-fatal):', e.message);
    return null;
  }
}

async function sendAndConfirm(tx, label) {
  const sig = await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
  log(`      📨 ${label} sent: ${sig}`);
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`${label} confirm err: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function executeLive(route) {
  await initLive();
  const tokenMint = new PublicKey(route.tokenMint);
  const tokenPool = route.buyOnDlmm ? route.dlmmPool.raw : route.dammPool.raw;
  const poolAddress = new PublicKey(tokenPool.address);
  const lamports = route.startAmountLamports;

  if (route.buyOnDlmm) {
    // ---------- Leg 1: SOL -> token on DLMM ----------
    const dlmmPool = await DLMM.create(connection, poolAddress, { cluster: 'mainnet-beta' });
    const swapForY = dlmmPool.tokenX.publicKey.toBase58() === WSOL_MINT; // SOL is X => swap for Y
    const binArrays = await dlmmPool.getBinArrayForSwap(!swapForY);
    const quote = await dlmmPool.swapQuote(new BN(lamports), !swapForY, new BN(1), binArrays);
    let tx = await dlmmPool.swap({
      inToken: dlmmPool.tokenX.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
      inAmount: new BN(lamports),
      lbPair: dlmmPool.pubkey,
      user: wallet.publicKey,
      minOutAmount: quote.minOutAmount,
      outToken: dlmmPool.tokenY.publicKey
    });
    tx = await addFeeOptimization(tx, 600_000);
    const sig1 = await sendAndConfirm(tx, 'DLMM swap');

    // ---------- Leg 2: token -> USDC on DAMMv2 ----------
    const dammRaw = route.dammPool.raw;
    const dammAddr = new PublicKey(dammRaw.address);
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm.fetchPoolState(dammAddr);
    // tight minimum-out from a real DAMMv2 quote (anti-slippage)
    const dammQuote2 = await cpAmm.getQuote({
      inAmount: quote.outAmount,
      inputTokenMint: tokenMint,
      slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'),
      poolState,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: 0,
      tokenADecimal: 9,
      tokenBDecimal: 9,
    });
    const minOut2 = dammQuote2?.minSwapOutAmount || new BN(0);
    let tx2 = await cpAmm.swap({
      payer: wallet.publicKey,
      pool: dammAddr,
      inputTokenMint: tokenMint,
      outputTokenMint: new PublicKey(USDC_MINT),
      amountIn: quote.outAmount, // use actual received (minus fee), safe
      minimumAmountOut: minOut2,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: poolState.tokenAProgram,
      tokenBProgram: poolState.tokenBProgram,
      referralTokenAccount: null,
      poolState
    });
    tx2 = await addFeeOptimization(tx2, 400_000);
    const sig2 = await sendAndConfirm(tx2, 'DAMMv2 swap');
    return { sent: true, venue: 'DLMM→DAMMv2', sigs: [sig1, sig2] };
  } else {
    // ---------- Leg 1: SOL -> token on DAMMv2 ----------
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    const { ixs: wrapIxs } = await prepareWsol(lamports);
    // estimate leg-1 output so leg-2 (DLMM) can be quoted with the REAL amount
    const dammQuote = await cpAmm.getQuote({
      inAmount: new BN(lamports),
      inputTokenMint: new PublicKey(WSOL_MINT),
      slippage: 1,
      poolState,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: 0,
      tokenADecimal: 9,
      tokenBDecimal: 9,
    });
    const minOut1 = dammQuote?.minSwapOutAmount || new BN(0);
    let tx = await cpAmm.swap({
      payer: wallet.publicKey,
      pool: poolAddress,
      inputTokenMint: new PublicKey(WSOL_MINT),
      outputTokenMint: tokenMint,
      amountIn: new BN(lamports),
      minimumAmountOut: minOut1,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: poolState.tokenAProgram,
      tokenBProgram: poolState.tokenBProgram,
      referralTokenAccount: null,
      poolState
    });
    tx.instructions = [...wrapIxs, ...tx.instructions];
    tx = await addFeeOptimization(tx, 400_000);
    const sig1 = await sendAndConfirm(tx, 'DAMMv2 swap');

    // ---------- Leg 2: token -> USDC on DLMM ----------
    const dlmmRaw = route.dlmmPool.raw;
    const dlmmAddr = new PublicKey(dlmmRaw.address);
    const dlmmPool = await DLMM.create(connection, dlmmAddr, { cluster: 'mainnet-beta' });
    const swapForY = dlmmPool.tokenX.publicKey.toBase58() === WSOL_MINT;
    const binArrays = await dlmmPool.getBinArrayForSwap(!swapForY);
    const leg2In = dammQuote?.swapOutAmount || new BN(0);
    const quote = await dlmmPool.swapQuote(leg2In, !swapForY, new BN(1), binArrays);
    let tx2 = await dlmmPool.swap({
      inToken: dlmmPool.tokenX.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
      inAmount: quote.outAmount,
      lbPair: dlmmPool.pubkey,
      user: wallet.publicKey,
      minOutAmount: quote.minOutAmount,
      outToken: dlmmPool.tokenY.publicKey
    });
    tx2 = await addFeeOptimization(tx2, 600_000);
    const sig2 = await sendAndConfirm(tx2, 'DLMM swap');
    const sig3 = await closeWsol(); // recover any leftover WSOL back to SOL
    return { sent: true, venue: 'DAMMv2→DLMM', sigs: sig3 ? [sig1, sig2, sig3] : [sig1, sig2] };
  }
}

// ---------- Main loop ----------
async function cycle() {
  const ts = new Date().toISOString();
  log(`\n${'='.repeat(64)}`);
  log(`[${ts}] 🔄 Scan cycle | MODE=${MODE} | minTVL=$${MIN_TVL} minMis=${MIN_MISPRICING}%`);
  try {
    const candidates = await scanForCandidates();
    log(`   Found ${candidates.length} mispricing candidate(s)`);
    if (candidates.length === 0) return;

    for (const c of candidates) {
      const startLamports = Math.floor(TRADE_AMOUNT_SOL * 1e9);
      const route = buildRoute(c, startLamports);
      log(`\n   🎯 ${route.symbol} | mispricing ${c.mispricingPct.toFixed(2)}% | dir ${c.direction}`);
      log(`      Route: SOL→${route.tokenMint.slice(0,6)} (${route.leg1Venue}) → ${route.tokenMint.slice(0,6)} (${route.leg2Venue}) → USDC`);

      if (MODE === 'dry-run') {
        const sim = await dryRun(route);
        if (!sim) { warn('   dry-run estimate failed (price fetch).'); continue; }
        log(`      Spread: ${sim.grossSpreadPct.toFixed(2)}% | Est net: ${sim.netPct.toFixed(2)}% ($${sim.netUsd.toFixed(2)})`);
        if (sim.netPct >= MIN_PROFIT_PCT) {
          log(`      ✅ PROFITABLE (>= ${MIN_PROFIT_PCT}%) — would execute in live mode`);
          await notify(`🤖 *Arb candidate* ${route.symbol}\nSpread ${sim.grossSpreadPct.toFixed(2)}% | net ${sim.netPct.toFixed(2)}% ($${sim.netUsd.toFixed(2)})`);
        } else {
          log(`      ⚪ below min profit (${MIN_PROFIT_PCT}%) — skip`);
        }
      } else if (MODE === 'live') {
        if (!process.env.WALLET_PRIVATE_KEY || !process.env.RPC_URL) {
          warn('   LIVE mode needs WALLET_PRIVATE_KEY + RPC_URL. Skipping.');
          continue;
        }
        // Gate on the same net-profit check as dry-run so we don't burn SOL on bad fills.
        const sim = await dryRun(route);
        if (sim && sim.netPct < MIN_PROFIT_PCT) {
          log(`      ⚪ live skip: est net ${sim.netPct.toFixed(2)}% < ${MIN_PROFIT_PCT}%`);
          continue;
        }
        log(`      🔥 LIVE executing ${route.leg1Venue}->${route.leg2Venue} (${route.symbol})...`);
        const res = await executeLive(route);
        log(`      ✅ LIVE done (${res.venue}): ${res.sigs.join(' , ')}`);
        await notify(`🔥 *LIVE EXECUTED* ${route.symbol}\nRoute ${route.leg1Venue}→${route.leg2Venue}\n${res.sigs.map(s => 'https://solscan.io/tx/' + s).join('\n')}`);
      }
    }
  } catch (err) {
    warn('scan cycle error:', err.message);
  }
}

// ---------- Entry ----------
console.log('🤖 Meteora DLMM⇄DAMMv2 Arbitrage Bot');
console.log(`   MODE=${MODE} | scan every ${SCAN_INTERVAL_MS / 1000}s | trade ${TRADE_AMOUNT_SOL} SOL`);
console.log(`   close-leg(USDC→SOL)=${ADD_CLOSE_LEG} | minProfit=${MIN_PROFIT_PCT}%`);
cycle();
setInterval(cycle, SCAN_INTERVAL_MS);
