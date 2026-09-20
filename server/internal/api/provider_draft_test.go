package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type testDraftGenerator struct {
	text string
	err  error
}

func (g testDraftGenerator) Generate(context.Context, ProviderDraftInput) (string, error) {
	return g.text, g.err
}

func TestGenerateProviderDraftFallsBackOnGeneratorError(t *testing.T) {
	input := ProviderDraftInput{LineID: "line-1", Organization: "Средняя школа №32", ViolationType: "NO_INTERNET", ObservationsJSON: `[{},{}]`, Comment: "Проверьте line-42-primary"}
	draft := generateProviderDraft(context.Background(), testDraftGenerator{err: errors.New("unavailable")}, input)
	if !strings.Contains(draft, "Средняя школа №32") || !strings.Contains(draft, "потеря интернет-соединения") {
		t.Fatalf("fallback draft does not contain human incident context: %q", draft)
	}
	for _, forbidden := range []string{"line-1", "NO_INTERNET", "measurement IDs", "{"} {
		if strings.Contains(draft, forbidden) {
			t.Fatalf("fallback draft leaked technical data %q: %q", forbidden, draft)
		}
	}
}

func TestGenerateProviderDraftRejectsUnsafeGeneratorOutput(t *testing.T) {
	input := ProviderDraftInput{LineID: "line-1"}
	draft := generateProviderDraft(context.Background(), testDraftGenerator{text: "bad\x00draft"}, input)
	if strings.ContainsRune(draft, '\x00') {
		t.Fatalf("unsafe generator output was persisted: %q", draft)
	}
}

func TestValidateProviderDraftRejectsInvalidOutput(t *testing.T) {
	if err := validateProviderDraft("\x00"); err == nil {
		t.Fatal("expected control character validation error")
	}
	if err := validateProviderDraft(strings.Repeat("x", maxProviderDraftLength+1)); err == nil {
		t.Fatal("expected length validation error")
	}
	if err := validateProviderDraft(`{"measurement_id":7}`); err == nil {
		t.Fatal("expected technical output validation error")
	}
	if err := validateProviderDraft("Просим проверить line-42-primary."); err == nil {
		t.Fatal("expected internal identifier validation error")
	}
}

func TestOllamaDraftGeneratorUsesStoredFactsOnly(t *testing.T) {
	var request map[string]interface{}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"response":"Просим проверить состояние линии и сообщить номер заявки."}`)), Header: make(http.Header)}, nil
	})
	generator := &ollamaDraftGenerator{Endpoint: "http://127.0.0.1:11434", Model: "qwen3.5:9b-q6k", Timeout: time.Second, Client: &http.Client{Transport: transport}}
	draft, err := generator.Generate(context.Background(), ProviderDraftInput{LineID: "line-1", EvidenceJSON: "[7]", Comment: "<unsafe>"})
	if err != nil || draft == "" {
		t.Fatalf("Generate() = %q, %v", draft, err)
	}
	prompt, _ := request["prompt"].(string)
	if !strings.Contains(prompt, "line-1") || !strings.Contains(prompt, "[7]") || !strings.Contains(prompt, "<unsafe>") {
		t.Fatalf("prompt lost supplied facts: %q", prompt)
	}
	if strings.Contains(prompt, "password") {
		t.Fatal("prompt unexpectedly contains credential-like data")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOllamaDraftGeneratorRejectsNonLocalEndpoint(t *testing.T) {
	generator := &ollamaDraftGenerator{Endpoint: "https://example.invalid", Model: "qwen3.5:9b-q6k", Timeout: time.Second}
	if _, err := generator.Generate(context.Background(), ProviderDraftInput{}); err == nil {
		t.Fatal("remote Ollama endpoint was accepted")
	}
}

func TestProviderDraftPromptDisallowsLegalConclusions(t *testing.T) {
	prompt := buildProviderDraftPrompt(ProviderDraftInput{LineID: "line-1"})
	if !strings.Contains(prompt, "Do not invent facts, causes, legal conclusions") {
		t.Fatalf("prompt boundary missing: %q", prompt)
	}
	if !strings.Contains(prompt, "Never output JSON, internal IDs, enum codes, measurement IDs") {
		t.Fatalf("prompt technical-output boundary missing: %q", prompt)
	}
}

func TestProviderDraftPromptRedactsCredentialValues(t *testing.T) {
	prompt := buildProviderDraftPrompt(ProviderDraftInput{
		LineID:           "line-1",
		PolicyJSON:       `{"api_token":"fixture-api-token","download_min":50}`,
		ContractJSON:     `{"password":"fixture-password"}`,
		ObservationsJSON: `[{"id":7,"raw_secret":"fixture-raw-secret"}]`,
		Comment:          "password=fixture-comment-password Authorization: Bearer fixture-bearer-token",
	})
	for _, secret := range []string{"fixture-api-token", "fixture-password", "fixture-raw-secret", "fixture-comment-password", "fixture-bearer-token"} {
		if strings.Contains(prompt, secret) {
			t.Fatalf("prompt leaked credential value %q: %s", secret, prompt)
		}
	}
	if strings.Count(prompt, "[REDACTED]") < 5 {
		t.Fatalf("prompt redaction markers = %d, want at least 5: %s", strings.Count(prompt, "[REDACTED]"), prompt)
	}
	if !strings.Contains(prompt, `"download_min":50`) || !strings.Contains(prompt, "line-1") {
		t.Fatalf("prompt lost non-sensitive technical facts: %s", prompt)
	}
}
