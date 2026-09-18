-- Fill immutable context evidence for evaluations that predate TASK-021.
-- The migration-created version starts at lines.created_at, so this lookup
-- does not invent a change date or alter any current line projection/state.
UPDATE measurement_evaluations e
SET line_context_snapshot_json = jsonb_build_object(
    'id',v.id,'line_id',v.line_id,'provider_id',v.provider_id,'provider_name',p.name,
    'technology',v.technology,'technology_id',v.technology_id,'role',v.role,
    'version',v.version,'valid_from',v.valid_from,'valid_to',v.valid_to,
    'reason',v.reason,'changed_by',v.changed_by,'created_at',v.created_at
)
FROM measurements m
JOIN line_context_versions v ON v.line_id=m.line_id
    AND v.valid_from <= m.observed_at
    AND (v.valid_to IS NULL OR v.valid_to > m.observed_at)
LEFT JOIN providers p ON p.id=v.provider_id
WHERE e.measurement_id=m.id
  AND e.line_context_snapshot_json = '{}'::jsonb;
