package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"linkwatch/server/internal/auth"
)

func TestManualIncidentAuthorizationUsesOperatorRoles(t *testing.T) {
	tests := []struct {
		name string
		role string
		want bool
	}{
		{name: "admin", role: "ADMIN", want: true},
		{name: "oblast", role: "OBLAST", want: true},
		{name: "district", role: "DISTRICT", want: true},
		{name: "provider is not incident operator", role: "PROVIDER", want: false},
		{name: "school is read only", role: "SCHOOL", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			got := requireRole(w, &auth.Principal{Role: tt.role}, "assign")
			if got != tt.want {
				t.Fatalf("requireRole(assign) for %s = %v, want %v", tt.role, got, tt.want)
			}
			if !tt.want && w.Code != http.StatusForbidden {
				t.Fatalf("requireRole(assign) for %s status = %d, want %d", tt.role, w.Code, http.StatusForbidden)
			}
		})
	}
}

func TestSchoolCannotCreateProviderDraft(t *testing.T) {
	w := httptest.NewRecorder()
	(&Server{}).providerDraft(w, nil, incidentRecord{}, &auth.Principal{Role: "SCHOOL"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("providerDraft for SCHOOL status = %d, want %d", w.Code, http.StatusForbidden)
	}
	if !strings.Contains(w.Body.String(), "provider_send") {
		t.Fatalf("providerDraft denial = %q, want provider_send explanation", w.Body.String())
	}
}

func TestRequireAdminRejectsOblastAndAllowsAdmin(t *testing.T) {
	denied := httptest.NewRecorder()
	if requireAdmin(denied, &auth.Principal{Role: "OBLAST"}) {
		t.Fatal("requireAdmin allowed OBLAST")
	}
	if denied.Code != http.StatusForbidden {
		t.Fatalf("requireAdmin OBLAST status = %d, want %d", denied.Code, http.StatusForbidden)
	}

	allowed := httptest.NewRecorder()
	if !requireAdmin(allowed, &auth.Principal{Role: "ADMIN"}) {
		t.Fatal("requireAdmin rejected ADMIN")
	}
	if allowed.Code != http.StatusOK {
		t.Fatalf("requireAdmin ADMIN status = %d, want untouched recorder status", allowed.Code)
	}
}
