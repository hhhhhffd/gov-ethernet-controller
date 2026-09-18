package api

import (
	"fmt"
	"strings"
	"time"
)

// evidenceChain is a read projection over immutable evaluation/opening
// snapshots. It intentionally never resolves policy or context from current
// tables: historical surfaces must remain stable after configuration changes.
func evidenceChain(item measurementRecord) map[string]interface{} {
	return evidenceChainFromSnapshots(item.ID, item.ObservedAt, item.BaselineState, item.ContractState,
		decodeJSONBytes(item.Violations), item.Valid, item.Reason,
		decodeJSONBytes(item.PolicySnapshot), decodeJSONBytes(item.ContractSnapshot),
		decodeJSONBytes(item.LineContextSnapshot), item.VerificationStatus, nil)
}

func evidenceChainFromSnapshots(id int64, observedAt time.Time, baseline, contract string, violations interface{}, valid bool, reason string, policy, contractSnapshot, contextSnapshot interface{}, verification string, extra map[string]interface{}) map[string]interface{} {
	policyMap := snapshotMap(policy)
	contractMap := snapshotMap(contractSnapshot)
	contextMap := snapshotMap(contextSnapshot)
	ids := []int64{}
	if id > 0 {
		ids = append(ids, id)
	}
	status := "AVAILABLE"
	unknownReason := ""
	if len(ids) == 0 {
		status = "NO_DATA"
		unknownReason = "no stored observation evidence"
	} else if !valid && baseline == "" && contract == "" {
		status = "UNKNOWN"
		unknownReason = evidenceFirstNonEmpty(reason, "stored evaluation is not complete")
	}
	if len(contextMap) == 0 {
		unknownReason = joinReason(unknownReason, "historical line context snapshot unavailable")
	}
	confirmation := map[string]interface{}{
		"method":           confirmationMethod(policyMap),
		"count":            len(ids),
		"duration_minutes": 0,
		"observation_ids":  ids,
	}
	verificationMap := map[string]interface{}{"status": evidenceFirstNonEmpty(verification, "UNKNOWN")}
	if id > 0 {
		verificationMap["candidate_measurement_id"] = id
	}
	result := map[string]interface{}{
		"status":            status,
		"baseline":          axisSnapshot(baseline, policyMap, violations),
		"contract":          axisSnapshot(contract, contractMap, violations),
		"policy":            compactSnapshot(policyMap),
		"contract_snapshot": compactSnapshot(contractMap),
		"line_context":      compactSnapshot(contextMap),
		"confirmation":      confirmation,
		"verification":      verificationMap,
		"completeness":      map[string]interface{}{"status": status, "unknown_reason": unknownReason},
		"historical_only":   true,
	}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func snapshotMap(value interface{}) map[string]interface{} {
	if result, ok := value.(map[string]interface{}); ok && result != nil {
		return result
	}
	return map[string]interface{}{}
}

func compactSnapshot(value map[string]interface{}) map[string]interface{} {
	if len(value) == 0 {
		return map[string]interface{}{}
	}
	result := map[string]interface{}{}
	for _, key := range []string{"id", "version", "line_id", "scope_type", "scope_id", "valid_from", "valid_to", "contract_no", "reason", "changed_by", "confirm_count", "confirm_minutes", "confirm_duration_minutes", "recovery_count", "recovery_minutes"} {
		if item, ok := value[key]; ok {
			result[key] = item
		}
	}
	return result
}

func axisSnapshot(state string, snapshot map[string]interface{}, violations interface{}) map[string]interface{} {
	return map[string]interface{}{"state": firstNonEmpty(state, "UNKNOWN"), "thresholds": thresholdSnapshot(snapshot), "violations": violationsOrEmpty(violations)}
}

func thresholdSnapshot(snapshot map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{}
	for _, key := range []string{"download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min"} {
		if value, ok := snapshot[key]; ok {
			result[key] = value
		}
	}
	return result
}

func violationsOrEmpty(value interface{}) interface{} {
	if value == nil {
		return []interface{}{}
	}
	return value
}

func confirmationMethod(policy map[string]interface{}) string {
	if number(policy["confirm_duration_minutes"]) > 0 {
		return "DURATION"
	}
	if number(policy["confirm_count"]) > 1 {
		return "COUNT"
	}
	if len(policy) == 0 {
		return "UNKNOWN"
	}
	return "COUNT_OR_DURATION"
}

func number(value interface{}) float64 {
	switch item := value.(type) {
	case float64:
		return item
	case float32:
		return float64(item)
	case int:
		return float64(item)
	case int64:
		return float64(item)
	}
	return 0
}

func joinReason(left, right string) string {
	if left == "" {
		return right
	}
	if right == "" || strings.Contains(left, right) {
		return left
	}
	return fmt.Sprintf("%s; %s", left, right)
}

func evidenceFirstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func evidenceChainForRows(rows []reportRow) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		result = append(result, evidenceChain(row.measurementRecord))
	}
	return result
}

func evidenceChainForRecords(records []measurementRecord) map[string]interface{} {
	if len(records) == 0 {
		return evidenceChain(measurementRecord{})
	}
	chain := evidenceChain(records[0])
	confirmation, _ := chain["confirmation"].(map[string]interface{})
	ids := make([]int64, 0, len(records))
	first, last := records[0].ObservedAt, records[0].ObservedAt
	for _, record := range records {
		ids = append(ids, record.ID)
		if record.ObservedAt.Before(first) {
			first = record.ObservedAt
		}
		if record.ObservedAt.After(last) {
			last = record.ObservedAt
		}
	}
	confirmation["count"] = len(ids)
	confirmation["observation_ids"] = ids
	if len(ids) > 1 {
		confirmation["method"] = "COUNT"
		if last.After(first) {
			confirmation["duration_minutes"] = last.Sub(first).Minutes()
		}
	}
	return chain
}

func evidenceChainFromOpening(opening interface{}, startedAt time.Time) map[string]interface{} {
	snapshot := snapshotMap(opening)
	ids := incidentEvidenceIDs(opening)
	var first int64
	if len(ids) > 0 {
		first = ids[0]
	}
	chain := evidenceChainFromSnapshots(first, startedAt, evidenceStringValue(snapshot["baseline_state"]), evidenceStringValue(snapshot["contract_state"]), snapshot["violations"], true, evidenceStringValue(snapshot["reason"]), snapshot["policy"], snapshot["contract"], snapshot["line_context"], evidenceStringValue(snapshot["verification_status"]), map[string]interface{}{"observation_ids": ids})
	confirmation := chain["confirmation"].(map[string]interface{})
	confirmation["count"] = len(ids)
	confirmation["observation_ids"] = ids
	if len(ids) > 1 {
		confirmation["method"] = "COUNT"
	}
	return chain
}

func setEvidenceDuration(chain map[string]interface{}, start time.Time, end *time.Time) {
	if end == nil || !end.After(start) {
		return
	}
	if confirmation, ok := chain["confirmation"].(map[string]interface{}); ok {
		confirmation["duration_minutes"] = end.Sub(start).Minutes()
	}
}

func evidenceStringValue(value interface{}) string {
	if result, ok := value.(string); ok {
		return result
	}
	return ""
}
