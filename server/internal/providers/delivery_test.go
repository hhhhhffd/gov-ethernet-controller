package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"strings"
	"sync"
	"testing"
	"time"
)

func testWebhookServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func webhookCase() (ProviderCase, Incident, *Provider) {
	return ProviderCase{ID: 42, TicketNo: "CASE-42", FinalText: "check line", CreatedAt: time.Unix(10, 0).UTC()}, Incident{ID: 7, Number: "INC-7", LineID: "line-1", ViolationType: "NO_INTERNET", StartedAt: time.Unix(9, 0).UTC()}, &Provider{ID: "provider-1", Name: "Test provider"}
}

func requireDeliveryError(t *testing.T, err error) *DeliveryError {
	t.Helper()
	var deliveryErr *DeliveryError
	if !errors.As(err, &deliveryErr) {
		t.Fatalf("expected DeliveryError, got %v", err)
	}
	return deliveryErr
}

func TestSendProviderCaseSetsAuthIdempotencyAndPersistsReference(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_TOKEN", "secret-token")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer secret-token" || r.Header.Get("Idempotency-Key") != "linkwatch-provider-case-42" {
			t.Fatalf("headers/method = %s auth=%q idempotency=%q", r.Method, r.Header.Get("Authorization"), r.Header.Get("Idempotency-Key"))
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"EXT-42"}`)
	}))
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", server.URL)
	item, incident, provider := webhookCase()
	result, err := SendProviderCase(context.Background(), item, incident, provider)
	if err != nil || result.Channel != "WEBHOOK" || result.ExternalID != "EXT-42" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestSendProviderCaseRejectsMissingExternalReference(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_PROVIDER_TRANSPORT", "webhook")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"accepted"}`)
	}))
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", server.URL)
	item, incident, provider := webhookCase()
	_, err := SendProviderCase(context.Background(), item, incident, provider)
	deliveryErr := requireDeliveryError(t, err)
	if deliveryErr.Retryable || !strings.Contains(deliveryErr.Error(), "missing external reference") {
		t.Fatalf("missing reference classification = %+v", deliveryErr)
	}
}

func TestPostJSONClassifiesAuthAndTransientResponses(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    int
		retryable bool
	}{{"unauthorized", http.StatusUnauthorized, false}, {"forbidden", http.StatusForbidden, false}, {"server error", http.StatusBadGateway, true}, {"rate limited", http.StatusTooManyRequests, true}} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("LINKWATCH_ENV", "test")
			t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
			server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "provider detail must not leak", test.status)
			}))
			_, err := postJSON(context.Background(), server.URL, map[string]string{"ok": "true"}, "", "key")
			deliveryErr := requireDeliveryError(t, err)
			if deliveryErr.Retryable != test.retryable || strings.Contains(deliveryErr.Error(), "provider detail") {
				t.Fatalf("classification = %+v", deliveryErr)
			}
		})
	}
}

func TestPostJSONTimeoutIsRetryableAndDoesNotLeakEndpoint(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-time.After(100 * time.Millisecond)
		_, _ = io.WriteString(w, `{"id":"late"}`)
	}))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := postJSON(ctx, server.URL+"?token=secret", map[string]string{"ok": "true"}, "", "key")
	deliveryErr := requireDeliveryError(t, err)
	if !deliveryErr.Retryable || strings.Contains(deliveryErr.Error(), "secret") || strings.Contains(deliveryErr.Error(), "127.0.0.1") {
		t.Fatalf("timeout error leaked or was not retryable: %+v", deliveryErr)
	}
}

func TestPostJSONDuplicateAttemptsCarrySameIdempotencyKey(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	var mu sync.Mutex
	var keys []string
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"external_ticket_no":"EXT-RETRY"}`)
	}))
	for i := 0; i < 2; i++ {
		response, err := postJSON(context.Background(), server.URL, map[string]string{"case": "42"}, "", "linkwatch-provider-case-42")
		if err != nil || responseID(response) != "EXT-RETRY" {
			t.Fatalf("attempt %d response=%v err=%v", i, response, err)
		}
	}
	if len(keys) != 2 || keys[0] != keys[1] || keys[0] != "linkwatch-provider-case-42" {
		t.Fatalf("idempotency keys = %#v", keys)
	}
}

func TestPostJSONReusesIdempotencyKeyAfterAcceptedResponseLoss(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	const idempotencyKey = "linkwatch-provider-case-43"
	var mu sync.Mutex
	calls := 0
	var receivedKeys []string
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		callNumber := calls
		receivedKeys = append(receivedKeys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()

		if callNumber == 1 {
			// The provider has accepted the request, but the client loses the
			// response. A retry must be safe because it carries the same key.
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Errorf("test server does not support connection hijacking")
				return
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack accepted response connection: %v", err)
				return
			}
			_ = connection.Close()
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket_no":"EXT-LOST-43"}`)
	}))
	t.Setenv("LINKWATCH_PROVIDER_WEBHOOK_URL", server.URL)

	_, err := postJSON(context.Background(), server.URL, map[string]string{"case": "43"}, "", idempotencyKey)
	deliveryErr := requireDeliveryError(t, err)
	if !deliveryErr.Retryable {
		t.Fatalf("lost response error = %+v, want retryable", deliveryErr)
	}

	response, err := postJSON(context.Background(), server.URL, map[string]string{"case": "43"}, "", idempotencyKey)
	if err != nil || responseID(response) != "EXT-LOST-43" {
		t.Fatalf("reconciliation response=%v err=%v, want external reference", response, err)
	}

	mu.Lock()
	defer mu.Unlock()
	if calls != 2 || len(receivedKeys) != 2 || receivedKeys[0] != idempotencyKey || receivedKeys[1] != idempotencyKey {
		t.Fatalf("accepted-response-loss calls=%d idempotency keys=%#v", calls, receivedKeys)
	}
}

func TestPostJSONRejectsMalformedSuccessfulResponse(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{not-json"))
	}))
	_, err := postJSON(context.Background(), server.URL, map[string]string{"ok": "true"}, "", "test")
	deliveryErr := requireDeliveryError(t, err)
	if !deliveryErr.Retryable {
		t.Fatalf("malformed upstream response should remain retryable: %+v", deliveryErr)
	}
}

func TestPostJSONRejectsNullSuccessfulResponse(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("null"))
	}))
	_, err := postJSON(context.Background(), server.URL, map[string]string{"ok": "true"}, "", "test")
	deliveryErr := requireDeliveryError(t, err)
	if !deliveryErr.Retryable {
		t.Fatalf("null upstream response should remain retryable: %+v", deliveryErr)
	}
}

func TestSendNotificationTelegramUsesConfiguredSecretAndIdempotency(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_NOTIFICATION_TRANSPORT", "telegram")
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_BOT_TOKEN", "bot-secret")
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_CHAT_ID", "chat-7")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Idempotency-Key") != "linkwatch-notification-17" {
			t.Fatalf("idempotency key = %q", r.Header.Get("Idempotency-Key"))
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["chat_id"] != "chat-7" {
			t.Fatalf("telegram payload = %#v err=%v", payload, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":91}}`)
	}))
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_URL", server.URL)
	result, err := SendNotification(context.Background(), Notification{ID: 17, Message: "line degraded"})
	if err != nil || result.Channel != "TELEGRAM" || result.ExternalID != "91" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestSendNotificationClassifiesTelegramRateLimit(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_NOTIFICATION_TRANSPORT", "telegram")
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_BOT_TOKEN", "secret")
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_CHAT_ID", "chat")
	server := testWebhookServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "provider secret", http.StatusTooManyRequests)
	}))
	t.Setenv("LINKWATCH_NOTIFICATION_TELEGRAM_URL", server.URL)
	_, err := SendNotification(context.Background(), Notification{ID: 18, Message: "test"})
	deliveryErr := requireDeliveryError(t, err)
	if !deliveryErr.Retryable || strings.Contains(deliveryErr.Error(), "provider secret") || strings.Contains(deliveryErr.Error(), "secret") {
		t.Fatalf("telegram rate-limit classification = %+v", deliveryErr)
	}
}

func TestSendNotificationEmailUsesExternalizedDestination(t *testing.T) {
	t.Setenv("LINKWATCH_NOTIFICATION_TRANSPORT", "email")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_SMTP_HOST", "smtp.example.test")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_SMTP_PORT", "587")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_FROM", "alerts@example.test")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_TO", "ops@example.test")
	old := sendMail
	defer func() { sendMail = old }()
	var gotHost, gotFrom, gotTo, gotBody string
	sendMail = func(host string, _ smtp.Auth, from string, to []string, body []byte) error {
		gotHost, gotFrom, gotTo, gotBody = host, from, strings.Join(to, ","), string(body)
		return nil
	}
	result, err := SendNotification(context.Background(), Notification{ID: 19, Message: "incident message"})
	if err != nil || result.Channel != "EMAIL" || gotHost != "smtp.example.test:587" || gotFrom != "alerts@example.test" || gotTo != "ops@example.test" || !strings.Contains(gotBody, "incident message") {
		t.Fatalf("result=%+v host=%q from=%q to=%q body=%q err=%v", result, gotHost, gotFrom, gotTo, gotBody, err)
	}
}

func TestSendNotificationEmailRejectsInvalidDestinationWithoutSecretLeak(t *testing.T) {
	t.Setenv("LINKWATCH_NOTIFICATION_TRANSPORT", "email")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_SMTP_HOST", "smtp.example.test")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_SMTP_PORT", "587")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_FROM", "alerts@example.test")
	t.Setenv("LINKWATCH_NOTIFICATION_EMAIL_TO", "ops@example.test\r\nBcc:secret@example.test")
	_, err := SendNotification(context.Background(), Notification{ID: 20, Message: "test"})
	deliveryErr := requireDeliveryError(t, err)
	if deliveryErr.Retryable || strings.Contains(deliveryErr.Error(), "secret") {
		t.Fatalf("invalid destination classification = %+v", deliveryErr)
	}
}
