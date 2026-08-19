#!/data/data/com.termux/files/usr/bin/bash
# Cross-Match Tool — Termux Auto-Setup Script
# Run: curl -sSL https://raw.githubusercontent.com/Gfast416/cross-match-tool/main/setup_termux.sh | bash
set -e

echo "🚀 Cross-Match Tool — Termux Setup"
echo "================================="

# Step 1: Install Node.js + dependencies
echo "[1/5] Installing Node.js..."
pkg update && pkg upgrade -y
pkg install -y nodejs git

# Step 2: Clone repo
echo "[2/5] Cloning cross-match-tool repo..."
cd ~
if [ -d "cross-match-tool" ]; then
  echo "   Repo already exists, pulling latest..."
  cd cross-match-tool && git pull
else
  git clone https://github.com/Gfast416/cross-match-tool.git
  cd cross-match-tool
fi

# Step 3: Install npm dependencies
echo "[3/5] Installing npm dependencies..."
npm install

# Step 4: Create .env file if not exists
echo "[4/5] Setting up .env file..."
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'
# Cross-Match Tool Environment
# Replace *** with your GitHub PAT (classic token with repo scope)
GITHUB_TOKEN=your_token_here
# Override repo if needed (optional)
# GITHUB_OWNER=Gfast416
# GITHUB_REPO=cross-match-tool
EOF
  echo "   .env created. Edit it with: nano .env"
  echo "   Get your token at: https://github.com/settings/tokens"
else
  echo "   .env already exists"
fi

# Step 5: Make scripts executable
echo "[5/5] Making scripts executable..."
chmod +x scanner.js
chmod +x cross_match.js
chmod +x deploy.js
chmod +x verify.js

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 USAGE:"
echo "  # Edit .env with your GitHub token"
echo "  nano .env"
echo ""
echo "  # Run real-time scanner (scans every 30s)"
echo "  node cross_match.js 100 1.0"
echo ""
echo "  # Push updates to GitHub"
echo "  node deploy.js"
echo ""
echo "  # Verify files on GitHub"
echo "  node verify.js"
echo ""
echo "  # Run single scan (exit after 1 cycle)"
echo "  node scanner.js"
echo ""
echo "🚨 Remember: Set GITHUB_TOKEN in .env before running!"
