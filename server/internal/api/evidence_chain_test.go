package api

import (
	"encoding/json"
	"testing"
	"time"
)

func snapshotBytes(t *testing.T, value interface{}) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestEvidenceChainUsesHistoricalAxesAndConfirmationPolicy(t *testing.T) {
	item := measurementRecord{ID: 42, ObservedAt: time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC), BaselineState: "VIOLATION", ContractState: "MEETS", Valid: true, PolicySnapshot: snapshotBytes(t, map[string]interface{}{"id": 7, "version": 3, "confirm_count": 1, "confirm_duration_minutes": 15, "download_min": 50.0}), ContractSnapshot: snapshotBytes(t, map[string]interface{}{"id": 9, "contract_no": "C-1", "download_min": 40.0}), LineContextSnapshot: snapshotBytes(t, map[string]interface{}{"version": 2, "provider_id": "p-old"})}
	chain := evidenceChain(item)
	if chain["historical_only"] != true || chain["status"] != "AVAILABLE" {
		t.Fatalf("unexpected chain metadata: %#v", chain)
	}
	if chain["policy"].(map[string]interface{})["version"] != float64(3) {
		t.Fatalf("policy snapshot was not projected: %#v", chain["policy"])
	}
	if chain["confirmation"].(map[string]interface{})["method"] != "DURATION" {
		t.Fatalf("duration policy was not exposed: %#v", chain["confirmation"])
	}
	if chain["line_context"].(map[string]interface{})["version"] != float64(2) {
		t.Fatalf("context snapshot was not projected: %#v", chain["line_context"])
	}
}

func TestEvidenceChainExplicitlyReportsNoDataAndUnknownContext(t *testing.T) {
	chain := evidenceChain(measurementRecord{})
	if chain["status"] != "NO_DATA" {
		t.Fatalf("empty evidence status = %#v", chain["status"])
	}
	completeness := chain["completeness"].(map[string]interface{})
	if completeness["unknown_reason"] == "" {
		t.Fatal("empty evidence must explain unknown/no-data context")
	}
	item := measurementRecord{ID: 1, Valid: true, BaselineState: "OK", ContractState: "MEETS", PolicySnapshot: snapshotBytes(t, map[string]interface{}{"version": 1})}
	chain = evidenceChain(item)
	if chain["status"] != "AVAILABLE" || chain["completeness"].(map[string]interface{})["unknown_reason"] == "" {
		t.Fatalf("missing historical context must remain explicit: %#v", chain)
	}
}

func TestEvidenceChainOpeningAndReportRowsShareProjectionShape(t *testing.T) {
	opening := map[string]interface{}{"evidence_measurement_ids": []interface{}{42.0, 43.0}, "policy": map[string]interface{}{"version": 4}, "contract": map[string]interface{}{"id": 8}, "reason": "confirmed duration"}
	incidentChain := evidenceChainFromOpening(opening, time.Now())
	if incidentChain["confirmation"].(map[string]interface{})["count"] != 2 {
		t.Fatalf("opening evidence count missing: %#v", incidentChain)
	}
	rows := []reportRow{{measurementRecord: measurementRecord{ID: 42, Valid: true, BaselineState: "OK", ContractState: "MEETS"}}}
	rowChain := evidenceChainForRows(rows)
	for _, key := range []string{"baseline", "contract", "confirmation", "completeness", "historical_only"} {
		if _, ok := incidentChain[key]; !ok {
			t.Fatalf("incident projection missing %s", key)
		}
		if _, ok := rowChain[0][key]; !ok {
			t.Fatalf("report projection missing %s", key)
		}
	}
}
