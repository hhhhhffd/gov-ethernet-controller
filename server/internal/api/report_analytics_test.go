package api

import (
	"strings"
	"testing"
	"time"
)

func analyticsTestRow(line string, hour int, valid bool, baseline, contract string, download float64) reportRow {
	return reportRow{measurementRecord: measurementRecord{ID: int64(hour + 1), LineID: line, ObservedAt: time.Date(2026, 1, 2, hour, 0, 0, 0, time.UTC), Valid: valid, BaselineState: baseline, ContractState: contract, Download: &download}}
}

func TestAnalyticsRowsAreBoundedAndHistorical(t *testing.T) {
	rows := []reportRow{analyticsTestRow("L-2", 13, true, "OK", "MEETS", 20), analyticsTestRow("L-1", 1, false, "VIOLATION", "DEVIATES", 10)}
	result := analyticsRows(rows, 1)
	if result["status"] != "AVAILABLE" || result["historical_only"] != true || result["current_state_used"] != false {
		t.Fatalf("unexpected analytics status: %#v", result)
	}
	ranking := result["ranking"].([]map[string]interface{})
	if len(ranking) != 1 || ranking[0]["line_id"] != "L-2" {
		t.Fatalf("ranking limit/order failed: %#v", ranking)
	}
	if len(result["time_of_day"].([]map[string]interface{})) != 6 {
		t.Fatal("expected six time-of-day buckets")
	}
}

func TestAnalyticsRowsExposeNoDataAndUnknown(t *testing.T) {
	noData := analyticsRows(nil, 50)
	if noData["status"] != "NO_DATA" {
		t.Fatalf("expected NO_DATA: %#v", noData)
	}
	unknown := analyticsRows([]reportRow{{measurementRecord: measurementRecord{LineID: "L", ObservedAt: time.Now(), Valid: false}}}, 50)
	if unknown["status"] != "UNKNOWN" {
		t.Fatalf("expected UNKNOWN: %#v", unknown)
	}
	if !strings.Contains(unknown["ranking"].([]map[string]interface{})[0]["state"].(string), "UNKNOWN") {
		t.Fatal("ranking lost unknown state")
	}
}
