package api

import (
	"reflect"
	"testing"
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
