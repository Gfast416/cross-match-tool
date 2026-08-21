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
import { normalizePool, findCandidates, findCrossDexMisprice, fetchAllPages, fetchRaydiumPools, fetchOrcaPools, fetchJupiterPrices } from './scanner.js';
import { initRouter, executeAdaptiveRoute, WSOL as ROUTER_WSOL, USDC as ROUTER_USDC, USDT as ROUTER_USDT } from './router.js';

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

// ---------- Config ----------
const MODE = (process.env.MODE || 'dry-run').toLowerCase();
const TRADE_AMOUNT_SOL = parseFloat(process.env.TRADE_AMOUNT_SOL || '0.5');
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '1.0');
const MIN_TVL = parseFloat(process.env.MIN_TVL || process.argv[2] || '100');
const MIN_MISPRICING = parseFloat(process.env.MIN_MISPRICING || process.argv[3] || '0.5');
const ADD_CLOSE_LEG = (process.env.ADD_CLOSE_LEG || 'false').toLowerCase() === 'true';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '5', 10); // match cross_match.js (2500 pools/venue)
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || '20000', 10);

// Race a promise against a timeout so a slow/stalled Helius free-RPC call can
// never hang the bot silently (Node's Connection/fetch have NO default timeout).
async function withTimeout(promise, ms = RPC_TIMEOUT_MS, label = 'rpc') {
  let timer;
  const timeout = new Promise((_, reject) =>
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (RPC stalled?)`)), ms)
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const DLMM_API = 'https://dlmm.datapi.meteora.ag/pools';
const DAMM_API = 'https://damm-v2.datapi.meteora.ag/pools';
const JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
// Tokens we use as quote/input — never treat a pool whose base is one of these as an arb target.
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// Dead-pool threshold (%) — Meteora rejects swaps when pool price is >5% from market.
const DEAD_POOL_PCT = parseFloat(process.env.DEAD_POOL_PCT || '5.0');

// ---------- Serialized logging ----------
// log = normal step, warn = soft warning, fail = full error detail (always verbose).
const logBuffer = [];
function ts() { return new Date().toISOString(); }
function log(...args) {
  logBuffer.push(`[${ts()}] ${args.map(String).join(' ')}`);
  while (logBuffer.length) console.log(logBuffer.shift());
}
function warn(...args) { console.warn(`[${ts()}] [!] ${args.map(String).join(' ')}`); }

// Always surface the FULL error: message + on-chain simulator logs + short stack.
// This is used in every catch block so no failure is ever swallowed silently.
function errorDetail(err, ctx) {
  const parts = [];
  if (ctx) parts.push(`[${ctx}]`);
  parts.push(err?.message || String(err));
  if (err?.logs && Array.isArray(err.logs) && err.logs.length) {
    parts.push('Logs:\n' + err.logs.join('\n'));
  }
  if (err?.stack) {
    parts.push('Stack: ' + err.stack.split('\n').slice(0, 5).join('\n'));
  }
  return parts.join('\n');
}
function fail(ctx, err) { warn(errorDetail(err, ctx)); }
// Debug-only line (set DEBUG=1 to see routing/SDK internals).
function dbg(...args) { if (process.env.DEBUG === '1') log('      🔬', ...args); }

// ---------- Price cache (Jupiter, 5s) ----------
const priceCache = new Map();
async function fetchTokenPrice(mint) {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.ts < 5000) return cached.price;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    const resp = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await resp.json();
    const price = parseFloat(data?.data?.[mint]?.price) || 0;
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
  // Fetch Meteora DLMM + DAMMv2 pools in parallel.
  const [dlmmRows, dammRows] = await Promise.all([
    fetchAllPages('DLMM', DLMM_API, MAX_PAGES),
    fetchAllPages('DAMM', DAMM_API, MAX_PAGES)
  ]);

  const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
  const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);

  // --- Additional cross-DEX price sources for WIDER mispricing coverage ---
  // (Raydium, Orca, Jupiter aggregate) — a token can be fairly priced inside Meteora
  // but heavily mispriced vs other venues; that gap is arbitrageable via Meteora legs.
  const [raydiumPools, orcaPools] = await Promise.all([
    fetchRaydiumPools().catch(() => []),
    fetchOrcaPools().catch(() => [])
  ]);
  const allMints = [...new Set([...dlmmPoolMap.keys(), ...dammPoolMap.keys()])];
  const jupiterPrices = await fetchJupiterPrices(allMints).catch(() => ({}));

  const candidates = [];

  // 1) Internal Meteora check: DLMM vs DAMMv2 for the same token.
  const commonTokens = [...dlmmPoolMap.keys()].filter(m => dammPoolMap.has(m));
  for (const mint of commonTokens) {
    const dlmmPool = dlmmPoolMap.get(mint);
    const dammPool = dammPoolMap.get(mint);
    const jupiterPrice = jupiterPrices[mint] || await fetchTokenPrice(mint);
    const c = findCandidates(dlmmPool, dammPool, jupiterPrice, MIN_MISPRICING);
    if (c) candidates.push({ ...c, dlmmPool, dammPool, source: 'meteora-internal' });
  }

  // 2) Cross-DEX check: same token priced differently across Meteora/Raydium/Orca/Jupiter.
  try {
    const crossDex = await findCrossDexMisprice(
      { dlmm: dlmmPoolMap, damm: dammPoolMap },
      jupiterPrices,
      raydiumPools,
      orcaPools,
      Math.max(2, MIN_MISPRICING) // report spreads >=2%
    );
    for (const cd of crossDex) {
      // Only keep ones where Meteora is on the cheap side (buy on Meteora) OR
      // where Meteora DLMM vs DAMMv2 itself diverges (already covered above).
      const dlmm = dlmmPoolMap.get(cd.tokenMint);
      const damm = dammPoolMap.get(cd.tokenMint);
      if (dlmm && damm) {
        // Meteora-internal already handled; skip to avoid duplicate.
        continue;
      }
      if (dlmm || damm) {
        // Determine the quote token of the Meteora mispriced pool (USDC/USDT) from the REAL raw.
        const realRaw = (dlmm || damm).raw || {};
        const hasTok = (r, m) => {
          const xs = r?.token_x?.address || r?.tokenX?.address || r?.token_a_mint || '';
          const ys = r?.token_y?.address || r?.tokenY?.address || r?.token_b_mint || '';
          return xs === m || ys === m;
        };
        let quoteToken = null;
        if (hasTok(realRaw, USDC_MINT)) quoteToken = USDC_MINT;
        else if (hasTok(realRaw, USDT_MINT)) quoteToken = USDT_MINT;
        else if (hasTok(realRaw, WSOL_MINT)) quoteToken = WSOL_MINT;
        candidates.push({
          baseMint: cd.tokenMint,
          name: cd.symbol,
          direction: cd.meteoraIsCheap ? 'BUY_METEORA' : 'SELL_METEORA',
          mispricingPct: cd.spreadPct,
          dlmmPool: dlmm || { priceUsd: cd.prices.dlmm || 0, tvlUsd: 0, volume24h: 0, raw: {} },
          dammPool: damm || { priceUsd: cd.prices.damm || 0, tvlUsd: 0, volume24h: 0, raw: {} },
          crossDex: { ...cd, quoteToken },
          source: 'cross-dex'
        });
      }
    }
  } catch (e) {
    warn(`[scan] cross-dex check failed: ${e.message}`);
  }

  return candidates;
}

// ---------- Build 2-hop route (DLMM -> DAMMv2) ----------
// Leg 1 must be the pool that contains WSOL (SOL side): SOL -> token.
// Leg 2 must be the pool that contains USDC: token -> USDC.
// The venue (DLMM vs DAMMv2) for each leg is chosen by which pool holds WSOL/USDC,
// NOT by price direction — otherwise we'd swap WSOL into a USDC-quoted pool (bad mint).
function buildRoute(candidate, startAmountLamports) {
  const tokenMint = candidate.baseMint;
  const dlmmRaw = candidate.dlmmPool.raw;
  const dammRaw = candidate.dammPool.raw;
  const has = (raw, mint) => {
    const xs = raw?.token_x?.address || raw?.tokenX?.address || raw?.token_a_mint || '';
    const ys = raw?.token_y?.address || raw?.tokenY?.address || raw?.token_b_mint || '';
    return xs === mint || ys === mint;
  };
  const dlmmHasWsol = has(dlmmRaw, WSOL_MINT);
  const dammHasWsol = has(dammRaw, WSOL_MINT);
  const dlmmHasUsdc = has(dlmmRaw, USDC_MINT);
  const dammHasUsdc = has(dammRaw, USDC_MINT);
  dbg(`route dlmmRaw.token_x=${dlmmRaw?.token_x?.address||dlmmRaw?.tokenX?.address} token_y=${dlmmRaw?.token_y?.address||dlmmRaw?.tokenY?.address} dlmmHasWsol=${dlmmHasWsol} dammHasWsol=${dammHasWsol} dlmmHasUsdc=${dlmmHasUsdc} dammHasUsdc=${dammHasUsdc}`);

  const leg1Pool = dlmmHasWsol ? candidate.dlmmPool : candidate.dammPool; // SOL side
  const leg2Pool = dlmmHasUsdc ? candidate.dlmmPool : candidate.dammPool; // USDC side
  const leg1IsDlmm = dlmmHasWsol;
  const leg2IsDlmm = dlmmHasUsdc;

  // No valid route if NEITHER venue has a WSOL pool for this token — SOL can't enter.
  // (e.g. USWS only has USDC pairs in both DLMM & DAMMv2). Skip this candidate.
  if (!dlmmHasWsol && !dammHasWsol) {
    log(`      ⚠️ no WSOL pool for ${tokenMint.slice(0, 6)} in either venue — cannot route SOL in — skip`);
    return null;
  }

  const symbol = dlmmRaw?.name || dammRaw?.name || tokenMint.slice(0, 6);
  return {
    tokenMint,
    // keep direction for PnL/profit logging (buy cheaper venue, sell pricier)
    buyOnDlmm: candidate.direction === 'BUY_A_SELL_B',
    leg1Venue: leg1IsDlmm ? 'DLMM' : 'DAMMv2',
    leg1Pool,
    leg2Venue: leg2IsDlmm ? 'DLMM' : 'DAMMv2',
    leg2Pool,
    leg1IsDlmm,
    leg2IsDlmm,
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
  createCloseAccountInstruction, getAssociatedTokenAddress, getAccount,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token';

let connection = null, wallet = null, CpAmm = null, DLMM = null, getTokenProgram = null;

async function initRead() {
  if (connection) return;
  try {
    const dlmmMod = await import('@meteora-ag/dlmm');
    const cpAmmMod = await import('@meteora-ag/cp-amm-sdk');
    DLMM = dlmmMod.default || dlmmMod.DLMM;
    CpAmm = cpAmmMod.CpAmm || cpAmmMod.default?.CpAmm || cpAmmMod.default;
    getTokenProgram = cpAmmMod.getTokenProgram || (() => TOKEN_PROGRAM_ID);
    connection = new Connection(process.env.RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: RPC_TIMEOUT_MS,
      fetchMiddleware: undefined
    });
  } catch (e) {
    throw new Error(
      `Gagal load SDK Meteora (${e.message.split('\n')[0]}).\n` +
      `Node 22+ (termasuk 26) butuh patch anchor: jalankan \`bash fix_node26.sh\` setelah npm install.\n` +
      `Atau gunakan Node 18/20. Tanpa patch, jalankan tanpa RPC_URL (dry-run aman).`
    );
  }
}

async function initLive() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY diperlukan untuk live mode.');
  // connection+SDK may already be set by initRead() (pool probe); only (re)set wallet here.
  if (!connection) await initRead();
  if (!wallet) {
    const raw = process.env.WALLET_PRIVATE_KEY.trim();
    let secretBytes;
    try {
      // Format 1: base64 of a JSON array of bytes  (e.g. from `Buffer.from(JSON.stringify([...])).toString('base64')`)
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const arr = JSON.parse(decoded);
      if (Array.isArray(arr) && arr.length === 64) {
        secretBytes = Uint8Array.from(arr);
      } else {
        throw new Error('not an array');
      }
    } catch {
      try {
        // Format 2: a JSON array pasted directly as text  (e.g. [1,2,3,...])
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length === 64) {
          secretBytes = Uint8Array.from(arr);
        } else {
          throw new Error('not an array');
        }
      } catch {
        // Format 3: base58 secret key (Solflare / solana-keygen / Phantom export)
        try {
          const bs58 = (await import('bs58')).default;
          secretBytes = bs58.decode(raw);
        } catch (e) {
          throw new Error(
            'WALLET_PRIVATE_KEY tidak dikenali. Gunakan salah satu:\n' +
            '  (a) base64 dari JSON array byte (lihat .env.bot.example), atau\n' +
            '  (b) base58 secret key (Solflare/phantom), atau\n' +
            '  (c) JSON array [..] langsung.\n' +
            'Error decode: ' + e.message
          );
        }
      }
    }
    if (!secretBytes || secretBytes.length !== 64) {
      throw new Error('WALLET_PRIVATE_KEY harus menghasilkan 64 byte (array/base58).');
    }
    wallet = Keypair.fromSecretKey(secretBytes);
  }
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    const res = await fetch(process.env.RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal
    });
    clearTimeout(t);
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
  // Skip if the tx already carries a ComputeBudget instruction (e.g. DLMM.swap adds its own),
  // otherwise we'd emit a duplicate ComputeUnitLimit and the tx is rejected.
  const hasCu = tx.instructions.some(ix =>
    ix.programId && ix.programId.equals(ComputeBudgetProgram.programId));
  if (hasCu) return tx;
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
// SDK swaps create the WSOL ATA themselves, but they do NOT wrap native SOL —
// so we do the wrap in a separate, self-contained tx BEFORE the swap.
// IMPORTANT: if a stale/corrupt WSOL ATA exists under the WRONG token program
// (e.g. Token-2022 from an earlier run), we must close+recreate it as SPL first,
// otherwise every swap fails with "Account not associated with this Mint" / "IllegalOwner".
// Build (but do NOT send) the WSOL wrap instructions: create ATA (if missing) + transfer SOL + syncNative.
// In atomic mode these are concatenated into the single combined transaction.
async function buildWrapIx(lamports) {
  // Wrap slightly LESS than `lamports` so the wallet keeps native SOL for the tx fee.
  const wrapAmount = lamports - 5_000;
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey);
  const SPL = TOKEN_PROGRAM_ID;
  let info = null;
  try {
    info = await withTimeout(connection.getAccountInfo(ata), RPC_TIMEOUT_MS, 'getAccountInfo WSOL ATA');
  } catch { info = null; }

  if (info && info.data) {
    if (!info.owner.equals(SPL)) {
      // Corrupt WSOL ATA (wrong program) — close then recreate. Return both instructions.
      const closeIx = createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], info.owner);
      return [
        closeIx,
        createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT, SPL),
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: wrapAmount }),
        createSyncNativeInstruction(ata, SPL)
      ];
    }
    // Healthy ATA present — just wrap.
    return [
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: wrapAmount }),
      createSyncNativeInstruction(ata, SPL)
    ];
  }
  // Fresh ATA + wrap.
  return [
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT, SPL),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: wrapAmount }),
    createSyncNativeInstruction(ata, SPL)
  ];
}

// Build (do NOT send) the WSOL close instruction (recover leftover lamports) — only if ATA exists.
// If a small WSOL balance remains (e.g. DLMM swap left a fee buffer), sync it back to native SOL
// before closing so the lamports aren't lost.
async function buildCloseWsolIx() {
  try {
    const ata = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey);
    let info;
    try {
      info = await withTimeout(connection.getAccountInfo(ata), RPC_TIMEOUT_MS, 'getAccountInfo WSOL ATA close');
    } catch { return null; }
    if (!info || !info.data) return null;
    let bal = 0n;
    try {
      const tb = await withTimeout(connection.getTokenAccountBalance(ata), RPC_TIMEOUT_MS, 'getTokenAccountBalance');
      bal = BigInt(tb.value.amount);
    } catch { bal = 0n; }
    dbg(`WSOL ATA close: bal=${bal} owner=${info.owner.toBase58()}`);
    const ixs = [];
    if (bal > 0n) {
      // Sync remaining WSOL -> native SOL before closing so it isn't burned.
      ixs.push(createSyncNativeInstruction(ata, info.owner));
    }
    ixs.push(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], info.owner));
    return ixs;
  } catch { return null; }
}

// Build (do NOT send) an ATA-creation instruction for `mint` if the ATA is missing/uninitialized.
async function buildAtaIx(mint) {
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
  const info = await withTimeout(connection.getAccountInfo(ata), 20000, 'getAccountInfo ATA');
  if (info && info.data) return null; // already exists
  const prog = await getMintProgram(mint);
  return createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, new PublicKey(mint), prog);
}

async function sendAndConfirm(tx, label) {
  let sig;
  try {
    sig = await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    // SendTransactionError carries .logs with the real revert reason.
    throw new Error(`${label} send failed: ${errorDetail(e)}`);
  }
  log(`      📨 ${label} sent: ${sig}`);
  const conf = await withTimeout(connection.confirmTransaction(sig, 'confirmed'), 30000, `${label} confirm`);
  if (conf.value.err) throw new Error(`${label} confirm err: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

// Determine DLMM swapForY from the actual input mint.
// DLMM swapForY = true  => swap X for Y (input is tokenX, output is tokenY)
// DLMM swapForY = false => swap Y for X (input is tokenY, output is tokenX)
function dlmmSwapForY(dlmmPool, inputMint) {
  return dlmmPool.tokenX.publicKey.toBase58() === inputMint;
}

// Compute-unit slippage for DLMM swapQuote (basis points; 100 = 1%)
function dlmmSlippageBps() {
  return new BN(Math.max(1, Math.round((parseFloat(process.env.SLIPPAGE_PCT || '1.0')) * 100)));
}

// Resolve the SPL vs Token-2022 program for a mint by reading its on-chain
// owner. This is the ONLY fully-reliable way — poolState.tokenAFlag can be
// wrong/missing, and a wrong program makes the SDK create the ATA under the
// wrong program => "Account not associated with this Mint" on swap.
async function getMintProgram(mint) {
  try {
    const info = await withTimeout(connection.getAccountInfo(new PublicKey(mint)), 20000, 'getAccountInfo mint');
    if (info && info.owner) return info.owner; // PublicKey of the token program
  } catch { /* fall through */ }
  return TOKEN_PROGRAM_ID;
}

// Extract a swap SDK's Transaction instructions into `out`, dropping any ComputeBudget
// instructions (we set a single CU limit/price on the combined atomic tx instead).
function appendSwapIxs(out, swapTx, label) {
  for (const ix of swapTx.instructions || []) {
    if (ix.programId && ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    out.push(ix);
  }
}

async function executeLive(route) {
  await initLive();
  const tokenMint = new PublicKey(route.tokenMint);
  const lamports = route.startAmountLamports;
  const allIxs = []; // collect ALL instructions -> one atomic transaction

  // Guard: wrapping needs native SOL = wrapAmount + tx fees, so require a buffer over the trade size.
  try {
    const bal = await withTimeout(connection.getBalance(wallet.publicKey), RPC_TIMEOUT_MS, 'getBalance');
    const needed = lamports + 10_000_000; // trade + ~0.01 SOL buffer for wrap/swap/close fees
    if (bal < needed) {
      warn(`⚠️ wallet SOL=${bal/1e9} < needed ${needed/1e9} SOL — wrap will fail with insufficient funds. Top up wallet.`);
      return [];
    }
    dbg(`wallet SOL=${bal/1e9} needed>=${needed/1e9}`);
  } catch { /* non-fatal */ }

  // Pre-build the leg-1 OUTPUT token ATA creation (if missing) — appended to the combined tx.
  const ataIx1 = await buildAtaIx(tokenMint);
  if (ataIx1) allIxs.push(ataIx1);

  let sigs = [];
  // ---------- Leg 1: SOL (WSOL) -> token (on the pool that contains WSOL) ----------
  if (route.leg1IsDlmm) {
    // DLMM does NOT wrap SOL itself — build the wrap instructions here.
    allIxs.push(...await buildWrapIx(lamports));
    const dlmmPool = await withTimeout(DLMM.create(connection, new PublicKey(route.leg1Pool.raw.address), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg1');
    const swapForY = dlmmSwapForY(dlmmPool, WSOL_MINT); // input = WSOL
    const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg1');
    const inLamports = lamports - 105_000; // wrapAmount(5k buffer) minus DLMM fee room
    const quote = await withTimeout(dlmmPool.swapQuote(new BN(inLamports), swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg1');
    const tx = await withTimeout(dlmmPool.swap({
      inToken: swapForY ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
      inAmount: new BN(inLamports),
      lbPair: dlmmPool.pubkey,
      user: wallet.publicKey,
      minOutAmount: quote.minOutAmount,
      outToken: swapForY ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey
    }), 25000, 'DLMM.swap leg1');
    appendSwapIxs(allIxs, tx, 'DLMM swap (leg1)');
    var leg1OutAmount = quote.outAmount;
  } else {
    const cpAmm = new CpAmm(connection);
    const poolState = await withTimeout(cpAmm.fetchPoolState(new PublicKey(route.leg1Pool.raw.address)), 20000, 'fetchPoolState leg1');
    const dammQuote = await withTimeout(cpAmm.getQuote({
      inAmount: new BN(lamports),
      inputTokenMint: NATIVE_MINT,
      slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'),
      poolState,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: 0,
      tokenADecimal: 9,
      tokenBDecimal: 9,
    }), 20000, 'getQuote leg1');
    const minOut1 = dammQuote?.minSwapOutAmount || new BN(0);
    const taProg = poolState.tokenAProgram || await getMintProgram(poolState.tokenAMint);
    const tbProg = poolState.tokenBProgram || await getMintProgram(poolState.tokenBMint);
    dbg(`leg1 tokenAMint=${poolState.tokenAMint} tokenAFlag=${poolState.tokenAFlag} onChainProg=${poolState.tokenAProgram && poolState.tokenAProgram} ownerA=${taProg.toBase58()}`);
    const tx = await withTimeout(cpAmm.swap({
      payer: wallet.publicKey,
      pool: new PublicKey(route.leg1Pool.raw.address),
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: tokenMint,
      amountIn: new BN(lamports),
      minimumAmountOut: minOut1,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: taProg,
      tokenBProgram: tbProg,
      referralTokenAccount: null,
      poolState
    }), 25000, 'CpAmm.swap leg1');
    appendSwapIxs(allIxs, tx, 'DAMMv2 swap (leg1)');
    var leg1OutAmount = dammQuote?.swapOutAmount || new BN(0);
  }

  // ---------- Leg 2: token -> USDC (on the pool that contains USDC) ----------
  const ataIx2 = await buildAtaIx(USDC_MINT);
  if (ataIx2) allIxs.push(ataIx2);
  if (route.leg2IsDlmm) {
    const dlmmPool = await withTimeout(DLMM.create(connection, new PublicKey(route.leg2Pool.raw.address), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg2');
    const swapForY = dlmmSwapForY(dlmmPool, tokenMint); // input = token
    const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg2');
    const quote = await withTimeout(dlmmPool.swapQuote(leg1OutAmount, swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg2');
    const tx2 = await withTimeout(dlmmPool.swap({
      inToken: swapForY ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
      inAmount: quote.outAmount,
      lbPair: dlmmPool.pubkey,
      user: wallet.publicKey,
      minOutAmount: quote.minOutAmount,
      outToken: swapForY ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey
    }), 25000, 'DLMM.swap leg2');
    appendSwapIxs(allIxs, tx2, 'DLMM swap (leg2)');
  } else {
    const cpAmm = new CpAmm(connection);
    const poolState = await withTimeout(cpAmm.fetchPoolState(new PublicKey(route.leg2Pool.raw.address)), 20000, 'fetchPoolState leg2');
    const dammQuote2 = await withTimeout(cpAmm.getQuote({
      inAmount: leg1OutAmount,
      inputTokenMint: tokenMint,
      slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'),
      poolState,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: 0,
      tokenADecimal: 9,
      tokenBDecimal: 9,
    }), 20000, 'getQuote leg2');
    const minOut2 = dammQuote2?.minSwapOutAmount || new BN(0);
    const taProg2 = poolState.tokenAProgram || await getMintProgram(poolState.tokenAMint);
    const tbProg2 = poolState.tokenBProgram || await getMintProgram(poolState.tokenBMint);
    log(`      [debug leg2] tokenAMint=${poolState.tokenAMint} tokenAFlag=${poolState.tokenAFlag} onChainProg=${poolState.tokenAProgram && poolState.tokenAProgram} ownerA=${taProg2.toBase58()}`);
    const tx2 = await withTimeout(cpAmm.swap({
      payer: wallet.publicKey,
      pool: new PublicKey(route.leg2Pool.raw.address),
      inputTokenMint: tokenMint,
      outputTokenMint: new PublicKey(USDC_MINT),
      amountIn: leg1OutAmount,
      minimumAmountOut: minOut2,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: taProg2,
      tokenBProgram: tbProg2,
      referralTokenAccount: null,
      poolState
    }), 25000, 'CpAmm.swap leg2');
    appendSwapIxs(allIxs, tx2, 'DAMMv2 swap (leg2)');
  }

  // Recover any leftover WSOL back to SOL (if ATA empty).
  const closeIx = await buildCloseWsolIx();
  if (closeIx) allIxs.push(...closeIx);

  // ---- Build ONE atomic transaction from all collected instructions ----
  const bigTx = new Transaction();
  bigTx.add(...allIxs);
  bigTx.feePayer = wallet.publicKey;
  const { blockhash } = await withTimeout(connection.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash atomic');
  bigTx.recentBlockhash = blockhash;
  // High CU limit for the combined tx (wrap + 2 swaps + ATAs + close).
  bigTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  bigTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  const sig = await sendAndConfirm(bigTx, 'ATOMIC swap (leg1+leg2)');
  sigs.push(sig);
  return { sent: true, venue: `${route.leg1Venue}→${route.leg2Venue}`, sigs };
}

// ---------- Pool usability verification (read-only, no funds) ----------
// After a candidate passes the price filter, we actually probe BOTH pools via the
// official Meteora SDK (DLMM swapQuote / DAMMv2 getQuote). If a pool is dead
// ("Pool price differs from estimated market price" / >5% away) the SDK throws —
// we catch it and skip the candidate so we never try to trade a stale pool.
async function verifyPoolUsable(route) {
  if (!connection) await initRead(); // read-only: no wallet needed
  try {
    // Probe Leg-1 pool (SOL/WSOL side)
    log(`      🔎 probing leg1 (${route.leg1Venue})...`);
    if (route.leg1IsDlmm) {
      const dlmmPool = await withTimeout(DLMM.create(connection, new PublicKey(route.leg1Pool.raw.address), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg1');
      const swapForY = dlmmSwapForY(dlmmPool, WSOL_MINT);
      const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg1');
      await withTimeout(dlmmPool.swapQuote(new BN(1e6), swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg1'); // tiny amount, read-only
    } else {
      const cpAmm = new CpAmm(connection);
      const ps = await withTimeout(cpAmm.fetchPoolState(new PublicKey(route.leg1Pool.raw.address)), 20000, 'fetchPoolState leg1');
      await withTimeout(cpAmm.getQuote({
        inAmount: new BN(1e6), inputTokenMint: new PublicKey(WSOL_MINT),
        slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'), poolState: ps,
        currentTime: Math.floor(Date.now() / 1000), currentSlot: 0,
        tokenADecimal: 9, tokenBDecimal: 9
      }), 20000, 'getQuote leg1');
    }
    log(`      🔎 probing leg2 (${route.leg2Venue})...`);
    // Probe Leg-2 pool (USDC side)
    if (route.leg2IsDlmm) {
      const dlmmPool = await withTimeout(DLMM.create(connection, new PublicKey(route.leg2Pool.raw.address), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg2');
      const swapForY = dlmmSwapForY(dlmmPool, route.tokenMint);
      const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg2');
      await withTimeout(dlmmPool.swapQuote(new BN(1e6), swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg2');
    } else {
      const cpAmm = new CpAmm(connection);
      const ps = await withTimeout(cpAmm.fetchPoolState(new PublicKey(route.leg2Pool.raw.address)), 20000, 'fetchPoolState leg2');
      await withTimeout(cpAmm.getQuote({
        inAmount: new BN(1e6), inputTokenMint: new PublicKey(route.tokenMint),
        slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'), poolState: ps,
        currentTime: Math.floor(Date.now() / 1000), currentSlot: 0,
        tokenADecimal: 9, tokenBDecimal: 9
      }), 20000, 'getQuote leg2');
    }
    log(`      ✅ pool probe OK (both venues tradeable)`);
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    // SDK load failure (e.g. Node 22+ incompatibility) — surface clearly.
    if (/Gagal load SDK|Node\.js 18\/20|not supported|Cannot find module|resolve ES modules/i.test(msg)) {
      return { ok: false, reason: 'SDK load error (Node version?)', deadish: false, fatal: true };
    }
    // Meteora rejects swaps when pool price >5% from market — that's a dead pool.
    const deadish = /price.*(differ|away|5%|market)|differs from|not tradable|no bin|empty/i.test(msg);
    if (!deadish) fail('pool probe', e);
    return { ok: false, reason: deadish ? 'dead pool (>5% from market)' : msg, deadish };
  }
}

// ---------- Main loop ----------
async function cycle() {
  console.log('='.repeat(64));
  log(`🔄 Scan cycle | MODE=${MODE} | minTVL=$${MIN_TVL} minMis=${MIN_MISPRICING}%`);
  try {
    const candidates = await scanForCandidates();
    log(`   Found ${candidates.length} mispricing candidate(s)`);
    if (candidates.length === 0) return;

    for (const c of candidates) {
      const startLamports = Math.floor(TRADE_AMOUNT_SOL * 1e9);

      // --- Adaptive cross-DEX route: mispriced pool quoted in USDC/USDT (not WSOL) ---
      // e.g. METEORA USDC-A misprice -> SOL->USDC->A->SOL via Jupiter (dexes restricted to the mispriced venue for hop2).
      if (c.crossDex && c.crossDex.quoteToken && c.crossDex.quoteToken !== WSOL_MINT) {
        const qt = c.crossDex.quoteToken === USDC_MINT ? ROUTER_USDC : ROUTER_USDT;
        log(`\n   🎯 CROSS-DEX ${c.symbol} | spread ${c.crossDex.spreadPct.toFixed(2)}% | quote=${qt.slice(0,6)} | cheap=${c.crossDex.cheapVenue}`);
        try {
          if (MODE === 'dry-run') {
            log(`      ⚪ dry-run: would execute adaptive SOL->${qt.slice(0,6)}->${c.tokenMint.slice(0,6)}->SOL via Jupiter`);
            continue;
          }
          initRouter(connection, wallet);
          const sigs = await executeAdaptiveRoute({
            tokenMint: c.tokenMint,
            quoteToken: qt,
            mispriceVenueDexes: c.crossDex.meteoraIsCheap ? 'Meteora' : undefined,
            startLamports
          });
          log(`      ✅ CROSS-DEX LIVE done: ${sigs.join(' , ')}`);
          for (const s of sigs) log(`      https://solscan.io/tx/${s}`);
        } catch (e) {
          fail('cross-dex execute', e);
        }
        continue;
      }

      const route = buildRoute(c, startLamports);
      if (!route) {
        // No WSOL-entry route (token has no WSOL pool in Meteora). Try adaptive transit
        // via Jupiter: SOL->USDC->A->SOL (only if token has a Meteora pool to capture misprice).
        const inMeteora = c.dlmmPool || c.dammPool;
        const tk = c.baseMint || c.tokenMint;
        const qtRaw = c.crossDex?.quoteToken;
        if (inMeteora && tk && c.crossDex && qtRaw && qtRaw !== WSOL_MINT) {
          const qt = qtRaw === USDC_MINT ? ROUTER_USDC : ROUTER_USDT;
          const sym = c.symbol || tk.slice(0, 6);
          log(`\n   🎯 CROSS-DEX ${sym} | spread ${c.crossDex.spreadPct.toFixed(2)}% | quote=${qt.slice(0,6)} | (no WSOL pool → adaptive SOL->${qt.slice(0,6)}->A->SOL)`);
          if (MODE === 'dry-run') {
            log(`      ⚪ dry-run: would execute adaptive route via Jupiter`);
            continue;
          }
          try {
            initRouter(connection, wallet);
            const sigs = await executeAdaptiveRoute({ tokenMint: tk, quoteToken: qt, mispriceVenueDexes: c.crossDex.meteoraIsCheap ? 'Meteora' : undefined, startLamports });
            log(`      ✅ CROSS-DEX LIVE done: ${sigs.join(' , ')}`);
            for (const s of sigs) log(`      https://solscan.io/tx/${s}`);
          } catch (e) { fail('cross-dex adaptive', e); }
        }
        continue;
      }

      // Skip noise: pools whose base token is one of our quote/input tokens
      // (e.g. SOL-USDT where the "token" is WSOL itself — an absurd route).
      if (QUOTE_MINTS.has(route.tokenMint)) {
        log(`\n   🎯 ${route.symbol} | mispricing ${c.mispricingPct.toFixed(2)}% | dir ${c.direction}`);
        log(`      ⚪ base token is ${route.tokenMint.slice(0,6)} (SOL/USDC/USDT) — skip (not a real arb target)`);
        continue;
      }

      log(`\n   🎯 ${route.symbol} | mispricing ${c.mispricingPct.toFixed(2)}% | dir ${c.direction}`);
      log(`      Route: SOL→${route.tokenMint.slice(0,6)} (${route.leg1Venue}) → ${route.tokenMint.slice(0,6)} (${route.leg2Venue}) → USDC`);
      log(`      TVL: DLMM=$${route.dlmmPool.tvlUsd.toFixed(0)} | DAMM=$${route.dammPool.tvlUsd.toFixed(0)} (min $${MIN_TVL})`);
      log(`      Vol24h: DLMM=$${route.dlmmPool.volume24h.toFixed(0)} | DAMM=$${route.dammPool.volume24h.toFixed(0)}`);

      // Verify both pools are actually usable (read-only SDK probe).
      // Catches dead/stale pools that slipped past the 20% price filter.
      if (process.env.RPC_URL) {
        const v = await verifyPoolUsable(route);
        if (!v.ok) {
          if (v.fatal) {
            warn(`      💥 ${v.reason} — live/probe tidak dapat berjalan. ${v.reason.includes('Node') ? 'Gunakan Node 18/20.' : ''}`);
            if (MODE === 'live') { warn('      Menghentikan siklus live.'); break; }
          } else {
            warn(`      💀 pool unusable (${v.reason}) — skip`);
          }
          continue;
        }
        log(`      🔍 pool probe OK (both venues tradeable)`);
      } else {
        warn('      ⚠️ no RPC_URL set — skipping live pool probe (set RPC_URL to verify tradability)');
      }

      // TVL/volume guard. For INTERNAL Meteora candidates (DLMM vs DAMMv2) we need BOTH
      // venues to clear the floor. For CROSS-DEX candidates (misprice vs Orca/Raydium/Jupiter)
      // only ONE Meteora pool is required (the other leg is routed via Jupiter).
      const isCrossDex = !!c.crossDex;
      const tvlFloor = MIN_TVL * 2;
      const dlmmOk = route.dlmmPool.tvlUsd >= tvlFloor;
      const dammOk = route.dammPool.tvlUsd >= tvlFloor;
      if (isCrossDex ? !(dlmmOk || dammOk) : (!dlmmOk || !dammOk)) {
        warn(`      💀 low TVL (DLMM $${route.dlmmPool.tvlUsd.toFixed(0)} / DAMM $${route.dammPool.tvlUsd.toFixed(0)} < $${tvlFloor}) — skip (dead/illiquid pool)`);
        continue;
      }
      if (route.dlmmPool.volume24h <= 0 || route.dammPool.volume24h <= 0) {
        warn(`      💀 zero volume (DLMM $${route.dlmmPool.volume24h.toFixed(0)} / DAMM $${route.dammPool.volume24h.toFixed(0)}) — skip (dead pool)`);
        continue;
      }
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
    // Surface the FULL error: message, SDK logs, and stack — never swallow.
    fail('scan cycle', err);
  }
}

// ---------- Entry ----------
console.log('🤖 Meteora DLMM⇄DAMMv2 Arbitrage Bot');
console.log(`   MODE=${MODE} | scan every ${SCAN_INTERVAL_MS / 1000}s | trade ${TRADE_AMOUNT_SOL} SOL`);
console.log(`   close-leg(USDC→SOL)=${ADD_CLOSE_LEG} | minProfit=${MIN_PROFIT_PCT}%`);

// TEST MODE: force a single MET (DLMM->DAMMv2) live swap to verify end-to-end.
// Usage: node arbitrage_bot.js test   |   or set TEST_MET=1
if (process.argv.includes('test') || process.env.TEST_MET === '1') {
  (async () => {
    try {
      const MET = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
      // Build a fake candidate with the real MET pools from the live API.
      const [dlmmRows, dammRows] = await Promise.all([
        fetchAllPages('DLMM', DLMM_API, MAX_PAGES),
        fetchAllPages('DAMM', DAMM_API, MAX_PAGES)
      ]);
      const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
      const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);
      if (!dlmmPoolMap.has(MET) || !dammPoolMap.has(MET)) {
        warn('TEST: MET pool missing from one venue — cannot test. dlmm?', dlmmPoolMap.has(MET), 'damm?', dammPoolMap.has(MET));
        process.exit(1);
      }
      const cand = { baseMint: MET, direction: 'BUY_A_SELL_B', mispricingPct: 99, dlmmPool: dlmmPoolMap.get(MET), dammPool: dammPoolMap.get(MET) };
      const route = buildRoute(cand, Math.floor(TRADE_AMOUNT_SOL * 1e9));
      if (!route) { warn('TEST: no valid WSOL route for MET'); process.exit(1); }
      log(`\n🧪 TEST MODE — forced ${route.leg1Venue}->${route.leg2Venue} (MET), ${TRADE_AMOUNT_SOL} SOL`);
      log(`   Route: SOL→${MET.slice(0,6)} (${route.leg1Venue}) → ${MET.slice(0,6)} (${route.leg2Venue}) → USDC`);
      const res = await executeLive(route);
      log(`   ✅ TEST swap done (${res.venue}): ${res.sigs.join(' , ')}`);
      for (const s of res.sigs) log(`   https://solscan.io/tx/${s}`);
      process.exit(0);
    } catch (e) {
      fail('TEST swap', e);
      process.exit(1);
    }
  })();
} else if (process.argv.includes('watch')) {
  // REAL-TIME mode: watch new/imbalanced Meteora pools via logsSubscribe, evaluate misprice, execute.
  (async () => {
    const { watchNewPools } = await import('./watcher.js');
    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    log(`\n👁️ WATCH MODE — real-time Meteora pool detection (execute on misprice > ${MIN_MISPRICING}%)`);
    watchNewPools({
      rpcUrl: RPC_URL,
      minMispricePct: MIN_MISPRICING,
      onCandidate: async (info) => {
        try {
          // Only act on pools that contain WSOL (so we can route SOL in) or USDC (route out).
          const hasWsol = info.tokenX === WSOL_MINT || info.tokenY === WSOL_MINT;
          const hasUsdc = info.tokenX === USDC_MINT || info.tokenY === USDC_MINT;
          const baseMint = info.tokenX === WSOL_MINT || info.tokenX === USDC_MINT ? info.tokenY
                         : info.tokenY === WSOL_MINT || info.tokenY === USDC_MINT ? info.tokenX : null;
          if (!baseMint) { dbg(`pool ${info.poolAddress.slice(0,8)} no WSOL/USDC — skip`); return; }
          log(`\n🆕 POOL ${info.venue} ${info.poolAddress.slice(0,10)} token=${baseMint.slice(0,6)} wsol=${hasWsol} usdc=${hasUsdc}`);
          // Fetch the counterpart pool (dlmm<->damm) for the same token to build a 2-hop route.
          const [dlmmRows, dammRows] = await Promise.all([
            fetchAllPages('DLMM', DLMM_API, MAX_PAGES),
            fetchAllPages('DAMM', DAMM_API, MAX_PAGES)
          ]);
          const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
          const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);
          if (!dlmmPoolMap.has(baseMint) || !dammPoolMap.has(baseMint)) {
            log(`   ⚪ counterpart pool missing for ${baseMint.slice(0,6)} — skip`); return;
          }
          const cand = { baseMint, direction: 'BUY_A_SELL_B', mispricingPct: 99, dlmmPool: dlmmPoolMap.get(baseMint), dammPool: dammPoolMap.get(baseMint) };
          const route = buildRoute(cand, Math.floor(TRADE_AMOUNT_SOL * 1e9));
          if (!route) { log(`   ⚪ no WSOL route for ${baseMint.slice(0,6)} — skip`); return; }
          // dry-run estimate first
          const sim = await dryRun(route);
          if (!sim) { log(`   ⚪ dry-run failed — skip`); return; }
          log(`   💡 est net ${sim.netPct.toFixed(2)}% (${route.leg1Venue}->${route.leg2Venue})`);
          if (sim.netPct >= MIN_PROFIT_PCT && MODE === 'live') {
            const res = await executeLive(route);
            log(`   ✅ WATCH executed (${res.venue}): ${res.sigs.join(' , ')}`);
            for (const s of res.sigs) log(`   https://solscan.io/tx/${s}`);
          } else {
            log(`   ⚪ below min profit (${MIN_PROFIT_PCT}%) — watch only`);
          }
        } catch (e) { fail('watch candidate', e); }
      }
    });
  })();
} else {
  cycle();
  setInterval(cycle, SCAN_INTERVAL_MS);
}
