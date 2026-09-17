package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"linkwatch/server/internal/admin"
	"linkwatch/server/internal/auth"
)

func (s *Server) adminRoute(w http.ResponseWriter, r *http.Request, rest string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 {
		writeError(w, 404, "not found")
		return
	}
	if parts[0] == "demo" && len(parts) > 1 && parts[1] == "reset" && r.Method == http.MethodPost {
		if !requireAdmin(w, p) {
			return
		}
		if strings.ToLower(getenv("LINKWATCH_ENV", "development")) == "production" {
			writeError(w, 404, "demo reset is disabled in production")
			return
		}
		if err := admin.ResetDemo(r.Context(), s.DB); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"reset": true})
		return
	}
	if parts[0] == "schedules" {
		s.adminSchedule(w, r, p)
		return
	}
	if parts[0] == "policies" {
		s.adminPolicy(w, r, p)
		return
	}
	if parts[0] == "contracts" {
		s.adminContract(w, r, p)
		return
	}
	if parts[0] == "devices" {
		s.adminDevices(w, r, p, parts[1:])
		return
	}
	if parts[0] == "monitoring-points" {
		s.adminMonitoringPoints(w, r, p, parts[1:])
		return
	}
	if parts[0] == "notifications" && len(parts) > 2 && parts[2] == "dispatch" {
		s.notificationDispatch(w, r, p, parts[1])
		return
	}
	switch parts[0] {
	case "organizations":
		s.adminOrganizations(w, r, p, parts[1:])
		return
	case "providers":
		s.adminProviders(w, r, p, parts[1:])
		return
	case "lines":
		s.adminLines(w, r, p, parts[1:])
		return
	case "users":
		s.adminUserRoute(w, r, p, parts[1:])
		return
	case "monitoring-points":
		s.adminMonitoringPoints(w, r, p, parts[1:])
		return
	case "audit":
		if r.Method == http.MethodGet {
			s.audit(w, r)
			return
		}
	}
	writeError(w, 404, "not found")
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,username,role,disabled_at,created_at FROM users ORDER BY username`)
	if err != nil {
		writeError(w, 500, "could not query users")
		return
	}
	users := []struct {
		id, username, role string
		disabled           *time.Time
		created            time.Time
	}{}
	for rows.Next() {
		var id, username, role string
		var disabled *time.Time
		var created time.Time
		if rows.Scan(&id, &username, &role, &disabled, &created) == nil {
			users = append(users, struct {
				id, username, role string
				disabled           *time.Time
				created            time.Time
			}{id: id, username: username, role: role, disabled: disabled, created: created})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeError(w, 500, "could not read users")
		return
	}
	rows.Close()
	result := []map[string]interface{}{}
	for _, user := range users {
		scopes := []map[string]string{}
		scopeRows, e := s.DB.Pool.Query(r.Context(), `SELECT scope_type,scope_id FROM role_scopes WHERE user_id=$1 ORDER BY scope_type,scope_id`, user.id)
		if e == nil {
			for scopeRows.Next() {
				var scopeType, scopeID string
				if scopeRows.Scan(&scopeType, &scopeID) == nil {
					scopes = append(scopes, map[string]string{"scope_type": scopeType, "scope_id": scopeID})
				}
			}
			scopeRows.Close()
		}
		result = append(result, map[string]interface{}{"id": user.id, "username": user.username, "role": user.role, "disabled": user.disabled != nil, "disabled_at": user.disabled, "created_at": user.created, "scopes": scopes})
	}
	writeJSON(w, 200, result)
}

type scopePayload struct {
	Type string `json:"scope_type"`
	ID   string `json:"scope_id"`
}

type userPayload struct {
	ID       string         `json:"id"`
	Username string         `json:"username"`
	Role     string         `json:"role"`
	Password string         `json:"password"`
	Disabled bool           `json:"disabled"`
	Scopes   []scopePayload `json:"scopes"`
}

func (s *Server) adminUserRoute(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if len(parts) == 0 && r.Method == http.MethodGet {
		s.adminUsers(w, r, p)
		return
	}
	if len(parts) > 1 || (len(parts) == 1 && parts[0] == "") {
		writeError(w, 404, "user not found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload userPayload
	if err := decodeJSON(r, &payload); err != nil || payload.ID == "" || payload.Username == "" || payload.Role == "" {
		writeError(w, 422, "invalid user payload")
		return
	}
	if payload.Role != "ADMIN" && payload.Role != "OBLAST" && payload.Role != "DISTRICT" && payload.Role != "PROVIDER" && payload.Role != "SCHOOL" {
		writeError(w, 422, "unsupported role")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if strings.EqualFold(getenv("LINKWATCH_ENV", "development"), "production") && len(payload.Password) < 12 {
			writeError(w, 422, "a 12+ character password is required in production")
			return
		}
		token := randomSecret()
		passwordHash := interface{}(nil)
		if payload.Password != "" {
			hash, err := auth.HashPassword(payload.Password)
			if err != nil {
				writeError(w, 422, err.Error())
				return
			}
			passwordHash = hash
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO users(id,username,role,token_hash,password_hash,disabled_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, payload.ID, payload.Username, payload.Role, auth.TokenHash(token), passwordHash, nullableNow(payload.Disabled, now), now); err != nil {
			writeError(w, 409, "user id or username already exists")
			return
		}
		if err := replaceUserScopes(r.Context(), s, payload.ID, payload.Scopes); err != nil {
			writeError(w, 422, err.Error())
			return
		}
		if !payload.Disabled {
			sessionToken, _, err := auth.IssueSession(r.Context(), s.DB, payload.ID, sessionTTL(), r.RemoteAddr, r.UserAgent())
			if err != nil {
				writeError(w, 500, "could not create user session")
				return
			}
			token = sessionToken
		}
		writeAudit(r.Context(), s, p, "user.created", "user", payload.ID, nil, payload)
		writeJSON(w, 201, map[string]interface{}{"id": payload.ID, "username": payload.Username, "role": payload.Role, "disabled": payload.Disabled, "scopes": payload.Scopes, "token": token, "created_at": now})
		return
	}
	if parts[0] != payload.ID {
		writeError(w, 409, "user id is immutable")
		return
	}
	var current userPayload
	var disabledAt *time.Time
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,username,role,disabled_at,created_at FROM users WHERE id=$1`, parts[0]).Scan(&current.ID, &current.Username, &current.Role, &disabledAt, &created); err != nil {
		writeError(w, 404, "user not found")
		return
	}
	current.Disabled = disabledAt != nil
	setPassword := ""
	args := []interface{}{payload.Username, payload.Role, nullableNow(payload.Disabled, now)}
	if payload.Password != "" {
		if strings.EqualFold(getenv("LINKWATCH_ENV", "development"), "production") && len(payload.Password) < 12 {
			writeError(w, 422, "a 12+ character password is required in production")
			return
		}
		hash, err := auth.HashPassword(payload.Password)
		if err != nil {
			writeError(w, 422, err.Error())
			return
		}
		setPassword = ",password_hash=$4,token_hash=$5"
		args = append(args, hash, auth.TokenHash(randomSecret()))
	}
	if payload.Disabled && payload.Password == "" {
		setPassword = ",token_hash=$4"
		args = append(args, auth.TokenHash(randomSecret()))
	}
	args = append(args, payload.ID)
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE users SET username=$1,role=$2,disabled_at=$3`+setPassword+` WHERE id=$`+itoa(len(args)), args...); err != nil {
		writeError(w, 409, "username already exists or user update failed")
		return
	}
	if payload.Disabled || payload.Password != "" {
		_, _ = s.DB.Pool.Exec(r.Context(), `UPDATE auth_sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL`, now, payload.ID)
	}
	if err := replaceUserScopes(r.Context(), s, payload.ID, payload.Scopes); err != nil {
		writeError(w, 422, err.Error())
		return
	}
	writeAudit(r.Context(), s, p, "user.updated", "user", payload.ID, current, payload)
	writeJSON(w, 200, map[string]interface{}{"id": payload.ID, "username": payload.Username, "role": payload.Role, "disabled": payload.Disabled, "scopes": payload.Scopes, "created_at": created})
}

func nullableNow(disabled bool, now time.Time) *time.Time {
	if disabled {
		return &now
	}
	return nil
}

func replaceUserScopes(ctx context.Context, s *Server, userID string, scopes []scopePayload) error {
	if _, err := s.DB.Pool.Exec(ctx, `DELETE FROM role_scopes WHERE user_id=$1`, userID); err != nil {
		return err
	}
	for _, scope := range scopes {
		if scope.Type == "" || scope.ID == "" {
			return fmt.Errorf("scope_type and scope_id are required")
		}
		if _, err := s.DB.Pool.Exec(ctx, `INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, userID, strings.ToUpper(scope.Type), scope.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) agentRegister(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	s.adminDevices(w, r, p, []string{"register"})
}

type organizationPayload struct {
	ID           string   `json:"id"`
	SchoolID     string   `json:"school_id"`
	Name         string   `json:"name"`
	District     string   `json:"district"`
	Address      string   `json:"address"`
	Latitude     *float64 `json:"latitude"`
	Longitude    *float64 `json:"longitude"`
	ContactName  string   `json:"contact_name"`
	ContactPhone string   `json:"contact_phone"`
	Active       bool     `json:"active"`
}

func (s *Server) adminOrganizations(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet && len(parts) == 0 {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,school_id,name,district,address,latitude,longitude,contact_name,contact_phone,active,created_at FROM organizations ORDER BY district,name`)
		if err != nil {
			writeError(w, 500, "could not query organizations")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var item organizationPayload
			var created time.Time
			if rows.Scan(&item.ID, &item.SchoolID, &item.Name, &item.District, &item.Address, &item.Latitude, &item.Longitude, &item.ContactName, &item.ContactPhone, &item.Active, &created) == nil {
				result = append(result, organizationMap(item, created))
			}
		}
		writeJSON(w, 200, result)
		return
	}
	if len(parts) > 1 || (len(parts) == 1 && parts[0] == "") {
		writeError(w, 404, "organization not found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload organizationPayload
	payload.Active = true
	if err := decodeJSON(r, &payload); err != nil || payload.ID == "" || payload.SchoolID == "" || payload.Name == "" || payload.District == "" {
		writeError(w, 422, "invalid organization payload")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO organizations(id,school_id,name,district,address,latitude,longitude,contact_name,contact_phone,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, payload.ID, payload.SchoolID, payload.Name, payload.District, payload.Address, payload.Latitude, payload.Longitude, payload.ContactName, payload.ContactPhone, payload.Active, now); err != nil {
			writeError(w, 409, "organization id or school_id already exists")
			return
		}
		writeAudit(r.Context(), s, p, "organization.created", "organization", payload.ID, nil, payload)
		writeJSON(w, 201, organizationMap(payload, now))
		return
	}
	id := parts[0]
	if id != payload.ID {
		writeError(w, 409, "organization id is immutable")
		return
	}
	var previous organizationPayload
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,school_id,name,district,address,latitude,longitude,contact_name,contact_phone,active,created_at FROM organizations WHERE id=$1`, id).Scan(&previous.ID, &previous.SchoolID, &previous.Name, &previous.District, &previous.Address, &previous.Latitude, &previous.Longitude, &previous.ContactName, &previous.ContactPhone, &previous.Active, &created); err != nil {
		writeError(w, 404, "organization not found")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE organizations SET school_id=$1,name=$2,district=$3,address=$4,latitude=$5,longitude=$6,contact_name=$7,contact_phone=$8,active=$9 WHERE id=$10`, payload.SchoolID, payload.Name, payload.District, payload.Address, payload.Latitude, payload.Longitude, payload.ContactName, payload.ContactPhone, payload.Active, id); err != nil {
		writeError(w, 409, "school_id already exists")
		return
	}
	writeAudit(r.Context(), s, p, "organization.updated", "organization", id, previous, payload)
	writeJSON(w, 200, organizationMap(payload, created))
}

func organizationMap(item organizationPayload, created time.Time) map[string]interface{} {
	return map[string]interface{}{"id": item.ID, "school_id": item.SchoolID, "name": item.Name, "district": item.District, "address": item.Address, "latitude": item.Latitude, "longitude": item.Longitude, "contact_name": item.ContactName, "contact_phone": item.ContactPhone, "active": item.Active, "created_at": created}
}

type providerPayload struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SupportContact string `json:"support_contact"`
	Active         bool   `json:"active"`
}

func (s *Server) adminProviders(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet && len(parts) == 0 {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,name,support_contact,active,created_at FROM providers ORDER BY name`)
		if err != nil {
			writeError(w, 500, "could not query providers")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var item providerPayload
			var created time.Time
			if rows.Scan(&item.ID, &item.Name, &item.SupportContact, &item.Active, &created) == nil {
				result = append(result, map[string]interface{}{"id": item.ID, "name": item.Name, "support_contact": item.SupportContact, "active": item.Active, "created_at": created})
			}
		}
		writeJSON(w, 200, result)
		return
	}
	if len(parts) > 1 {
		writeError(w, 404, "provider not found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload providerPayload
	payload.Active = true
	if err := decodeJSON(r, &payload); err != nil || payload.ID == "" || payload.Name == "" {
		writeError(w, 422, "invalid provider payload")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO providers(id,name,support_contact,active,created_at) VALUES ($1,$2,$3,$4,$5)`, payload.ID, payload.Name, payload.SupportContact, payload.Active, now); err != nil {
			writeError(w, 409, "provider id or name already exists")
			return
		}
		writeAudit(r.Context(), s, p, "provider.created", "provider", payload.ID, nil, payload)
		writeJSON(w, 201, map[string]interface{}{"id": payload.ID, "name": payload.Name, "support_contact": payload.SupportContact, "active": payload.Active, "created_at": now})
		return
	}
	if parts[0] != payload.ID {
		writeError(w, 409, "provider id is immutable")
		return
	}
	var previous providerPayload
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,name,support_contact,active,created_at FROM providers WHERE id=$1`, parts[0]).Scan(&previous.ID, &previous.Name, &previous.SupportContact, &previous.Active, &created); err != nil {
		writeError(w, 404, "provider not found")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE providers SET name=$1,support_contact=$2,active=$3 WHERE id=$4`, payload.Name, payload.SupportContact, payload.Active, parts[0]); err != nil {
		writeError(w, 409, "provider id or name already exists")
		return
	}
	writeAudit(r.Context(), s, p, "provider.updated", "provider", parts[0], previous, payload)
	writeJSON(w, 200, map[string]interface{}{"id": payload.ID, "name": payload.Name, "support_contact": payload.SupportContact, "active": payload.Active, "created_at": created})
}

type linePayload struct {
	ID             string  `json:"id"`
	OrganizationID string  `json:"organization_id"`
	ProviderID     *string `json:"provider_id"`
	Role           string  `json:"role"`
	Technology     string  `json:"technology"`
	Status         string  `json:"status"`
}

func (s *Server) adminLines(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet && len(parts) == 0 {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT l.id,l.organization_id,l.provider_id,l.role,l.technology,l.status,l.created_at,o.school_id,o.name,p.name FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id ORDER BY o.district,o.name,l.role`)
		if err != nil {
			writeError(w, 500, "could not query lines")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var item linePayload
			var providerID *string
			var created time.Time
			var school, name string
			var providerName *string
			if rows.Scan(&item.ID, &item.OrganizationID, &providerID, &item.Role, &item.Technology, &item.Status, &created, &school, &name, &providerName) == nil {
				item.ProviderID = providerID
				result = append(result, map[string]interface{}{"id": item.ID, "organization_id": item.OrganizationID, "provider_id": providerID, "role": item.Role, "technology": item.Technology, "status": item.Status, "created_at": created, "school_id": school, "organization_name": name, "provider_name": providerName})
			}
		}
		writeJSON(w, 200, result)
		return
	}
	if len(parts) > 1 {
		writeError(w, 404, "line not found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload linePayload
	payload.Role = "PRIMARY"
	payload.Status = "ACTIVE"
	if err := decodeJSON(r, &payload); err != nil || payload.ID == "" || payload.OrganizationID == "" || payload.Role == "" {
		writeError(w, 422, "invalid line payload")
		return
	}
	if payload.Status == "" {
		payload.Status = "ACTIVE"
	}
	if payload.Role != "PRIMARY" && payload.Role != "RESERVE" && payload.Role != "INACTIVE" {
		writeError(w, 422, "unsupported line role")
		return
	}
	if payload.Status != "ACTIVE" && payload.Status != "INACTIVE" && payload.Status != "DELETED" {
		writeError(w, 422, "unsupported line status")
		return
	}
	var organizationExists bool
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1)`, payload.OrganizationID).Scan(&organizationExists); err != nil || !organizationExists {
		writeError(w, 422, "organization not found")
		return
	}
	if payload.ProviderID != nil {
		var providerExists bool
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM providers WHERE id=$1)`, *payload.ProviderID).Scan(&providerExists); err != nil || !providerExists {
			writeError(w, 422, "provider not found")
			return
		}
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, payload.ID, payload.OrganizationID, payload.ProviderID, payload.Role, payload.Technology, payload.Status, now); err != nil {
			writeError(w, 409, "line already exists or references are invalid")
			return
		}
		writeAudit(r.Context(), s, p, "line.created", "line", payload.ID, nil, payload)
		writeJSON(w, 201, map[string]interface{}{"id": payload.ID, "organization_id": payload.OrganizationID, "provider_id": payload.ProviderID, "role": payload.Role, "technology": payload.Technology, "status": payload.Status, "created_at": now})
		return
	}
	if parts[0] != payload.ID {
		writeError(w, 409, "line id is immutable")
		return
	}
	var previous linePayload
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,organization_id,provider_id,role,technology,status,created_at FROM lines WHERE id=$1`, parts[0]).Scan(&previous.ID, &previous.OrganizationID, &previous.ProviderID, &previous.Role, &previous.Technology, &previous.Status, &created); err != nil {
		writeError(w, 404, "line not found")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE lines SET organization_id=$1,provider_id=$2,role=$3,technology=$4,status=$5 WHERE id=$6`, payload.OrganizationID, payload.ProviderID, payload.Role, payload.Technology, payload.Status, parts[0]); err != nil {
		writeError(w, 409, "line update failed or references are invalid")
		return
	}
	writeAudit(r.Context(), s, p, "line.updated", "line", parts[0], previous, payload)
	writeJSON(w, 200, map[string]interface{}{"id": payload.ID, "organization_id": payload.OrganizationID, "provider_id": payload.ProviderID, "role": payload.Role, "technology": payload.Technology, "status": payload.Status, "created_at": created})
}

type pointPayload struct {
	ID       string `json:"id"`
	LineID   string `json:"line_id"`
	Location string `json:"location"`
	Primary  bool   `json:"is_primary"`
	Active   bool   `json:"active"`
}

func (s *Server) adminMonitoringPoints(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet && len(parts) == 0 {
		s.adminPoints(w, r, p)
		return
	}
	if len(parts) > 1 || (len(parts) == 1 && parts[0] == "") {
		writeError(w, 404, "monitoring point not found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload pointPayload
	payload.Active = true
	if err := decodeJSON(r, &payload); err != nil || payload.ID == "" || payload.LineID == "" {
		writeError(w, 422, "invalid monitoring point payload")
		return
	}
	var lineExists bool
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM lines WHERE id=$1)`, payload.LineID).Scan(&lineExists); err != nil || !lineExists {
		writeError(w, 422, "line not found")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if r.Method == http.MethodPost {
		if payload.Primary {
			_, _ = s.DB.Pool.Exec(r.Context(), `UPDATE monitoring_points SET is_primary=FALSE WHERE line_id=$1`, payload.LineID)
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO monitoring_points(id,line_id,location,is_primary,active,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, payload.ID, payload.LineID, payload.Location, payload.Primary, payload.Active, now); err != nil {
			writeError(w, 409, "monitoring point already exists or line is invalid")
			return
		}
		writeAudit(r.Context(), s, p, "monitoring_point.created", "monitoring_point", payload.ID, nil, payload)
		writeJSON(w, 201, map[string]interface{}{"id": payload.ID, "line_id": payload.LineID, "location": payload.Location, "is_primary": payload.Primary, "active": payload.Active, "created_at": now})
		return
	}
	if parts[0] != payload.ID {
		writeError(w, 409, "monitoring point id is immutable")
		return
	}
	var previous pointPayload
	var created time.Time
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT id,line_id,location,is_primary,active,created_at FROM monitoring_points WHERE id=$1`, parts[0]).Scan(&previous.ID, &previous.LineID, &previous.Location, &previous.Primary, &previous.Active, &created); err != nil {
		writeError(w, 404, "monitoring point not found")
		return
	}
	if payload.Primary {
		_, _ = s.DB.Pool.Exec(r.Context(), `UPDATE monitoring_points SET is_primary=FALSE WHERE line_id=$1 AND id<>$2`, payload.LineID, parts[0])
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE monitoring_points SET line_id=$1,location=$2,is_primary=$3,active=$4 WHERE id=$5`, payload.LineID, payload.Location, payload.Primary, payload.Active, parts[0]); err != nil {
		writeError(w, 409, "monitoring point update failed")
		return
	}
	writeAudit(r.Context(), s, p, "monitoring_point.updated", "monitoring_point", parts[0], previous, payload)
	writeJSON(w, 200, map[string]interface{}{"id": payload.ID, "line_id": payload.LineID, "location": payload.Location, "is_primary": payload.Primary, "active": payload.Active, "created_at": created})
}

func writeAudit(ctx context.Context, s *Server, p *auth.Principal, action, objectType, objectID string, before, after interface{}) {
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	_, _ = s.DB.Pool.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,before_json,after_json,request_id,created_at) VALUES ('USER',$1,$2,$3,$4,NULLIF($5,'')::jsonb,NULLIF($6,'')::jsonb,NULL,now())`, p.ID, action, objectType, objectID, string(beforeJSON), string(afterJSON))
}

func (s *Server) adminPoints(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,line_id,location,is_primary,active,created_at FROM monitoring_points ORDER BY id`)
	if err != nil {
		writeError(w, 500, "could not query points")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id, line, location string
		var primary, active bool
		var created time.Time
		if rows.Scan(&id, &line, &location, &primary, &active, &created) == nil {
			result = append(result, map[string]interface{}{"id": id, "line_id": line, "location": location, "is_primary": primary, "active": active, "created_at": created})
		}
	}
	writeJSON(w, 200, result)
}

func (s *Server) adminDevices(w http.ResponseWriter, r *http.Request, p *auth.Principal, parts []string) {
	if !requireAdmin(w, p) {
		return
	}
	if len(parts) > 0 && parts[0] == "register" && r.Method == http.MethodPost {
		var payload struct {
			DeviceID          string `json:"device_id"`
			MonitoringPointID string `json:"monitoring_point_id"`
			AgentVersion      string `json:"agent_version"`
		}
		if err := decodeJSON(r, &payload); err != nil {
			writeError(w, 422, "invalid device payload")
			return
		}
		if payload.DeviceID == "" || payload.MonitoringPointID == "" {
			writeError(w, 422, "device_id and monitoring_point_id are required")
			return
		}
		var lineID string
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT line_id FROM monitoring_points WHERE id=$1 AND active`, payload.MonitoringPointID).Scan(&lineID); err != nil {
			writeError(w, 404, "active monitoring point not found")
			return
		}
		if payload.AgentVersion == "" {
			payload.AgentVersion = "0.1.0"
		}
		token := randomSecret()
		now := time.Now().UTC().Truncate(time.Second)
		if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO devices(id,monitoring_point_id,auth_token_hash,agent_version,created_at) VALUES ($1,$2,$3,$4,$5)`, payload.DeviceID, payload.MonitoringPointID, auth.TokenHash(token), payload.AgentVersion, now); err != nil {
			writeError(w, 409, "device id already registered")
			return
		}
		writeAudit(r.Context(), s, p, "device.registered", "device", payload.DeviceID, nil, map[string]interface{}{"monitoring_point_id": payload.MonitoringPointID, "line_id": lineID, "agent_version": payload.AgentVersion})
		writeJSON(w, 201, map[string]interface{}{"device_id": payload.DeviceID, "monitoring_point_id": payload.MonitoringPointID, "line_id": lineID, "agent_version": payload.AgentVersion, "device_token": token})
		return
	}
	if len(parts) > 1 && parts[1] == "block" && r.Method == http.MethodPost {
		now := time.Now().UTC()
		var exists bool
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1)`, parts[0]).Scan(&exists); err != nil || !exists {
			writeError(w, 404, "device not found")
			return
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE devices SET blocked_at=$1 WHERE id=$2`, now, parts[0]); err != nil {
			writeError(w, 500, "could not block device")
			return
		}
		writeAudit(r.Context(), s, p, "device.blocked", "device", parts[0], nil, map[string]interface{}{"blocked_at": now})
		writeJSON(w, 200, map[string]interface{}{"device_id": parts[0], "blocked": true, "blocked_at": now})
		return
	}
	if len(parts) > 1 && parts[1] == "unblock" && r.Method == http.MethodPost {
		var exists bool
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1)`, parts[0]).Scan(&exists); err != nil || !exists {
			writeError(w, 404, "device not found")
			return
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `UPDATE devices SET blocked_at=NULL WHERE id=$1`, parts[0]); err != nil {
			writeError(w, 500, "could not unblock device")
			return
		}
		writeAudit(r.Context(), s, p, "device.unblocked", "device", parts[0], nil, map[string]interface{}{"blocked_at": nil})
		writeJSON(w, 200, map[string]interface{}{"device_id": parts[0], "blocked": false, "blocked_at": nil})
		return
	}
	if r.Method == http.MethodGet {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT d.id,d.monitoring_point_id,mp.line_id,l.organization_id,o.school_id,o.name,d.agent_version,d.last_seen,d.blocked_at,d.created_at FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id JOIN lines l ON l.id=mp.line_id JOIN organizations o ON o.id=l.organization_id ORDER BY o.district,o.name,d.id`)
		if err != nil {
			writeError(w, 500, "could not query devices")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var id, point, line, organizationID, schoolID, organizationName, version string
			var seen, blocked, created *time.Time
			if rows.Scan(&id, &point, &line, &organizationID, &schoolID, &organizationName, &version, &seen, &blocked, &created) == nil {
				result = append(result, map[string]interface{}{"id": id, "monitoring_point_id": point, "line_id": line, "organization_id": organizationID, "school_id": schoolID, "organization_name": organizationName, "agent_version": version, "last_seen": seen, "blocked_at": blocked, "blocked": blocked != nil, "created_at": created})
			}
		}
		writeJSON(w, 200, result)
		return
	}
	writeError(w, 404, "not found")
}

func randomSecret() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprint(time.Now().UnixNano())))
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func (s *Server) adminSchedule(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet {
		var tests, jitter, light int
		if err := s.DB.Pool.QueryRow(r.Context(), `SELECT tests_per_day,jitter_minutes,light_checks_between FROM agent_schedules WHERE id=1`).Scan(&tests, &jitter, &light); err != nil {
			tests, jitter, light = 4, 8, 0
		}
		writeJSON(w, 200, map[string]interface{}{"tests_per_day": tests, "performance_tests_per_day": tests, "jitter_minutes": jitter, "light_checks_between": light != 0})
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload struct {
		TestsPerDay            *int `json:"tests_per_day"`
		PerformanceTestsPerDay *int `json:"performance_tests_per_day"`
		JitterMinutes          *int `json:"jitter_minutes"`
		LightChecksBetween     bool `json:"light_checks_between"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid schedule payload")
		return
	}
	testsPerDay := 4
	if payload.TestsPerDay != nil {
		testsPerDay = *payload.TestsPerDay
	} else if payload.PerformanceTestsPerDay != nil {
		testsPerDay = *payload.PerformanceTestsPerDay
	}
	jitterMinutes := 8
	if payload.JitterMinutes != nil {
		jitterMinutes = *payload.JitterMinutes
	}
	if testsPerDay < 3 || testsPerDay > 5 || jitterMinutes < 0 || jitterMinutes > 240 {
		writeError(w, 422, "tests_per_day must be 3-5 and jitter_minutes 0-240")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `INSERT INTO agent_schedules(id,tests_per_day,jitter_minutes,light_checks_between,updated_by,updated_at) VALUES (1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET tests_per_day=EXCLUDED.tests_per_day,jitter_minutes=EXCLUDED.jitter_minutes,light_checks_between=EXCLUDED.light_checks_between,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`, testsPerDay, jitterMinutes, boolInt(payload.LightChecksBetween), p.ID, time.Now().UTC().Truncate(time.Second)); err != nil {
		writeError(w, 500, "could not store schedule")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"tests_per_day": testsPerDay, "performance_tests_per_day": testsPerDay, "jitter_minutes": jitterMinutes, "light_checks_between": payload.LightChecksBetween})
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (s *Server) adminPolicy(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet {
		rows, err := s.DB.Pool.Query(r.Context(), `SELECT id,scope_type,scope_id,version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds,created_at FROM threshold_policy_versions ORDER BY valid_from DESC`)
		if err != nil {
			writeError(w, 500, "could not query policies")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var id int64
			var typ string
			var scope *string
			var version, cc, cm, rc, rm, fs int
			var from time.Time
			var to *time.Time
			var d, u, ping, jit, loss, av float64
			var created time.Time
			if rows.Scan(&id, &typ, &scope, &version, &from, &to, &d, &u, &ping, &jit, &loss, &av, &cc, &cm, &rc, &rm, &fs, &created) == nil {
				result = append(result, map[string]interface{}{"id": id, "scope_type": typ, "scope_id": scope, "version": version, "valid_from": from, "valid_to": to, "download_min": d, "upload_min": u, "ping_max": ping, "jitter_max": jit, "packet_loss_max": loss, "availability_min": av, "confirm_count": cc, "confirm_minutes": cm, "recovery_count": rc, "recovery_minutes": rm, "freshness_seconds": fs, "created_at": created})
			}
		}
		writeJSON(w, 200, result)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload struct {
		ScopeType        string     `json:"scope_type"`
		ScopeID          string     `json:"scope_id"`
		ValidFrom        *time.Time `json:"valid_from"`
		ValidTo          *time.Time `json:"valid_to"`
		Version          int        `json:"version"`
		DownloadMin      float64    `json:"download_min"`
		UploadMin        float64    `json:"upload_min"`
		PingMax          float64    `json:"ping_max"`
		JitterMax        float64    `json:"jitter_max"`
		PacketLossMax    float64    `json:"packet_loss_max"`
		AvailabilityMin  float64    `json:"availability_min"`
		ConfirmCount     int        `json:"confirm_count"`
		ConfirmMinutes   int        `json:"confirm_minutes"`
		RecoveryCount    int        `json:"recovery_count"`
		RecoveryMinutes  int        `json:"recovery_minutes"`
		FreshnessSeconds int        `json:"freshness_seconds"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid policy payload")
		return
	}
	if payload.ScopeType == "" {
		payload.ScopeType = "GLOBAL"
	}
	payload.ScopeType = strings.ToUpper(payload.ScopeType)
	if payload.ScopeType != "GLOBAL" && payload.ScopeType != "LINE" {
		writeError(w, 422, "scope_type must be GLOBAL or LINE")
		return
	}
	if payload.ScopeType == "LINE" && strings.TrimSpace(payload.ScopeID) == "" {
		writeError(w, 422, "scope_id is required for LINE policy")
		return
	}
	if payload.ValidFrom == nil {
		now := time.Now().UTC().Truncate(time.Second)
		payload.ValidFrom = &now
	}
	if payload.DownloadMin == 0 {
		payload.DownloadMin = 20
	}
	if payload.UploadMin == 0 {
		payload.UploadMin = 20
	}
	if payload.PingMax == 0 {
		payload.PingMax = 100
	}
	if payload.JitterMax == 0 {
		payload.JitterMax = 30
	}
	if payload.PacketLossMax == 0 {
		payload.PacketLossMax = 2
	}
	if payload.AvailabilityMin == 0 {
		payload.AvailabilityMin = 99
	}
	if payload.ConfirmCount == 0 {
		payload.ConfirmCount = 3
	}
	if payload.RecoveryCount == 0 {
		payload.RecoveryCount = 3
	}
	if payload.FreshnessSeconds == 0 {
		payload.FreshnessSeconds = 86400
	}
	if payload.DownloadMin < 0 || payload.UploadMin < 0 || payload.PingMax < 0 || payload.JitterMax < 0 || payload.PacketLossMax < 0 || payload.PacketLossMax > 100 || payload.AvailabilityMin < 0 || payload.AvailabilityMin > 100 || payload.ConfirmCount < 1 || payload.ConfirmCount > 100 || payload.ConfirmMinutes < 0 || payload.ConfirmMinutes > 10080 || payload.RecoveryCount < 1 || payload.RecoveryCount > 100 || payload.RecoveryMinutes < 0 || payload.RecoveryMinutes > 10080 || payload.FreshnessSeconds < 1 || payload.FreshnessSeconds > 604800 {
		writeError(w, 422, "policy thresholds are outside the allowed range")
		return
	}
	if payload.ValidTo != nil && !payload.ValidTo.After(*payload.ValidFrom) {
		writeError(w, 422, "valid_to must be after valid_from")
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin policy transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := lockVersionScope(r.Context(), tx, "policy:"+payload.ScopeType+":"+payload.ScopeID); err != nil {
		writeError(w, 500, "could not lock policy scope")
		return
	}
	if err := policyOverlap(r.Context(), tx, payload.ScopeType, payload.ScopeID, *payload.ValidFrom, payload.ValidTo, p.ID); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	if payload.Version == 0 {
		if err := tx.QueryRow(r.Context(), `SELECT COALESCE(MAX(version),0)+1 FROM threshold_policy_versions WHERE scope_type=$1 AND scope_id IS NOT DISTINCT FROM $2`, payload.ScopeType, nullableString(payload.ScopeID)).Scan(&payload.Version); err != nil {
			writeError(w, 500, "could not allocate policy version")
			return
		}
	}
	var id int64
	err = tx.QueryRow(r.Context(), `INSERT INTO threshold_policy_versions(scope_type,scope_id,valid_from,valid_to,version,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, payload.ScopeType, nullableString(payload.ScopeID), *payload.ValidFrom, payload.ValidTo, payload.Version, payload.DownloadMin, payload.UploadMin, payload.PingMax, payload.JitterMax, payload.PacketLossMax, payload.AvailabilityMin, payload.ConfirmCount, payload.ConfirmMinutes, payload.RecoveryCount, payload.RecoveryMinutes, payload.FreshnessSeconds, p.ID, time.Now().UTC().Truncate(time.Second)).Scan(&id)
	if err != nil {
		if isVersionConstraintConflict(err) {
			writeError(w, http.StatusConflict, "policy version or effective interval conflicts with an existing version")
			return
		}
		writeError(w, 500, "could not create policy")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit policy")
		return
	}
	writeJSON(w, 201, map[string]interface{}{"id": id, "version": payload.Version, "scope_type": payload.ScopeType, "scope_id": payload.ScopeID, "valid_from": payload.ValidFrom, "valid_to": payload.ValidTo, "confirm_count": payload.ConfirmCount, "confirm_minutes": payload.ConfirmMinutes, "recovery_count": payload.RecoveryCount, "recovery_minutes": payload.RecoveryMinutes})
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

type versionInterval struct {
	id   int64
	from time.Time
	to   *time.Time
}

func lockVersionScope(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 742031))`, key)
	return err
}

func isVersionConstraintConflict(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23P01" || pgErr.Code == "23505"
}

func policyOverlap(ctx context.Context, tx pgx.Tx, typ, scope string, from time.Time, to *time.Time, actor string) error {
	rows, err := tx.Query(ctx, `SELECT id,valid_from,valid_to FROM threshold_policy_versions WHERE scope_type=$1 AND scope_id IS NOT DISTINCT FROM $2 ORDER BY valid_from FOR UPDATE`, typ, nullableString(scope))
	if err != nil {
		return err
	}
	intervals := []versionInterval{}
	for rows.Next() {
		var item versionInterval
		if err := rows.Scan(&item.id, &item.from, &item.to); err != nil {
			rows.Close()
			return err
		}
		intervals = append(intervals, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, existing := range intervals {
		if (to == nil || existing.from.Before(*to)) && (existing.to == nil || from.Before(*existing.to)) {
			// A new version supersedes an open-ended predecessor. Closing that
			// predecessor preserves non-overlapping effective intervals while
			// retaining its historical snapshot.
			if existing.to == nil && from.After(existing.from) {
				if _, err := tx.Exec(ctx, `UPDATE threshold_policy_versions SET valid_to=$1 WHERE id=$2`, from, existing.id); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,before_json,after_json,created_at) VALUES ('USER',$1,'policy.version_closed','threshold_policy',$2,$3::jsonb,$4::jsonb,now())`, actor, fmt.Sprint(existing.id), fmt.Sprintf(`{"valid_to":null}`), fmt.Sprintf(`{"valid_to":%q}`, from.UTC().Format(time.RFC3339))); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("policy effective interval overlaps an existing version")
		}
	}
	return nil
}

func (s *Server) adminContract(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	if r.Method == http.MethodGet {
		lineID := r.URL.Query().Get("line_id")
		query := `SELECT id,line_id,valid_from,valid_to,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at FROM contract_versions`
		args := []interface{}{}
		if lineID != "" {
			query += ` WHERE line_id=$1`
			args = append(args, lineID)
		}
		query += ` ORDER BY line_id,valid_from DESC`
		rows, err := s.DB.Pool.Query(r.Context(), query, args...)
		if err != nil {
			writeError(w, 500, "could not query contracts")
			return
		}
		defer rows.Close()
		result := []map[string]interface{}{}
		for rows.Next() {
			var id int64
			var line string
			var createdBy *string
			var from, createdAt time.Time
			var to, contractDate *time.Time
			var contractNumber *string
			var d, u, ping, jitter, loss, availability *float64
			if rows.Scan(&id, &line, &from, &to, &contractNumber, &contractDate, &d, &u, &ping, &jitter, &loss, &availability, &createdBy, &createdAt) == nil {
				result = append(result, map[string]interface{}{"id": id, "line_id": line, "valid_from": from, "valid_to": to, "contract_no": contractNumber, "contract_date": contractDate, "download_min": d, "upload_min": u, "ping_max": ping, "jitter_max": jitter, "packet_loss_max": loss, "availability_min": availability, "created_by": createdBy, "created_at": createdAt})
			}
		}
		writeJSON(w, 200, result)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, 405, "method not allowed")
		return
	}
	var payload struct {
		LineID          string     `json:"line_id"`
		ValidFrom       time.Time  `json:"valid_from"`
		ValidTo         *time.Time `json:"valid_to"`
		ContractNo      *string    `json:"contract_no"`
		ContractDate    *time.Time `json:"contract_date"`
		DownloadMin     *float64   `json:"download_min"`
		UploadMin       *float64   `json:"upload_min"`
		PingMax         *float64   `json:"ping_max"`
		JitterMax       *float64   `json:"jitter_max"`
		PacketLossMax   *float64   `json:"packet_loss_max"`
		AvailabilityMin *float64   `json:"availability_min"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, 422, "invalid contract payload")
		return
	}
	if payload.ValidFrom.IsZero() {
		writeError(w, 422, "valid_from is required")
		return
	}
	if strings.TrimSpace(payload.LineID) == "" {
		writeError(w, 422, "line_id is required")
		return
	}
	var lineExists bool
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM lines WHERE id=$1)`, payload.LineID).Scan(&lineExists); err != nil || !lineExists {
		writeError(w, 422, "line not found")
		return
	}
	if payload.ValidTo != nil && !payload.ValidTo.After(payload.ValidFrom) {
		writeError(w, 422, "valid_to must be after valid_from")
		return
	}
	for name, value := range map[string]*float64{"download_min": payload.DownloadMin, "upload_min": payload.UploadMin, "ping_max": payload.PingMax, "jitter_max": payload.JitterMax, "packet_loss_max": payload.PacketLossMax, "availability_min": payload.AvailabilityMin} {
		if value != nil && (*value < 0 || (name == "packet_loss_max" || name == "availability_min") && *value > 100) {
			writeError(w, 422, "contract thresholds are outside the allowed range")
			return
		}
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin contract transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := lockVersionScope(r.Context(), tx, "contract:"+payload.LineID); err != nil {
		writeError(w, 500, "could not lock contract scope")
		return
	}
	if err := contractOverlap(r.Context(), tx, payload.LineID, payload.ValidFrom, payload.ValidTo, p.ID); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	var id int64
	err = tx.QueryRow(r.Context(), `INSERT INTO contract_versions(line_id,valid_from,valid_to,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, payload.LineID, payload.ValidFrom, payload.ValidTo, payload.ContractNo, payload.ContractDate, payload.DownloadMin, payload.UploadMin, payload.PingMax, payload.JitterMax, payload.PacketLossMax, payload.AvailabilityMin, p.ID, time.Now().UTC().Truncate(time.Second)).Scan(&id)
	if err != nil {
		if isVersionConstraintConflict(err) {
			writeError(w, http.StatusConflict, "contract version or effective interval conflicts with an existing version")
			return
		}
		writeError(w, 500, "could not create contract")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit contract")
		return
	}
	writeJSON(w, 201, map[string]interface{}{"id": id, "line_id": payload.LineID, "valid_from": payload.ValidFrom, "valid_to": payload.ValidTo})
}

func contractOverlap(ctx context.Context, tx pgx.Tx, lineID string, from time.Time, to *time.Time, actor string) error {
	rows, err := tx.Query(ctx, `SELECT id,valid_from,valid_to FROM contract_versions WHERE line_id=$1 ORDER BY valid_from FOR UPDATE`, lineID)
	if err != nil {
		return err
	}
	intervals := []versionInterval{}
	for rows.Next() {
		var item versionInterval
		if err := rows.Scan(&item.id, &item.from, &item.to); err != nil {
			rows.Close()
			return err
		}
		intervals = append(intervals, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, existing := range intervals {
		if (to == nil || existing.from.Before(*to)) && (existing.to == nil || from.Before(*existing.to)) {
			if existing.to == nil && from.After(existing.from) {
				if _, err := tx.Exec(ctx, `UPDATE contract_versions SET valid_to=$1 WHERE id=$2`, from, existing.id); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,before_json,after_json,created_at) VALUES ('USER',$1,'contract.version_closed','contract_version',$2,$3::jsonb,$4::jsonb,now())`, actor, fmt.Sprint(existing.id), `{"valid_to":null}`, fmt.Sprintf(`{"valid_to":%q}`, from.UTC().Format(time.RFC3339))); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("contract effective interval overlaps an existing version")
		}
	}
	return nil
}

var _ = json.Marshal
