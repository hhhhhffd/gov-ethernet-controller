package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/database"
)

type Scope struct {
	Type string `json:"scope_type"`
	ID   string `json:"scope_id"`
}

type Principal struct {
	ID           string   `json:"id"`
	Username     string   `json:"username"`
	Role         string   `json:"role"`
	Scopes       []Scope  `json:"scopes,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
}

func (p Principal) IsAdmin() bool { return p.Role == "ADMIN" || p.Role == "OBLAST" }

// EffectiveCapabilities is the server-authoritative action contract consumed by
// the browser. Object scope remains enforced separately by backend routes.
func EffectiveCapabilities(p *Principal) []string {
	if p == nil {
		return nil
	}
	capabilities := []string{"line.read", "incident.read", "report.read", "report.export"}
	switch p.Role {
	case "ADMIN":
		capabilities = append(capabilities, "audit.read", "admin.manage", "admin.users", "admin.devices", "admin.policies", "notification.dispatch", "incident.create", "incident.update", "provider_case.draft", "provider_case.send")
	case "OBLAST", "DISTRICT":
		capabilities = append(capabilities, "audit.read", "incident.create", "incident.update", "provider_case.draft", "provider_case.send")
	case "PROVIDER":
		capabilities = append(capabilities, "incident.update", "provider_case.draft", "provider_case.send")
	}
	return capabilities
}

func TokenHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", sum[:])
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func HashPassword(password string) (string, error) {
	if password == "" || len(password) > 1024 {
		return "", fmt.Errorf("password must contain 1-1024 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	const iterations = 310000
	digest := pbkdf2Key([]byte(password), salt, iterations, 32)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s", iterations,
		base64.RawURLEncoding.EncodeToString(salt), base64.RawURLEncoding.EncodeToString(digest)), nil
}

func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	var iterations int
	if _, err := fmt.Sscanf(parts[1], "%d", &iterations); err != nil || iterations < 100000 || iterations > 2000000 {
		return false
	}
	salt, err1 := base64.RawURLEncoding.DecodeString(parts[2])
	expected, err2 := base64.RawURLEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil || len(expected) == 0 {
		return false
	}
	actual := pbkdf2Key([]byte(password), salt, iterations, len(expected))
	return hmac.Equal(actual, expected)
}

// pbkdf2Key is the RFC 8018 PBKDF2-HMAC-SHA256 construction.  It keeps the
// server dependency-light while remaining compatible with the hashes emitted
// by the previous Python runtime.
func pbkdf2Key(password, salt []byte, iterations, length int) []byte {
	result := make([]byte, 0, length)
	for block := uint32(1); len(result) < length; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iterations; i++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		result = append(result, t...)
	}
	return result[:length]
}

func IssueSession(ctx context.Context, db *database.DB, userID string, ttl time.Duration, ip, ua string) (string, time.Time, error) {
	if ttl < 5*time.Minute {
		ttl = 5 * time.Minute
	}
	if ttl > 30*24*time.Hour {
		ttl = 30 * 24 * time.Hour
	}
	token, err := randomToken()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now().UTC().Truncate(time.Second)
	expires := now.Add(ttl)
	_, err = db.Pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at,last_seen_at,ip_address,user_agent)
        VALUES ($1,$2,$3,$4,$5,$4,$6,$7)`, randomID(), userID, TokenHash(token), now, expires, ip, truncate(ua, 512))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("issue session: %w", err)
	}
	return token, expires, nil
}

func randomID() string {
	token, err := randomToken()
	if err != nil {
		return fmt.Sprintf("session-%d", time.Now().UnixNano())
	}
	return token
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func AuthenticateUser(ctx context.Context, db *database.DB, token string) (*Principal, error) {
	if token == "" {
		return nil, fmt.Errorf("missing token")
	}
	var p Principal
	var sessionID string
	var userID string
	err := db.Pool.QueryRow(ctx, `SELECT u.id,u.username,u.role,s.id
        FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, TokenHash(token)).Scan(&userID, &p.Username, &p.Role, &sessionID)
	if err != nil {
		// Legacy user tokens remain readable only outside production. They are
		// useful for upgrading an existing development database, never a default
		// production authentication path.
		if strings.EqualFold(os.Getenv("LINKWATCH_ENV"), "production") && os.Getenv("LINKWATCH_ALLOW_LEGACY_TOKENS") != "1" {
			return nil, fmt.Errorf("invalid token")
		}
		err = db.Pool.QueryRow(ctx, `SELECT id,username,role FROM users WHERE token_hash=$1 AND disabled_at IS NULL`, TokenHash(token)).Scan(&userID, &p.Username, &p.Role)
		if err != nil {
			return nil, fmt.Errorf("invalid token")
		}
	} else {
		p.ID = userID
		_, _ = db.Pool.Exec(ctx, `UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1`, sessionID)
	}
	p.ID = userID
	rows, err := db.Pool.Query(ctx, `SELECT scope_type,scope_id FROM role_scopes WHERE user_id=$1 ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var scope Scope
		if err := rows.Scan(&scope.Type, &scope.ID); err != nil {
			return nil, err
		}
		p.Scopes = append(p.Scopes, scope)
	}
	return &p, rows.Err()
}

type Device struct {
	ID              string
	MonitoringPoint string
	LineID          string
	PointID         string
	Hostname        *string
	AgentVersion    string
	LastSeen        *time.Time
}

func AuthenticateDevice(ctx context.Context, db *database.DB, deviceID, token string) (*Device, error) {
	if deviceID == "" || token == "" {
		return nil, fmt.Errorf("device credentials required")
	}
	device := &Device{}
	err := db.Pool.QueryRow(ctx, `SELECT d.id,d.monitoring_point_id,mp.line_id,mp.id,d.hostname,d.agent_version,d.last_seen
        FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id
        WHERE d.id=$1 AND d.auth_token_hash=$2 AND d.blocked_at IS NULL AND mp.active`, deviceID, TokenHash(token)).Scan(
		&device.ID, &device.MonitoringPoint, &device.LineID, &device.PointID, &device.Hostname, &device.AgentVersion, &device.LastSeen)
	if err != nil {
		return nil, fmt.Errorf("invalid or blocked device")
	}
	return device, nil
}

// CheckRateLimit records one failed authentication attempt for a scoped key.
// The row is locked in a short transaction so limits remain effective when
// several server replicas handle the same credentials concurrently.
func CheckRateLimit(ctx context.Context, db *database.DB, scope, key string, limit int, window time.Duration) (bool, time.Duration, error) {
	if limit < 1 {
		limit = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now().UTC()
	var started time.Time
	var attempts int
	err = tx.QueryRow(ctx, `SELECT window_started_at,attempts FROM auth_rate_limits WHERE scope=$1 AND key=$2 FOR UPDATE`, scope, key).Scan(&started, &attempts)
	if err != nil && err != pgx.ErrNoRows {
		return false, 0, err
	}
	if err == pgx.ErrNoRows || !now.Before(started.Add(window)) {
		started = now
		attempts = 1
		_, err = tx.Exec(ctx, `INSERT INTO auth_rate_limits(scope,key,window_started_at,attempts) VALUES ($1,$2,$3,$4) ON CONFLICT(scope,key) DO UPDATE SET window_started_at=EXCLUDED.window_started_at,attempts=EXCLUDED.attempts`, scope, key, started, attempts)
	} else {
		attempts++
		_, err = tx.Exec(ctx, `UPDATE auth_rate_limits SET attempts=$3 WHERE scope=$1 AND key=$2`, scope, key, attempts)
	}
	if err != nil {
		return false, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	if attempts <= limit {
		return true, 0, nil
	}
	return false, time.Until(started.Add(window)), nil
}

// ClearRateLimit forgets the failed-attempt counter after a successful
// authentication, preventing a user's normal activity from consuming a
// failure budget.
func ClearRateLimit(ctx context.Context, db *database.DB, scope, key string) error {
	_, err := db.Pool.Exec(ctx, `DELETE FROM auth_rate_limits WHERE scope=$1 AND key=$2`, scope, key)
	return err
}

func Bearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 8 || !strings.EqualFold(header[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

func HasLineScope(p *Principal, lineID, organizationID, district, providerID string) bool {
	if p == nil {
		return false
	}
	if p.IsAdmin() {
		return true
	}
	for _, scope := range p.Scopes {
		switch strings.ToUpper(scope.Type) {
		case "LINE":
			if scope.ID == lineID {
				return true
			}
		case "ORGANIZATION":
			if (p.Role == "DISTRICT" || p.Role == "SCHOOL") && scope.ID == organizationID {
				return true
			}
		case "DISTRICT":
			if p.Role == "DISTRICT" && scope.ID == district {
				return true
			}
		case "PROVIDER":
			if p.Role == "PROVIDER" && scope.ID == providerID {
				return true
			}
		}
	}
	return false
}

func RoleAllows(p *Principal, action string) bool {
	if p == nil {
		return false
	}
	if p.Role == "ADMIN" {
		return true
	}
	switch action {
	case "comment":
		return true
	case "provider_fixed", "send_to_provider", "provider_send":
		return p.Role == "OBLAST" || p.Role == "DISTRICT" || p.Role == "PROVIDER"
	case "assign":
		return p.Role == "OBLAST" || p.Role == "DISTRICT"
	case "status":
		return p.Role == "OBLAST" || p.Role == "DISTRICT" || p.Role == "PROVIDER"
	default:
		return p.Role == "OBLAST" || p.Role == "DISTRICT" || p.Role == "PROVIDER"
	}
}
