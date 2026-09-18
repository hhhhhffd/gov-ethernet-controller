package api

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"time"
)

type availabilityIntervalState string

const (
	availabilityAvailable   availabilityIntervalState = "AVAILABLE"
	availabilityUnavailable availabilityIntervalState = "UNAVAILABLE"
	availabilityNoData      availabilityIntervalState = "NO_DATA"
)

// availabilityInterval is a classified, half-open interval [Start, End).
// Intervals are deliberately independent of the current line state: callers
// build them from historical line_state_events for the requested period.
type availabilityInterval struct {
	Start time.Time
	End   time.Time
	State availabilityIntervalState
}

type periodAvailability struct {
	PeriodStart, PeriodEnd time.Time
	AvailabilityPct        *float64
	Threshold              *float64
	Status                 string
	ObservedDuration       time.Duration
	UnavailableDuration    time.Duration
	NoDataDuration         time.Duration
	DataCompletenessPct    float64
}

func classifyAvailabilityState(dataState, connectionState string) availabilityIntervalState {
	if dataState != "FRESH" {
		return availabilityNoData
	}
	if connectionState == "NO_INTERNET" {
		return availabilityUnavailable
	}
	if connectionState == "OK" || connectionState == "DEGRADED" {
		return availabilityAvailable
	}
	return availabilityNoData
}

// summarizeAvailability clips and normalizes historical intervals. Gaps are
// NO_DATA, never healthy or outage. A minimum completeness of zero disables
// the gate; the reporting contract currently uses the existing 80% rule.
func summarizeAvailability(start, end time.Time, intervals []availabilityInterval, threshold *float64, minimumCompleteness float64) periodAvailability {
	result := periodAvailability{PeriodStart: start, PeriodEnd: end, Threshold: threshold, Status: "UNKNOWN"}
	if !start.Before(end) {
		return result
	}
	clipped := make([]availabilityInterval, 0, len(intervals))
	for _, item := range intervals {
		if !item.End.After(item.Start) || !item.End.After(start) || !item.Start.Before(end) {
			continue
		}
		if item.Start.Before(start) {
			item.Start = start
		}
		if item.End.After(end) {
			item.End = end
		}
		if item.Start.Before(item.End) {
			clipped = append(clipped, item)
		}
	}
	sort.SliceStable(clipped, func(i, j int) bool { return clipped[i].Start.Before(clipped[j].Start) })
	cursor := start
	add := func(state availabilityIntervalState, from, to time.Time) {
		if !to.After(from) {
			return
		}
		d := to.Sub(from)
		switch state {
		case availabilityAvailable:
			result.ObservedDuration += d
		case availabilityUnavailable:
			result.ObservedDuration += d
			result.UnavailableDuration += d
		default:
			result.NoDataDuration += d
		}
	}
	for _, item := range clipped {
		if item.Start.After(cursor) {
			add(availabilityNoData, cursor, item.Start)
		}
		from := item.Start
		if from.Before(cursor) {
			from = cursor
		}
		if item.End.After(from) {
			add(item.State, from, item.End)
			cursor = item.End
		}
	}
	if cursor.Before(end) {
		add(availabilityNoData, cursor, end)
	}
	total := end.Sub(start)
	result.DataCompletenessPct = float64(result.ObservedDuration) / float64(total) * 100
	if result.ObservedDuration > 0 {
		value := float64(result.ObservedDuration-result.UnavailableDuration) / float64(result.ObservedDuration) * 100
		result.AvailabilityPct = &value
	}
	if result.AvailabilityPct != nil && (minimumCompleteness <= 0 || result.DataCompletenessPct >= minimumCompleteness) && threshold != nil {
		if *result.AvailabilityPct >= *threshold {
			result.Status = "PASS"
		} else {
			result.Status = "FAIL"
		}
	}
	return result
}

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

func periodStatus(summary availabilitySummary, completeness float64, threshold *float64) string {
	if threshold == nil || summary.percent() == nil || completeness < 80 {
		return "UNKNOWN"
	}
	if *summary.percent() >= *threshold {
		return "PASS"
	}
	return "FAIL"
}

func commonAvailabilityThreshold(rows []reportRow) *float64 {
	var result *float64
	for _, row := range rows {
		threshold, ok := availabilityThreshold(row.PolicySnapshot, row.ContractSnapshot)
		if !ok {
			continue
		}
		if result != nil && *result != threshold {
			return nil
		}
		value := threshold
		result = &value
	}
	return result
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
