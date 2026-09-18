-- Allow a ProviderCase to be rooted in either an incident or a line.
-- Existing incident-backed rows remain valid and keep their original IDs.
ALTER TABLE provider_cases
    ALTER COLUMN incident_id DROP NOT NULL;

ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS line_id TEXT REFERENCES lines(id),
    ADD COLUMN IF NOT EXISTS source_context TEXT NOT NULL DEFAULT 'INCIDENT',
    ADD COLUMN IF NOT EXISTS period_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS period_to TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evidence_measurement_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE provider_cases
SET source_context = 'INCIDENT'
WHERE source_context IS NULL OR btrim(source_context) = '';

ALTER TABLE provider_cases
    ADD CONSTRAINT provider_cases_source_context_check
        CHECK (source_context IN ('INCIDENT', 'LINE')),
    ADD CONSTRAINT provider_cases_exactly_one_root_check
        CHECK ((incident_id IS NOT NULL) <> (line_id IS NOT NULL)),
    ADD CONSTRAINT provider_cases_root_context_check
        CHECK ((source_context = 'INCIDENT' AND incident_id IS NOT NULL AND line_id IS NULL)
            OR (source_context = 'LINE' AND line_id IS NOT NULL AND incident_id IS NULL)),
    ADD CONSTRAINT provider_cases_period_check
        CHECK (period_to IS NULL OR period_from IS NULL OR period_to > period_from);

CREATE INDEX IF NOT EXISTS ix_provider_cases_line ON provider_cases(line_id, created_at, id);
