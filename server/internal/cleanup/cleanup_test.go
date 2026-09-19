package cleanup

import (
	"strings"
	"testing"
)

func TestSyntheticRulesAreExplicit(t *testing.T) {
	for _, value := range append(append(append([]string{}, demoOrganizationIDs...), demoProviderIDs...), demoDeviceIDs...) {
		if strings.TrimSpace(value) == "" {
			t.Fatalf("empty deterministic synthetic ID")
		}
	}
	for _, prefix := range syntheticTestPrefixes {
		if prefix == "" || prefix == "%" || strings.HasPrefix(prefix, "%") {
			t.Fatalf("unsafe synthetic test prefix %q", prefix)
		}
	}
	for _, spec := range deleteSpecs {
		upper := strings.ToUpper(spec.query)
		if strings.Contains(upper, "DROP SCHEMA") || strings.Contains(upper, "TRUNCATE") || strings.Contains(upper, "CASCADE") {
			t.Fatalf("destructive blanket operation in %s: %s", spec.table, spec.query)
		}
	}
}

func TestApplyRequiresExplicitNonProductionTarget(t *testing.T) {
	base := Options{Apply: true, ConfirmApply: true, Environment: "test", ConfirmTarget: "linkwatch_test"}
	if err := ValidateApplyOptions(base, "linkwatch_test"); err != nil {
		t.Fatalf("valid test target rejected: %v", err)
	}
	cases := []Options{
		{Apply: true, Environment: "test", ConfirmTarget: "linkwatch_test"},
		{Apply: true, ConfirmApply: true, Environment: "production", ConfirmTarget: "linkwatch_test"},
		{Apply: true, ConfirmApply: true, Environment: "test", ConfirmTarget: "other"},
		{Apply: true, ConfirmApply: true, Environment: "test"},
	}
	for index, options := range cases {
		if err := ValidateApplyOptions(options, "linkwatch_test"); err == nil {
			t.Errorf("guard case %d unexpectedly accepted", index)
		}
	}
	if err := ValidateApplyOptions(base, "linkwatch_production"); err == nil {
		t.Fatal("production-looking database unexpectedly accepted")
	}
}

func TestDeleteOrderFollowsForeignKeys(t *testing.T) {
	position := make(map[string]int, len(deleteSpecs))
	for index, spec := range deleteSpecs {
		position[spec.table] = index
	}
	for child, parent := range map[string]string{
		"measurement_evaluations":         "measurements",
		"measurement_verifications":       "measurements",
		"provider_case_draft_generations": "provider_cases",
		"incident_events":                 "incidents",
		"situation_members":               "incidents",
		"agent_commands":                  "devices",
		"live_verify_results":             "agent_commands",
		"agent_update_attempts":           "devices",
		"monitoring_points":               "lines",
		"lines":                           "organizations",
	} {
		if position[child] >= position[parent] {
			t.Errorf("%s must be deleted before %s", child, parent)
		}
	}
}

func TestProtectedCategoriesHaveNoDeletePlan(t *testing.T) {
	protected := map[string]bool{}
	for _, spec := range reportSpecs {
		if spec.rule == "protected: auth users are never selected" || spec.rule == "protected: auth access is never selected" || spec.rule == "protected: sessions are never selected" || spec.rule == "protected: audit history is never selected" || spec.rule == "protected: migrations are never selected" {
			protected[spec.table] = true
		}
	}
	for _, spec := range deleteSpecs {
		if protected[spec.table] {
			t.Fatalf("protected table %s has a delete plan", spec.table)
		}
	}
}
