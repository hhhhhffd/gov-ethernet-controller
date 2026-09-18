package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

func auditReadAllowed(p *auth.Principal) bool {
	if p == nil {
		return false
	}
	for _, capability := range auth.EffectiveCapabilities(p) {
		if capability == "audit.read" {
			return true
		}
	}
	return false
}

// scopedLinePredicate returns a server-authoritative predicate for a canonical
// line relation. It intentionally does not trust audit_events.scope_* because
// older events may not have those fields populated.
func scopedLinePredicate(p *auth.Principal, alias string, start int) (string, []interface{}) {
	if p == nil || p.IsAdmin() {
		return "TRUE", nil
	}
	clauses := []string{}
	params := []interface{}{}
	for _, scope := range p.Scopes {
		placeholder := "$" + strconv.Itoa(start+len(params))
		switch strings.ToUpper(scope.Type) {
		case "LINE":
			clauses = append(clauses, alias+".id="+placeholder)
			params = append(params, scope.ID)
		case "ORGANIZATION":
			if p.Role == "DISTRICT" || p.Role == "SCHOOL" {
				clauses = append(clauses, alias+".organization_id="+placeholder)
				params = append(params, scope.ID)
			}
		case "DISTRICT":
			if p.Role == "DISTRICT" {
				clauses = append(clauses, "scoped_org.district="+placeholder)
				params = append(params, scope.ID)
			}
		case "PROVIDER":
			if p.Role == "PROVIDER" {
				clauses = append(clauses, alias+".provider_id="+placeholder)
				params = append(params, scope.ID)
			}
		}
	}
	if len(clauses) == 0 {
		return "FALSE", params
	}
	return "(" + strings.Join(clauses, " OR ") + ")", params
}

func auditVisibilityPredicate(p *auth.Principal, start int) (string, []interface{}) {
	lineScope, params := scopedLinePredicate(p, "scoped_line", start)
	lineRelation := `EXISTS (
        SELECT 1 FROM lines scoped_line
        JOIN organizations scoped_org ON scoped_org.id=scoped_line.organization_id
        LEFT JOIN incidents scoped_incident ON scoped_incident.line_id=scoped_line.id
        LEFT JOIN provider_cases scoped_case ON scoped_case.line_id=scoped_line.id OR scoped_case.incident_id=scoped_incident.id
        LEFT JOIN monitoring_points scoped_point ON scoped_point.line_id=scoped_line.id
        LEFT JOIN devices scoped_device ON scoped_device.monitoring_point_id=scoped_point.id
        LEFT JOIN situation_members scoped_situation_member ON scoped_situation_member.incident_id=scoped_incident.id
        LEFT JOIN situations scoped_situation ON scoped_situation.id=scoped_situation_member.situation_id
        WHERE ` + lineScope + ` AND (
            (ae.object_type='line' AND ae.object_id=scoped_line.id)
            OR (ae.object_type='incident' AND ae.object_id=scoped_incident.id::text)
            OR (ae.object_type='provider_case' AND ae.object_id=scoped_case.id::text)
            OR (ae.object_type='organization' AND ae.object_id=scoped_line.organization_id)
            OR (ae.object_type='provider' AND ae.object_id=scoped_line.provider_id)
            OR (ae.object_type='device' AND ae.object_id=scoped_device.id)
            OR (ae.object_type='monitoring_point' AND ae.object_id=scoped_point.id)
            OR (ae.object_type='situation' AND ae.object_id=scoped_situation.id::text)
        )
    )`
	return "(" + lineRelation + ")", params
}

func parsePageParams(r *http.Request) (limit, offset int, err error) {
	limit, offset = 50, 0
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return 0, 0, fmt.Errorf("limit must be between 1 and 100")
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		page, pageErr := strconv.Atoi(raw)
		if pageErr != nil || page < 1 {
			return 0, 0, fmt.Errorf("page must be positive")
		}
		offset = (page - 1) * limit
	}
	return limit, offset, nil
}

func redactAuditValue(value interface{}) interface{} {
	switch item := value.(type) {
	case map[string]interface{}:
		result := make(map[string]interface{}, len(item))
		for key, nested := range item {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "credential") || strings.Contains(lower, "private_key") {
				result[key] = "[REDACTED]"
			} else {
				result[key] = redactAuditValue(nested)
			}
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(item))
		for i, nested := range item {
			result[i] = redactAuditValue(nested)
		}
		return result
	default:
		return value
	}
}

// marshalAuditSnapshot normalizes structs and maps through JSON before applying
// the key-based redaction. This keeps credentials out of storage as well as
// out of the read API when a future audit caller passes a struct payload.
func marshalAuditSnapshot(value interface{}) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var decoded interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	return json.Marshal(redactAuditValue(decoded))
}

func (s *Server) audit(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if !auditReadAllowed(p) {
		writeError(w, http.StatusForbidden, "audit read capability required")
		return
	}
	limit, offset, err := parsePageParams(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	params := []interface{}{}
	filters := []string{}
	visibility, visibilityParams := auditVisibilityPredicate(p, 1)
	filters = append(filters, visibility)
	params = append(params, visibilityParams...)
	addText := func(query, value string) {
		if value != "" {
			params = append(params, value)
			filters = append(filters, query+"$"+strconv.Itoa(len(params)))
		}
	}
	addText("ae.actor_id=", strings.TrimSpace(r.URL.Query().Get("actor_id")))
	addText("ae.action=", strings.TrimSpace(r.URL.Query().Get("action")))
	addText("ae.object_type=", strings.TrimSpace(r.URL.Query().Get("object_type")))
	addText("ae.object_id=", strings.TrimSpace(r.URL.Query().Get("object_id")))
	addText("ae.scope_type=", strings.TrimSpace(r.URL.Query().Get("scope_type")))
	addText("ae.scope_id=", strings.TrimSpace(r.URL.Query().Get("scope_id")))
	if raw := strings.TrimSpace(r.URL.Query().Get("before_id")); raw != "" {
		before, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || before < 1 {
			writeError(w, http.StatusUnprocessableEntity, "before_id must be positive")
			return
		}
		params = append(params, before)
		filters = append(filters, "ae.id<$"+strconv.Itoa(len(params)))
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("from")); raw != "" {
		from, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid from")
			return
		}
		params = append(params, from.UTC())
		filters = append(filters, "ae.created_at>=$"+strconv.Itoa(len(params)))
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("to")); raw != "" {
		to, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid to")
			return
		}
		params = append(params, to.UTC())
		filters = append(filters, "ae.created_at<$"+strconv.Itoa(len(params)))
	}
	params = append(params, limit+1)
	query := `SELECT ae.id,ae.actor_type,ae.actor_id,ae.action,ae.object_type,ae.object_id,ae.scope_type,ae.scope_id,ae.before_json,ae.after_json,ae.request_id,ae.created_at FROM audit_events ae WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY ae.id DESC LIMIT $` + strconv.Itoa(len(params)) + ` OFFSET ` + strconv.Itoa(offset)
	rows, err := s.DB.Pool.Query(r.Context(), query, params...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query audit")
		return
	}
	defer rows.Close()
	items := make([]map[string]interface{}, 0, limit+1)
	for rows.Next() {
		var id int64
		var actorType, actorID, action, objectType, objectID string
		var scopeType, scopeID, requestID *string
		var before, after []byte
		var created time.Time
		if err := rows.Scan(&id, &actorType, &actorID, &action, &objectType, &objectID, &scopeType, &scopeID, &before, &after, &requestID, &created); err != nil {
			writeError(w, 500, "could not read audit")
			return
		}
		items = append(items, map[string]interface{}{"id": id, "actor_type": actorType, "actor_id": actorID, "action": action, "object_type": objectType, "object_id": objectID, "scope_type": scopeType, "scope_id": scopeID, "before": redactAuditValue(decodeJSONBytes(before)), "after": redactAuditValue(decodeJSONBytes(after)), "request_id": requestID, "created_at": created})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read audit")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	var nextBefore interface{}
	if len(items) > 0 && hasMore {
		nextBefore = items[len(items)-1]["id"]
	}
	writeJSON(w, 200, map[string]interface{}{"items": items, "page": offset/limit + 1, "limit": limit, "has_more": hasMore, "next_before_id": nextBefore})
}

func (s *Server) observedAgentVersions(w http.ResponseWriter, r *http.Request, parts []string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if !auditReadAllowed(p) {
		writeError(w, 403, "audit read capability required")
		return
	}
	limit, offset, err := parsePageParams(r)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	lineScope, scopeParams := scopedLinePredicate(p, "l", 1)
	params := append([]interface{}{}, scopeParams...)
	filters := []string{"d.agent_telemetry_received_at IS NOT NULL", "d.agent_version IS NOT NULL", "btrim(d.agent_version) <> ''", lineScope}
	version := ""
	if len(parts) > 0 {
		version, _ = url.PathUnescape(strings.TrimSpace(parts[0]))
	}
	if version != "" {
		params = append(params, version)
		filters = append(filters, "d.agent_version=$"+strconv.Itoa(len(params)))
	}
	if len(parts) > 1 && parts[1] == "devices" {
		params = append(params, limit+1)
		query := `SELECT d.id,d.display_name,d.hostname,d.agent_version,d.last_seen,mp.id,l.id,scoped_org.school_id,scoped_org.name FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id JOIN lines l ON l.id=mp.line_id JOIN organizations scoped_org ON scoped_org.id=l.organization_id WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY d.last_seen DESC NULLS LAST,d.id LIMIT $` + strconv.Itoa(len(params)) + ` OFFSET ` + strconv.Itoa(offset)
		rows, queryErr := s.DB.Pool.Query(r.Context(), query, params...)
		if queryErr != nil {
			writeError(w, 500, "could not query observed devices")
			return
		}
		defer rows.Close()
		items := []map[string]interface{}{}
		for rows.Next() {
			var id, version string
			var display, host *string
			var seen *time.Time
			var point, line, school, name string
			if scanErr := rows.Scan(&id, &display, &host, &version, &seen, &point, &line, &school, &name); scanErr != nil {
				writeError(w, 500, "could not read observed devices")
				return
			}
			items = append(items, map[string]interface{}{"id": id, "display_name": display, "hostname": host, "agent_version": version, "last_seen": seen, "monitoring_point_id": point, "line_id": line, "school_id": school, "school_name": name})
		}
		hasMore := len(items) > limit
		if hasMore {
			items = items[:limit]
		}
		writeJSON(w, 200, map[string]interface{}{"items": items, "version": version, "page": offset/limit + 1, "limit": limit, "has_more": hasMore})
		return
	}
	params = append(params, limit+1)
	query := `SELECT d.agent_version,COUNT(*),MAX(d.last_seen) FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id JOIN lines l ON l.id=mp.line_id JOIN organizations scoped_org ON scoped_org.id=l.organization_id WHERE ` + strings.Join(filters, " AND ") + ` GROUP BY d.agent_version ORDER BY COUNT(*) DESC,d.agent_version LIMIT $` + strconv.Itoa(len(params)) + ` OFFSET ` + strconv.Itoa(offset)
	rows, queryErr := s.DB.Pool.Query(r.Context(), query, params...)
	if queryErr != nil {
		writeError(w, 500, "could not query observed versions")
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var v string
		var count int64
		var last *time.Time
		if scanErr := rows.Scan(&v, &count, &last); scanErr != nil {
			writeError(w, 500, "could not read observed versions")
			return
		}
		items = append(items, map[string]interface{}{"version": v, "device_count": count, "last_seen": last, "source": "observed_telemetry"})
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	writeJSON(w, 200, map[string]interface{}{"items": items, "page": offset/limit + 1, "limit": limit, "has_more": hasMore, "source": "observed_telemetry"})
}
