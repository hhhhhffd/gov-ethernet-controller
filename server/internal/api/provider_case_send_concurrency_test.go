package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"linkwatch/server/internal/database"
)

type providerCaseSendResponse struct {
	status int
	body   string
	err    error
}

type providerCaseConcurrencyFixture struct {
	organizationID string
	providerID     string
	lineID         string
	incidentID     int64
	caseID         int64
}

func TestProviderCaseConcurrentSendClaimsSingleExternalDelivery(t *testing.T) {
	dsn := os.Getenv("LINKWATCH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run the PostgreSQL provider send integration test")
	}

	ctx := context.Background()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	t.Cleanup(db.Close)

	fixture := createProviderCaseConcurrencyFixture(t, db)
	t.Cleanup(func() { deleteProviderCaseConcurrencyFixture(t, db, fixture) })

	var externalCalls atomic.Int64
	firstCallStarted := make(chan struct{})
	releaseFirstCall := make(chan struct{})
	providerTransport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callNumber := externalCalls.Add(1)
		if callNumber == 1 {
			close(firstCallStarted)
			<-releaseFirstCall
		}
		if r.Method != http.MethodPost {
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"EXT-CONCURRENT"}`)
	}))
	t.Cleanup(providerTransport.Close)

	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "1")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", providerTransport.URL)

	application, err := New(db, t.TempDir())
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)

	withoutReview := sendProviderCaseRequest(t, server.URL, fixture.caseID, `{"reviewed":false}`)
	if withoutReview.status != http.StatusConflict {
		t.Fatalf("unreviewed send status = %d, body=%s; want %d", withoutReview.status, withoutReview.body, http.StatusConflict)
	}
	if externalCalls.Load() != 0 {
		t.Fatalf("unreviewed send made %d external calls, want 0", externalCalls.Load())
	}
	assertProviderCaseState(t, db, fixture.caseID, "DRAFT", "PENDING", 0, "", 0)

	start := make(chan struct{})
	responses := make(chan providerCaseSendResponse, 2)
	for range 2 {
		go func() {
			<-start
			responses <- sendProviderCaseRequest(t, server.URL, fixture.caseID, `{"reviewed":true,"final_text":"reviewed text"}`)
		}()
	}
	close(start)

	select {
	case <-firstCallStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("no external provider call started")
	}

	// A duplicate-delivery race reaches the transport while the first call is
	// deliberately blocked. A correct claim may leave this at one until the
	// first call is released.
	if waitForProviderCall(externalCalls, 2, 250*time.Millisecond) {
		t.Log("concurrent requests reached the transport twice before the first call was released")
	}
	close(releaseFirstCall)

	statuses := make([]int, 0, 2)
	for range 2 {
		response := <-responses
		if response.err != nil {
			t.Fatalf("concurrent send request failed: %v", response.err)
		}
		statuses = append(statuses, response.status)
	}

	if got := externalCalls.Load(); got != 1 {
		t.Fatalf("external provider calls = %d, want 1; HTTP statuses = %v", got, statuses)
	}
	if countStatus(statuses, http.StatusOK) != 1 || countStatus(statuses, http.StatusConflict) != 1 {
		t.Fatalf("concurrent send statuses = %v, want one 200 and one 409", statuses)
	}
	assertProviderCaseState(t, db, fixture.caseID, "SENT", "SENT", 1, "EXT-CONCURRENT", 1)
}

func TestProviderCaseConcurrentFailureKeepsRetryAvailable(t *testing.T) {
	dsn := os.Getenv("LINKWATCH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run the PostgreSQL provider send integration test")
	}

	db, err := database.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	t.Cleanup(db.Close)
	fixture := createProviderCaseConcurrencyFixture(t, db)
	t.Cleanup(func() { deleteProviderCaseConcurrencyFixture(t, db, fixture) })

	var externalCalls atomic.Int64
	firstCallStarted := make(chan struct{})
	releaseFirstCall := make(chan struct{})
	providerTransport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callNumber := externalCalls.Add(1)
		if callNumber == 1 {
			close(firstCallStarted)
			<-releaseFirstCall
			http.Error(w, "provider unavailable", http.StatusBadGateway)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"EXT-RETRY"}`)
	}))
	t.Cleanup(providerTransport.Close)

	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "1")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", providerTransport.URL)

	application, err := New(db, t.TempDir())
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)

	start := make(chan struct{})
	responses := make(chan providerCaseSendResponse, 2)
	for range 2 {
		go func() {
			<-start
			responses <- sendProviderCaseRequest(t, server.URL, fixture.caseID, `{"reviewed":true,"final_text":"reviewed text"}`)
		}()
	}
	close(start)

	select {
	case <-firstCallStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("no external provider call started")
	}
	if waitForProviderCall(externalCalls, 2, 250*time.Millisecond) {
		t.Log("concurrent requests reached the transport twice before the first call was released")
	}
	close(releaseFirstCall)

	statuses := make([]int, 0, 2)
	for range 2 {
		response := <-responses
		if response.err != nil {
			t.Fatalf("concurrent send request failed: %v", response.err)
		}
		statuses = append(statuses, response.status)
	}
	if externalCalls.Load() != 1 {
		t.Fatalf("external provider calls before retry = %d, want 1; HTTP statuses = %v", externalCalls.Load(), statuses)
	}
	if countStatus(statuses, http.StatusBadGateway) != 1 || countStatus(statuses, http.StatusConflict) != 1 {
		t.Fatalf("concurrent failure statuses = %v, want one 502 and one 409", statuses)
	}
	assertProviderCaseFailureState(t, db, fixture.caseID)

	retry := sendProviderCaseRequestPath(t, server.URL, fixture.caseID, "retry", `{"reviewed":true}`)
	if retry.err != nil || retry.status != http.StatusOK {
		t.Fatalf("retry status=%d body=%s err=%v, want 200", retry.status, retry.body, retry.err)
	}
	if externalCalls.Load() != 2 {
		t.Fatalf("external provider calls after retry = %d, want 2", externalCalls.Load())
	}
	assertProviderCaseState(t, db, fixture.caseID, "SENT", "SENT", 2, "EXT-RETRY", 1)
}

func waitForProviderCall(calls atomic.Int64, want int64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for calls.Load() < want && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	return calls.Load() >= want
}

func sendProviderCaseRequest(t *testing.T, baseURL string, caseID int64, payload string) providerCaseSendResponse {
	return sendProviderCaseRequestPath(t, baseURL, caseID, "send", payload)
}

func sendProviderCaseRequestPath(t *testing.T, baseURL string, caseID int64, action, payload string) providerCaseSendResponse {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/provider-cases/%d/%s", baseURL, caseID, action), strings.NewReader(payload))
	if err != nil {
		return providerCaseSendResponse{err: fmt.Errorf("create provider send request: %w", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return providerCaseSendResponse{err: fmt.Errorf("send provider case request: %w", err)}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return providerCaseSendResponse{err: fmt.Errorf("read provider send response: %w", err)}
	}
	return providerCaseSendResponse{status: response.StatusCode, body: string(body)}
}

func createProviderCaseConcurrencyFixture(t *testing.T, db *database.DB) providerCaseConcurrencyFixture {
	t.Helper()
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	fixture := providerCaseConcurrencyFixture{
		organizationID: "provider-send-concurrency-org-" + suffix,
		providerID:     "provider-send-concurrency-provider-" + suffix,
		lineID:         "provider-send-concurrency-line-" + suffix,
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := db.Pool.Exec(ctx, `INSERT INTO organizations(id,school_id,name,district,created_at) VALUES ($1,$2,$3,$4,$5)`, fixture.organizationID, fixture.organizationID, "Provider send concurrency test", "test", now); err != nil {
		t.Fatalf("insert provider send test organization: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, fixture.providerID, fixture.providerID, now); err != nil {
		t.Fatalf("insert provider send test provider: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO lines(id,organization_id,provider_id,role,created_at) VALUES ($1,$2,$3,'PRIMARY',$4)`, fixture.lineID, fixture.organizationID, fixture.providerID, now); err != nil {
		t.Fatalf("insert provider send test line: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO incidents(incident_no,line_id,source,violation_type,status,started_at,created_at) VALUES ($1,$2,'MANUAL','LINE_REVIEW','NEW',$3,$3) RETURNING id`, "PROVIDER-SEND-CONCURRENCY-"+suffix, fixture.lineID, now).Scan(&fixture.incidentID); err != nil {
		t.Fatalf("insert provider send test incident: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO provider_cases(incident_id,draft_text,status,delivery_status,created_by,created_at) VALUES ($1,'draft text','DRAFT','PENDING','integration-test',$2) RETURNING id`, fixture.incidentID, now).Scan(&fixture.caseID); err != nil {
		t.Fatalf("insert provider send test case: %v", err)
	}
	return fixture
}

func deleteProviderCaseConcurrencyFixture(t *testing.T, db *database.DB, fixture providerCaseConcurrencyFixture) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.Pool.Exec(ctx, `DELETE FROM provider_cases WHERE id=$1`, fixture.caseID); err != nil {
		t.Errorf("delete provider send test case: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM incident_events WHERE incident_id=$1`, fixture.incidentID); err != nil {
		t.Errorf("delete provider send test events: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM incidents WHERE id=$1`, fixture.incidentID); err != nil {
		t.Errorf("delete provider send test incident: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM lines WHERE id=$1`, fixture.lineID); err != nil {
		t.Errorf("delete provider send test line: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM providers WHERE id=$1`, fixture.providerID); err != nil {
		t.Errorf("delete provider send test provider: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM organizations WHERE id=$1`, fixture.organizationID); err != nil {
		t.Errorf("delete provider send test organization: %v", err)
	}
}

func assertProviderCaseState(t *testing.T, db *database.DB, caseID int64, wantStatus, wantDelivery string, wantAttempts int, wantExternal string, wantEvents int) {
	t.Helper()
	var status, delivery, external string
	var attempts, events int
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,delivery_status,delivery_attempts,COALESCE(external_ticket_no,''), (SELECT COUNT(*) FROM incident_events e JOIN provider_cases c ON c.incident_id=e.incident_id WHERE c.id=$1 AND e.event_type='PROVIDER_CASE_SENT') FROM provider_cases WHERE id=$1`, caseID).Scan(&status, &delivery, &attempts, &external, &events); err != nil {
		t.Fatalf("read provider send state: %v", err)
	}
	if status != wantStatus || delivery != wantDelivery || attempts != wantAttempts || external != wantExternal || events != wantEvents {
		t.Fatalf("provider case state = %s|%s|%d|%q|events=%d, want %s|%s|%d|%q|events=%d", status, delivery, attempts, external, events, wantStatus, wantDelivery, wantAttempts, wantExternal, wantEvents)
	}
}

func assertProviderCaseFailureState(t *testing.T, db *database.DB, caseID int64) {
	t.Helper()
	var status, delivery, deliveryError string
	var attempts, failures int
	var retryable, hasNextAttempt bool
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,delivery_status,delivery_attempts,COALESCE(delivery_error,''),delivery_retryable,next_attempt_at IS NOT NULL,(SELECT COUNT(*) FROM incident_events e JOIN provider_cases c ON c.incident_id=e.incident_id WHERE c.id=$1 AND e.event_type='PROVIDER_CASE_DELIVERY_FAILED') FROM provider_cases WHERE id=$1`, caseID).Scan(&status, &delivery, &attempts, &deliveryError, &retryable, &hasNextAttempt, &failures); err != nil {
		t.Fatalf("read provider send failure state: %v", err)
	}
	if status != "FAILED" || delivery != "FAILED" || attempts != 1 || deliveryError == "" || !retryable || !hasNextAttempt || failures != 1 {
		t.Fatalf("provider case failure state = %s|%s|%d|%q|retryable=%t|next=%t|failure_events=%d, want FAILED|FAILED|1|error|retryable=true|next=true|failure_events=1", status, delivery, attempts, deliveryError, retryable, hasNextAttempt, failures)
	}
}

func countStatus(statuses []int, want int) int {
	count := 0
	for _, status := range statuses {
		if status == want {
			count++
		}
	}
	return count
}
