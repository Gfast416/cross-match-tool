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
   - `MODE=live`: eksekusi riil 2-hop via SDK Meteora resmi (`@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`),
     otomatis kirim tx (ter-**gate** oleh cek net-profit, jadi tidak bakar SOL kalau fill buruk).
4. **LOOP** — ulangi tiap `SCAN_INTERVAL_MS`.

## Strategi Fee Rendah (khusus Helius free RPC)

Biaya per swap ditekan seminimal mungkin tapi tetap cepat landing:

- **Compute Unit LIMIT dipas ketat per-tx** — DLMM ≈ 600k CU, DAMMv2 ≈ 400k CU.
  Membatasi LIMIT mencegah over-pay priority fee (yang dihitung per-CU).
- **Priority fee via `getPriorityFeeEstimate` Helius (level `Min`)** — hanya tambahkan
  micro-lamports/CU bila jaringan benar-benar butuh (biasanya 0–2000 µL/CU ≈ $0.00001–$0.0001).
  Disimpan 15 detik (cache) supaya tidak nambah RPC call tiap tx.
- **WSOL di-wrap sekali** via `SystemProgram.transfer` + `createSyncNative` (ATA WSOL dibuat
  cuma pertama kali; setelahnya tanpa biaya sewa).
- **Confirmation `confirmed`** (bukan `finalized`) → lebih cepat, cukup aman untuk arbitrase.

Estimasi total: ≈ base fee 5000 lamports + priority mikro per swap. Dengan 2 swap per siklus,
biayanya di kisaran **$0.00002–$0.0002** — jauh di bawah profit minimal (default 1%).

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
