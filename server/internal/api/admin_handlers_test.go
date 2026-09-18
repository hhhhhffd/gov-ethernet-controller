package api

import "testing"

func TestAuditReasonTrimsOptionalReasonAndUsesVersionFallback(t *testing.T) {
	if got := auditReason("  approved by network team  ", "policy version created"); got != "approved by network team" {
		t.Fatalf("auditReason() = %q, want trimmed supplied reason", got)
	}
	if got := auditReason("  ", "contract version created"); got != "contract version created" {
		t.Fatalf("auditReason() = %q, want fallback for blank reason", got)
	}
}
