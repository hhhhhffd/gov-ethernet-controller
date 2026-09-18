CREATE TABLE agent_commands (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command_type TEXT NOT NULL CHECK (length(btrim(command_type)) BETWEEN 1 AND 64),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LEASED','DONE','FAILED','EXPIRED')),
    idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    leased_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result_json JSONB,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, idempotency_key),
    CHECK (jsonb_typeof(payload_json) = 'object'),
    CHECK (expires_at > created_at)
);
CREATE INDEX agent_commands_fetch_idx ON agent_commands (device_id, status, available_at, created_at, id);
CREATE INDEX agent_commands_expiry_idx ON agent_commands (status, expires_at);
CREATE INDEX agent_commands_lease_idx ON agent_commands (status, lease_expires_at);
