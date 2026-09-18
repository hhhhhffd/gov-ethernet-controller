package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

type reportRow struct {
	measurementRecord
	SchoolID, OrganizationName, District, ProviderID, ProviderName string
}

func periodBounds(q map[string]string, defaultDays int) (time.Time, time.Time, error) {
	now := time.Now().UTC().Truncate(time.Second)
	end := now
	if value := q["to"]; value != "" {
		parsed, e := parseTime(value, now)
		if e != nil {
			return time.Time{}, time.Time{}, e
		}
		end = parsed
	}
	start := end.Add(-time.Duration(defaultDays) * 24 * time.Hour)
	if value := q["from"]; value != "" {
		parsed, e := parseTime(value, now)
		if e != nil {
			return time.Time{}, time.Time{}, e
		}
		start = parsed
	}
	if value := strings.ToLower(q["period"]); value != "" && q["from"] == "" {
		days := map[string]int{"day": 1, "week": 7, "month": 30}[value]
		if days > 0 {
			start = end.Add(-time.Duration(days) * 24 * time.Hour)
		}
	}
	if !start.Before(end) {
		return time.Time{}, time.Time{}, fmt.Errorf("from must be earlier than to")
	}
	return start, end, nil
}

func (s *Server) reportRows(r *http.Request, p *auth.Principal, start, end time.Time) ([]reportRow, error) {
	where, params := scopeSQL(p, 3)
	filters := []string{"m.observed_at >= $1", "m.observed_at < $2", where}
	add := func(key, column string) {
		if value := r.URL.Query().Get(key); value != "" {
			params = append(params, value)
			filters = append(filters, column+"=$"+itoa(len(params)+2))
		}
	}
	add("line_id", "m.line_id")
	if value := r.URL.Query().Get("provider"); value != "" {
		base := len(params) + 3
		params = append(params, value, value)
		filters = append(filters, "(l.provider_id=$"+itoa(base)+" OR p.name=$"+itoa(base+1)+")")
	}
	add("district", "o.district")
	add("device_id", "m.device_id")
	if deviceIDs := reportDeviceIDs(r.URL.Query()); len(deviceIDs) > 0 {
		placeholders := make([]string, len(deviceIDs))
		for i, deviceID := range deviceIDs {
			params = append(params, deviceID)
			placeholders[i] = "$" + itoa(len(params)+2)
		}
		filters = append(filters, "m.device_id IN ("+strings.Join(placeholders, ",")+")")
	}
	add("role", "l.role")
	add("technology", "l.technology")
	add("organization_id", "l.organization_id")
	if value := r.URL.Query().Get("status"); value != "" {
		normalized := normalizeReportStatus(value)
		params = append(params, normalized)
		placeholder := itoa(len(params) + 2)
		if normalized == "ACTIVE" || normalized == "INACTIVE" || normalized == "DELETED" {
			filters = append(filters, "l.status=$"+placeholder)
		} else {
			filters = append(filters, "(CASE WHEN COALESCE(ls.data_state,'NO_DATA')='NO_DATA' THEN 'NO_DATA' ELSE COALESCE(ls.connection_state,'UNKNOWN') END)=$"+placeholder)
		}
	}
	query := `SELECT m.id,m.device_id,m.line_id,m.monitoring_point_id,m.client_event_id,m.observed_at,m.received_at,m.mode,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,m.connection_status,m.raw_json,m.quality,e.baseline_state,e.contract_state,e.violations_json,e.valid,e.reason,e.policy_snapshot_json,e.contract_snapshot_json,o.school_id,o.name,o.district,l.provider_id,p.name FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id JOIN lines l ON l.id=m.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id LEFT JOIN line_states ls ON ls.line_id=l.id WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY m.observed_at`
	args := append([]interface{}{start, end}, params...)
	rows, err := s.DB.Pool.Query(r.Context(), query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []reportRow{}
	for rows.Next() {
		var item reportRow
		var providerID, providerName *string
		if err := rows.Scan(&item.ID, &item.DeviceID, &item.LineID, &item.PointID, &item.ClientEventID, &item.ObservedAt, &item.ReceivedAt, &item.Mode, &item.Download, &item.Upload, &item.Ping, &item.Jitter, &item.PacketLoss, &item.Availability, &item.ConnectionStatus, &item.Raw, &item.Quality, &item.BaselineState, &item.ContractState, &item.Violations, &item.Valid, &item.Reason, &item.PolicySnapshot, &item.ContractSnapshot, &item.SchoolID, &item.OrganizationName, &item.District, &providerID, &providerName); err != nil {
			return nil, err
		}
		if providerID != nil {
			item.ProviderID = *providerID
		}
		if providerName != nil {
			item.ProviderName = *providerName
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// reportDeviceIDs accepts the repeated device_ids[] contract and the comma-separated
// device_ids variant used by some clients; the scalar device_id remains supported.
func reportDeviceIDs(query map[string][]string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, key := range []string{"device_ids[]", "device_ids"} {
		for _, value := range query[key] {
			for _, item := range strings.Split(value, ",") {
				item = strings.TrimSpace(item)
				if item != "" && !seen[item] {
					seen[item] = true
					result = append(result, item)
				}
			}
		}
	}
	return result
}

var rawExportFields = []string{"observed_at", "received_at", "line_id", "school_id", "organization_name", "district", "provider", "device_id", "mode", "connection_status", "download", "upload", "ping", "jitter", "packet_loss", "availability", "availability_status", "baseline_state", "contract_state", "reason"}

var aggregateExportFields = []string{"line_id", "measurement_count", "average_download", "min_download", "max_download", "average_upload", "average_ping", "average_availability", "availability_valid_count", "availability_invalid_count", "availability_unknown_count", "availability_known_count", "availability_observation_count", "availability_percent", "problem_measurement_count", "problem_measurement_percent"}

func selectedExportFields(query map[string][]string, kind string) ([]string, error) {
	allowed := rawExportFields
	if kind == "aggregate" {
		allowed = aggregateExportFields
	}
	requested := append([]string{}, query["fields[]"]...)
	requested = append(requested, query["fields"]...)
	if len(requested) == 0 {
		return append([]string{}, allowed...), nil
	}
	valid := map[string]bool{}
	for _, field := range allowed {
		valid[field] = true
	}
	result := []string{}
	seen := map[string]bool{}
	for _, field := range requested {
		field = strings.TrimSpace(field)
		if field == "" || !valid[field] {
			return nil, fmt.Errorf("unsupported export field %q", field)
		}
		if !seen[field] {
			seen[field] = true
			result = append(result, field)
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("fields must not be empty")
	}
	return result, nil
}

// reportProblemPercent uses observations, rather than non-null metric cells, as
// its denominator so partial measurements cannot make the rate look worse/better.
func reportProblemPercent(problem, measurements int) float64 {
	if measurements == 0 {
		return 0
	}
	return float64(problem) / float64(measurements) * 100
}

func (s *Server) aggregateReport(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	start, end, err := periodBounds(map[string]string{"from": r.URL.Query().Get("from"), "to": r.URL.Query().Get("to"), "period": r.URL.Query().Get("period")}, 1)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	rows, err := s.reportRows(r, p, start, end)
	if err != nil {
		writeError(w, 500, "could not query report")
		return
	}
	metrics := map[string][]float64{}
	for _, row := range rows {
		for name, value := range map[string]*float64{"download": row.Download, "upload": row.Upload, "ping": row.Ping, "jitter": row.Jitter, "packet_loss": row.PacketLoss, "availability": row.Availability} {
			if value != nil {
				metrics[name] = append(metrics[name], *value)
			}
		}
	}
	aggregate := map[string]interface{}{}
	for name, values := range metrics {
		sum, min, max := 0.0, values[0], values[0]
		for _, value := range values {
			sum += value
			if value < min {
				min = value
			}
			if value > max {
				max = value
			}
		}
		aggregate[name] = map[string]interface{}{"average": sum / float64(len(values)), "min": min, "max": max}
	}
	for _, name := range []string{"download", "upload", "ping", "jitter", "packet_loss", "availability"} {
		if _, exists := aggregate[name]; !exists {
			aggregate[name] = map[string]interface{}{"average": nil, "min": nil, "max": nil}
		}
	}
	problem := 0
	for _, row := range rows {
		if row.BaselineState == "VIOLATION" || row.ContractState == "DEVIATES" {
			problem++
		}
	}
	byLine := groupRows(rows, func(row reportRow) string { return row.LineID })
	byOrganization := groupRows(rows, func(row reportRow) string { return row.OrganizationName })
	byDistrict := groupRows(rows, func(row reportRow) string { return row.District })
	byProvider := groupRows(rows, func(row reportRow) string { return row.ProviderName })
	periodAvailability := availabilitySummaryForRows(rows)
	if availability, ok := aggregate["availability"].(map[string]interface{}); ok {
		availability["valid_count"] = periodAvailability.Valid
		availability["invalid_count"] = periodAvailability.Invalid
		availability["unknown_count"] = periodAvailability.Unknown
		availability["known_count"] = periodAvailability.known()
		availability["percent"] = periodAvailability.percent()
	}
	response := map[string]interface{}{"from": start, "to": end, "period_start": start, "period_end": end, "measurement_count": len(rows), "problem_measurement_count": problem, "aggregate": aggregate, "by_line": byLine, "by_organization": byOrganization, "by_school": byOrganization, "by_district": byDistrict, "by_provider": byProvider}
	for key, value := range availabilitySummaryFields(periodAvailability) {
		response[key] = value
	}
	writeJSON(w, 200, response)
}

func groupRows(rows []reportRow, key func(reportRow) string) map[string]interface{} {
	groups := map[string][]reportRow{}
	for _, row := range rows {
		name := key(row)
		if name == "" {
			name = "UNKNOWN"
		}
		groups[name] = append(groups[name], row)
	}
	result := map[string]interface{}{}
	for name, items := range groups {
		sum := func(field func(reportRow) *float64) *float64 {
			total, count := 0.0, 0
			for _, item := range items {
				if value := field(item); value != nil {
					total += *value
					count++
				}
			}
			if count == 0 {
				return nil
			}
			value := total / float64(count)
			return &value
		}
		bad := 0
		for _, item := range items {
			if item.BaselineState == "VIOLATION" || item.ContractState == "DEVIATES" {
				bad++
			}
		}
		lineIDs := map[string]struct{}{}
		for _, item := range items {
			lineIDs[item.LineID] = struct{}{}
		}
		group := map[string]interface{}{"measurement_count": len(items), "line_count": len(lineIDs), "average_download": sum(func(item reportRow) *float64 { return item.Download }), "average_upload": sum(func(item reportRow) *float64 { return item.Upload }), "average_ping": sum(func(item reportRow) *float64 { return item.Ping }), "average_availability": sum(func(item reportRow) *float64 { return item.Availability }), "problem_measurement_count": bad, "problem_measurement_share": reportProblemPercent(bad, len(items))}
		for key, value := range availabilitySummaryFields(availabilitySummaryForRows(items)) {
			group[key] = value
		}
		result[name] = group
	}
	return result
}

func (s *Server) passport(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	start, end, err := periodBounds(map[string]string{"from": r.URL.Query().Get("from"), "to": r.URL.Query().Get("to"), "period": r.URL.Query().Get("period")}, 30)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	rows, err := s.reportRows(r, p, start, end)
	if err != nil {
		writeError(w, 500, "could not query passport")
		return
	}
	lines, err := s.reportLineCount(r.Context(), r, p)
	if err != nil {
		writeError(w, 500, "could not count report lines")
		return
	}
	var tests int
	if s.DB.Pool.QueryRow(r.Context(), `SELECT tests_per_day FROM agent_schedules WHERE id=1`).Scan(&tests) != nil {
		tests = 4
	}
	expected := int((end.Sub(start).Hours()/24)*float64(tests*lines) + 0.5)
	baselineOK, baselineKnown, contractOK, contractKnown := 0, 0, 0, 0
	for _, row := range rows {
		if row.BaselineState == "OK" {
			baselineOK++
		}
		if row.BaselineState == "OK" || row.BaselineState == "VIOLATION" {
			baselineKnown++
		}
		if row.ContractState == "MEETS" {
			contractOK++
		}
		if row.ContractState == "MEETS" || row.ContractState == "DEVIATES" {
			contractKnown++
		}
	}
	incidentCount, duration, err := s.incidentStats(r, p, start, end)
	if err != nil {
		writeError(w, 500, "could not calculate incident statistics")
		return
	}
	complete := 0.0
	if expected > 0 {
		complete = float64(len(rows)) / float64(expected) * 100
		if complete > 100 {
			complete = 100
		}
	}
	periodAvailability := availabilitySummaryForRows(rows)
	threshold := commonAvailabilityThreshold(rows)
	availabilityPct := periodAvailability.percent()
	observedMinutes, unavailableMinutes, noDataMinutes := 0.0, 0.0, end.Sub(start).Minutes()
	if expected > 0 {
		slotMinutes := end.Sub(start).Minutes() / float64(expected)
		observedCount := len(rows)
		if observedCount > expected {
			observedCount = expected
		}
		observedMinutes = float64(observedCount) * slotMinutes
		unavailableMinutes = float64(periodAvailability.Invalid) * slotMinutes
		noDataMinutes = end.Sub(start).Minutes() - observedMinutes
		if noDataMinutes < 0 {
			noDataMinutes = 0
		}
	}
	response := map[string]interface{}{"from": start, "to": end, "period_start": start, "period_end": end, "line_id": r.URL.Query().Get("line_id"), "measurements_received": len(rows), "measurements_expected": expected, "data_completeness": complete, "data_completeness_pct": complete, "baseline_compliance": ratio(baselineOK, baselineKnown), "contract_compliance": ratio(contractOK, contractKnown), "incidents": map[string]interface{}{"count": incidentCount, "total_duration_minutes": duration}, "sufficient_data": expected > 0 && float64(len(rows)) >= float64(expected)*.8, "availability_pct": availabilityPct, "availability_threshold": threshold, "availability_status": periodStatus(periodAvailability, complete, threshold), "observed_duration_minutes": observedMinutes, "unavailable_duration_minutes": unavailableMinutes, "no_data_duration_minutes": noDataMinutes}
	for key, value := range availabilitySummaryFields(periodAvailability) {
		response[key] = value
	}
	writeJSON(w, 200, response)
}

func (s *Server) reportLineCount(ctx context.Context, r *http.Request, p *auth.Principal) (int, error) {
	ids, err := s.reportLineIDs(ctx, r, p, true)
	if err != nil {
		return 0, err
	}
	return len(ids), nil
}

func normalizeReportStatus(value string) string {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if normalized == "UNSTABLE" {
		return "DEGRADED"
	}
	if normalized == "CRITICAL" {
		return "NO_INTERNET"
	}
	return normalized
}

// reportLineIDs resolves the lines represented by report filters. Status
// filtering uses the materialized line state maintained by the freshness
// worker; report reads never mutate that state.
func (s *Server) reportLineIDs(ctx context.Context, r *http.Request, p *auth.Principal, withStatus bool) ([]string, error) {
	where, params := scopeSQL(p, 1)
	filters := []string{"l.status <> 'DELETED'", where}
	add := func(key, column string) {
		if value := r.URL.Query().Get(key); value != "" {
			params = append(params, value)
			filters = append(filters, column+"=$"+itoa(len(params)))
		}
	}
	add("line_id", "l.id")
	add("district", "o.district")
	if value := r.URL.Query().Get("provider"); value != "" {
		params = append(params, value, value)
		filters = append(filters, "(l.provider_id=$"+itoa(len(params)-1)+" OR p.name=$"+itoa(len(params))+")")
	}
	add("device_id", "d.id")
	add("organization_id", "l.organization_id")
	add("role", "l.role")
	add("technology", "l.technology")
	if withStatus {
		if value := r.URL.Query().Get("status"); value != "" {
			normalized := normalizeReportStatus(value)
			params = append(params, normalized)
			placeholder := itoa(len(params))
			if normalized == "ACTIVE" || normalized == "INACTIVE" || normalized == "DELETED" {
				filters = append(filters, "l.status=$"+placeholder)
			} else {
				filters = append(filters, "(CASE WHEN COALESCE(ls.data_state,'NO_DATA')='NO_DATA' THEN 'NO_DATA' ELSE COALESCE(ls.connection_state,'UNKNOWN') END)=$"+placeholder)
			}
		}
	}
	query := `SELECT DISTINCT l.id FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id LEFT JOIN line_states ls ON ls.line_id=l.id LEFT JOIN monitoring_points mp ON mp.line_id=l.id LEFT JOIN devices d ON d.monitoring_point_id=mp.id WHERE ` + strings.Join(filters, " AND ") + ` ORDER BY l.id`
	rows, err := s.DB.Pool.Query(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func ratio(ok, known int) *float64 {
	if known == 0 {
		return nil
	}
	value := float64(ok) / float64(known) * 100
	return &value
}

func (s *Server) incidentStats(r *http.Request, p *auth.Principal, start, end time.Time) (int, float64, error) {
	where, params := scopeSQL(p, 1)
	params = append(params, end, start)
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT i.started_at,i.closed_at FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE `+where+` AND i.started_at < $`+itoa(len(params)-1)+` AND (i.closed_at IS NULL OR i.closed_at >= $`+itoa(len(params)), params...)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	count := 0
	duration := 0.0
	for rows.Next() {
		var began time.Time
		var closed *time.Time
		if err := rows.Scan(&began, &closed); err != nil {
			return 0, 0, err
		}
		left := start
		if began.After(left) {
			left = began
		}
		right := end
		if closed != nil && closed.Before(right) {
			right = *closed
		}
		if right.After(left) {
			duration += right.Sub(left).Minutes()
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	return count, duration, nil
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	if r.Method == http.MethodPost && r.Body != nil {
		var payload struct {
			Kind           string   `json:"kind"`
			Type           string   `json:"type"`
			Format         string   `json:"format"`
			Period         string   `json:"period"`
			LineID         string   `json:"line_id"`
			District       string   `json:"district"`
			Provider       string   `json:"provider"`
			DeviceID       string   `json:"device_id"`
			Status         string   `json:"status"`
			Role           string   `json:"role"`
			Technology     string   `json:"technology"`
			OrganizationID string   `json:"organization_id"`
			DeviceIDs      []string `json:"device_ids"`
			Fields         []string `json:"fields"`
			From           string   `json:"from"`
			To             string   `json:"to"`
		}
		if err := decodeJSON(r, &payload); err != nil && err != io.EOF {
			writeError(w, 422, "invalid export payload")
			return
		}
		setIfMissing := func(key, value string) {
			if query.Get(key) == "" && value != "" {
				query.Set(key, value)
			}
		}
		if query.Get("kind") == "" || query.Get("kind") == "raw" {
			setIfMissing("kind", firstNonEmpty(payload.Kind, payload.Type))
		}
		setIfMissing("format", payload.Format)
		setIfMissing("period", payload.Period)
		setIfMissing("line_id", payload.LineID)
		setIfMissing("district", payload.District)
		setIfMissing("provider", payload.Provider)
		setIfMissing("device_id", payload.DeviceID)
		for _, deviceID := range payload.DeviceIDs {
			query.Add("device_ids[]", deviceID)
		}
		for _, field := range payload.Fields {
			query.Add("fields[]", field)
		}
		setIfMissing("status", payload.Status)
		setIfMissing("role", payload.Role)
		setIfMissing("technology", payload.Technology)
		setIfMissing("organization_id", payload.OrganizationID)
		setIfMissing("from", payload.From)
		setIfMissing("to", payload.To)
		r.URL.RawQuery = query.Encode()
	}
	start, end, err := periodBounds(map[string]string{"from": query.Get("from"), "to": query.Get("to"), "period": query.Get("period")}, 1)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	rows, err := s.reportRows(r, p, start, end)
	if err != nil {
		writeError(w, 500, "could not query export")
		return
	}
	kind := strings.ToLower(query.Get("kind"))
	if kind == "" {
		kind = "raw"
	}
	format := strings.ToLower(query.Get("format"))
	if format == "" {
		format = "csv"
	}
	if kind != "raw" && kind != "aggregate" {
		writeError(w, 422, "kind must be raw or aggregate")
		return
	}
	if format != "csv" && format != "xlsx" {
		writeError(w, 422, "format must be csv or xlsx")
		return
	}
	fields, err := selectedExportFields(query, kind)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	headers := append([]string{}, fields...)
	data := [][]interface{}{}
	if kind == "aggregate" {
		groups := map[string][]reportRow{}
		for _, row := range rows {
			groups[row.LineID] = append(groups[row.LineID], row)
		}
		for lineID, items := range groups {
			average := func(field func(reportRow) *float64) *float64 {
				var total float64
				count := 0
				for _, item := range items {
					if value := field(item); value != nil {
						total += *value
						count++
					}
				}
				if count == 0 {
					return nil
				}
				result := total / float64(count)
				return &result
			}
			min := func(field func(reportRow) *float64) *float64 {
				var result float64
				found := false
				for _, item := range items {
					if value := field(item); value != nil && (!found || *value < result) {
						result, found = *value, true
					}
				}
				if !found {
					return nil
				}
				return &result
			}
			max := func(field func(reportRow) *float64) *float64 {
				var result float64
				found := false
				for _, item := range items {
					if value := field(item); value != nil && (!found || *value > result) {
						result, found = *value, true
					}
				}
				if !found {
					return nil
				}
				return &result
			}
			bad := 0
			for _, item := range items {
				if item.BaselineState == "VIOLATION" || item.ContractState == "DEVIATES" {
					bad++
				}
			}
			problemPercent := reportProblemPercent(bad, len(items))
			values := map[string]interface{}{"line_id": lineID, "measurement_count": len(items), "average_download": average(func(item reportRow) *float64 { return item.Download }), "min_download": min(func(item reportRow) *float64 { return item.Download }), "max_download": max(func(item reportRow) *float64 { return item.Download }), "average_upload": average(func(item reportRow) *float64 { return item.Upload }), "average_ping": average(func(item reportRow) *float64 { return item.Ping }), "average_availability": average(func(item reportRow) *float64 { return item.Availability }), "problem_measurement_count": bad, "problem_measurement_percent": problemPercent}
			for key, value := range availabilitySummaryFields(availabilitySummaryForRows(items)) {
				values[key] = value
			}
			row := make([]interface{}, len(fields))
			for i, field := range fields {
				row[i] = values[field]
			}
			data = append(data, row)
		}
	} else {
		for _, row := range rows {
			values := map[string]interface{}{"observed_at": row.ObservedAt, "received_at": row.ReceivedAt, "line_id": row.LineID, "school_id": row.SchoolID, "organization_name": row.OrganizationName, "district": row.District, "provider": row.ProviderName, "device_id": row.DeviceID, "mode": row.Mode, "connection_status": row.ConnectionStatus, "download": row.Download, "upload": row.Upload, "ping": row.Ping, "jitter": row.Jitter, "packet_loss": row.PacketLoss, "availability": row.Availability, "availability_status": string(availabilityStatusForRow(row)), "baseline_state": row.BaselineState, "contract_state": row.ContractState, "reason": row.Reason}
			item := make([]interface{}, len(fields))
			for i, field := range fields {
				item[i] = values[field]
			}
			data = append(data, item)
		}
	}
	if format == "xlsx" {
		payload, err := xlsx(headers, data)
		if err != nil {
			writeError(w, 500, "could not build xlsx export")
			return
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", "attachment; filename=linkwatch-export.xlsx")
		if _, err := w.Write(payload); err != nil {
			s.Logger.Error("could not write xlsx export", "error", err)
		}
		return
	}
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	if err := writer.Write(headers); err != nil {
		writeError(w, 500, "could not build csv export")
		return
	}
	for _, row := range data {
		values := make([]string, len(row))
		for i, value := range row {
			if value == nil {
				values[i] = ""
			} else {
				values[i] = csvCell(value)
			}
		}
		if err := writer.Write(values); err != nil {
			writeError(w, 500, "could not build csv export")
			return
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		writeError(w, 500, "could not build csv export")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=linkwatch-export.csv")
	if _, err := w.Write(buffer.Bytes()); err != nil {
		s.Logger.Error("could not write csv export", "error", err)
	}
}

func xlsx(headers []string, rows [][]interface{}) ([]byte, error) {
	sheet := `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
	all := append([][]interface{}{make([]interface{}, len(headers))}, rows...)
	for i, h := range headers {
		all[0][i] = h
	}
	for rowIndex, row := range all {
		sheet += fmt.Sprintf(`<row r="%d">`, rowIndex+1)
		for colIndex, value := range row {
			ref := columnName(colIndex+1) + itoa(rowIndex+1)
			if numeric, ok := numericCell(value); ok {
				sheet += fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, ref, numeric)
				continue
			}
			text := ""
			if value != nil {
				text = htmlEscape(csvCell(value))
			}
			sheet += fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, text)
		}
		sheet += `</row>`
	}
	sheet += `</sheetData></worksheet>`
	var result bytes.Buffer
	archive := zip.NewWriter(&result)
	files := map[string]string{"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`, `_rels/.rels`: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, `xl/workbook.xml`: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="LINKWATCH" sheetId="1" r:id="rId1"/></sheets></workbook>`, `xl/_rels/workbook.xml.rels`: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`}
	for name, content := range files {
		file, err := archive.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := file.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	file, err := archive.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, err
	}
	if _, err := file.Write([]byte(sheet)); err != nil {
		return nil, err
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}

func csvCell(value interface{}) string {
	if value == nil {
		return ""
	}
	switch item := value.(type) {
	case *float64:
		if item == nil {
			return ""
		}
		return strconv.FormatFloat(*item, 'f', -1, 64)
	case time.Time:
		return item.UTC().Format(time.RFC3339)
	}
	text := fmt.Sprint(value)
	if _, ok := numericCell(value); ok {
		return text
	}
	if strings.HasPrefix(strings.TrimSpace(text), "=") || strings.HasPrefix(strings.TrimSpace(text), "+") || strings.HasPrefix(strings.TrimSpace(text), "-") || strings.HasPrefix(strings.TrimSpace(text), "@") {
		return "'" + text
	}
	return text
}

func numericCell(value interface{}) (string, bool) {
	switch item := value.(type) {
	case int:
		return strconv.Itoa(item), true
	case int64:
		return strconv.FormatInt(item, 10), true
	case float64:
		if math.IsNaN(item) || math.IsInf(item, 0) {
			return "", false
		}
		return strconv.FormatFloat(item, 'f', -1, 64), true
	case *float64:
		if item == nil || math.IsNaN(*item) || math.IsInf(*item, 0) {
			return "", false
		}
		return strconv.FormatFloat(*item, 'f', -1, 64), true
	default:
		return "", false
	}
}
func columnName(value int) string {
	result := ""
	for value > 0 {
		value--
		result = string(rune('A'+value%26)) + result
		value /= 26
	}
	return result
}
func htmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(value)
}
