package measurements

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"linkwatch/server/internal/database"
	"linkwatch/server/internal/providers"
)

type notificationAcceptanceState struct {
	status          string
	channel         string
	attempts        int
	deliveryError   string
	retryable       bool
	nextAttemptAt   *time.Time
	deliveryStarted *time.Time
	sentAt          *time.Time
}

func TestNotificationOutboxAcceptance(t *testing.T) {
	db := openMeasurementIntegrationDB(t)
	t.Cleanup(db.Close)

	t.Run("successful webhook delivery persists SENT and sent_at", func(t *testing.T) {
		const token = "task-023-local-webhook-secret"
		notificationID := insertNotificationAcceptanceRow(t, db, "success")
		configureNotificationWebhookTest(t, token)

		var mu sync.Mutex
		var calls int
		var idempotencyKeys []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("read webhook request: %v", err)
			}
			mu.Lock()
			calls++
			idempotencyKeys = append(idempotencyKeys, r.Header.Get("Idempotency-Key"))
			mu.Unlock()
			if got := r.Header.Get("Authorization"); got != "Bearer "+token {
				t.Errorf("authorization header = %q, want configured bearer token", got)
			}
			if strings.Contains(string(raw), token) {
				t.Errorf("webhook payload leaked configured token")
			}
			var payload struct {
				Event        string `json:"event"`
				Notification struct {
					ID      int64  `json:"ID"`
					Message string `json:"Message"`
				} `json:"notification"`
			}
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Errorf("decode webhook payload: %v", err)
			} else if payload.Event != "notification.created" || payload.Notification.ID != notificationID || payload.Notification.Message == "" {
				t.Errorf("webhook payload = %#v, want notification %d", payload, notificationID)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"external-notification-success"}`)
		}))
		t.Cleanup(server.Close)
		t.Setenv("LINKWATCH_NOTIFICATION_WEBHOOK_URL", server.URL)

		result, err := (&Service{DB: db}).DispatchNotification(context.Background(), notificationID)
		if err != nil {
			t.Fatalf("dispatch successful notification: %v", err)
		}
		if result.Channel != "WEBHOOK" || result.ExternalID != "external-notification-success" {
			t.Fatalf("delivery result = %+v, want WEBHOOK with external reference", result)
		}
		state := readNotificationAcceptanceState(t, db, notificationID)
		if state.status != "SENT" || state.channel != "WEBHOOK" || state.attempts != 1 || state.sentAt == nil || state.retryable || state.deliveryError != "" || state.nextAttemptAt != nil || state.deliveryStarted != nil {
			t.Fatalf("successful delivery state = %+v", state)
		}
		mu.Lock()
		defer mu.Unlock()
		if calls != 1 || len(idempotencyKeys) != 1 || idempotencyKeys[0] != fmt.Sprintf("linkwatch-notification-%d", notificationID) {
			t.Fatalf("successful delivery calls=%d idempotency_keys=%#v", calls, idempotencyKeys)
		}
	})

	t.Run("retryable failure remains durable and retry succeeds", func(t *testing.T) {
		const token = "task-023-retry-webhook-secret"
		notificationID := insertNotificationAcceptanceRow(t, db, "retry")
		configureNotificationWebhookTest(t, token)

		var mu sync.Mutex
		var calls int
		var idempotencyKeys []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			mu.Lock()
			calls++
			call := calls
			idempotencyKeys = append(idempotencyKeys, r.Header.Get("Idempotency-Key"))
			mu.Unlock()
			if call == 1 {
				http.Error(w, "upstream secret must not be persisted", http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"external-notification-retry"}`)
		}))
		t.Cleanup(server.Close)
		t.Setenv("LINKWATCH_NOTIFICATION_WEBHOOK_URL", server.URL)

		_, err := (&Service{DB: db}).DispatchNotification(context.Background(), notificationID)
		var deliveryErr *providers.DeliveryError
		if !errors.As(err, &deliveryErr) || !deliveryErr.Retryable {
			t.Fatalf("first delivery error = %v, want retryable DeliveryError", err)
		}
		failed := readNotificationAcceptanceState(t, db, notificationID)
		if failed.status != "FAILED" || failed.attempts != 1 || !failed.retryable || failed.nextAttemptAt == nil || failed.deliveryStarted != nil || failed.deliveryError != "webhook returned HTTP 502" {
			t.Fatalf("retryable failure state = %+v", failed)
		}
		if strings.Contains(failed.deliveryError, token) || strings.Contains(failed.deliveryError, "upstream secret") || strings.Contains(failed.deliveryError, server.URL) {
			t.Fatalf("retryable failure leaked transport details: %q", failed.deliveryError)
		}

		if _, err := db.Pool.Exec(context.Background(), `UPDATE notifications SET next_attempt_at=now() - interval '1 second' WHERE id=$1`, notificationID); err != nil {
			t.Fatalf("make retry eligible: %v", err)
		}
		result, err := (&Service{DB: db}).DispatchNotification(context.Background(), notificationID)
		if err != nil {
			t.Fatalf("dispatch retry: %v", err)
		}
		if result.Channel != "WEBHOOK" || result.ExternalID != "external-notification-retry" {
			t.Fatalf("retry delivery result = %+v", result)
		}
		sent := readNotificationAcceptanceState(t, db, notificationID)
		if sent.status != "SENT" || sent.channel != "WEBHOOK" || sent.attempts != 2 || sent.sentAt == nil || sent.retryable || sent.deliveryError != "" || sent.nextAttemptAt != nil || sent.deliveryStarted != nil {
			t.Fatalf("retry success state = %+v", sent)
		}
		mu.Lock()
		defer mu.Unlock()
		wantKey := fmt.Sprintf("linkwatch-notification-%d", notificationID)
		if calls != 2 || len(idempotencyKeys) != 2 || idempotencyKeys[0] != wantKey || idempotencyKeys[1] != wantKey {
			t.Fatalf("retry calls=%d idempotency_keys=%#v, want stable key %q", calls, idempotencyKeys, wantKey)
		}
	})

	t.Run("permanent failure remains visible and non-retryable", func(t *testing.T) {
		const token = "task-023-permanent-webhook-secret"
		notificationID := insertNotificationAcceptanceRow(t, db, "permanent")
		configureNotificationWebhookTest(t, token)

		var calls int
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			http.Error(w, "permanent upstream credential detail", http.StatusUnauthorized)
		}))
		t.Cleanup(server.Close)
		t.Setenv("LINKWATCH_NOTIFICATION_WEBHOOK_URL", server.URL)

		_, err := (&Service{DB: db}).DispatchNotification(context.Background(), notificationID)
		var deliveryErr *providers.DeliveryError
		if !errors.As(err, &deliveryErr) || deliveryErr.Retryable {
			t.Fatalf("permanent delivery error = %v, want non-retryable DeliveryError", err)
		}
		state := readNotificationAcceptanceState(t, db, notificationID)
		if state.status != "FAILED" || state.attempts != 1 || state.retryable || state.nextAttemptAt != nil || state.deliveryStarted != nil || state.sentAt != nil || state.deliveryError != "webhook returned HTTP 401" {
			t.Fatalf("permanent failure state = %+v", state)
		}
		if strings.Contains(state.deliveryError, token) || strings.Contains(state.deliveryError, "permanent upstream credential detail") || strings.Contains(state.deliveryError, server.URL) {
			t.Fatalf("permanent failure leaked transport details: %q", state.deliveryError)
		}
		if calls != 1 {
			t.Fatalf("permanent failure calls = %d, want one", calls)
		}
	})
}

func configureNotificationWebhookTest(t *testing.T, token string) {
	t.Helper()
	t.Setenv("LINKWATCH_ENV", "test")
	t.Setenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK", "1")
	t.Setenv("LINKWATCH_NOTIFICATION_TRANSPORT", "webhook")
	t.Setenv("LINKWATCH_NOTIFICATION_WEBHOOK_TOKEN", token)
	t.Setenv("VKO_NOTIFICATION_TRANSPORT", "")
	t.Setenv("VKO_NOTIFICATION_WEBHOOK_URL", "")
	t.Setenv("VKO_NOTIFICATION_WEBHOOK_TOKEN", "")
}

func insertNotificationAcceptanceRow(t *testing.T, db *database.DB, suffix string) int64 {
	t.Helper()
	sourceID := fmt.Sprintf("task-023-%s-%d", suffix, time.Now().UnixNano())
	var id int64
	if err := db.Pool.QueryRow(context.Background(), `INSERT INTO notifications(source_type,source_id,channel,recipient_scope,message,status,generated_at) VALUES ('TASK-023',$1,'WEB','task-023-scope',$2,'PENDING',$3) RETURNING id`, sourceID, "TASK-023 acceptance notification", time.Now().UTC().Truncate(time.Second)).Scan(&id); err != nil {
		t.Fatalf("insert notification acceptance row: %v", err)
	}
	t.Cleanup(func() {
		if _, err := db.Pool.Exec(context.Background(), `DELETE FROM notifications WHERE id=$1`, id); err != nil {
			t.Errorf("cleanup notification %d: %v", id, err)
		}
	})
	return id
}

func readNotificationAcceptanceState(t *testing.T, db *database.DB, id int64) notificationAcceptanceState {
	t.Helper()
	var state notificationAcceptanceState
	if err := db.Pool.QueryRow(context.Background(), `SELECT status,channel,delivery_attempts,COALESCE(delivery_error,''),delivery_retryable,next_attempt_at,delivery_started_at,sent_at FROM notifications WHERE id=$1`, id).Scan(&state.status, &state.channel, &state.attempts, &state.deliveryError, &state.retryable, &state.nextAttemptAt, &state.deliveryStarted, &state.sentAt); err != nil {
		t.Fatalf("read notification %d state: %v", id, err)
	}
	return state
}
