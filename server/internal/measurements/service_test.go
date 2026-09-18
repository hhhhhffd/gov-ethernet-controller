package measurements

import (
	"bytes"
	"encoding/json"
	"math"
	"testing"
	"time"

	"linkwatch/server/internal/evaluation"
)

func TestInputDecodesAndPreservesTopLevelLatencyEvidence(t *testing.T) {
	payload := []byte(`{"client_event_id":"latency-1","observed_at":"2026-09-18T10:00:00Z","mode":"LIGHT","ping":34,"connection_status":"OK","latency_method":"TCP_CONNECT","latency_evidence":{"method":"TCP_CONNECT","sample_count":2,"samples_ms":[33.5,34.5]}}`)
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var input Input
	if err := decoder.Decode(&input); err != nil {
		t.Fatalf("latency payload rejected: %v", err)
	}
	preserveLatencyEvidence(&input)
	if input.LatencyMethod != "TCP_CONNECT" {
		t.Fatalf("latency method = %q, want TCP_CONNECT", input.LatencyMethod)
	}
	if got := input.Raw["latency_method"]; got != "TCP_CONNECT" {
		t.Fatalf("raw latency method = %#v, want TCP_CONNECT", got)
	}
	evidence, ok := input.Raw["latency_evidence"].(map[string]interface{})
	if !ok || evidence["method"] != "TCP_CONNECT" {
		t.Fatalf("raw latency evidence = %#v, want preserved object", input.Raw["latency_evidence"])
	}
}

func TestPreserveLatencyEvidenceRetainsConflictingRawValues(t *testing.T) {
	input := Input{
		LatencyMethod:   "TCP_CONNECT",
		LatencyEvidence: map[string]interface{}{"method": "TCP_CONNECT"},
		Raw: map[string]interface{}{
			"latency_method":   "ICMP",
			"latency_evidence": map[string]interface{}{"method": "ICMP"},
		},
	}
	preserveLatencyEvidence(&input)
	if input.Raw["latency_method"] != "TCP_CONNECT" || input.Raw["latency_method_raw"] != "ICMP" {
		t.Fatalf("conflicting latency method was not preserved: %#v", input.Raw)
	}
	if input.Raw["latency_evidence_raw"] == nil {
		t.Fatalf("conflicting latency evidence was dropped: %#v", input.Raw)
	}
}

func TestConfirmationPolicyKeepsCountIndependentFromDuration(t *testing.T) {
	base := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []recentEvaluation{
		{ID: 3, ObservedAt: base.Add(40 * time.Minute), Valid: true},
		{ID: 2, ObservedAt: base.Add(20 * time.Minute), Valid: true},
		{ID: 1, ObservedAt: base, Valid: true},
	}
	problem := func(row recentEvaluation) bool { return row.Valid }
	relevant := func(recentEvaluation) bool { return true }
	if got := confirmationEvidence(rows, confirmationPolicy{Mode: confirmationCount, Count: 3, Duration: 15 * time.Minute}, relevant, problem); len(got) != 3 {
		t.Fatalf("count confirmation incorrectly limited by duration: %#v", got)
	}
	if got := confirmationEvidence(rows, confirmationPolicy{Mode: confirmationDuration, Duration: 30 * time.Minute}, relevant, problem); len(got) != 3 {
		t.Fatalf("duration confirmation length = %d, want 3", len(got))
	}
	rows[1].Valid = false
	if got := confirmationEvidence(rows, confirmationPolicy{Mode: confirmationCount, Count: 3}, relevant, problem); got != nil {
		t.Fatalf("non-consecutive invalid observation confirmed %#v", got)
	}
}

func TestConfirmationModes(t *testing.T) {
	tests := []struct {
		name   string
		policy confirmationPolicy
		want   bool
	}{
		{"count", confirmationPolicy{Mode: confirmationCount, Count: 2}, true},
		{"duration", confirmationPolicy{Mode: confirmationDuration, Duration: 20 * time.Minute}, true},
		{"either", confirmationPolicy{Mode: confirmationEither, Count: 3, Duration: 20 * time.Minute}, true},
		{"both", confirmationPolicy{Mode: confirmationBoth, Count: 2, Duration: 20 * time.Minute}, true},
		{"both requires count", confirmationPolicy{Mode: confirmationBoth, Count: 4, Duration: 20 * time.Minute}, false},
	}
	rows := []recentEvaluation{
		{ID: 2, ObservedAt: time.Date(2026, 9, 16, 12, 20, 0, 0, time.UTC), Valid: true},
		{ID: 1, ObservedAt: time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC), Valid: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := confirmationEvidence(rows, tt.policy, func(recentEvaluation) bool { return true }, func(row recentEvaluation) bool { return row.Valid })
			if (got != nil) != tt.want {
				t.Fatalf("confirmation = %v, want %v", got != nil, tt.want)
			}
		})
	}
}

func TestConfirmationEvidenceStopsAtSatisfiedCount(t *testing.T) {
	base := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := make([]recentEvaluation, 1000)
	for i := range rows {
		rows[i] = recentEvaluation{ID: int64(1000 - i), ObservedAt: base.Add(-time.Duration(i) * time.Minute), Valid: true}
	}
	got := confirmationEvidence(rows, confirmationPolicy{Mode: confirmationCount, Count: 3},
		func(recentEvaluation) bool { return true }, func(row recentEvaluation) bool { return row.Valid })
	if len(got) != 3 {
		t.Fatalf("count evidence length = %d, want 3", len(got))
	}
}

func TestConnectionStateDoesNotTreatUnknownAsHealthy(t *testing.T) {
	for _, test := range []struct {
		name     string
		baseline string
		want     string
	}{
		{name: "ok", baseline: "OK", want: "OK"},
		{name: "violation", baseline: "VIOLATION", want: "DEGRADED"},
		{name: "unknown", baseline: "UNKNOWN", want: "UNKNOWN"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := connectionStateForResult(evaluation.Result{Valid: true, BaselineState: test.baseline})
			if got != test.want {
				t.Fatalf("connection state = %q, want %q", got, test.want)
			}
		})
	}
}

func TestEvidenceIsMetricAndModeSpecific(t *testing.T) {
	base := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []recentEvaluation{
		{ID: 4, ObservedAt: base.Add(3 * time.Minute), Mode: "PERFORMANCE", Valid: true, Metrics: map[string]bool{"download": true}, Violations: []evaluation.Violation{{Code: "BASELINE_DOWNLOAD"}}},
		{ID: 3, ObservedAt: base.Add(2 * time.Minute), Mode: "LIGHT", Valid: true, Metrics: map[string]bool{"ping": true}, Violations: []evaluation.Violation{{Code: "BASELINE_PING"}}},
		{ID: 2, ObservedAt: base.Add(time.Minute), Mode: "PERFORMANCE", Valid: true, Metrics: map[string]bool{"ping": true}, Violations: []evaluation.Violation{{Code: "BASELINE_PING"}}},
		{ID: 1, ObservedAt: base, Mode: "PERFORMANCE", Valid: true, Metrics: map[string]bool{"download": true}, Violations: []evaluation.Violation{{Code: "BASELINE_DOWNLOAD"}}},
	}
	policy := confirmationPolicy{Mode: confirmationCount, Count: 3}
	if got := confirmedForCode("line-1", rows, "PERFORMANCE", policy, "BASELINE_DOWNLOAD", false); got != nil {
		t.Fatalf("cross-metric/mode evidence confirmed download: %#v", got)
	}
	if keyFor("line-1", "BASELINE_DOWNLOAD", "LIGHT") == keyFor("line-1", "BASELINE_DOWNLOAD", "PERFORMANCE") {
		t.Fatal("LIGHT and PERFORMANCE evidence keys must differ")
	}
}

func TestRecoveryIgnoresMissingMetric(t *testing.T) {
	base := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []recentEvaluation{
		{ID: 2, ObservedAt: base.Add(time.Minute), Mode: "PERFORMANCE", Valid: true, Metrics: map[string]bool{"ping": true}},
		{ID: 1, ObservedAt: base, Mode: "PERFORMANCE", Valid: true, Metrics: map[string]bool{"download": true}, Violations: []evaluation.Violation{{Code: "BASELINE_DOWNLOAD"}}},
	}
	if got := confirmedForCode("line-1", rows, "PERFORMANCE", confirmationPolicy{Mode: confirmationCount, Count: 1}, "BASELINE_DOWNLOAD", true); got != nil {
		t.Fatalf("missing download metric incorrectly confirmed recovery: %#v", got)
	}
}

func TestValidateInputRejectsInvalidMeasurements(t *testing.T) {
	valid := Input{ClientEventID: "event-1", Mode: "PERFORMANCE", ConnectionStatus: "OK", Quality: "VALID", Download: floatPtr(10)}
	if err := validateInput(valid); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	invalid := valid
	invalid.Download = floatPtr(math.NaN())
	if err := validateInput(invalid); err == nil {
		t.Fatal("NaN metric accepted")
	}
	noData := valid
	noData.Download = nil
	if err := validateInput(noData); err == nil {
		t.Fatal("online measurement without metrics accepted")
	}
	noInternet := Input{ClientEventID: "event-2", Mode: "PERFORMANCE", ConnectionStatus: "NO_INTERNET", Quality: "VALID"}
	if err := validateInput(noInternet); err != nil {
		t.Fatalf("NO_INTERNET evidence rejected without metrics: %v", err)
	}
}

func floatPtr(value float64) *float64 { return &value }
