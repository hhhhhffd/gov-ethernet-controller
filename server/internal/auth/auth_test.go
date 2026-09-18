package auth

import "testing"

func TestHasLineScopeHonorsRoleBoundaries(t *testing.T) {
	provider := &Principal{Role: "PROVIDER", Scopes: []Scope{{Type: "PROVIDER", ID: "provider-a"}}}
	if !HasLineScope(provider, "line-a", "org-a", "District", "provider-a") {
		t.Fatal("provider scope did not allow its line")
	}
	if HasLineScope(provider, "line-b", "org-b", "District", "provider-b") {
		t.Fatal("provider scope leaked to another provider")
	}
	providerOrg := &Principal{Role: "PROVIDER", Scopes: []Scope{{Type: "ORGANIZATION", ID: "org-a"}}}
	if HasLineScope(providerOrg, "line-a", "org-a", "District", "provider-a") {
		t.Fatal("provider organization scope bypassed provider boundary")
	}
	foreignRole := &Principal{Role: "SCHOOL", Scopes: []Scope{{Type: "PROVIDER", ID: "provider-a"}}}
	if HasLineScope(foreignRole, "line-a", "org-a", "District", "provider-a") {
		t.Fatal("provider scope was honored for a school role")
	}
	if !HasLineScope(&Principal{Role: "ADMIN"}, "line-b", "org-b", "District", "provider-b") {
		t.Fatal("admin was denied global access")
	}
}

func TestPasswordHashVerification(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if !VerifyPassword("correct horse battery staple", hash) {
		t.Fatal("generated password hash did not verify")
	}
	if VerifyPassword("wrong", hash) {
		t.Fatal("wrong password verified")
	}
}

func TestEffectiveCapabilitiesUseBackendActionContract(t *testing.T) {
	admin := EffectiveCapabilities(&Principal{Role: "ADMIN"})
	if !containsCapability(admin, "admin.users") || !containsCapability(admin, "notification.dispatch") || !containsCapability(admin, "notification.read") {
		t.Fatalf("admin capabilities = %v", admin)
	}
	school := EffectiveCapabilities(&Principal{Role: "SCHOOL"})
	if !containsCapability(school, "notification.read") {
		t.Fatalf("school lacks notification.read: %v", school)
	}
	if containsCapability(school, "incident.create") || containsCapability(school, "provider_case.send") {
		t.Fatalf("school received mutation capabilities: %v", school)
	}
	provider := EffectiveCapabilities(&Principal{Role: "PROVIDER", Scopes: []Scope{{Type: "PROVIDER", ID: "p1"}}})
	if !containsCapability(provider, "provider_case.send") || containsCapability(provider, "admin.manage") {
		t.Fatalf("provider capabilities = %v", provider)
	}
}

func containsCapability(capabilities []string, wanted string) bool {
	for _, capability := range capabilities {
		if capability == wanted {
			return true
		}
	}
	return false
}
