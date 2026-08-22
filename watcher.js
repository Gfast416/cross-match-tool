// watcher.js — real-time detection of new/imbalanced Meteora pools.
// Primary: logsSubscribe (WebSocket) for <1s latency.
// Fallback: poll getSignaturesForAddress every few seconds (works on RPCs that block WS / logsSubscribe, e.g. Helius free 401).
// For each suspicious tx we read pool reserves on-chain and call onCandidate(poolInfo).

import { Connection, PublicKey } from '@solana/web3.js';
const dlmmMod = await import('@meteora-ag/dlmm');
const DLMM = dlmmMod.default || dlmmMod.DLMM;
const cpMod = await import('@meteora-ag/cp-amm-sdk');
const CpAmm = cpMod.CpAmm || cpMod.default;

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DAMMV2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

function getWsUrl(httpUrl) {
  // For Helius etc: https://x/?api-key=K -> wss://x/?api-key=K (NO trailing slash).
  if (httpUrl.startsWith('http')) return httpUrl.replace(/^http/, 'ws');
  return httpUrl;
}

async function handleTx(connection, sig, logs, onCandidate, minMispricePct, seen) {
  let tx;
  try { tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); }
  catch (e) { return; }
  if (!tx) return;
  const m = tx.transaction.message;
  // Resolve account keys. Versioned txs with Address Lookup Tables need resolution;
  // if getAccountKeys() throws (ALT not resolved), fall back to staticAccountKeys — the
  // Meteora PROGRAM ID is always in the static keys, so we can still detect + extract pool.
  let accountKeys;
  try {
    accountKeys = (typeof m.getAccountKeys === 'function')
      ? m.getAccountKeys().staticAccountKeys.map(k => k.toBase58())
      : (m.accountKeys || m.staticAccountKeys || []).map(k => k.toBase58());
  } catch {
    accountKeys = (m.staticAccountKeys || m.accountKeys || []).map(k => k.toBase58());
  }
  const ixs = m.compiledInstructions || m.instructions || [];
  const progIndices = [DLMM_PROGRAM, DAMMV2_PROGRAM];
  let poolAddr = null, isDlmm = false;
  for (const ix of ixs) {
    // versioned: ix.programIdIndex + ix.accountKeyIndexes[]; legacy: ix.programIdIndex + ix.accounts[]
    const pid = accountKeys[ix.programIdIndex];
    if (!pid || !progIndices.includes(pid)) continue;
    const firstAcct = ix.accountKeyIndexes ? ix.accountKeyIndexes[0] : ix.accounts?.[0];
    if (firstAcct === undefined) continue;
    poolAddr = accountKeys[firstAcct];
    isDlmm = pid === DLMM_PROGRAM;
    break;
  }
  if (!poolAddr) return;
  if (seen.has('pool:' + poolAddr)) return;
  seen.add('pool:' + poolAddr);

  try {
    let info;
    if (isDlmm) {
      const pool = await DLMM.create(connection, new PublicKey(poolAddr), { cluster: 'mainnet-beta' });
      info = {
        poolAddress: poolAddr, venue: 'DLMM',
        tokenX: pool.tokenX.publicKey.toBase58(), tokenY: pool.tokenY.publicKey.toBase58(),
        reserveX: pool.lbPair.reserveX, reserveY: pool.lbPair.reserveY,
        binStep: pool.lbPair.binStep
      };
    } else {
      const cp = new CpAmm(connection);
      const ps = await cp.fetchPoolState(new PublicKey(poolAddr));
      info = {
        poolAddress: poolAddr, venue: 'DAMMv2',
        tokenX: ps.tokenAMint?.toBase58?.() || ps.tokenA?.address, tokenY: ps.tokenBMint?.toBase58?.() || ps.tokenB?.address,
        reserveX: ps.tokenAAmount, reserveY: ps.tokenBAmount
      };
    }
    await onCandidate({ ...info, signature: sig, logs });
  } catch (e) {
    if (process.env.WATCH_DEBUG) console.warn('⚠️ handleTx pool read failed:', e.message);
    // pool may not be fully initialized yet — ignore
  }
}

/**
 * Watch new Meteora pools.
 * Tries WebSocket (logsSubscribe) first; if it fails (e.g. 401 on Helius free), falls back to
 * polling getSignaturesForAddress every `pollMs` ms. Either way, onCandidate is called for
 * each new pool with its on-chain reserves.
 */
export async function watchNewPools({ rpcUrl, onCandidate, minMispricePct = 3, seen = new Set(), wsUrl, pollMs = 3000 }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

  const isNew = (logs) => logs.some(l => /InitializeLbPair|InitializePool|AddLiquidity|Initialize|SingleSide|Swap|CollectFee/i.test(l));

  // --- Try WebSocket first ---
  try {
    const WebSocket = (await import('ws')).default;
    const endpoint = wsUrl || getWsUrl(rpcUrl);
    const ws = new WebSocket(endpoint);
    let reqId = 0;
    let wsOk = false;
    await new Promise((resolve) => {
      const t = setTimeout(() => { if (!wsOk) { try { ws.close(); } catch {} resolve(); } }, 4000);
      ws.on('open', () => {
        wsOk = true; clearTimeout(t);
        log('🔌 watcher WS open');
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method: 'logsSubscribe', params: [{ mentions: [DLMM_PROGRAM] }, { commitment: 'confirmed' }] }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method: 'logsSubscribe', params: [{ mentions: [DAMMV2_PROGRAM] }, { commitment: 'confirmed' }] }));
      });
      ws.on('error', (e) => { if (!wsOk) { clearTimeout(t); resolve(); } else log('⚠️ WS error', e.message); });
      ws.on('close', () => { if (wsOk) log('🔌 WS closed — restart recommended'); });
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.method !== 'logsNotification') return;
        const v = msg.params?.result?.value;
        const logs = v?.logs || [];
        const sig = v?.signature;
        if (!sig) return;
        // DEBUG: count all meteora-program txs seen
        if (process.env.WATCH_DEBUG) console.log(`[watch-dbg] tx ${sig.slice(0,8)} logs=${logs.length} newMatch=${isNew(logs)}`);
        if (!isNew(logs) || seen.has(sig)) return;
        seen.add(sig);
        handleTx(connection, sig, logs, onCandidate, minMispricePct, seen).catch(e => log('⚠️ handleTx', e.message));
      });
    });
    if (wsOk) return ws; // WS mode active
    log('⚠️ WS unavailable — falling back to polling mode');
  } catch (e) {
    log('⚠️ WS init failed:', e.message, '— falling back to polling');
  }

  // --- Polling fallback (no WS needed) ---
  log(`🔄 polling mode: getSignaturesForAddress every ${pollMs}ms`);
  const programs = [DLMM_PROGRAM, DAMMV2_PROGRAM];
  let lastSeen = { [DLMM_PROGRAM]: null, [DAMMV2_PROGRAM]: null };
  const loop = async () => {
    for (const prog of programs) {
      try {
        const sigs = await connection.getSignaturesForAddress(new PublicKey(prog), { limit: 8, commitment: 'confirmed', before: lastSeen[prog] || undefined });
        if (sigs.length) {
          lastSeen[prog] = sigs[0].signature; // anchor for next poll (newest first)
          // Process newest-last so we evaluate in chronological order
          for (const s of sigs.slice().reverse()) {
            if (seen.has('sig:' + s.signature)) continue;
            seen.add('sig:' + s.signature);
            const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
            if (!tx) continue;
            const logs = tx.meta?.logMessages || [];
            if (!isNew(logs)) continue;
            handleTx(connection, s.signature, logs, onCandidate, minMispricePct, seen).catch(e => log('⚠️ handleTx', e.message));
            await new Promise(r => setTimeout(r, 200));
          }
        }
      } catch (e) {
        log(`⚠️ poll ${prog.slice(0, 6)}:`, e.message);
      }
    }
    setTimeout(loop, pollMs);
  };
  loop();
  return null;
}
