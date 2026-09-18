package api

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Username string `json:"username"`
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	username := strings.TrimSpace(payload.Username)
	if username == "" {
		username = strings.TrimSpace(payload.Login)
	}
	clientKey := authClientKey(r)
	allowed, retryAfter, err := auth.CheckRateLimit(r.Context(), s.DB, "login", clientKey, authRateLimit("LINKWATCH_LOGIN_RATE_LIMIT", 10), time.Minute)
	if err != nil {
		s.Logger.Error("could not check login rate limit", "error", err)
		writeError(w, http.StatusServiceUnavailable, "authentication is temporarily unavailable")
		return
	}
	if !allowed {
		auditAuthEvent(r, s, "auth.login_rate_limited", username, clientKey)
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
		writeError(w, http.StatusTooManyRequests, "too many login attempts")
		return
	}
	var id, role, passwordHash string
	err = s.DB.Pool.QueryRow(r.Context(), `SELECT id,role,password_hash FROM users WHERE username=$1 AND disabled_at IS NULL`, username).Scan(&id, &role, &passwordHash)
	if err != nil || !auth.VerifyPassword(payload.Password, passwordHash) {
		auditAuthEvent(r, s, "auth.login_failed", username, clientKey)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := auth.ClearRateLimit(r.Context(), s.DB, "login", clientKey); err != nil {
		s.Logger.Error("could not clear login rate limit", "error", err)
	}
	token, expires, err := auth.IssueSession(r.Context(), s.DB, id, sessionTTL(), r.RemoteAddr, r.UserAgent())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,request_id,created_at) VALUES ('USER',$1,'auth.login','user',$1,$2,now())`, id, r.Header.Get("X-Request-ID")); err != nil {
		s.Logger.Error("could not persist login audit event", "user_id", id, "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token": token, "token_type": "Bearer", "expires_at": expires.UTC().Format(time.RFC3339),
		"user": map[string]interface{}{"id": id, "username": username, "role": role, "role_label": roleLabel(role)},
	})
}

func authClientKey(r *http.Request) string {
	address := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	if address == "" {
		address = "unknown"
	}
	return address
}

func authRateLimit(name string, fallback int) int {
	value, err := strconv.Atoi(getenv(name, strconv.Itoa(fallback)))
	if err != nil || value < 1 || value > 10000 {
		return fallback
	}
	return value
}

func auditAuthEvent(r *http.Request, s *Server, action, objectID, key string) {
	after, err := json.Marshal(map[string]string{"client_key": key})
	if err != nil {
		s.Logger.Error("could not encode authentication audit event", "action", action, "error", err)
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,after_json,request_id,created_at) VALUES ('ANONYMOUS',$1,$2,'user',$1,$3::jsonb,$4,now())`, objectID, action, string(after), r.Header.Get("X-Request-ID")); err != nil {
		s.Logger.Error("could not persist authentication audit event", "action", action, "error", err)
	}
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if token := auth.Bearer(r); token != "" {
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, auth.TokenHash(token)); err != nil {
			s.Logger.Error("could not revoke auth session", "error", err)
			writeError(w, http.StatusInternalServerError, "could not revoke session")
			return
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,request_id,created_at) VALUES ('USER',$1,'auth.logout','user',$1,$2,now())`, p.ID, r.Header.Get("X-Request-ID")); err != nil {
			s.Logger.Error("could not persist logout audit event", "user_id", p.ID, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func requireAdmin(w http.ResponseWriter, p *auth.Principal) bool {
	if p == nil || p.Role != "ADMIN" {
		writeError(w, http.StatusForbidden, "administrator role required")
		return false
	}
	return true
}

func requireRole(w http.ResponseWriter, p *auth.Principal, action string) bool {
	if !auth.RoleAllows(p, action) {
		writeError(w, http.StatusForbidden, fmt.Sprintf("role cannot perform %s", action))
		return false
	}
	return true
}
