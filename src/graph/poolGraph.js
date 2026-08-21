// src/graph/poolGraph.js — convenience views over PoolStore for path finding.
// A pool is a bidirectional edge between mintA and mintB.

/**
 * Enumerate every token that has more than one pool (can be same or different
 * venue / quote). Used by the same-token cross-venue opportunity finder.
 * @param {import('../pool/store.js').PoolStore} store
 * @returns {{mint:string, pools:object[]}[]}
 */
export function sameTokenGroups(store) {
  const groups = [];
  for (const [mint, addrs] of store.byMint) {
    const pools = [...addrs].map(a => store.byAddress.get(a)).filter(Boolean);
    if (pools.length > 1) groups.push({ mint, pools });
  }
  return groups;
}

/**
 * All pools for a given pair (mintA, mintB) across every venue — the basis for
 * comparing the SAME pair priced differently on Raydium vs Orca vs Meteora.
 */
export function pairPools(store, mintA, mintB) {
  return store.getByPair(mintA, mintB);
}
