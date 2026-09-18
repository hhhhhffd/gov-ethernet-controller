package api

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestReportDeviceIDs(t *testing.T) {
	query := map[string][]string{
		"device_ids[]": {"dev-a", "dev-b, dev-a"},
		"device_ids":   {"dev-c"},
	}
	got := reportDeviceIDs(query)
	want := []string{"dev-a", "dev-b", "dev-c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reportDeviceIDs() = %#v, want %#v", got, want)
	}
}

func TestSummarizeAvailabilityClassifiesNoDataAndThreshold(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Hour)
	threshold := 80.0
	got := summarizeAvailability(start, end, []availabilityInterval{
		{Start: start, End: start.Add(4 * time.Hour), State: availabilityAvailable},
		{Start: start.Add(4 * time.Hour), End: start.Add(6 * time.Hour), State: availabilityUnavailable},
	}, &threshold, 80)
	if got.ObservedDuration != 6*time.Hour || got.UnavailableDuration != 2*time.Hour || got.NoDataDuration != 4*time.Hour {
		t.Fatalf("durations = observed %v unavailable %v no_data %v", got.ObservedDuration, got.UnavailableDuration, got.NoDataDuration)
	}
	if got.Status != "UNKNOWN" {
		t.Fatalf("status = %q, want UNKNOWN below completeness gate", got.Status)
	}
	if got.DataCompletenessPct != 60 {
		t.Fatalf("completeness = %v, want 60", got.DataCompletenessPct)
	}
}

func TestSummarizeAvailabilityPassFailAndBoundaryClipping(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Hour)
	threshold := 75.0
	got := summarizeAvailability(start, end, []availabilityInterval{{Start: start.Add(-2 * time.Hour), End: end, State: availabilityAvailable}}, &threshold, 80)
	if got.Status != "PASS" || got.AvailabilityPct == nil || *got.AvailabilityPct != 100 || got.NoDataDuration != 0 {
		t.Fatalf("summary = %#v, want clipped full PASS", got)
	}
	got = summarizeAvailability(start, end, []availabilityInterval{{Start: start, End: end, State: availabilityUnavailable}}, &threshold, 80)
	if got.Status != "FAIL" || got.AvailabilityPct == nil || *got.AvailabilityPct != 0 {
		t.Fatalf("summary = %#v, want full outage FAIL", got)
	}
}

func TestSelectedExportFieldsRejectsUnknownAndDeduplicates(t *testing.T) {
	got, err := selectedExportFields(map[string][]string{"fields[]": {"device_id", "device_id", "line_id"}}, "raw")
	if err != nil {
		t.Fatalf("selectedExportFields() error = %v", err)
	}
	if want := []string{"device_id", "line_id"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("selectedExportFields() = %#v, want %#v", got, want)
	}
	if _, err := selectedExportFields(map[string][]string{"fields[]": {"raw_json"}}, "raw"); err == nil {
		t.Fatal("selectedExportFields() accepted an unauthorized field")
	}
}

func TestReportProblemPercentUsesMeasurementsAsDenominator(t *testing.T) {
	if got := reportProblemPercent(1, 4); got != 25 {
		t.Fatalf("reportProblemPercent() = %v, want 25", got)
	}
	if got := reportProblemPercent(1, 0); got != 0 {
		t.Fatalf("reportProblemPercent() empty = %v, want 0", got)
	}
}

func TestAvailabilitySummaryUsesStoredThresholdAndExplicitUnknowns(t *testing.T) {
	threshold := func(value float64) []byte {
		payload, _ := json.Marshal(map[string]interface{}{"availability_min": value})
		return payload
	}
	value := func(number float64) *float64 { return &number }
	rows := []reportRow{
		{measurementRecord: measurementRecord{Availability: value(100), Quality: "VALID", Valid: true, PolicySnapshot: threshold(99)}},
		{measurementRecord: measurementRecord{Availability: value(98), Quality: "VALID", Valid: true, PolicySnapshot: threshold(99)}},
		{measurementRecord: measurementRecord{Availability: nil, Quality: "VALID", Valid: true, PolicySnapshot: threshold(99)}},
		{measurementRecord: measurementRecord{Availability: value(100), Quality: "SUSPECT", Valid: false, PolicySnapshot: threshold(99)}},
		{measurementRecord: measurementRecord{Availability: value(100), Quality: "VALID", Valid: true}},
		{measurementRecord: measurementRecord{Availability: value(100), Quality: "VALID", Valid: true, PolicySnapshot: threshold(99), ContractSnapshot: threshold(98)}},
	}
	summary := availabilitySummaryForRows(rows)
	if summary.Valid != 1 || summary.Invalid != 1 || summary.Unknown != 4 {
		t.Fatalf("summary = %#v, want valid=1 invalid=1 unknown=4", summary)
	}
	if got := *summary.percent(); got != 50 {
		t.Fatalf("percent = %v, want 50", got)
	}
}

func TestAvailabilitySummaryPercentIsUnknownWithoutKnownObservations(t *testing.T) {
	if got := (availabilitySummary{Unknown: 2}).percent(); got != nil {
		t.Fatalf("percent = %v, want nil for unknown-only observations", *got)
	}
}

func TestAvailabilityThresholdAcceptsMatchingPolicyAndContractSnapshots(t *testing.T) {
	policy := []byte(`{"availability_min":99}`)
	contract := []byte(`{"availability_min":99}`)
	if value, ok := availabilityThreshold(policy, contract); !ok || value != 99 {
		t.Fatalf("threshold = (%v, %v), want (99, true)", value, ok)
	}
}
