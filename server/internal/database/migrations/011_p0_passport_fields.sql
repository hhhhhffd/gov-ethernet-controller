-- P0 passport fields. All changes are additive and preserve legacy columns.
-- A display name is nullable until an operator sets it; known telemetry
-- hostnames are the only safe source for the initial value.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE devices
SET display_name = hostname
WHERE display_name IS NULL AND hostname IS NOT NULL;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS contact_updated_at TIMESTAMPTZ;

-- Migration 010 briefly made this field mandatory. Existing deployments must
-- continue to accept legacy rows without an invented contact timestamp.
ALTER TABLE organizations
    ALTER COLUMN contact_updated_at DROP NOT NULL,
    ALTER COLUMN contact_updated_at DROP DEFAULT;

ALTER TABLE threshold_policy_versions
    ADD COLUMN IF NOT EXISTS confirm_duration_minutes INTEGER;

ALTER TABLE threshold_policy_versions
    ADD CONSTRAINT threshold_policy_versions_confirm_duration_positive
    CHECK (confirm_duration_minutes IS NULL OR confirm_duration_minutes > 0);
