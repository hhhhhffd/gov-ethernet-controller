package evaluation

import "testing"

func float(value float64) *float64 { return &value }

func TestEvaluateSeparatesBaselineAndContractAxes(t *testing.T) {
	policy := &Policy{ID: 1, ScopeType: "GLOBAL", Version: 1, DownloadMin: 20, UploadMin: 20, PingMax: 100, JitterMax: 30, PacketLossMax: 2, AvailabilityMin: 99}
	contract := &Contract{ID: 2, LineID: "line-1", DownloadMin: float(100), UploadMin: float(100)}
	result := Evaluate(Measurement{ConnectionStatus: "OK", Quality: "VALID", Download: float(45), Upload: float(42)}, policy, contract)
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
