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
