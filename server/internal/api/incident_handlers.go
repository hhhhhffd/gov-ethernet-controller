package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/measurements"
	"linkwatch/server/internal/providers"
)

type incidentRecord struct {
	ID                                                                                             int64
	Number, LineID, OrganizationID, SchoolID, OrganizationName, District, ProviderID, ProviderName string
	Source, ViolationType, Status, RecoveryState                                                   string
	StartedAt                                                                                      time.Time
	ConfirmedAt, ResolvedAt, ClosedAt                                                              *time.Time
	Duration                                                                                       *float64
	Assignee                                                                                       *string
	RecurrenceOf                                                                                   *int64
	Opening                                                                                        []byte
}

func (s *Server) scanIncident(row interface{ Scan(...interface{}) error }) (incidentRecord, error) {
	var item incidentRecord
	var providerID, providerName *string
	err := row.Scan(&item.ID, &item.Number, &item.LineID, &item.Source, &item.ViolationType, &item.Status, &item.RecoveryState, &item.StartedAt, &item.ConfirmedAt, &item.ResolvedAt, &item.ClosedAt, &item.Duration, &item.Assignee, &item.RecurrenceOf, &item.Opening, &item.OrganizationID, &providerID, &item.SchoolID, &item.OrganizationName, &item.District, &providerName)
	if providerID != nil {
		item.ProviderID = *providerID
	}
	if providerName != nil {
		item.ProviderName = *providerName
	}
	return item, err
}

func (s *Server) incidentMap(ctx context.Context, item incidentRecord) (map[string]interface{}, error) { // context import is supplied by the file below through alias helper
	opening := decodeJSONBytes(item.Opening)
	title := map[bool]string{true: "Подтверждённое отсутствие соединения", false: "Подтверждённое нарушение " + item.ViolationType}[item.ViolationType == "NO_INTERNET"]
	description := title
	if snapshot, ok := opening.(map[string]interface{}); ok {
		if value, ok := snapshot["manual_description"].(string); ok && strings.TrimSpace(value) != "" {
			description = value
		} else if value, ok := snapshot["reason"].(string); ok && strings.TrimSpace(value) != "" {
			description = value
		}
	}
	provider := item.ProviderName
	if provider == "" {
		provider = "—"
	}
	duration := item.Duration
	if duration == nil {
		value := time.Since(item.StartedAt).Minutes()
		if value < 0 {
			value = 0
		}
		duration = &value
	}
	result := map[string]interface{}{"id": item.ID, "incident_no": item.Number, "number": item.Number, "line_id": item.LineID, "organization_id": item.OrganizationID, "school_id": item.SchoolID, "organization_name": item.OrganizationName, "school_name": item.OrganizationName, "district": item.District, "provider_id": item.ProviderID, "provider_name": item.ProviderName, "provider": provider, "source": item.Source, "violation_type": item.ViolationType, "status": item.Status, "recovery_state": item.RecoveryState, "started_at": item.StartedAt, "confirmed_at": item.ConfirmedAt, "resolved_at": item.ResolvedAt, "closed_at": item.ClosedAt, "duration_minutes": duration, "assignee": item.Assignee, "recurrence_of": item.RecurrenceOf, "opening_snapshot": opening, "severity": map[bool]string{true: "CRITICAL", false: "ATTENTION"}[item.ViolationType == "NO_INTERNET"], "title": title, "description": description}
	events := []map[string]interface{}{}
	rows, err := s.DB.Pool.Query(ctx, `SELECT id,event_type,actor,payload_json,created_at FROM incident_events WHERE incident_id=$1 ORDER BY id`, item.ID)
	if err != nil {
		return nil, fmt.Errorf("query incident events: %w", err)
	}
	for rows.Next() {
		var id int64
		var typ, actor string
		var payload []byte
		var at time.Time
		if err := rows.Scan(&id, &typ, &actor, &payload, &at); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan incident event: %w", err)
		}
		events = append(events, map[string]interface{}{"id": id, "event_type": typ, "actor": actor, "payload": decodeJSONBytes(payload), "created_at": at, "at": at, "text": typ})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate incident events: %w", err)
	}
	rows.Close()
	result["events"] = events
	actions := []map[string]interface{}{}
	for _, event := range events {
		actions = append(actions, map[string]interface{}{"at": event["at"], "text": event["text"], "actor": event["actor"], "payload": event["payload"]})
	}
	result["actions"] = actions
	providerCases, err := s.providerCases(ctx, item.ID)
	if err != nil {
		return nil, err
	}
	result["provider_cases"] = providerCases
	return result, nil
}

func (s *Server) incidentListForLine(ctx context.Context, lineID string) ([]map[string]interface{}, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT i.id,i.incident_no,i.line_id,i.source,i.violation_type,i.status,i.recovery_state,i.started_at,i.confirmed_at,i.resolved_at,i.closed_at,i.duration_minutes,i.assignee,i.recurrence_of,i.opening_snapshot_json,l.organization_id,l.provider_id,o.school_id,o.name,o.district,p.name FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE i.line_id=$1 ORDER BY i.id DESC`, lineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []incidentRecord{}
	for rows.Next() {
		item, scanErr := s.scanIncident(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		mapped, mapErr := s.incidentMap(ctx, item)
		if mapErr != nil {
			return nil, mapErr
		}
		result = append(result, mapped)
	}
	return result, nil
}

func (s *Server) listIncidents(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	filters := []string{where}
	if lineID := r.URL.Query().Get("line_id"); lineID != "" {
		params = append(params, lineID)
		filters = append(filters, "i.line_id=$"+itoa(len(params)))
	}
	if status := r.URL.Query().Get("status"); status != "" {
		params = append(params, status)
		filters = append(filters, "i.status=$"+itoa(len(params)))
	}
	query := `SELECT i.id,i.incident_no,i.line_id,i.source,i.violation_type,i.status,i.recovery_state,i.started_at,i.confirmed_at,i.resolved_at,i.closed_at,i.duration_minutes,i.assignee,i.recurrence_of,i.opening_snapshot_json,l.organization_id,l.provider_id,o.school_id,o.name,o.district,p.name FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY i.id DESC`
	rows, err := s.DB.Pool.Query(r.Context(), query, params...)
	if err != nil {
		writeError(w, 500, "could not query incidents")
		return
	}
	defer rows.Close()
	items := []incidentRecord{}
	for rows.Next() {
		item, scanErr := s.scanIncident(rows)
		if scanErr != nil {
			writeError(w, 500, "could not read incident")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read incidents")
		return
	}
	rows.Close()
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		mapped, mapErr := s.incidentMap(r.Context(), item)
		if mapErr != nil {
			writeError(w, 500, "could not read incident details")
			return
		}
		result = append(result, mapped)
	}
	writeJSON(w, 200, result)
}

func (s *Server) incidentRoute(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) < 1 {
		writeError(w, 404, "incident not found")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, 404, "incident not found")
		return
	}
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	item, visible := s.loadIncident(r.Context(), id, p)
	if !visible {
		writeError(w, 404, "incident not found")
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		mapped, mapErr := s.incidentMap(r.Context(), item)
		if mapErr != nil {
			writeError(w, 500, "could not read incident details")
			return
		}
		writeJSON(w, 200, mapped)
		return
	}
	if len(parts) >= 2 && parts[1] == "events" && r.Method == http.MethodPost {
		s.incidentEvent(w, r, item, p)
		return
	}
	if len(parts) >= 3 && parts[1] == "provider-case" && parts[2] == "draft" && r.Method == http.MethodPost {
		s.providerDraft(w, r, item, p)
		return
	}
	writeError(w, 404, "not found")
}

func (s *Server) loadIncident(ctx context.Context, id int64, p *auth.Principal) (incidentRecord, bool) {
	var item incidentRecord
	item, err := s.scanIncident(s.DB.Pool.QueryRow(ctx, `SELECT i.id,i.incident_no,i.line_id,i.source,i.violation_type,i.status,i.recovery_state,i.started_at,i.confirmed_at,i.resolved_at,i.closed_at,i.duration_minutes,i.assignee,i.recurrence_of,i.opening_snapshot_json,l.organization_id,l.provider_id,o.school_id,o.name,o.district,p.name FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE i.id=$1`, id))
	if err != nil {
		return incidentRecord{}, false
	}
	return item, auth.HasLineScope(p, item.LineID, item.OrganizationID, item.District, item.ProviderID)
}

func (s *Server) createManualIncident(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var payload struct {
		LineID        string  `json:"line_id"`
		ViolationType string  `json:"violation_type"`
		Description   string  `json:"description"`
		Assignee      *string `json:"assignee"`
		Source        string  `json:"source"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid incident payload")
		return
	}
	line, visible, lineErr := s.lineVisible(r.Context(), p, payload.LineID)
	if lineErr != nil {
		writeError(w, 500, "could not query line")
		return
	}
	if !visible {
		writeError(w, 404, "line not found")
		return
	}
	if payload.ViolationType == "" {
		payload.ViolationType = "MANUAL_REVIEW"
	}
	if payload.Source == "" {
		payload.Source = "MANUAL"
	}
	now := time.Now().UTC().Truncate(time.Second)
	snapshot, err := json.Marshal(map[string]interface{}{"manual_description": payload.Description, "line_id": line.ID, "reason": payload.Description, "evidence_measurement_ids": []int64{}, "manual": true})
	if err != nil {
		writeError(w, 500, "could not encode incident snapshot")
		return
	}
	var id int64
	err = s.DB.Pool.QueryRow(r.Context(), `INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,opening_snapshot_json,created_at,assignee) VALUES ($1,$2,'MANUAL',$3,'NEW','NONE',$4,$5::jsonb,$4,$6) RETURNING id`, "PENDING-"+measurements.RandomEventID(), line.ID, payload.ViolationType, now, string(snapshot), payload.Assignee).Scan(&id)
	if err != nil {
		writeError(w, 500, "could not create incident")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET incident_no=$1 WHERE id=$2`, fmt.Sprintf("INC-%06d", id), id); err != nil {
		writeError(w, 500, "could not number incident")
		return
	}
	eventPayload, err := json.Marshal(map[string]interface{}{"description": payload.Description})
	if err != nil {
		writeError(w, 500, "could not encode incident event")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'MANUAL_CREATED',$2,$3::jsonb,$4)`, id, p.ID, string(eventPayload), now); err != nil {
		writeError(w, 500, "could not record incident event")
		return
	}
	writeAudit(r.Context(), s, p, "incident.created_manual", "incident", fmt.Sprint(id), nil, map[string]interface{}{"line_id": line.ID, "manual_description": payload.Description})
	fresh, freshErr := mustIncident(s, id)
	if freshErr != nil {
		writeError(w, 500, "could not read incident")
		return
	}
	mapped, mapErr := s.incidentMap(r.Context(), fresh)
	if mapErr != nil {
		writeError(w, 500, "could not read incident details")
		return
	}
	writeJSON(w, 201, mapped)
}

func mustIncident(s *Server, id int64) (incidentRecord, error) {
	return s.scanIncident(s.DB.Pool.QueryRow(context.Background(), `SELECT i.id,i.incident_no,i.line_id,i.source,i.violation_type,i.status,i.recovery_state,i.started_at,i.confirmed_at,i.resolved_at,i.closed_at,i.duration_minutes,i.assignee,i.recurrence_of,i.opening_snapshot_json,l.organization_id,l.provider_id,o.school_id,o.name,o.district,p.name FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE i.id=$1`, id))
}

func (s *Server) incidentEvent(w http.ResponseWriter, r *http.Request, item incidentRecord, p *auth.Principal) {
	var payload struct {
		EventType string `json:"event_type"`
		Note      string `json:"note"`
		Status    string `json:"status"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid event payload")
		return
	}
	if payload.EventType != "provider_fixed" && payload.EventType != "send_to_provider" && payload.EventType != "assign" && payload.EventType != "status" && payload.EventType != "comment" {
		writeError(w, 422, "unsupported incident event")
		return
	}
	if !requireRole(w, p, payload.EventType) {
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	switch payload.EventType {
	case "provider_fixed":
		if item.Status == "CLOSED" {
			writeError(w, http.StatusConflict, "closed incident cannot be marked resolved")
			return
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET status='RESOLVED',recovery_state='OBSERVED',resolved_at=$1 WHERE id=$2`, now, item.ID); err != nil {
			writeError(w, 500, "could not update incident")
			return
		}
	case "assign":
		if strings.TrimSpace(payload.Note) == "" {
			writeError(w, http.StatusUnprocessableEntity, "note must contain assignee")
			return
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET assignee=$1 WHERE id=$2`, payload.Note, item.ID); err != nil {
			writeError(w, 500, "could not update incident")
			return
		}
	case "send_to_provider":
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET status='SENT_TO_PROVIDER' WHERE id=$1`, item.ID); err != nil {
			writeError(w, 500, "could not update incident")
			return
		}
	case "status":
		if payload.Status != "NEW" && payload.Status != "SENT_TO_PROVIDER" && payload.Status != "IN_PROGRESS" && payload.Status != "WAITING_INFO" && payload.Status != "RESOLVED" && payload.Status != "CLOSED" {
			writeError(w, 422, "unsupported incident status")
			return
		}
		if payload.Status == "CLOSED" {
			writeError(w, 409, "incident requires confirmed recovery before close")
			return
		}
		if payload.Status != "" {
			if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET status=$1 WHERE id=$2`, payload.Status, item.ID); err != nil {
				writeError(w, 500, "could not update incident")
				return
			}
		}
	}
	eventType := map[string]string{"provider_fixed": "PROVIDER_REPORTED_FIXED", "send_to_provider": "SENT_TO_PROVIDER", "assign": "ASSIGNED", "status": "STATUS_CHANGED", "comment": "COMMENT"}[payload.EventType]
	data, err := json.Marshal(map[string]interface{}{"note": payload.Note, "status": payload.Status})
	if err != nil {
		writeError(w, 500, "could not encode incident event")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,$2,$3,$4::jsonb,$5)`, item.ID, eventType, p.ID, string(data), now); err != nil {
		writeError(w, 500, "could not record incident event")
		return
	}
	writeAudit(r.Context(), s, p, "incident."+strings.ToLower(eventType), "incident", fmt.Sprint(item.ID), nil, map[string]interface{}{"note": payload.Note, "status": payload.Status})
	fresh, visible := s.loadIncident(r.Context(), item.ID, p)
	if !visible {
		writeError(w, 404, "incident not found")
		return
	}
	mapped, mapErr := s.incidentMap(r.Context(), fresh)
	if mapErr != nil {
		writeError(w, 500, "could not read incident details")
		return
	}
	writeJSON(w, 200, mapped)
}

func (s *Server) providerDraft(w http.ResponseWriter, r *http.Request, item incidentRecord, p *auth.Principal) {
	var payload struct {
		Comment string `json:"comment"`
	}
	if r.Body != nil {
		if err := decodeJSON(r, &payload); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid provider draft payload")
			return
		}
	}
	opening := decodeJSONBytes(item.Opening)
	evidenceIDs := incidentEvidenceIDs(opening)
	evidenceJSON := "[]"
	if len(evidenceIDs) > 0 {
		encoded, err := json.Marshal(evidenceIDs)
		if err != nil {
			writeError(w, 500, "could not encode provider evidence")
			return
		}
		evidenceJSON = string(encoded)
	}
	observations := []map[string]interface{}{}
	if len(evidenceIDs) > 0 {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,observed_at,download,upload,ping,jitter,packet_loss,availability FROM measurements WHERE id = ANY($1) ORDER BY observed_at`, evidenceIDs)
		if err != nil {
			writeError(w, 500, "could not query provider evidence")
			return
		}
		for rows.Next() {
			var id int64
			var at time.Time
			var download, upload, ping, jitter, loss, availability *float64
			if err := rows.Scan(&id, &at, &download, &upload, &ping, &jitter, &loss, &availability); err != nil {
				rows.Close()
				writeError(w, 500, "could not read provider evidence")
				return
			}
			observations = append(observations, map[string]interface{}{"id": id, "observed_at": at, "download": download, "upload": upload, "ping": ping, "jitter": jitter, "packet_loss": loss, "availability": availability})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			writeError(w, 500, "could not read provider evidence")
			return
		}
		rows.Close()
	}
	observationsJSON, err := json.Marshal(observations)
	if err != nil {
		writeError(w, 500, "could not encode provider observations")
		return
	}
	policyJSON, err := json.Marshal(mapValue(opening, "policy"))
	if err != nil {
		writeError(w, 500, "could not encode provider policy")
		return
	}
	contractJSON, err := json.Marshal(mapValue(opening, "contract"))
	if err != nil {
		writeError(w, 500, "could not encode provider contract")
		return
	}
	draft := fmt.Sprintf("Здравствуйте! Просим проверить качество услуги на линии %s (школа %s, %s).\n\nСистема мониторинга подтвердила нарушение %s с %s.\n\nПрименённые пороги: %s.\nДоговорный ориентир и его срок действия на момент наблюдений: %s.\nНаблюдения: %s.\nПакет доказательств: measurement IDs %s; значения и effective policy/contract сохранены в системе без перезаписи истории.\n\nКомментарий заказчика: %s\n\nФормулировка описывает технически наблюдаемое отклонение и требует проверки оператором.", item.LineID, item.SchoolID, item.OrganizationName, item.ViolationType, item.StartedAt.UTC().Format(time.RFC3339), string(policyJSON), string(contractJSON), string(observationsJSON), evidenceJSON, payload.Comment)
	var id int64
	err = s.DB.Pool.QueryRow(r.Context(), `INSERT INTO provider_cases(incident_id,draft_text,status,delivery_status,created_by,created_at) VALUES ($1,$2,'DRAFT','PENDING',$3,$4) RETURNING id`, item.ID, draft, p.ID, time.Now().UTC().Truncate(time.Second)).Scan(&id)
	if err != nil {
		writeError(w, 500, "could not create provider case")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'PROVIDER_DRAFT_CREATED',$2,$3::jsonb,$4)`, item.ID, p.ID, fmt.Sprintf(`{"provider_case_id":%d}`, id), time.Now().UTC().Truncate(time.Second)); err != nil {
		writeError(w, 500, "could not record provider case event")
		return
	}
	writeAudit(r.Context(), s, p, "provider_case.draft", "provider_case", fmt.Sprint(id), nil, map[string]interface{}{"incident_id": item.ID})
	writeJSON(w, 201, map[string]interface{}{"id": id, "incident_id": item.ID, "draft_text": draft, "status": "DRAFT", "delivery_status": "PENDING"})
}

func incidentEvidenceIDs(opening interface{}) []int64 {
	snapshot, ok := opening.(map[string]interface{})
	if !ok {
		return nil
	}
	values, ok := snapshot["evidence_measurement_ids"].([]interface{})
	if !ok {
		return nil
	}
	result := make([]int64, 0, len(values))
	for _, value := range values {
		switch item := value.(type) {
		case float64:
			if item >= 0 && item == float64(int64(item)) {
				result = append(result, int64(item))
			}
		case json.Number:
			if parsed, err := item.Int64(); err == nil && parsed >= 0 {
				result = append(result, parsed)
			}
		}
	}
	return result
}

func mapValue(value interface{}, key string) interface{} {
	if object, ok := value.(map[string]interface{}); ok {
		if nested, exists := object[key]; exists {
			return nested
		}
	}
	return map[string]interface{}{}
}

func (s *Server) providerCases(ctx context.Context, incidentID int64) ([]map[string]interface{}, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT id,incident_id,ticket_no,draft_text,final_text,status,delivery_channel,delivery_status,delivery_attempts,delivery_error,delivery_retryable,next_attempt_at,delivery_started_at,external_ticket_no,created_by,sent_by,sent_at,created_at FROM provider_cases WHERE incident_id=$1 ORDER BY id`, incidentID)
	if err != nil {
		return nil, fmt.Errorf("query provider cases: %w", err)
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id, inc int64
		var ticket, draft, final, status, channel, delivery, errorText, external, createdBy, sentBy *string
		var attempts int
		var retryable bool
		var nextAttempt, deliveryStarted, sent, created *time.Time
		if err := rows.Scan(&id, &inc, &ticket, &draft, &final, &status, &channel, &delivery, &attempts, &errorText, &retryable, &nextAttempt, &deliveryStarted, &external, &createdBy, &sentBy, &sent, &created); err != nil {
			return nil, fmt.Errorf("scan provider case: %w", err)
		}
		result = append(result, map[string]interface{}{"id": id, "incident_id": inc, "ticket_no": ticket, "draft_text": draft, "final_text": final, "status": status, "delivery_channel": channel, "delivery_status": delivery, "delivery_attempts": attempts, "delivery_error": errorText, "delivery_retryable": retryable, "next_attempt_at": nextAttempt, "delivery_started_at": deliveryStarted, "external_ticket_no": external, "created_by": createdBy, "sent_by": sentBy, "sent_at": sent, "created_at": created})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate provider cases: %w", err)
	}
	return result, nil
}

func (s *Server) providerCaseRoute(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) < 2 {
		writeError(w, 404, "provider case not found")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, 404, "provider case not found")
		return
	}
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var lineID, orgID, district string
	var providerID *string
	var incidentID int64
	err = s.DB.Pool.QueryRow(r.Context(), `SELECT i.id,i.line_id,l.organization_id,o.district,l.provider_id FROM provider_cases c JOIN incidents i ON i.id=c.incident_id JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE c.id=$1`, id).Scan(&incidentID, &lineID, &orgID, &district, &providerID)
	if err != nil || !auth.HasLineScope(p, lineID, orgID, district, stringValue(providerID)) {
		writeError(w, 404, "provider case not found")
		return
	}
	if !requireRole(w, p, "provider_send") {
		return
	}
	if parts[1] != "send" && parts[1] != "retry" {
		writeError(w, 404, "not found")
		return
	}
	var payload struct {
		FinalText  *string `json:"final_text"`
		Text       *string `json:"text"`
		TicketNo   *string `json:"ticket_no"`
		IncidentID *int64  `json:"incident_id"`
		Reviewed   bool    `json:"reviewed"`
	}
	if err := decodeJSON(r, &payload); err != nil && r.Body != nil {
		writeError(w, 422, "invalid provider payload")
		return
	}
	var ticket, draft, existingFinal, currentStatus *string
	var attempts int
	var createdAt time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT ticket_no,draft_text,final_text,status,delivery_attempts,created_at FROM provider_cases WHERE id=$1`, id).Scan(&ticket, &draft, &existingFinal, &currentStatus, &attempts, &createdAt); err != nil {
		writeError(w, 404, "provider case not found")
		return
	}
	if currentStatus != nil && *currentStatus == "SENT" {
		cases, casesErr := s.providerCases(r.Context(), incidentID)
		if casesErr != nil {
			writeError(w, 500, "could not read provider cases")
			return
		}
		for _, item := range cases {
			if fmt.Sprint(item["id"]) == strconv.FormatInt(id, 10) {
				writeJSON(w, 200, item)
				return
			}
		}
	}
	if !payload.Reviewed {
		writeError(w, 409, "human review is required before sending")
		return
	}
	final := payload.FinalText
	if final == nil {
		final = payload.Text
	}
	if final == nil {
		final = existingFinal
	}
	if final == nil {
		final = draft
	}
	if final == nil || strings.TrimSpace(*final) == "" {
		writeError(w, 422, "final_text is required")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err = s.DB.Pool.Exec(r.Context(), `UPDATE provider_cases SET final_text=$1,ticket_no=COALESCE($2::text,ticket_no),delivery_status='DELIVERING',delivery_attempts=delivery_attempts+1,delivery_error=NULL,delivery_retryable=TRUE,next_attempt_at=NULL,delivery_started_at=$4 WHERE id=$3`, *final, payload.TicketNo, id, now); err != nil {
		s.Logger.Error("could not record provider case attempt", "case_id", id, "error", err)
		writeError(w, 500, "could not record provider attempt")
		return
	}
	attempt := attempts + 1
	incident, visible := s.loadIncident(r.Context(), incidentID, p)
	if !visible {
		writeError(w, 404, "provider case not found")
		return
	}
	var providerName, providerContact string
	if providerID != nil {
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT COALESCE(name,''),COALESCE(support_contact,'') FROM providers WHERE id=$1`, *providerID).Scan(&providerName, &providerContact); err != nil {
			writeError(w, 500, "could not read provider")
			return
		}
	}
	opening := decodeJSONBytes(incident.Opening)
	provider := &providers.Provider{Name: providerName, Contact: providerContact}
	if providerID != nil {
		provider.ID = *providerID
	}
	delivery, deliveryErr := providers.SendProviderCase(r.Context(), providers.ProviderCase{ID: id, TicketNo: firstString(payload.TicketNo, ticket), FinalText: *final, DraftText: firstString(draft, nil), CreatedAt: createdAt}, providers.Incident{ID: incident.ID, Number: incident.Number, LineID: incident.LineID, ViolationType: incident.ViolationType, StartedAt: incident.StartedAt, Opening: opening}, provider)
	if deliveryErr != nil {
		retryable := false
		if typed, ok := deliveryErr.(*providers.DeliveryError); ok {
			retryable = typed.Retryable
		}
		var nextAttempt interface{}
		if retryable {
			exponent := attempts
			if exponent > 5 {
				exponent = 5
			}
			nextAttempt = now.Add(time.Duration(1<<uint(exponent)) * time.Minute)
		}
		if _, persistErr := s.DB.Pool.Exec(r.Context(), `UPDATE provider_cases SET status='FAILED',delivery_status='FAILED',delivery_error=$1,delivery_retryable=$2,next_attempt_at=$3,delivery_started_at=NULL WHERE id=$4`, deliveryErr.Error(), retryable, nextAttempt, id); persistErr != nil {
			s.Logger.Error("could not persist provider case failure", "case_id", id, "error", persistErr)
			writeError(w, 500, "could not persist provider delivery failure")
			return
		}
		if _, eventErr := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'PROVIDER_CASE_DELIVERY_FAILED',$2,$3::jsonb,$4)`, incidentID, p.ID, fmt.Sprintf(`{"provider_case_id":%d,"error":%q,"retryable":%t}`, id, deliveryErr.Error(), retryable), now); eventErr != nil {
			s.Logger.Error("could not record provider case delivery failure event", "case_id", id, "error", eventErr)
		}
		writeAudit(r.Context(), s, p, "provider_case.delivery_failed", "provider_case", fmt.Sprint(id), nil, map[string]interface{}{"status": "FAILED", "attempts": attempt, "retryable": retryable, "error": deliveryErr.Error()})
		writeError(w, http.StatusBadGateway, "provider delivery failed; delivery state was persisted")
		return
	}
	if delivery.Channel == "" {
		delivery.Channel = "INTERNAL"
	}
	ticketNo := firstString(payload.TicketNo, ticket)
	if ticketNo == "" {
		ticketNo = delivery.ExternalID
	}
	if ticketNo == "" {
		ticketNo = fmt.Sprintf("PROVIDER-%06d", id)
	}
	_, err = s.DB.Pool.Exec(r.Context(), `UPDATE provider_cases SET ticket_no=$1,external_ticket_no=NULLIF($2,''),status='SENT',delivery_channel=$3,delivery_status='SENT',delivery_error=NULL,delivery_retryable=FALSE,next_attempt_at=NULL,delivery_started_at=NULL,sent_by=$4,sent_at=$5 WHERE id=$6`, ticketNo, delivery.ExternalID, delivery.Channel, p.ID, now, id)
	if err != nil {
		writeError(w, 500, "could not send provider case")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE incidents SET status=CASE WHEN status='NEW' THEN 'SENT_TO_PROVIDER' ELSE status END WHERE id=$1`, incidentID); err != nil {
		writeError(w, 500, "could not update incident")
		return
	}
	if _, eventErr := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'PROVIDER_CASE_SENT',$2,$3::jsonb,$4)`, incidentID, p.ID, fmt.Sprintf(`{"provider_case_id":%d,"ticket_no":%q,"channel":%q}`, id, ticketNo, delivery.Channel), now); eventErr != nil {
		s.Logger.Error("could not record provider case sent event", "case_id", id, "error", eventErr)
	}
	writeAudit(r.Context(), s, p, "provider_case.sent", "provider_case", fmt.Sprint(id), nil, map[string]interface{}{"ticket_no": ticketNo, "external_ticket_no": delivery.ExternalID, "delivery_channel": delivery.Channel, "status": "SENT", "reviewed": true})
	cases, casesErr := s.providerCases(r.Context(), incidentID)
	if casesErr != nil {
		writeError(w, 500, "could not read provider cases")
		return
	}
	for _, item := range cases {
		if fmt.Sprint(item["id"]) == strconv.FormatInt(id, 10) {
			writeJSON(w, 200, item)
			return
		}
	}
	writeError(w, 404, "provider case not found")
}

func firstString(value *string, fallback *string) string {
	if value != nil && strings.TrimSpace(*value) != "" {
		return *value
	}
	if fallback != nil {
		return *fallback
	}
	return ""
}
