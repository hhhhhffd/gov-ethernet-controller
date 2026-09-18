package measurements

import (
	"testing"
	"time"
)

func TestVerificationOutcomeUsesEvaluationEvidence(t *testing.T) {
	if got := VerificationOutcome(true, "VIOLATION", "UNKNOWN", "OK"); got != VerificationConfirmed {
		t.Fatalf("violation outcome = %q", got)
	}
	if got := VerificationOutcome(true, "OK", "MEETS", "OK"); got != VerificationNotConfirmed {
		t.Fatalf("healthy outcome = %q", got)
	}
	if got := VerificationOutcome(false, "UNKNOWN", "UNKNOWN", "OK"); got != "" {
		t.Fatalf("non-authoritative outcome = %q", got)
	}
}

func TestVerificationTransitionsAreTerminalAndExpireDeterministically(t *testing.T) {
	base := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	candidate := VerificationCandidate{Status: VerificationPending, CandidateAt: base, ExpiresAt: base.Add(time.Hour)}
	if got, changed := TransitionVerification(candidate, base.Add(10*time.Minute), VerificationConfirmed); got != VerificationConfirmed || !changed {
		t.Fatalf("confirm transition = %q, %v", got, changed)
	}
	candidate.Status = VerificationConfirmed
	if got, changed := TransitionVerification(candidate, base.Add(20*time.Minute), VerificationNotConfirmed); got != VerificationConfirmed || changed {
		t.Fatalf("terminal replay = %q, %v", got, changed)
	}
	if got, changed := TransitionVerification(VerificationCandidate{Status: VerificationPending, ExpiresAt: base.Add(time.Hour)}, base.Add(time.Hour), ""); got != VerificationExpired || !changed {
		t.Fatalf("expiry transition = %q, %v", got, changed)
	}
}

func TestVerificationLateEvidenceCannotConfirmExpiredCandidate(t *testing.T) {
	base := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	candidate := VerificationCandidate{Status: VerificationPending, CandidateAt: base, ExpiresAt: base.Add(time.Hour)}
	got, changed := TransitionVerification(candidate, base.Add(2*time.Hour), VerificationConfirmed)
	if got != VerificationExpired || !changed {
		t.Fatalf("late evidence = %q, %v", got, changed)
	}
}
