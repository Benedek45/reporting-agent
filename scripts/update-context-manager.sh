#!/usr/bin/env bash
# Refresh the bundled context-manager plugin from its OWN project repo:
#   https://github.com/Benedek45/context-manager
#
# The context manager is developed and tested as a SEPARATE project. This repo
# only CONSUMES the built artifact: a single self-contained Bun bundle dropped at
# .opencode/context-manager.js (loaded via explicit plugin declaration in opencode.json).
#
# This script clones the plugin repo at a pinned commit, builds the opencode
# adapter entry into that single file, and cleans up. No plugin source is kept
# in this repo.
#
# Usage:
#   ./scripts/update-context-manager.sh            # pinned ref below
#   ./scripts/update-context-manager.sh main       # latest on main
set -euo pipefail

# Pinned to the context-manager commit that estimates context size from
# message content instead of provider per-turn usage metadata (builds on the
# hard-cap floor + system.transform empty-turn guard). See AGENTS.md §7.
REF="${1:-ef2400102e6f2c317f1351f57773eae002e18907}"
REPO_URL="https://github.com/Benedek45/context-manager.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEST="$REPO_ROOT/.opencode/context-manager.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning $REPO_URL @ $REF ..."
git clone --quiet "$REPO_URL" "$TMP"
git -C "$TMP" checkout --quiet "$REF"
ENTRY="$TMP/clean-impl/adapters/opencode/plugin.ts"
[ -f "$ENTRY" ] || { echo "plugin entry not found: $ENTRY" >&2; exit 1; }

echo "Building bundle -> $DEST"
bun build "$ENTRY" --target bun --outfile "$DEST"
echo "Installed $(wc -c < "$DEST") bytes from $(git -C "$TMP" rev-parse HEAD)"
