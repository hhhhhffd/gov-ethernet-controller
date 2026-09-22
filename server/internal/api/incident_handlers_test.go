package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProviderCaseDeliveryActionsRejectNonPost(t *testing.T) {
	for _, action := range []string{"send", "retry", "ai-draft"} {
		t.Run(action, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/provider-cases/1/"+action, nil)
			(&Server{}).providerCaseRoute(recorder, request, "1/"+action)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("GET provider case %s status = %d, want %d", action, recorder.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

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
