package api

import (
	"testing"
)

func TestValidateProviderCaseRootRequiresExactlyOne(t *testing.T) {
	valid := int64(42)
	tests := []struct {
		name string
		item providerCaseCreatePayload
		want bool
	}{
		{"incident", providerCaseCreatePayload{IncidentID: &valid}, true},
		{"line", providerCaseCreatePayload{LineID: "line-1"}, true},
		{"neither", providerCaseCreatePayload{}, false},
		{"both", providerCaseCreatePayload{IncidentID: &valid, LineID: "line-1"}, false},
		{"zero incident", providerCaseCreatePayload{IncidentID: new(int64)}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, _ := validateProviderCaseRoot(test.item)
			if got != test.want {
				t.Fatalf("valid=%v, want %v", got, test.want)
			}
		})
	}
}

func TestProviderCasePeriodIsStrictHalfOpenInterval(t *testing.T) {
	from, to, err := parseProviderCasePeriod(providerCaseCreatePayload{PeriodFrom: "2026-01-01T00:00:00Z", PeriodTo: "2026-01-02T00:00:00Z"})
	if err != nil || from == nil || to == nil || !to.After(*from) {
		t.Fatalf("unexpected valid period: %v", err)
	}
	if _, _, err := parseProviderCasePeriod(providerCaseCreatePayload{PeriodFrom: "2026-01-02T00:00:00Z", PeriodTo: "2026-01-01T00:00:00Z"}); err == nil {
		t.Fatal("reversed period accepted")
	}
	if _, _, err := parseProviderCasePeriod(providerCaseCreatePayload{PeriodFrom: "not-time"}); err == nil {
		t.Fatal("invalid timestamp accepted")
	}
}

func TestProviderCaseOverridesMustMatchCanonicalLine(t *testing.T) {
	line := lineRecord{SchoolID: "school-1", OrganizationID: "org-1", ProviderID: "provider-1"}
	if err := validateProviderCaseOverrides(providerCaseCreatePayload{SchoolID: "school-2"}, line); err == nil {
		t.Fatal("foreign school accepted")
	}
	if err := validateProviderCaseOverrides(providerCaseCreatePayload{OrganizationID: "org-2"}, line); err == nil {
		t.Fatal("foreign organization accepted")
	}
	if err := validateProviderCaseOverrides(providerCaseCreatePayload{ProviderID: "provider-2"}, line); err == nil {
		t.Fatal("foreign provider accepted")
	}
	if err := validateProviderCaseOverrides(providerCaseCreatePayload{SchoolID: "school-1", OrganizationID: "org-1", ProviderID: "provider-1"}, line); err != nil {
		t.Fatalf("canonical overrides rejected: %v", err)
	}
}

func TestProviderCaseSelectedIDsAreStableAndDeduplicated(t *testing.T) {
	ids := (providerCaseCreatePayload{MeasurementIDs: []int64{9, 2, 9, -1}}).selectedIDs()
	want := []int64{2, 9}
	if len(ids) != len(want) || ids[0] != want[0] || ids[1] != want[1] {
		t.Fatalf("got %v, want %v", ids, want)
	}
}
