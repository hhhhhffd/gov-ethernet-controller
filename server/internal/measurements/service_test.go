package measurements

import (
	"math"
	"testing"
	"time"
)

func TestConfirmedRequiresConsecutiveRowsAndWindow(t *testing.T) {
	base := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []recentEvaluation{
		{ID: 3, ObservedAt: base.Add(20 * time.Minute), Valid: true},
		{ID: 2, ObservedAt: base.Add(10 * time.Minute), Valid: true},
		{ID: 1, ObservedAt: base, Valid: true},
	}
	problem := func(row recentEvaluation) bool { return row.Valid }
	if got := confirmed(rows, 3, 15, problem); got != nil {
		t.Fatalf("streak outside time window returned %#v", got)
	}
	if got := confirmed(rows, 3, 20, problem); len(got) != 3 {
		t.Fatalf("streak inside time window length = %d, want 3", len(got))
	}
	rows[1].Valid = false
	if got := confirmed(rows, 3, 20, problem); got != nil {
		t.Fatalf("non-consecutive invalid observation confirmed %#v", got)
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
