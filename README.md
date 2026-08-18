# Cross-Match Tool

3-layer DeFi pair scanner for cross-venue arbitrage detection across liquidity venues.

## Overview

This tool filters token pairs from multiple DEX venues using a 3-layer filtering pipeline to identify potential cross-venue arbitrage opportunities.

## Filters

| Layer | Rule |
|-------|------|
| 1 (Liquidity) | TVL > 1,000 USD, reserves > 0, 24h volume > 0 |
| 2 (Price Ratio) | Cross-venue price ratio <= 3x relative to max price |
| 3 (Jupiter Cross-Check) | Venue price discount vs Jupiter <= 25% |

## File Structure

```
cross-match-tool/
├── scanner.js          # Main scanner with 3-layer pipeline + GitHub REST API helpers
├── README.md           # This file
```

## Usage

### Prerequisites

- Node.js >= 16
- An npm-installed `axios` package: `npm install axios`
- A GitHub Personal Access Token (classic) with `repo` scope

### Setup

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
node scanner.js
```

### Programmatic API

```js
const { runFilterPipeline } = require('./scanner');

const pairs = [
  { venue: 'raydium', price: 0.0001, tvl: 5000, reserve0: 100, volume24h: 200, jupiterPrice: 0.00009 },
  { venue: 'orca',     price: 0.0005, tvl: 3000, reserve0: 50,  volume24h: 100, jupiterPrice: 0.0004 },
];

const matches = runFilterPipeline(pairs);
console.log(matches);
```

## Filters Explained

### Layer 1 — Liquidity & Activity

Filters out pairs with negligible liquidity:
- **TVL > 1,000** USD — ensures sufficient capital
- **Reserves > 0** — excludes empty pools
- **24h Volume > 0** — requires trading activity

### Layer 2 — Cross-Venue Price Ratio

Ensures price consistency across venues:
- Finds the max price across all venues for a pair
- Accepts pairs where `maxPrice / venuePrice <= 3`
- Eliminates extreme pricing anomalies

### Layer 3 — Jupiter Cross-Check

Validates against Jupiter's quoted price:
- Computes discount: `(venuePrice - jupiterPrice) / venuePrice`
- Accepts pairs with discount <= 25%
- Filters out pairs deviating too far from Jupiter's oracle

## GitHub REST API Endpoints

The scanner uses the following GitHub REST API endpoints (all via HTTPS, no git binary):

| Method | Endpoint | Purpose | Retry Policy |
|--------|----------|---------|--------------|
| GET | `/repos/{owner}/{repo}` | Check if repo exists | 5 retries |
| POST | `/repos/{owner}/{repo}` | Create repo if missing | 5 retries |
| GET | `/repos/{owner}/{repo}/contents/{path}` | Fetch existing file SHA | 5 retries |
| PUT | `/repos/{owner}/{repo}/contents/{path}` | Upload/update file (base64 content) | 5 retries |

### Headers

```http
Authorization: token <GITHUB_TOKEN>
Accept: application/vnd.github+json
User-Agent: cross-match-scanner
```

### Retry Logic

All API calls use a retry wrapper that:
- Retries up to 5 times on failure
- Uses exponential-ish backoff (1s × attempt number)
- Logs each failed attempt with the error message
