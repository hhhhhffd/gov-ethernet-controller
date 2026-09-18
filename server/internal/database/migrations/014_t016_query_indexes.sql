-- T016: indexes for existing paginated/history and report/export query paths.
-- Additive only; these do not change product semantics or API pagination.
CREATE INDEX IF NOT EXISTS ix_measurements_device_time
    ON measurements(device_id, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_measurements_observed_time
    ON measurements(observed_at, id);
