/**
 * Cross-Match Scanner
 * -------------------
 * 3-layer filtering for DeFi token pairs across venues:
 *   Layer 1: TVL > 1k, reserves > 0, 24h volume > 0
 *   Layer 2: cross-venue price ratio <= 3x (relative to max price)
 *   Layer 3: Jupiter cross-check — cross-venue discount <= 25%
 */

const https = require('https');
const axios = require('axios');

// Token will be set at runtime via environment variable
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'Gfast416';
const REPO_NAME = 'cross-match-tool';

const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 1000;

/**
 * Layer 1 — Basic liquidity / activity filters.
 * @param {Array<Object>} pairs - token pair data
 * @returns {Array<Object>} filtered pairs
 */
function filterLayer1(pairs) {
  return pairs.filter(pair => {
    const tvl = Number(pair.tvl || pair.liquidityUsd || 0);
    const reserves = Number(pair.reserve0 || pair.reserve1 || pair.reserves || 0);
    const vol24h = Number(pair.volume24h || pair.volume || pair.vol24h || 0);

    return tvl > 1000 && reserves > 0 && vol24h > 0;
  });
}

/**
 * Layer 2 — Cross-venue price ratio check (<= 3x).
 * @param {Array<Object>} pairs - pair data with `venue` and `price` fields
 * @returns {Array<Object>} pairs whose price is within 3x of the max
 */
function filterLayer2(pairs) {
  if (pairs.length === 0) return [];

  const prices = pairs.map(p => Number(p.price || 0));
  const maxPrice = Math.max(...prices);

  if (maxPrice <= 0) return [];

  return pairs.filter(pair => {
    const price = Number(pair.price || 0);
    // Ratio relative to the highest price across venues
    const ratio = maxPrice / price;
    return ratio <= 3;
  });
}

/**
 * Layer 3 — Jupiter cross-check (cross-venue discount <= 25%).
 * @param {Array<Object>} pairs - pair data
 * @returns {Array<Object>} pairs that pass the Jupiter discount threshold
 */
function filterLayer3(pairs) {
  return pairs.filter(pair => {
    const jupiterPrice = Number(pair.jupiterPrice || pair.jupiter?.price || 0);
    const venuePrice = Number(pair.price || 0);

    if (venuePrice <= 0) return false;

    // Cross-venue discount = (venue - jupiter) / venue
    const discount = (venuePrice - jupiterPrice) / venuePrice;
    return discount <= 0.25;
  });
}

/**
 * Run the full 3-layer filtering pipeline.
 * @param {Array<Object>} rawPairs
 * @returns {Array<Object>} final filtered pairs
 */
function runFilterPipeline(rawPairs) {
  const l1 = filterLayer1(rawPairs);
  const l2 = filterLayer2(l1);
  const l3 = filterLayer3(l2);

  console.log(`[scanner] Layer 1 (liquidity): ${l1.length} of ${rawPairs.length}`);
  console.log(`[scanner] Layer 2 (price ratio <= 3x): ${l2.length} of ${l1.length}`);
  console.log(`[scanner] Layer 3 (Jupiter discount <= 25%): ${l3.length} of ${l2.length}`);

  return l3;
}

// ─── GitHub REST API helpers ───────────────────────────────────────────────

/**
 * Retry wrapper — retries an async fn up to RETRY_LIMIT times.
 * @param {Function} fn - async function to retry
 * @returns {Promise<*>}
 */
async function retry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[github] attempt ${attempt}/${RETRY_LIMIT} failed: ${err.message}`);
      if (attempt < RETRY_LIMIT) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Check if the repo exists via GET.
 * @returns {Promise<boolean>}
 */
async function repoExists() {
  return retry(async () => {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`,
        {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'cross-match-scanner'
          }
        }
      );
      return res.status === 200;
    } catch (err) {
      if (err.response && err.response.status === 404) return false;
      throw err;
    }
  });
}

/**
 * Create a new repo via POST.
 * @returns {Promise<void>}
 */
async function createRepo() {
  await retry(async () => {
    const res = await axios.post(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`,
      {
        name: REPO_NAME,
        description: 'Cross-match scanner for DeFi token pairs across venues',
        private: false,
        auto_init: false
      },
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'cross-match-scanner'
        }
      }
    );
    console.log(`[github] created repo ${REPO_OWNER}/${REPO_NAME} (status ${res.status})`);
  });
}

/**
 * Upload a file via PUT /contents/{path}.
 * @param {string} path - repo path (e.g. "scanner.js")
 * @param {string} content - file content (raw text)
 * @param {string} message - commit message
 * @param {string|null} sha - file SHA if updating (null for new file)
 * @returns {Promise<Object>}
 */
async function uploadFile(path, content, message, sha = null) {
  const b64 = Buffer.from(content).toString('base64');
  const payload = { message, content: b64 };
  if (sha) payload.sha = sha;

  return retry(async () => {
    const res = await axios.put(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
      payload,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'cross-match-scanner'
        }
      }
    );
    console.log(`[github] uploaded ${path} (status ${res.status})`);
    return res.data;
  });
}

/**
 * Get the SHA of an existing file (for update commits).
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function getFileSha(path) {
  return retry(async () => {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
        {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'cross-match-scanner'
          }
        }
      );
      return res.data.sha || null;
    } catch (err) {
      if (err.response && err.response.status === 404) return null;
      throw err;
    }
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!GITHUB_TOKEN) {
    console.error('[scanner] GITHUB_TOKEN env var is required.');
    process.exit(1);
  }

  // 1. Ensure repo exists
  const exists = await repoExists();
  if (!exists) {
    console.log('[scanner] repo not found — creating...');
    await createRepo();
  } else {
    console.log('[scanner] repo already exists.');
  }

  // 2. Upload scanner.js
  const scannerContent = await require('fs').readFileSync(__filename, 'utf8');
  await uploadFile('scanner.js', scannerContent, 'Add cross-match scanner');

  // 3. Upload README.md
  const readmeContent = `# Cross-Match Tool

3-layer DeFi pair scanner for cross-venue arbitrage detection.

## Filters

| Layer | Rule |
|-------|------|
| 1 | TVL > 1k, reserves > 0, 24h volume > 0 |
| 2 | cross-venue price ratio <= 3x |
| 3 | Jupiter cross-check: discount <= 25% |

## Usage

Set your GitHub token as an env var, then run:

\`\`\`bash
export GITHUB_TOKEN=ghp_xxx
node scanner.js
\`\`\`

## API Endpoints (GitHub REST)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET    | /repos/{owner}/{repo} | Check repo exists |
| POST   | /repos/{owner}/{repo} | Create repo |
| GET    | /repos/{owner}/{repo}/contents/{path} | Get file + SHA |
| PUT    | /repos/{owner}/{repo}/contents/{path} | Upload/update file |

All requests use \`Authorization: token <PAT>\` header. Content is base64-encoded.
`;
  await uploadFile('README.md', readmeContent, 'Add README');

  console.log('[scanner] done.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[scanner] fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  filterLayer1,
  filterLayer2,
  filterLayer3,
  runFilterPipeline,
  uploadFile,
  createRepo,
  repoExists,
  getFileSha,
  retry
};
