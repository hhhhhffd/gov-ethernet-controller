-- Persist provider-case delivery state independently from the synchronous
-- transport call so failures retain retryability and backoff metadata.
ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS delivery_retryable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_provider_cases_delivery
    ON provider_cases(delivery_status, next_attempt_at, created_at, id);
