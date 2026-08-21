// src/pool/ingestors/meteoraDamm.js
import axios from 'axios';
import { normalizeMeteora } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG } from '../../config.js';

const API = 'https://damm-v2.datapi.meteora.ag/pools';

export async function fetchMeteoraDamm({ minTvl = MIN_TVL, maxPages = MAX_PAGES, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(API, { params: { page, pageSize, sort_by: 'tvl', order: 'desc' } });
      const rows = data?.data || data?.pools || data || [];
      if (!rows.length) break;
      for (const r of rows) {
        const p = normalizeMeteora(r, 'meteora-damm');
        if (p && p.tvlUsd >= minTvl) out.push(p);
      }
      if (rows.length < pageSize) break;
    } catch (e) {
      if (DEBUG) console.warn('[ingest] meteora-damm page', page, 'failed:', e.message);
      break;
    }
  }
  return out;
}
