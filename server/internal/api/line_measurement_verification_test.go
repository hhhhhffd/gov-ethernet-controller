package api

import "testing"

func TestMeasurementMapProjectsVerificationStatus(t *testing.T) {
	item := measurementRecord{ID: 41, Quality: "SUSPECT", VerificationStatus: "PENDING"}
	mapped := measurementMap(item)
	if got, ok := mapped["verification_status"].(string); !ok || got != "PENDING" {
		t.Fatalf("verification_status = %#v, want PENDING", mapped["verification_status"])
	}
}
