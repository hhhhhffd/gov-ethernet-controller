-- Keep line-scoped policies tied to canonical line identifiers.
-- Existing invalid rows are rejected before the constraints are installed so
-- operators get an actionable migration failure instead of silent misrouting.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions
        WHERE scope_type = 'LINE'
          AND scope_id <> btrim(scope_id)
    ) THEN
        RAISE EXCEPTION 'migration 005: line-scoped policies contain untrimmed scope_id values';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM threshold_policy_versions p
        LEFT JOIN lines l ON l.id = p.scope_id
        WHERE p.scope_type = 'LINE' AND l.id IS NULL
    ) THEN
        RAISE EXCEPTION 'migration 005: line-scoped policies reference missing lines';
    END IF;
END
$$;

ALTER TABLE threshold_policy_versions
    ADD CONSTRAINT threshold_policy_versions_scope_id_trimmed
    CHECK (scope_id IS NULL OR scope_id = btrim(scope_id)),
    ADD CONSTRAINT threshold_policy_versions_line_scope_fk
    FOREIGN KEY (scope_id) REFERENCES lines(id);
