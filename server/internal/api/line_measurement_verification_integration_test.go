package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"linkwatch/server/internal/database"
	"linkwatch/server/internal/measurements"
)

type verificationAPIIntegrationCase struct {
	name         string
	lineID       string
	pointID      string
	deviceID     string
	wantStatus   string
	wantVerifier bool
}

type verificationAPIIntegrationFixture struct {
	prefix         string
	organizationID string
	providerID     string
	cases          []verificationAPIIntegrationCase
}

func TestLineMeasurementsProjectPersistedVerificationAcrossAPIAliases(t *testing.T) {
	dsn := os.Getenv("LINKWATCH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run PostgreSQL API verification integration tests")
	}
	db, err := database.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open API verification integration database: %v", err)
	}
	t.Cleanup(db.Close)
	fixture := createVerificationAPIIntegrationFixture(t, db)
	t.Cleanup(func() { cleanupVerificationAPIIntegrationFixture(t, db, fixture) })

	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "1")
	application, err := New(db, "")
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	httpServer := httptest.NewServer(application.Handler())
	t.Cleanup(httpServer.Close)

	service := &measurements.Service{DB: db}
	base := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	for _, testCase := range fixture.cases {
		t.Run(testCase.name, func(t *testing.T) {
			candidate := submitVerificationAPIObservation(t, service, fixture, testCase, base, "candidate", "SUSPECT", 100, 10)
			verifierAt := base.Add(time.Minute)
			verifierUpload := 100.0
			if testCase.wantStatus == measurements.VerificationConfirmed || testCase.wantStatus == measurements.VerificationExpired {
				verifierUpload = 10
			}
			if testCase.wantStatus == measurements.VerificationExpired {
				verifierAt = base.Add(2 * time.Minute)
			}
			verifier := submitVerificationAPIObservation(t, service, fixture, testCase, verifierAt, "verifier", "VALID", 100, verifierUpload)

			for _, alias := range []string{"/api", "/api/v1"} {
				path := fmt.Sprintf("%s/lines/%s/measurements", alias, testCase.lineID)
				mapped := fetchVerificationAPIMeasurement(t, httpServer.Client(), httpServer.URL+path, candidate.MeasurementID)
				assertVerificationAPIPayload(t, mapped, testCase.wantStatus, testCase.wantVerifier, candidate.MeasurementID, verifier.MeasurementID)
				if alias == "/api" {
					apiPayload := mapped
					v1Payload := fetchVerificationAPIMeasurement(t, httpServer.Client(), httpServer.URL+"/api/v1/lines/"+testCase.lineID+"/measurements", candidate.MeasurementID)
					if !reflect.DeepEqual(apiPayload, v1Payload) {
						t.Fatalf("/api and /api/v1 verification projections differ: api=%#v v1=%#v", apiPayload, v1Payload)
					}
				}
			}
		})
	}
}

func submitVerificationAPIObservation(t *testing.T, service *measurements.Service, fixture verificationAPIIntegrationFixture, testCase verificationAPIIntegrationCase, observedAt time.Time, label, quality string, download, upload float64) measurements.Result {
	t.Helper()
	result, err := service.Process(context.Background(), testCase.deviceID, testCase.lineID, testCase.pointID, "integration-test", measurements.Input{
		ClientEventID:    fmt.Sprintf("%s-%s-%s", fixture.prefix, testCase.name, label),
		ObservedAt:       observedAt,
		Mode:             "PERFORMANCE",
		Download:         floatPointerForVerificationAPI(download),
		Upload:           floatPointerForVerificationAPI(upload),
		Ping:             floatPointerForVerificationAPI(20),
		Jitter:           floatPointerForVerificationAPI(1),
		PacketLoss:       floatPointerForVerificationAPI(0),
		Availability:     floatPointerForVerificationAPI(100),
		ConnectionStatus: "OK",
		Quality:          quality,
	})
	if err != nil {
		t.Fatalf("process %s observation: %v", label, err)
	}
	if !result.Accepted || result.MeasurementID <= 0 {
		t.Fatalf("%s observation was not accepted: %#v", label, result)
	}
	return result
}

func fetchVerificationAPIMeasurement(t *testing.T, client *http.Client, endpoint string, measurementID int64) map[string]interface{} {
	t.Helper()
	response, err := client.Get(endpoint)
	if err != nil {
		t.Fatalf("GET %s: %v", endpoint, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read GET %s: %v", endpoint, err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status = %d, body = %s", endpoint, response.StatusCode, body)
	}
	var items []map[string]interface{}
	if err := json.Unmarshal(body, &items); err != nil {
		t.Fatalf("decode GET %s: %v; body=%s", endpoint, err, body)
	}
	for _, item := range items {
		if id, ok := item["id"].(float64); ok && int64(id) == measurementID {
			return item
		}
	}
	t.Fatalf("measurement %d missing from %s response: %s", measurementID, endpoint, body)
	return nil
}

func assertVerificationAPIPayload(t *testing.T, payload map[string]interface{}, wantStatus string, wantVerifier bool, candidateID, verifierID int64) {
	t.Helper()
	if payload["verification_status"] != wantStatus {
		t.Fatalf("verification_status = %#v, want %s", payload["verification_status"], wantStatus)
	}
	chain, ok := payload["evidence_chain"].(map[string]interface{})
	if !ok {
		t.Fatalf("evidence_chain = %#v", payload["evidence_chain"])
	}
	verification, ok := chain["verification"].(map[string]interface{})
	if !ok {
		t.Fatalf("evidence_chain.verification = %#v", chain["verification"])
	}
	if verification["status"] != wantStatus {
		t.Fatalf("evidence verification status = %#v, want %s", verification["status"], wantStatus)
	}
	candidateSnapshot, ok := verification["candidate_snapshot"].(map[string]interface{})
	if !ok || candidateSnapshot["measurement_id"] != float64(candidateID) {
		t.Fatalf("candidate snapshot = %#v, want measurement %d", verification["candidate_snapshot"], candidateID)
	}
	if verification["verified_at"] == nil {
		t.Fatal("terminal verification has no persisted verified_at")
	}
	if wantVerifier {
		gotVerifier, ok := verification["verifying_measurement_id"].(float64)
		if !ok || int64(gotVerifier) != verifierID {
			t.Fatalf("verifying_measurement_id = %#v, want %d", verification["verifying_measurement_id"], verifierID)
		}
		if _, ok := verification["verifying_snapshot"].(map[string]interface{}); !ok {
			t.Fatalf("verifying_snapshot = %#v", verification["verifying_snapshot"])
		}
		return
	}
	if verification["verifying_measurement_id"] != nil || verification["verifying_snapshot"] != nil {
		t.Fatalf("expired verification retained verifier relation: %#v", verification)
	}
	if verification["reason"] != "no eligible subsequent evidence before expiry" {
		t.Fatalf("expired verification reason = %#v", verification["reason"])
	}
}

func createVerificationAPIIntegrationFixture(t *testing.T, db *database.DB) verificationAPIIntegrationFixture {
	t.Helper()
	prefix := fmt.Sprintf("verification-api-%d", time.Now().UnixNano())
	fixture := verificationAPIIntegrationFixture{
		prefix:         prefix,
		organizationID: prefix + "-org",
		providerID:     prefix + "-provider",
		cases: []verificationAPIIntegrationCase{
			{name: "confirmed", wantStatus: measurements.VerificationConfirmed, wantVerifier: true},
			{name: "not-confirmed", wantStatus: measurements.VerificationNotConfirmed, wantVerifier: true},
			{name: "expired", wantStatus: measurements.VerificationExpired, wantVerifier: false},
		},
	}
	now := time.Now().UTC().Truncate(time.Second)
	// The observations below use a fixed historical window. Keep fixture
	// configuration effective before that window so the test does not depend on
	// the wall clock being earlier than the hard-coded observation timestamp.
	validFrom := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
	exec := func(query string, args ...interface{}) {
		t.Helper()
		if _, err := db.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatalf("verification API fixture query failed: %v", err)
		}
	}
	exec(`INSERT INTO organizations(id,school_id,name,district,created_at) VALUES ($1,$2,$3,$4,$5)`, fixture.organizationID, prefix+"-school", "Verification API regression", prefix+"-district", now)
	exec(`INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, fixture.providerID, prefix+" provider", now)
	for index := range fixture.cases {
		fixture.cases[index].lineID = fmt.Sprintf("%s-%s-line", prefix, fixture.cases[index].name)
		fixture.cases[index].pointID = fmt.Sprintf("%s-%s-point", prefix, fixture.cases[index].name)
		fixture.cases[index].deviceID = fmt.Sprintf("%s-%s-device", prefix, fixture.cases[index].name)
		line := fixture.cases[index]
		expires := 86400
		if line.wantStatus == measurements.VerificationExpired {
			expires = 60
		}
		exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, line.lineID, fixture.organizationID, fixture.providerID, now)
		exec(`INSERT INTO monitoring_points(id,line_id,location,is_primary,created_at) VALUES ($1,$2,'integration',TRUE,$3)`, line.pointID, line.lineID, now)
		exec(`INSERT INTO devices(id,monitoring_point_id,auth_token_hash,created_at) VALUES ($1,$2,'integration-test',$3)`, line.deviceID, line.pointID, now)
		exec(`INSERT INTO line_context_versions(line_id,provider_id,technology,role,valid_from,version,reason,changed_by,created_at) VALUES ($1,$2,'FIBER','PRIMARY',$3,1,'verification API fixture','integration-test',$4)`, line.lineID, fixture.providerID, validFrom, now)
		exec(`INSERT INTO threshold_policy_versions(scope_type,scope_id,valid_from,version,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds,created_by,created_at) VALUES ('LINE',$1,$2,1,20,20,100,30,2,99,3,0,NULL,3,0,$3,'integration-test',$4)`, line.lineID, validFrom, expires, now)
	}
	return fixture
}

func cleanupVerificationAPIIntegrationFixture(t *testing.T, db *database.DB, fixture verificationAPIIntegrationFixture) {
	t.Helper()
	pattern := fixture.prefix + "%"
	queries := []string{
		`DELETE FROM audit_events WHERE (object_type='measurement' AND object_id IN (SELECT id::text FROM measurements WHERE line_id LIKE $1)) OR (object_type='measurement_verification' AND object_id IN (SELECT v.id::text FROM measurement_verifications v JOIN measurements m ON m.id=v.candidate_measurement_id WHERE m.line_id LIKE $1)) OR (object_type='incident' AND object_id IN (SELECT id::text FROM incidents WHERE line_id LIKE $1))`,
		`DELETE FROM measurement_verifications WHERE candidate_measurement_id IN (SELECT id FROM measurements WHERE line_id LIKE $1) OR verifying_measurement_id IN (SELECT id FROM measurements WHERE line_id LIKE $1)`,
		`DELETE FROM notifications WHERE source_type='INCIDENT' AND source_id IN (SELECT id::text FROM incidents WHERE line_id LIKE $1)`,
		`DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE line_id LIKE $1)`,
		`DELETE FROM incidents WHERE line_id LIKE $1`,
		`DELETE FROM line_state_events WHERE line_id LIKE $1`,
		`DELETE FROM line_states WHERE line_id LIKE $1`,
		`DELETE FROM measurement_evaluations WHERE measurement_id IN (SELECT id FROM measurements WHERE line_id LIKE $1)`,
		`DELETE FROM measurements WHERE line_id LIKE $1`,
		`DELETE FROM line_context_versions WHERE line_id LIKE $1`,
		`DELETE FROM contract_versions WHERE line_id LIKE $1`,
		`DELETE FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id LIKE $1`,
		`DELETE FROM devices WHERE id LIKE $1`,
		`DELETE FROM monitoring_points WHERE id LIKE $1`,
		`DELETE FROM lines WHERE id LIKE $1`,
		`DELETE FROM providers WHERE id LIKE $1`,
		`DELETE FROM organizations WHERE id LIKE $1`,
	}
	for _, query := range queries {
		if _, err := db.Pool.Exec(context.Background(), query, pattern); err != nil {
			t.Errorf("verification API fixture cleanup failed: %v", err)
		}
	}
}

func floatPointerForVerificationAPI(value float64) *float64 {
	return &value
}
