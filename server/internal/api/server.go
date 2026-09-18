package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
	"linkwatch/server/internal/measurements"
)

type Server struct {
	DB             *database.DB
	Measure        *measurements.Service
	WebDir         string
	Logger         *slog.Logger
	DraftGenerator DraftGenerator
}

type requestIDContextKey struct{}

func New(db *database.DB, webDir string) *Server {
	return &Server{DB: db, Measure: &measurements.Service{DB: db}, WebDir: webDir, Logger: slog.Default(), DraftGenerator: newOllamaDraftGeneratorFromEnv()}
}

func (s *Server) Handler() http.Handler { return s }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if requestID := strings.TrimSpace(r.Header.Get("X-Request-ID")); requestID != "" {
		r = r.WithContext(context.WithValue(r.Context(), requestIDContextKey{}, requestID))
	}
	s.applyCORS(w, r)
	w.Header().Set("Vary", "Origin")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Device-ID,X-Device-Token,X-Request-ID")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	path := r.URL.Path
	if path == "/health" || path == "/health/live" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "linkwatch-server"})
		return
	}
	if path == "/health/ready" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := s.DB.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database is not ready")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "service": "linkwatch-server"})
		return
	}
	if path == "/" && r.Method == http.MethodGet {
		s.serveStatic(w, "index.html")
		return
	}
	if strings.HasPrefix(path, "/static/") && r.Method == http.MethodGet {
		s.serveStatic(w, strings.TrimPrefix(path, "/static/"))
		return
	}
	normalized := path
	for _, prefix := range []string{"/api/v1", "/api"} {
		if strings.HasPrefix(normalized, prefix+"/") {
			normalized = strings.TrimPrefix(normalized, prefix)
			break
		}
	}
	if normalized == "/login" || normalized == "/auth/login" {
		s.login(w, r)
		return
	}
	if normalized == "/auth/me" {
		s.me(w, r)
		return
	}
	if normalized == "/auth/logout" {
		s.logout(w, r)
		return
	}
	switch {
	case normalized == "/agent/heartbeat" && r.Method == http.MethodPost:
		s.agentHeartbeat(w, r)
	case normalized == "/agent/measurements:batch" && r.Method == http.MethodPost:
		s.agentBatch(w, r)
	case normalized == "/agent/config" && r.Method == http.MethodGet:
		s.agentConfig(w, r)
	case normalized == "/agent/commands:lease" && r.Method == http.MethodPost:
		s.agentCommandLease(w, r)
	case strings.HasPrefix(normalized, "/agent/commands/") && strings.HasSuffix(normalized, ":ack") && r.Method == http.MethodPost:
		s.agentCommandAck(w, r, strings.TrimSuffix(strings.TrimPrefix(normalized, "/agent/commands/"), ":ack"))
	case normalized == "/agent/probe/download" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		s.agentProbeDownload(w, r)
	case normalized == "/agent/probe/upload" && r.Method == http.MethodPost:
		s.agentProbeUpload(w, r)
	case normalized == "/agent/register" && r.Method == http.MethodPost:
		s.agentRegister(w, r)
	case normalized == "/lines" && r.Method == http.MethodGet:
		s.listLines(w, r)
	case strings.HasPrefix(normalized, "/lines/"):
		s.lineRoute(w, r, strings.TrimPrefix(normalized, "/lines/"))
	case normalized == "/overview" && r.Method == http.MethodGet:
		s.overview(w, r)
	case normalized == "/map/points" && r.Method == http.MethodGet:
		s.mapPoints(w, r)
	case normalized == "/organizations" && r.Method == http.MethodGet:
		s.listOrganizations(w, r)
	case normalized == "/providers" && r.Method == http.MethodGet:
		s.listProviders(w, r)
	case normalized == "/incidents" && r.Method == http.MethodGet:
		s.listIncidents(w, r)
	case normalized == "/incidents" && r.Method == http.MethodPost:
		s.createManualIncident(w, r)
	case strings.HasPrefix(normalized, "/incidents/"):
		s.incidentRoute(w, r, strings.TrimPrefix(normalized, "/incidents/"))
	case normalized == "/situations" && r.Method == http.MethodGet:
		s.listSituations(w, r)
	case strings.HasPrefix(normalized, "/situations/") && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		s.situationRoute(w, r, strings.TrimPrefix(normalized, "/situations/"))
	case normalized == "/reports/aggregate" && r.Method == http.MethodGet:
		s.aggregateReport(w, r)
	case normalized == "/reports/analytics" && r.Method == http.MethodGet:
		s.reportAnalytics(w, r)
	case (normalized == "/reports/quality-passport/evidence" || normalized == "/reports/evidence-report") && r.Method == http.MethodGet:
		s.evidenceReport(w, r)
	case normalized == "/reports/quality-passport" && r.Method == http.MethodGet:
		s.passport(w, r)
	case normalized == "/exports/preview" && r.Method == http.MethodGet:
		query := r.URL.Query()
		query.Set("preview", "1")
		r.URL.RawQuery = query.Encode()
		s.export(w, r)
	case normalized == "/exports" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		s.export(w, r)
	case normalized == "/audit" && r.Method == http.MethodGet:
		s.audit(w, r)
	case normalized == "/agent-versions" && r.Method == http.MethodGet:
		s.observedAgentVersions(w, r, nil)
	case strings.HasPrefix(normalized, "/agent-versions/") && r.Method == http.MethodGet:
		s.observedAgentVersions(w, r, strings.Split(strings.Trim(strings.TrimPrefix(normalized, "/agent-versions/"), "/"), "/"))
	case normalized == "/notifications" && r.Method == http.MethodGet:
		s.notifications(w, r)
	case normalized == "/provider-cases" && r.Method == http.MethodGet:
		s.listProviderCases(w, r)
	case normalized == "/provider-cases" && r.Method == http.MethodPost:
		s.createProviderCase(w, r)
	case normalized == "/demo/replay" && r.Method == http.MethodPost:
		s.demoReplay(w, r)
	case strings.HasPrefix(normalized, "/provider-cases/"):
		s.providerCaseRoute(w, r, strings.TrimPrefix(normalized, "/provider-cases/"))
	case strings.HasPrefix(normalized, "/devices/") && r.Method == http.MethodGet:
		s.deviceDetail(w, r, strings.TrimPrefix(normalized, "/devices/"))
	case strings.HasPrefix(normalized, "/admin/"):
		s.adminRoute(w, r, strings.TrimPrefix(normalized, "/admin/"))
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func requestIDFromContext(ctx context.Context) string {
	value, _ := ctx.Value(requestIDContextKey{}).(string)
	return value
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) {
	configured := os.Getenv("LINKWATCH_CORS_ORIGINS")
	if configured == "" && strings.ToLower(os.Getenv("LINKWATCH_ENV")) != "production" {
		configured = "http://localhost:8080,http://127.0.0.1:8080,http://localhost:8000,http://127.0.0.1:8000"
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return
	}
	for _, allowed := range strings.Split(configured, ",") {
		if strings.TrimSpace(allowed) == origin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "false")
			break
		}
	}
}

func (s *Server) serveStatic(w http.ResponseWriter, name string) {
	if name == "" || strings.Contains(name, "..") || strings.ContainsRune(name, '\\') {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}
	data, err := os.ReadFile(s.WebDir + "/" + name)
	if err != nil {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}
	contentType := "application/octet-stream"
	if strings.HasSuffix(name, ".html") {
		contentType = "text/html; charset=utf-8"
	}
	if strings.HasSuffix(name, ".css") {
		contentType = "text/css; charset=utf-8"
	}
	if strings.HasSuffix(name, ".js") {
		contentType = "text/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"detail": message, "error": message})
}

func decodeJSON(r *http.Request, target interface{}) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("request body must contain one JSON value")
		}
		return err
	}
	return nil
}

func parseTime(value string, fallback time.Time) (time.Time, error) {
	if value == "" {
		return fallback.UTC().Truncate(time.Second), nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339Nano, value)
	}
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC().Truncate(time.Second), nil
}

type deviceTimeError struct {
	code      string
	retryable bool
	message   string
}

func (e *deviceTimeError) Error() string { return e.message }

func validateDeviceTime(value time.Time) error {
	now := time.Now().UTC()
	if value.After(now.Add(10 * time.Minute)) {
		return &deviceTimeError{code: "clock_skew_future", retryable: true, message: "timestamp is too far in the future"}
	}
	if max := measurements.MaxBackfillDays(); max >= 0 && value.Before(now.Add(-time.Duration(max)*24*time.Hour)) {
		return &deviceTimeError{code: "backfill_window_exceeded", message: "timestamp is older than allowed backfill window"}
	}
	return nil
}

func sessionTTL() time.Duration {
	seconds, err := strconv.Atoi(os.Getenv("LINKWATCH_SESSION_TTL_SECONDS"))
	if err != nil || seconds <= 0 {
		seconds = 8 * 60 * 60
	}
	return time.Duration(seconds) * time.Second
}

func roleLabel(role string) string {
	return map[string]string{"ADMIN": "Администратор", "OBLAST": "Областной уровень", "DISTRICT": "Районный уровень", "PROVIDER": "Провайдер", "SCHOOL": "Школа"}[role]
}

func (s *Server) principal(w http.ResponseWriter, r *http.Request) (*auth.Principal, bool) {
	if os.Getenv("LINKWATCH_AUTH_DISABLED") == "1" && strings.ToLower(os.Getenv("LINKWATCH_ENV")) != "production" {
		return &auth.Principal{ID: "local-admin", Username: "local-admin", Role: "ADMIN"}, true
	}
	p, err := auth.AuthenticateUser(r.Context(), s.DB, auth.Bearer(r))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Bearer token required")
		return nil, false
	}
	return p, true
}

func (s *Server) device(w http.ResponseWriter, r *http.Request) (*auth.Device, bool) {
	deviceID := strings.TrimSpace(r.Header.Get("X-Device-ID"))
	clientKey := authClientKey(r) + ":" + deviceID
	allowed, retryAfter, err := auth.CheckRateLimit(r.Context(), s.DB, "device", clientKey, authRateLimit("LINKWATCH_DEVICE_AUTH_RATE_LIMIT", 20), time.Minute)
	if err != nil {
		s.Logger.Error("could not check device auth rate limit", "error", err)
		writeError(w, http.StatusServiceUnavailable, "device authentication is temporarily unavailable")
		return nil, false
	}
	if !allowed {
		if _, auditErr := s.DB.Pool.Exec(r.Context(), `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,request_id,created_at) VALUES ('ANONYMOUS','', 'auth.device_rate_limited','device',$1,$2,now())`, deviceID, r.Header.Get("X-Request-ID")); auditErr != nil {
			s.Logger.Error("could not persist device rate limit audit event", "error", auditErr)
		}
		seconds := int(retryAfter.Seconds()) + 1
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeError(w, http.StatusTooManyRequests, "too many device authentication attempts")
		return nil, false
	}
	device, err := auth.AuthenticateDevice(r.Context(), s.DB, deviceID, r.Header.Get("X-Device-Token"))
	if err != nil {
		if _, auditErr := s.DB.Pool.Exec(r.Context(), `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,request_id,created_at) VALUES ('ANONYMOUS','', 'auth.device_failed','device',$1,$2,now())`, deviceID, r.Header.Get("X-Request-ID")); auditErr != nil {
			s.Logger.Error("could not persist device authentication audit event", "error", auditErr)
		}
		writeError(w, http.StatusUnauthorized, "invalid or blocked device")
		return nil, false
	}
	if err := auth.ClearRateLimit(r.Context(), s.DB, "device", clientKey); err != nil {
		s.Logger.Error("could not clear device auth rate limit", "error", err)
	}
	return device, true
}

func decodeJSONBytes(raw []byte) interface{} {
	if len(raw) == 0 {
		return map[string]interface{}{}
	}
	var value interface{}
	if json.Unmarshal(raw, &value) != nil {
		return map[string]interface{}{}
	}
	return value
}

func nullableTime(value *time.Time) interface{} {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339)
}

// Keep pgx.ErrNoRows available to the other API files without repeating the
// import in every handler file.
var _ = errors.Is
var _ = pgx.ErrNoRows
