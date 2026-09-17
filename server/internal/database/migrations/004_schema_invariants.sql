-- Schema invariants for effective versions and workflow state.
-- Keep the checks in PostgreSQL so direct writers and concurrent API requests
-- cannot bypass the application-level validation.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM contract_versions
        WHERE valid_to IS NOT NULL AND valid_to <= valid_from
    ) THEN
        RAISE EXCEPTION 'migration 004: contract_versions contains invalid effective intervals';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions
        WHERE valid_to IS NOT NULL AND valid_to <= valid_from
    ) THEN
        RAISE EXCEPTION 'migration 004: threshold_policy_versions contains invalid effective intervals';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM contract_versions a
        JOIN contract_versions b
          ON b.line_id = a.line_id
         AND b.id > a.id
         AND tstzrange(a.valid_from, a.valid_to, '[)') && tstzrange(b.valid_from, b.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'migration 004: contract_versions contains overlapping effective intervals';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions a
        JOIN threshold_policy_versions b
          ON b.scope_type = a.scope_type
         AND b.scope_id IS NOT DISTINCT FROM a.scope_id
         AND b.id > a.id
         AND tstzrange(a.valid_from, a.valid_to, '[)') && tstzrange(b.valid_from, b.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'migration 004: threshold_policy_versions contains overlapping effective intervals';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions
        WHERE scope_type = 'GLOBAL' AND scope_id IS NOT NULL
    ) OR EXISTS (
        SELECT 1
        FROM threshold_policy_versions
        WHERE scope_type = 'LINE' AND (scope_id IS NULL OR btrim(scope_id) = '')
    ) THEN
        RAISE EXCEPTION 'migration 004: threshold policy scope_type and scope_id are inconsistent';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions
        GROUP BY scope_type, scope_id, version
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'migration 004: threshold_policy_versions contains duplicate scope/version rows';
    END IF;
END
$$;

ALTER TABLE contract_versions
    ADD CONSTRAINT contract_versions_valid_interval
    CHECK (valid_to IS NULL OR valid_to > valid_from);

ALTER TABLE contract_versions
    ADD CONSTRAINT contract_versions_no_overlap
    EXCLUDE USING gist (
        line_id WITH =,
        (tstzrange(valid_from, valid_to, '[)')) WITH &&
    );

ALTER TABLE threshold_policy_versions
    DROP CONSTRAINT IF EXISTS threshold_policy_versions_scope_type_scope_id_version_key;

ALTER TABLE threshold_policy_versions
    ADD CONSTRAINT threshold_policy_versions_valid_interval
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    ADD CONSTRAINT threshold_policy_versions_positive_version
    CHECK (version > 0),
    ADD CONSTRAINT threshold_policy_versions_scope_consistent
    CHECK (
        (scope_type = 'GLOBAL' AND scope_id IS NULL)
        OR (scope_type = 'LINE' AND scope_id IS NOT NULL AND btrim(scope_id) <> '')
    ),
    ADD CONSTRAINT threshold_policy_versions_no_overlap
    EXCLUDE USING gist (
        scope_type WITH =,
        (COALESCE(scope_id, '')) WITH =,
        (tstzrange(valid_from, valid_to, '[)')) WITH &&
    ),
    ADD CONSTRAINT threshold_policy_versions_scope_version_key
    UNIQUE NULLS NOT DISTINCT (scope_type, scope_id, version);

ALTER TABLE line_states
    ADD CONSTRAINT line_states_data_state_check
    CHECK (data_state IN ('NO_DATA', 'FRESH')),
    ADD CONSTRAINT line_states_connection_state_check
    CHECK (connection_state IN ('UNKNOWN', 'OK', 'DEGRADED', 'NO_INTERNET')),
    ADD CONSTRAINT line_states_contract_state_check
    CHECK (contract_state IN ('UNKNOWN', 'MEETS', 'DEVIATES')),
    ADD CONSTRAINT line_states_recovery_state_check
    CHECK (recovery_state IN ('NONE', 'OBSERVED', 'CONFIRMED'));

ALTER TABLE line_state_events
    ADD CONSTRAINT line_state_events_data_state_check
    CHECK (data_state IN ('NO_DATA', 'FRESH')),
    ADD CONSTRAINT line_state_events_connection_state_check
    CHECK (connection_state IN ('UNKNOWN', 'OK', 'DEGRADED', 'NO_INTERNET')),
    ADD CONSTRAINT line_state_events_contract_state_check
    CHECK (contract_state IN ('UNKNOWN', 'MEETS', 'DEVIATES')),
    ADD CONSTRAINT line_state_events_recovery_state_check
    CHECK (recovery_state IN ('NONE', 'OBSERVED', 'CONFIRMED'));

ALTER TABLE incidents
    ADD CONSTRAINT incidents_status_check
    CHECK (status IN ('NEW', 'SENT_TO_PROVIDER', 'IN_PROGRESS', 'WAITING_INFO', 'RESOLVED', 'CLOSED')),
    ADD CONSTRAINT incidents_recovery_state_check
    CHECK (recovery_state IN ('NONE', 'OBSERVED', 'CONFIRMED'));

ALTER TABLE provider_cases
    ADD CONSTRAINT provider_cases_status_check
    CHECK (status IN ('DRAFT', 'SENT', 'FAILED')),
    ADD CONSTRAINT provider_cases_delivery_status_check
    CHECK (delivery_status IN ('PENDING', 'DELIVERING', 'SENT', 'FAILED')),
    ADD CONSTRAINT provider_cases_delivery_channel_check
    CHECK (delivery_channel IN ('INTERNAL', 'WEBHOOK', 'WEB'));

ALTER TABLE notifications
    ADD CONSTRAINT notifications_status_check
    CHECK (status IN ('PENDING', 'GENERATED', 'DELIVERING', 'SENT', 'FAILED')),
    ADD CONSTRAINT notifications_channel_check
    CHECK (channel IN ('WEB', 'WEBHOOK'));
