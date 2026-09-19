package measurements

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"linkwatch/server/internal/database"
)

type verificationIntegrationRecord struct {
	ID                     int64
	Status                 string
	Reason                 string
	CandidateSnapshot      []byte
	VerifyingMeasurementID *int64
	VerifyingSnapshot      []byte
	ExpiresAt              time.Time
	VerifiedAt             *time.Time
}

func TestVerificationPersistenceKeepsTerminalEvidenceRelations(t *testing.T) {
	tests := []struct {
		name             string
		wantStatus       string
		wantVerifier     bool
		verifierDownload float64
		verifierUpload   float64
		lateEvidence     bool
	}{
		{name: "confirmed", wantStatus: VerificationConfirmed, wantVerifier: true, verifierDownload: 100, verifierUpload: 10},
		{name: "not confirmed", wantStatus: VerificationNotConfirmed, wantVerifier: true, verifierDownload: 100, verifierUpload: 100},
		{name: "expired", wantStatus: VerificationExpired, wantVerifier: false, verifierDownload: 100, verifierUpload: 10, lateEvidence: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := openMeasurementIntegrationDB(t)
			t.Cleanup(db.Close)
			fixture := createMeasurementIntegrationFixture(t, db, nil, 3)
			t.Cleanup(func() { cleanupMeasurementIntegrationFixture(t, db, fixture) })
			service := &Service{DB: db}
			base := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
			verifierAt := base.Add(time.Minute)
			if test.lateEvidence {
				if _, err := db.Pool.Exec(context.Background(), `UPDATE threshold_policy_versions SET freshness_seconds=60 WHERE scope_type='LINE' AND scope_id=$1`, fixture.lineID); err != nil {
					t.Fatalf("set short verification expiry: %v", err)
				}
				verifierAt = base.Add(2 * time.Minute)
			}

			candidate := submitVerificationMeasurement(t, service, fixture, base, "verification-candidate", "SUSPECT", floatPointer(100), floatPointer(10))
			before := readVerificationRecord(t, db, candidate.MeasurementID)
			candidateSnapshot := append([]byte(nil), before.CandidateSnapshot...)
			verifier := submitVerificationMeasurement(t, service, fixture, verifierAt, "verification-verifier", "VALID", floatPointer(test.verifierDownload), floatPointer(test.verifierUpload))
			after := readVerificationRecord(t, db, candidate.MeasurementID)

			if after.Status != test.wantStatus {
				t.Fatalf("verification status = %q, want %q (expires_at=%s verifier_at=%s delta=%s)", after.Status, test.wantStatus, after.ExpiresAt, verifierAt, after.ExpiresAt.Sub(verifierAt))
			}
			if !after.VerifiedAtValid() {
				t.Fatal("terminal verification has no verified_at")
			}
			if string(after.CandidateSnapshot) != string(candidateSnapshot) {
				t.Fatalf("candidate snapshot changed: before=%s after=%s", candidateSnapshot, after.CandidateSnapshot)
			}
			if test.wantVerifier {
				if after.VerifyingMeasurementID == nil || *after.VerifyingMeasurementID != verifier.MeasurementID {
					t.Fatalf("verifying_measurement_id = %v, want %d", after.VerifyingMeasurementID, verifier.MeasurementID)
				}
				if len(after.VerifyingSnapshot) == 0 {
					t.Fatal("terminal verifier snapshot is empty")
				}
			} else {
				if after.VerifyingMeasurementID != nil || len(after.VerifyingSnapshot) != 0 {
					t.Fatalf("expired verification retained verifier relation: id=%v snapshot=%s", after.VerifyingMeasurementID, after.VerifyingSnapshot)
				}
				if after.Reason != "no eligible subsequent evidence before expiry" {
					t.Fatalf("expired reason = %q", after.Reason)
				}
			}
			assertVerificationAudit(t, db, after.ID, after.Status, after.VerifyingMeasurementID, after.Reason)

			// A later observation is a terminal replay attempt. It must not
			// replace the verifier, snapshot, timestamp, or candidate evidence.
			replay := submitVerificationMeasurement(t, service, fixture, verifierAt.Add(time.Minute), "verification-replay", "VALID", floatPointer(100), floatPointer(100))
			if replay.MeasurementID <= verifier.MeasurementID {
				t.Fatalf("replay measurement id = %d, want a later persisted observation", replay.MeasurementID)
			}
			replayed := readVerificationRecord(t, db, candidate.MeasurementID)
			assertVerificationRecordEqual(t, replayed, after)
			if got := countVerificationAudits(t, db, after.ID); got != 1 {
				t.Fatalf("terminal replay audit count = %d, want 1 transition audit", got)
			}
		})
	}
}

func (item verificationIntegrationRecord) VerifiedAtValid() bool { return item.VerifiedAt != nil }

func submitVerificationMeasurement(t *testing.T, service *Service, fixture measurementIntegrationFixture, observedAt time.Time, eventID, quality string, download, upload *float64) Result {
	t.Helper()
	result, err := service.Process(context.Background(), fixture.deviceID, fixture.lineID, fixture.pointID, "integration-test", Input{
		ClientEventID:    fixture.prefix + "-" + eventID,
		ObservedAt:       observedAt,
		Mode:             "PERFORMANCE",
		Download:         download,
		Upload:           upload,
		Ping:             floatPointer(20),
		Jitter:           floatPointer(1),
		PacketLoss:       floatPointer(0),
		Availability:     floatPointer(100),
		ConnectionStatus: "OK",
		Quality:          quality,
	})
	if err != nil {
		t.Fatalf("process verification measurement %s: %v", eventID, err)
	}
	if !result.Accepted || result.MeasurementID <= 0 {
		t.Fatalf("verification measurement %s was not accepted: %#v", eventID, result)
	}
	return result
}

func readVerificationRecord(t *testing.T, db *database.DB, candidateID int64) verificationIntegrationRecord {
	t.Helper()
	var item verificationIntegrationRecord
	if err := db.Pool.QueryRow(context.Background(), `SELECT id,status,reason,candidate_snapshot_json,verifying_measurement_id,verifying_snapshot_json,expires_at,verified_at FROM measurement_verifications WHERE candidate_measurement_id=$1`, candidateID).Scan(&item.ID, &item.Status, &item.Reason, &item.CandidateSnapshot, &item.VerifyingMeasurementID, &item.VerifyingSnapshot, &item.ExpiresAt, &item.VerifiedAt); err != nil {
		t.Fatalf("read verification candidate %d: %v", candidateID, err)
	}
	return item
}

func assertVerificationRecordEqual(t *testing.T, got, want verificationIntegrationRecord) {
	t.Helper()
	if got.ID != want.ID || got.Status != want.Status || got.Reason != want.Reason || string(got.CandidateSnapshot) != string(want.CandidateSnapshot) || string(got.VerifyingSnapshot) != string(want.VerifyingSnapshot) {
		t.Fatalf("terminal verification changed: got=%#v want=%#v", got, want)
	}
	if (got.VerifyingMeasurementID == nil) != (want.VerifyingMeasurementID == nil) || (got.VerifyingMeasurementID != nil && *got.VerifyingMeasurementID != *want.VerifyingMeasurementID) {
		t.Fatalf("terminal verifier id changed: got=%v want=%v", got.VerifyingMeasurementID, want.VerifyingMeasurementID)
	}
	if (got.VerifiedAt == nil) != (want.VerifiedAt == nil) || (got.VerifiedAt != nil && !got.VerifiedAt.Equal(*want.VerifiedAt)) {
		t.Fatalf("terminal verified_at changed: got=%v want=%v", got.VerifiedAt, want.VerifiedAt)
	}
}

func assertVerificationAudit(t *testing.T, db *database.DB, verificationID int64, wantStatus string, wantVerifier *int64, wantReason string) {
	t.Helper()
	var payload []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT after_json FROM audit_events WHERE object_type='measurement_verification' AND object_id=$1 ORDER BY id DESC LIMIT 1`, fmtInt64(verificationID)).Scan(&payload); err != nil {
		t.Fatalf("read verification audit %d: %v", verificationID, err)
	}
	var value map[string]interface{}
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("decode verification audit %d: %v", verificationID, err)
	}
	if value["status"] != wantStatus || value["reason"] != wantReason {
		t.Fatalf("verification audit = %#v, want status=%s reason=%s", value, wantStatus, wantReason)
	}
	if wantVerifier == nil {
		if value["verifying_measurement_id"] != nil {
			t.Fatalf("expired audit verifier = %#v, want null", value["verifying_measurement_id"])
		}
		return
	}
	got, ok := value["verifying_measurement_id"].(float64)
	if !ok || int64(got) != *wantVerifier {
		t.Fatalf("audit verifier = %#v, want %d", value["verifying_measurement_id"], *wantVerifier)
	}
}

func countVerificationAudits(t *testing.T, db *database.DB, verificationID int64) int {
	t.Helper()
	var count int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM audit_events WHERE object_type='measurement_verification' AND object_id=$1`, fmtInt64(verificationID)).Scan(&count); err != nil {
		t.Fatalf("count verification audits: %v", err)
	}
	return count
}

func fmtInt64(value int64) string {
	return fmt.Sprintf("%d", value)
}
