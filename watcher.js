// watcher.js — real-time detection of new pools across MULTIPLE DEXes (Meteora DLMM/DAMMv2 + Raydium V4).
// Primary: logsSubscribe (WebSocket) for <1s latency.
// Fallback: poll getSignaturesForAddress every few seconds (works on RPCs that block WS).
//
// Rate-limit handling (Helius free = strict 429):
//   - Accepts rpcUrls: string[] (round-robin) so N keys = Nx capacity.
//   - Limits concurrent tx processing (CONCURRENCY) so we never spam hundreds of reqs/sec.
//   - Only fetches a tx when its logs indicate a NEW pool (Initialize*), skipping Swap/CollectFee.

import { Connection, PublicKey } from '@solana/web3.js';
const dlmmMod = await import('@meteora-ag/dlmm');
const DLMM = dlmmMod.default || dlmmMod.DLMM;
const cpMod = await import('@meteora-ag/cp-amm-sdk');
const CpAmm = cpMod.CpAmm || cpMod.default;

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DAMMV2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const RAYDIUM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const CONCURRENCY = 3;          // max simultaneous tx evaluations
const POLL_MS = 4000;           // polling fallback interval

function getWsUrl(httpUrl) {
  if (httpUrl.startsWith('http')) return httpUrl.replace(/^http/, 'ws');
  return httpUrl;
}

// Retry a pool read up to 3x with 1s delay — new pools take 1-2s to be indexed by RPC.
async function withRetry(fn, tries = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs)); }
  }
  throw lastErr;
}

// Decode a pool by its known venue (do NOT cross-decode — Raydium's raw layout overlaps
// DLMM/DAMMv2 account bytes and would misread mints as reserves).
async function decodePoolAny(pickConn, poolAddr, venue) {
  const pk = new PublicKey(poolAddr);
  if (venue === 'RAYDIUM') {
    const conn = pickConn();
    const acc = await withRetry(() => conn.getAccountInfo(pk, { commitment: 'confirmed' }));
    if (acc && acc.data && acc.data.length > 300) {
      const buf = acc.data;
      const mintA = new PublicKey(buf.slice(0, 32)).toBase58();
      const mintB = new PublicKey(buf.slice(32, 64)).toBase58();
      const baseReserve = buf.readBigUInt64LE(256);
      const quoteReserve = buf.readBigUInt64LE(264);
      if (baseReserve > 0n && quoteReserve > 0n)
        return { poolAddress: poolAddr, venue: 'RAYDIUM', tokenX: mintA, tokenY: mintB, reserveX: baseReserve, reserveY: quoteReserve };
    }
    throw new Error('raydium account empty');
  }
  if (venue === 'DLMM') {
    const conn = pickConn();
    const pool = await withRetry(() => DLMM.create(conn, pk, { cluster: 'mainnet-beta' }));
    const lb = pool.lbPair;
    // Per Meteora docs: lbPair.reserveX/reserveY are VAULT pubkeys, NOT amounts.
    // Real reserves = token balances of those vault accounts.
    const [ax, ay] = await Promise.all([
      conn.getTokenAccountBalance(new PublicKey(lb.reserveX)),
      conn.getTokenAccountBalance(new PublicKey(lb.reserveY)),
    ]);
    const rx = BigInt(ax.value.amount);
    const ry = BigInt(ay.value.amount);
    if (rx <= 0n || ry <= 0n) throw new Error('vault balance zero');
    return {
      poolAddress: poolAddr, venue: 'DLMM',
      tokenX: pool.tokenX.publicKey.toBase58(), tokenY: pool.tokenY.publicKey.toBase58(),
      reserveX: rx, reserveY: ry, binStep: lb.binStep
    };
  }
  // DAMMv2
  const conn = pickConn();
  const cp = new CpAmm(conn);
  const ps = await withRetry(() => cp.fetchPoolState(pk));
  return {
    poolAddress: poolAddr, venue: 'DAMMv2',
    tokenX: ps.tokenAMint?.toBase58?.() || ps.tokenA?.address, tokenY: ps.tokenBMint?.toBase58?.() || ps.tokenB?.address,
    reserveX: ps.tokenAAmount, reserveY: ps.tokenBAmount
  };
}

// Only fetch txs that actually CREATE a pool (not swaps/fees) — cuts request volume ~20x.
const isNewPool = (logs) => logs.some(l => /InitializeLbPair|InitializePool|Initialize\b/i.test(l));

async function handleTx(pickConn, sig, logs, onCandidate, seen) {
  if (!isNewPool(logs)) return;        // skip Swap/CollectFee early — no RPC call
  const connection = pickConn();
  let tx;
  try { tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); }
  catch (e) { return; }
  if (!tx) return;
  const m = tx.transaction.message;
  let accountKeys;
  try {
    accountKeys = (typeof m.getAccountKeys === 'function')
      ? m.getAccountKeys().staticAccountKeys.map(k => k.toBase58())
      : (m.accountKeys || m.staticAccountKeys || []).map(k => k.toBase58());
  } catch {
    accountKeys = (m.staticAccountKeys || m.accountKeys || []).map(k => k.toBase58());
  }
  const ixs = m.compiledInstructions || m.instructions || [];
  const progIndices = [DLMM_PROGRAM, DAMMV2_PROGRAM, RAYDIUM_V4_PROGRAM];
  let poolAddr = null, isDlmm = false, isRaydium = false;
  for (const ix of ixs) {
    const pid = accountKeys[ix.programIdIndex];
    if (!pid || !progIndices.includes(pid)) continue;
    const firstAcct = ix.accountKeyIndexes ? ix.accountKeyIndexes[0] : ix.accounts?.[0];
    if (firstAcct === undefined) continue;
    poolAddr = accountKeys[firstAcct];
    isDlmm = pid === DLMM_PROGRAM;
    isRaydium = pid === RAYDIUM_V4_PROGRAM;
    break;
  }
  if (!poolAddr) return;
  if (seen.has('pool:' + poolAddr)) return;
  seen.add('pool:' + poolAddr);

  try {
    const venue = isRaydium ? 'RAYDIUM' : isDlmm ? 'DLMM' : 'DAMMv2';
    const info = await decodePoolAny(pickConn, poolAddr, venue);
    await onCandidate({ ...info, signature: sig, logs });
  } catch (e) {
    if (process.env.WATCH_DEBUG) console.warn(`⚠️ handleTx pool read failed [${isDlmm ? 'DLMM' : isRaydium ? 'RAYDIUM' : 'DAMMv2'}] ${poolAddr?.slice(0,8)}:`, e.message);
  }
}

export async function watchNewPools({ rpcUrls = [], onCandidate, seen = new Set(), wsUrl, pollMs = POLL_MS }) {
  const urls = Array.isArray(rpcUrls) ? rpcUrls : (rpcUrls ? [rpcUrls] : []);
  if (!urls.length) urls.push('https://api.mainnet-beta.solana.com');
  const connections = urls.map(u => new Connection(u, 'confirmed'));
  let rr = 0;
  const pickConn = () => connections[rr++ % connections.length];   // round-robin across RPC keys
  const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

  // --- Try WebSocket first (uses first RPC's WS endpoint) ---
  try {
    const WebSocket = (await import('ws')).default;
    const endpoint = wsUrl || getWsUrl(urls[0]);
    const ws = new WebSocket(endpoint);
    let reqId = 0, wsOk = false;
    let active = 0;
    const queue = [];
    const pump = () => { while (active < CONCURRENCY && queue.length) { active++; const job = queue.shift(); job().finally(() => { active--; pump(); }); } };

    await new Promise((resolve) => {
      const t = setTimeout(() => { if (!wsOk) { try { ws.close(); } catch {} resolve(); } }, 4000);
      ws.on('open', () => {
        wsOk = true; clearTimeout(t);
        log(`🔌 watcher WS open (${connections.length} RPC key(s))`);
        for (const prog of [DLMM_PROGRAM, DAMMV2_PROGRAM, RAYDIUM_V4_PROGRAM]) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method: 'logsSubscribe', params: [{ mentions: [prog] }, { commitment: 'confirmed' }] }));
        }
      });
      ws.on('error', (e) => { if (!wsOk) { clearTimeout(t); resolve(); } else log('⚠️ WS error', e.message); });
      ws.on('close', () => { if (wsOk) log('🔌 WS closed — restart recommended'); });
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.method !== 'logsNotification') return;
        const v = msg.params?.result?.value;
        const logs = v?.logs || [];
        const sig = v?.signature;
        if (!sig || seen.has('sig:' + sig)) return;
        seen.add('sig:' + sig);
        const np = isNewPool(logs);
        if (np && process.env.WATCH_DEBUG) console.log(`[watch-dbg] tx ${sig.slice(0,8)} newPool=true`);
        if (!np) return;   // only enqueue real pool creation (no per-tx spam)
        queue.push(() => handleTx(pickConn, sig, logs, onCandidate, seen).catch(e => log('⚠️ handleTx', e.message)));
        pump();
      });
    });
    if (wsOk) return ws;
    log('⚠️ WS unavailable — falling back to polling mode');
  } catch (e) {
    log('⚠️ WS init failed:', e.message, '— falling back to polling');
  }

  // --- Polling fallback ---
  log(`🔄 polling mode: getSignaturesForAddress every ${pollMs}ms (${connections.length} RPC key(s))`);
  const programs = [DLMM_PROGRAM, DAMMV2_PROGRAM, RAYDIUM_V4_PROGRAM];
  let active = 0;
  const loop = async () => {
    for (const prog of programs) {
      try {
        const conn = pickConn();
        const sigs = await conn.getSignaturesForAddress(new PublicKey(prog), { limit: 6, commitment: 'confirmed' });
        for (const s of sigs.slice().reverse()) {
          if (seen.has('sig:' + s.signature)) continue;
          seen.add('sig:' + s.signature);
          if (active >= CONCURRENCY) break;
          active++;
          handleTx(pickConn, s.signature, [], onCandidate, seen).finally(() => active--);
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) { log(`⚠️ poll ${prog.slice(0,6)}:`, e.message); }
    }
    setTimeout(loop, pollMs);
  };
  loop();
  return null;
}
