package api

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuthClientKeyNormalizesRemotePort(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "[2001:db8::1]:443"
	if got := authClientKey(r); got != "2001:db8::1" {
		t.Fatalf("authClientKey() = %q, want normalized IPv6 host", got)
	}
}

func TestAuthRateLimitRejectsInvalidConfiguration(t *testing.T) {
	t.Setenv("LINKWATCH_TEST_RATE_LIMIT", "0")
	if got := authRateLimit("LINKWATCH_TEST_RATE_LIMIT", 10); got != 10 {
		t.Fatalf("authRateLimit() = %d, want fallback", got)
	}
}

func TestHeartbeatTelemetryOrderRejectsDelayedOlderBoot(t *testing.T) {
	currentBoot := "boot-new"
	currentStarted := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	currentUptime := int64(30)
	olderStarted := currentStarted.Add(-time.Hour)
	newerStarted := currentStarted.Add(time.Hour)

	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, true, "boot-old", &olderStarted, ptrInt64(60), true); accepted || !changed {
		t.Fatalf("older boot accepted: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, true, "boot-newer", &newerStarted, ptrInt64(1), true); !accepted || !changed {
		t.Fatalf("newer boot rejected: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, true, "boot-new", &currentStarted, ptrInt64(29), true); accepted || changed {
		t.Fatalf("stale uptime accepted: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &currentStarted, &currentUptime, true, "boot-new", &currentStarted, ptrInt64(31), true); !accepted || changed {
		t.Fatalf("newer uptime rejected: accepted=%v changed=%v", accepted, changed)
	}
}

func TestHeartbeatTelemetryOrderAcceptsEqualUptimeProbeSnapshot(t *testing.T) {
	currentBoot := "boot-new"
	started := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	uptime := int64(0)
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &started, &uptime, false, "boot-new", &started, ptrInt64(0), true); !accepted || changed {
		t.Fatalf("equal-uptime probe snapshot rejected: accepted=%v changed=%v", accepted, changed)
	}
	if accepted, changed := heartbeatTelemetryOrder(&currentBoot, &started, &uptime, true, "boot-new", &started, ptrInt64(0), true); accepted || changed {
		t.Fatalf("equal-uptime stale snapshot accepted: accepted=%v changed=%v", accepted, changed)
	}
}

func TestHeartbeatHostnamePrefersIncomingValueAndKeepsStoredValueForOldAgents(t *testing.T) {
	stored := "DESKTOP-OLD"
	if got := heartbeatHostname("DESKTOP-NEW", &stored); got != "DESKTOP-NEW" {
		t.Fatalf("incoming hostname was not returned: %#v", got)
	}
	if got := heartbeatHostname("", &stored); got != stored {
		t.Fatalf("stored hostname was not retained: %#v", got)
	}
	if got := heartbeatHostname("", nil); got != nil {
		t.Fatalf("legacy device should keep a nullable hostname: %#v", got)
	}
}

func ptrInt64(value int64) *int64 { return &value }
