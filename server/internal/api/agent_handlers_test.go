package api

import (
	"testing"
	"time"
)

func TestHeartbeatTelemetryOrderRejectsDelayedOlderBoot(t *testing.T) {
	currentBoot := "boot-new"
	currentStarted := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	currentUptime := int64(30)
	olderStarted := currentStarted.Add(-time.Hour)
	newerStarted := currentStarted.Add(time.Hour)

	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, "boot-old", &olderStarted, ptrInt64(60)); accepted || !changed {
		t.Fatalf("older boot accepted: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, "boot-newer", &newerStarted, ptrInt64(1)); !accepted || !changed {
		t.Fatalf("newer boot rejected: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, "boot-new", &currentStarted, ptrInt64(29)); accepted || changed {
		t.Fatalf("stale uptime accepted: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, "boot-new", &currentStarted, ptrInt64(31)); !accepted || changed {
		t.Fatalf("newer uptime rejected: accepted=%v changed=%v", accepted, changed)
	}
}

func ptrInt64(value int64) *int64 { return &value }
