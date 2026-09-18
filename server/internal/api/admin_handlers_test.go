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

func TestValidateScopeRole(t *testing.T) {
	tests := []struct {
		name, role, scopeType string
		wantErr               bool
	}{
		{name: "provider role provider scope", role: "PROVIDER", scopeType: "PROVIDER"},
		{name: "district role district scope", role: "DISTRICT", scopeType: "DISTRICT"},
		{name: "non provider cannot use provider scope", role: "ADMIN", scopeType: "PROVIDER", wantErr: true},
		{name: "provider cannot use line scope", role: "PROVIDER", scopeType: "LINE", wantErr: true},
		{name: "unknown scope", role: "ADMIN", scopeType: "UNKNOWN", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateScopeRole(tt.role, tt.scopeType); (err != nil) != tt.wantErr {
				t.Fatalf("validateScopeRole(%q, %q) error = %v, wantErr %v", tt.role, tt.scopeType, err, tt.wantErr)
			}
		})
	}
}
