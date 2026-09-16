package api

import (
	"net/http"
	"time"

	"linkwatch/server/internal/measurements"
)

func (s *Server) agentBatch(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	var payload struct {
		Measurements []measurements.Input `json:"measurements"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid measurement payload")
		return
	}
	if len(payload.Measurements) < 1 || len(payload.Measurements) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "measurements must contain 1-500 items")
		return
	}
	results := make([]measurements.Result, 0, len(payload.Measurements))
	for _, item := range payload.Measurements {
		if item.ObservedAt.IsZero() {
			writeError(w, http.StatusUnprocessableEntity, "observed_at is required")
			return
		}
		if err := validateDeviceTime(item.ObservedAt); err != nil {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		result, err := s.Measure.Process(r.Context(), device.ID, device.LineID, device.PointID, device.AgentVersion, item)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		results = append(results, result)
	}
	accepted, duplicates := 0, 0
	for _, result := range results {
		if result.Accepted {
			accepted++
		}
		if result.Duplicate {
			duplicates++
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "results": results, "accepted": accepted, "duplicates": duplicates})
}

func (s *Server) agentHeartbeat(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	var payload struct {
		AgentVersion string     `json:"agent_version"`
		SeenAt       *time.Time `json:"seen_at"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid heartbeat payload")
		return
	}
	seenAt := time.Now().UTC().Truncate(time.Second)
	if payload.SeenAt != nil {
		if err := validateDeviceTime(*payload.SeenAt); err != nil {
			writeError(w, 422, err.Error())
			return
		}
		seenAt = payload.SeenAt.UTC().Truncate(time.Second)
	}
	if payload.AgentVersion == "" {
		payload.AgentVersion = device.AgentVersion
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE devices SET last_seen=$1,agent_version=$2 WHERE id=$3`, seenAt, payload.AgentVersion, device.ID); err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "last_seen": seenAt, "agent_version": payload.AgentVersion})
}

func (s *Server) agentConfig(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	var testsPerDay, jitter, light int
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT tests_per_day,jitter_minutes,light_checks_between FROM agent_schedules WHERE id=1`).Scan(&testsPerDay, &jitter, &light); err != nil {
		testsPerDay, jitter, light = 4, 8, 0
	}
	var policyID, version, confirmCount, confirmMinutes, recoveryCount, recoveryMinutes, freshness int
	var downloadMin, uploadMin, pingMax, jitterMax, lossMax, availabilityMin float64
	var scopeType, scopeID string
	var validFrom time.Time
	var validTo *time.Time
	policyErr := s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`, device.LineID).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &recoveryCount, &recoveryMinutes, &freshness)
	if policyErr != nil {
		policyErr = s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &recoveryCount, &recoveryMinutes, &freshness)
	}
	policy := map[string]interface{}{}
	if policyErr == nil {
		policy = map[string]interface{}{"id": policyID, "scope_type": scopeType, "scope_id": scopeID, "version": version, "valid_from": validFrom, "valid_to": validTo, "download_min": downloadMin, "upload_min": uploadMin, "ping_max": pingMax, "jitter_max": jitterMax, "packet_loss_max": lossMax, "availability_min": availabilityMin, "confirm_count": confirmCount, "confirm_minutes": confirmMinutes, "recovery_count": recoveryCount, "recovery_minutes": recoveryMinutes, "freshness_seconds": freshness}
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "monitoring_point_id": device.PointID, "schedule": map[string]interface{}{"tests_per_day": testsPerDay, "performance_tests_per_day": testsPerDay, "jitter_minutes": jitter, "light_checks_between": light > 0}, "policy": policy})
}
