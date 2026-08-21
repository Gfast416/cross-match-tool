// src/index.js — PRO entry point.
import { runPro } from './bot.js';

runPro().catch(e => {
  console.error('[fatal]', e.message);
  if (process.env.DEBUG && e.stack) console.error(e.stack);
  process.exit(1);
});
