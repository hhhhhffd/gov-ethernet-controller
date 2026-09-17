package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostJSONRejectsMalformedSuccessfulResponse(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{not-json"))
	}))
	defer server.Close()

	_, err := postJSON(context.Background(), server.URL, map[string]string{"ok": "true"}, "", "test")
	var deliveryErr *DeliveryError
	if !errors.As(err, &deliveryErr) {
		t.Fatalf("expected DeliveryError, got %v", err)
	}
	if !deliveryErr.Retryable {
		t.Fatalf("malformed upstream response should remain retryable: %+v", deliveryErr)
	}
}
