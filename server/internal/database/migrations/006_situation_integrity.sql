-- Situations are a materialized reconciliation, so their open group key must
-- be unique even when concurrent workers or direct writers are involved.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM situations
        WHERE status NOT IN ('OPEN', 'CLOSED')
    ) THEN
        RAISE EXCEPTION 'migration 006: situations contains an unsupported status';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM situations
        WHERE status = 'OPEN'
        GROUP BY provider_id, district, violation_type, start_at
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'migration 006: situations contains duplicate open group keys';
    END IF;
END
$$;

ALTER TABLE situations
    ADD CONSTRAINT situations_status_check
    CHECK (status IN ('OPEN', 'CLOSED'));

CREATE UNIQUE INDEX situations_open_group_key
    ON situations (provider_id, district, violation_type, start_at) NULLS NOT DISTINCT
    WHERE status = 'OPEN';
