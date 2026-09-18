package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/measurements"
)

func contextValueEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func lineContextChanged(previous, next linePayload) bool {
	return !contextValueEqual(previous.ProviderID, next.ProviderID) || previous.Technology != next.Technology || !contextValueEqual(previous.TechnologyID, next.TechnologyID) || previous.Role != next.Role
}

func insertLineContext(ctx context.Context, tx pgx.Tx, lineID string, providerID *string, technology string, technologyID *string, role, reason, changedBy string, validFrom, createdAt time.Time) error {
	var version int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM line_context_versions WHERE line_id=$1`, lineID).Scan(&version); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO line_context_versions(line_id,provider_id,technology,technology_id,role,valid_from,version,reason,changed_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, lineID, providerID, technology, technologyID, role, validFrom, version, reason, changedBy, createdAt)
	return err
}

func advanceLineContext(ctx context.Context, tx pgx.Tx, lineID string, previous, next linePayload, changedBy string, at time.Time) error {
	if !lineContextChanged(previous, next) {
		return nil
	}
	var currentID int64
	var currentFrom time.Time
	err := tx.QueryRow(ctx, `SELECT id,valid_from FROM line_context_versions WHERE line_id=$1 AND valid_to IS NULL ORDER BY version DESC LIMIT 1 FOR UPDATE`, lineID).Scan(&currentID, &currentFrom)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("line context version is missing")
	}
	if err != nil {
		return err
	}
	if !at.After(currentFrom) {
		return fmt.Errorf("line context change must be later than current version start")
	}
	if _, err := tx.Exec(ctx, `UPDATE line_context_versions SET valid_to=$1 WHERE id=$2`, at, currentID); err != nil {
		return err
	}
	return insertLineContext(ctx, tx, lineID, next.ProviderID, next.Technology, next.TechnologyID, next.Role, "admin projection update", changedBy, at, at)
}

func contextMap(value measurements.ContextSnapshot) map[string]interface{} {
	return measurements.SnapshotContext(value)
}

func (s *Server) lineContext(w http.ResponseWriter, r *http.Request, line lineRecord) {
	at := time.Now().UTC()
	if value := r.URL.Query().Get("at"); value != "" {
		parsed, err := parseTime(value, at)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid context timestamp")
			return
		}
		at = parsed
	}
	resolved, err := measurements.ResolveContext(r.Context(), s.DB.Pool, line.ID, at)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "line context not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not resolve line context")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT v.id,v.line_id,v.provider_id,p.name,v.technology,v.technology_id,v.role,v.version,v.valid_from,v.valid_to,v.reason,v.changed_by,v.created_at
        FROM line_context_versions v LEFT JOIN providers p ON p.id=v.provider_id
        WHERE v.line_id=$1 ORDER BY v.valid_from DESC,v.version DESC`, line.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query line context history")
		return
	}
	defer rows.Close()
	versions := []map[string]interface{}{}
	for rows.Next() {
		var value measurements.ContextSnapshot
		if err := rows.Scan(&value.ID, &value.LineID, &value.ProviderID, &value.Provider, &value.Technology, &value.TechnologyID, &value.Role, &value.Version, &value.ValidFrom, &value.ValidTo, &value.Reason, &value.ChangedBy, &value.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "could not read line context history")
			return
		}
		versions = append(versions, contextMap(value))
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "could not read line context history")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"line_id": line.ID, "at": at, "resolved_context": contextMap(resolved), "versions": versions})
}
