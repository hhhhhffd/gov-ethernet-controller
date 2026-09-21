package api

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
)

const (
	enrollmentCodeTTL          = 15 * time.Minute
	enrollmentCodeBytes        = 10
	enrollmentCodeGroupSize    = 4
	enrollmentRateLimitDefault = 10
)

var errInvalidEnrollmentCode = errors.New("invalid enrollment code")

type deviceRegistrationInput struct {
	ID                string
	MonitoringPointID string
	AgentVersion      string
	DisplayName       string
	Hostname          string
}

type registeredDevice struct {
	ID           string
	Token        string
	AgentVersion string
	DisplayName  string
}

// registerDeviceInTx is the shared device credential path. Keeping token
// generation and hashing here prevents enrollment from becoming a parallel
// registration mechanism with different authentication semantics.
func registerDeviceInTx(ctx context.Context, tx pgx.Tx, input deviceRegistrationInput) (registeredDevice, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.MonitoringPointID) == "" {
		return registeredDevice{}, fmt.Errorf("device identity and monitoring point are required")
	}
	if input.AgentVersion == "" {
		input.AgentVersion = "0.1.0"
	}
	token, err := randomSecret()
	if err != nil {
		return registeredDevice{}, fmt.Errorf("generate device token: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := tx.Exec(ctx, `INSERT INTO devices(id,monitoring_point_id,auth_token_hash,agent_version,display_name,hostname,created_at) VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7)`, input.ID, input.MonitoringPointID, auth.TokenHash(token), input.AgentVersion, input.DisplayName, input.Hostname, now); err != nil {
		return registeredDevice{}, err
	}
	return registeredDevice{ID: input.ID, Token: token, AgentVersion: input.AgentVersion, DisplayName: input.DisplayName}, nil
}

func (s *Server) adminEnrollmentCode(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	var payload struct {
		MonitoringPointID string `json:"monitoring_point_id"`
	}
	if err := decodeJSON(r, &payload); err != nil || strings.TrimSpace(payload.MonitoringPointID) == "" {
		writeError(w, http.StatusUnprocessableEntity, "monitoring_point_id is required")
		return
	}

	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not start enrollment transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var lineID, organizationID, schoolID, location string
	err = tx.QueryRow(r.Context(), `SELECT mp.line_id,l.organization_id,o.school_id,mp.location FROM monitoring_points mp JOIN lines l ON l.id=mp.line_id JOIN organizations o ON o.id=l.organization_id WHERE mp.id=$1 AND mp.active FOR KEY SHARE OF mp`, strings.TrimSpace(payload.MonitoringPointID)).Scan(&lineID, &organizationID, &schoolID, &location)
	if err != nil {
		writeError(w, http.StatusNotFound, "active monitoring point not found")
		return
	}
	code, err := randomEnrollmentCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate enrollment code")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	expiresAt := now.Add(enrollmentCodeTTL)
	var codeID int64
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_enrollment_codes(code_hash,monitoring_point_id,created_by,created_at,expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, auth.TokenHash(normalizeEnrollmentCode(code)), payload.MonitoringPointID, p.ID, now, expiresAt).Scan(&codeID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create enrollment code")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "could not commit enrollment code")
		return
	}
	writeAudit(r.Context(), s, p, "agent_enrollment.created", "agent_enrollment", strconv.FormatInt(codeID, 10), nil, map[string]interface{}{"monitoring_point_id": payload.MonitoringPointID, "line_id": lineID, "organization_id": organizationID, "school_id": schoolID, "expires_at": expiresAt})
	writeJSON(w, http.StatusCreated, map[string]interface{}{"code": code, "expires_at": expiresAt, "status": "ACTIVE", "monitoring_point_id": payload.MonitoringPointID, "monitoring_point_location": location, "line_id": lineID, "organization_id": organizationID, "school_id": schoolID})
}

func (s *Server) agentEnroll(w http.ResponseWriter, r *http.Request) {
	clientKey := s.authClientKey(r)
	allowed, retryAfter, err := auth.CheckRateLimit(r.Context(), s.DB, "agent_enroll", clientKey, authRateLimit("LINKWATCH_AGENT_ENROLL_RATE_LIMIT", enrollmentRateLimitDefault), time.Minute)
	if err != nil {
		s.Logger.Error("could not check enrollment rate limit", "error", err)
		writeError(w, http.StatusServiceUnavailable, "enrollment is temporarily unavailable")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
		writeError(w, http.StatusTooManyRequests, "too many enrollment attempts")
		return
	}

	var payload struct {
		Code         string `json:"code"`
		Hostname     string `json:"hostname"`
		AgentVersion string `json:"agent_version"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeInvalidEnrollmentError(w)
		return
	}
	payload.Code = normalizeEnrollmentCode(payload.Code)
	payload.Hostname = strings.TrimSpace(payload.Hostname)
	payload.AgentVersion = strings.TrimSpace(payload.AgentVersion)
	if len(payload.Code) != enrollmentCodeBytes*8/5 || payload.Hostname == "" || len(payload.Hostname) > 255 || len(payload.AgentVersion) > 255 {
		writeInvalidEnrollmentError(w)
		return
	}

	result, err := s.consumeEnrollmentCode(r.Context(), payload.Code, payload.Hostname, payload.AgentVersion)
	if err != nil {
		if errors.Is(err, errInvalidEnrollmentCode) {
			writeInvalidEnrollmentError(w)
			return
		}
		s.Logger.Error("could not enroll agent", "error", err)
		writeError(w, http.StatusInternalServerError, "could not enroll agent")
		return
	}
	if err := auth.ClearRateLimit(r.Context(), s.DB, "agent_enroll", clientKey); err != nil {
		s.Logger.Error("could not clear enrollment rate limit", "error", err)
	}
	writeJSON(w, http.StatusCreated, map[string]string{"device_id": result.ID, "device_token": result.Token})
}

func (s *Server) consumeEnrollmentCode(ctx context.Context, code, hostname, agentVersion string) (registeredDevice, error) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return registeredDevice{}, fmt.Errorf("start enrollment transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var codeID int64
	var monitoringPointID string
	var expiresAt time.Time
	var usedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT id,monitoring_point_id,expires_at,used_at FROM agent_enrollment_codes WHERE code_hash=$1 FOR UPDATE`, auth.TokenHash(code)).Scan(&codeID, &monitoringPointID, &expiresAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return registeredDevice{}, errInvalidEnrollmentCode
	}
	if err != nil {
		return registeredDevice{}, fmt.Errorf("load enrollment code: %w", err)
	}
	if usedAt != nil || !expiresAt.After(time.Now().UTC()) {
		return registeredDevice{}, errInvalidEnrollmentCode
	}
	var lineID, organizationID, schoolID string
	err = tx.QueryRow(ctx, `SELECT mp.line_id,l.organization_id,o.school_id FROM monitoring_points mp JOIN lines l ON l.id=mp.line_id JOIN organizations o ON o.id=l.organization_id WHERE mp.id=$1 AND mp.active FOR KEY SHARE OF mp`, monitoringPointID).Scan(&lineID, &organizationID, &schoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return registeredDevice{}, errInvalidEnrollmentCode
	}
	if err != nil {
		return registeredDevice{}, fmt.Errorf("load enrollment point: %w", err)
	}
	deviceID, err := randomDeviceID()
	if err != nil {
		return registeredDevice{}, err
	}
	registered, err := registerDeviceInTx(ctx, tx, deviceRegistrationInput{ID: deviceID, MonitoringPointID: monitoringPointID, AgentVersion: agentVersion, DisplayName: hostname, Hostname: hostname})
	if err != nil {
		return registeredDevice{}, fmt.Errorf("create enrolled device: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := tx.Exec(ctx, `UPDATE agent_enrollment_codes SET used_at=$1,used_device_id=$2 WHERE id=$3 AND used_at IS NULL`, now, registered.ID, codeID); err != nil {
		return registeredDevice{}, fmt.Errorf("consume enrollment code: %w", err)
	}
	audit, err := json.Marshal(map[string]string{"monitoring_point_id": monitoringPointID, "line_id": lineID, "organization_id": organizationID, "school_id": schoolID, "hostname": hostname, "agent_version": registered.AgentVersion})
	if err != nil {
		return registeredDevice{}, fmt.Errorf("encode enrollment audit: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,after_json,request_id,created_at) VALUES ('ANONYMOUS','', 'agent.enrolled','device',$1,$2::jsonb,NULLIF($3,''),$4)`, registered.ID, string(audit), requestIDFromContext(ctx), now); err != nil {
		return registeredDevice{}, fmt.Errorf("audit enrolled device: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return registeredDevice{}, fmt.Errorf("commit enrollment transaction: %w", err)
	}
	return registered, nil
}

func writeInvalidEnrollmentError(w http.ResponseWriter) {
	writeError(w, http.StatusUnauthorized, errInvalidEnrollmentCode.Error())
}

func randomEnrollmentCode() (string, error) {
	bytes := make([]byte, enrollmentCodeBytes)
	if _, err := cryptorand.Read(bytes); err != nil {
		return "", err
	}
	raw := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(bytes)
	groups := make([]string, 0, len(raw)/enrollmentCodeGroupSize)
	for start := 0; start < len(raw); start += enrollmentCodeGroupSize {
		groups = append(groups, raw[start:start+enrollmentCodeGroupSize])
	}
	return strings.Join(groups, "-"), nil
}

func normalizeEnrollmentCode(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r - ('a' - 'A')
		}
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return -1
	}, strings.TrimSpace(value))
}

func randomDeviceID() (string, error) {
	secret, err := randomSecret()
	if err != nil {
		return "", err
	}
	return "device-" + secret, nil
}
