package api

import (
	"testing"
	"time"
)

func TestMeasurementMapProjectsVerificationStatus(t *testing.T) {
	item := measurementRecord{ID: 41, Quality: "SUSPECT", VerificationStatus: "PENDING"}
	mapped := measurementMap(item)
	if got, ok := mapped["verification_status"].(string); !ok || got != "PENDING" {
		t.Fatalf("verification_status = %#v, want PENDING", mapped["verification_status"])
	}
}

func TestMeasurementMapProjectsPersistedVerificationRelation(t *testing.T) {
	verifiedAt := time.Date(2026, 9, 20, 10, 1, 0, 0, time.UTC)
	verifierID := int64(42)
	item := measurementRecord{
		ID:                     41,
		VerificationStatus:     "CONFIRMED",
		VerificationReason:     "subsequent evidence classified the candidate",
		CandidateSnapshot:      []byte(`{"measurement_id":41,"quality":"SUSPECT"}`),
		VerifyingMeasurementID: &verifierID,
		VerifyingSnapshot:      []byte(`{"measurement_id":42,"quality":"VALID"}`),
		VerificationVerifiedAt: &verifiedAt,
	}
	mapped := measurementMap(item)
	chain := mapped["evidence_chain"].(map[string]interface{})
	verification := chain["verification"].(map[string]interface{})
	if verification["status"] != "CONFIRMED" || verification["reason"] != item.VerificationReason {
		t.Fatalf("terminal verification projection = %#v", verification)
	}
	gotVerifier, ok := verification["verifying_measurement_id"].(int64)
	if !ok || gotVerifier != verifierID {
		t.Fatalf("verifier relation = %#v, want %d", verification["verifying_measurement_id"], verifierID)
	}
	if verification["candidate_snapshot"].(map[string]interface{})["measurement_id"] != float64(41) || verification["verifying_snapshot"].(map[string]interface{})["measurement_id"] != float64(42) {
		t.Fatalf("verification snapshots = %#v", verification)
	}
	if got := verification["verified_at"].(*time.Time); got == nil || !got.Equal(verifiedAt) {
		t.Fatalf("verified_at = %#v, want %s", verification["verified_at"], verifiedAt)
	}

	expired := measurementMap(measurementRecord{
		ID:                 51,
		VerificationStatus: "EXPIRED",
		VerificationReason: "no eligible subsequent evidence before expiry",
		CandidateSnapshot:  []byte(`{"measurement_id":51,"quality":"SUSPECT"}`),
	})
	expiredVerification := expired["evidence_chain"].(map[string]interface{})["verification"].(map[string]interface{})
	if expiredVerification["status"] != "EXPIRED" || expiredVerification["verifying_measurement_id"] != nil || expiredVerification["verifying_snapshot"] != nil {
		t.Fatalf("expired verification retained verifier relation: %#v", expiredVerification)
	}
}
