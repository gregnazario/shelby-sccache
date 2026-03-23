#!/usr/bin/env bash
# scripts/install.sh
set -euo pipefail

echo "Installing shelby-cache-proxy..."

# Check for bun
if ! command -v bun &>/dev/null; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install globally
bun install -g @gregnazario/shelby-cache-proxy

# Run init
shelby-cache-proxy init

echo ""
echo "Installation complete!"
echo "Run 'source $(dirname "$0")/setup-sccache-env.sh' to configure your shell."
