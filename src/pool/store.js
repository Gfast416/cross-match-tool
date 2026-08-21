// src/pool/store.js — in-memory multi-pool index (the PRO data model).
// FASE 1 of the review: keeps ALL pools per token, indexed 3 ways so the
// path finder / graph can compare pools and build routes without re-scanning.

export class PoolStore {
  constructor() {
    /** @type {Map<string, object>} address -> pool */
    this.byAddress = new Map();
    /** @type {Map<string, Set<string>>} mint -> Set of pool addresses */
    this.byMint = new Map();
    /** @type {Map<string, object[]>} "mintA|mintB" (sorted) -> pool[] */
    this.byPair = new Map();
  }

  clear() {
    this.byAddress.clear();
    this.byMint.clear();
    this.byPair.clear();
  }

  /**
   * @param {object} pool - NormalizedPool (must have address, mintA, mintB, venue)
   */
  add(pool) {
    if (!pool || !pool.address || !pool.mintA || !pool.mintB) return;
    const id = pool.id || `${pool.venue}:${pool.address}`;
    pool.id = id;

    this.byAddress.set(pool.address, pool);

    for (const m of [pool.mintA, pool.mintB]) {
      if (!this.byMint.has(m)) this.byMint.set(m, new Set());
      this.byMint.get(m).add(pool.address);
    }

    const pairKey = [pool.mintA, pool.mintB].sort().join('|');
    if (!this.byPair.has(pairKey)) this.byPair.set(pairKey, []);
    const arr = this.byPair.get(pairKey);
    const idx = arr.findIndex(p => p.address === pool.address);
    if (idx >= 0) arr[idx] = pool; // update in place
    else arr.push(pool);
  }

  addMany(pools) {
    for (const p of pools) this.add(p);
  }

  /** @param {string} mint @returns {object[]} */
  getByMint(mint) {
    const addrs = this.byMint.get(mint);
    if (!addrs) return [];
    return [...addrs].map(a => this.byAddress.get(a)).filter(Boolean);
  }

  /** @param {string} mintA @param {string} mintB @returns {object[]} */
  getByPair(mintA, mintB) {
    const key = [mintA, mintB].sort().join('|');
    return this.byPair.get(key) || [];
  }

  /** @returns {object[]} */
  getAll() {
    return [...this.byAddress.values()];
  }

  stats() {
    const venues = {};
    for (const p of this.byAddress.values()) {
      venues[p.venue] = (venues[p.venue] || 0) + 1;
    }
    return { totalPools: this.byAddress.size, totalMints: this.byMint.size, venues };
  }
}
