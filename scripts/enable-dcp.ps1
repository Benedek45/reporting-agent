# Opt in to Dynamic Context Pruning (DCP). DCP is AGPL-3.0 and is NOT bundled
# with reporting-agent — enabling it is your choice and your AGPL responsibility.
$ErrorActionPreference = "Stop"
Write-Host "Enabling DCP (AGPL-3.0-or-later)." -ForegroundColor Yellow
Write-Host "reporting-agent does not bundle DCP; by enabling it you choose to install"
Write-Host "and run AGPL software and take on its obligations for the service you run."
docker compose -f docker-compose.yml -f docker-compose.dcp.yml up -d --build
Write-Host "DCP enabled. To disable, bring the stack up without the overlay: docker compose up -d" -ForegroundColor Green
