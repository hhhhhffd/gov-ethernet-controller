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
	provenance := chain["configuration_provenance"].(map[string]interface{})["historical"].(map[string]interface{})["policy"].(map[string]interface{})
	if provenance["source"] != "stored_policy_snapshot" || provenance["change_metadata_status"] != "UNKNOWN" {
		t.Fatalf("snapshot provenance must expose source and missing audit metadata: %#v", provenance)
	}
	if chain["configuration_provenance"].(map[string]interface{})["current_operational"].(map[string]interface{})["status"] != "NOT_INCLUDED" {
		t.Fatal("historical chain must not silently use current configuration")
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
	if incidentChain["status"] != "AVAILABLE" {
		t.Fatalf("incident evidence status = %#v, want AVAILABLE", incidentChain["status"])
	}
	if incidentChain["confirmation"].(map[string]interface{})["count"] != 2 {
		t.Fatalf("opening evidence count missing: %#v", incidentChain)
	}
	observationIDs, ok := incidentChain["confirmation"].(map[string]interface{})["observation_ids"].([]int64)
	if !ok || len(observationIDs) != 2 || observationIDs[0] != 42 || observationIDs[1] != 43 {
		t.Fatalf("opening evidence observation IDs = %#v, want [42 43]", incidentChain["confirmation"].(map[string]interface{})["observation_ids"])
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

func TestEvidenceChainLinksRemainScopedToKnownLine(t *testing.T) {
	item := measurementRecord{ID: 11, LineID: "L-11", Valid: true, BaselineState: "OK"}
	links := evidenceChain(item)["scoped_links"].([]string)
	if len(links) != 2 || links[0] != "/api/lines/L-11" || links[1] != "/api/v1/lines/L-11" {
		t.Fatalf("unexpected scoped links: %#v", links)
	}
	if got := evidenceChain(measurementRecord{})["scoped_links"].([]string); len(got) != 0 {
		t.Fatalf("missing line must not receive guessed links: %#v", got)
	}
}

func TestConfigurationHierarchyIsDeterministicAndPreservesUnknowns(t *testing.T) {
	historical := configurationHierarchy(map[string]interface{}{"scope_type": "LINE", "scope_id": "L-1", "version": float64(2)}, map[string]interface{}{"line_id": "L-1", "id": float64(8)}, map[string]interface{}{"version": float64(3)}, true)
	if historical["historical"] != true {
		t.Fatal("historical hierarchy flag missing")
	}
	precedence := historical["precedence"].([]string)
	if len(precedence) != 4 || precedence[0] != "LINE_POLICY" || precedence[1] != "GLOBAL_POLICY" {
		t.Fatalf("unexpected precedence: %#v", precedence)
	}
	current := configurationHierarchy(map[string]interface{}{}, map[string]interface{}{}, map[string]interface{}{}, false)
	if current["policy"].(map[string]interface{})["scope_type"] != "UNKNOWN" || current["context_reason"] == nil {
		t.Fatalf("missing hierarchy inputs must remain unknown: %#v", current)
	}
}
