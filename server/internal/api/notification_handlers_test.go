package api

import "testing"

func TestNotificationLimitIsBounded(t *testing.T) {
	tests := []struct {
		value string
		want  int
	}{
		{"", 50}, {"0", 50}, {"-2", 50}, {"bad", 50}, {"25", 25}, {"100", 100}, {"101", 100},
	}
	for _, test := range tests {
		if got := notificationLimit(test.value); got != test.want {
			t.Errorf("notificationLimit(%q) = %d, want %d", test.value, got, test.want)
		}
	}
}
