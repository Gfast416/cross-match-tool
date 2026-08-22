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
// Also load .env.bot if present (our documented config file), since `dotenv/config`
// only auto-loads `.env`. Without this, RPC_URLS / WALLET_PRIVATE_KEY in .env.bot are ignored.
import { config as dotenvConfig } from 'dotenv';
try { dotenvConfig({ path: '.env.bot' }); } catch {}
try { dotenvConfig({ path: '.env' }); } catch {}
import BN from 'bn.js';
import { normalizePool, bestPool, findCandidates, findCrossDexMisprice, fetchAllPages, fetchRaydiumPools, fetchOrcaPools, fetchJupiterPrices, buildPriceGraph, findTriangularMisprice } from './scanner.js';
import { initRouter, executeAdaptiveRoute, WSOL as ROUTER_WSOL, quoteSameTokenArb, executeTriangularRoute, quoteTriangularArb } from './router.js';
import { initJito, executeRouteViaJito } from './executor/jito.js';

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

// ---------- Config ----------
const MODE = (process.env.MODE || 'dry-run').toLowerCase();
const TRADE_AMOUNT_SOL = parseFloat(process.env.TRADE_AMOUNT_SOL || '0.5');
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.3');
const MIN_TVL = parseFloat(process.env.MIN_TVL || process.argv[2] || '100');
const MIN_MISPRICING = parseFloat(process.env.MIN_MISPRICING || process.argv[3] || '0.5');
const ADD_CLOSE_LEG = (process.env.ADD_CLOSE_LEG || 'false').toLowerCase() === 'true';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '5', 10); // match cross_match.js (2500 pools/venue)
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || '20000', 10);

// ---------- Multi-RPC pool (Helius free rotation to avoid rate limits) ----------
// Configure via env:
//   RPC_URLS="https://first.helius-rpc.com,https://second.helius-rpc.com,https://third.helius-rpc.com"
//   (comma-separated, no spaces). Falls back to RPC_URL if RPC_URLS is unset.
// The pool rotates endpoints round-robin on every connection request so a single
// free-tier RPC's rate limit is spread across all of them.
const RPC_LIST = (process.env.RPC_URLS || process.env.RPC_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
let rpcCursor = 0;
const rpcFailStreak = new Map(); // endpoint -> consecutive failures
function rpcEndpoints() { return RPC_LIST.length ? RPC_LIST : [process.env.RPC_URL]; }
function nextRpcEndpoint() {
  const list = rpcEndpoints();
  // round-robin, but skip endpoints with a long failure streak
  for (let i = 0; i < list.length; i++) {
    const idx = (rpcCursor + i) % list.length;
    if ((rpcFailStreak.get(list[idx]) || 0) < 3) {
      rpcCursor = (idx + 1) % list.length;
      return list[idx];
    }
  }
  // all flagged; reset and return round-robin anyway
  rpcCursor = (rpcCursor + 1) % list.length;
  return list[rpcCursor === 0 ? list.length - 1 : rpcCursor - 1];
}
function markRpcSuccess(ep) { rpcFailStreak.set(ep, 0); }
function markRpcFail(ep) { rpcFailStreak.set(ep, (rpcFailStreak.get(ep) || 0) + 1); }

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
  log('   [scan] fetching Meteora DLMM/DAMMv2 pools...');
  // Fetch Meteora DLMM + DAMMv2 pools in parallel.
  const [dlmmRows, dammRows] = await Promise.all([
    fetchAllPages('DLMM', DLMM_API, MAX_PAGES).catch(e => { warn('DLMM fetch failed:', e.message); return []; }),
    fetchAllPages('DAMM', DAMM_API, MAX_PAGES).catch(e => { warn('DAMM fetch failed:', e.message); return []; })
  ]);
  log(`   [scan] Meteora: dlmm=${dlmmRows.length} damm=${dammRows.length}`);

  const dlmmPoolMap = normalizePool(dlmmRows, 'dlmm', MIN_TVL);
  const dammPoolMap = normalizePool(dammRows, 'damm', MIN_TVL);

  // --- Additional cross-DEX price sources for WIDER mispricing coverage ---
  // (Raydium, Orca, Jupiter aggregate) — a token can be fairly priced inside Meteora
  // but heavily mispriced vs other venues; that gap is arbitrageable via Meteora legs.
  log('   [scan] fetching Raydium + Orca pools...');
  const [raydiumPools, orcaPools] = await Promise.all([
    fetchRaydiumPools().catch(e => { warn('Raydium fetch failed:', e.message); return []; }),
    fetchOrcaPools().catch(e => { warn('Orca fetch failed:', e.message); return []; })
  ]);
  log(`   [scan] Raydium: ${raydiumPools.length} | Orca: ${orcaPools.length}`);
  log('   [scan] fetching Jupiter USD prices...');
  const allMints = [...new Set([...dlmmPoolMap.keys(), ...dammPoolMap.keys(), ...raydiumPools.map(p=>p.tokenMint||p.mintA), ...orcaPools.map(p=>p.tokenMint||p.mintA)])];
  const jupiterPrices = await fetchJupiterPrices(allMints).catch(e => { warn('Jupiter prices failed:', e.message); return {}; });
  log(`   [scan] Jupiter prices: ${Object.keys(jupiterPrices).length} mints`);

  const candidates = [];

  // 1) Internal Meteora check: DLMM vs DAMMv2 for the same token.
  const commonTokens = [...dlmmPoolMap.keys()].filter(m => dammPoolMap.has(m));
  for (const mint of commonTokens) {
    // FASE 1: pick the best DLMM (WSOL-side preferred) and best DAMMv2 (USDC-side preferred)
    // out of ALL pools for this token — not just the first one.
    const dlmmPool = bestPool(dlmmPoolMap.get(mint), WSOL_MINT);
    const dammPool = bestPool(dammPoolMap.get(mint), USDC_MINT);
    if (!dlmmPool || !dammPool) continue;
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
      Math.max(0.5, MIN_MISPRICING) // report spreads >=0.5% (user-tunable via minMis)
    );
    for (const cd of crossDex) {
      // Only keep ones where Meteora is on the cheap side (buy on Meteora) OR
      // where Meteora DLMM vs DAMMv2 itself diverges (already covered above).
      const dlmm = bestPool(dlmmPoolMap.get(cd.tokenMint), WSOL_MINT);
      const damm = bestPool(dammPoolMap.get(cd.tokenMint), USDC_MINT);
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
          tokenMint: cd.tokenMint,
          symbol: cd.symbol,
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

  // --- Triangular / multi-hop path finder (A→B→C→A across venues) ---
  try {
    // Triangular math needs a valid USD oracle. If Jupiter prices are empty (oracle down),
    // every computed spread is garbage (we saw 7,000,000% "arbs"). Skip until prices recover.
    if (Object.keys(jupiterPrices || {}).length === 0) {
      log('   [scan] triangular: skipped (no Jupiter USD prices — oracle down)');
    } else {
      log('   [scan] building price graph for triangular search...');
      const poolsByMint = new Map();
      const addPool = (p, venue) => {
        const m = p.tokenMint || p.mintA;
        if (!m) return;
        if (!poolsByMint.has(m)) poolsByMint.set(m, []);
        poolsByMint.get(m).push({ venue, tokenMint: m, priceUsd: p.priceUsd || p.price || 0, tvlUsd: p.tvlUsd || p.tvl || 0, volume24h: p.volume24h || 0, raw: p.raw || p });
      };
      for (const arr of dlmmPoolMap.values()) arr.forEach(p => addPool(p, 'meteora-dlmm'));
      for (const arr of dammPoolMap.values()) arr.forEach(p => addPool(p, 'meteora-damm'));
      (raydiumPools || []).forEach(p => addPool(p, 'raydium'));
      (orcaPools || []).forEach(p => addPool(p, 'orca'));

      const graph = buildPriceGraph(poolsByMint);
      const tri = findTriangularMisprice(graph, { hub: WSOL_MINT, minProfitPct: MIN_MISPRICING, maxTokens: 300 });
      log(`   [scan] triangular: ${tri.length} opportunity(s)`);
      for (const t of tri.slice(0, 10)) {
        candidates.push({
          type: 'triangular',
          baseMint: t.A,
          tokenMint: t.A,
          symbol: `${t.A.slice(0,4)}→${t.B.slice(0,4)}→SOL`,
          mispricingPct: t.netPct,
          netPct: t.netPct,
          route: t.route,
          source: 'triangular',
          tri
        });
      }
    }
  } catch (e) {
    warn(`[scan] triangular check failed: ${e.message}`);
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

  // Need a real USDC-side pool to close the loop (token -> USDC). If neither venue has a
  // USDC pool for this token, there is no internal DLMM->DAMMv2 route; return null so the
  // cycle falls back to the Jupiter adaptive branch (SOL->A->SOL).
  const leg2Real = (leg2IsDlmm ? candidate.dlmmPool.tvlUsd : candidate.dammPool.tvlUsd) > 0;
  if (!leg2Real) {
    log(`      ⚠️ no USDC-side pool for ${tokenMint.slice(0,6)} (only WSOL side) — internal route impossible; cross-dex branch will try Jupiter`);
    return null;
  }

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

let connections = {}, lastConn = null, wallet = null, CpAmm = null, DLMM = null, getTokenProgram = null;
function getConn() {
  const ep = nextRpcEndpoint();
  if (!connections[ep]) {
    connections[ep] = new Connection(ep, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: RPC_TIMEOUT_MS
    });
  }
  lastConn = connections[ep];
  return lastConn;
}

async function initRead() {
  if (Object.keys(connections).length) return;
  try {
    const dlmmMod = await import('@meteora-ag/dlmm');
    const cpAmmMod = await import('@meteora-ag/cp-amm-sdk');
    DLMM = dlmmMod.default || dlmmMod.DLMM;
    CpAmm = cpAmmMod.CpAmm || cpAmmMod.default?.CpAmm || cpAmmMod.default;
    getTokenProgram = cpAmmMod.getTokenProgram || (() => TOKEN_PROGRAM_ID);
    // Warm up the connection pool (one Connection per RPC endpoint).
    for (const ep of rpcEndpoints()) {
      if (!connections[ep]) {
        connections[ep] = new Connection(ep, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: RPC_TIMEOUT_MS
        });
      }
    }
    lastConn = getConn();
  } catch (e) {
    throw new Error(
      `Gagal load SDK Meteora (${e.message.split('\\n')[0]}).\n` +
      `Node 22+ (termasuk 26) butuh patch anchor: jalankan \`bash fix_node26.sh\` setelah npm install.\n` +
      `Atau gunakan Node 18/20. Tanpa patch, jalankan tanpa RPC_URL (dry-run aman).`
    );
  }
}

async function initLive() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY diperlukan untuk live mode.');
  // connection+SDK may already be set by initRead() (pool probe); only (re)set wallet here.
  if (!Object.keys(connections).length) await initRead();
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
    // Init Jito bundle executor (atomic multi-tx). Uses JITO_ENDPOINT or default block engine.
    try { initJito(getConn(), wallet); } catch (e) { warn('Jito init skipped:', e.message); }
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
    const res = await fetch(nextRpcEndpoint(), {
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
    info = await withTimeout(getConn().getAccountInfo(ata), RPC_TIMEOUT_MS, 'getAccountInfo WSOL ATA');
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
      info = await withTimeout(getConn().getAccountInfo(ata), RPC_TIMEOUT_MS, 'getAccountInfo WSOL ATA close');
    } catch { return null; }
    if (!info || !info.data) return null;
    let bal = 0n;
    try {
      const tb = await withTimeout(getConn().getTokenAccountBalance(ata), RPC_TIMEOUT_MS, 'getTokenAccountBalance');
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
  const info = await withTimeout(getConn().getAccountInfo(ata), 20000, 'getAccountInfo ATA');
  if (info && info.data) return null; // already exists
  const prog = await getMintProgram(mint);
  return createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, new PublicKey(mint), prog);
}

async function sendAndConfirmVersioned(tx, label) {
  let sig;
  try {
    sig = await getConn().sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    throw new Error(`${label} send failed: ${errorDetail(e)}`);
  }
  log(`      📨 ${label} sent: ${sig}`);
  const conf = await withTimeout(getConn().confirmTransaction(sig, 'confirmed'), 30000, `${label} confirm`);
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
    const info = await withTimeout(getConn().getAccountInfo(new PublicKey(mint)), 20000, 'getAccountInfo mint');
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
    const bal = await withTimeout(getConn().getBalance(wallet.publicKey), RPC_TIMEOUT_MS, 'getBalance');
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
    const dlmmPool = await withTimeout(DLMM.create(getConn(), new PublicKey(route.leg1Pool.raw.address), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg1');
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
    const leg1Addr = route.leg1Pool?.raw?.address;
    if (!leg1Addr) throw new Error(`leg1 pool has no on-chain address (stub pool) — cannot execute internal route`);
    const cpAmm = new CpAmm(getConn());
    const poolState = await withTimeout(cpAmm.fetchPoolState(new PublicKey(leg1Addr)), 20000, 'fetchPoolState leg1');
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
    const leg2Addr = route.leg2Pool?.raw?.address;
    if (!leg2Addr) throw new Error(`leg2 pool has no on-chain address (stub pool) — cannot execute internal route`);
    const dlmmPool = await withTimeout(DLMM.create(getConn(), new PublicKey(leg2Addr), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg2');
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
    const leg2Addr = route.leg2Pool?.raw?.address;
    if (!leg2Addr) throw new Error(`leg2 pool has no on-chain address (stub pool) — cannot execute internal route`);
    const cpAmm = new CpAmm(getConn());
    const poolState = await withTimeout(cpAmm.fetchPoolState(new PublicKey(leg2Addr)), 20000, 'fetchPoolState leg2');
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

  // ---- Build ONE atomic versioned transaction from all collected instructions ----
  const microPrio = await getPriorityFeeMicroLamports(); // dynamic (Helius Min), free
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const prioIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microPrio || 50_000 });
  const allIxsFinal = [computeIx, prioIx, ...allIxs];

  const { blockhash, lastValidBlockHeight } = await withTimeout(
    getConn().getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash atomic'
  );
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: allIxsFinal,
  }).compileToV0Message(); // v0 (supports ALT); we don't need a lookup table for a 2-hop route
  const bigTx = new VersionedTransaction(messageV0);
  bigTx.sign([wallet]);

  // PRO guard: simulate BEFORE paying. Catches reverts (price moved, slippage, bad mint)
  // without burning SOL. Free RPC call.
  try {
    const sim = await withTimeout(getConn().simulateTransaction(bigTx), RPC_TIMEOUT_MS, 'simulate atomic');
    if (sim.value.err) {
      const reason = JSON.stringify(sim.value.err);
      const logs = (sim.value.logs || []).slice(-6).join('\n');
      warn(`      🛑 simulate FAILED (skip, no SOL burned): ${reason}\n${logs}`);
      return [];
    }
    const cu = sim.value.unitsConsumed || 0;
    dbg(`simulate OK — unitsConsumed=${cu}`);
  } catch (e) {
    warn(`      ⚠️ simulate error (proceeding anyway): ${e.message}`);
  }

  const sig = await sendAndConfirmVersioned(bigTx, 'ATOMIC swap (leg1+leg2)');
  sigs.push(sig);
  return { sent: true, venue: `${route.leg1Venue}→${route.leg2Venue}`, sigs };
}

// ---------- Pool usability verification (read-only, no funds) ----------
// After a candidate passes the price filter, we actually probe BOTH pools via the
// official Meteora SDK (DLMM swapQuote / DAMMv2 getQuote). If a pool is dead
// ("Pool price differs from estimated market price" / >5% away) the SDK throws —
// we catch it and skip the candidate so we never try to trade a stale pool.
async function verifyPoolUsable(route) {
  if (!Object.keys(connections).length) await initRead(); // read-only: no wallet needed
  try {
    // Probe Leg-1 pool (SOL/WSOL side)
    log(`      🔎 probing leg1 (${route.leg1Venue})...`);
    const leg1Addr = route.leg1Pool?.raw?.address;
    if (!leg1Addr) { log(`      ⚠️ leg1 raw.address missing — skip probe`); }
    else if (route.leg1IsDlmm) {
      const dlmmPool = await withTimeout(DLMM.create(getConn(), new PublicKey(leg1Addr), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg1');
      const swapForY = dlmmSwapForY(dlmmPool, WSOL_MINT);
      const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg1');
      await withTimeout(dlmmPool.swapQuote(new BN(1e6), swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg1'); // tiny amount, read-only
    } else {
      const cpAmm = new CpAmm(getConn());
      const ps = await withTimeout(cpAmm.fetchPoolState(new PublicKey(leg1Addr)), 20000, 'fetchPoolState leg1');
      await withTimeout(cpAmm.getQuote({
        inAmount: new BN(1e6), inputTokenMint: new PublicKey(WSOL_MINT),
        slippage: parseFloat(process.env.SLIPPAGE_PCT || '1.0'), poolState: ps,
        currentTime: Math.floor(Date.now() / 1000), currentSlot: 0,
        tokenADecimal: 9, tokenBDecimal: 9
      }), 20000, 'getQuote leg1');
    }
    log(`      🔎 probing leg2 (${route.leg2Venue})...`);
    // Probe Leg-2 pool (USDC side)
    const leg2Addr = route.leg2Pool?.raw?.address;
    if (!leg2Addr) { log(`      ⚠️ leg2 raw.address missing — skip probe`); }
    else if (route.leg2IsDlmm) {
      const tokenMint = route.baseMint || route.tokenMint;
      const dlmmPool = await withTimeout(DLMM.create(getConn(), new PublicKey(leg2Addr), { cluster: 'mainnet-beta' }), 20000, 'DLMM.create leg2');
      const swapForY = dlmmSwapForY(dlmmPool, tokenMint);
      const binArrays = await withTimeout(dlmmPool.getBinArrayForSwap(swapForY), 20000, 'getBinArrayForSwap leg2');
      await withTimeout(dlmmPool.swapQuote(new BN(1e6), swapForY, dlmmSlippageBps(), binArrays), 20000, 'swapQuote leg2');
    } else {
      const tokenMint = route.baseMint || route.tokenMint;
      const cpAmm = new CpAmm(getConn());
      const ps = await withTimeout(cpAmm.fetchPoolState(new PublicKey(leg2Addr)), 20000, 'fetchPoolState leg2');
      await withTimeout(cpAmm.getQuote({
        inAmount: new BN(1e6), inputTokenMint: new PublicKey(tokenMint),
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

      // --- Triangular / multi-hop (A→B→C→SOL across venues) ---
      if (c.type === 'triangular') {
        const net = c.netPct || 0;
        log(`\n   🔺 TRIANGULAR ${c.symbol} | est net ${net.toFixed(2)}% | route ${c.route.map(m=>m.slice(0,4)).join('→')}`);
        if (net < MIN_PROFIT_PCT) { log(`      ⚪ below min profit (${MIN_PROFIT_PCT}%) — skip`); continue; }
        try {
          if (MODE === 'dry-run') {
            log(`      ⚪ dry-run: would execute 3-hop SOL→${c.route[1].slice(0,6)}→${c.route[2].slice(0,6)}→SOL via Jupiter`);
            continue;
          }
          if (!wallet) { warn('      ⚠️ wallet not initialized — skip live triangular'); continue; }
          initRouter(getConn(), wallet);
          const { quoteTriangularArb, executeTriangularRoute } = await import('./router.js');
          const q = await quoteTriangularArb({ route: c.route, startLamports });
          log(`      ⚪ live quote net ${q.netPct.toFixed(2)}% (${q.netSol.toFixed(6)} SOL)`);
          if (q.netPct < MIN_PROFIT_PCT) { log(`      ⚪ live quote below min — skip`); continue; }
          // Prefer Jito bundle (atomic, anti-sandwich); fall back to Helius 3-tx if Jito fails.
          try {
            const jr = await executeRouteViaJito(c.route, startLamports, { tipLamports: Number(process.env.JITO_TIP_LAMPORTS || 2000) });
            log(`      ✅ TRIANGULAR LIVE done (Jito bundle): ${jr.bundleId}`);
            log(`      https://explorer.jito.wtf/bundle/${jr.bundleId}`);
          } catch (je) {
            warn(`      ⚠️ Jito failed (${je.message}) — falling back to Helius 3-tx`);
            const sigs = await executeTriangularRoute({ route: c.route, startLamports });
            log(`      ✅ TRIANGULAR LIVE done (Helius 3-tx): ${sigs.join(' , ')}`);
            for (const s of sigs) log(`      https://solscan.io/tx/${s}`);
          }
        } catch (e) {
          warn(`      ⚠️ triangular execute failed: ${e.message}`);
        }
        continue;
      }

      // --- Adaptive cross-DEX route: mispriced pool quoted in USDC/USDT (not WSOL) ---
      // e.g. METEORA USDC-A misprice -> SOL->USDC->A->SOL via Jupiter (dexes restricted to the mispriced venue for hop2).
      if (c.crossDex && c.crossDex.quoteToken && c.crossDex.quoteToken !== WSOL_MINT) {
        // Use the REAL quote token of the mispriced Meteora pool — can be USDC, USDT, JUP,
        // BONK, PUMP, ANY token. Do NOT force USDC/USDT (user: "bisa apa aja").
        const qt = c.crossDex.quoteToken;
        const tk = c.baseMint || c.tokenMint;
        const spread = c.crossDex.spreadPct || 0;
        // Skip near-zero / noise spreads (e.g. 0.00%) — not a real arb.
        if (spread < MIN_MISPRICING) {
          log(`\n   🎯 CROSS-DEX ${c.symbol} | spread ${spread.toFixed(2)}% | quote=${qt.slice(0,6)} | cheap=${c.crossDex.cheapVenue}`);
          log(`      ⚪ spread < ${MIN_MISPRICING}% — skip (noise)`);
          continue;
        }
        log(`\n   🎯 CROSS-DEX ${c.symbol} | spread ${spread.toFixed(2)}% | quote=${qt.slice(0,6)} | cheap=${c.crossDex.cheapVenue}`);
        try {
          if (MODE === 'dry-run') {
            try {
              const q = await quoteSameTokenArb({ tokenMint: tk, buyVenue: c.crossDex.meteoraIsCheap ? 'Meteora' : undefined, sellVenue: undefined, startLamports });
              log(`      ⚪ dry-run: SOL->${qt.slice(0,6)}->${tk.slice(0,6)}->SOL net ${q.netPct.toFixed(2)}% (${q.netSol.toFixed(6)} SOL) [Jupiter quote]`);
            } catch (e) {
              log(`      ⚪ dry-run: would execute adaptive SOL->${qt.slice(0,6)}->${tk.slice(0,6)}->SOL via Jupiter (quote failed: ${e.message})`);
            }
            continue;
          }
          if (!wallet) { warn('      ⚠️ wallet not initialized (check WALLET_PRIVATE_KEY) — skip live cross-dex'); continue; }
          initRouter(getConn(), wallet);
          // Build the 3-hop route array SOL->quote->token->quote->SOL for Jito bundle.
          const route3 = [WSOL_MINT, qt, tk, qt, WSOL_MINT];
          try {
            const jr = await executeRouteViaJito(route3, startLamports, { tipLamports: Number(process.env.JITO_TIP_LAMPORTS || 2000) });
            log(`      ✅ CROSS-DEX LIVE done (Jito bundle): ${jr.bundleId}`);
            log(`      https://explorer.jito.wtf/bundle/${jr.bundleId}`);
          } catch (je) {
            warn(`      ⚠️ Jito failed (${je.message}) — fallback to 3 separate Jupiter tx (NOT atomic)`);
            const sigs = await executeAdaptiveRoute({
              tokenMint: tk,
              quoteToken: qt,
              mispriceVenueDexes: c.crossDex.meteoraIsCheap ? 'Meteora' : undefined,
              startLamports
            });
            log(`      ✅ CROSS-DEX LIVE done (Helius 3-tx): ${sigs.join(' , ')}`);
            for (const s of sigs) log(`      https://solscan.io/tx/${s}`);
          }
        } catch (e) {
          fail('cross-dex execute', e);
        }
        continue;
      }

      const route = buildRoute(c, startLamports);
      if (!route) {
        // No WSOL-entry route (token has no WSOL pool in Meteora). Try adaptive transit
        // via Jupiter: SOL->quoteToken->A->quoteToken->SOL using whatever DEX holds the pools.
        // quoteToken can be USDC, USDT, PUMP, BONK, etc. — any token the mispriced Meteora
        // pool is quoted in.
        const inMeteora = c.dlmmPool || c.dammPool;
        const tk = c.baseMint || c.tokenMint;
        const qtRaw = c.crossDex?.quoteToken;
        // Skip only if there's truly no Meteora pool, or the quote token is WSOL (redundant loop).
        if (inMeteora && tk && c.crossDex && qtRaw && qtRaw !== WSOL_MINT) {
          const sym = c.symbol || tk.slice(0, 6);
          const spr = c.crossDex.spreadPct || 0;
          if (spr < MIN_MISPRICING) {
            log(`\n   🎯 CROSS-DEX ${sym} | spread ${spr.toFixed(2)}% | quote=${qtRaw.slice(0,6)} | (adaptive)`);
            log(`      ⚪ spread < ${MIN_MISPRICING}% — skip (noise)`);
            continue;
          }
          if (MODE === 'dry-run') {
            log(`      ⚪ dry-run: would execute adaptive route via Jupiter (DEX-agnostic)`);
            continue;
          }
          try {
            initRouter(getConn(), wallet);
            const sigs = await executeAdaptiveRoute({ tokenMint: tk, quoteToken: qtRaw, mispriceVenueDexes: c.crossDex.meteoraIsCheap ? 'Meteora' : undefined, startLamports });
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
      // For cross-dex candidates we route via Jupiter (not Meteora SDK swaps), so skip the Meteora probe.
      if (rpcEndpoints().length && !c.crossDex) {
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
        if (c.crossDex) log('      ⏭️ cross-dex route — skipping Meteora probe (routed via Jupiter)');
        else warn('      ⚠️ no RPC_URL set — skipping live pool probe (set RPC_URLS to verify tradability)');
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
      // Volume guard. For internal Meteora (both pools) require both >0. For cross-dex/single-pool
      // only require the pool(s) that actually exist (a stub pool has volume24h=0 by design).
      const dlmmVolOk = route.dlmmPool.tvlUsd > 0 ? route.dlmmPool.volume24h > 0 : true;
      const dammVolOk = route.dammPool.tvlUsd > 0 ? route.dammPool.volume24h > 0 : true;
      if (dlmmVolOk && dammVolOk) {
        // both existing pools have volume — OK
      } else {
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
        if (!process.env.WALLET_PRIVATE_KEY || !rpcEndpoints().length) {
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
      const cand = { baseMint: MET, direction: 'BUY_A_SELL_B', mispricingPct: 99, dlmmPool: bestPool(dlmmPoolMap.get(MET), WSOL_MINT), dammPool: bestPool(dammPoolMap.get(MET), USDC_MINT) };
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
    const { mintUsdFromPool } = await import('./onchain.js');
    const { jupQuote } = await import('./router.js');
    const RPC_URL = rpcEndpoints()[0] || 'https://api.mainnet-beta.solana.com';
    log(`\n👁️ WATCH MODE — real-time Meteora pool detection (execute on misprice > ${MIN_MISPRICING}%)`);
    watchNewPools({
      rpcUrl: RPC_URL,
      minMispricePct: MIN_MISPRICING,
      onCandidate: async (info) => {
        try {
          const RPC = rpcEndpoints()[0];
          const conn = new (await import('@solana/web3.js')).Connection(RPC, 'confirmed');
          // info: { poolAddress, venue, tokenX, tokenY, reserveX, reserveY } (reserves already on-chain from watcher)
          const hasWsol = info.tokenX === WSOL_MINT || info.tokenY === WSOL_MINT;
          const hasUsdc = info.tokenX === USDC_MINT || info.tokenY === USDC_MINT;
          const anchorMint = hasWsol ? WSOL_MINT : hasUsdc ? USDC_MINT : null;
          if (!anchorMint) { dbg(`pool ${info.poolAddress.slice(0,8)} no WSOL/USDC anchor — skip`); return; }
          const baseMint = info.tokenX === anchorMint ? info.tokenY : info.tokenX;
          log(`\n🆕 POOL ${info.venue} ${info.poolAddress.slice(0,10)} base=${baseMint.slice(0,6)} anchor=${anchorMint.slice(0,4)}`);

          // 1) On-chain price of base token (reverse from reserves).
          const onchain = { tokenX: info.tokenX, tokenY: info.tokenY, reserveX: info.reserveX, reserveY: info.reserveY, priceXinY: (Number(info.reserveY)/Math.pow(10,9)) / (Number(info.reserveX)/Math.pow(10,9)) };
          // 2) USD anchor: quote SOL->USDC and SOL->base via Jupiter (executable prices).
          const startLamports = Math.floor(TRADE_AMOUNT_SOL * 1e9);
          const qUsdc = await jupQuote(WSOL_MINT, USDC_MINT, startLamports, {}).catch(() => null);
          const qBase = await jupQuote(WSOL_MINT, baseMint, startLamports, {}).catch(() => null);
          if (!qUsdc || !qBase) { log(`   ⚪ jupiter quote unavailable — skip`); return; }
          const usdcPerSol = Number(qUsdc.outAmount) / 1e6;        // USDC has 6 decimals
          const basePerSol = Number(qBase.outAmount) / 1e9;        // base assumed 9 decimals
          const anchorUsd = usdcPerSol;                             // 1 SOL = usdcPerSol USD
          const baseUsdJup = (1 / basePerSol) * anchorUsd;          // Jupiter USD price of base

          // 3) On-chain USD price of base (reverse): anchor price * (base per anchor from reserves).
          //    priceXinY = anchor per base (if anchor is X) or base per anchor (if anchor is Y).
          let baseUsdOnchain;
          if (info.tokenX === anchorMint) baseUsdOnchain = anchorUsd / onchain.priceXinY; // anchor=base of priceXinY
          else baseUsdOnchain = anchorUsd * onchain.priceXinY;       // anchor=quote of priceXinY

          if (!baseUsdOnchain || !baseUsdJup) { log(`   ⚪ price compute failed — skip`); return; }
          const spreadPct = ((baseUsdJup - baseUsdOnchain) / baseUsdOnchain) * 100;
          log(`   💡 onchain $${baseUsdOnchain.toFixed(6)} vs jupiter $${baseUsdJup.toFixed(6)} -> spread ${spreadPct.toFixed(2)}%`);

          // 4) If mispriced beyond threshold, execute a 3-hop route via Jito bundle atomically.
          if (Math.abs(spreadPct) >= MIN_MISPRICING && MODE === 'live') {
            const route = [WSOL_MINT, anchorMint, baseMint, anchorMint, WSOL_MINT];
            try {
              const jr = await executeRouteViaJito(route, startLamports, { tipLamports: Number(process.env.JITO_TIP_LAMPORTS || 2000) });
              log(`   🚀 WATCH executed (Jito bundle): ${jr.bundleId}`);
              log(`   https://explorer.jito.wtf/bundle/${jr.bundleId}`);
            } catch (je) {
              warn(`   ⚠️ Jito failed (${je.message}) — skip`);
            }
          } else {
            log(`   ⚪ spread < min (${MIN_MISPRICING}%) — watch only`);
          }
        } catch (e) { fail('watch candidate', e); }
      }
    });
  })();
} else {
  (async () => {
    if (MODE === 'live') {
      try {
        await initLive(); // sets wallet + connections BEFORE any cycle runs
      } catch (e) {
        fail('initLive', e);
        process.exit(1);
      }
    } else {
      try { await initRead(); } catch (e) { warn('initRead skipped: ' + e.message); }
    }
    await cycle();
    if (MODE !== 'live') return; // dry-run: single pass
    let running = false;
    const loop = async () => {
      if (running) return;
      running = true;
      try { await cycle(); } catch (e) { warn(`cycle error: ${e.message}`); }
      finally { running = false; }
      setTimeout(loop, SCAN_INTERVAL_MS);
    };
    setTimeout(loop, SCAN_INTERVAL_MS);
  })();
}
