// Package providers contains the bounded outbound adapters used by provider
// cases and web notifications.  The adapters never decide workflow state;
// callers persist the attempt and its result in PostgreSQL.
package providers

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
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
		externalID := responseID(response)
		if externalID == "" {
			return Result{}, &DeliveryError{Message: "webhook response missing external reference", Retryable: false}
		}
		return Result{Channel: "WEBHOOK", ExternalID: externalID, Detail: "webhook delivery accepted"}, nil
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

var sendMail = sendMailWithTLS

var notificationRateLimiter = struct {
	sync.Mutex
	last map[string]time.Time
}{last: map[string]time.Time{}}

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
	if mode == "email" || mode == "smtp" {
		if err := waitNotificationRateLimit(ctx, "EMAIL"); err != nil {
			return Result{}, err
		}
		return sendEmailNotification(ctx, item)
	}
	if mode == "telegram" || mode == "tg" {
		if err := waitNotificationRateLimit(ctx, "TELEGRAM"); err != nil {
			return Result{}, err
		}
		return sendTelegramNotification(ctx, item)
	}
	if mode != "webhook" {
		return Result{}, &DeliveryError{Message: "LINKWATCH_NOTIFICATION_TRANSPORT must be internal, webhook, email or telegram", Retryable: false}
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

func sendEmailNotification(ctx context.Context, item Notification) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, &DeliveryError{Message: "email delivery cancelled", Retryable: true}
	}
	host := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_EMAIL_SMTP_HOST", "VKO_NOTIFICATION_EMAIL_SMTP_HOST"))
	port := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_EMAIL_SMTP_PORT", "VKO_NOTIFICATION_EMAIL_SMTP_PORT"))
	from := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_EMAIL_FROM", "VKO_NOTIFICATION_EMAIL_FROM"))
	to := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_EMAIL_TO", "VKO_NOTIFICATION_EMAIL_TO"))
	if host == "" || port == "" || from == "" || to == "" {
		return Result{}, &DeliveryError{Message: "email transport is not configured", Retryable: false}
	}
	if !validEmailAddress(from) || !validEmailAddress(to) || strings.ContainsAny(host, "\r\n") || strings.ContainsAny(port, "\r\n") {
		return Result{}, &DeliveryError{Message: "email destination configuration is invalid", Retryable: false}
	}
	username := envOr("LINKWATCH_NOTIFICATION_EMAIL_USERNAME", "VKO_NOTIFICATION_EMAIL_USERNAME")
	password := envOr("LINKWATCH_NOTIFICATION_EMAIL_PASSWORD", "VKO_NOTIFICATION_EMAIL_PASSWORD")
	var auth smtp.Auth
	if username != "" || password != "" {
		auth = smtp.PlainAuth("", username, password, host)
	}
	subject := fmt.Sprintf("Linkwatch notification %d", item.ID)
	body := "From: " + from + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + item.Message + "\r\n"
	done := make(chan error, 1)
	go func() { done <- sendMail(host+":"+port, auth, from, []string{to}, []byte(body)) }()
	select {
	case <-ctx.Done():
		return Result{}, &DeliveryError{Message: "email delivery cancelled", Retryable: true}
	case err := <-done:
		if err != nil {
			return Result{}, classifySMTPError(err)
		}
	case <-time.After(10 * time.Second):
		return Result{}, &DeliveryError{Message: "email provider request timed out", Retryable: true}
	}
	return Result{Channel: "EMAIL", ExternalID: fmt.Sprintf("notification-%d", item.ID), Detail: "email delivery accepted"}, nil
}

func sendMailWithTLS(address string, auth smtp.Auth, from string, to []string, body []byte) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	tlsConfig := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	var client *smtp.Client
	if port == "465" {
		conn, dialErr := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", address, tlsConfig)
		if dialErr != nil {
			return dialErr
		}
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		client, err = smtp.NewClient(conn, host)
	} else {
		conn, dialErr := net.DialTimeout("tcp", address, 10*time.Second)
		if dialErr != nil {
			return dialErr
		}
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		client, err = smtp.NewClient(conn, host)
		if err == nil {
			if ok, _ := client.Extension("STARTTLS"); !ok {
				_ = client.Close()
				return fmt.Errorf("smtp server does not support STARTTLS")
			}
			err = client.StartTLS(tlsConfig)
		}
	}
	if err != nil {
		return err
	}
	defer client.Close()
	if auth != nil {
		if err := client.Auth(auth); err != nil {
			return err
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(body); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func sendTelegramNotification(ctx context.Context, item Notification) (Result, error) {
	token := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_TELEGRAM_BOT_TOKEN", "VKO_NOTIFICATION_TELEGRAM_BOT_TOKEN"))
	chatID := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_TELEGRAM_CHAT_ID", "VKO_NOTIFICATION_TELEGRAM_CHAT_ID"))
	endpoint := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_TELEGRAM_URL", "VKO_NOTIFICATION_TELEGRAM_URL"))
	if token == "" || chatID == "" {
		return Result{}, &DeliveryError{Message: "telegram transport is not configured", Retryable: false}
	}
	if endpoint == "" {
		endpoint = "https://api.telegram.org/bot" + url.PathEscape(token) + "/sendMessage"
	}
	response, err := postJSON(ctx, endpoint, map[string]interface{}{"chat_id": chatID, "text": item.Message, "disable_web_page_preview": true}, "", fmt.Sprintf("linkwatch-notification-%d", item.ID))
	if err != nil {
		return Result{}, err
	}
	if ok, exists := response["ok"]; exists && ok == false {
		return Result{}, &DeliveryError{Message: "telegram rejected notification", Retryable: false}
	}
	externalID := responseID(response)
	if result, ok := response["result"].(map[string]interface{}); ok {
		externalID = responseID(result)
	}
	if externalID == "" {
		return Result{}, &DeliveryError{Message: "telegram response missing message reference", Retryable: false}
	}
	return Result{Channel: "TELEGRAM", ExternalID: externalID, Detail: "telegram delivery accepted"}, nil
}

func validEmailAddress(value string) bool {
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && !strings.ContainsAny(value, "\r\n")
}

func classifySMTPError(err error) *DeliveryError {
	message := err.Error()
	if len(message) >= 3 {
		if code, parseErr := strconv.Atoi(message[:3]); parseErr == nil {
			return &DeliveryError{Message: "email provider rejected notification", Retryable: code >= 400 && code < 500}
		}
	}
	return &DeliveryError{Message: "email provider request failed", Retryable: true}
}

func waitNotificationRateLimit(ctx context.Context, channel string) error {
	value := strings.TrimSpace(envOr("LINKWATCH_NOTIFICATION_RATE_LIMIT_MS", "VKO_NOTIFICATION_RATE_LIMIT_MS"))
	if value == "" {
		return nil
	}
	ms, err := strconv.Atoi(value)
	if err != nil || ms < 0 || ms > 600000 {
		return &DeliveryError{Message: "notification rate limit configuration is invalid", Retryable: false}
	}
	now := time.Now()
	notificationRateLimiter.Lock()
	delay := time.Duration(0)
	interval := time.Duration(ms) * time.Millisecond
	if previous := notificationRateLimiter.last[channel]; !previous.IsZero() {
		next := previous.Add(interval)
		if next.After(now) {
			delay = next.Sub(now)
		}
	}
	notificationRateLimiter.last[channel] = now.Add(delay)
	notificationRateLimiter.Unlock()
	if delay == 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return &DeliveryError{Message: "notification rate limit wait cancelled", Retryable: true}
	case <-timer.C:
		notificationRateLimiter.Lock()
		notificationRateLimiter.last[channel] = time.Now()
		notificationRateLimiter.Unlock()
		return nil
	}
}

func postJSON(ctx context.Context, endpoint string, payload interface{}, tokenEnv, idempotency string) (map[string]interface{}, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || !isAllowedWebhookURL(parsed) {
		return nil, &DeliveryError{Message: "webhook endpoint must use HTTPS without credentials", Retryable: false}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &DeliveryError{Message: "encode webhook payload failed", Retryable: false}
	}
	timeout := 10 * time.Second
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &DeliveryError{Message: "create webhook request failed", Retryable: false}
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
			if !isAllowedWebhookURL(next.URL) {
				return fmt.Errorf("webhook redirect must use HTTPS")
			}
			return nil
		},
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, &DeliveryError{Message: "webhook request failed", Retryable: true}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return nil, &DeliveryError{Message: "read webhook response failed", Retryable: true}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &DeliveryError{Message: fmt.Sprintf("webhook returned HTTP %d", response.StatusCode), Retryable: response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
	}
	if len(raw) == 0 {
		return map[string]interface{}{}, nil
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, &DeliveryError{Message: "decode webhook response failed", Retryable: true}
	}
	if decoded == nil {
		return nil, &DeliveryError{Message: "webhook response must be a JSON object", Retryable: true}
	}
	return decoded, nil
}

func isAllowedWebhookURL(value *url.URL) bool {
	if value == nil || value.Host == "" || value.User != nil {
		return false
	}
	return value.Scheme == "https" || (value.Scheme == "http" && !isProduction() && os.Getenv("LINKWATCH_ALLOW_INSECURE_WEBHOOK") == "1")
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
