package api

import "testing"

func TestNormalizeDeviceDisplayName(t *testing.T) {
	if got, err := normalizeDeviceDisplayName("  Router A  "); err != nil || got != "Router A" {
		t.Fatalf("normalizeDeviceDisplayName() = %q, %v", got, err)
	}
	if _, err := normalizeDeviceDisplayName(""); err == nil {
		t.Fatal("empty display name must be rejected")
	}
	if _, err := normalizeDeviceDisplayName(string(make([]byte, 256))); err == nil {
		t.Fatal("display name longer than 255 bytes must be rejected")
	}
}
