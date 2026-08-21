// src/pool/ingestors/raydium.js
import axios from 'axios';
import { normalizeRaydium } from '../normalize.js';
import { MIN_TVL, MAX_PAGES, DEBUG } from '../../config.js';

const API = 'https://api-v3.raydium.io/pools/info/list';

export async function fetchRaydium({ minTvl = MIN_TVL, maxPages = MAX_PAGES, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(API, {
        params: { poolType: 'all', poolSortField: 'liquidity', sortType: 'desc', pageSize, page },
        timeout: 10000
      });
      const rows = data?.data?.data || data?.data || [];
      if (!rows.length) break;
      for (const r of rows) {
        const p = normalizeRaydium(r);
        if (p && p.tvlUsd >= minTvl) out.push(p);
      }
      if (rows.length < pageSize) break;
    } catch (e) {
      if (DEBUG) console.warn('[ingest] raydium page', page, 'failed:', e.message);
      break;
    }
  }
  return out;
}
