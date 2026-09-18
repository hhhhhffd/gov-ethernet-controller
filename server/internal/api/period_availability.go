package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

// historicalPeriodAvailability reads the append-only state history. The
// current line_states row is intentionally not used: it would re-label a
// historical period after a later recovery or policy change.
func (s *Server) historicalPeriodAvailability(ctx context.Context, r *http.Request, p *auth.Principal, start, end time.Time) (periodAvailability, error) {
	lines, err := s.reportLineIDs(ctx, r, p, false)
	if err != nil {
		return periodAvailability{}, err
	}
	result := periodAvailability{PeriodStart: start, PeriodEnd: end, Status: "UNKNOWN", NoDataDuration: end.Sub(start) * time.Duration(len(lines))}
	if len(lines) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(lines))
	args := []interface{}{}
	for i, line := range lines {
		placeholders[i] = "$" + itoa(i+1)
		args = append(args, line)
	}
	endArg := len(args) + 1
	args = append(args, end)
	rows, err := s.DB.Pool.Query(ctx, `SELECT line_id,data_state,connection_state,COALESCE(effective_since,occurred_at),config_snapshot_json FROM line_state_events WHERE line_id IN (`+strings.Join(placeholders, ",")+`) AND occurred_at < $`+itoa(endArg)+` ORDER BY line_id,COALESCE(effective_since,occurred_at),id`, args...)
	if err != nil {
		return periodAvailability{}, err
	}
	defer rows.Close()
	type event struct {
		at        time.Time
		state     availabilityIntervalState
		threshold *float64
	}
	byLine := map[string][]event{}
	for rows.Next() {
		var line, data, connection string
		var at time.Time
		var snapshot []byte
		if err := rows.Scan(&line, &data, &connection, &at, &snapshot); err != nil {
			return periodAvailability{}, err
		}
		byLine[line] = append(byLine[line], event{at: at, state: classifyAvailabilityState(data, connection), threshold: configAvailabilityThreshold(snapshot)})
	}
	if err := rows.Err(); err != nil {
		return periodAvailability{}, err
	}
	var commonThreshold *float64
	for _, line := range lines {
		events := byLine[line]
		intervals := make([]availabilityInterval, 0, len(events))
		var threshold *float64
		thresholdConflict := false
		for i, item := range events {
			if item.at.Before(end) {
				to := end
				if i+1 < len(events) && events[i+1].at.Before(to) {
					to = events[i+1].at
				}
				intervals = append(intervals, availabilityInterval{Start: item.at, End: to, State: item.state})
			}
			if item.threshold != nil {
				if threshold != nil && *threshold != *item.threshold {
					thresholdConflict = true
				}
				if threshold == nil && !thresholdConflict {
					value := *item.threshold
					threshold = &value
				}
			}
		}
		if thresholdConflict {
			threshold = nil
		}
		lineResult := summarizeAvailability(start, end, intervals, threshold, 80)
		if threshold != nil {
			if commonThreshold != nil && *commonThreshold != *threshold {
				commonThreshold = nil
			}
			if commonThreshold == nil {
				value := *threshold
				commonThreshold = &value
			}
		}
		result.ObservedDuration += lineResult.ObservedDuration
		result.UnavailableDuration += lineResult.UnavailableDuration
		result.NoDataDuration += lineResult.NoDataDuration - end.Sub(start)
	}
	total := end.Sub(start) * time.Duration(len(lines))
	if total > 0 {
		result.DataCompletenessPct = float64(result.ObservedDuration) / float64(total) * 100
	}
	if result.ObservedDuration > 0 {
		value := float64(result.ObservedDuration-result.UnavailableDuration) / float64(result.ObservedDuration) * 100
		result.AvailabilityPct = &value
	}
	result.Threshold = commonThreshold
	if result.AvailabilityPct != nil && result.DataCompletenessPct >= 80 && commonThreshold != nil {
		if *result.AvailabilityPct >= *commonThreshold {
			result.Status = "PASS"
		} else {
			result.Status = "FAIL"
		}
	}
	return result, nil
}

func configAvailabilityThreshold(raw []byte) *float64 {
	var config map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &config) != nil {
		return nil
	}
	for _, key := range []string{"policy", "contract"} {
		var snapshot map[string]json.RawMessage
		if json.Unmarshal(config[key], &snapshot) != nil {
			continue
		}
		if value, ok := snapshot["availability_min"]; ok {
			var threshold float64
			if json.Unmarshal(value, &threshold) == nil {
				return &threshold
			}
		}
	}
	return nil
}
