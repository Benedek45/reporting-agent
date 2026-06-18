# Stop the reporting-agent stack gracefully.
Set-Location $PSScriptRoot
# Use explicit -f to avoid auto-merging docker-compose.override.yml (the DEV overlay).
docker compose -f docker-compose.yml down
Write-Host "Stopped."
Pause
