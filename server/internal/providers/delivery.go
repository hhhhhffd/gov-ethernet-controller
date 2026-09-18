// Package providers contains the bounded outbound adapters used by provider
// cases and web notifications.  The adapters never decide workflow state;
// callers persist the attempt and its result in PostgreSQL.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type DeliveryError struct {
	Message   string
	Retryable bool
}

func (e *DeliveryError) Error() string { return e.Message }

type Result struct {
	Channel    string
	ExternalID string
	Detail     string
}

type ProviderCase struct {
	ID        int64
	TicketNo  string
	FinalText string
	DraftText string
	CreatedAt time.Time
}

type Incident struct {
	ID            int64
	Number        string
	LineID        string
	ViolationType string
	StartedAt     time.Time
	Opening       interface{}
}

type Provider struct {
	ID      string
	Name    string
	Contact string
}

func SendProviderCase(ctx context.Context, item ProviderCase, incident Incident, provider *Provider) (Result, error) {
	mode := strings.ToLower(strings.TrimSpace(envOr("LINKWATCH_PROVIDER_TRANSPORT", "VKO_PROVIDER_TRANSPORT")))
	if mode == "" {
		mode = "internal"
		if strings.EqualFold(os.Getenv("LINKWATCH_ENV"), "production") || strings.EqualFold(os.Getenv("VKO_ENV"), "production") {
			mode = "webhook"
		}
	}
	switch mode {
	case "internal", "web":
		if isProduction() {
			return Result{}, &DeliveryError{Message: "internal provider transport is disabled in production", Retryable: false}
		}
		return Result{Channel: "INTERNAL", Detail: "recorded in LINKWATCH"}, nil
	case "webhook":
		endpoint := strings.TrimSpace(envOr("LINKWATCH_PROVIDER_WEBHOOK_URL", "VKO_PROVIDER_WEBHOOK_URL"))
		if endpoint == "" && provider != nil && strings.HasPrefix(provider.Contact, "http") {
			endpoint = provider.Contact
		}
		if endpoint == "" {
			return Result{}, &DeliveryError{Message: "provider webhook endpoint is not configured", Retryable: true}
		}
		payload := map[string]interface{}{
			"event": "provider_case.created",
			"case":  map[string]interface{}{"id": item.ID, "ticket_no": item.TicketNo, "text": first(item.FinalText, item.DraftText), "created_at": item.CreatedAt},
		}
		if incident.ID == 0 {
			payload["line"] = map[string]interface{}{"line_id": incident.LineID, "violation_type": incident.ViolationType, "started_at": incident.StartedAt, "evidence_snapshot": incident.Opening}
		} else {
			payload["incident"] = map[string]interface{}{"id": incident.ID, "number": incident.Number, "line_id": incident.LineID, "violation_type": incident.ViolationType, "started_at": incident.StartedAt, "opening_snapshot": incident.Opening}
		}
		if provider != nil {
			payload["provider"] = map[string]interface{}{"id": provider.ID, "name": provider.Name}
		}
		response, err := postJSON(ctx, endpoint, payload, "LINKWATCH_PROVIDER_WEBHOOK_TOKEN", fmt.Sprintf("linkwatch-provider-case-%d", item.ID))
		if err != nil {
			return Result{}, err
		}
		return Result{Channel: "WEBHOOK", ExternalID: responseID(response), Detail: endpoint}, nil
	default:
		return Result{}, &DeliveryError{Message: "LINKWATCH_PROVIDER_TRANSPORT must be internal or webhook", Retryable: false}
	}
}

type Notification struct {
	ID          int64
	SourceType  string
	SourceID    string
	Scope       string
	Message     string
	GeneratedAt time.Time
}

func SendNotification(ctx context.Context, item Notification) (Result, error) {
	mode := strings.ToLower(strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_TRANSPORT", "VKO_NOTIFICATION_TRANSPORT")))
	if mode == "" {
		mode = "internal"
		if isProduction() {
			mode = "webhook"
		}
	}
	if mode == "internal" || mode == "web" {
		if isProduction() {
			return Result{}, &DeliveryError{Message: "internal notification transport is disabled in production", Retryable: false}
		}
		return Result{Channel: "WEB", Detail: "available in the web inbox"}, nil
	}
	if mode != "webhook" {
		return Result{}, &DeliveryError{Message: "LINKWATCH_NOTIFICATION_TRANSPORT must be internal or webhook", Retryable: false}
	}
	endpoint := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_WEBHOOK_URL", "VKO_NOTIFICATION_WEBHOOK_URL"))
	if endpoint == "" {
		return Result{}, &DeliveryError{Message: "notification webhook endpoint is not configured", Retryable: true}
	}
	response, err := postJSON(ctx, endpoint, map[string]interface{}{"event": "notification.created", "notification": item}, "LINKWATCH_NOTIFICATION_WEBHOOK_TOKEN", fmt.Sprintf("linkwatch-notification-%d", item.ID))
	if err != nil {
		return Result{}, err
	}
	return Result{Channel: "WEBHOOK", ExternalID: responseID(response), Detail: endpoint}, nil
}

func postJSON(ctx context.Context, endpoint string, payload interface{}, tokenEnv, idempotency string) (map[string]interface{}, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && !isProduction() && os.Getenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK") == "1")) {
		return nil, &DeliveryError{Message: "webhook endpoint must use HTTPS", Retryable: false}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &DeliveryError{Message: "encode webhook payload: " + err.Error(), Retryable: false}
	}
	timeout := 10 * time.Second
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &DeliveryError{Message: "create webhook request: " + err.Error(), Retryable: false}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "linkwatch-server/1")
	if token := strings.TrimSpace(envOr(tokenEnv, "")); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Idempotency-Key", idempotency)
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(next *http.Request, _ []*http.Request) error {
			if next.URL.Scheme != "https" && !(next.URL.Scheme == "http" && !isProduction() && os.Getenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK") == "1") {
				return fmt.Errorf("webhook redirect must use HTTPS")
			}
			return nil
		},
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, &DeliveryError{Message: "webhook request failed: " + err.Error(), Retryable: true}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return nil, &DeliveryError{Message: "read webhook response: " + err.Error(), Retryable: true}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &DeliveryError{Message: fmt.Sprintf("webhook returned HTTP %d", response.StatusCode), Retryable: response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
	}
	if len(raw) == 0 {
		return map[string]interface{}{}, nil
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, &DeliveryError{Message: "decode webhook response: " + err.Error(), Retryable: true}
	}
	if decoded == nil {
		return nil, &DeliveryError{Message: "webhook response must be a JSON object", Retryable: true}
	}
	return decoded, nil
}

func responseID(value map[string]interface{}) string {
	for _, key := range []string{"ticket_no", "ticket_number", "external_ticket_no", "message_id", "id"} {
		if item, ok := value[key]; ok && item != nil {
			return fmt.Sprint(item)
		}
	}
	return ""
}

func envOr(primary, secondary string) string {
	if primary != "" {
		if value := os.Getenv(primary); value != "" {
			return value
		}
	}
	if secondary != "" {
		return os.Getenv(secondary)
	}
	return ""
}

func isProduction() bool {
	return strings.EqualFold(envOr("LINKWATCH_ENV", "VKO_ENV"), "production")
}

func first(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
