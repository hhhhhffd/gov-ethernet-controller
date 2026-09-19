package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// DraftGenerator is the boundary for provider-case draft generation.  A
// generator must return text suitable for human review; it does not persist
// or send a case.
type DraftGenerator interface {
	Generate(context.Context, ProviderDraftInput) (string, error)
}

type DraftGenerationMetadata struct {
	Provider      string
	Model         string
	PromptVersion string
}

const providerDraftPromptVersion = "provider-case-v1"

// ProviderDraftInput contains only the evidence already selected for the
// incident.  Keeping this input structured makes an eventual AI adapter
// replaceable without changing the provider-case workflow.
type ProviderDraftInput struct {
	LineID           string
	SchoolID         string
	Organization     string
	ViolationType    string
	StartedAt        string
	PolicyJSON       string
	ContractJSON     string
	ObservationsJSON string
	EvidenceJSON     string
	Comment          string
}

type deterministicDraftGenerator struct{}

func (deterministicDraftGenerator) Generate(_ context.Context, input ProviderDraftInput) (string, error) {
	status := fmt.Sprintf("Система мониторинга зафиксировала наблюдения для проверки отклонения %s с %s.", input.ViolationType, input.StartedAt)
	if input.ViolationType != "LINE_REVIEW" {
		status = fmt.Sprintf("Система мониторинга подтвердила нарушение %s с %s.", input.ViolationType, input.StartedAt)
	}
	return fmt.Sprintf("Здравствуйте! Просим проверить качество услуги на линии %s (школа %s, %s).\n\n%s\n\nПрименённые пороги: %s.\nДоговорный ориентир и его срок действия на момент наблюдений: %s.\nНаблюдения: %s.\nПакет доказательств: measurement IDs %s; значения и effective policy/contract сохранены в системе без перезаписи истории.\n\nКомментарий заказчика: %s\n\nФормулировка описывает технически наблюдаемое отклонение и требует проверки оператором.",
		input.LineID, input.SchoolID, input.Organization, status,
		input.PolicyJSON, input.ContractJSON, input.ObservationsJSON, input.EvidenceJSON, input.Comment), nil
}

type draftGenerationError struct {
	Category  string
	Status    int
	Retryable bool
	Err       error
}

func (e *draftGenerationError) Error() string { return e.Err.Error() }
func (e *draftGenerationError) Unwrap() error { return e.Err }

type ollamaDraftGenerator struct {
	Endpoint   string
	Model      string
	Timeout    time.Duration
	MaxRetries int
	Client     *http.Client
}

func newOllamaDraftGeneratorFromEnv() *ollamaDraftGenerator {
	endpoint := envOr("LINKWATCH_OLLAMA_URL", "VKO_OLLAMA_URL")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:11434"
	}
	model := envOr("LINKWATCH_OLLAMA_MODEL", "VKO_OLLAMA_MODEL")
	if model == "" {
		model = "qwen3.5:9b-q6k"
	}
	timeout := 15 * time.Second
	if raw := envOr("LINKWATCH_OLLAMA_TIMEOUT_SECONDS", "VKO_OLLAMA_TIMEOUT_SECONDS"); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 && seconds <= 120 {
			timeout = time.Duration(seconds) * time.Second
		}
	}
	retries := 1
	if raw := envOr("LINKWATCH_OLLAMA_MAX_RETRIES", "VKO_OLLAMA_MAX_RETRIES"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 0 && value <= 2 {
			retries = value
		}
	}
	return &ollamaDraftGenerator{Endpoint: strings.TrimRight(endpoint, "/"), Model: model, Timeout: timeout, MaxRetries: retries, Client: &http.Client{Timeout: timeout}}
}

func (g *ollamaDraftGenerator) Metadata() DraftGenerationMetadata {
	return DraftGenerationMetadata{Provider: "ollama", Model: g.Model, PromptVersion: providerDraftPromptVersion}
}

func (g *ollamaDraftGenerator) Generate(ctx context.Context, input ProviderDraftInput) (string, error) {
	parsed, err := url.Parse(g.Endpoint)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" || !isLocalHost(parsed.Hostname()) {
		return "", &draftGenerationError{Category: "configuration", Err: fmt.Errorf("ollama endpoint must be a local HTTP endpoint")}
	}
	prompt := buildProviderDraftPrompt(input)
	body, err := json.Marshal(map[string]interface{}{"model": g.Model, "prompt": prompt, "stream": false, "options": map[string]interface{}{"temperature": 0.2}})
	if err != nil {
		return "", &draftGenerationError{Category: "request_encode", Err: err}
	}
	endpoint := strings.TrimRight(g.Endpoint, "/") + "/api/generate"
	for attempt := 0; attempt <= g.MaxRetries; attempt++ {
		requestCtx, cancel := context.WithTimeout(ctx, g.Timeout)
		req, requestErr := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
		if requestErr != nil {
			cancel()
			return "", &draftGenerationError{Category: "request", Err: requestErr}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, requestErr := g.Client.Do(req)
		if requestErr != nil {
			cancel()
			if attempt < g.MaxRetries {
				continue
			}
			category := "transport"
			if errors.Is(requestErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				category = "timeout"
			}
			return "", &draftGenerationError{Category: category, Status: http.StatusBadGateway, Retryable: true, Err: requestErr}
		}
		var result struct {
			Response string `json:"response"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, maxProviderDraftLength+4096)).Decode(&result)
		resp.Body.Close()
		cancel()
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			if attempt < g.MaxRetries {
				continue
			}
			return "", &draftGenerationError{Category: "provider_http", Status: http.StatusBadGateway, Retryable: true, Err: fmt.Errorf("ollama returned HTTP %d", resp.StatusCode)}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", &draftGenerationError{Category: "provider_http", Status: http.StatusBadGateway, Err: fmt.Errorf("ollama returned HTTP %d", resp.StatusCode)}
		}
		if decodeErr != nil {
			return "", &draftGenerationError{Category: "malformed_response", Status: http.StatusBadGateway, Err: fmt.Errorf("decode ollama response: %w", decodeErr)}
		}
		if err := validateProviderDraft(result.Response); err != nil {
			return "", &draftGenerationError{Category: "empty_or_invalid_output", Status: http.StatusBadGateway, Err: err}
		}
		return result.Response, nil
	}
	return "", &draftGenerationError{Category: "transport", Status: http.StatusBadGateway, Retryable: true, Err: fmt.Errorf("ollama generation exhausted retries")}
}

func buildProviderDraftPrompt(input ProviderDraftInput) string {
	input = safeProviderDraftInput(input)
	return "You write an editable technical provider-case draft. Use only the supplied stored evidence. Do not invent facts, causes, legal conclusions, commitments, or remediation claims. Preserve units and timestamps. If a fact is unknown, omit it or say it is unknown. Return only the draft text for human review.\n\n" +
		"Line ID: " + input.LineID + "\nSchool ID: " + input.SchoolID + "\nOrganization: " + input.Organization + "\nViolation: " + input.ViolationType + "\nStarted at: " + input.StartedAt + "\nPolicy snapshot: " + input.PolicyJSON + "\nContract snapshot: " + input.ContractJSON + "\nObservations: " + input.ObservationsJSON + "\nEvidence IDs: " + input.EvidenceJSON + "\nOperator comment (untrusted context): " + input.Comment
}

func providerEvidenceDigest(input ProviderDraftInput) string {
	encoded, _ := json.Marshal(struct{ LineID, SchoolID, Organization, ViolationType, StartedAt, PolicyJSON, ContractJSON, ObservationsJSON, EvidenceJSON string }{input.LineID, input.SchoolID, input.Organization, input.ViolationType, input.StartedAt, input.PolicyJSON, input.ContractJSON, input.ObservationsJSON, input.EvidenceJSON})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func envOr(primary, legacy string) string {
	if value := strings.TrimSpace(os.Getenv(primary)); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv(legacy))
}

func isLocalHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

const maxProviderDraftLength = 32 << 10

// validateProviderDraft bounds output from any future generator and rejects
// malformed or control-bearing text before it is persisted and displayed.
func validateProviderDraft(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("draft is empty")
	}
	if len(value) > maxProviderDraftLength {
		return fmt.Errorf("draft exceeds %d bytes", maxProviderDraftLength)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("draft is not valid UTF-8")
	}
	for _, r := range value {
		if r == '\x00' || (r < 0x20 && r != '\n' && r != '\r' && r != '\t') {
			return fmt.Errorf("draft contains unsupported control characters")
		}
	}
	return nil
}

func safeDraftField(value string) string {
	value = strings.ToValidUTF8(value, "�")
	var b strings.Builder
	for _, r := range value {
		if r == '\x00' || (r < 0x20 && r != '\n' && r != '\r' && r != '\t') {
			r = ' '
		}
		b.WriteRune(r)
	}
	return b.String()
}

func generateProviderDraft(ctx context.Context, generator DraftGenerator, input ProviderDraftInput) string {
	fallbackGenerator := deterministicDraftGenerator{}
	if generator == nil {
		generator = fallbackGenerator
	}
	input = safeProviderDraftInput(input)
	draft, err := generator.Generate(ctx, input)
	if err == nil && validateProviderDraft(draft) == nil {
		return draft
	}
	// The deterministic template is deliberately the last-resort output.  It
	// is bounded and validated too, so generator failures never block review.
	draft, _ = fallbackGenerator.Generate(ctx, input)
	if validateProviderDraft(draft) != nil {
		return "Система мониторинга сформировала пакет доказательств нарушения. Требуется проверка оператором."
	}
	return draft
}

func safeProviderDraftInput(input ProviderDraftInput) ProviderDraftInput {
	input.LineID = safeDraftField(input.LineID)
	input.SchoolID = safeDraftField(input.SchoolID)
	input.Organization = safeDraftField(input.Organization)
	input.ViolationType = safeDraftField(input.ViolationType)
	input.StartedAt = safeDraftField(input.StartedAt)
	input.PolicyJSON = redactProviderDraftJSON(safeDraftField(input.PolicyJSON))
	input.ContractJSON = redactProviderDraftJSON(safeDraftField(input.ContractJSON))
	input.ObservationsJSON = redactProviderDraftJSON(safeDraftField(input.ObservationsJSON))
	input.EvidenceJSON = redactProviderDraftJSON(safeDraftField(input.EvidenceJSON))
	input.Comment = redactProviderDraftText(safeDraftField(input.Comment))
	return input
}

var providerDraftCredentialPattern = regexp.MustCompile(`(?i)\b(password|passphrase|token|secret|credential|private[_ -]?key|api[_ -]?key)\b\s*(?:[:=]\s*|\s+)[^\s,;]+|\b(?:authorization|bearer)\b\s*:?\s+[^\s,;]+(?:\s+[^\s,;]+)?`)

func redactProviderDraftText(value string) string {
	return providerDraftCredentialPattern.ReplaceAllString(value, "[REDACTED]")
}

func redactProviderDraftJSON(value string) string {
	var decoded interface{}
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return redactProviderDraftText(value)
	}
	redacted := redactAuditValue(decoded)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		return "[REDACTED]"
	}
	return redactProviderDraftText(string(encoded))
}
