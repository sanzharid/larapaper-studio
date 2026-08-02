#!/usr/bin/env bash
# Larapaper Studio MCP — self-serve installer.
# Safe for an agent (e.g. Hermes) to run non-interactively on Linux/macOS.
#
#   ./install.sh            install deps + verify
#   ./install.sh --print-config   also print the MCP client registration snippet
set -euo pipefail
cd "$(dirname "$0")"

echo "== Larapaper Studio MCP installer =="

# 1. Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 18+ first, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "or via nvm: https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node $(node --version) is too old — need 18+ (22 recommended)."
  exit 1
fi
echo "node $(node --version) ✓"

# 2. Dependencies
npm install --no-audit --no-fund
echo "dependencies ✓"

# 3. Verify
npm test --silent
echo "tests ✓"

SERVER="$(pwd)/server.js"
echo
echo "MCP server ready: $SERVER"
echo "Smoke-check it speaks MCP:  echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"x\",\"version\":\"1\"}}}' | node \"$SERVER\""

if [ "${1:-}" = "--print-config" ]; then
  cat <<EOF

Register in your MCP client (stdio transport):
{
  "mcpServers": {
    "larapaper-studio": {
      "command": "node",
      "args": ["$SERVER"]
    }
  }
}
EOF
fi
