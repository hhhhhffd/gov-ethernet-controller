package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"linkwatch/server/internal/auth"
)

const (
	commandLeaseDuration = 2 * time.Minute
	commandMaxBatch      = 4
	commandMaxPayload    = 64 << 10
)

type agentCommand struct {
	ID             int64           `json:"id"`
	DeviceID       string          `json:"device_id"`
	CommandType    string          `json:"command_type"`
	Payload        json.RawMessage `json:"payload"`
	Status         string          `json:"status"`
	IdempotencyKey string          `json:"idempotency_key"`
	AttemptCount   int             `json:"attempt_count"`
	CreatedAt      time.Time       `json:"created_at"`
	ExpiresAt      time.Time       `json:"expires_at"`
	LeaseExpiresAt *time.Time      `json:"lease_expires_at,omitempty"`
	CompletedAt    *time.Time      `json:"completed_at,omitempty"`
	Result         json.RawMessage `json:"result,omitempty"`
	LastError      *string         `json:"last_error,omitempty"`
	SituationID    *int64          `json:"situation_id,omitempty"`
}

func validateCommandInput(commandType, idempotency string, payload json.RawMessage) error {
	if n := len(strings.TrimSpace(commandType)); n < 1 || n > 64 {
		return errors.New("command_type must be 1-64 characters")
	}
	if n := len(strings.TrimSpace(idempotency)); n < 1 || n > 128 {
		return errors.New("idempotency_key must be 1-128 characters")
	}
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	if len(payload) > commandMaxPayload {
		return errors.New("payload exceeds 64 KiB")
	}
	var value interface{}
	if json.Unmarshal(payload, &value) != nil {
		return errors.New("payload must be valid JSON")
	}
	if _, ok := value.(map[string]interface{}); !ok {
		return errors.New("payload must be a JSON object")
	}
	return nil
}

func (s *Server) adminAgentCommand(w http.ResponseWriter, r *http.Request, p *auth.Principal, deviceID string) {
	if !requireAdmin(w, p) {
		return
	}
	var request struct {
		CommandType    string          `json:"command_type"`
		Payload        json.RawMessage `json:"payload"`
		IdempotencyKey string          `json:"idempotency_key"`
		ExpiresAt      *time.Time      `json:"expires_at"`
	}
	if err := decodeJSON(r, &request); err != nil || validateCommandInput(request.CommandType, request.IdempotencyKey, request.Payload) != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid command payload")
		return
	}
	if len(request.Payload) == 0 {
		request.Payload = []byte("{}")
	}
	expires := time.Now().UTC().Add(15 * time.Minute)
	if request.ExpiresAt != nil {
		expires = request.ExpiresAt.UTC()
	}
	if !expires.After(time.Now().UTC()) || expires.After(time.Now().UTC().Add(24*time.Hour)) {
		writeError(w, http.StatusUnprocessableEntity, "expires_at must be within the next 24 hours")
		return
	}
	var command agentCommand
	err := s.DB.Pool.QueryRow(r.Context(), `
		INSERT INTO agent_commands(device_id,command_type,payload_json,idempotency_key,expires_at)
		SELECT $1,$2,$3::jsonb,$4,$5 FROM devices WHERE id=$1
		RETURNING id,device_id,command_type,payload_json,status,idempotency_key,attempt_count,created_at,expires_at,lease_expires_at,completed_at,result_json,last_error,situation_id`,
		deviceID, strings.TrimSpace(request.CommandType), request.Payload, strings.TrimSpace(request.IdempotencyKey), expires).Scan(commandScanArgs(&command)...)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if scanErr := s.DB.Pool.QueryRow(r.Context(), `SELECT id,device_id,command_type,payload_json,status,idempotency_key,attempt_count,created_at,expires_at,lease_expires_at,completed_at,result_json,last_error,situation_id FROM agent_commands WHERE device_id=$1 AND idempotency_key=$2`, deviceID, strings.TrimSpace(request.IdempotencyKey)).Scan(commandScanArgs(&command)...); scanErr == nil {
				writeJSON(w, http.StatusOK, command)
				return
			}
		}
		writeError(w, http.StatusNotFound, "device not found or command could not be created")
		return
	}
	writeAudit(r.Context(), s, p, "agent_command.created", "agent_command", strconv.FormatInt(command.ID, 10), nil, map[string]interface{}{"device_id": deviceID, "command_type": command.CommandType})
	writeJSON(w, http.StatusCreated, command)
}

func commandScanArgs(c *agentCommand) []interface{} {
	return []interface{}{&c.ID, &c.DeviceID, &c.CommandType, &c.Payload, &c.Status, &c.IdempotencyKey, &c.AttemptCount, &c.CreatedAt, &c.ExpiresAt, &c.LeaseExpiresAt, &c.CompletedAt, &c.Result, &c.LastError, &c.SituationID}
}

func (s *Server) agentCommandLease(w http.ResponseWriter, r *http.Request) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	limit := 1
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > commandMaxBatch {
		limit = commandMaxBatch
	}
	if _, err := s.ReconcileAgentCommands(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "command queue is temporarily unavailable")
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not lease commands")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `SELECT id,device_id,command_type,payload_json,status,idempotency_key,attempt_count,created_at,expires_at,lease_expires_at,completed_at,result_json,last_error,situation_id FROM agent_commands WHERE device_id=$1 AND status='PENDING' AND available_at<=now() AND expires_at>now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2`, device.ID, limit)
	if err != nil {
		writeError(w, 500, "could not lease commands")
		return
	}
	defer rows.Close()
	commands := []agentCommand{}
	for rows.Next() {
		var c agentCommand
		if err := rows.Scan(commandScanArgs(&c)...); err != nil {
			writeError(w, 500, "could not read command")
			return
		}
		commands = append(commands, c)
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read commands")
		return
	}
	leaseUntil := time.Now().UTC().Add(commandLeaseDuration)
	for i := range commands {
		if err := tx.QueryRow(r.Context(), `UPDATE agent_commands SET status='LEASED',attempt_count=attempt_count+1,leased_at=now(),lease_expires_at=$1,updated_at=now() WHERE id=$2 RETURNING attempt_count,lease_expires_at`, leaseUntil, commands[i].ID).Scan(&commands[i].AttemptCount, &commands[i].LeaseExpiresAt); err != nil {
			writeError(w, 500, "could not update command lease")
			return
		}
		commands[i].Status = "LEASED"
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit command lease")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"commands": commands, "lease_seconds": int(commandLeaseDuration.Seconds())})
}

func (s *Server) agentCommandAck(w http.ResponseWriter, r *http.Request, id string) {
	device, ok := s.device(w, r)
	if !ok {
		return
	}
	commandID, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "command not found")
		return
	}
	var request struct {
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := decodeJSON(r, &request); err != nil || (request.Status != "DONE" && request.Status != "FAILED") || len(request.Result) > commandMaxPayload {
		writeError(w, http.StatusUnprocessableEntity, "status must be DONE or FAILED and result must be <=64 KiB")
		return
	}
	if len(request.Result) == 0 {
		request.Result = []byte("{}")
	}
	var command agentCommand
	err = s.DB.Pool.QueryRow(r.Context(), `UPDATE agent_commands SET status=$1,result_json=$2::jsonb,last_error=NULLIF($3,''),completed_at=now(),updated_at=now(),lease_expires_at=NULL WHERE id=$4 AND device_id=$5 AND status='LEASED' AND expires_at>now() RETURNING id,device_id,command_type,payload_json,status,idempotency_key,attempt_count,created_at,expires_at,lease_expires_at,completed_at,result_json,last_error,situation_id`, request.Status, request.Result, strings.TrimSpace(request.Error), commandID, device.ID).Scan(commandScanArgs(&command)...)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "command is no longer leased or has expired")
			return
		}
		writeError(w, 500, "could not acknowledge command")
		return
	}
	writeJSON(w, http.StatusOK, command)
}

// ReconcileAgentCommands makes lease expiry and command expiry terminal/durable.
// It is safe for multiple server workers to call concurrently.
func (s *Server) ReconcileAgentCommands(ctx context.Context) (int64, error) {
	result, err := s.DB.Pool.Exec(ctx, `UPDATE agent_commands SET status='EXPIRED',completed_at=COALESCE(completed_at,now()),updated_at=now(),last_error=COALESCE(last_error,'command expired') WHERE status IN ('PENDING','LEASED') AND expires_at<=now()`)
	if err != nil {
		return 0, err
	}
	result2, err := s.DB.Pool.Exec(ctx, `UPDATE agent_commands SET status='PENDING',available_at=now(),leased_at=NULL,lease_expires_at=NULL,updated_at=now(),last_error=COALESCE(last_error,'lease expired; retrying') WHERE status='LEASED' AND lease_expires_at<=now() AND expires_at>now()`)
	if err != nil {
		return result.RowsAffected(), err
	}
	return result.RowsAffected() + result2.RowsAffected(), nil
}
