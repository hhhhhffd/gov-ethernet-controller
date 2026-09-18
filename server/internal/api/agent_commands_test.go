package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateCommandInputIsFrameworkOnly(t *testing.T) {
	if err := validateCommandInput("REBOOT", "device-1:1", json.RawMessage(`{"reason":"maintenance"}`)); err != nil {
		t.Fatalf("generic command should be accepted: %v", err)
	}
	if err := validateCommandInput("", "key", json.RawMessage(`{}`)); err == nil {
		t.Fatal("blank command type must be rejected")
	}
	if err := validateCommandInput("CUSTOM", "key", json.RawMessage(`[]`)); err == nil {
		t.Fatal("non-object payload must be rejected")
	}
	if err := validateCommandInput("CUSTOM", "key", json.RawMessage(strings.Repeat("x", commandMaxPayload+1))); err == nil {
		t.Fatal("oversized payload must be rejected")
	}
}
