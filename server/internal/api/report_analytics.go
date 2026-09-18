package api

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"net/http"
	"sort"
	"strconv"
)

const maxAnalyticsRows = 50000

type analyticsLine struct {
	LineID                                                                    string
	Measurements, Valid, BaselineKnown, BaselineOK, ContractKnown, ContractOK int
	Download, Availability                                                    float64
	DownloadCount, AvailabilityCount                                          int
}

func analyticsState(total, valid int) string {
	if total == 0 {
		return "NO_DATA"
	}
	if valid == 0 {
		return "UNKNOWN"
	}
	return "AVAILABLE"
}

func analyticsRate(ok, known int) *float64 {
	if known == 0 {
		return nil
	}
	v := float64(ok) / float64(known) * 100
	return &v
}

func analyticsRows(rows []reportRow, limit int) map[string]interface{} {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	byLine := map[string]*analyticsLine{}
	timeOfDay := make([]analyticsLine, 6)
	daily := map[string]*analyticsLine{}
	for i := range timeOfDay {
		timeOfDay[i] = analyticsLine{}
	}
	add := func(item *analyticsLine, row reportRow) {
		item.Measurements++
		if row.Valid {
			item.Valid++
		}
		if row.BaselineState == "OK" || row.BaselineState == "VIOLATION" {
			item.BaselineKnown++
		}
		if row.BaselineState == "OK" {
			item.BaselineOK++
		}
		if row.ContractState == "MEETS" || row.ContractState == "DEVIATES" {
			item.ContractKnown++
		}
		if row.ContractState == "MEETS" {
			item.ContractOK++
		}
		if row.Download != nil {
			item.Download += *row.Download
			item.DownloadCount++
		}
		if row.Availability != nil {
			item.Availability += *row.Availability
			item.AvailabilityCount++
		}
	}
	for _, row := range rows {
		line := byLine[row.LineID]
		if line == nil {
			line = &analyticsLine{LineID: row.LineID}
			byLine[row.LineID] = line
		}
		add(line, row)
		add(&timeOfDay[row.ObservedAt.UTC().Hour()/4], row)
		key := row.ObservedAt.UTC().Format("2006-01-02")
		day := daily[key]
		if day == nil {
			day = &analyticsLine{}
			daily[key] = day
		}
		add(day, row)
	}
	type pair struct {
		key   string
		value *analyticsLine
	}
	lines := make([]pair, 0, len(byLine))
	for key, value := range byLine {
		lines = append(lines, pair{key, value})
	}
	sort.Slice(lines, func(i, j int) bool {
		left, right := lines[i].value, lines[j].value
		if left.Valid != right.Valid {
			return left.Valid > right.Valid
		}
		return lines[i].key < lines[j].key
	})
	if len(lines) > limit {
		lines = lines[:limit]
	}
	mapLine := func(item *analyticsLine, key string) map[string]interface{} {
		var avgDownload, avgAvailability *float64
		if item.DownloadCount > 0 {
			value := item.Download / float64(item.DownloadCount)
			avgDownload = &value
		}
		if item.AvailabilityCount > 0 {
			value := item.Availability / float64(item.AvailabilityCount)
			avgAvailability = &value
		}
		return map[string]interface{}{"key": key, "line_id": item.LineID, "measurements": item.Measurements, "valid_evidence": item.Valid, "state": analyticsState(item.Measurements, item.Valid), "baseline_compliance": analyticsRate(item.BaselineOK, item.BaselineKnown), "contract_compliance": analyticsRate(item.ContractOK, item.ContractKnown), "average_download": avgDownload, "average_availability": avgAvailability}
	}
	ranking := make([]map[string]interface{}, 0, len(lines))
	for _, item := range lines {
		ranking = append(ranking, mapLine(item.value, item.key))
	}
	timeBuckets := make([]map[string]interface{}, 0, len(timeOfDay))
	for index := range timeOfDay {
		bucket := timeOfDay[index]
		bucket.LineID = ""
		timeBuckets = append(timeBuckets, mapLine(&bucket, fmt.Sprintf("%02d:00-%02d:00 UTC", index*4, ((index+1)*4)%24)))
	}
	days := make([]string, 0, len(daily))
	for key := range daily {
		days = append(days, key)
	}
	sort.Strings(days)
	trend := make([]map[string]interface{}, 0, len(days))
	for _, key := range days {
		trend = append(trend, mapLine(daily[key], key))
	}
	return map[string]interface{}{"status": analyticsState(len(rows), countValid(rows)), "historical_only": true, "current_state_used": false, "row_limit": maxAnalyticsRows, "ranking": ranking, "time_of_day": timeBuckets, "trend": trend}
}

func countValid(rows []reportRow) int {
	count := 0
	for _, row := range rows {
		if row.Valid {
			count++
		}
	}
	return count
}

func (s *Server) reportAnalytics(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	start, end, err := periodBounds(map[string]string{"from": r.URL.Query().Get("from"), "to": r.URL.Query().Get("to"), "period": r.URL.Query().Get("period")}, 30)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	rows, err := s.reportRows(r, p, start, end)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query analytics")
		return
	}
	if len(rows) > maxAnalyticsRows {
		writeError(w, http.StatusRequestEntityTooLarge, "analytics period exceeds maximum observations; narrow the period or filters")
		return
	}
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil {
			limit = parsed
		}
	}
	result := analyticsRows(rows, limit)
	result["from"], result["to"] = start, end
	if r.URL.Query().Get("format") == "csv" {
		var output bytes.Buffer
		writer := csv.NewWriter(&output)
		_ = writer.Write([]string{"rank", "line_id", "state", "measurements", "valid_evidence", "baseline_compliance", "contract_compliance", "average_download", "average_availability"})
		for index, item := range result["ranking"].([]map[string]interface{}) {
			_ = writer.Write([]string{strconv.Itoa(index + 1), fmt.Sprint(item["line_id"]), fmt.Sprint(item["state"]), fmt.Sprint(item["measurements"]), fmt.Sprint(item["valid_evidence"]), fmt.Sprint(item["baseline_compliance"]), fmt.Sprint(item["contract_compliance"]), fmt.Sprint(item["average_download"]), fmt.Sprint(item["average_availability"])})
		}
		writer.Flush()
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="linkwatch-analytics.csv"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(output.Bytes())
		return
	}
	writeJSON(w, http.StatusOK, result)
}
