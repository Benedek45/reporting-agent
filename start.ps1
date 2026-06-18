# Start the reporting-agent stack.
# Run this after Docker Desktop is installed and running.
# Usage: Right-click -> "Run with PowerShell"  OR  pwsh -File start.ps1

Set-Location $PSScriptRoot

# Check Docker is reachable
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker not found in PATH. Make sure Docker Desktop is installed and you have restarted after installation."
    Pause
    exit 1
}

$dockerRunning = docker info 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker daemon is not running. Starting Docker Desktop..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    Write-Host "Waiting for Docker to start (up to 60 seconds)..."
    $tries = 0
    do {
        Start-Sleep -Seconds 5
        $tries++
        docker info 2>$null | Out-Null
    } while ($LASTEXITCODE -ne 0 -and $tries -lt 12)

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker did not start in time. Please open Docker Desktop manually and try again."
        Pause
        exit 1
    }
}

# Check the API key has been filled in
$env_content = Get-Content "$PSScriptRoot\.env" -Raw
if ($env_content -match "OPENCODE_GO_API_KEY=sk-xxx") {
    Write-Warning "You haven't set your OPENCODE_GO_API_KEY in .env yet."
    Write-Warning "Edit $PSScriptRoot\.env and replace the placeholder, then run this script again."
    Pause
    exit 1
}

Write-Host "Building and starting reporting-agent..."
Write-Host "(First build takes ~5-10 minutes — subsequent starts are fast)"
Write-Host ""
# Use explicit -f to avoid auto-merging docker-compose.override.yml (the DEV overlay).
docker compose -f docker-compose.yml up --build

Write-Host ""
Write-Host "App stopped. Run this script again to restart."
Pause
