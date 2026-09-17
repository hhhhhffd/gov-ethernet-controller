package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/measurements"
)

func (s *Server) listSituations(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if err := s.refreshSituations(r.Context()); err != nil {
		writeError(w, 500, "could not refresh situations")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at FROM situations WHERE status='OPEN' ORDER BY start_at DESC,id DESC`)
	if err != nil {
		writeError(w, 500, "could not query situations")
		return
	}
	defer rows.Close()
	situations := []situationRecord{}
	for rows.Next() {
		item, scanErr := scanSituation(rows)
		if scanErr != nil {
			writeError(w, 500, "could not read situation")
			return
		}
		situations = append(situations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeError(w, 500, "could not read situations")
		return
	}
	rows.Close()
	result := []map[string]interface{}{}
	for _, item := range situations {
		members, memberErr := s.situationMembers(r.Context(), item.ID)
		if memberErr != nil {
			writeError(w, 500, "could not read situation members")
			return
		}
		visible := true
		ids := make([]int64, 0, len(members))
		for _, memberID := range members {
			var lineID, organizationID, district, providerID string
			if err := s.DB.Pool.QueryRow(r.Context(), `SELECT i.line_id,l.organization_id,o.district,COALESCE(l.provider_id,'') FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE i.id=$1`, memberID).Scan(&lineID, &organizationID, &district, &providerID); err != nil {
				visible = false
				break
			}
			if !auth.HasLineScope(p, lineID, organizationID, district, providerID) {
				visible = false
				break
			}
			ids = append(ids, memberID)
		}
		if !visible {
			continue
		}
		reason := decodeJSONBytes(item.Reason)
		provider := item.ProviderID
		if reasonMap, ok := reason.(map[string]interface{}); ok {
			if value, ok := reasonMap["provider"].(string); ok && value != "" {
				provider = value
			}
		}
		result = append(result, map[string]interface{}{"id": item.ID, "title": item.Title, "status": item.Status, "provider_id": nullableString(item.ProviderID), "district": item.District, "violation_type": item.ViolationType, "affected_count": len(ids), "incident_ids": ids, "start_at": item.StartAt, "started_at": item.StartAt, "reason": reason, "provider": provider, "severity": severity(item.ViolationType)})
	}
	writeJSON(w, 200, result)
}

type situationRecord struct {
	ID                                  int64
	Title, Status, ProviderID, District string
	ViolationType                       string
	StartAt, CreatedAt, UpdatedAt       time.Time
	Reason                              []byte
}

type situationGroupKey struct {
	ProviderID, District, ViolationType string
	StartAt                             time.Time
}

type situationMember struct {
	IncidentID             int64
	LineID, ProviderID     string
	ProviderName, District string
	ViolationType          string
	StartedAt              time.Time
}

func scanSituation(row interface{ Scan(...interface{}) error }) (situationRecord, error) {
	var item situationRecord
	var providerID, district, violation *string
	err := row.Scan(&item.ID, &item.Title, &item.Status, &providerID, &district, &violation, &item.StartAt, &item.Reason, &item.CreatedAt, &item.UpdatedAt)
	if providerID != nil {
		item.ProviderID = *providerID
	}
	if district != nil {
		item.District = *district
	}
	if violation != nil {
		item.ViolationType = *violation
	}
	return item, err
}

func (s *Server) refreshSituations(ctx context.Context) error {
	minimum := 2
	for _, key := range []string{"LINKWATCH_SITUATION_MIN_MEMBERS", "VKO_SITUATION_MIN_MEMBERS"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if parsed, err := strconv.Atoi(value); err == nil {
				minimum = parsed
				break
			}
		}
	}
	if minimum < 2 {
		minimum = 2
	}
	if minimum > 100 {
		minimum = 100
	}
	rows, err := s.DB.Pool.Query(ctx, `SELECT i.id,i.line_id,i.violation_type,i.started_at,COALESCE(l.provider_id,''),COALESCE(p.name,''),o.district FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE i.status <> 'CLOSED' ORDER BY i.started_at,i.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	groups := map[situationGroupKey][]situationMember{}
	for rows.Next() {
		var member situationMember
		if err := rows.Scan(&member.IncidentID, &member.LineID, &member.ViolationType, &member.StartedAt, &member.ProviderID, &member.ProviderName, &member.District); err != nil {
			return err
		}
		started := member.StartedAt.UTC()
		bucket := started.Truncate(15 * time.Minute)
		key := situationGroupKey{ProviderID: member.ProviderID, District: member.District, ViolationType: member.ViolationType, StartAt: bucket}
		groups[key] = append(groups[key], member)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	existingRows, err := s.DB.Pool.Query(ctx, `SELECT id,provider_id,district,violation_type,start_at FROM situations WHERE status='OPEN'`)
	if err != nil {
		return err
	}
	existing := map[situationGroupKey]int64{}
	for existingRows.Next() {
		var id int64
		var providerID, district, violation *string
		var startAt time.Time
		if err := existingRows.Scan(&id, &providerID, &district, &violation, &startAt); err != nil {
			existingRows.Close()
			return err
		}
		key := situationGroupKey{StartAt: startAt.UTC()}
		if providerID != nil {
			key.ProviderID = *providerID
		}
		if district != nil {
			key.District = *district
		}
		if violation != nil {
			key.ViolationType = *violation
		}
		existing[key] = id
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return err
	}
	existingRows.Close()
	active := map[int64]bool{}
	now := time.Now().UTC().Truncate(time.Second)
	for key, members := range groups {
		if len(members) < minimum {
			continue
		}
		providerName := ""
		if len(members) > 0 {
			providerName = members[0].ProviderName
		}
		reason := map[string]interface{}{"provider": providerName, "provider_id": nullableString(key.ProviderID), "district": key.District, "violation_type": key.ViolationType, "time_window_minutes": 15, "minimum_members": minimum, "member_count": len(members)}
		reasonJSON, _ := json.Marshal(reason)
		title := fmt.Sprintf("Возможная ситуация: %s / %s", firstNonEmpty(providerName, "неизвестный provider"), key.District)
		id, found := existing[key]
		if found {
			if _, err := s.DB.Pool.Exec(ctx, `UPDATE situations SET title=$1,reason_json=$2::jsonb,updated_at=$3 WHERE id=$4`, title, string(reasonJSON), now, id); err != nil {
				return err
			}
		} else {
			if err := s.DB.Pool.QueryRow(ctx, `INSERT INTO situations(title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at) VALUES ($1,'OPEN',$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING id`, title, nullableString(key.ProviderID), nullableString(key.District), nullableString(key.ViolationType), key.StartAt, string(reasonJSON), now).Scan(&id); err != nil {
				return err
			}
		}
		active[id] = true
		if _, err := s.DB.Pool.Exec(ctx, `DELETE FROM situation_members WHERE situation_id=$1`, id); err != nil {
			return err
		}
		for _, member := range members {
			if _, err := s.DB.Pool.Exec(ctx, `INSERT INTO situation_members(situation_id,incident_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, member.IncidentID); err != nil {
				return err
			}
		}
	}
	for _, id := range existing {
		if !active[id] {
			if _, err := s.DB.Pool.Exec(ctx, `UPDATE situations SET status='CLOSED',updated_at=$1 WHERE id=$2`, now, id); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) situationMembers(ctx context.Context, situationID int64) ([]int64, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT incident_id FROM situation_members WHERE situation_id=$1 ORDER BY incident_id`, situationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func severity(violationType string) string {
	if violationType == "NO_INTERNET" {
		return "CRITICAL"
	}
	return "ATTENTION"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *Server) situationDetail(w http.ResponseWriter, r *http.Request, id string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if err := s.refreshSituations(r.Context()); err != nil {
		writeError(w, 500, "could not refresh situations")
		return
	}
	situationID, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		writeError(w, 404, "situation not found")
		return
	}
	var item situationRecord
	if item, err = scanSituation(s.DB.Pool.QueryRow(r.Context(), `SELECT id,title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at FROM situations WHERE id=$1`, situationID)); err != nil {
		writeError(w, 404, "situation not found")
		return
	}
	memberIDs, err := s.situationMembers(r.Context(), item.ID)
	if err != nil || len(memberIDs) == 0 {
		writeError(w, 404, "situation not found")
		return
	}
	incidents := make([]map[string]interface{}, 0, len(memberIDs))
	for _, memberID := range memberIDs {
		incident, visible := s.loadIncident(r.Context(), memberID, p)
		if !visible {
			writeError(w, 404, "situation not found")
			return
		}
		incidents = append(incidents, s.incidentMap(r.Context(), incident))
	}
	writeJSON(w, 200, map[string]interface{}{"id": item.ID, "title": item.Title, "status": item.Status, "provider_id": nullableString(item.ProviderID), "district": nullableString(item.District), "violation_type": nullableString(item.ViolationType), "start_at": item.StartAt, "started_at": item.StartAt, "incident_ids": memberIDs, "affected_count": len(memberIDs), "incidents": incidents, "reason": decodeJSONBytes(item.Reason)})
}

func (s *Server) audit(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if p.Role != "ADMIN" && p.Role != "OBLAST" {
		writeError(w, 403, "administrator role required")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,actor_type,actor_id,action,object_type,object_id,scope_type,scope_id,before_json,after_json,request_id,created_at FROM audit_events ORDER BY id DESC LIMIT 500`)
	if err != nil {
		writeError(w, 500, "could not query audit")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id int64
		var actorType, actorID, action, objType, objID string
		var scopeType, scopeID, requestID *string
		var before, after []byte
		var created time.Time
		if rows.Scan(&id, &actorType, &actorID, &action, &objType, &objID, &scopeType, &scopeID, &before, &after, &requestID, &created) == nil {
			result = append(result, map[string]interface{}{"id": id, "actor_type": actorType, "actor_id": actorID, "action": action, "object_type": objType, "object_id": objID, "scope_type": scopeType, "scope_id": scopeID, "before": decodeJSONBytes(before), "after": decodeJSONBytes(after), "request_id": requestID, "created_at": created})
		}
	}
	writeJSON(w, 200, result)
}

func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT n.id,n.source_type,n.source_id,n.channel,n.recipient_scope,n.message,n.status,n.delivery_attempts,n.delivery_error,n.delivery_retryable,n.next_attempt_at,n.delivery_started_at,n.generated_at,n.sent_at,n.read_at FROM notifications n JOIN lines l ON l.id=n.recipient_scope JOIN organizations o ON o.id=l.organization_id WHERE `+where+` ORDER BY n.id DESC`, params...)
	if err != nil {
		writeError(w, 500, "could not query notifications")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id int64
		var sourceType, sourceID, channel, scope, message, status string
		var attempts int
		var delivery *string
		var retryable bool
		var nextAttempt, deliveryStarted, generated, sent, read *time.Time
		if rows.Scan(&id, &sourceType, &sourceID, &channel, &scope, &message, &status, &attempts, &delivery, &retryable, &nextAttempt, &deliveryStarted, &generated, &sent, &read) == nil {
			result = append(result, map[string]interface{}{"id": id, "source_type": sourceType, "source_id": sourceID, "channel": channel, "recipient_scope": scope, "message": message, "status": status, "delivery_attempts": attempts, "delivery_error": delivery, "delivery_retryable": retryable, "next_attempt_at": nextAttempt, "delivery_started_at": deliveryStarted, "generated_at": generated, "sent_at": sent, "read_at": read})
		}
	}
	writeJSON(w, 200, result)
}

func (s *Server) notificationDispatch(w http.ResponseWriter, r *http.Request, p *auth.Principal, id string) {
	if !requireAdmin(w, p) {
		return
	}
	notificationID, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		writeError(w, 404, "notification not found")
		return
	}
	delivery, deliveryErr := s.Measure.DispatchNotification(r.Context(), notificationID)
	if deliveryErr != nil {
		if strings.Contains(deliveryErr.Error(), "not pending") {
			writeError(w, http.StatusNotFound, "notification not found or already delivered")
			return
		}
		writeError(w, http.StatusBadGateway, "notification delivery failed; retry is available")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"id": notificationID, "status": "SENT", "delivery_channel": delivery.Channel})
}

func (s *Server) demoReplay(w http.ResponseWriter, r *http.Request) {
	if strings.ToLower(getenv("LINKWATCH_ENV", "development")) == "production" {
		writeError(w, 404, "demo replay is disabled in production")
		return
	}
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	line, visible := s.lineVisible(r.Context(), p, "line-42-primary")
	if !visible {
		writeError(w, 404, "demo line not found")
		return
	}
	var deviceID, pointID, version string
	var tokenHash string
	_ = tokenHash
	err := s.DB.Pool.QueryRow(r.Context(), `SELECT d.id,d.monitoring_point_id,d.agent_version FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id WHERE mp.line_id=$1 AND d.blocked_at IS NULL ORDER BY d.id LIMIT 1`, line.ID).Scan(&deviceID, &pointID, &version)
	if err != nil {
		writeError(w, 404, "demo device not found")
		return
	}
	start := time.Now().UTC().Add(-3 * time.Minute).Truncate(time.Second)
	values := []float64{42, 39, 41}
	results := []interface{}{}
	for i, value := range values {
		result, processErr := s.Measure.Process(r.Context(), deviceID, line.ID, pointID, version, measurements.Input{ClientEventID: measurements.RandomEventID(), ObservedAt: start.Add(time.Duration(i) * time.Minute), Mode: "PERFORMANCE", Download: &value, Upload: ptrFloat(44), Ping: ptrFloat(22), Jitter: ptrFloat(7), PacketLoss: ptrFloat(.4), Availability: ptrFloat(100), ConnectionStatus: "OK", Quality: "VALID", Raw: map[string]interface{}{"source": "demo-replay"}})
		if processErr != nil {
			writeError(w, 500, processErr.Error())
			return
		}
		results = append(results, result)
	}
	writeJSON(w, 200, map[string]interface{}{"scenario": "school-42", "line_id": line.ID, "results": results})
}

func ptrFloat(value float64) *float64 { return &value }
func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
