package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

const providerWorkspaceLimit = 100

func (s *Server) listProviderCases(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok || !requireRole(w, p, "provider_send") {
		return
	}
	where, params := scopeSQL(p, 1)
	filters := []string{where}
	add := func(key, column string) {
		if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
			params = append(params, value)
			filters = append(filters, column+"=$"+itoa(len(params)))
		}
	}
	add("status", "c.status")
	add("delivery_status", "c.delivery_status")
	add("provider_id", "l.provider_id")
	limit := providerWorkspaceLimit
	if value := r.URL.Query().Get("limit"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 && parsed <= providerWorkspaceLimit {
			limit = parsed
		}
	}
	params = append(params, limit)
	query := `SELECT c.id,c.incident_id,COALESCE(c.line_id,''),c.source_context,COALESCE(c.ticket_no,''),c.status,c.delivery_status,c.delivery_attempts,COALESCE(c.delivery_error,''),c.delivery_retryable,c.next_attempt_at,c.created_at,COALESCE(i.incident_no,''),o.school_id,o.name,COALESCE(p.name,''),COALESCE(l.provider_id,'') FROM provider_cases c LEFT JOIN incidents i ON i.id=c.incident_id JOIN lines l ON l.id=COALESCE(c.line_id,i.line_id) JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY CASE WHEN c.delivery_status IN ('FAILED','DELIVERING') THEN 0 ELSE 1 END,c.created_at DESC,c.id DESC LIMIT $` + itoa(len(params))
	rows, err := s.DB.Pool.Query(r.Context(), query, params...)
	if err != nil {
		writeError(w, 500, "could not query provider workspace")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id int64
		var incidentID *int64
		var lineID, source, ticket, status, delivery, errorText, incidentNo, schoolID, orgName, providerName, providerID string
		var attempts int
		var retryable bool
		var next, created *time.Time
		if err := rows.Scan(&id, &incidentID, &lineID, &source, &ticket, &status, &delivery, &attempts, &errorText, &retryable, &next, &created, &incidentNo, &schoolID, &orgName, &providerName, &providerID); err != nil {
			writeError(w, 500, "could not read provider workspace")
			return
		}
		incidentValue := int64(0)
		if incidentID != nil {
			incidentValue = *incidentID
		}
		result = append(result, providerCaseSummary(id, incidentValue, lineID, source, ticket, status, delivery, attempts, errorText, retryable, next, created, incidentNo, schoolID, orgName, providerName, providerID))
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read provider workspace")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"items": result, "count": len(result), "limit": limit, "scope_enforced": true, "human_send_gate": true})
}

func providerCaseSummary(id, incidentID int64, lineID, source, ticket, status, delivery string, attempts int, errorText string, retryable bool, next, created *time.Time, incidentNo, schoolID, organizationName, providerName, providerID string) map[string]interface{} {
	// Delivery errors are operational summaries; never expose transport payloads or credentials.
	if len(errorText) > 240 {
		errorText = errorText[:240]
	}
	return map[string]interface{}{"id": id, "incident_id": incidentID, "incident_no": incidentNo, "line_id": lineID, "source_context": source, "ticket_no": ticket, "status": status, "delivery_status": delivery, "delivery_attempts": attempts, "delivery_error": errorText, "delivery_retryable": retryable, "next_attempt_at": next, "created_at": created, "school_id": schoolID, "organization_name": organizationName, "provider_id": providerID, "provider_name": providerName, "human_send_required": status != "SENT"}
}

func (s *Server) providerCaseWorkspaceDetail(w http.ResponseWriter, r *http.Request, id int64, p *auth.Principal) {
	var lineID, orgID, district string
	var providerID *string
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT l.id,l.organization_id,o.district,l.provider_id FROM provider_cases c LEFT JOIN incidents i ON i.id=c.incident_id JOIN lines l ON l.id=COALESCE(c.line_id,i.line_id) JOIN organizations o ON o.id=l.organization_id WHERE c.id=$1`, id).Scan(&lineID, &orgID, &district, &providerID); err != nil || !auth.HasLineScope(p, lineID, orgID, district, stringValue(providerID)) {
		writeError(w, 404, "provider case not found")
		return
	}
	item, err := s.providerCaseByID(r.Context(), id)
	if err != nil {
		writeError(w, 404, "provider case not found")
		return
	}
	if value, ok := item["delivery_error"].(*string); ok && value != nil && len(*value) > 240 {
		redacted := (*value)[:240]
		item["delivery_error"] = &redacted
	}
	item["scope_enforced"] = true
	item["human_send_gate"] = item["status"] != "SENT"
	item["timeline"] = []map[string]interface{}{}
	var incidentID *int64
	_ = s.DB.Pool.QueryRow(r.Context(), `SELECT incident_id FROM provider_cases WHERE id=$1`, id).Scan(&incidentID)
	if incidentID != nil {
		var incident incidentRecord
		incident, visible := s.loadIncident(r.Context(), *incidentID, p)
		if visible {
			if mapped, mapErr := s.incidentMap(r.Context(), incident); mapErr == nil {
				item["incident"] = mapped
				item["timeline"] = mapped["events"]
			}
		}
	}
	evidence := []map[string]interface{}{}
	var encoded []byte
	if evidenceErr := s.DB.Pool.QueryRow(r.Context(), `SELECT evidence_measurement_ids FROM provider_cases WHERE id=$1`, id).Scan(&encoded); evidenceErr == nil {
		var ids []int64
		if unmarshalErr := json.Unmarshal(encoded, &ids); unmarshalErr == nil {
			for _, measurementID := range ids {
				var record measurementRecord
				evidenceErr := s.DB.Pool.QueryRow(r.Context(), `SELECT m.id,m.device_id,m.line_id,m.monitoring_point_id,m.client_event_id,m.observed_at,m.received_at,m.mode,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,m.connection_status,m.raw_json,m.quality,e.baseline_state,e.contract_state,e.violations_json,e.valid,e.reason,e.policy_snapshot_json,e.contract_snapshot_json,e.line_context_snapshot_json,COALESCE(v.status,''),COALESCE(v.reason,''),v.candidate_snapshot_json,v.verifying_measurement_id,v.verifying_snapshot_json,v.verified_at FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id LEFT JOIN measurement_verifications v ON v.candidate_measurement_id=m.id WHERE m.id=$1 AND m.line_id=$2`, measurementID, lineID).Scan(&record.ID, &record.DeviceID, &record.LineID, &record.PointID, &record.ClientEventID, &record.ObservedAt, &record.ReceivedAt, &record.Mode, &record.Download, &record.Upload, &record.Ping, &record.Jitter, &record.PacketLoss, &record.Availability, &record.ConnectionStatus, &record.Raw, &record.Quality, &record.BaselineState, &record.ContractState, &record.Violations, &record.Valid, &record.Reason, &record.PolicySnapshot, &record.ContractSnapshot, &record.LineContextSnapshot, &record.VerificationStatus, &record.VerificationReason, &record.CandidateSnapshot, &record.VerifyingMeasurementID, &record.VerifyingSnapshot, &record.VerificationVerifiedAt)
				if evidenceErr == nil {
					evidence = append(evidence, evidenceChain(record))
				} else {
					s.Logger.Error("could not read provider case evidence measurement", "case_id", id, "measurement_id", measurementID, "line_id", lineID, "error", evidenceErr)
				}
			}
		} else {
			s.Logger.Error("could not decode provider case evidence ids", "case_id", id, "error", unmarshalErr)
		}
	} else {
		s.Logger.Error("could not read provider case evidence ids", "case_id", id, "error", evidenceErr)
	}
	item["evidence_chain"] = evidence
	writeProviderWorkspaceDetail(w, item)
}

func writeProviderWorkspaceDetail(w http.ResponseWriter, item map[string]interface{}) error {
	writeJSON(w, 200, item)
	return nil
}
