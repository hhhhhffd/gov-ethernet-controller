package api

import (
	"testing"

	"linkwatch/server/internal/auth"
)

func TestLiveVerifySampleIsBounded(t *testing.T) {
	if liveVerifySampleLimit < 1 || liveVerifySampleLimit > 4 {
		t.Fatalf("sample limit must remain bounded, got %d", liveVerifySampleLimit)
	}
}

func TestLiveVerifyRequiresSituationManagementCapability(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{role: "ADMIN", want: true},
		{role: "DISTRICT", want: true},
		{role: "PROVIDER", want: false},
		{role: "SCHOOL", want: false},
	}
	for _, test := range tests {
		t.Run(test.role, func(t *testing.T) {
			got := situationManageAllowed(&auth.Principal{Role: test.role})
			if got != test.want {
				t.Fatalf("situationManageAllowed(%q) = %v, want %v", test.role, got, test.want)
			}
		})
	}
}
