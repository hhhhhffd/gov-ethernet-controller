package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
	"linkwatch/server/internal/measurements"
)

type providerAIAcceptanceFixture struct {
	prefix         string
	organizationID string
	providerID     string
	lineID         string
	pointID        string
	deviceID       string
	userID         string
	incidentID     int64
	measurementIDs []int64
	providerToken  string
}

func TestProviderAIFailSafeManualFallbackThroughIncidentServicePath(t *testing.T) {
	db := openProviderWorkspaceIntegrationDB(t)
	t.Cleanup(db.Close)
	fixture := createProviderAIAcceptanceFixture(t, db)
	t.Logf("service path created incident=%d evidence_measurement_ids=%v canonical_violation=BASELINE_UPLOAD", fixture.incidentID, fixture.measurementIDs)

	// This is a deterministic outage fixture. It uses the production Ollama
	// adapter pointed at a closed loopback port and never invents AI output.
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	t.Setenv("LINKWATCH_OLLAMA_URL", "http://127.0.0.1:9")
	t.Setenv("LINKWATCH_OLLAMA_MODEL", "task016-unavailable-model")
	t.Setenv("LINKWATCH_OLLAMA_TIMEOUT_SECONDS", "1")
	t.Setenv("LINKWATCH_OLLAMA_MAX_RETRIES", "0")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_TOKEN", "task016-fixture-token")

	var transportCalls atomic.Int32
	var receivedFinalText atomic.Value
	providerTransport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer task016-fixture-token" {
			t.Errorf("provider Authorization = %q, want configured fixture token", got)
		}
		if got := r.Header.Get("Idempotency-Key"); !strings.HasPrefix(got, "linkwatch-provider-case-") {
			t.Errorf("provider idempotency key = %q, want stable provider-case prefix", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read provider request: %v", err)
		} else {
			var payload map[string]interface{}
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("decode provider request: %v", err)
			} else if providerCase, ok := payload["case"].(map[string]interface{}); ok {
				if value, ok := providerCase["text"].(string); ok {
					receivedFinalText.Store(value)
				}
			}
		}
		transportCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"TASK016-TEST-REFERENCE"}`)
	}))
	t.Cleanup(providerTransport.Close)
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", providerTransport.URL)

	application, err := New(db, "")
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)

	createPayload := fmt.Sprintf(`{"incident_id":%d,"comment":"operator note password=task016-comment-password Authorization: Bearer task016-comment-token"}`, fixture.incidentID)
	status, body := requestProviderAIAcceptance(t, server.URL, http.MethodPost, "/api/v1/provider-cases", fixture.providerToken, createPayload)
	if status != http.StatusCreated {
		t.Fatalf("incident ProviderCase creation status = %d, want %d; body=%s", status, http.StatusCreated, body)
	}
	var created struct {
		ID        int64  `json:"id"`
		DraftText string `json:"draft_text"`
		Status    string `json:"status"`
	}
	decodeProviderAIAcceptance(t, body, &created)
	if created.ID <= 0 || created.Status != "DRAFT" || strings.TrimSpace(created.DraftText) == "" {
		t.Fatalf("created ProviderCase = %#v, want editable DRAFT", created)
	}
	t.Logf("manual fallback ProviderCase id=%d status=%s draft_bytes=%d", created.ID, created.Status, len(created.DraftText))
	for _, secret := range []string{"task016-comment-password", "task016-comment-token"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("manual fallback response leaked %q: %s", secret, body)
		}
	}
	if !strings.Contains(created.DraftText, "[REDACTED]") {
		t.Fatalf("manual fallback did not expose its redaction boundary: %q", created.DraftText)
	}

	status, body = requestProviderAIAcceptance(t, server.URL, http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", created.ID), fixture.providerToken, "")
	if status != http.StatusOK {
		t.Fatalf("ProviderCase detail status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	var detail map[string]interface{}
	decodeProviderAIAcceptance(t, body, &detail)
	assertProviderAIAcceptanceEvidence(t, detail, fixture.measurementIDs)
	if gate, ok := detail["human_send_gate"].(bool); !ok || !gate {
		t.Fatalf("ProviderCase detail human_send_gate = %#v, want true", detail["human_send_gate"])
	}

	status, body = requestProviderAIAcceptance(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/ai-draft", created.ID), fixture.providerToken, `{"request_id":"task016-unavailable"}`)
	if status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
		t.Fatalf("unavailable Ollama status = %d, want 502 or 503; body=%s", status, body)
	}
	if strings.Contains(string(body), "task016-unavailable-model") || strings.Contains(string(body), "task016-fixture-token") {
		t.Fatalf("unavailable Ollama response leaked configuration secret: %s", body)
	}
	var generationStatus, failureCategory, failureDetail, evidenceDigest string
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,COALESCE(failure_category,''),COALESCE(error_detail,''),evidence_digest FROM provider_case_draft_generations WHERE provider_case_id=$1 ORDER BY id DESC LIMIT 1`, created.ID).Scan(&generationStatus, &failureCategory, &failureDetail, &evidenceDigest); err != nil {
		t.Fatalf("read failed AI generation: %v", err)
	}
	if generationStatus != "FAILED" || failureCategory != "transport" || evidenceDigest == "" || strings.Contains(failureDetail, "task016-fixture-token") {
		t.Fatalf("failed AI generation = status=%q category=%q detail=%q digest=%q", generationStatus, failureCategory, failureDetail, evidenceDigest)
	}
	t.Logf("real Ollama adapter outage status=%d persisted generation_status=%s failure_category=%s evidence_digest_present=true", status, generationStatus, failureCategory)

	status, body = requestProviderAIAcceptance(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", created.ID), fixture.providerToken, `{"reviewed":false}`)
	if status != http.StatusConflict {
		t.Fatalf("unreviewed send status = %d, want %d; body=%s", status, http.StatusConflict, body)
	}
	if calls := transportCalls.Load(); calls != 0 {
		t.Fatalf("unreviewed send made %d provider calls, want 0", calls)
	}
	assertProviderAIAcceptanceState(t, db, created.ID, "DRAFT", "PENDING", 0, "")
	t.Logf("human gate status=%d transport_calls=%d persisted_state=DRAFT/PENDING", status, transportCalls.Load())

	manualText := "Оператор проверил доказательства и просит устранить подтверждённое отклонение."
	status, body = requestProviderAIAcceptance(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", created.ID), fixture.providerToken, fmt.Sprintf(`{"reviewed":true,"final_text":%q}`, manualText))
	if status != http.StatusOK {
		t.Fatalf("reviewed manual send status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	if calls := transportCalls.Load(); calls != 1 {
		t.Fatalf("reviewed send provider calls = %d, want 1", calls)
	}
	if got := receivedFinalText.Load(); got != manualText {
		t.Fatalf("provider received final text = %#v, want edited manual text", got)
	}
	assertProviderAIAcceptanceState(t, db, created.ID, "SENT", "SENT", 1, manualText)
	assertProviderAIAcceptanceEvidencePersisted(t, db, created.ID, fixture.incidentID, fixture.measurementIDs)
	t.Logf("reviewed manual send status=%d transport_calls=%d persisted_state=SENT/SENT attempts=1 edited_text=true", status, transportCalls.Load())

	var reviewed bool
	if err := db.Pool.QueryRow(context.Background(), `SELECT COALESCE((after_json->>'reviewed')::boolean,FALSE) FROM audit_events WHERE action='provider_case.sent' AND object_id=$1 ORDER BY id DESC LIMIT 1`, fmt.Sprint(created.ID)).Scan(&reviewed); err != nil {
		t.Fatalf("read provider send audit gate: %v", err)
	}
	if !reviewed {
		t.Fatal("successful provider send did not persist reviewed=true audit evidence")
	}
}

func createProviderAIAcceptanceFixture(t *testing.T, db *database.DB) providerAIAcceptanceFixture {
	t.Helper()
	prefix := fmt.Sprintf("task016-ai-%d", time.Now().UnixNano())
	fixture := providerAIAcceptanceFixture{
		prefix:         prefix,
		organizationID: prefix + "-org",
		providerID:     prefix + "-provider",
		lineID:         prefix + "-line",
		pointID:        prefix + "-point",
		deviceID:       prefix + "-device",
		userID:         prefix + "-user",
	}
	now := time.Now().UTC().Truncate(time.Second)
	validFrom := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	exec := func(query string, args ...interface{}) {
		t.Helper()
		if _, err := db.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatalf("TASK-016 fixture query failed: %v", err)
		}
	}
	exec(`INSERT INTO organizations(id,school_id,name,district,created_at) VALUES ($1,$2,$3,$4,$5)`, fixture.organizationID, prefix+"-school", "TASK-016 AI acceptance", prefix+"-district", now)
	exec(`INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, fixture.providerID, "TASK-016 provider", now)
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, fixture.lineID, fixture.organizationID, fixture.providerID, now)
	exec(`INSERT INTO monitoring_points(id,line_id,location,is_primary,active,created_at) VALUES ($1,$2,'TASK-016 acceptance',TRUE,TRUE,$3)`, fixture.pointID, fixture.lineID, now)
	exec(`INSERT INTO devices(id,monitoring_point_id,auth_token_hash,created_at) VALUES ($1,$2,'task016-device-hash',$3)`, fixture.deviceID, fixture.pointID, now)
	exec(`INSERT INTO line_context_versions(line_id,provider_id,technology,role,valid_from,version,reason,changed_by,created_at) VALUES ($1,$2,'FIBER','PRIMARY',$3,1,'TASK-016 acceptance','task016',$4)`, fixture.lineID, fixture.providerID, validFrom, now)
	exec(`INSERT INTO threshold_policy_versions(scope_type,scope_id,valid_from,version,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds,created_by,created_at) VALUES ('LINE',$1,$2,1,20,20,100,30,2,99,3,0,NULL,3,0,86400,'task016',$3)`, fixture.lineID, validFrom, now)
	exec(`INSERT INTO contract_versions(line_id,valid_from,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at) VALUES ($1,$2,$3,$2,NULL,NULL,NULL,NULL,NULL,NULL,'task016',$4)`, fixture.lineID, validFrom, prefix+"-contract", now)
	exec(`INSERT INTO users(id,username,role,token_hash,created_at) VALUES ($1,$2,'PROVIDER',$3,$4)`, fixture.userID, prefix+"-provider-user", auth.TokenHash(prefix+"-legacy-token"), now)
	exec(`INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,'PROVIDER',$2)`, fixture.userID, fixture.providerID)
	token, _, err := auth.IssueSession(context.Background(), db, fixture.userID, time.Hour, "127.0.0.1", "TASK-016 acceptance")
	if err != nil {
		t.Fatalf("issue TASK-016 provider session: %v", err)
	}
	fixture.providerToken = token

	service := &measurements.Service{DB: db}
	base := time.Date(2026, 9, 19, 14, 0, 0, 0, time.UTC)
	for index := 0; index < 3; index++ {
		result, processErr := service.Process(context.Background(), fixture.deviceID, fixture.lineID, fixture.pointID, "task016-agent", measurements.Input{
			ClientEventID:    fmt.Sprintf("%s-measurement-%d", prefix, index+1),
			ObservedAt:       base.Add(time.Duration(index) * time.Minute),
			Mode:             "PERFORMANCE",
			Download:         providerAIFloatPointer(100),
			Upload:           providerAIFloatPointer(1),
			Ping:             providerAIFloatPointer(20),
			Jitter:           providerAIFloatPointer(1),
			PacketLoss:       providerAIFloatPointer(0),
			Availability:     providerAIFloatPointer(100),
			ConnectionStatus: "OK",
			Quality:          "VALID",
		})
		if processErr != nil || !result.Accepted || result.MeasurementID <= 0 {
			t.Fatalf("process TASK-016 measurement %d: result=%#v err=%v", index+1, result, processErr)
		}
		fixture.measurementIDs = append(fixture.measurementIDs, result.MeasurementID)
	}
	for left, right := 0, len(fixture.measurementIDs)-1; left < right; left, right = left+1, right-1 {
		fixture.measurementIDs[left], fixture.measurementIDs[right] = fixture.measurementIDs[right], fixture.measurementIDs[left]
	}
	if err := db.Pool.QueryRow(context.Background(), `SELECT id FROM incidents WHERE line_id=$1 AND status='NEW' ORDER BY id DESC LIMIT 1`, fixture.lineID).Scan(&fixture.incidentID); err != nil {
		t.Fatalf("read service-created TASK-016 incident: %v", err)
	}
	var violation string
	if err := db.Pool.QueryRow(context.Background(), `SELECT violation_type FROM incidents WHERE id=$1`, fixture.incidentID).Scan(&violation); err != nil {
		t.Fatalf("read TASK-016 incident violation: %v", err)
	}
	if violation != "BASELINE_UPLOAD" {
		t.Fatalf("service-created incident violation = %q, want BASELINE_UPLOAD", violation)
	}

	t.Cleanup(func() { cleanupProviderAIAcceptanceFixture(t, db, fixture) })
	return fixture
}

func cleanupProviderAIAcceptanceFixture(t *testing.T, db *database.DB, fixture providerAIAcceptanceFixture) {
	t.Helper()
	ctx := context.Background()
	queries := []struct {
		name  string
		query string
		args  []interface{}
	}{
		{"audit provider/incident/measurement", `DELETE FROM audit_events WHERE (object_type='provider_case' AND object_id IN (SELECT id::text FROM provider_cases WHERE incident_id=$1)) OR (object_type='incident' AND object_id=$2) OR (object_type='measurement' AND object_id IN (SELECT id::text FROM measurements WHERE line_id=$3))`, []interface{}{fixture.incidentID, fmt.Sprint(fixture.incidentID), fixture.lineID}},
		{"draft generations", `DELETE FROM provider_case_draft_generations WHERE provider_case_id IN (SELECT id FROM provider_cases WHERE incident_id=$1)`, []interface{}{fixture.incidentID}},
		{"provider cases", `DELETE FROM provider_cases WHERE incident_id=$1`, []interface{}{fixture.incidentID}},
		{"notifications", `DELETE FROM notifications WHERE source_type='INCIDENT' AND source_id=$1`, []interface{}{fmt.Sprint(fixture.incidentID)}},
		{"incident events", `DELETE FROM incident_events WHERE incident_id=$1`, []interface{}{fixture.incidentID}},
		{"measurement verifications", `DELETE FROM measurement_verifications WHERE candidate_measurement_id IN (SELECT id FROM measurements WHERE line_id=$1) OR verifying_measurement_id IN (SELECT id FROM measurements WHERE line_id=$1)`, []interface{}{fixture.lineID}},
		{"measurement evaluations", `DELETE FROM measurement_evaluations WHERE measurement_id IN (SELECT id FROM measurements WHERE line_id=$1)`, []interface{}{fixture.lineID}},
		{"measurements", `DELETE FROM measurements WHERE line_id=$1`, []interface{}{fixture.lineID}},
		{"line state events", `DELETE FROM line_state_events WHERE line_id=$1`, []interface{}{fixture.lineID}},
		{"line states", `DELETE FROM line_states WHERE line_id=$1`, []interface{}{fixture.lineID}},
		{"incidents", `DELETE FROM incidents WHERE id=$1`, []interface{}{fixture.incidentID}},
		{"auth sessions", `DELETE FROM auth_sessions WHERE user_id=$1`, []interface{}{fixture.userID}},
		{"role scopes", `DELETE FROM role_scopes WHERE user_id=$1`, []interface{}{fixture.userID}},
		{"users", `DELETE FROM users WHERE id=$1`, []interface{}{fixture.userID}},
		{"line context", `DELETE FROM line_context_versions WHERE line_id=$1`, []interface{}{fixture.lineID}},
		{"contracts", `DELETE FROM contract_versions WHERE line_id=$1`, []interface{}{fixture.lineID}},
		{"policy", `DELETE FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1`, []interface{}{fixture.lineID}},
		{"devices", `DELETE FROM devices WHERE id=$1`, []interface{}{fixture.deviceID}},
		{"monitoring points", `DELETE FROM monitoring_points WHERE id=$1`, []interface{}{fixture.pointID}},
		{"lines", `DELETE FROM lines WHERE id=$1`, []interface{}{fixture.lineID}},
		{"providers", `DELETE FROM providers WHERE id=$1`, []interface{}{fixture.providerID}},
		{"organizations", `DELETE FROM organizations WHERE id=$1`, []interface{}{fixture.organizationID}},
	}
	for _, item := range queries {
		if _, err := db.Pool.Exec(ctx, item.query, item.args...); err != nil {
			t.Errorf("cleanup %s failed: %v", item.name, err)
		}
	}
}

func assertProviderAIAcceptanceEvidence(t *testing.T, detail map[string]interface{}, wantIDs []int64) {
	t.Helper()
	evidence, ok := detail["evidence_chain"].([]interface{})
	if !ok || len(evidence) != len(wantIDs) {
		t.Fatalf("ProviderCase evidence chain = %#v, want %d items", detail["evidence_chain"], len(wantIDs))
	}
	gotIDs := make([]int64, 0, len(evidence))
	for _, raw := range evidence {
		item, ok := raw.(map[string]interface{})
		if !ok || item["status"] != "AVAILABLE" {
			t.Fatalf("ProviderCase evidence item = %#v, want AVAILABLE", raw)
		}
		confirmation, ok := item["confirmation"].(map[string]interface{})
		if !ok {
			t.Fatalf("ProviderCase evidence confirmation = %#v", item["confirmation"])
		}
		observationIDs, ok := confirmation["observation_ids"].([]interface{})
		if !ok || len(observationIDs) != 1 {
			t.Fatalf("ProviderCase evidence observation IDs = %#v", confirmation["observation_ids"])
		}
		id, ok := observationIDs[0].(float64)
		if !ok {
			t.Fatalf("ProviderCase evidence observation ID = %#v", observationIDs[0])
		}
		gotIDs = append(gotIDs, int64(id))
	}
	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("ProviderCase evidence IDs = %#v, want %#v", gotIDs, wantIDs)
	}
	for index := range wantIDs {
		if gotIDs[index] != wantIDs[index] {
			t.Fatalf("ProviderCase evidence IDs = %#v, want %#v", gotIDs, wantIDs)
		}
	}
	if incident, ok := detail["incident"].(map[string]interface{}); !ok || incident["violation_type"] != "BASELINE_UPLOAD" {
		t.Fatalf("ProviderCase incident projection = %#v, want canonical BASELINE_UPLOAD", detail["incident"])
	}
}

func assertProviderAIAcceptanceEvidencePersisted(t *testing.T, db *database.DB, caseID, incidentID int64, wantIDs []int64) {
	t.Helper()
	var stored []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT evidence_measurement_ids FROM provider_cases WHERE id=$1 AND incident_id=$2`, caseID, incidentID).Scan(&stored); err != nil {
		t.Fatalf("read persisted ProviderCase evidence IDs: %v", err)
	}
	var got []int64
	if err := json.Unmarshal(stored, &got); err != nil {
		t.Fatalf("decode persisted ProviderCase evidence IDs: %v", err)
	}
	if len(got) != len(wantIDs) {
		t.Fatalf("persisted ProviderCase evidence IDs = %#v, want %#v", got, wantIDs)
	}
	for index := range wantIDs {
		if got[index] != wantIDs[index] {
			t.Fatalf("persisted ProviderCase evidence IDs = %#v, want %#v", got, wantIDs)
		}
	}
	var violation string
	var opening []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT violation_type,opening_snapshot_json FROM incidents WHERE id=$1`, incidentID).Scan(&violation, &opening); err != nil {
		t.Fatalf("read canonical incident after provider send: %v", err)
	}
	if violation != "BASELINE_UPLOAD" {
		t.Fatalf("provider send changed canonical incident violation to %q", violation)
	}
	var snapshot map[string]interface{}
	if err := json.Unmarshal(opening, &snapshot); err != nil {
		t.Fatalf("decode canonical incident snapshot after provider send: %v", err)
	}
	encodedIDs, ok := snapshot["evidence_measurement_ids"].([]interface{})
	if !ok || len(encodedIDs) != len(wantIDs) {
		t.Fatalf("canonical incident evidence IDs after provider send = %#v, want %#v", snapshot["evidence_measurement_ids"], wantIDs)
	}
	for index, raw := range encodedIDs {
		value, ok := raw.(float64)
		if !ok || int64(value) != wantIDs[index] {
			t.Fatalf("canonical incident evidence IDs after provider send = %#v, want %#v", snapshot["evidence_measurement_ids"], wantIDs)
		}
	}
}

func assertProviderAIAcceptanceState(t *testing.T, db *database.DB, caseID int64, wantStatus, wantDelivery string, wantAttempts int, wantFinal string) {
	t.Helper()
	var status, delivery string
	var attempts int
	var final *string
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,delivery_status,delivery_attempts,final_text FROM provider_cases WHERE id=$1`, caseID).Scan(&status, &delivery, &attempts, &final); err != nil {
		t.Fatalf("read ProviderCase state: %v", err)
	}
	gotFinal := ""
	if final != nil {
		gotFinal = *final
	}
	if status != wantStatus || delivery != wantDelivery || attempts != wantAttempts || gotFinal != wantFinal {
		t.Fatalf("ProviderCase state = %q/%q/%d/%q, want %q/%q/%d/%q", status, delivery, attempts, gotFinal, wantStatus, wantDelivery, wantAttempts, wantFinal)
	}
}

func requestProviderAIAcceptance(t *testing.T, baseURL string, method string, path string, token string, payload string) (int, []byte) {
	t.Helper()
	var body io.Reader
	if payload != "" {
		body = strings.NewReader(payload)
	}
	request, err := http.NewRequest(method, baseURL+path, body)
	if err != nil {
		t.Fatalf("build TASK-016 request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if payload != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("run TASK-016 request: %v", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read TASK-016 response: %v", err)
	}
	return response.StatusCode, responseBody
}

func decodeProviderAIAcceptance(t *testing.T, body []byte, target interface{}) {
	t.Helper()
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("decode TASK-016 JSON response: %v; body=%s", err, body)
	}
}

func providerAIFloatPointer(value float64) *float64 { return &value }
