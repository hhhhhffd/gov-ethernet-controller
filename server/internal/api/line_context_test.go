package api

import "testing"

func stringPtr(value string) *string { return &value }

func TestLineContextChangedOnlyForTemporalFields(t *testing.T) {
	previous := linePayload{ProviderID: stringPtr("provider-a"), Technology: "FIBER", TechnologyID: stringPtr("fiber"), Role: "PRIMARY"}
	if lineContextChanged(previous, previous) {
		t.Fatal("identical projection unexpectedly changed context")
	}
	tests := []linePayload{
		{ProviderID: stringPtr("provider-b"), Technology: "FIBER", TechnologyID: stringPtr("fiber"), Role: "PRIMARY"},
		{ProviderID: stringPtr("provider-a"), Technology: "LTE", TechnologyID: stringPtr("lte"), Role: "PRIMARY"},
		{ProviderID: stringPtr("provider-a"), Technology: "FIBER", TechnologyID: stringPtr("fiber"), Role: "RESERVE"},
		{Technology: "FIBER", TechnologyID: stringPtr("fiber"), Role: "PRIMARY"},
	}
	for _, next := range tests {
		if !lineContextChanged(previous, next) {
			t.Fatalf("projection change was not detected: %#v", next)
		}
	}
}

func TestLineContextChangedTreatsNilAndEmptyAsDistinctProjection(t *testing.T) {
	previous := linePayload{Technology: "FIBER", Role: "PRIMARY"}
	next := linePayload{ProviderID: stringPtr("provider-a"), Technology: "FIBER", Role: "PRIMARY"}
	if !lineContextChanged(previous, next) {
		t.Fatal("provider assignment change was not detected")
	}
}
