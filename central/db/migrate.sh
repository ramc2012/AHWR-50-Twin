#!/bin/sh
# Schema upgrades for existing databases (service crmf-db-migrate): waits for
# init.sql to have created the core tables, then applies every db/migrations/*.sql
# in name order. Each migration is idempotent, so this runs on every start.
set -eu
export PGPASSWORD="$PGPASSWORD"
for i in $(seq 1 60); do
    if psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT to_regclass('public.well_runs') IS NOT NULL" 2>/dev/null | grep -q t; then
        break
    fi
    echo "waiting for the base schema (init.sql)..."; sleep 2
done
for f in /db/migrations/*.sql; do
    echo "applying $(basename "$f")"
    psql -v ON_ERROR_STOP=1 -q -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "$f"
done
