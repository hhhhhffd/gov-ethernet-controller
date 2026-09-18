package api

import (
	"bytes"
	"encoding/json"
	"math"
)

type availabilityStatus string

const (
	availabilityValid   availabilityStatus = "VALID"
	availabilityInvalid availabilityStatus = "INVALID"
	availabilityUnknown availabilityStatus = "UNKNOWN"
)

type availabilitySummary struct {
	Valid   int
	Invalid int
	Unknown int
}

func (s availabilitySummary) known() int { return s.Valid + s.Invalid }

func (s availabilitySummary) percent() *float64 {
	known := s.known()
	if known == 0 {
		return nil
	}
	value := float64(s.Valid) / float64(known) * 100
	return &value
}

// availabilitySummaryFields returns the additive report fields shared by all
// aggregate/group/export consumers. Unknown observations are deliberately not
// included in the percentage denominator.
func availabilitySummaryFields(summary availabilitySummary) map[string]interface{} {
	return map[string]interface{}{
		"availability_valid_count":       summary.Valid,
		"availability_invalid_count":     summary.Invalid,
		"availability_unknown_count":     summary.Unknown,
		"availability_known_count":       summary.known(),
		"availability_observation_count": summary.Valid + summary.Invalid + summary.Unknown,
		"availability_percent":           summary.percent(),
		"availability_period": map[string]interface{}{
			"valid_count":   summary.Valid,
			"invalid_count": summary.Invalid,
			"unknown_count": summary.Unknown,
			"known_count":   summary.known(),
			"percent":       summary.percent(),
			"valid":         summary.Valid,
			"invalid":       summary.Invalid,
			"unknown":       summary.Unknown,
		},
	}
}

// availabilityStatusForRow classifies one observation using only immutable
// evaluation data stored with it. A period report must not look up today's
// policy because that would silently re-evaluate historical evidence.
func availabilityStatusForRow(row reportRow) availabilityStatus {
	if !row.Valid || row.Quality != "VALID" || row.Availability == nil {
		return availabilityUnknown
	}
	threshold, ok := availabilityThreshold(row.PolicySnapshot, row.ContractSnapshot)
	if !ok {
		return availabilityUnknown
	}
	if *row.Availability < threshold {
		return availabilityInvalid
	}
	return availabilityValid
}

func addAvailability(summary *availabilitySummary, row reportRow) {
	switch availabilityStatusForRow(row) {
	case availabilityValid:
		summary.Valid++
	case availabilityInvalid:
		summary.Invalid++
	default:
		summary.Unknown++
	}
}

func availabilitySummaryForRows(rows []reportRow) availabilitySummary {
	var summary availabilitySummary
	for _, row := range rows {
		addAvailability(&summary, row)
	}
	return summary
}

// availabilityThreshold resolves the effective threshold preserved with an
// observation. Both policy and contract snapshots may provide one; a
// disagreement is intentionally ambiguous and therefore UNKNOWN.
func availabilityThreshold(policyRaw, contractRaw []byte) (float64, bool) {
	policy, policySet, policyOK := snapshotAvailabilityThreshold(policyRaw)
	contract, contractSet, contractOK := snapshotAvailabilityThreshold(contractRaw)
	if !policyOK || !contractOK {
		return 0, false
	}
	if policySet && contractSet && policy != contract {
		return 0, false
	}
	if policySet {
		return policy, true
	}
	if contractSet {
		return contract, true
	}
	return 0, false
}

// snapshotAvailabilityThreshold returns (value, present, valid). An absent
// or null availability_min is not a malformed snapshot, but it cannot prove
// period availability.
func snapshotAvailabilityThreshold(raw []byte) (float64, bool, bool) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return 0, false, true
	}
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(raw, &snapshot); err != nil || snapshot == nil {
		return 0, false, false
	}
	value, exists := snapshot["availability_min"]
	if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return 0, false, true
	}
	var threshold float64
	if err := json.Unmarshal(value, &threshold); err != nil || math.IsNaN(threshold) || math.IsInf(threshold, 0) {
		return 0, false, false
	}
	return threshold, true, true
}
