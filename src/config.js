// src/config.js — all env + constants for the PRO multi-pool multi-DEX bot.
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
try { dotenvConfig({ path: '.env.bot' }); } catch {}
try { dotenvConfig({ path: '.env' }); } catch {}

export const MODE = (process.env.MODE || 'dry-run').toLowerCase();
export const TRADE_AMOUNT_SOL = parseFloat(process.env.TRADE_AMOUNT_SOL || '0.5');
export const MIN_TVL = parseFloat(process.env.MIN_TVL || '100');
export const MIN_MISPRICING = parseFloat(process.env.MIN_MISPRICING || '0.5');
export const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '1.0');
export const SLIPPAGE_PCT = parseFloat(process.env.SLIPPAGE_PCT || '1.0');
export const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
export const MAX_PAGES = parseInt(process.env.MAX_PAGES || '3', 10);
export const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || '20000', 10);

// Multi-RPC pool (round-robin to dodge Helius free rate limits)
const RPC_LIST = (process.env.RPC_URLS || process.env.RPC_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
export function rpcEndpoints() {
  return RPC_LIST.length ? RPC_LIST : [process.env.RPC_URL].filter(Boolean);
}

// Canonical mints
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Quote mints we never treat as an arb BASE (SOL/USDC/USDT are transit, not targets)
export const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Venue -> Jupiter dex name (for dexes= filter on quotes)
export const VENUE_TO_JUP = {
  'raydium': 'Raydium',
  'orca': 'Whirlpool',
  'meteora-dlmm': 'Meteora',
  'meteora-damm': 'Meteora'
};

export const DEBUG = process.env.DEBUG === '1';
export function dbg(...a) { if (DEBUG) console.log('[dbg]', ...a); }
export function log(...a) { console.log(...a); }
export function warn(...a) { console.warn('[warn]', ...a); }
export function fail(where, e) { console.error(`[!] [${where}] ${e.message}`); if (DEBUG && e.stack) console.error(e.stack); }
