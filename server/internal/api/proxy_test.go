package api

import (
	"net/http/httptest"
	"testing"
)

func TestAuthClientKeySeparatesClientsBehindTrustedProxy(t *testing.T) {
	networks, err := parseTrustedProxyCIDRs("172.30.0.10/32")
	if err != nil {
		t.Fatalf("parse trusted proxy: %v", err)
	}

	clientA := httptest.NewRequest("POST", "/api/login", nil)
	clientA.RemoteAddr = "172.30.0.10:8080"
	clientA.Header.Set("X-Forwarded-For", "198.51.100.10")
	clientB := httptest.NewRequest("POST", "/api/login", nil)
	clientB.RemoteAddr = "172.30.0.10:8080"
	clientB.Header.Set("X-Forwarded-For", "198.51.100.11")

	keyA := authClientKeyWithTrustedProxies(clientA, networks)
	keyB := authClientKeyWithTrustedProxies(clientB, networks)
	if keyA != "198.51.100.10" || keyB != "198.51.100.11" || keyA == keyB {
		t.Fatalf("trusted proxy client keys = %q and %q", keyA, keyB)
	}
}

func TestAuthClientKeyIgnoresForwardedHeaderFromDirectPeer(t *testing.T) {
	networks, err := parseTrustedProxyCIDRs("172.30.0.10/32")
	if err != nil {
		t.Fatalf("parse trusted proxy: %v", err)
	}
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "198.51.100.10:4000"
	r.Header.Set("X-Forwarded-For", "203.0.113.99")
	if got := authClientKeyWithTrustedProxies(r, networks); got != "198.51.100.10" {
		t.Fatalf("direct peer with forged X-Forwarded-For got key %q", got)
	}
}

func TestAuthClientKeyTrustedProxyWithoutForwardedHeaderFallsBackToPeer(t *testing.T) {
	networks, err := parseTrustedProxyCIDRs("172.30.0.10/32")
	if err != nil {
		t.Fatalf("parse trusted proxy: %v", err)
	}
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "172.30.0.10:4000"
	if got := authClientKeyWithTrustedProxies(r, networks); got != "172.30.0.10" {
		t.Fatalf("trusted peer without X-Forwarded-For got key %q", got)
	}
}

func TestAuthClientKeyUsesFirstValidForwardedHopAndNormalizesIPv6(t *testing.T) {
	networks, err := parseTrustedProxyCIDRs("2001:db8::10/128")
	if err != nil {
		t.Fatalf("parse trusted proxy: %v", err)
	}
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "[2001:db8::10]:8080"
	r.Header.Add("X-Forwarded-For", "unknown, 2001:db8::20, 2001:db8::30")
	if got := authClientKeyWithTrustedProxies(r, networks); got != "2001:db8::20" {
		t.Fatalf("trusted IPv6 peer got key %q", got)
	}
}

func TestValidateRuntimeConfigRequiresTrustedProxyInProduction(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "production")
	t.Setenv(trustedProxyCIDRsEnv, "")
	if err := ValidateRuntimeConfig(); err == nil {
		t.Fatal("production configuration without trusted proxy was accepted")
	}

	t.Setenv(trustedProxyCIDRsEnv, "not-an-ip")
	if err := ValidateRuntimeConfig(); err == nil {
		t.Fatal("malformed trusted proxy configuration was accepted")
	}

	t.Setenv(trustedProxyCIDRsEnv, "172.30.0.10/32")
	if err := ValidateRuntimeConfig(); err != nil {
		t.Fatalf("valid production configuration rejected: %v", err)
	}
}
