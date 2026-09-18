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
	input := ProviderDraftInput{LineID: "line-1", ViolationType: "PING"}
	draft := generateProviderDraft(context.Background(), testDraftGenerator{err: errors.New("unavailable")}, input)
	if !strings.Contains(draft, "line-1") || !strings.Contains(draft, "PING") {
		t.Fatalf("fallback draft does not contain incident context: %q", draft)
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
}

func TestOllamaDraftGeneratorUsesStoredFactsOnly(t *testing.T) {
	var request map[string]interface{}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"response":"Проверить линию line-1."}`)), Header: make(http.Header)}, nil
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
}
