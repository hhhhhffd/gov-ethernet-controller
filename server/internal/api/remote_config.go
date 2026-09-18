package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"linkwatch/server/internal/auth"
	"net/http"
	"strconv"
)

func validateRemoteConfig(payload map[string]interface{}) error {
	for key := range payload {
		if key != "schedule" && key != "probe" {
			return errors.New("unsupported remote config field")
		}
	}
	if schedule, ok := payload["schedule"].(map[string]interface{}); ok {
		if value, exists := schedule["performance_tests_per_day"]; exists {
			n, valid := value.(float64)
			if !valid || n < 3 || n > 5 || n != float64(int(n)) {
				return errors.New("performance_tests_per_day must be 3-5")
			}
		}
		if value, exists := schedule["jitter_minutes"]; exists {
			n, valid := value.(float64)
			if !valid || n < 0 || n > 240 || n != float64(int(n)) {
				return errors.New("jitter_minutes must be 0-240")
			}
		}
	}
	if probe, ok := payload["probe"].(map[string]interface{}); ok {
		for key := range probe {
			if key != "timeout_seconds" && key != "throughput_duration_seconds" && key != "use_server_probe" {
				return errors.New("unsupported probe config field")
			}
		}
	}
	return nil
}

func (s *Server) adminRemoteConfig(w http.ResponseWriter, r *http.Request, p *auth.Principal, deviceID string) {
	if !requireAdmin(w, p) {
		return
	}
	var request struct {
		Config map[string]interface{} `json:"config"`
	}
	if err := decodeJSON(r, &request); err != nil || request.Config == nil || validateRemoteConfig(request.Config) != nil {
		writeError(w, 422, "invalid or unsupported remote config")
		return
	}
	payload, _ := json.Marshal(request.Config)
	hash := sha256.Sum256(payload)
	hashText := hex.EncodeToString(hash[:])
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin config rollout")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var version int64
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_config_versions(payload_json,payload_hash,created_by) VALUES ($1::jsonb,$2,$3) RETURNING version`, string(payload), hashText, p.ID).Scan(&version); err != nil {
		writeError(w, 500, "could not persist config version")
		return
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO agent_config_device_state(device_id,desired_version,status,last_error,updated_at) SELECT $1,$2,'PENDING',NULL,now() FROM devices WHERE id=$1 ON CONFLICT (device_id) DO UPDATE SET desired_version=EXCLUDED.desired_version,status='PENDING',last_error=NULL,updated_at=now()`, deviceID, version); err != nil {
		writeError(w, 404, "device not found")
		return
	}
	commandPayload, _ := json.Marshal(map[string]interface{}{"config_version": version, "config": request.Config, "config_hash": hashText})
	if _, err := tx.Exec(r.Context(), `INSERT INTO agent_commands(device_id,command_type,payload_json,idempotency_key,expires_at) VALUES ($1,'REMOTE_CONFIG',$2::jsonb,$3,now()+interval '24 hours') ON CONFLICT (device_id,idempotency_key) DO NOTHING`, deviceID, string(commandPayload), "remote-config:"+strconv.FormatInt(version, 10)); err != nil {
		writeError(w, 500, "could not queue config command")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit config rollout")
		return
	}
	writeAudit(r.Context(), s, p, "agent_config.desired", "device", deviceID, nil, map[string]interface{}{"version": version, "hash": hashText})
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"device_id": deviceID, "desired_version": version, "payload": request.Config, "payload_hash": hashText, "status": "PENDING"})
}

func (s *Server) agentConfigStateAck(ctx context.Context, deviceID string, version int64, status, message string) error {
	if status != "APPLIED" && status != "FAILED" && status != "ROLLED_BACK" {
		return errors.New("invalid config state")
	}
	_, err := s.DB.Pool.Exec(ctx, `UPDATE agent_config_device_state SET applied_version=CASE WHEN $2='APPLIED' THEN $1 ELSE applied_version END,last_known_good_version=CASE WHEN $2='APPLIED' THEN $1 ELSE last_known_good_version END,status=$2,last_error=NULLIF($3,''),updated_at=now() WHERE device_id=$4 AND desired_version=$1`, version, status, message, deviceID)
	return err
}
