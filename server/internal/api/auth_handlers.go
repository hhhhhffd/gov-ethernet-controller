package api

import (
	"fmt"
	"net/http"
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
	var id, role, passwordHash string
	err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,role,password_hash FROM users WHERE username=$1 AND disabled_at IS NULL`, username).Scan(&id, &role, &passwordHash)
	if err != nil || !auth.VerifyPassword(payload.Password, passwordHash) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
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

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.principal(w, r); !ok {
		return
	}
	if token := auth.Bearer(r); token != "" {
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, auth.TokenHash(token)); err != nil {
			s.Logger.Error("could not revoke auth session", "error", err)
			writeError(w, http.StatusInternalServerError, "could not revoke session")
			return
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
