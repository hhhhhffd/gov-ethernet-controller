package api

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/measurements"
)

const (
	controlledProbePayloadSize = 1 << 20
	controlledProbeMaxUpload   = 8 << 20
)

var controlledProbePayload = bytes.Repeat([]byte{0xA5}, controlledProbePayloadSize)

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
		result := measurements.Result{ClientEventID: item.ClientEventID}
		if item.ObservedAt.IsZero() {
			result.Error = "observed_at is required"
			result.ErrorCode = "observed_at_required"
			results = append(results, result)
			continue
		}
		if err := validateDeviceTime(item.ObservedAt); err != nil {
			result.Error = err.Error()
			result.ErrorCode = "clock_skew"
			result.Retryable = true
			results = append(results, result)
			continue
		}
		processed, err := s.Measure.Process(r.Context(), device.ID, device.LineID, device.PointID, device.AgentVersion, item)
		if err != nil {
			result = measurementErrorResult(item.ClientEventID, err)
			results = append(results, result)
			continue
		}
		results = append(results, processed)
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
	writeJSON(w, http.StatusOK, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "results": results, "accepted": accepted, "duplicates": duplicates, "rejected": len(results) - accepted})
}

func measurementErrorResult(clientEventID string, err error) measurements.Result {
	result := measurements.Result{
		ClientEventID: clientEventID,
		Error:         err.Error(),
		ErrorCode:     "internal_error",
		Retryable:     true,
	}
	var inputErr *measurements.InputError
	if errors.As(err, &inputErr) {
		result.ErrorCode = inputErr.Code
		result.Retryable = false
	}
	return result
}

func (s *Server) agentHeartbeat(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	var payload struct {
		AgentVersion    string     `json:"agent_version"`
		SeenAt          *time.Time `json:"seen_at"`
		BootID          string     `json:"boot_id"`
		UptimeSeconds   *int64     `json:"uptime_seconds"`
		QueueDepth      *int64     `json:"queue_depth"`
		LastProbeAt     *time.Time `json:"last_probe_at"`
		LastProbeStatus *string    `json:"last_probe_status"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid heartbeat payload")
		return
	}
	payload.BootID = strings.TrimSpace(payload.BootID)
	if len(payload.BootID) > 128 {
		writeError(w, 422, "boot_id must contain at most 128 characters")
		return
	}
	if payload.UptimeSeconds != nil && *payload.UptimeSeconds < 0 {
		writeError(w, 422, "uptime_seconds must be non-negative")
		return
	}
	if payload.QueueDepth != nil && *payload.QueueDepth < 0 {
		writeError(w, 422, "queue_depth must be non-negative")
		return
	}
	if payload.LastProbeStatus != nil {
		status := strings.ToLower(strings.TrimSpace(*payload.LastProbeStatus))
		if status != "ok" && status != "no_internet" && status != "error" {
			writeError(w, 422, "last_probe_status must be ok, no_internet or error")
			return
		}
		*payload.LastProbeStatus = status
	}
	if payload.LastProbeAt != nil {
		value := payload.LastProbeAt.UTC().Truncate(time.Second)
		payload.LastProbeAt = &value
	}
	// seen_at is accepted for wire compatibility, but last_seen is
	// authoritative server receipt time. Agent clocks must not be able to move
	// fleet state into the future or make a stale retry look fresh.
	receivedAt := time.Now().UTC().Truncate(time.Second)
	if payload.AgentVersion == "" {
		payload.AgentVersion = device.AgentVersion
	}
	var lastSeen time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `
WITH heartbeat_state AS (
    SELECT id,
           ($3::text <> '' AND (
               agent_boot_id IS NULL
               OR agent_boot_id <> $3
               OR $4::bigint IS NULL
               OR agent_uptime_seconds IS NULL
               OR $4::bigint > agent_uptime_seconds
           )) AS accept_telemetry,
           ($3::text <> '' AND (agent_boot_id IS NULL OR agent_boot_id <> $3)) AS boot_changed
    FROM devices
    WHERE id=$8
)
UPDATE devices AS d
SET last_seen=GREATEST(COALESCE(d.last_seen,$1),$1),
    agent_version=$2,
    agent_boot_id=CASE WHEN heartbeat_state.accept_telemetry THEN NULLIF($3::text,'') ELSE d.agent_boot_id END,
    agent_uptime_seconds=CASE WHEN heartbeat_state.accept_telemetry THEN $4::bigint ELSE d.agent_uptime_seconds END,
    agent_queue_depth=CASE WHEN heartbeat_state.accept_telemetry THEN $5::bigint ELSE d.agent_queue_depth END,
    agent_last_probe_at=CASE
        WHEN heartbeat_state.accept_telemetry AND heartbeat_state.boot_changed THEN $6::timestamptz
        WHEN heartbeat_state.accept_telemetry AND $6::timestamptz IS NOT NULL THEN $6::timestamptz
        ELSE d.agent_last_probe_at
    END,
    agent_last_probe_status=CASE
        WHEN heartbeat_state.accept_telemetry AND heartbeat_state.boot_changed THEN $7::text
        WHEN heartbeat_state.accept_telemetry AND $7::text IS NOT NULL THEN $7::text
        ELSE d.agent_last_probe_status
    END,
    agent_telemetry_received_at=CASE
        WHEN heartbeat_state.accept_telemetry THEN $1
        ELSE d.agent_telemetry_received_at
    END
FROM heartbeat_state
WHERE d.id=heartbeat_state.id
RETURNING d.last_seen`, receivedAt, payload.AgentVersion, payload.BootID, payload.UptimeSeconds, payload.QueueDepth, payload.LastProbeAt, payload.LastProbeStatus, device.ID).Scan(&lastSeen); err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "last_seen": lastSeen, "agent_version": payload.AgentVersion})
}

func (s *Server) agentConfig(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	var testsPerDay, jitter, light int
	scheduleErr := s.DB.Pool.QueryRow(r.Context(), `SELECT tests_per_day,jitter_minutes,light_checks_between FROM agent_schedules WHERE id=1`).Scan(&testsPerDay, &jitter, &light)
	if scheduleErr != nil && !errors.Is(scheduleErr, pgx.ErrNoRows) {
		writeError(w, 500, "could not load agent schedule")
		return
	}
	if errors.Is(scheduleErr, pgx.ErrNoRows) {
		testsPerDay, jitter, light = 4, 8, 0
	}
	var policyID, version, confirmCount, confirmMinutes, recoveryCount, recoveryMinutes, freshness int
	var downloadMin, uploadMin, pingMax, jitterMax, lossMax, availabilityMin float64
	var scopeType, scopeID string
	var validFrom time.Time
	var validTo *time.Time
	policyErr := s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`, device.LineID).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &recoveryCount, &recoveryMinutes, &freshness)
	if policyErr != nil && !errors.Is(policyErr, pgx.ErrNoRows) {
		writeError(w, 500, "could not load line policy")
		return
	}
	if errors.Is(policyErr, pgx.ErrNoRows) {
		policyErr = s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &recoveryCount, &recoveryMinutes, &freshness)
		if policyErr != nil && !errors.Is(policyErr, pgx.ErrNoRows) {
			writeError(w, 500, "could not load global policy")
			return
		}
	}
	policy := map[string]interface{}{}
	if policyErr == nil {
		policy = map[string]interface{}{"id": policyID, "scope_type": scopeType, "scope_id": scopeID, "version": version, "valid_from": validFrom, "valid_to": validTo, "download_min": downloadMin, "upload_min": uploadMin, "ping_max": pingMax, "jitter_max": jitterMax, "packet_loss_max": lossMax, "availability_min": availabilityMin, "confirm_count": confirmCount, "confirm_minutes": confirmMinutes, "recovery_count": recoveryCount, "recovery_minutes": recoveryMinutes, "freshness_seconds": freshness}
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "monitoring_point_id": device.PointID, "schedule": map[string]interface{}{"tests_per_day": testsPerDay, "performance_tests_per_day": testsPerDay, "jitter_minutes": jitter, "light_checks_between": light > 0}, "policy": policy})
}

// agentProbeDownload and agentProbeUpload provide an optional controlled
// endpoint for production throughput measurements. Authentication is the same
// device authentication as telemetry ingest, while the payload is bounded so
// a probe cannot turn the server into an unbounded memory or disk sink.
func (s *Server) agentProbeDownload(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.device(w, r); !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "linkwatch-probe.bin", time.Time{}, bytes.NewReader(controlledProbePayload))
}

func (s *Server) agentProbeUpload(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.device(w, r); !ok {
		return
	}
	defer r.Body.Close()
	reader := http.MaxBytesReader(w, r.Body, controlledProbeMaxUpload)
	bytesReceived, err := io.Copy(io.Discard, reader)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "probe upload exceeds the maximum size")
		return
	}
	if bytesReceived == 0 {
		writeError(w, http.StatusUnprocessableEntity, "probe upload must contain bytes")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
