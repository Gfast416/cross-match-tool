// src/pool/ingestors/meteoraDlmm.js
import axios from 'axios';
import { normalizeMeteora } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG } from '../../config.js';

const API = 'https://dlmm.datapi.meteora.ag/pools';

export async function fetchMeteoraDlmm({ minTvl = MIN_TVL, maxPages = MAX_PAGES, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(API, { params: { page, pageSize, sort_by: 'tvl', order: 'desc', include_pool_without_tokens: false } });
      const rows = data?.data || data?.pools || data || [];
      if (!rows.length) break;
      for (const r of rows) {
        const p = normalizeMeteora(r, 'meteora-dlmm');
        if (p && p.tvlUsd >= minTvl) out.push(p);
      }
      if (rows.length < pageSize) break;
    } catch (e) {
      if (DEBUG) console.warn('[ingest] meteora-dlmm page', page, 'failed:', e.message);
      break;
    }
  }
  return out;
}
