package measurements

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// ContextSnapshot is the immutable line metadata used when explaining an
// observation. The current lines projection is intentionally not consulted.
type ContextSnapshot struct {
	ID           int64
	LineID       string
	ProviderID   *string
	Provider     *string
	Technology   string
	TechnologyID *string
	Role         string
	Version      int
	ValidFrom    time.Time
	ValidTo      *time.Time
	Reason       string
	ChangedBy    string
	CreatedAt    time.Time
}

func ResolveContext(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string, at time.Time) (ContextSnapshot, error) {
	var result ContextSnapshot
	if err := q.QueryRow(ctx, `SELECT v.id,v.line_id,v.provider_id,p.name,v.technology,v.technology_id,v.role,v.version,v.valid_from,v.valid_to,v.reason,v.changed_by,v.created_at
        FROM line_context_versions v LEFT JOIN providers p ON p.id=v.provider_id
        WHERE v.line_id=$1 AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to > $2)
		ORDER BY v.valid_from DESC,v.version DESC LIMIT 1`, lineID, at.UTC()).Scan(&result.ID, &result.LineID, &result.ProviderID, &result.Provider, &result.Technology, &result.TechnologyID, &result.Role, &result.Version, &result.ValidFrom, &result.ValidTo, &result.Reason, &result.ChangedBy, &result.CreatedAt); err != nil {
		return ContextSnapshot{}, err
	}
	return result, nil
}

func SnapshotContext(value ContextSnapshot) map[string]interface{} {
	return map[string]interface{}{
		"id": value.ID, "line_id": value.LineID, "provider_id": value.ProviderID,
		"provider_name": value.Provider, "technology": value.Technology,
		"technology_id": value.TechnologyID, "role": value.Role, "version": value.Version,
		"valid_from": value.ValidFrom, "valid_to": value.ValidTo, "reason": value.Reason,
		"changed_by": value.ChangedBy, "created_at": value.CreatedAt,
	}
}
