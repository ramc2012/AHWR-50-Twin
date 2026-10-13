-- =====================================================================
-- Energistics identity (WITSML 2.1 / ETP v1.2) — same tables as the rig edge
-- (AHWR-150-EDGE app/sql/02-schema.sql, schema version 3).
-- Name-based UUIDs are computed identically at the edge and here
-- (etp-witsml/lib/ids.js); they are stored for lookup.
-- channels: one row per (rig, metric) with what a WITSML 2.1 Channel and an ETP
-- ChannelMetadataRecord need. Filled from the edge's channel dictionary (sync
-- batches) or from Channel objects an edge puts over ETP.
-- Idempotent: applied on every start by db/migrate.sh.
-- =====================================================================
ALTER TABLE rigs ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;
ALTER TABLE wells ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;
ALTER TABLE well_runs ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;

CREATE TABLE IF NOT EXISTS wellbores (
    uuid        UUID PRIMARY KEY,
    well_id     TEXT NOT NULL REFERENCES wells(well_id) ON DELETE CASCADE ON UPDATE CASCADE,
    name        TEXT NOT NULL,
    number      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (well_id, name)
);

CREATE TABLE IF NOT EXISTS channels (
    rig_id             TEXT NOT NULL REFERENCES rigs(rig_id) ON DELETE CASCADE,
    metric             TEXT NOT NULL,
    uuid               UUID NOT NULL UNIQUE,
    mnemonic           TEXT NOT NULL,
    label              TEXT,
    group_name         TEXT,
    stored_unit        TEXT,                                -- unit of the values in telemetry
    uom                TEXT NOT NULL,                       -- Energistics unit of presented values
    factor             DOUBLE PRECISION NOT NULL DEFAULT 1, -- presented = stored * factor
    data_kind          TEXT NOT NULL DEFAULT 'double',
    property_kind_uuid UUID NOT NULL,                       -- Energistics PWLS property kind
    property_kind      TEXT NOT NULL,
    unit_source        TEXT,
    logging_company    TEXT,                              -- WITSML Channel LoggingCompany (default: the rig)
    first_ts           TIMESTAMPTZ,                         -- data extent in telemetry
    last_ts            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rig_id, metric)
);
CREATE INDEX IF NOT EXISTS channels_last_ts ON channels (last_ts DESC);

-- Business associates (logging companies, operators) referenced by objects.
CREATE TABLE IF NOT EXISTS business_associates (
    uuid        UUID PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmf_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON wellbores, channels, business_associates TO crmf_app;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (name) VALUES ('002-energistics') ON CONFLICT DO NOTHING;
