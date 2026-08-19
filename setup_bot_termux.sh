#!/data/data/com.termux/files/usr/bin/bash
# Arbitrage Bot — Termux Auto-Setup
# Run: bash setup_bot_termux.sh
set -e
echo "🤖 Meteora Arbitrage Bot — Termux Setup"
echo "========================================"

echo "[1/4] Installing Node.js + git..."
pkg update -y && pkg upgrade -y
pkg install -y nodejs git

echo "[2/4] Cloning / updating repo..."
cd ~
if [ -d "cross-match-tool" ]; then
  echo "   Repo exists, pulling latest..."
  cd cross-match-tool && git pull
else
  git clone https://github.com/Gfast416/cross-match-tool.git
  cd cross-match-tool
fi

echo "[3/4] Installing dependencies (incl. Meteora SDKs)..."
npm install

echo "[4/4] Creating .env from example..."
if [ ! -f ".env" ]; then
  cp .env.bot.example .env
  echo "   .env created — edit it: nano .env"
else
  echo "   .env already exists"
fi

chmod +x arbitrage_bot.js

echo ""
echo "✅ Setup complete!"
echo ""
echo "   Edit config:   nano .env"
echo "   Dry-run test:  node arbitrage_bot.js 100 0.5"
echo "   Keep alive:    nohup node arbitrage_bot.js > bot.log 2>&1 &"
echo "   Live mode:     set MODE=live + WALLET_PRIVATE_KEY + RPC_URL in .env"
echo ""
echo "⚠️  LIVE mode moves REAL funds. Test in dry-run first."
