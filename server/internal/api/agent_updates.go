package api

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
)

type signedAgentManifest struct {
	SignedPayload string `json:"signed_payload"`
	Signature     string `json:"signature"`
	KeyID         string `json:"key_id"`
}

type agentReleasePayload struct {
	Schema          string `json:"schema"`
	ReleaseID       string `json:"release_id"`
	Version         string `json:"version"`
	MinAgentVersion string `json:"min_agent_version"`
	MaxAgentVersion string `json:"max_agent_version,omitempty"`
	ArtifactURL     string `json:"artifact_url"`
	ArtifactSHA256  string `json:"artifact_sha256"`
	ArtifactSize    int64  `json:"artifact_size"`
}

func decodeSignedAgentManifest(raw []byte) (agentReleasePayload, []byte, string, error) {
	var manifest signedAgentManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.SignedPayload == "" || manifest.Signature == "" || manifest.KeyID == "" {
		return agentReleasePayload{}, nil, "", errors.New("manifest must contain signed_payload, signature and key_id")
	}
	payloadBytes, err := decodeManifestBase64(manifest.SignedPayload)
	if err != nil {
		return agentReleasePayload{}, nil, "", errors.New("manifest signed_payload is not base64")
	}
	var payload agentReleasePayload
	if json.Unmarshal(payloadBytes, &payload) != nil || payload.Schema != "linkwatch.agent-release/v1" || strings.TrimSpace(payload.ReleaseID) == "" || strings.TrimSpace(payload.Version) == "" {
		return agentReleasePayload{}, nil, "", errors.New("invalid release payload")
	}
	u, err := url.Parse(payload.ArtifactURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return agentReleasePayload{}, nil, "", errors.New("artifact_url must be an HTTPS URL without credentials")
	}
	if len(payload.ArtifactSHA256) != 64 {
		return agentReleasePayload{}, nil, "", errors.New("artifact_sha256 must be a 64-character hex digest")
	}
	if _, err := hex.DecodeString(payload.ArtifactSHA256); err != nil || payload.ArtifactSize <= 0 {
		return agentReleasePayload{}, nil, "", errors.New("invalid artifact integrity metadata")
	}
	pubRaw := strings.TrimSpace(getenv("LINKWATCH_UPDATE_PUBLIC_KEY", ""))
	if rotating := strings.TrimSpace(getenv("LINKWATCH_UPDATE_TRUST_KEYS", "")); rotating != "" {
		pubRaw = ""
		for _, entry := range strings.Split(rotating, ",") {
			id, key, ok := strings.Cut(strings.TrimSpace(entry), "=")
			if ok && strings.TrimSpace(id) == manifest.KeyID {
				pubRaw = strings.TrimSpace(key)
				break
			}
		}
	}
	pub, err := decodeManifestBase64(pubRaw)
	sig, sigErr := decodeManifestBase64(manifest.Signature)
	if err != nil || len(pub) != ed25519.PublicKeySize || sigErr != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(ed25519.PublicKey(pub), payloadBytes, sig) {
		return agentReleasePayload{}, nil, "", errors.New("manifest signature verification failed")
	}
	return payload, payloadBytes, manifest.KeyID, nil
}

func decodeManifestBase64(value string) ([]byte, error) {
	for _, encoding := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.StdEncoding} {
		if decoded, err := encoding.DecodeString(value); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("invalid base64")
}

func (s *Server) adminAgentUpdate(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	var request struct {
		Manifest  json.RawMessage `json:"manifest"`
		DeviceIDs []string        `json:"device_ids"`
	}
	if err := decodeJSON(r, &request); err != nil || len(request.Manifest) == 0 || len(request.DeviceIDs) == 0 || len(request.DeviceIDs) > 100 {
		writeError(w, http.StatusUnprocessableEntity, "manifest and 1-100 device_ids are required")
		return
	}
	payload, payloadBytes, keyID, err := decodeSignedAgentManifest(request.Manifest)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	digest := sha256.Sum256(payloadBytes)
	manifestHash := hex.EncodeToString(digest[:])
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin update rollout")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `INSERT INTO agent_update_releases(release_id,version,manifest_json,manifest_sha256,key_id,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(release_id) DO NOTHING`, payload.ReleaseID, payload.Version, string(request.Manifest), manifestHash, keyID, p.ID); err != nil {
		writeError(w, 409, "release already exists with incompatible metadata")
		return
	}
	var storedHash string
	if err := tx.QueryRow(r.Context(), `SELECT manifest_sha256 FROM agent_update_releases WHERE release_id=$1`, payload.ReleaseID).Scan(&storedHash); err != nil || storedHash != manifestHash {
		writeError(w, http.StatusConflict, "release already exists with incompatible metadata")
		return
	}
	queued := 0
	for _, deviceID := range request.DeviceIDs {
		deviceID = strings.TrimSpace(deviceID)
		if deviceID == "" {
			continue
		}
		commandPayload, _ := json.Marshal(map[string]interface{}{"manifest": json.RawMessage(request.Manifest), "release_id": payload.ReleaseID, "version": payload.Version})
		var commandID int64
		err = tx.QueryRow(r.Context(), `INSERT INTO agent_commands(device_id,command_type,payload_json,idempotency_key,expires_at) SELECT $1,'AGENT_UPDATE',$2::jsonb,$3,now()+interval '24 hours' FROM devices WHERE id=$1 ON CONFLICT(device_id,idempotency_key) DO UPDATE SET updated_at=now() RETURNING id`, deviceID, string(commandPayload), "agent-update:"+payload.ReleaseID).Scan(&commandID)
		if err != nil {
			continue
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO agent_update_attempts(release_id,device_id,command_id,status,detail_json) VALUES($1,$2,$3,'REQUESTED',$4::jsonb) ON CONFLICT(release_id,device_id) DO UPDATE SET command_id=EXCLUDED.command_id,status=CASE WHEN agent_update_attempts.status='SUCCEEDED' THEN 'SUCCEEDED' ELSE 'REQUESTED' END,detail_json=CASE WHEN agent_update_attempts.status='SUCCEEDED' THEN agent_update_attempts.detail_json ELSE EXCLUDED.detail_json END,last_error=NULL,updated_at=now()`, payload.ReleaseID, deviceID, commandID, string(commandPayload)); err != nil {
			writeError(w, 500, "could not persist update attempt")
			return
		}
		queued++
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit update rollout")
		return
	}
	writeAudit(r.Context(), s, p, "agent_update.requested", "agent_release", payload.ReleaseID, nil, map[string]interface{}{"version": payload.Version, "device_count": queued, "manifest_sha256": manifestHash, "key_id": keyID})
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"release_id": payload.ReleaseID, "version": payload.Version, "queued": queued, "status": "REQUESTED", "manifest_sha256": manifestHash})
}

func updateAckStatus(result json.RawMessage, commandStatus string) string {
	if commandStatus == "FAILED" {
		var value struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(result, &value) == nil && value.Status == "ROLLED_BACK" {
			return "ROLLED_BACK"
		}
		return "FAILED"
	}
	var value struct {
		Status           string `json:"status"`
		RestartRequested bool   `json:"restart_requested"`
	}
	if json.Unmarshal(result, &value) == nil {
		switch value.Status {
		case "DOWNLOADING":
			return "DOWNLOADING"
		case "VERIFIED":
			return "VERIFIED"
		case "INSTALLING":
			if value.RestartRequested {
				return "INSTALLING"
			}
		case "SUCCEEDED":
			// Older agents used SUCCEEDED for an install ACK. Preserve the
			// activation invariant for those ACKs until a heartbeat proves the
			// new process is running.
			return "INSTALLING"
		case "ALREADY_CURRENT":
			return "VERIFIED"
		}
	}
	return "VERIFIED"
}

type agentUpdateActivationReport struct {
	ReleaseID string `json:"release_id"`
	Version   string `json:"version"`
	Status    string `json:"status"`
	Error     string `json:"error"`
}

type agentUpdateActivationTransition struct {
	ReleaseID string `json:"release_id"`
	Version   string `json:"version"`
	Status    string `json:"status"`
}

func updateHeartbeatTransition(attemptStatus, expectedVersion, runningVersion, previousBootID, incomingBootID string, restartRequested bool) string {
	if attemptStatus != "INSTALLING" || !restartRequested || previousBootID == "" || incomingBootID == "" || previousBootID == incomingBootID {
		return ""
	}
	if expectedVersion == runningVersion {
		return "SUCCEEDED"
	}
	return "ROLLED_BACK"
}

func (s *Server) reconcileAgentUpdateHeartbeat(ctx context.Context, tx pgx.Tx, deviceID, runningVersion, bootID string, allowAutomatic bool, report *agentUpdateActivationReport) ([]agentUpdateActivationTransition, error) {
	transitions := make([]agentUpdateActivationTransition, 0, 2)
	if report != nil && report.ReleaseID != "" {
		status := "FAILED"
		if report.Status == "ROLLED_BACK" {
			status = "ROLLED_BACK"
		}
		var transition agentUpdateActivationTransition
		err := tx.QueryRow(ctx, `UPDATE agent_update_attempts a SET status=$3,last_error=NULLIF($4,''),detail_json=COALESCE(a.detail_json,'{}'::jsonb)||jsonb_build_object('status',$3,'error',$4,'reported_at',now()),updated_at=now() WHERE a.release_id=$1 AND a.device_id=$2 AND a.status NOT IN ('SUCCEEDED','ROLLED_BACK') RETURNING a.release_id,(SELECT version FROM agent_update_releases WHERE release_id=a.release_id)`, report.ReleaseID, deviceID, status, strings.TrimSpace(report.Error)).Scan(&transition.ReleaseID, &transition.Version)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			transition.Status = status
			transitions = append(transitions, transition)
		}
	}
	if !allowAutomatic {
		return transitions, nil
	}
	rows, err := tx.Query(ctx, `UPDATE agent_update_attempts a SET status='ROLLED_BACK',last_error=COALESCE(a.last_error,'running agent version did not match requested release'),detail_json=COALESCE(a.detail_json,'{}'::jsonb)||jsonb_build_object('status','ROLLED_BACK','running_version',$2,'rollback_observed_at',now()),updated_at=now() FROM agent_update_releases r WHERE a.release_id=r.release_id AND a.device_id=$1 AND a.status='INSTALLING' AND a.detail_json->>'restart_requested'='true' AND r.version<>$2 AND NULLIF(a.detail_json->>'previous_boot_id','') IS NOT NULL AND a.detail_json->>'previous_boot_id'<>NULLIF($3,'') RETURNING a.release_id,r.version`, deviceID, runningVersion, bootID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var transition agentUpdateActivationTransition
		if err := rows.Scan(&transition.ReleaseID, &transition.Version); err != nil {
			rows.Close()
			return nil, err
		}
		transition.Status = "ROLLED_BACK"
		transitions = append(transitions, transition)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `UPDATE agent_update_attempts a SET status='SUCCEEDED',last_error=NULL,detail_json=COALESCE(a.detail_json,'{}'::jsonb)||jsonb_build_object('status','SUCCEEDED','running_version',$2,'activated_at',now()),updated_at=now() FROM agent_update_releases r WHERE a.release_id=r.release_id AND a.device_id=$1 AND a.status='INSTALLING' AND a.detail_json->>'restart_requested'='true' AND r.version=$2 AND NULLIF(a.detail_json->>'previous_boot_id','') IS NOT NULL AND a.detail_json->>'previous_boot_id'<>NULLIF($3,'') RETURNING a.release_id,r.version`, deviceID, runningVersion, bootID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var transition agentUpdateActivationTransition
		if err := rows.Scan(&transition.ReleaseID, &transition.Version); err != nil {
			rows.Close()
			return nil, err
		}
		transition.Status = "SUCCEEDED"
		transitions = append(transitions, transition)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return transitions, nil
}
