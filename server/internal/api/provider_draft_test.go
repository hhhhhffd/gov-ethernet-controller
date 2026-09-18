package api

import (
	"context"
	"errors"
	"strings"
	"testing"
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
