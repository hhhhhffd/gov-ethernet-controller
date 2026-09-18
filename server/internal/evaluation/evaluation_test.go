package evaluation

import "testing"

func float(value float64) *float64 { return &value }

func TestEvaluateSeparatesBaselineAndContractAxes(t *testing.T) {
	policy := &Policy{ID: 1, ScopeType: "GLOBAL", Version: 1, DownloadMin: 20, UploadMin: 20, PingMax: 100, JitterMax: 30, PacketLossMax: 2, AvailabilityMin: 99}
	contract := &Contract{ID: 2, LineID: "line-1", DownloadMin: float(100), UploadMin: float(100)}
	result := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "VALID", Download: float(45), Upload: float(42), Ping: float(30), Jitter: float(5), PacketLoss: float(0), Availability: float(100)}, policy, contract)
	if result.BaselineState != "OK" {
		t.Fatalf("baseline state = %q, want OK", result.BaselineState)
	}
	if result.ContractState != "DEVIATES" {
		t.Fatalf("contract state = %q, want DEVIATES", result.ContractState)
	}
	if len(result.Violations) != 2 || result.Violations[0].Code != "CONTRACT_DOWNLOAD" {
		t.Fatalf("unexpected violations: %#v", result.Violations)
	}
}

func TestEvaluateMissingPolicyMetricDoesNotBecomeOK(t *testing.T) {
	policy := &Policy{DownloadMin: 20, UploadMin: 20, PingMax: 100, JitterMax: 30, PacketLossMax: 2, AvailabilityMin: 99}
	result := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "VALID", Download: float(45), Upload: float(42), Jitter: float(5), PacketLoss: float(0), Availability: float(100)}, policy, nil)
	if result.BaselineState != "UNKNOWN" {
		t.Fatalf("baseline state = %q, want UNKNOWN", result.BaselineState)
	}
	if result.ContractState != "UNKNOWN" {
		t.Fatalf("contract state = %q, want UNKNOWN without contract", result.ContractState)
	}
	if result.BaselineState == "OK" || result.ContractState == "MEETS" {
		t.Fatal("missing required metric must not produce a positive aggregate state")
	}
}

func TestEvaluateMetricStates(t *testing.T) {
	threshold := 10.0
	tests := []struct {
		name      string
		actual    *float64
		threshold *float64
		want      string
	}{
		{name: "missing", want: metricUnknown},
		{name: "observed", actual: float(5), want: metricObserved},
		{name: "ok", actual: float(15), threshold: &threshold, want: metricOK},
		{name: "violation", actual: float(5), threshold: &threshold, want: metricViolation},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, violation := evaluateMetric("download", test.actual, test.threshold, "<", "BASELINE_DOWNLOAD")
			if state != test.want {
				t.Fatalf("state = %q, want %q", state, test.want)
			}
			if (state == metricViolation) != (violation != nil) {
				t.Fatalf("violation = %#v for state %q", violation, state)
			}
		})
	}
}

func TestEvaluateMissingContractMetricDoesNotBecomeMeets(t *testing.T) {
	contract := &Contract{DownloadMin: float(100)}
	result := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "VALID", Upload: float(42)}, nil, contract)
	if result.ContractState != "UNKNOWN" {
		t.Fatalf("contract state = %q, want UNKNOWN", result.ContractState)
	}
}

func TestEvaluateSuspectIsNotAuthoritative(t *testing.T) {
	policy := &Policy{DownloadMin: 20, UploadMin: 20, PingMax: 100, JitterMax: 30, PacketLossMax: 2, AvailabilityMin: 99}
	result := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "SUSPECT", Download: float(1), Upload: float(1), Ping: float(200), Jitter: float(50), PacketLoss: float(5), Availability: float(50)}, policy, nil)
	if result.Valid {
		t.Fatal("SUSPECT measurement must not be valid evidence")
	}
	if result.BaselineState != "UNKNOWN" || result.ContractState != "UNKNOWN" {
		t.Fatalf("suspect result states = (%q, %q), want UNKNOWN/UNKNOWN", result.BaselineState, result.ContractState)
	}
	if len(result.Violations) != 0 {
		t.Fatalf("suspect measurement must not emit authoritative violations: %#v", result.Violations)
	}
}

func TestEvaluateNoInternetAndInvalidMeasurement(t *testing.T) {
	policy := &Policy{DownloadMin: 20, UploadMin: 20, PingMax: 100, JitterMax: 30, PacketLossMax: 2, AvailabilityMin: 99}
	noInternet := Evaluate(Measurement{ConnectionStatus: "NO_INTERNET", Quality: "VALID"}, policy, nil)
	if noInternet.BaselineState != "VIOLATION" || len(noInternet.Violations) != 1 || noInternet.Violations[0].Code != "NO_INTERNET" {
		t.Fatalf("unexpected no-internet result: %#v", noInternet)
	}
	invalid := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "INVALID", Download: float(1)}, policy, nil)
	if invalid.Valid || invalid.BaselineState != "UNKNOWN" || len(invalid.Violations) != 0 {
		t.Fatalf("unexpected invalid result: %#v", invalid)
	}
}

func TestSnapshotsRetainEffectiveConfiguration(t *testing.T) {
	policy := &Policy{ID: 7, ScopeType: "LINE", ScopeID: "line-7", Version: 3, ValidFrom: "2026-01-01T00:00:00Z", DownloadMin: 17}
	snapshot := SnapshotPolicy(policy)
	snapshot["download_min"] = 99
	if policy.DownloadMin != 17 {
		t.Fatal("snapshot mutation changed policy")
	}
	if SnapshotContract(nil) == nil {
		t.Fatal("nil contract snapshot must be an empty object")
	}
}
