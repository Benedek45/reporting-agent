#!/usr/bin/env pwsh
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
#   ./scripts/update-context-manager.ps1            # pinned ref below
#   ./scripts/update-context-manager.ps1 -Ref main  # latest on main
param(
  # Pinned to the context-manager commit that estimates context size from
  # message content instead of provider per-turn usage metadata (builds on the
  # hard-cap floor + system.transform empty-turn guard). See AGENTS.md §7.
  [string]$Ref = "ef2400102e6f2c317f1351f57773eae002e18907"
)
$ErrorActionPreference = "Stop"

$repoUrl  = "https://github.com/Benedek45/context-manager.git"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dest     = Join-Path $repoRoot ".opencode/context-manager.js"
$tmp      = Join-Path ([System.IO.Path]::GetTempPath()) ("cm-" + [guid]::NewGuid().ToString("N"))

try {
  Write-Host "Cloning $repoUrl @ $Ref ..."
  git clone --quiet $repoUrl $tmp
  git -C $tmp checkout --quiet $Ref
  $entry = Join-Path $tmp "clean-impl/adapters/opencode/plugin.ts"
  if (-not (Test-Path $entry)) { throw "plugin entry not found: $entry" }
  Write-Host "Building bundle -> $dest"
  & bun build $entry --target bun --outfile $dest
  if ($LASTEXITCODE -ne 0) { throw "bun build failed ($LASTEXITCODE)" }
  $sha = (git -C $tmp rev-parse HEAD).Trim()
  Write-Host ("Installed {0} bytes from {1}" -f (Get-Item $dest).Length, $sha)
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
