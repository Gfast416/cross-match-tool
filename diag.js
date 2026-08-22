// diag.js — print ACTUAL reserve field names/values from a real Meteora pool on mainnet.
// Run: node diag.js <poolAddress>   (copy the address from "🆕 POOL DLMM <addr>")
// This tells us the EXACT field names so we stop guessing (reserveX vs reserveXAmount, etc).
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
try { dotenvConfig({ path: '.env.bot' }); } catch {}
try { dotenvConfig({ path: '.env' }); } catch {}
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = (process.env.RPC_URLS || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com').split(',')[0].trim();
const conn = new Connection(RPC, 'confirmed');
const addr = process.argv[2];
if (!addr) { console.log('Usage: node diag.js <poolAddress>'); process.exit(1); }

const dlmmMod = await import('@meteora-ag/dlmm');
const DLMM = dlmmMod.default || dlmmMod.DLMM;
const cpMod = await import('@meteora-ag/cp-amm-sdk');
const CpAmm = cpMod.CpAmm || cpMod.default;

try {
  const pool = await DLMM.create(conn, new PublicKey(addr), { cluster: 'mainnet-beta' });
  const lb = pool.lbPair;
  console.log('=== DLMM lbPair reserve-related fields ===');
  for (const k of Object.keys(lb)) {
    if (/reserve/i.test(k)) console.log(k, '=', String(lb[k]).slice(0, 40));
  }
  console.log('tokenX=', pool.tokenX.publicKey.toBase58(), 'dec=', pool.tokenX.decimals);
  console.log('tokenY=', pool.tokenY.publicKey.toBase58(), 'dec=', pool.tokenY.decimals);
} catch (e) {
  console.log('DLMM.create failed:', e.message, '-> trying DAMMv2');
  try {
    const cp = new CpAmm(conn);
    const ps = await cp.fetchPoolState(new PublicKey(addr));
    console.log('=== DAMMv2 fields ===');
    for (const k of Object.keys(ps)) {
      if (/amount|reserve|mint/i.test(k)) console.log(k, '=', String(ps[k]).slice(0, 40));
    }
  } catch (e2) { console.log('DAMMv2 also failed:', e2.message); }
}
