# Meteora DLMM ⇄ DAMMv2 Arbitrage Bot

Bot yang memindai token *misprice* antara dua tipe DEX Meteora — **DLMM** dan **DAMMv2** —
lalu menyusun rencana arbitrase 2-hop (persis seperti contoh: `SOL → JFY (DLMM) → JFY (DAMMv2) → USDC`)
dan mengeksekusinya (atau hanya menyimulasikan PnL di mode dry-run).

## Cara kerja

1. **SCAN** — reuse `scanner.js` untuk mengambil pool DLMM + DAMMv2 dari API Meteora,
   normalisasi, cross-match token yang ada di kedua venue, dan hitung *mispricing %* (dengan
   filter *dead pool* >20% dari oracle Jupiter — sama persis dengan `cross_match.js` Anda).
2. **PLAN** — untuk tiap kandidat, susun rute:
   - `BUY_A_SELL_B` → harga DLMM lebih murah → beli di **DLMM**, jual di **DAMMv2**.
   - `SELL_A_BUY_B` → harga DAMMv2 lebih murah → beli di **DAMMv2**, jual di **DLMM**.
3. **EXECUTE**
   - `MODE=dry-run` (default): simulasi spread + estimasi PnL via harga pool & Jupiter. Aman.
   - `MODE=live`: bangun tx via SDK Meteora resmi (`@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`).
     Tx **tidak otomatis dikirim** — direview dulu untuk melindungi dana Anda.
4. **LOOP** — ulangi tiap `SCAN_INTERVAL_MS`.

## Instalasi (Termux)

```bash
bash setup_bot_termux.sh
nano .env        # atur MODE, filter, dsb
```

## Penggunaan

```bash
# Dry-run, scan 1x (TVL>=100, mispricing>=0.5%)
node arbitrage_bot.js 100 0.5

# Jalankan terus (background) dengan log
nohup node arbitrage_bot.js > bot.log 2>&1 &

# Live mode (BUTUH WALLET_PRIVATE_KEY + RPC_URL di .env)
# set MODE=live di .env, lalu:
node arbitrage_bot.js
```

## Konfigurasi (.env)

| Var | Default | Keterangan |
|-----|---------|-----------|
| `MODE` | `dry-run` | `dry-run` (aman) atau `live` |
| `TRADE_AMOUNT_SOL` | `0.5` | ukuran tiap trade |
| `MIN_TVL` | `100` | TVL minimal pool (USD) |
| `MIN_MISPRICING` | `0.5` | mispricing minimal antar venue (%) |
| `MIN_PROFIT_PCT` | `1.0` | net profit minimal sebelum aksi (%) |
| `ADD_CLOSE_LEG` | `false` | tutup siklus USDC→SOL via Jupiter (spt screenshot) |
| `SCAN_INTERVAL_MS` | `30000` | interval scan |
| `MAX_PAGES` | `3` | halaman API per venue |
| `WALLET_PRIVATE_KEY` | — | base64 JSON secret key (live only) |
| `RPC_URL` | — | Solana RPC (live only) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | alert opsional |

## Keamanan

- Default **dry-run**: tidak ada dana yang berpindah.
- Mode **live** membangun tx tapi **tidak mengirim** otomatis — Anda review dulu.
- Private key hanya dibaca dari `.env`; jangan commit `.env` ke git.

## Dependencies

`@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`, `@solana/web3.js`, `bn.js`, `axios`, `dotenv`
(diinstall otomatis oleh `setup_bot_termux.sh`).
