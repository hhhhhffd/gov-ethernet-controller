package api

import (
	"testing"

	"linkwatch/server/internal/evaluation"
)

func TestImpactPreviewUsesHistoricalSnapshotsAndChangesOnlyProjection(t *testing.T) {
	threshold := 50.0
	metric := func(value float64) *float64 { return &value }
	row := reportRow{measurementRecord: measurementRecord{LineID: "line-1", ConnectionStatus: "OK", Quality: "VALID", Download: metric(80), Upload: metric(10), Ping: metric(20), Jitter: metric(5), PacketLoss: metric(1), Availability: metric(100), BaselineState: "VIOLATION", ContractState: "UNKNOWN", PolicySnapshot: []byte(`{"version":3,"download_min":50,"upload_min":1,"ping_max":100,"jitter_max":30,"packet_loss_max":2,"availability_min":99}`), ContractSnapshot: []byte(`{"id":4,"download_min":null}`)}}
	var policySnapshot = map[string]interface{}{"version": float64(3), "download_min": float64(50), "upload_min": float64(1), "ping_max": float64(100), "jitter_max": float64(30), "packet_loss_max": float64(2), "availability_min": float64(99)}
	proposal := impactPolicyProposal{DownloadMin: &threshold}
	result := evaluation.Evaluate(impactMeasurement(row), impactPolicy(policySnapshot, proposal), impactContract(map[string]interface{}{"id": float64(4)}, impactContractProposal{}, row.LineID))
	if result.BaselineState != "OK" {
		t.Fatalf("preview baseline state = %q, want OK", result.BaselineState)
	}
	if row.BaselineState != "VIOLATION" {
		t.Fatal("preview mutated historical evaluation state")
	}
}

func TestImpactPreviewRetainsUnknownHistoricalEvidence(t *testing.T) {
	row := reportRow{measurementRecord: measurementRecord{LineID: "line-1", ConnectionStatus: "OK", Quality: "SUSPECT", PolicySnapshot: []byte(`{"version":2}`)}}
	result := evaluation.Evaluate(impactMeasurement(row), impactPolicy(map[string]interface{}{"download_min": float64(50)}, impactPolicyProposal{}), nil)
	if result.Valid || result.BaselineState != "UNKNOWN" || result.Reason != "measurement marked SUSPECT" {
		t.Fatalf("preview did not preserve uncertainty: %#v", result)
	}
}

func TestImpactPreviewRejectsEmptyOrInvalidProposal(t *testing.T) {
	if !impactProposalEmpty(impactPreviewRequest{}) {
		t.Fatal("empty proposal was not detected")
	}
	value := -1.0
	if impactProposalValid(impactPreviewRequest{Policy: impactPolicyProposal{DownloadMin: &value}}) {
		t.Fatal("negative proposal threshold accepted")
	}
	valid := 20.0
	if impactProposalEmpty(impactPreviewRequest{Policy: impactPolicyProposal{DownloadMin: &valid}}) {
		t.Fatal("non-empty proposal rejected as empty")
	}
}
