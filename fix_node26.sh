#!/bin/bash
# fix_node26.sh — Workaround agar SDK Meteora (@meteora-ag/dlmm, @meteora-ag/cp-amm-sdk)
# bisa di-load di Node.js 22+ (termasuk 26). Node 22+ mengubah resolution ESM↔CJS
# sehingga @coral-xyz/anchor (CJS) gagal di-impor oleh SDK.
#
# Cara pakai (di Termux, setelah `npm install`):
#   bash fix_node26.sh
#
# Script ini aman dijalankan berulang. Hanya memodifikasi node_modules (tidak di-push,
# karena .gitignore memblokir node_modules). Jalankan lagi setiap kali `npm install` /
# `npm ci` dilakukan ulang.

set -e
cd "$(dirname "$0")"

echo "🔧 Mencari anchor CJS di node_modules (termasuk nested)..."
ANCHORS=$(find node_modules -type d -path "*/@coral-xyz/anchor" 2>/dev/null || true)

if [ -z "$ANCHORS" ]; then
  echo "⚠️  Tidak menemukan @coral-xyz/anchor. Pastikan sudah `npm install` dulu."
  exit 1
fi

for dir in $ANCHORS; do
  pkg="$dir/package.json"
  [ -f "$pkg" ] || continue
  node -e "
    const fs = require('fs');
    const p = '$pkg';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Map eksplisit supaya ESM bisa resolve subpath CJS (termasuk directory 'bytes').
    j.exports = {
      '.': './dist/cjs/index.js',
      './dist/cjs/utils/bytes': './dist/cjs/utils/bytes/index.js',
      './dist/cjs/utils/*': './dist/cjs/utils/*.js',
      './dist/cjs/*': './dist/cjs/*.js'
    };
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    console.log('   ✅ patched', p);
  "
done

echo ""
echo "✅ Selesai. SDK Meteora sekarang bisa di-load di Node 22+."
echo "   Jalankan bot seperti biasa: node arbitrage_bot.js 100 0.5"
echo "   (Ulangi script ini tiap 'npm install' ulang.)"
