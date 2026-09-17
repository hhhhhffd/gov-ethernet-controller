-- Keep the latest agent heartbeat snapshot on the device row so fleet views
-- can distinguish an alive process from a stale or wedged local spool.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS agent_boot_id TEXT,
    ADD COLUMN IF NOT EXISTS agent_uptime_seconds BIGINT,
    ADD COLUMN IF NOT EXISTS agent_queue_depth BIGINT,
    ADD COLUMN IF NOT EXISTS agent_last_probe_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS agent_last_probe_status TEXT,
    ADD COLUMN IF NOT EXISTS agent_telemetry_received_at TIMESTAMPTZ;

ALTER TABLE devices
    ADD CONSTRAINT devices_agent_boot_id_length
        CHECK (agent_boot_id IS NULL OR length(agent_boot_id) BETWEEN 1 AND 128),
    ADD CONSTRAINT devices_agent_uptime_nonnegative
        CHECK (agent_uptime_seconds IS NULL OR agent_uptime_seconds >= 0),
    ADD CONSTRAINT devices_agent_queue_nonnegative
        CHECK (agent_queue_depth IS NULL OR agent_queue_depth >= 0),
    ADD CONSTRAINT devices_agent_probe_status_valid
        CHECK (agent_last_probe_status IS NULL OR agent_last_probe_status IN ('ok', 'no_internet', 'error'));

CREATE INDEX IF NOT EXISTS ix_devices_telemetry_received
    ON devices(agent_telemetry_received_at);
