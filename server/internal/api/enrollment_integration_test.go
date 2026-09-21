package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
)

func TestAgentEnrollmentFlow(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	db := openAdminMatrixDB(t)
	t.Cleanup(db.Close)
	fixture := createAdminMatrixFixture(t, db)

	created := createEnrollmentCode(t, fixture, fixture.pointID)
	code := responseString(t, created, "code")
	if strings.Contains(code, " ") || !strings.Contains(code, "-") {
		t.Fatalf("enrollment code format = %q, want grouped code", code)
	}
	var codeHash string
	if err := db.Pool.QueryRow(context.Background(), `SELECT code_hash FROM agent_enrollment_codes WHERE monitoring_point_id=$1 ORDER BY id DESC LIMIT 1`, fixture.pointID).Scan(&codeHash); err != nil {
		t.Fatalf("read enrollment code hash: %v", err)
	}
	if codeHash != auth.TokenHash(normalizeEnrollmentCode(code)) || strings.Contains(codeHash, code) {
		t.Fatalf("stored enrollment code is not only a digest: %q", codeHash)
	}

	status, enrolled := enrollAgent(t, fixture.server, "/api/v1/agent/enroll", code, "SCHOOL-PC-01", "0.1.0-test")
	if status != http.StatusCreated {
		t.Fatalf("enroll status = %d, want %d; body=%v", status, http.StatusCreated, enrolled)
	}
	deviceID := responseString(t, enrolled, "device_id")
	deviceToken := responseString(t, enrolled, "device_token")
	var pointID, lineID, organizationID, schoolID, tokenHash string
	if err := db.Pool.QueryRow(context.Background(), `SELECT d.monitoring_point_id,mp.line_id,l.organization_id,o.school_id,d.auth_token_hash FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id JOIN lines l ON l.id=mp.line_id JOIN organizations o ON o.id=l.organization_id WHERE d.id=$1`, deviceID).Scan(&pointID, &lineID, &organizationID, &schoolID, &tokenHash); err != nil {
		t.Fatalf("read enrolled device: %v", err)
	}
	if pointID != fixture.pointID || lineID != fixture.lineID || organizationID != fixture.organizationID || schoolID != fixture.prefix+" School" {
		t.Fatalf("enrolled device scope = point=%q line=%q organization=%q school=%q", pointID, lineID, organizationID, schoolID)
	}
	if tokenHash != auth.TokenHash(deviceToken) {
		t.Fatal("device token was not persisted as a hash")
	}
	if _, err := auth.AuthenticateDevice(context.Background(), db, deviceID, deviceToken); err != nil {
		t.Fatalf("enrolled device cannot authenticate: %v", err)
	}
	status, heartbeat := enrolledAgentRequest(t, fixture.server, "/api/v1/agent/heartbeat", deviceID, deviceToken, map[string]interface{}{"agent_version": "0.1.0-test", "hostname": "SCHOOL-PC-01", "boot_id": "enrollment-test-boot", "boot_started_at": time.Now().UTC().Format(time.RFC3339), "uptime_seconds": 1})
	if status != http.StatusOK || heartbeat["device_id"] != deviceID {
		t.Fatalf("enrolled heartbeat = %d %#v, want enrolled device response", status, heartbeat)
	}
	status, batch := enrolledAgentRequest(t, fixture.server, "/api/agent/measurements:batch", deviceID, deviceToken, map[string]interface{}{"measurements": []map[string]interface{}{{"client_event_id": "enrollment-measurement-" + fixture.prefix, "observed_at": time.Now().UTC().Format(time.RFC3339), "mode": "LIGHT", "availability": 100, "connection_status": "OK", "quality": "VALID", "raw": map[string]interface{}{}}}})
	if status != http.StatusOK || batch["accepted"] != float64(1) {
		t.Fatalf("enrolled measurement batch = %d %#v, want accepted observation", status, batch)
	}
	assertEnrollmentAuditDoesNotContain(t, db, "agent.enrolled", "device", deviceID, code, deviceToken)

	status, reused := enrollAgent(t, fixture.server, "/api/agent/enroll", code, "SCHOOL-PC-02", "0.1.0-test")
	assertGenericEnrollmentFailure(t, status, reused)

	expired := createEnrollmentCode(t, fixture, fixture.pointID)
	expiredCode := responseString(t, expired, "code")
	if _, err := db.Pool.Exec(context.Background(), `UPDATE agent_enrollment_codes SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE code_hash=$1`, auth.TokenHash(normalizeEnrollmentCode(expiredCode))); err != nil {
		t.Fatalf("expire enrollment code: %v", err)
	}
	status, expiredResponse := enrollAgent(t, fixture.server, "/api/v1/agent/enroll", expiredCode, "SCHOOL-PC-03", "0.1.0-test")
	assertGenericEnrollmentFailure(t, status, expiredResponse)
}

func TestAgentEnrollmentConcurrentUseCreatesOneDevice(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	db := openAdminMatrixDB(t)
	t.Cleanup(db.Close)
	fixture := createAdminMatrixFixture(t, db)
	code := responseString(t, createEnrollmentCode(t, fixture, fixture.pointID), "code")

	statuses := make(chan int, 2)
	var group sync.WaitGroup
	for index := 0; index < 2; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			status, _ := enrollAgent(t, fixture.server, "/api/v1/agent/enroll", code, "SCHOOL-PC-CONCURRENT", "0.1.0-test")
			statuses <- status
		}(index)
	}
	group.Wait()
	close(statuses)
	created, rejected := 0, 0
	for status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusUnauthorized:
			rejected++
		default:
			t.Fatalf("concurrent enroll status = %d", status)
		}
	}
	if created != 1 || rejected != 1 {
		t.Fatalf("concurrent enroll results = created=%d rejected=%d, want 1/1", created, rejected)
	}
	var usedDeviceID *string
	if err := db.Pool.QueryRow(context.Background(), `SELECT used_device_id FROM agent_enrollment_codes WHERE code_hash=$1`, auth.TokenHash(normalizeEnrollmentCode(code))).Scan(&usedDeviceID); err != nil {
		t.Fatalf("read consumed enrollment code: %v", err)
	}
	if usedDeviceID == nil || strings.TrimSpace(*usedDeviceID) == "" {
		t.Fatal("concurrent enrollment code was not atomically consumed")
	}
	var devices int
	if err := db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM devices WHERE id=$1`, *usedDeviceID).Scan(&devices); err != nil || devices != 1 {
		t.Fatalf("consumed code device count = %d, err=%v; want one", devices, err)
	}
}

func createEnrollmentCode(t *testing.T, fixture adminMatrixFixture, pointID string) map[string]interface{} {
	t.Helper()
	status, body := adminMatrixRequest(t, fixture.server, fixture.adminToken, http.MethodPost, "/api/v1/admin/enrollment-codes", map[string]string{"monitoring_point_id": pointID})
	if status != http.StatusCreated {
		t.Fatalf("create enrollment code status = %d, want %d; body=%v", status, http.StatusCreated, body)
	}
	return body
}

func enrollAgent(t *testing.T, server *Server, path, code, hostname, version string) (int, map[string]interface{}) {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"code": code, "hostname": hostname, "agent_version": version})
	if err != nil {
		t.Fatalf("marshal enrollment request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "198.51.100.50:4100"
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode enrollment response: %v; body=%s", err, recorder.Body.String())
	}
	return recorder.Code, body
}

func enrolledAgentRequest(t *testing.T, server *Server, path, deviceID, token string, payload interface{}) (int, map[string]interface{}) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal enrolled agent request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Device-ID", deviceID)
	request.Header.Set("X-Device-Token", token)
	request.RemoteAddr = "198.51.100.50:4101"
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode enrolled agent response: %v; body=%s", err, recorder.Body.String())
	}
	return recorder.Code, body
}

func assertGenericEnrollmentFailure(t *testing.T, status int, body map[string]interface{}) {
	t.Helper()
	if status != http.StatusUnauthorized || body["error"] != errInvalidEnrollmentCode.Error() || body["detail"] != errInvalidEnrollmentCode.Error() {
		t.Fatalf("enrollment failure = %d %#v, want generic invalid-code error", status, body)
	}
}

func assertEnrollmentAuditDoesNotContain(t *testing.T, db *database.DB, action, objectType, objectID, code, token string) {
	t.Helper()
	var snapshot []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT after_json FROM audit_events WHERE action=$1 AND object_type=$2 AND object_id=$3 ORDER BY id DESC LIMIT 1`, action, objectType, objectID).Scan(&snapshot); err != nil {
		t.Fatalf("read enrollment audit: %v", err)
	}
	if strings.Contains(string(snapshot), code) || strings.Contains(string(snapshot), token) {
		t.Fatalf("enrollment audit leaked a secret: %s", snapshot)
	}
}
