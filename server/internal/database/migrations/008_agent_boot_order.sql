-- Store the wall-clock start of an agent session so delayed heartbeats from an
-- older process cannot overwrite telemetry from a newer process.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS agent_boot_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_devices_boot_started
    ON devices(agent_boot_started_at);
