package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

// providerCaseCreatePayload is deliberately shared by the incident and line
// roots. Exactly one root is accepted; all identity fields are checked against
// the server-side line/incident context when supplied by a client.
type providerCaseCreatePayload struct {
	IncidentID             *int64  `json:"incident_id"`
	LineID                 string  `json:"line_id"`
	PeriodFrom             string  `json:"period_from"`
	PeriodTo               string  `json:"period_to"`
	MeasurementIDs         []int64 `json:"measurement_ids"`
	SelectedMeasurementIDs []int64 `json:"selected_measurement_ids"`
	Comment                string  `json:"comment"`
	SchoolID               string  `json:"school_id"`
	OrganizationID         string  `json:"organization_id"`
	ProviderID             string  `json:"provider_id"`
}

func (p providerCaseCreatePayload) selectedIDs() []int64 {
	values := p.MeasurementIDs
	if len(values) == 0 {
		values = p.SelectedMeasurementIDs
	}
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func validateProviderCaseRoot(p providerCaseCreatePayload) (bool, string) {
	hasIncident := p.IncidentID != nil
	hasLine := strings.TrimSpace(p.LineID) != ""
	if hasIncident == hasLine {
		return false, "exactly one of incident_id or line_id is required"
	}
	if hasIncident && *p.IncidentID <= 0 {
		return false, "incident_id must be positive"
	}
	return true, ""
}

func parseProviderCasePeriod(p providerCaseCreatePayload) (*time.Time, *time.Time, error) {
	var from, to *time.Time
	if strings.TrimSpace(p.PeriodFrom) != "" {
		value, err := parseTime(strings.TrimSpace(p.PeriodFrom), time.Time{})
		if err != nil {
			return nil, nil, fmt.Errorf("invalid period_from")
		}
		from = &value
	}
	if strings.TrimSpace(p.PeriodTo) != "" {
		value, err := parseTime(strings.TrimSpace(p.PeriodTo), time.Time{})
		if err != nil {
			return nil, nil, fmt.Errorf("invalid period_to")
		}
		to = &value
	}
	if from != nil && to != nil && !to.After(*from) {
		return nil, nil, fmt.Errorf("period_to must be after period_from")
	}
	return from, to, nil
}

func validateProviderCaseOverrides(p providerCaseCreatePayload, line lineRecord) error {
	if p.SchoolID != "" && p.SchoolID != line.SchoolID {
		return fmt.Errorf("school_id does not match line context")
	}
	if p.OrganizationID != "" && p.OrganizationID != line.OrganizationID {
		return fmt.Errorf("organization_id does not match line context")
	}
	if p.ProviderID != "" && p.ProviderID != line.ProviderID {
		return fmt.Errorf("provider_id does not match line context")
	}
	return nil
}

func (s *Server) lineProviderDraftInput(ctx context.Context, line lineRecord, ids []int64, from, to *time.Time, comment string) (ProviderDraftInput, error) {
	return s.buildLineProviderDraftInput(ctx, line, ids, from, to, comment)
}

func (s *Server) createLineProviderCase(w http.ResponseWriter, r *http.Request, p *auth.Principal, payload providerCaseCreatePayload) {
	line, visible, err := s.lineVisible(r.Context(), p, strings.TrimSpace(payload.LineID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query line")
		return
	}
	if !visible {
		writeError(w, http.StatusNotFound, "line not found")
		return
	}
	if err := validateProviderCaseOverrides(payload, line); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	from, to, err := parseProviderCasePeriod(payload)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	ids := payload.selectedIDs()
	input, err := s.lineProviderDraftInput(r.Context(), line, ids, from, to, payload.Comment)
	if err != nil {
		if strings.Contains(err.Error(), "not permitted") || strings.Contains(err.Error(), "period") {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "could not build provider evidence")
		}
		return
	}
	draft := generateProviderDraft(r.Context(), deterministicDraftGenerator{}, input)
	if s.DraftGenerator != nil {
		if generated, generationErr := s.DraftGenerator.Generate(r.Context(), input); generationErr == nil {
			draft = generated
		}
	}
	var id int64
	now := time.Now().UTC().Truncate(time.Second)
	evidenceJSON := input.EvidenceJSON
	if evidenceJSON == "" {
		evidenceJSON = "[]"
	}
	err = s.DB.Pool.QueryRow(r.Context(), `INSERT INTO provider_cases(incident_id,line_id,source_context,period_from,period_to,evidence_measurement_ids,draft_text,status,delivery_status,created_by,created_at) VALUES (NULL,$1,'LINE',$2,$3,$4::jsonb,$5,'DRAFT','PENDING',$6,$7) RETURNING id`, line.ID, from, to, evidenceJSON, draft, p.ID, now).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create provider case")
		return
	}
	writeAudit(r.Context(), s, p, "provider_case.draft", "provider_case", fmt.Sprint(id), nil, map[string]interface{}{"source_context": "LINE", "line_id": line.ID, "evidence_measurement_ids": ids})
	writeJSON(w, http.StatusCreated, map[string]interface{}{"id": id, "incident_id": nil, "line_id": line.ID, "source_context": "LINE", "school_id": line.SchoolID, "organization_id": line.OrganizationID, "provider_id": line.ProviderID, "draft_text": draft, "status": "DRAFT", "delivery_status": "PENDING"})
}

// buildLineProviderDraftInput reads only canonical line measurements and the
// historical evaluation snapshots stored with each observation. It never
// reads or updates line_states.
func (s *Server) buildLineProviderDraftInput(ctx context.Context, line lineRecord, ids []int64, from, to *time.Time, comment string) (ProviderDraftInput, error) {
	where := []string{"m.line_id=$1"}
	args := []interface{}{line.ID}
	if len(ids) > 0 {
		where = append(where, fmt.Sprintf("m.id=ANY($%d)", len(args)+1))
		args = append(args, ids)
	}
	if from != nil {
		where = append(where, fmt.Sprintf("m.observed_at >= $%d", len(args)+1))
		args = append(args, *from)
	}
	if to != nil {
		where = append(where, fmt.Sprintf("m.observed_at < $%d", len(args)+1))
		args = append(args, *to)
	}
	query := `SELECT m.id,m.observed_at,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,e.policy_snapshot_json,e.contract_snapshot_json,e.line_context_snapshot_json FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id WHERE ` + strings.Join(where, " AND ") + ` ORDER BY m.observed_at,m.id`
	rows, err := s.DB.Pool.Query(ctx, query, args...)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	defer rows.Close()
	observations := []map[string]interface{}{}
	policies := []interface{}{}
	contracts := []interface{}{}
	policySeen, contractSeen := map[string]struct{}{}, map[string]struct{}{}
	found := map[int64]struct{}{}
	for rows.Next() {
		var id int64
		var at time.Time
		var download, upload, ping, jitter, loss, availability *float64
		var policy, contract, lineContext []byte
		if err := rows.Scan(&id, &at, &download, &upload, &ping, &jitter, &loss, &availability, &policy, &contract, &lineContext); err != nil {
			return ProviderDraftInput{}, err
		}
		found[id] = struct{}{}
		observations = append(observations, lineProviderObservation(id, at, download, upload, ping, jitter, loss, availability, policy, contract, lineContext))
		for _, snapshot := range []struct {
			value  []byte
			seen   map[string]struct{}
			target *[]interface{}
		}{{policy, policySeen, &policies}, {contract, contractSeen, &contracts}} {
			key := string(snapshot.value)
			if _, ok := snapshot.seen[key]; !ok {
				snapshot.seen[key] = struct{}{}
				(*snapshot.target) = append(*snapshot.target, decodeJSONBytes(snapshot.value))
			}
		}
	}
	if err := rows.Err(); err != nil {
		return ProviderDraftInput{}, err
	}
	for _, id := range ids {
		if _, ok := found[id]; !ok {
			return ProviderDraftInput{}, fmt.Errorf("selected measurement %d is not permitted for this line or period", id)
		}
	}
	evidenceIDs := append([]int64(nil), ids...)
	if len(evidenceIDs) == 0 {
		for id := range found {
			evidenceIDs = append(evidenceIDs, id)
		}
		sort.Slice(evidenceIDs, func(i, j int) bool { return evidenceIDs[i] < evidenceIDs[j] })
	}
	observationsJSON, err := json.Marshal(observations)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	policyJSON, err := json.Marshal(policies)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	contractJSON, err := json.Marshal(contracts)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	evidenceJSON, err := json.Marshal(evidenceIDs)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	started := time.Now().UTC()
	if from != nil {
		started = *from
	}
	return ProviderDraftInput{LineID: line.ID, SchoolID: line.SchoolID, Organization: line.OrganizationName, ViolationType: "LINE_REVIEW", StartedAt: started.Format(time.RFC3339), PolicyJSON: string(policyJSON), ContractJSON: string(contractJSON), ObservationsJSON: string(observationsJSON), EvidenceJSON: string(evidenceJSON), Comment: comment}, nil
}

func lineProviderObservation(id int64, at time.Time, download, upload, ping, jitter, loss, availability *float64, policy, contract, lineContext []byte) map[string]interface{} {
	return map[string]interface{}{"id": id, "observed_at": at.UTC().Format(time.RFC3339), "download": download, "upload": upload, "ping": ping, "jitter": jitter, "packet_loss": loss, "availability": availability, "policy_snapshot": decodeJSONBytes(policy), "contract_snapshot": decodeJSONBytes(contract), "line_context_snapshot": decodeJSONBytes(lineContext)}
}

func (s *Server) createProviderCase(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok || !requireRole(w, p, "provider_send") {
		return
	}
	var payload providerCaseCreatePayload
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid provider case payload")
		return
	}
	if valid, message := validateProviderCaseRoot(payload); !valid {
		writeError(w, http.StatusUnprocessableEntity, message)
		return
	}
	if strings.TrimSpace(payload.LineID) != "" {
		s.createLineProviderCase(w, r, p, payload)
		return
	}
	item, visible := s.loadIncident(r.Context(), *payload.IncidentID, p)
	if !visible {
		writeError(w, http.StatusNotFound, "incident not found")
		return
	}
	if payload.SchoolID != "" && payload.SchoolID != item.SchoolID {
		writeError(w, 422, "school_id does not match incident context")
		return
	}
	if payload.OrganizationID != "" && payload.OrganizationID != item.OrganizationID {
		writeError(w, 422, "organization_id does not match incident context")
		return
	}
	if payload.ProviderID != "" && payload.ProviderID != item.ProviderID {
		writeError(w, 422, "provider_id does not match incident context")
		return
	}
	input, err := s.providerDraftInput(r.Context(), item, payload.Comment)
	if err != nil {
		writeError(w, 500, "could not build provider evidence")
		return
	}
	draft := generateProviderDraft(r.Context(), deterministicDraftGenerator{}, input)
	if s.DraftGenerator != nil {
		if generated, generationErr := s.DraftGenerator.Generate(r.Context(), input); generationErr == nil {
			draft = generated
		}
	}
	evidenceJSON := input.EvidenceJSON
	if evidenceJSON == "" {
		evidenceJSON = "[]"
	}
	var id int64
	err = s.DB.Pool.QueryRow(r.Context(), `INSERT INTO provider_cases(incident_id,source_context,evidence_measurement_ids,draft_text,status,delivery_status,created_by,created_at) VALUES ($1,'INCIDENT',$2::jsonb,$3,'DRAFT','PENDING',$4,$5) RETURNING id`, item.ID, evidenceJSON, draft, p.ID, time.Now().UTC().Truncate(time.Second)).Scan(&id)
	if err != nil {
		writeError(w, 500, "could not create provider case")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'PROVIDER_DRAFT_CREATED',$2,$3::jsonb,$4)`, item.ID, p.ID, fmt.Sprintf(`{"provider_case_id":%d}`, id), time.Now().UTC().Truncate(time.Second)); err != nil {
		writeError(w, 500, "could not record provider case event")
		return
	}
	writeAudit(r.Context(), s, p, "provider_case.draft", "provider_case", fmt.Sprint(id), nil, map[string]interface{}{"incident_id": item.ID})
	writeJSON(w, 201, map[string]interface{}{"id": id, "incident_id": item.ID, "line_id": item.LineID, "source_context": "INCIDENT", "draft_text": draft, "status": "DRAFT", "delivery_status": "PENDING"})
}

func (s *Server) providerCaseByID(ctx context.Context, id int64) (map[string]interface{}, error) {
	var incidentID *int64
	var lineID *string
	var source, status string
	var ticket, draft, final, channel, delivery, errorText, external, createdBy, sentBy *string
	var attempts int
	var retryable bool
	var nextAttempt, deliveryStarted, sent, created *time.Time
	err := s.DB.Pool.QueryRow(ctx, `SELECT incident_id,line_id,source_context,ticket_no,draft_text,final_text,status,delivery_channel,delivery_status,delivery_attempts,delivery_error,delivery_retryable,next_attempt_at,delivery_started_at,external_ticket_no,created_by,sent_by,sent_at,created_at FROM provider_cases WHERE id=$1`, id).Scan(&incidentID, &lineID, &source, &ticket, &draft, &final, &status, &channel, &delivery, &attempts, &errorText, &retryable, &nextAttempt, &deliveryStarted, &external, &createdBy, &sentBy, &sent, &created)
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{"id": id, "incident_id": incidentID, "line_id": lineID, "source_context": source, "ticket_no": ticket, "draft_text": draft, "final_text": final, "status": status, "delivery_channel": channel, "delivery_status": delivery, "delivery_attempts": attempts, "delivery_error": errorText, "delivery_retryable": retryable, "next_attempt_at": nextAttempt, "delivery_started_at": deliveryStarted, "external_ticket_no": external, "created_by": createdBy, "sent_by": sentBy, "sent_at": sent, "created_at": created}
	return result, nil
}
