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
			var timeErr *deviceTimeError
			if errors.As(err, &timeErr) {
				result.ErrorCode = timeErr.code
				result.Retryable = timeErr.retryable
			}
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
	writeJSON(w, http.StatusOK, map[string]interface{}{"device_id": device.ID, "hostname": device.Hostname, "line_id": device.LineID, "results": results, "accepted": accepted, "duplicates": duplicates, "rejected": len(results) - accepted})
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
		Hostname        string     `json:"hostname"`
		SeenAt          *time.Time `json:"seen_at"`
		BootID          string     `json:"boot_id"`
		BootStartedAt   *time.Time `json:"boot_started_at"`
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
	payload.Hostname = strings.TrimSpace(payload.Hostname)
	if len(payload.Hostname) > 255 {
		writeError(w, 422, "hostname must contain at most 255 characters")
		return
	}
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
	if payload.BootStartedAt != nil {
		value := payload.BootStartedAt.UTC()
		payload.BootStartedAt = &value
	}
	// seen_at is accepted for wire compatibility, but last_seen is
	// authoritative server receipt time. Agent clocks must not be able to move
	// fleet state into the future or make a stale retry look fresh.
	receivedAt := time.Now().UTC().Truncate(time.Second)
	if payload.AgentVersion == "" {
		payload.AgentVersion = device.AgentVersion
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var currentLastSeen, currentBootStartedAt *time.Time
	var currentBootID *string
	var currentUptime *int64
	var currentLastProbeAt *time.Time
	var currentLastProbeStatus *string
	if err := tx.QueryRow(r.Context(), `SELECT last_seen,agent_boot_id,agent_boot_started_at,agent_uptime_seconds,agent_last_probe_at,agent_last_probe_status FROM devices WHERE id=$1 FOR UPDATE`, device.ID).Scan(&currentLastSeen, &currentBootID, &currentBootStartedAt, &currentUptime, &currentLastProbeAt, &currentLastProbeStatus); err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	acceptTelemetry, bootChanged := heartbeatTelemetryOrder(
		currentBootID,
		currentBootStartedAt,
		currentUptime,
		currentLastProbeAt != nil || currentLastProbeStatus != nil,
		payload.BootID,
		payload.BootStartedAt,
		payload.UptimeSeconds,
		payload.LastProbeAt != nil || payload.LastProbeStatus != nil,
	)
	lastSeen := receivedAt
	if currentLastSeen != nil && currentLastSeen.After(lastSeen) {
		lastSeen = *currentLastSeen
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE devices
SET last_seen=$1,
    hostname=COALESCE(NULLIF($12::text,''),hostname),
    agent_version=CASE WHEN $3 OR agent_boot_id IS NULL THEN $2 ELSE agent_version END,
    agent_boot_id=CASE WHEN $3 THEN NULLIF($4::text,'') ELSE agent_boot_id END,
    agent_boot_started_at=CASE WHEN $3 THEN $5::timestamptz ELSE agent_boot_started_at END,
    agent_uptime_seconds=CASE WHEN $3 THEN $6::bigint ELSE agent_uptime_seconds END,
    agent_queue_depth=CASE WHEN $3 THEN $7::bigint ELSE agent_queue_depth END,
    agent_last_probe_at=CASE
        WHEN NOT $3 THEN agent_last_probe_at
        WHEN $8 THEN $9::timestamptz
        WHEN $9::timestamptz IS NOT NULL THEN $9::timestamptz
        ELSE agent_last_probe_at
    END,
    agent_last_probe_status=CASE
        WHEN NOT $3 THEN agent_last_probe_status
        WHEN $8 THEN $10::text
        WHEN $10::text IS NOT NULL THEN $10::text
        ELSE agent_last_probe_status
    END,
    agent_telemetry_received_at=CASE WHEN $3 THEN $1 ELSE agent_telemetry_received_at END
WHERE id=$11`, lastSeen, payload.AgentVersion, acceptTelemetry, payload.BootID, payload.BootStartedAt, payload.UptimeSeconds, payload.QueueDepth, bootChanged, payload.LastProbeAt, payload.LastProbeStatus, device.ID, payload.Hostname); err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not store heartbeat")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "line_id": device.LineID, "hostname": heartbeatHostname(payload.Hostname, device.Hostname), "last_seen": lastSeen, "agent_version": payload.AgentVersion})
}

func heartbeatHostname(value string, fallback *string) interface{} {
	if value != "" {
		return value
	}
	if fallback == nil {
		return nil
	}
	return *fallback
}

func heartbeatTelemetryOrder(currentBootID *string, currentBootStartedAt *time.Time, currentUptime *int64, currentHasProbe bool, incomingBootID string, incomingBootStartedAt *time.Time, incomingUptime *int64, incomingHasProbe bool) (accept, bootChanged bool) {
	if incomingBootID == "" {
		return false, false
	}
	if currentBootID == nil {
		return true, false
	}
	if *currentBootID == incomingBootID {
		if incomingUptime == nil {
			return currentUptime == nil, false
		}
		if currentUptime == nil {
			return true, false
		}
		if *incomingUptime > *currentUptime {
			return true, false
		}
		// A fast `once` run can emit its initial and final heartbeat within the
		// same second. Accept the equal-uptime final snapshot only when it adds
		// probe telemetry to an otherwise empty snapshot; equal stale snapshots
		// must not overwrite a known probe result.
		return *incomingUptime == *currentUptime && !currentHasProbe && incomingHasProbe, false
	}
	if currentBootStartedAt == nil || incomingBootStartedAt == nil {
		return currentBootStartedAt == nil, true
	}
	return incomingBootStartedAt.After(*currentBootStartedAt), true
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
	var confirmDurationMinutes *int
	var downloadMin, uploadMin, pingMax, jitterMax, lossMax, availabilityMin float64
	var scopeType, scopeID string
	var validFrom time.Time
	var validTo *time.Time
	policyErr := s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`, device.LineID).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &confirmDurationMinutes, &recoveryCount, &recoveryMinutes, &freshness)
	if policyErr != nil && !errors.Is(policyErr, pgx.ErrNoRows) {
		writeError(w, 500, "could not load line policy")
		return
	}
	if errors.Is(policyErr, pgx.ErrNoRows) {
		policyErr = s.DB.Pool.QueryRow(r.Context(), `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &downloadMin, &uploadMin, &pingMax, &jitterMax, &lossMax, &availabilityMin, &confirmCount, &confirmMinutes, &confirmDurationMinutes, &recoveryCount, &recoveryMinutes, &freshness)
		if policyErr != nil && !errors.Is(policyErr, pgx.ErrNoRows) {
			writeError(w, 500, "could not load global policy")
			return
		}
	}
	policy := map[string]interface{}{}
	if policyErr == nil {
		policy = map[string]interface{}{"id": policyID, "scope_type": scopeType, "scope_id": scopeID, "version": version, "valid_from": validFrom, "valid_to": validTo, "download_min": downloadMin, "upload_min": uploadMin, "ping_max": pingMax, "jitter_max": jitterMax, "packet_loss_max": lossMax, "availability_min": availabilityMin, "confirm_count": confirmCount, "confirm_minutes": confirmMinutes, "confirm_duration_minutes": confirmDurationMinutes, "recovery_count": recoveryCount, "recovery_minutes": recoveryMinutes, "freshness_seconds": freshness}
	}
	writeJSON(w, 200, map[string]interface{}{"device_id": device.ID, "hostname": device.Hostname, "line_id": device.LineID, "monitoring_point_id": device.PointID, "schedule": map[string]interface{}{"tests_per_day": testsPerDay, "performance_tests_per_day": testsPerDay, "jitter_minutes": jitter, "light_checks_between": light > 0}, "policy": policy})
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
