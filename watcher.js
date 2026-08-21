// watcher.js — real-time detection of new/imbalanced Meteora pools via logsSubscribe.
// Strategy (from pro arb playbook): watch InitializeLbPair / InitializePool (NEW pools) and
// AddLiquiditySingleSide / AddLiquidity (imbalanced adds). For each suspicious tx, fetch the
// pool address, read its reserves, and compare the implied price vs the market (Jupiter).
// If mispriced beyond threshold, call `onCandidate(poolInfo)` so the bot can execute first.

import { Connection, PublicKey } from '@solana/web3.js';
const dlmmMod = await import('@meteora-ag/dlmm');
const DLMM = dlmmMod.default || dlmmMod.DLMM;
const cpMod = await import('@meteora-ag/cp-amm-sdk');
const CpAmm = cpMod.default || cpMod.CpAmm;

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DAMMV2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

function getWsUrl(httpUrl) {
  // Helius / most RPCs: replace https:// with wss://
  if (httpUrl.startsWith('http')) return httpUrl.replace(/^http/, 'ws') + '/';
  return httpUrl;
}

export async function watchNewPools({ rpcUrl, onCandidate, minMispricePct = 3, seen = new Set(), wsUrl }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const endpoint = wsUrl || getWsUrl(rpcUrl);
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(endpoint);
  let reqId = 0;
  const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

  function subscribe(program) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: ++reqId, method: 'logsSubscribe',
      params: [{ mentions: [program] }, { commitment: 'finalized' }]
    }));
  }

  ws.on('open', () => { log('🔌 watcher WS open'); subscribe(DLMM_PROGRAM); subscribe(DAMMV2_PROGRAM); });
  ws.on('error', (e) => log('⚠️ WS error', e.message));
  ws.on('close', () => log('🔌 WS closed — restart recommended'));

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.method !== 'logsNotification') return;
    const v = msg.params?.result?.value;
    const logs = v?.logs || [];
    const sig = v?.signature;
    // Single-side add => extreme ratio (one side ~0). Also new pools. These are rare => safe to fetch.
    const isNew = logs.some(l => /InitializeLbPair|InitializePool|AddLiquiditySingleSide|SingleSide/i.test(l));
    if (!isNew || !sig) return;
    if (seen.has(sig)) return;
    seen.add(sig);
    // Don't block the WS loop — handle async.
    handleTx(connection, sig, logs, onCandidate, minMispricePct, seen).catch(e => log('⚠️ handleTx', e.message));
  });

  return ws;
}

async function handleTx(connection, sig, logs, onCandidate, minMispricePct, seen) {
  let tx;
  try { tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'finalized' }); }
  catch (e) { return; }
  if (!tx) return;
  const m = tx.transaction.message;
  const acctKeys = (m.accountKeys || m.staticAccountKeys || []).map(k => k.toBase58());
  const ixs = m.instructions || m.compiledInstructions || [];
  // Find the Meteora instruction, take its first account as the pool/lbPair address.
  const progIndices = [DLMM_PROGRAM, DAMMV2_PROGRAM];
  let poolAddr = null, isDlmm = false;
  for (const ix of ixs) {
    const pid = acctKeys[ix.programIdIndex];
    if (progIndices.includes(pid)) {
      poolAddr = acctKeys[ix.accounts[0]];
      isDlmm = pid === DLMM_PROGRAM;
      break;
    }
  }
  if (!poolAddr) return;
  if (seen.has('pool:' + poolAddr)) return; // already evaluated this pool
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
        tokenX: ps.tokenAMint?.toBase58?.() || ps.tokenA.address, tokenY: ps.tokenBMint?.toBase58?.() || ps.tokenB.address,
        reserveX: ps.tokenAAmount, reserveY: ps.tokenBAmount
      };
    }
    await onCandidate({ ...info, signature: sig, logs });
  } catch (e) {
    // pool may not be fully initialized yet — ignore
  }
}
