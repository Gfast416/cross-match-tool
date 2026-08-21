/**
 * @typedef {Object} NormalizedPool
 * @property {string} id              - "venue:address"
 * @property {string} address
 * @property {"meteora-dlmm"|"meteora-damm"|"raydium"|"orca"} venue
 * @property {string} mintA
 * @property {string} mintB
 * @property {number} price           - price of A in B (raw ratio if available)
 * @property {number} priceUsdA       - USD price of mintA (0 if unknown)
 * @property {number} priceUsdB       - USD price of mintB (0 if unknown)
 * @property {number} tvlUsd
 * @property {number} volume24h
 * @property {number} feeRate         - 0.0025 = 0.25%
 * @property {number|null} binStep
 * @property {object} raw
 */

/**
 * @typedef {Object} Opportunity
 * @property {string} tokenMint
 * @property {string} symbol
 * @property {NormalizedPool} buyPool   - cheaper venue to BUY the token
 * @property {NormalizedPool} sellPool   - pricier venue to SELL the token
 * @property {number} spreadPct
 * @property {number} buyPriceUsd
 * @property {number} sellPriceUsd
 */
