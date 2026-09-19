package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderCasePermanentFailurePersistsWithoutRetry(t *testing.T) {
	db := openProviderWorkspaceIntegrationDB(t)
	t.Cleanup(db.Close)

	fixture := createProviderWorkspaceIntegrationFixture(t, db)
	providerTransport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "permanent-provider-secret", http.StatusUnauthorized)
	}))
	t.Cleanup(providerTransport.Close)

	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", providerTransport.URL)
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_TOKEN", "permanent-webhook-secret")

	application, err := New(db, "")
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)

	status, body, _ := requestProviderWorkspace(t, server.URL, http.MethodPost, fmt.Sprintf("/api/v1/provider-cases/%d/send", fixture.lineOnlyCase), fixture.allowedToken, `{"reviewed":true,"final_text":"reviewed text"}`)
	if status != http.StatusBadGateway {
		t.Fatalf("permanent provider failure status = %d, want %d; body=%s", status, http.StatusBadGateway, body)
	}
	if strings.Contains(body, "permanent-provider-secret") || strings.Contains(body, "permanent-webhook-secret") {
		t.Fatalf("permanent provider failure leaked secret: %s", body)
	}

	state := readProviderWorkspaceDBState(t, db, fixture.lineOnlyCase)
	if state.status != "FAILED" || state.deliveryStatus != "FAILED" || state.attempts != 1 || state.retryable {
		t.Fatalf("permanent provider state = %#v, want FAILED/FAILED/1/non-retryable", state)
	}
	var hasNextAttempt bool
	if err := db.Pool.QueryRow(context.Background(), `SELECT next_attempt_at IS NOT NULL FROM provider_cases WHERE id=$1`, fixture.lineOnlyCase).Scan(&hasNextAttempt); err != nil {
		t.Fatalf("read permanent provider backoff state: %v", err)
	}
	if hasNextAttempt {
		t.Fatal("permanent provider failure received a retry timestamp")
	}
	var deliveryError string
	if err := db.Pool.QueryRow(context.Background(), `SELECT COALESCE(delivery_error,'') FROM provider_cases WHERE id=$1`, fixture.lineOnlyCase).Scan(&deliveryError); err != nil {
		t.Fatalf("read permanent provider error: %v", err)
	}
	if deliveryError != "webhook returned HTTP 401" || strings.Contains(deliveryError, "secret") {
		t.Fatalf("persisted permanent provider error = %q", deliveryError)
	}
}
