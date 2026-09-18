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
		ids := make([]int64, 0, len(members))
		for _, memberID := range members {
			var lineID, organizationID, district, providerID string
			if err := s.DB.Pool.QueryRow(r.Context(), `SELECT i.line_id,l.organization_id,o.district,COALESCE(l.provider_id,'') FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE i.id=$1`, memberID).Scan(&lineID, &organizationID, &district, &providerID); err != nil {
				writeError(w, 500, "could not read situation member")
				return
			}
			if !auth.HasLineScope(p, lineID, organizationID, district, providerID) {
				continue
			}
			ids = append(ids, memberID)
		}
		if len(ids) == 0 {
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
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(742033)`); err != nil {
		return err
	}
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
	rows, err := tx.Query(ctx, `SELECT i.id,i.line_id,i.violation_type,i.started_at,COALESCE(l.provider_id,''),COALESCE(p.name,''),o.district FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE i.status <> 'CLOSED' ORDER BY i.started_at,i.id`)
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
	existingRows, err := tx.Query(ctx, `SELECT id,provider_id,district,violation_type,start_at,reason_json FROM situations WHERE status='OPEN'`)
	if err != nil {
		return err
	}
	existing := map[situationGroupKey]int64{}
	protected := map[int64]bool{}
	for existingRows.Next() {
		var id int64
		var providerID, district, violation *string
		var startAt time.Time
		var reasonRaw []byte
		if err := existingRows.Scan(&id, &providerID, &district, &violation, &startAt, &reasonRaw); err != nil {
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
		if reason, ok := decodeJSONBytes(reasonRaw).(map[string]interface{}); ok {
			if _, manual := reason["manual_action"]; manual {
				protected[id] = true
			}
		}
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return err
	}
	existingRows.Close()
	active := map[int64]bool{}
	for id := range protected {
		active[id] = true
	}
	now := time.Now().UTC().Truncate(time.Second)
	for key, members := range groups {
		if id, manual := existing[key]; manual && protected[id] {
			continue
		}
		if len(members) < minimum {
			continue
		}
		providerName := ""
		if len(members) > 0 {
			providerName = members[0].ProviderName
		}
		reason := map[string]interface{}{"provider": providerName, "provider_id": nullableString(key.ProviderID), "district": key.District, "violation_type": key.ViolationType, "time_window_minutes": 15, "minimum_members": minimum, "member_count": len(members)}
		reasonJSON, err := json.Marshal(reason)
		if err != nil {
			return fmt.Errorf("marshal situation reason: %w", err)
		}
		title := fmt.Sprintf("Возможная ситуация: %s / %s", firstNonEmpty(providerName, "неизвестный provider"), key.District)
		id, found := existing[key]
		if found {
			if _, err := tx.Exec(ctx, `UPDATE situations SET title=$1,reason_json=$2::jsonb,updated_at=$3 WHERE id=$4`, title, string(reasonJSON), now, id); err != nil {
				return err
			}
		} else {
			if err := tx.QueryRow(ctx, `INSERT INTO situations(title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at) VALUES ($1,'OPEN',$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING id`, title, nullableString(key.ProviderID), nullableString(key.District), nullableString(key.ViolationType), key.StartAt, string(reasonJSON), now).Scan(&id); err != nil {
				return err
			}
		}
		active[id] = true
		if _, err := tx.Exec(ctx, `DELETE FROM situation_members WHERE situation_id=$1`, id); err != nil {
			return err
		}
		for _, member := range members {
			if _, err := tx.Exec(ctx, `INSERT INTO situation_members(situation_id,incident_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, member.IncidentID); err != nil {
				return err
			}
		}
	}
	for _, id := range existing {
		if !active[id] {
			if _, err := tx.Exec(ctx, `UPDATE situations SET status='CLOSED',updated_at=$1 WHERE id=$2`, now, id); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// RefreshSituations reconciles materialized situations from current incidents.
// Callers should use it from a worker rather than from read handlers.
func (s *Server) RefreshSituations(ctx context.Context) error {
	return s.refreshSituations(ctx)
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
	visibleMemberIDs := make([]int64, 0, len(memberIDs))
	var latestConfirmation *time.Time
	evidenceCounts := map[string]int{"AVAILABLE": 0, "NO_DATA": 0, "UNKNOWN": 0}
	for _, memberID := range memberIDs {
		incident, visible := s.loadIncident(r.Context(), memberID, p)
		if !visible {
			continue
		}
		mapped, mapErr := s.incidentMap(r.Context(), incident)
		if mapErr != nil {
			writeError(w, 500, "could not read incident details")
			return
		}
		evidenceIDs := incidentEvidenceIDs(decodeJSONBytes(incident.Opening))
		evidenceState := situationEvidenceState(evidenceIDs, incident.ConfirmedAt)
		mapped["line"] = map[string]interface{}{"id": incident.LineID, "url": "/api/lines/" + incident.LineID}
		mapped["evidence"] = map[string]interface{}{"state": evidenceState, "measurement_ids": evidenceIDs, "incident_url": "/api/incidents/" + strconv.FormatInt(incident.ID, 10)}
		visibleMemberIDs = append(visibleMemberIDs, memberID)
		evidenceCounts[evidenceState]++
		if incident.ConfirmedAt != nil && (latestConfirmation == nil || incident.ConfirmedAt.After(*latestConfirmation)) {
			confirmed := *incident.ConfirmedAt
			latestConfirmation = &confirmed
		}
		incidents = append(incidents, mapped)
	}
	if len(visibleMemberIDs) == 0 {
		writeError(w, 404, "situation not found")
		return
	}
	relations, relationErr := s.situationRelations(r.Context(), item.ID)
	if relationErr != nil {
		writeError(w, 500, "could not read situation lifecycle")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"id": item.ID, "title": item.Title, "status": item.Status, "read_only": true, "projection": "materialized situation and canonical incident evidence", "causal_claim": false, "correlation_only": true, "provider_id": nullableString(item.ProviderID), "district": nullableString(item.District), "violation_type": nullableString(item.ViolationType), "start_at": item.StartAt, "started_at": item.StartAt, "latest_confirmation_at": latestConfirmation, "incident_ids": visibleMemberIDs, "affected_count": len(visibleMemberIDs), "incidents": incidents, "lifecycle": relations, "actions": map[string]interface{}{"merge": item.Status == "OPEN" && situationManageAllowed(p), "split": item.Status == "OPEN" && situationManageAllowed(p)}, "factors": map[string]interface{}{"provider_id": nullableString(item.ProviderID), "district": nullableString(item.District), "violation_type": nullableString(item.ViolationType), "time_window_minutes": 15}, "evidence": map[string]interface{}{"member_states": evidenceCounts, "state": situationEvidenceAggregate(evidenceCounts)}, "grouping": decodeJSONBytes(item.Reason), "reason": decodeJSONBytes(item.Reason)})
}

func (s *Server) situationRelations(ctx context.Context, id int64) ([]map[string]interface{}, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT source_situation_id,target_situation_id,relation_type,event_id,created_at FROM situation_relations WHERE source_situation_id=$1 OR target_situation_id=$1 ORDER BY created_at,source_situation_id,target_situation_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var source, target, event int64
		var relation string
		var created time.Time
		if err := rows.Scan(&source, &target, &relation, &event, &created); err != nil {
			return nil, err
		}
		result = append(result, map[string]interface{}{"source_situation_id": source, "target_situation_id": target, "relation_type": relation, "event_id": event, "created_at": created})
	}
	return result, rows.Err()
}

func situationEvidenceState(ids []int64, confirmedAt *time.Time) string {
	if len(ids) > 0 {
		return "AVAILABLE"
	}
	if confirmedAt == nil {
		return "NO_DATA"
	}
	return "UNKNOWN"
}

func situationEvidenceAggregate(counts map[string]int) string {
	if counts["AVAILABLE"] > 0 {
		return "AVAILABLE"
	}
	if counts["UNKNOWN"] > 0 {
		return "UNKNOWN"
	}
	return "NO_DATA"
}

func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	filters := []string{where}
	if value := strings.TrimSpace(r.URL.Query().Get("source_type")); value != "" {
		params = append(params, strings.ToUpper(value))
		filters = append(filters, "n.source_type=$"+itoa(len(params)))
	}
	if value := strings.TrimSpace(r.URL.Query().Get("status")); value != "" {
		params = append(params, strings.ToUpper(value))
		filters = append(filters, "n.status=$"+itoa(len(params)))
	}
	if value := strings.TrimSpace(r.URL.Query().Get("before_id")); value != "" {
		before, parseErr := strconv.ParseInt(value, 10, 64)
		if parseErr != nil || before < 1 {
			writeError(w, http.StatusUnprocessableEntity, "before_id must be a positive notification id")
			return
		}
		params = append(params, before)
		filters = append(filters, "n.id<$"+itoa(len(params)))
	}
	limit := notificationLimit(r.URL.Query().Get("limit"))
	params = append(params, limit)
	query := `SELECT n.id,n.source_type,n.source_id,n.channel,n.recipient_scope,n.message,n.status,n.delivery_attempts,n.delivery_error,n.delivery_retryable,n.next_attempt_at,n.delivery_started_at,n.generated_at,n.sent_at,n.read_at,
        l.organization_id,o.school_id,o.name,o.district,l.provider_id,
        CASE WHEN i.id IS NULL THEN NULL ELSE i.id END,
        CASE WHEN i.id IS NULL THEN NULL ELSE i.line_id END
        FROM notifications n
        JOIN lines l ON l.id=n.recipient_scope
        JOIN organizations o ON o.id=l.organization_id
        LEFT JOIN incidents i ON i.id=CASE WHEN n.source_id ~ '^[0-9]+$' THEN n.source_id::bigint ELSE NULL END AND n.source_type='INCIDENT' AND i.line_id=l.id
        WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY n.id DESC LIMIT $` + itoa(len(params))
	rows, err := s.DB.Pool.Query(r.Context(), query, params...)
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
		var organizationID, schoolID, schoolName, district, providerID string
		var incidentID *int64
		var incidentLineID *string
		if err := rows.Scan(&id, &sourceType, &sourceID, &channel, &scope, &message, &status, &attempts, &delivery, &retryable, &nextAttempt, &deliveryStarted, &generated, &sent, &read, &organizationID, &schoolID, &schoolName, &district, &providerID, &incidentID, &incidentLineID); err != nil {
			writeError(w, 500, "could not read notifications")
			return
		}
		item := map[string]interface{}{"id": id, "source_type": sourceType, "source_id": sourceID, "channel": channel, "recipient_scope": scope, "message": message, "status": status, "delivery_attempts": attempts, "delivery_error": delivery, "delivery_retryable": retryable, "next_attempt_at": nextAttempt, "delivery_started_at": deliveryStarted, "generated_at": generated, "sent_at": sent, "read_at": read, "line_id": scope, "organization_id": organizationID, "school_id": schoolID, "school_name": schoolName, "district": district, "provider_id": providerID}
		if incidentID != nil {
			item["incident_id"] = *incidentID
		}
		if incidentLineID != nil {
			item["incident_line_id"] = *incidentLineID
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read notifications")
		return
	}
	writeJSON(w, 200, result)
}

func notificationLimit(value string) int {
	limit, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || limit < 1 {
		return 50
	}
	if limit > 100 {
		return 100
	}
	return limit
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
		writeAudit(r.Context(), s, p, "notification.delivery_failed", "notification", id, nil, map[string]interface{}{"status": "FAILED"})
		if strings.Contains(deliveryErr.Error(), "not pending") {
			writeError(w, http.StatusNotFound, "notification not found or already delivered")
			return
		}
		writeError(w, http.StatusBadGateway, "notification delivery failed; retry is available")
		return
	}
	writeAudit(r.Context(), s, p, "notification.sent", "notification", id, nil, map[string]interface{}{"status": "SENT", "delivery_channel": delivery.Channel})
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
	if !requireAdmin(w, p) {
		return
	}
	line, visible, lineErr := s.lineVisible(r.Context(), p, "line-42-primary")
	if lineErr != nil {
		writeError(w, 500, "could not query demo line")
		return
	}
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
