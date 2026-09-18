package api

import "testing"

func TestRecoveryLabelKeepsObservedDistinctFromConfirmed(t *testing.T) {
	if got := recoveryLabel("OBSERVED", "RESOLVED"); got == recoveryLabel("CONFIRMED", "CLOSED") {
		t.Fatalf("observed recovery label %q must differ from confirmed recovery", got)
	}
	if got := recoveryLabel("OBSERVED", "RESOLVED"); got != "Восстановление наблюдается; подтверждение ожидается" {
		t.Fatalf("observed recovery label = %q", got)
	}
	if got := recoveryLabel("CONFIRMED", "CLOSED"); got != "Восстановление подтверждено" {
		t.Fatalf("confirmed recovery label = %q", got)
	}
}

func TestRecoveryLabelDoesNotTreatResolvedAsClosed(t *testing.T) {
	if got := recoveryLabel("NONE", "RESOLVED"); got == "Закрыт" {
		t.Fatalf("resolved incident was presented as closed: %q", got)
	}
}
