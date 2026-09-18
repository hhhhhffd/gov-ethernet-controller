-- Administrative catalog, organization contact, agent release and auth
-- hardening fields. All additions remain nullable or preserve the legacy
-- free-text columns so existing deployments and API clients keep working.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS contact_role TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS contact_updated_at TIMESTAMPTZ;
UPDATE organizations
SET contact_updated_at = COALESCE(contact_updated_at, created_at, now())
WHERE contact_updated_at IS NULL;
ALTER TABLE organizations
    ALTER COLUMN contact_updated_at SET DEFAULT now(),
    ALTER COLUMN contact_updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS districts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technologies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS district_id TEXT REFERENCES districts(id);
ALTER TABLE lines
    ADD COLUMN IF NOT EXISTS technology_id TEXT REFERENCES technologies(id);
CREATE INDEX IF NOT EXISTS ix_organizations_district_id ON organizations(district_id);
CREATE INDEX IF NOT EXISTS ix_lines_technology_id ON lines(technology_id);

CREATE TABLE IF NOT EXISTS agent_versions (
    version TEXT PRIMARY KEY,
    is_recommended BOOLEAN NOT NULL DEFAULT FALSE,
    is_minimum_supported BOOLEAN NOT NULL DEFAULT FALSE,
    release_at TIMESTAMPTZ,
    checksum TEXT NOT NULL DEFAULT '',
    artifact_url TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_versions_recommended
    ON agent_versions(is_recommended) WHERE is_recommended;
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_versions_minimum_supported
    ON agent_versions(is_minimum_supported) WHERE is_minimum_supported;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS ix_auth_rate_limits_window ON auth_rate_limits(window_started_at);
