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

	"linkwatch/server/internal/database"
)

func TestProviderWorkspaceHTTPStateEvidenceAndRedaction(t *testing.T) {
	db := openProviderWorkspaceIntegrationDB(t)
	t.Cleanup(db.Close)

	fixture := createProviderWorkspaceIntegrationFixture(t, db)
	measurementID := addProviderWorkspaceEvidence(t, db, fixture.lineOnlyCase)

	if _, err := db.Pool.Exec(context.Background(), `UPDATE provider_cases SET status='SENT',delivery_status='SENT',delivery_attempts=1,delivery_retryable=FALSE,ticket_no='CASE-ALREADY-SENT',external_ticket_no='EXT-ALREADY-SENT' WHERE id=$1`, fixture.multipleCase); err != nil {
		t.Fatalf("seed sent provider case: %v", err)
	}

	var transportCalls atomic.Int32
	providerTransport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if transportCalls.Add(1) == 1 {
			http.Error(w, "upstream response contains workspace-webhook-secret", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"EXT-WORKSPACE-1"}`)
	}))
	t.Cleanup(providerTransport.Close)
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", providerTransport.URL)
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_TOKEN", "workspace-webhook-secret")

	application, err := New(db, "")
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)

	assertProviderWorkspaceListState(t, db, server.URL, fixture.allowedToken, fixture.oneEventCase)
	assertProviderWorkspaceListState(t, db, server.URL, fixture.allowedToken, fixture.multipleCase)
	assertProviderWorkspaceListState(t, db, server.URL, fixture.allowedToken, fixture.lineOnlyCase)

	status, body, list := requestProviderWorkspace(t, server.URL, http.MethodGet, "/api/v1/provider-cases?limit=50", fixture.deniedToken, "")
	if status != http.StatusOK {
		t.Fatalf("foreign provider list status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	if count := list["count"]; count != float64(0) {
		t.Fatalf("foreign provider list count = %#v, want 0", count)
	}
	if items, ok := list["items"].([]interface{}); !ok || len(items) != 0 {
		t.Fatalf("foreign provider list leaked cases: %#v", list["items"])
	}

	status, body, detail := requestProviderWorkspace(t, server.URL, http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", fixture.lineOnlyCase), fixture.allowedToken, "")
	if status != http.StatusOK {
		t.Fatalf("line-only detail status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	assertProviderWorkspaceDetailState(t, db, detail, fixture.lineOnlyCase)
	if gate, ok := detail["human_send_gate"].(bool); !ok || !gate {
		t.Fatalf("pending line-only case did not expose human gate: %#v", detail["human_send_gate"])
	}
	if timeline, ok := detail["timeline"].([]interface{}); !ok || len(timeline) != 0 {
		t.Fatalf("line-only case returned synthetic timeline: %#v", detail["timeline"])
	}
	assertProviderWorkspaceEvidence(t, detail, fixture.lineOnlyCase, measurementID)

	status, body, _ = requestProviderWorkspace(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", fixture.lineOnlyCase), fixture.allowedToken, `{"reviewed":false}`)
	if status != http.StatusConflict {
		t.Fatalf("unreviewed send status = %d, want %d; body=%s", status, http.StatusConflict, body)
	}
	if calls := transportCalls.Load(); calls != 0 {
		t.Fatalf("human gate made %d transport calls, want 0", calls)
	}

	status, body, _ = requestProviderWorkspace(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", fixture.lineOnlyCase), fixture.allowedToken, `{"reviewed":true,"final_text":"reviewed workspace text"}`)
	if status != http.StatusBadGateway {
		t.Fatalf("failed send status = %d, want %d; body=%s", status, http.StatusBadGateway, body)
	}
	assertNoProviderSecret(t, body)
	assertProviderWorkspaceListState(t, db, server.URL, fixture.allowedToken, fixture.lineOnlyCase)
	assertProviderWorkspaceDetailState(t, db, mustProviderWorkspaceDetail(t, server.URL, fixture.allowedToken, fixture.lineOnlyCase), fixture.lineOnlyCase)
	failedDetail := mustProviderWorkspaceDetail(t, server.URL, fixture.allowedToken, fixture.lineOnlyCase)
	if errorText := fmt.Sprint(failedDetail["delivery_error"]); errorText != "webhook returned HTTP 502" {
		t.Fatalf("failed detail error = %q, want redacted transport classification", errorText)
	}
	assertNoProviderSecret(t, mustProviderWorkspaceRaw(t, server.URL, http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", fixture.lineOnlyCase), fixture.allowedToken, ""))

	status, body, sent := requestProviderWorkspace(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/retry", fixture.lineOnlyCase), fixture.allowedToken, `{"reviewed":true}`)
	if status != http.StatusOK {
		t.Fatalf("retry status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	if sent["status"] != "SENT" || sent["delivery_status"] != "SENT" {
		t.Fatalf("retry response state = %#v, want SENT/SENT", sent)
	}
	if calls := transportCalls.Load(); calls != 2 {
		t.Fatalf("transport calls after retry = %d, want 2", calls)
	}
	assertProviderWorkspaceListState(t, db, server.URL, fixture.allowedToken, fixture.lineOnlyCase)

	status, body, repeated := requestProviderWorkspace(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", fixture.lineOnlyCase), fixture.allowedToken, `{"reviewed":true}`)
	if status != http.StatusOK {
		t.Fatalf("repeated sent action status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	if repeated["status"] != "SENT" || repeated["delivery_status"] != "SENT" {
		t.Fatalf("repeated sent action changed state: %#v", repeated)
	}
	if calls := transportCalls.Load(); calls != 2 {
		t.Fatalf("repeated sent action made %d transport calls, want 2", calls)
	}
	finalDetail := mustProviderWorkspaceDetail(t, server.URL, fixture.allowedToken, fixture.lineOnlyCase)
	assertProviderWorkspaceDetailState(t, db, finalDetail, fixture.lineOnlyCase)
	if gate, ok := finalDetail["human_send_gate"].(bool); !ok || gate {
		t.Fatalf("sent detail kept human gate enabled: %#v", finalDetail["human_send_gate"])
	}
	assertNoProviderSecret(t, mustProviderWorkspaceRaw(t, server.URL, http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", fixture.lineOnlyCase), fixture.allowedToken, ""))
}

func addProviderWorkspaceEvidence(t *testing.T, db *database.DB, caseID int64) int64 {
	t.Helper()
	ctx := context.Background()
	var lineID string
	if err := db.Pool.QueryRow(ctx, `SELECT COALESCE(c.line_id,i.line_id) FROM provider_cases c LEFT JOIN incidents i ON i.id=c.incident_id WHERE c.id=$1`, caseID).Scan(&lineID); err != nil {
		t.Fatalf("read provider case line for evidence: %v", err)
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	pointID := "provider-workspace-evidence-point-" + suffix
	deviceID := "provider-workspace-evidence-device-" + suffix
	now := time.Now().UTC().Truncate(time.Second)
	var measurementID int64
	t.Cleanup(func() {
		if _, err := db.Pool.Exec(context.Background(), `DELETE FROM measurement_evaluations WHERE measurement_id=$1`, measurementID); err != nil {
			t.Errorf("delete provider evidence evaluation: %v", err)
		}
		if _, err := db.Pool.Exec(context.Background(), `DELETE FROM measurements WHERE id=$1`, measurementID); err != nil {
			t.Errorf("delete provider evidence measurement: %v", err)
		}
		if _, err := db.Pool.Exec(context.Background(), `DELETE FROM devices WHERE id=$1`, deviceID); err != nil {
			t.Errorf("delete provider evidence device: %v", err)
		}
		if _, err := db.Pool.Exec(context.Background(), `DELETE FROM monitoring_points WHERE id=$1`, pointID); err != nil {
			t.Errorf("delete provider evidence point: %v", err)
		}
	})
	if _, err := db.Pool.Exec(ctx, `INSERT INTO monitoring_points(id,line_id,location,is_primary,active,created_at) VALUES ($1,$2,'regression evidence',TRUE,TRUE,$3)`, pointID, lineID, now); err != nil {
		t.Fatalf("insert provider evidence point: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO devices(id,monitoring_point_id,auth_token_hash,created_at) VALUES ($1,$2,'integration-test-hash',$3)`, deviceID, pointID, now); err != nil {
		t.Fatalf("insert provider evidence device: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO measurements(device_id,line_id,monitoring_point_id,client_event_id,observed_at,received_at,mode,download,upload,ping,jitter,packet_loss,availability,connection_status,raw_json,quality) VALUES ($1,$2,$3,$4,$5,$5,'PERFORMANCE',80,40,18,2,0.1,99.9,'OK','{}'::jsonb,'VALID') RETURNING id`, deviceID, lineID, pointID, "provider-workspace-evidence-"+suffix, now).Scan(&measurementID); err != nil {
		t.Fatalf("insert provider evidence measurement: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO measurement_evaluations(measurement_id,baseline_state,contract_state,violations_json,valid,reason,policy_snapshot_json,contract_snapshot_json,line_context_snapshot_json,created_at) VALUES ($1,'OK','MEETS','[]'::jsonb,TRUE,'provider workspace evidence',$2::jsonb,$3::jsonb,$4::jsonb,$5)`, measurementID, `{"version":3,"confirm_count":1,"download_min":50}`, `{"id":9,"contract_no":"C-EVIDENCE"}`, `{"version":2,"line_id":"`+lineID+`"}`, now); err != nil {
		t.Fatalf("insert provider evidence evaluation: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE provider_cases SET evidence_measurement_ids=jsonb_build_array($1::bigint) WHERE id=$2`, measurementID, caseID); err != nil {
		t.Fatalf("link provider evidence: %v", err)
	}
	return measurementID
}

func assertProviderWorkspaceEvidence(t *testing.T, detail map[string]interface{}, caseID, measurementID int64) {
	t.Helper()
	evidence, ok := detail["evidence_chain"].([]interface{})
	if !ok || len(evidence) != 1 {
		t.Errorf("case %d evidence chain = %#v, want one persisted item", caseID, detail["evidence_chain"])
		return
	}
	chain, ok := evidence[0].(map[string]interface{})
	if !ok || chain["status"] != "AVAILABLE" {
		t.Errorf("evidence chain = %#v, want AVAILABLE", evidence[0])
		return
	}
	confirmation, ok := chain["confirmation"].(map[string]interface{})
	if !ok || confirmation["count"] != float64(1) {
		t.Errorf("evidence confirmation = %#v, want one observation", chain["confirmation"])
		return
	}
	observationIDs, ok := confirmation["observation_ids"].([]interface{})
	if !ok || len(observationIDs) != 1 || observationIDs[0] != float64(measurementID) {
		t.Errorf("evidence observation IDs = %#v, want [%d]", confirmation["observation_ids"], measurementID)
		return
	}
	policy, ok := chain["policy"].(map[string]interface{})
	if !ok || policy["version"] != float64(3) {
		t.Errorf("evidence policy snapshot = %#v, want version 3", chain["policy"])
		return
	}
	if links, ok := chain["scoped_links"].([]interface{}); !ok || len(links) != 2 {
		t.Errorf("evidence scoped links = %#v, want both API aliases", chain["scoped_links"])
	}
}

func assertProviderWorkspaceListState(t *testing.T, db *database.DB, baseURL, token string, caseID int64) {
	t.Helper()
	_, _, list := requestProviderWorkspace(t, baseURL, http.MethodGet, "/api/v1/provider-cases?limit=50", token, "")
	item := findProviderWorkspaceItem(t, list, caseID)
	state := readProviderWorkspaceDBState(t, db, caseID)
	for key, want := range map[string]interface{}{"status": state.status, "delivery_status": state.deliveryStatus, "delivery_attempts": float64(state.attempts), "delivery_error": state.deliveryError, "delivery_retryable": state.retryable, "human_send_required": state.status != "SENT"} {
		if item[key] != want {
			t.Fatalf("list case %d %s = %#v, want %#v from PostgreSQL", caseID, key, item[key], want)
		}
	}
}

func assertProviderWorkspaceDetailState(t *testing.T, db *database.DB, detail map[string]interface{}, caseID int64) {
	t.Helper()
	state := readProviderWorkspaceDBState(t, db, caseID)
	for key, want := range map[string]interface{}{"status": state.status, "delivery_status": state.deliveryStatus, "delivery_attempts": float64(state.attempts)} {
		if detail[key] != want {
			t.Fatalf("detail case %d %s = %#v, want %#v from PostgreSQL", caseID, key, detail[key], want)
		}
	}
	if wantGate := state.status != "SENT"; detail["human_send_gate"] != wantGate {
		t.Fatalf("detail case %d human_send_gate = %#v, want %v from PostgreSQL status", caseID, detail["human_send_gate"], wantGate)
	}
}

type providerWorkspaceDBState struct {
	status         string
	deliveryStatus string
	attempts       int
	deliveryError  string
	retryable      bool
}

func readProviderWorkspaceDBState(t *testing.T, db *database.DB, caseID int64) providerWorkspaceDBState {
	t.Helper()
	var state providerWorkspaceDBState
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,delivery_status,delivery_attempts,COALESCE(delivery_error,''),delivery_retryable FROM provider_cases WHERE id=$1`, caseID).Scan(&state.status, &state.deliveryStatus, &state.attempts, &state.deliveryError, &state.retryable); err != nil {
		t.Fatalf("read provider case %d state: %v", caseID, err)
	}
	return state
}

func requestProviderWorkspace(t *testing.T, baseURL string, method string, path string, token string, payload string) (int, string, map[string]interface{}) {
	t.Helper()
	status, raw := performProviderWorkspaceRequest(t, baseURL, method, path, token, payload)
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("decode provider workspace %s %s: %v; body=%s", method, path, err, raw)
	}
	return status, raw, body
}

func mustProviderWorkspaceRaw(t *testing.T, baseURL, method, path, token, payload string) string {
	t.Helper()
	_, body := performProviderWorkspaceRequest(t, baseURL, method, path, token, payload)
	return body
}

func performProviderWorkspaceRequest(t *testing.T, baseURL, method, path, token, payload string) (int, string) {
	t.Helper()
	requestBody := io.Reader(http.NoBody)
	if payload != "" {
		requestBody = strings.NewReader(payload)
	}
	request, err := http.NewRequest(method, baseURL+path, requestBody)
	if err != nil {
		t.Fatalf("create provider workspace request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if payload != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("provider workspace request %s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read provider workspace response %s %s: %v", method, path, err)
	}
	return response.StatusCode, string(body)
}

func findProviderWorkspaceItem(t *testing.T, list map[string]interface{}, caseID int64) map[string]interface{} {
	t.Helper()
	items, ok := list["items"].([]interface{})
	if !ok {
		t.Fatalf("provider workspace items = %#v, want array", list["items"])
	}
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if ok && item["id"] == float64(caseID) {
			return item
		}
	}
	t.Fatalf("provider workspace case %d missing from list: %#v", caseID, list)
	return nil
}

func mustProviderWorkspaceDetail(t *testing.T, baseURL, token string, caseID int64) map[string]interface{} {
	t.Helper()
	status, body, detail := requestProviderWorkspace(t, baseURL, http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", caseID), token, "")
	if status != http.StatusOK {
		t.Fatalf("provider case detail status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	return detail
}

func assertNoProviderSecret(t *testing.T, value string) {
	t.Helper()
	for _, secret := range []string{"workspace-webhook-secret", "upstream response contains"} {
		if strings.Contains(value, secret) {
			t.Fatalf("provider workspace response leaked %q: %s", secret, value)
		}
	}
}
