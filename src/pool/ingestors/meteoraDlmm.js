// src/pool/ingestors/meteoraDlmm.js + meteoraDamm.js replaced by a single meteora.js?
// For compatibility we keep both files but point them at the real Meteora API.
import axios from 'axios';
import { normalizeMeteora } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG } from '../../config.js';

// Verified endpoint (used by scanner.js): returns ALL Meteora pools (DLMM + DAMMv2 + others).
const API = 'https://api.meteora.io/v1/pools';

async function fetchMeteora(poolType, venue, { minTvl = MIN_TVL, maxPages = MAX_PAGES, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(API, { params: { page, pageSize, pool_type: poolType }, timeout: 10000 });
      const rows = Array.isArray(data) ? data : (data?.data || []);
      if (!rows.length) break;
      for (const r of rows) {
        // Only keep pools whose pool_type matches (API sometimes ignores the filter).
        if (r.pool_type && r.pool_type !== poolType) continue;
        const p = normalizeMeteora(r, venue);
        if (p && p.tvlUsd >= minTvl) out.push(p);
      }
      if (rows.length < pageSize) break;
    } catch (e) {
      if (DEBUG) console.warn(`[ingest] meteora ${venue} page`, page, 'failed:', e.message);
      break;
    }
  }
  return out;
}

export async function fetchMeteoraDlmm(opts) { return fetchMeteora('dlmm', 'meteora-dlmm', opts); }
export async function fetchMeteoraDamm(opts) { return fetchMeteora('damm_v2', 'meteora-damm', opts); }
