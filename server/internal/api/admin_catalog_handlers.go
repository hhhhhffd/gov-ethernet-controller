package api

import (
	"net/http"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

type referencePayload struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

func (s *Server) adminCatalog(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "catalog not found")
		return
	}
	table, objectType, ok := referenceTable(parts[0])
	if !ok {
		writeError(w, http.StatusNotFound, "catalog not found")
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,name,active,created_at FROM `+table+` ORDER BY name`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not query catalog")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var item referencePayload
			var created time.Time
			if err := rows.Scan(&item.ID, &item.Name, &item.Active, &created); err != nil {
				writeError(w, http.StatusInternalServerError, "could not read catalog")
				return
			}
			result = append(result, map[string]interface{}{"id": item.ID, "name": item.Name, "active": item.Active, "created_at": created})
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if len(parts) > 2 || (len(parts) == 2 && parts[1] == "") || (r.Method != http.MethodPost && r.Method != http.MethodPut) {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var payload referencePayload
	payload.Active = true
	if err := decodeJSON(r, &payload); err != nil || strings.TrimSpace(payload.ID) == "" || strings.TrimSpace(payload.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "id and name are required")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO `+table+`(id,name,active,created_at) VALUES ($1,$2,$3,$4)`, payload.ID, payload.Name, payload.Active, now); err != nil {
			writeError(w, http.StatusConflict, "catalog item already exists")
			return
		}
		writeAudit(r.Context(), s, p, objectType+".created", objectType, payload.ID, nil, payload)
		writeJSON(w, http.StatusCreated, map[string]interface{}{"id": payload.ID, "name": payload.Name, "active": payload.Active, "created_at": now})
		return
	}
	if parts[1] != payload.ID {
		writeError(w, http.StatusConflict, "catalog item id is immutable")
		return
	}
	var previous referencePayload
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,name,active,created_at FROM `+table+` WHERE id=$1`, payload.ID).Scan(&previous.ID, &previous.Name, &previous.Active, &created); err != nil {
		writeError(w, http.StatusNotFound, "catalog item not found")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE `+table+` SET name=$1,active=$2 WHERE id=$3`, payload.Name, payload.Active, payload.ID); err != nil {
		writeError(w, http.StatusConflict, "catalog item update failed")
		return
	}
	writeAudit(r.Context(), s, p, objectType+".updated", objectType, payload.ID, previous, payload)
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": payload.ID, "name": payload.Name, "active": payload.Active, "created_at": created})
}

func referenceTable(kind string) (table, objectType string, ok bool) {
	switch strings.ToLower(kind) {
	case "districts", "district":
		return "districts", "district", true
	case "technologies", "technology":
		return "technologies", "technology", true
	default:
		return "", "", false
	}
}

type agentVersionPayload struct {
	Version          string     `json:"version"`
	Recommended      bool       `json:"recommended"`
	MinimumSupported bool       `json:"minimum_supported"`
	ReleaseAt        *time.Time `json:"release_at"`
	Checksum         string     `json:"checksum"`
	ArtifactURL      string     `json:"artifact_url"`
	Active           bool       `json:"active"`
}

func (s *Server) adminAgentVersions(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if len(parts) == 0 && r.Method == http.MethodGet {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT version,is_recommended,is_minimum_supported,release_at,checksum,artifact_url,active,created_at,updated_at FROM agent_versions ORDER BY release_at DESC NULLS LAST,version DESC`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not query agent versions")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var item agentVersionPayload
			var created, updated time.Time
			if err := rows.Scan(&item.Version, &item.Recommended, &item.MinimumSupported, &item.ReleaseAt, &item.Checksum, &item.ArtifactURL, &item.Active, &created, &updated); err != nil {
				writeError(w, http.StatusInternalServerError, "could not read agent versions")
				return
			}
			result = append(result, agentVersionMap(item, created, updated))
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if len(parts) > 1 || (len(parts) == 1 && parts[0] == "") || (r.Method != http.MethodPost && r.Method != http.MethodPut) {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var payload agentVersionPayload
	payload.Active = true
	if err := decodeJSON(r, &payload); err != nil || strings.TrimSpace(payload.Version) == "" {
		writeError(w, http.StatusUnprocessableEntity, "version is required")
		return
	}
	if r.Method == http.MethodPut && parts[0] != payload.Version {
		writeError(w, http.StatusConflict, "agent version is immutable")
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not begin agent version transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	now := time.Now().UTC().Truncate(time.Second)
	var previous agentVersionPayload
	var created time.Time
	if r.Method == http.MethodPut {
		if err := tx.QueryRow(r.Context(), `SELECT version,is_recommended,is_minimum_supported,release_at,checksum,artifact_url,active,created_at FROM agent_versions WHERE version=$1 FOR UPDATE`, payload.Version).Scan(&previous.Version, &previous.Recommended, &previous.MinimumSupported, &previous.ReleaseAt, &previous.Checksum, &previous.ArtifactURL, &previous.Active, &created); err != nil {
			writeError(w, http.StatusNotFound, "agent version not found")
			return
		}
	} else {
		created = now
		if _, err := tx.Exec(r.Context(), `INSERT INTO agent_versions(version,release_at,checksum,artifact_url,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`, payload.Version, payload.ReleaseAt, payload.Checksum, payload.ArtifactURL, payload.Active, now); err != nil {
			writeError(w, http.StatusConflict, "agent version already exists")
			return
		}
	}
	if payload.Recommended {
		if _, err := tx.Exec(r.Context(), `UPDATE agent_versions SET is_recommended=FALSE WHERE version<>$1`, payload.Version); err != nil {
			writeError(w, http.StatusInternalServerError, "could not update recommended agent version")
			return
		}
	}
	if payload.MinimumSupported {
		if _, err := tx.Exec(r.Context(), `UPDATE agent_versions SET is_minimum_supported=FALSE WHERE version<>$1`, payload.Version); err != nil {
			writeError(w, http.StatusInternalServerError, "could not update minimum supported agent version")
			return
		}
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_versions SET is_recommended=$1,is_minimum_supported=$2,release_at=$3,checksum=$4,artifact_url=$5,active=$6,updated_at=$7 WHERE version=$8`, payload.Recommended, payload.MinimumSupported, payload.ReleaseAt, payload.Checksum, payload.ArtifactURL, payload.Active, now, payload.Version); err != nil {
		writeError(w, http.StatusInternalServerError, "could not store agent version")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "could not commit agent version")
		return
	}
	action := "agent_version.created"
	if r.Method == http.MethodPut {
		action = "agent_version.updated"
	}
	writeAudit(r.Context(), s, p, action, "agent_version", payload.Version, func() interface{} {
		if r.Method == http.MethodPut {
			return previous
		}
		return nil
	}(), payload)
	payloadMap := agentVersionMap(payload, created, now)
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[r.Method == http.MethodPut], payloadMap)
}

func agentVersionMap(item agentVersionPayload, created, updated time.Time) map[string]interface{} {
	return map[string]interface{}{"version": item.Version, "recommended": item.Recommended, "minimum_supported": item.MinimumSupported, "release_at": item.ReleaseAt, "checksum": item.Checksum, "artifact_url": item.ArtifactURL, "active": item.Active, "created_at": created, "updated_at": updated}
}
