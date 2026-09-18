package api

import (
	"testing"
	"time"
)

func TestSituationEvidenceStateExplicitAbsenceAndUnknown(t *testing.T) {
	if got := situationEvidenceState(nil, nil); got != "NO_DATA" {
		t.Fatalf("without confirmation/evidence = %q, want NO_DATA", got)
	}
	confirmed := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	if got := situationEvidenceState(nil, &confirmed); got != "UNKNOWN" {
		t.Fatalf("confirmation without evidence = %q, want UNKNOWN", got)
	}
	if got := situationEvidenceState([]int64{42}, nil); got != "AVAILABLE" {
		t.Fatalf("measurement evidence = %q, want AVAILABLE", got)
	}
}

func TestSituationEvidenceAggregatePrefersAvailableThenUnknown(t *testing.T) {
	if got := situationEvidenceAggregate(map[string]int{"NO_DATA": 2}); got != "NO_DATA" {
		t.Fatalf("no data aggregate = %q", got)
	}
	if got := situationEvidenceAggregate(map[string]int{"NO_DATA": 2, "UNKNOWN": 1}); got != "UNKNOWN" {
		t.Fatalf("unknown aggregate = %q", got)
	}
	if got := situationEvidenceAggregate(map[string]int{"NO_DATA": 2, "UNKNOWN": 1, "AVAILABLE": 1}); got != "AVAILABLE" {
		t.Fatalf("available aggregate = %q", got)
	}
}
