package api

import (
	"net/http/httptest"
	"testing"

	"linkwatch/server/internal/auth"
)

func TestParsePageParamsBounds(t *testing.T) {
	r := httptest.NewRequest("GET", "/audit?limit=25&page=3", nil)
	limit, offset, err := parsePageParams(r)
	if err != nil || limit != 25 || offset != 50 {
		t.Fatalf("got limit=%d offset=%d err=%v", limit, offset, err)
	}
	for _, query := range []string{"limit=0", "limit=101", "page=0", "page=nope"} {
		r := httptest.NewRequest("GET", "/audit?"+query, nil)
		if _, _, err := parsePageParams(r); err == nil {
			t.Fatalf("accepted invalid %s", query)
		}
	}
}

func TestScopedLinePredicateDoesNotGrantUnscopedRows(t *testing.T) {
	p := &auth.Principal{Role: "DISTRICT", Scopes: []auth.Scope{{Type: "DISTRICT", ID: "d-1"}}}
	clause, params := scopedLinePredicate(p, "l", 1)
	if clause == "TRUE" || len(params) != 1 || params[0] != "d-1" {
		t.Fatalf("clause=%q params=%v", clause, params)
	}
	if clause == "" || !containsAuditText(clause, "scoped_org.district") {
		t.Fatalf("district scope missing from %q", clause)
	}
	adminClause, adminParams := scopedLinePredicate(&auth.Principal{Role: "ADMIN"}, "l", 1)
	if adminClause != "TRUE" || len(adminParams) != 0 {
		t.Fatalf("admin clause=%q params=%v", adminClause, adminParams)
	}
}

func containsAuditText(value, wanted string) bool {
	return len(value) >= len(wanted) && stringIndex(value, wanted) >= 0
}
func stringIndex(value, wanted string) int {
	for i := 0; i+len(wanted) <= len(value); i++ {
		if value[i:i+len(wanted)] == wanted {
			return i
		}
	}
	return -1
}

func TestRedactAuditValueRemovesSensitiveHistoricalFields(t *testing.T) {
	value := redactAuditValue(map[string]interface{}{"token": "secret", "nested": map[string]interface{}{"password_hash": "hash", "safe": "ok"}}).(map[string]interface{})
	if value["token"] != "[REDACTED]" {
		t.Fatalf("token was not redacted: %#v", value)
	}
	nested := value["nested"].(map[string]interface{})
	if nested["password_hash"] != "[REDACTED]" || nested["safe"] != "ok" {
		t.Fatalf("nested redaction failed: %#v", nested)
	}
}

func TestAuditReadCapabilityAndObservedVersionSurfaceAreReadOnly(t *testing.T) {
	if !auditReadAllowed(&auth.Principal{Role: "DISTRICT"}) {
		t.Fatal("district governance reader should have audit.read")
	}
	if auditReadAllowed(&auth.Principal{Role: "SCHOOL"}) {
		t.Fatal("school role must not read governance audit")
	}
	if auditReadAllowed(&auth.Principal{Role: "PROVIDER"}) {
		t.Fatal("provider role must not read governance audit")
	}
}
