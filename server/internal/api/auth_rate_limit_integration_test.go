package api

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
)

func openRateLimitTestDB(t *testing.T) (*database.DB, context.Context, string) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("LINKWATCH_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run PostgreSQL rate-limit integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open rate-limit test database: %v", err)
	}
	keyPrefix := fmt.Sprintf("task006-%d-", time.Now().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM auth_rate_limits WHERE key LIKE $1`, keyPrefix+"%")
		db.Close()
	})
	return db, context.Background(), keyPrefix
}

func trustedProxyTestNetworks(t *testing.T) []*net.IPNet {
	t.Helper()
	networks, err := parseTrustedProxyCIDRs("172.30.0.10/32")
	if err != nil {
		t.Fatalf("parse trusted proxy: %v", err)
	}
	return networks
}

func trustedProxyTestKey(t *testing.T, remote, forwarded string, networks []*net.IPNet) string {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = remote
	if forwarded != "" {
		r.Header.Set("X-Forwarded-For", forwarded)
	}
	return authClientKeyWithTrustedProxies(r, networks)
}

func TestLoginRateLimitTrustedProxyClientsHaveIndependentBudgets(t *testing.T) {
	db, ctx, prefix := openRateLimitTestDB(t)
	networks := trustedProxyTestNetworks(t)
	keyA := prefix + trustedProxyTestKey(t, "172.30.0.10:8080", "198.51.100.10", networks)
	keyB := prefix + trustedProxyTestKey(t, "172.30.0.10:8080", "198.51.100.11", networks)

	for attempt := 0; attempt < 2; attempt++ {
		allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyA, 2, time.Minute)
		if err != nil || !allowed {
			t.Fatalf("client A attempt %d: allowed=%v err=%v", attempt+1, allowed, err)
		}
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyA, 2, time.Minute); err != nil || allowed {
		t.Fatalf("client A exceeded budget: allowed=%v err=%v", allowed, err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyB, 2, time.Minute); err != nil || !allowed {
		t.Fatalf("client B was affected by client A budget: allowed=%v err=%v", allowed, err)
	}
}

func TestLoginRateLimitDirectForgedForwardingCannotBypass(t *testing.T) {
	db, ctx, prefix := openRateLimitTestDB(t)
	networks := trustedProxyTestNetworks(t)
	firstKey := prefix + trustedProxyTestKey(t, "198.51.100.10:4000", "203.0.113.99", networks)
	forgedKey := prefix + trustedProxyTestKey(t, "198.51.100.10:4000", "198.51.100.200", networks)
	if firstKey != forgedKey {
		t.Fatalf("direct forged header changed rate-limit key from %q to %q", firstKey, forgedKey)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", firstKey, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("first direct attempt: allowed=%v err=%v", allowed, err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", forgedKey, 1, time.Minute); err != nil || allowed {
		t.Fatalf("forged direct forwarding bypassed limit: allowed=%v err=%v", allowed, err)
	}
}

func TestLoginRateLimitSuccessfulResetOnlyClearsOwnIdentity(t *testing.T) {
	db, ctx, prefix := openRateLimitTestDB(t)
	networks := trustedProxyTestNetworks(t)
	keyA := prefix + trustedProxyTestKey(t, "172.30.0.10:8080", "198.51.100.10", networks)
	keyB := prefix + trustedProxyTestKey(t, "172.30.0.10:8080", "198.51.100.11", networks)

	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyA, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("client A first attempt: allowed=%v err=%v", allowed, err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyA, 1, time.Minute); err != nil || allowed {
		t.Fatalf("client A should be exhausted: allowed=%v err=%v", allowed, err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyB, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("client B first attempt: allowed=%v err=%v", allowed, err)
	}
	if err := auth.ClearRateLimit(ctx, db, "login", keyA); err != nil {
		t.Fatalf("clear client A budget: %v", err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyA, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("client A budget was not reset: allowed=%v err=%v", allowed, err)
	}
	if allowed, _, err := auth.CheckRateLimit(ctx, db, "login", keyB, 1, time.Minute); err != nil || allowed {
		t.Fatalf("client B budget was reset by client A: allowed=%v err=%v", allowed, err)
	}
}

func TestSuccessfulLoginResetsOnlyItsTrustedProxyIdentity(t *testing.T) {
	db, ctx, prefix := openRateLimitTestDB(t)
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv(trustedProxyCIDRsEnv, "172.30.0.10/32")
	t.Setenv("LINKWATCH_LOGIN_RATE_LIMIT", "2")

	userID := prefix + "user"
	username := prefix + "username"
	password := "task006-correct-password"
	clientAIP := fmt.Sprintf("198.51.100.%d", 20+time.Now().UnixNano()%200)
	clientBIP := fmt.Sprintf("198.51.101.%d", 20+time.Now().UnixNano()%200)
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("hash test password: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,role,token_hash,password_hash,created_at) VALUES ($1,$2,'ADMIN',$3,$4,now())`, userID, username, auth.TokenHash(prefix+"legacy-token"), passwordHash); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM auth_sessions WHERE user_id=$1`, userID)
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM audit_events WHERE actor_id=$1 OR object_id=$2`, userID, username)
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1`, userID)
	})
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM auth_rate_limits WHERE scope=$1 AND key IN ($2,$3)`, "login", clientAIP, clientBIP)
	})

	server, err := New(db, "")
	if err != nil {
		t.Fatalf("create server with trusted proxy config: %v", err)
	}
	login := func(remote, forwarded, suppliedPassword string) int {
		body := fmt.Sprintf(`{"username":%q,"password":%q}`, username, suppliedPassword)
		r := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewBufferString(body))
		r.RemoteAddr = remote
		r.Header.Set("X-Forwarded-For", forwarded)
		response := httptest.NewRecorder()
		server.login(response, r)
		return response.Code
	}
	keyRequestA := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	keyRequestA.RemoteAddr = "172.30.0.10:8080"
	keyRequestA.Header.Set("X-Forwarded-For", clientAIP)
	keyRequestB := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	keyRequestB.RemoteAddr = "172.30.0.10:8080"
	keyRequestB.Header.Set("X-Forwarded-For", clientBIP)
	if keyA, keyB := server.authClientKey(keyRequestA), server.authClientKey(keyRequestB); keyA == keyB {
		t.Fatalf("server collapsed trusted client keys to %q", keyA)
	}

	if code := login("172.30.0.10:8080", clientAIP, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("client A failed login status = %d, want %d", code, http.StatusUnauthorized)
	}
	if code := login("172.30.0.10:8080", clientBIP, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("client B first failed login status = %d, want %d", code, http.StatusUnauthorized)
	}
	if code := login("172.30.0.10:8080", clientBIP, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("client B second failed login status = %d, want %d", code, http.StatusUnauthorized)
	}
	if code := login("172.30.0.10:8080", clientBIP, "wrong"); code != http.StatusTooManyRequests {
		t.Fatalf("client B exhausted status = %d, want %d", code, http.StatusTooManyRequests)
	}
	if code := login("172.30.0.10:8080", clientAIP, password); code != http.StatusOK {
		t.Fatalf("client A successful login status = %d, want %d", code, http.StatusOK)
	}
	if code := login("172.30.0.10:8080", clientBIP, "wrong"); code != http.StatusTooManyRequests {
		t.Fatalf("client B budget was reset by client A login: status = %d", code)
	}
}

func TestLoginRateLimitConcurrentWritesKeepEveryAttempt(t *testing.T) {
	db, ctx, prefix := openRateLimitTestDB(t)
	key := prefix + "concurrent"
	const workers = 32
	start := make(chan struct{})
	results := make(chan error, workers)
	var wait sync.WaitGroup
	wait.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wait.Done()
			<-start
			allowed, _, err := auth.CheckRateLimit(ctx, db, "login", key, workers, time.Minute)
			if err != nil {
				results <- err
				return
			}
			if !allowed {
				results <- fmt.Errorf("an attempt was rejected before the %d-attempt budget was exhausted", workers)
				return
			}
			results <- nil
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}

	var attempts int
	if err := db.Pool.QueryRow(ctx, `SELECT attempts FROM auth_rate_limits WHERE scope=$1 AND key=$2`, "login", key).Scan(&attempts); err != nil {
		t.Fatalf("read concurrent attempt count: %v", err)
	}
	if attempts != workers {
		t.Fatalf("concurrent attempts = %d, want %d", attempts, workers)
	}
}
