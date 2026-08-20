# Cross-Match Tool

Tool untuk menemukan **token misprice** antar dua tipe DEX Meteora — **DLMM** dan **DAMMv2** —
lalu menyusun & (opsional) mengeksekusi arbitrase 2-hop, persis seperti contoh:
`SOL → JFY (DLMM) → JFY (DAMMv2) → USDC`.

Repo ini berisi 3 bagian:

| File | Fungsi |
|------|--------|
| `scanner.js` | Engine scan dinamis (fetch pool, normalisasi, cross-match, cari kandidat) — dipakai ulang oleh bot |
| `cross_match.js` | Detektor misprice real-time (scan & lapor, tanpa eksekusi) |
| `arbitrage_bot.js` | **Bot arbitrase** — scan → susun rute → eksekusi (dry-run aman / live via SDK Meteora) |

---

## Cara Kerja Bot (`arbitrage_bot.js`)

1. **SCAN** — reuse `scanner.js`: ambil pool DLMM + DAMMv2 dari API Meteora, normalisasi,
   cross-match token yang ada di kedua venue, hitung *mispricing %* (dengan filter
   *dead pool* >20% dari oracle Jupiter — sama persis dengan `cross_match.js`).
2. **PLAN** — untuk tiap kandidat, susun rute 2-hop:
   - `BUY_A_SELL_B` → harga DLMM lebih murah → beli di **DLMM**, jual di **DAMMv2**
   - `SELL_A_BUY_B` → harga DAMMv2 lebih murah → beli di **DAMMv2**, jual di **DLMM**
3. **EXECUTE**
   - `MODE=dry-run` (default): simulasi spread + estimasi PnL. **Aman, nol dana berpindah.**
   - `MODE=live`: eksekusi riil 2-hop via SDK Meteora resmi
     (`@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`), otomatis kirim tx — tapi **ter-gate**
     oleh cek net-profit, jadi tidak bakar SOL kalau fill buruk.
4. **LOOP** — ulangi tiap `SCAN_INTERVAL_MS`.

---

## Instalasi (Termux / Linux)

```bash
# Termux — installer otomatis (Node, clone, npm install SDK Meteora):
bash setup_bot_termux.sh

# Atau manual:
git clone https://github.com/Gfast416/cross-match-tool.git
cd cross-match-tool
npm install
```

Dependency: `axios`, `dotenv`, `@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`,
`@solana/web3.js`, `@solana/spl-token`, `bn.js`.

---

## Penggunaan

### Detektor misprice (tanpa eksekusi)
```bash
node cross_match.js 100 1.0     # minTVL=100, minMispricing=1.0%
```

### Bot arbitrase
```bash
# Dry-run (aman, default):
node arbitrage_bot.js 100 0.5

# Jalankan terus di background + log:
nohup node arbitrage_bot.js 100 0.5 > bot.log 2>&1 &

# Live mode (butuh WALLET_PRIVATE_KEY + RPC_URL di .env):
node arbitrage_bot.js
```

Argumen posisi `arbitrage_bot.js [minTVL] [minMispricingPct]` menimpa env `MIN_TVL` / `MIN_MISPRICING`.

---

## Konfigurasi (`.env`)

Salin dari `.env.bot.example`. Variabel utama:

| Var | Default | Keterangan |
|-----|---------|-----------|
| `MODE` | `dry-run` | `dry-run` (aman) atau `live` |
| `TRADE_AMOUNT_SOL` | `0.5` | ukuran tiap trade |
| `MIN_TVL` | `100` | TVL minimal pool (USD) |
| `MIN_MISPRICING` | `0.5` | mispricing minimal antar venue (%) |
| `MIN_PROFIT_PCT` | `1.0` | net profit minimal sebelum aksi (%) |
| `SLIPPAGE_PCT` | `1.0` | slippage maks swap (dipakai di min-out quote) |
| `ADD_CLOSE_LEG` | `false` | tutup siklus USDC→SOL via Jupiter (spt screenshot) |
| `SCAN_INTERVAL_MS` | `30000` | interval scan |
| `MAX_PAGES` | `3` | halaman API per venue (500/page) |
| `WALLET_PRIVATE_KEY` | — | base64 JSON secret key (live only) |
| `RPC_URL` | — | Solana RPC, mis. `https://mainnet.helius-rpc.com/?api-key=...` (live only) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | alert opsional |

**Format `WALLET_PRIVATE_KEY`** (base64 dari array JSON secret key):
```bash
node -e "console.log(Buffer.from(JSON.stringify(Array.from(require('fs').readFileSync('id.json'))),'utf8').toString('base64'))"
```

---

## Strategi Fee Rendah (khusus Helius free RPC)

Biaya per swap ditekan seminimal mungkin tapi tetap cepat landing:

- **Compute Unit LIMIT dipas ketat per-tx** — DLMM ≈ 600k CU, DAMMv2 ≈ 400k CU.
  Membatasi LIMIT mencegah over-pay priority fee (dihitung per-CU).
- **Priority fee via `getPriorityFeeEstimate` Helius (level `Min`)** — hanya tambah
  0–2000 µL/CU (~$0.00001–$0.0001) bila jaringan butuh; di-cache 15 detik.
- **WSOL di-wrap sekali** via `SystemProgram.transfer` + `createSyncNativeInstruction`
  (ATA WSOL dibuat cuma pertama kali), lalu **auto-close WSOL→SOL** setelah trade
  supaya dana tidak nyangkut.
- **Confirmation `confirmed`** (bukan `finalized`) → lebih cepat.

Estimasi total per siklus (2 swap): **~$0.00002–$0.0002** — jauh di bawah profit min 1%.

---

## Keamanan

- Default **dry-run**: tidak ada dana yang berpindah.
- Mode **live** otomatis di-gate oleh cek net-profit (sama seperti dry-run) — skip kalau
  estimasi di bawah `MIN_PROFIT_PCT`.
- **Verifikasi pool langsung via SDK Meteora** (read-only quote) setelah nemu kandidat:
  kalau pool mati / "price differs >5% from market", otomatis **skip** (tidak trade stale pool).
- `minimumAmountOut` diperketat dari quote riil SDK (anti-slippage via `SLIPPAGE_PCT`).
- Private key hanya dibaca dari `.env`; `.gitignore` memblokir `.env` & `node_modules`.
- **Live on-chain belum diuji di mainnet oleh pembuat** — jalankan pertama dengan
  `TRADE_AMOUNT_SOL=0.01` untuk verifikasi end-to-end.

### ⚠️ Requirement Node.js untuk Mode Live

SDK Meteora (`@meteora-ag/dlmm`, `@meteora-ag/cp-amm-sdk`) butuh **Node.js 18/20** secara
native. Di **Node 22+ (termasuk 26)**, SDK gagal load karena isu kompatibilitas ESM↔CJS
(`@coral-xyz/anchor`) — bot akan menampilkan pesan instruktif, bukan crash.

**Solusi untuk Node 22+ (Termux default sekarang = Node 26):**
```bash
npm install
bash fix_node26.sh        # patch anchor CJS agar bisa di-load di Node 22+
node arbitrage_bot.js 100 0.5
```
`fix_node26.sh` hanya memodifikasi `node_modules` (tidak di-push). Jalankan ulang
setiap kali `npm install` dilakukan.

- Termux `pkg install nodejs` → Node 26 → **butuh `fix_node26.sh`**.
- Jika punya Node 18/20 → langsung jalan tanpa patch.
- Jika memaksa tanpa patch di Node 22+: jalankan **tanpa `RPC_URL`** (dry-run aman).

### Penyaringan Kandidat (noise & dead pool)

- Token *quote* (SOL/USDC/USDT) sebagai base di-skip otomatis — rute `SOL→WSOL→USDC` absurd.
- Filter dead-pool scanner: tolak pool yang harganya >`DEAD_POOL_PCT` (default 5%) dari oracle
  Jupiter. Untuk memperpresisi, set `DEAD_POOL_PCT=5` di `.env` (standar penolakan Meteora).

---

## Struktur File

```
cross-match-tool/
├── arbitrage_bot.js     # bot arbitrase utama (scan → plan → execute/estimate → loop)
├── scanner.js           # engine scan DLMM/DAMMv2 (reuse oleh bot & cross_match)
├── cross_match.js       # detektor misprice real-time (tanpa eksekusi)
├── setup_bot_termux.sh  # installer Termux otomatis
├── setup_termux.sh      # installer (scanner lama)
├── .env.bot.example     # template konfigurasi bot
├── README_BOT.md        # dokumentasi detail bot
└── README.md            # file ini
```
