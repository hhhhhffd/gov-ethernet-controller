-- Runtime hardening: serialize one active incident per line and add the
-- durable notification outbox bookkeeping used by the dispatcher.
-- Older installations may already contain duplicate active rows. Preserve
-- the newest row for each line and close only the stale duplicates before the
-- invariant is enforced by the unique index.
CREATE TEMP TABLE linkwatch_dedup_incidents ON COMMIT DROP AS
SELECT id, line_id
FROM (
    SELECT id, line_id,
           ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY id DESC) AS row_number
    FROM incidents
    WHERE status IN ('NEW', 'SENT_TO_PROVIDER', 'IN_PROGRESS', 'WAITING_INFO', 'RESOLVED')
) ranked
WHERE row_number > 1;

UPDATE incidents AS i
SET status = 'CLOSED',
    recovery_state = 'CONFIRMED',
    resolved_at = COALESCE(i.resolved_at, now()),
    closed_at = COALESCE(i.closed_at, now()),
    duration_minutes = EXTRACT(EPOCH FROM (COALESCE(i.closed_at, now()) - i.started_at)) / 60
FROM linkwatch_dedup_incidents AS d
WHERE i.id = d.id;

INSERT INTO incident_events(incident_id, event_type, actor, payload_json, created_at)
SELECT id, 'DEDUPLICATED', 'migration-002',
       jsonb_build_object('reason', 'closed stale duplicate active incident'), now()
FROM linkwatch_dedup_incidents;

INSERT INTO audit_events(actor_type, actor_id, action, object_type, object_id, after_json, created_at)
SELECT 'SYSTEM', 'migration-002', 'incident.deduplicated', 'incident', id::text,
       jsonb_build_object('status', 'CLOSED'), now()
FROM linkwatch_dedup_incidents;

CREATE UNIQUE INDEX IF NOT EXISTS ux_incidents_one_active_per_line
    ON incidents(line_id)
    WHERE status IN ('NEW', 'SENT_TO_PROVIDER', 'IN_PROGRESS', 'WAITING_INFO', 'RESOLVED');

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS delivery_retryable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ;
ALTER TABLE notifications ALTER COLUMN status SET DEFAULT 'PENDING';

CREATE INDEX IF NOT EXISTS ix_notifications_outbox
    ON notifications(status, next_attempt_at, generated_at, id);

ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS delivery_retryable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE provider_cases
    ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_provider_cases_delivery
    ON provider_cases(delivery_status, next_attempt_at, created_at, id);
