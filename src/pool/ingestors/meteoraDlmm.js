// src/pool/ingestors/meteoraDlmm.js + meteoraDamm.js replaced by a single meteora.js?
// For compatibility we keep both files but point them at the real Meteora API.
import axios from 'axios';
import { normalizeMeteora } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG, warn } from '../../config.js';

// Termux networks sometimes ENOTFOUND one host but resolve another — try a chain.
const HOSTS = [
  'https://api.meteora.io/v1/pools',
  'https://dlmm.api.meteora.ag/v1/pools',
  'https://api.meteora.ag/v1/pools'
];

async function fetchMeteora(poolType, venue, { minTvl = MIN_TVL, maxPages = MAX_PAGES, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let rows = [];
    let lastErr;
    for (const base of HOSTS) {
      try {
        const { data } = await axios.get(base, { params: { page, pageSize, pool_type: poolType }, timeout: 10000 });
        rows = Array.isArray(data) ? data : (data?.data || data?.results || []);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) { warn(`${venue} ingest failed: ${lastErr.message}`); break; }
    if (!rows.length) break;
    for (const r of rows) {
      if (r.pool_type && r.pool_type !== poolType) continue;
      const p = normalizeMeteora(r, venue);
      if (p && p.tvlUsd >= minTvl) out.push(p);
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function fetchMeteoraDlmm(opts) { return fetchMeteora('dlmm', 'meteora-dlmm', opts); }
export async function fetchMeteoraDamm(opts) { return fetchMeteora('damm_v2', 'meteora-damm', opts); }
