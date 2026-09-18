package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

type comparisonLine struct {
	LineID, SchoolID, OrganizationName, District, ProviderID, Role, Technology                              string
	MeasurementCount, ValidCount, LateCount, BaselineOK, BaselineViolation, ContractMeets, ContractDeviates int
	ObservedDownload, ObservedAvailability                                                                  *float64
}

func comparisonCompleteness(total, valid int) map[string]interface{} {
	if total == 0 {
		return map[string]interface{}{"status": "NO_DATA", "reason": "no stored observations in the selected historical period"}
	}
	if valid == 0 {
		return map[string]interface{}{"status": "UNKNOWN", "reason": "observations exist but none are valid evaluation evidence"}
	}
	return map[string]interface{}{"status": "AVAILABLE", "reason": "derived from stored measurement evaluations"}
}

func comparisonWindow(r *http.Request, center time.Time) (time.Time, time.Time, error) {
	window := 60
	if raw := strings.TrimSpace(r.URL.Query().Get("window_minutes")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 15 || parsed > 10080 {
			return time.Time{}, time.Time{}, fmt.Errorf("window_minutes must be between 15 and 10080")
		}
		window = parsed
	}
	from, to := center.Add(-time.Duration(window/2)*time.Minute), center.Add(time.Duration(window-window/2)*time.Minute)
	if raw := strings.TrimSpace(r.URL.Query().Get("from")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid from")
		}
		from = parsed.UTC()
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("to")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid to")
		}
		to = parsed.UTC()
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, fmt.Errorf("from must be earlier than to")
	}
	return from, to, nil
}

func (s *Server) situationComparison(w http.ResponseWriter, r *http.Request, situationID int64) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var item situationRecord
	if found, err := scanSituation(s.DB.Pool.QueryRow(r.Context(), `SELECT id,title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at FROM situations WHERE id=$1`, situationID)); err != nil {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	} else {
		item = found
	}
	memberIDs, err := s.situationMembers(r.Context(), situationID)
	if err != nil || len(memberIDs) == 0 {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	}
	treatmentIDs := []int64{}
	treatmentLines := map[string]bool{}
	for _, memberID := range memberIDs {
		incident, visible := s.loadIncident(r.Context(), memberID, p)
		if !visible {
			continue
		}
		treatmentIDs = append(treatmentIDs, memberID)
		treatmentLines[incident.LineID] = true
	}
	if len(treatmentIDs) == 0 {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	}
	from, to, err := comparisonWindow(r, item.StartAt)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	lineIDs := make([]string, 0, len(treatmentLines))
	for id := range treatmentLines {
		lineIDs = append(lineIDs, id)
	}
	criteria := map[string]interface{}{"same_provider": item.ProviderID != "", "same_district": item.District != "", "same_technology": false, "technology_reason": "technology is not a canonical Situation factor and is not guessed", "exclude_treatment_lines": true, "source": "canonical situation factors and stored evaluations", "causal_claim": false}
	controls, err := s.comparisonLines(r.Context(), p, from, to, lineIDs, item.ProviderID, item.District, "")
	if err != nil {
		writeError(w, 500, "could not calculate comparison")
		return
	}
	treatment, err := s.comparisonLines(r.Context(), p, from, to, lineIDs, item.ProviderID, item.District, "treatment")
	if err != nil {
		writeError(w, 500, "could not calculate treatment comparison")
		return
	}
	result := map[string]interface{}{"situation_id": situationID, "title": item.Title, "status": item.Status, "causal_claim": false, "correlation_only": true, "historical_only": true, "current_state_used": false, "period": map[string]interface{}{"from": from, "to": to, "basis": "observed_at; backfilled observations remain historical evidence"}, "selection": criteria, "treatment": comparisonRows(treatment), "controls": comparisonRows(controls), "control_count": len(controls), "explanation": "Контрольная группа подобрана по сохранённым факторам ситуации; сравнение описывает корреляцию и не устанавливает общую причину."}
	if len(controls) == 0 {
		result["control_completeness"] = map[string]interface{}{"status": "NO_DATA", "reason": "no eligible scoped lines matched the explicit criteria"}
	} else {
		result["control_completeness"] = map[string]interface{}{"status": "AVAILABLE", "reason": "eligible lines are shown with per-line evidence completeness"}
	}
	writeJSON(w, 200, result)
}

func (s *Server) comparisonLines(ctx context.Context, p *auth.Principal, from, to time.Time, treatment []string, provider, district, kind string) ([]comparisonLine, error) {
	where, scopeParams := scopeSQL(p, 4)
	filters := []string{"l.status <> 'DELETED'", where}
	args := []interface{}{from, to, treatment}
	args = append(args, scopeParams...)
	filters = append(filters, "l.id <> ALL($3::text[])")
	if kind == "treatment" {
		filters[len(filters)-1] = "l.id = ANY($3::text[])"
	}
	if provider != "" {
		args = append(args, provider)
		filters = append(filters, "l.provider_id=$"+itoa(len(args)))
	}
	if district != "" {
		args = append(args, district)
		filters = append(filters, "o.district=$"+itoa(len(args)))
	}
	query := `SELECT l.id,o.school_id,o.name,o.district,COALESCE(l.provider_id,''),l.role,l.technology,count(m.id),count(m.id) FILTER (WHERE e.valid),count(m.id) FILTER (WHERE m.received_at > m.observed_at),count(m.id) FILTER (WHERE e.baseline_state='OK'),count(m.id) FILTER (WHERE e.baseline_state='VIOLATION'),count(m.id) FILTER (WHERE e.contract_state='MEETS'),count(m.id) FILTER (WHERE e.contract_state='DEVIATES'),avg(m.download),avg(m.availability) FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id LEFT JOIN measurements m ON m.line_id=l.id AND m.observed_at >= $1 AND m.observed_at < $2 LEFT JOIN measurement_evaluations e ON e.measurement_id=m.id WHERE ` + strings.Join(filters, " AND ") + ` GROUP BY l.id,o.school_id,o.name,o.district,l.provider_id,l.role,l.technology ORDER BY l.id`
	rows, err := s.DB.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []comparisonLine{}
	for rows.Next() {
		var line comparisonLine
		if err := rows.Scan(&line.LineID, &line.SchoolID, &line.OrganizationName, &line.District, &line.ProviderID, &line.Role, &line.Technology, &line.MeasurementCount, &line.ValidCount, &line.LateCount, &line.BaselineOK, &line.BaselineViolation, &line.ContractMeets, &line.ContractDeviates, &line.ObservedDownload, &line.ObservedAvailability); err != nil {
			return nil, err
		}
		result = append(result, line)
	}
	return result, rows.Err()
}

func comparisonRows(lines []comparisonLine) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(lines))
	for _, line := range lines {
		result = append(result, map[string]interface{}{"line_id": line.LineID, "school_id": line.SchoolID, "organization_name": line.OrganizationName, "district": line.District, "provider_id": line.ProviderID, "role": line.Role, "technology": line.Technology, "measurement_count": line.MeasurementCount, "valid_evidence_count": line.ValidCount, "late_observation_count": line.LateCount, "baseline": map[string]interface{}{"ok": line.BaselineOK, "violation": line.BaselineViolation}, "contract": map[string]interface{}{"meets": line.ContractMeets, "deviates": line.ContractDeviates}, "average_download": line.ObservedDownload, "average_availability": line.ObservedAvailability, "completeness": comparisonCompleteness(line.MeasurementCount, line.ValidCount), "late_data_note": "historical observed_at window; current line state is not recalculated"})
	}
	return result
}
