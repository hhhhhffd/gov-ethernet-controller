package api

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestComparisonCompletenessPreservesNoDataAndSparseEvidence(t *testing.T) {
	if got := comparisonCompleteness(0, 0)["status"]; got != "NO_DATA" {
		t.Fatalf("empty controls = %v", got)
	}
	if got := comparisonCompleteness(3, 0)["status"]; got != "UNKNOWN" {
		t.Fatalf("invalid-only controls = %v", got)
	}
	if got := comparisonCompleteness(3, 1)["status"]; got != "AVAILABLE" {
		t.Fatalf("valid controls = %v", got)
	}
}

func TestComparisonWindowIsBoundedAndHistorical(t *testing.T) {
	center := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	r := httptest.NewRequest("GET", "/api/situations/1/comparison?window_minutes=15", nil)
	from, to, err := comparisonWindow(r, center)
	if err != nil || to.Sub(from) != 15*time.Minute {
		t.Fatalf("window = %s..%s err=%v", from, to, err)
	}
	r = httptest.NewRequest("GET", "/api/situations/1/comparison?window_minutes=1", nil)
	if _, _, err := comparisonWindow(r, center); err == nil {
		t.Fatal("unbounded window must fail")
	}
}

func TestComparisonRowsExposeEvidenceOnlyAndNoCausalClaim(t *testing.T) {
	rows := comparisonRows([]comparisonLine{{LineID: "L-1", SchoolID: "S-1", MeasurementCount: 2, ValidCount: 1, BaselineOK: 1}})
	if rows[0]["line_id"] != "L-1" || rows[0]["completeness"].(map[string]interface{})["status"] != "AVAILABLE" {
		t.Fatalf("unexpected comparison row: %#v", rows[0])
	}
	if rows[0]["late_data_note"] == "" {
		t.Fatal("historical late-data semantics must be explicit")
	}
}
