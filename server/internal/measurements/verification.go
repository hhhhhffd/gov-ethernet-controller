package measurements

import "time"

const (
	VerificationPending      = "PENDING"
	VerificationConfirmed    = "CONFIRMED"
	VerificationNotConfirmed = "NOT_CONFIRMED"
	VerificationExpired      = "EXPIRED"
)

// VerificationCandidate is the immutable part of a suspicious observation.
// It deliberately contains no mutable line state.
type VerificationCandidate struct {
	Status      string
	CandidateAt time.Time
	ExpiresAt   time.Time
	VerifyingAt *time.Time
}

// VerificationOutcome is derived from the later evaluation, never from the
// current LineState. A valid violating observation confirms the suspicious
// condition; a valid healthy observation disproves it.
func VerificationOutcome(valid bool, baselineState, contractState, connectionStatus string) string {
	if !valid {
		return ""
	}
	if connectionStatus == "NO_INTERNET" || baselineState == "VIOLATION" || contractState == "DEVIATES" {
		return VerificationConfirmed
	}
	return VerificationNotConfirmed
}

// TransitionVerification applies the only legal transitions. Replaying an
// already terminal candidate is a no-op, which makes retries idempotent.
func TransitionVerification(candidate VerificationCandidate, now time.Time, outcome string) (string, bool) {
	if candidate.Status != VerificationPending {
		return candidate.Status, false
	}
	if outcome == VerificationConfirmed || outcome == VerificationNotConfirmed {
		if !candidate.ExpiresAt.IsZero() && now.After(candidate.ExpiresAt) {
			return VerificationExpired, true
		}
		return outcome, true
	}
	if !candidate.ExpiresAt.IsZero() && !now.Before(candidate.ExpiresAt) {
		return VerificationExpired, true
	}
	return VerificationPending, false
}
