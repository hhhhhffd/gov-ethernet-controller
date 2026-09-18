package api

import (
	"strings"
	"testing"
)

func TestProviderCaseSummaryRedactsLongTransportError(t *testing.T) {
	item := providerCaseSummary(7, 8, "line-1", "INCIDENT", "T-1", "FAILED", "FAILED", 2, strings.Repeat("x", 500), true, nil, nil, "INC-1", "school-1", "School", "Provider", "provider-1")
	if len(item["delivery_error"].(string)) != 240 {
		t.Fatalf("delivery error was not bounded")
	}
	if item["human_send_required"] != true || item["delivery_retryable"] != true {
		t.Fatalf("unexpected workflow flags: %#v", item)
	}
}

func TestProviderCaseSummaryPreservesCanonicalScopeIdentity(t *testing.T) {
	item := providerCaseSummary(1, 0, "line-9", "LINE", "", "DRAFT", "PENDING", 0, "", false, nil, nil, "", "school-9", "Org", "Provider", "provider-9")
	if item["line_id"] != "line-9" || item["provider_id"] != "provider-9" {
		t.Fatalf("scope identity was not preserved: %#v", item)
	}
	if item["human_send_required"] != true {
		t.Fatal("draft must remain behind human-send gate")
	}
}
