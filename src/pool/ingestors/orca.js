// src/pool/ingestors/orca.js
import axios from 'axios';
import { normalizeOrca } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG } from '../../config.js';

const API = 'https://api.orca.so/v2/solana/pools';

export async function fetchOrca({ minTvl = MIN_TVL, maxPages = MAX_PAGES, size = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(API, { params: { minTvl, sortBy: 'tvl', page, size } });
      const rows = data?.pools || data?.data || data || [];
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const p = normalizeOrca(r);
        if (p && p.tvlUsd >= minTvl) out.push(p);
      }
      if (rows.length < size) break;
    } catch (e) {
      if (DEBUG) console.warn('[ingest] orca page', page, 'failed:', e.message);
      break;
    }
  }
  return out;
}
