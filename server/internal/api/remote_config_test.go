package api

import "testing"

func TestValidateRemoteConfigRejectsUnsupportedAndUnsafeValues(t *testing.T) {
	if err := validateRemoteConfig(map[string]interface{}{"schedule": map[string]interface{}{"performance_tests_per_day": float64(4)}, "probe": map[string]interface{}{"timeout_seconds": float64(10)}}); err != nil {
		t.Fatal(err)
	}
	if err := validateRemoteConfig(map[string]interface{}{"credentials": map[string]interface{}{}}); err == nil {
		t.Fatal("credentials must never be remotely configurable")
	}
	if err := validateRemoteConfig(map[string]interface{}{"schedule": map[string]interface{}{"performance_tests_per_day": float64(99)}}); err == nil {
		t.Fatal("unsafe schedule must be rejected")
	}
}
