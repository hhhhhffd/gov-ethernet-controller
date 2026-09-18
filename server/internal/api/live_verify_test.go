package api

import "testing"

func TestLiveVerifySampleIsBounded(t *testing.T) {
	if liveVerifySampleLimit < 1 || liveVerifySampleLimit > 4 {
		t.Fatalf("sample limit must remain bounded, got %d", liveVerifySampleLimit)
	}
}
