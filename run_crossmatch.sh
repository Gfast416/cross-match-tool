#!/data/data/com.termux/files/usr/bin/bash
# run_crossmatch.sh — Termux launcher for cross-match-tool
# Usage: ./run_crossmatch.sh

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
 
# Navigate to tool directory
cd /data/data/com.termux/files/home/storage/downloads/cross-match-tool
 
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}Installing dependencies...${NC}"
  npm install
fi
 
# Load .env if exists
if [ -f ".env" ]; then
  echo -e "${BLUE}Loading .env configuration...${NC}"
  export $(grep -v '^#' .env | xargs)
fi
 
# Check for GitHub token
if [ -z "$GITHUB_TOKEN" ]; then
  echo -e "${RED}Error: GITHUB_TOKEN not found${NC}"
  echo "Set it via: export GITHUB_TOKEN='your_token' OR add to .env"
  exit 1
fi
 
echo -e "${GREEN}🚀 Starting Cross-Match Tool v1.2${NC}"
echo "GitHub: Gfast416/cross-match-tool"
echo ""
 
# Run the scanner
node cross_match.js "$@"
