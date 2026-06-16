#!/usr/bin/env sh
# Opt in to Dynamic Context Pruning (DCP). DCP is AGPL-3.0 and is NOT bundled
# with reporting-agent — enabling it is your choice and your AGPL responsibility.
set -e
echo "Enabling DCP (AGPL-3.0-or-later)."
echo "reporting-agent does not bundle DCP; by enabling it you choose to install"
echo "and run AGPL software and take on its obligations for the service you run."
docker compose -f docker-compose.yml -f docker-compose.dcp.yml up -d --build
echo "DCP enabled. To disable, bring the stack up without the overlay: docker compose up -d"
