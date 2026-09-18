package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"linkwatch/server/internal/auth"
)

const liveVerifySampleLimit = 4

type liveVerifyCandidate struct {
	DeviceID string
	LineID   string
	OrgID    string
	District string
	Provider string
}

func (s *Server) issueLiveVerify(w http.ResponseWriter, r *http.Request, rawID string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	situationID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT DISTINCT d.id,i.line_id,l.organization_id,o.district,COALESCE(l.provider_id,'') FROM situation_members sm JOIN incidents i ON i.id=sm.incident_id JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id JOIN monitoring_points mp ON mp.line_id=l.id AND mp.active JOIN devices d ON d.monitoring_point_id=mp.id AND d.blocked_at IS NULL WHERE sm.situation_id=$1 AND i.status <> 'CLOSED' ORDER BY d.id LIMIT $2`, situationID, liveVerifySampleLimit)
	if err != nil {
		writeError(w, 500, "could not select verification devices")
		return
	}
	defer rows.Close()
	candidates := []liveVerifyCandidate{}
	for rows.Next() {
		var c liveVerifyCandidate
		if err := rows.Scan(&c.DeviceID, &c.LineID, &c.OrgID, &c.District, &c.Provider); err != nil {
			writeError(w, 500, "could not read verification devices")
			return
		}
		if auth.HasLineScope(p, c.LineID, c.OrgID, c.District, c.Provider) {
			candidates = append(candidates, c)
		}
	}
	if len(candidates) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"situation_id": situationID, "status": "NO_ELIGIBLE_DEVICES", "commands": []interface{}{}})
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin verification")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	commands := []map[string]interface{}{}
	for _, candidate := range candidates {
		key := fmt.Sprintf("live-verify:%d:%s", situationID, candidate.DeviceID)
		payload, _ := json.Marshal(map[string]interface{}{"situation_id": situationID, "line_id": candidate.LineID, "trigger": "LIVE_VERIFY", "mode": "PERFORMANCE"})
		var id int64
		var status string
		if err := tx.QueryRow(r.Context(), `INSERT INTO agent_commands(device_id,situation_id,command_type,payload_json,idempotency_key,expires_at) VALUES ($1,$2,'LIVE_VERIFY',$3::jsonb,$4,now()+interval '15 minutes') ON CONFLICT (device_id,idempotency_key) DO UPDATE SET updated_at=agent_commands.updated_at RETURNING id,status`, candidate.DeviceID, situationID, string(payload), key).Scan(&id, &status); err != nil {
			writeError(w, 500, "could not create verification command")
			return
		}
		commands = append(commands, map[string]interface{}{"id": id, "device_id": candidate.DeviceID, "line_id": candidate.LineID, "status": status, "idempotency_key": key})
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit verification commands")
		return
	}
	writeAudit(r.Context(), s, p, "situation.live_verify_requested", "situation", strconv.FormatInt(situationID, 10), nil, map[string]interface{}{"sample_size": len(commands), "bounded": true})
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"situation_id": situationID, "status": "REQUESTED", "sample_size": len(commands), "commands": commands, "causal_claim": false})
}

func (s *Server) liveVerifyStatus(ctx context.Context, situationID int64) (map[string]interface{}, error) {
	var requested, pending, leased, done, failed, expired int
	if err := s.DB.Pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE status='PENDING'),count(*) FILTER (WHERE status='LEASED'),count(*) FILTER (WHERE status='DONE'),count(*) FILTER (WHERE status='FAILED'),count(*) FILTER (WHERE status='EXPIRED') FROM agent_commands WHERE situation_id=$1 AND command_type='LIVE_VERIFY'`, situationID).Scan(&requested, &pending, &leased, &done, &failed, &expired); err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	status := "NONE"
	if requested > 0 {
		status = "IN_PROGRESS"
		if done+failed+expired == requested {
			status = "COMPLETED"
		}
	}
	return map[string]interface{}{"status": status, "requested": requested, "pending": pending, "leased": leased, "done": done, "failed": failed, "expired": expired, "causal_claim": false}, nil
}
