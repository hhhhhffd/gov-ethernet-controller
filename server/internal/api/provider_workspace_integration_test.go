package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
)

type providerWorkspaceIntegrationFixture struct {
	oneEventCase int64
	multipleCase int64
	lineOnlyCase int64
	allowedToken string
	deniedToken  string
}

func TestProviderCaseWorkspaceDetailTimeline(t *testing.T) {
	db := openProviderWorkspaceIntegrationDB(t)
	t.Cleanup(db.Close)

	fixture := createProviderWorkspaceIntegrationFixture(t, db)
	server, err := New(db, "")
	if err != nil {
		t.Fatalf("create API server: %v", err)
	}

	tests := []struct {
		name          string
		caseID        int64
		token         string
		wantStatus    int
		wantEventType []string
	}{
		{name: "linked incident with one event", caseID: fixture.oneEventCase, token: fixture.allowedToken, wantStatus: http.StatusOK, wantEventType: []string{"CONFIRMED"}},
		{name: "linked incident with multiple events", caseID: fixture.multipleCase, token: fixture.allowedToken, wantStatus: http.StatusOK, wantEventType: []string{"CONFIRMED", "RECOVERY_OBSERVED"}},
		{name: "line-only case has empty timeline", caseID: fixture.lineOnlyCase, token: fixture.allowedToken, wantStatus: http.StatusOK, wantEventType: []string{}},
		{name: "foreign provider scope is denied", caseID: fixture.oneEventCase, token: fixture.deniedToken, wantStatus: http.StatusNotFound, wantEventType: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, body := getProviderCaseDetail(t, server, test.caseID, test.token)
			if status != test.wantStatus {
				t.Fatalf("provider case detail status = %d, want %d; body=%v", status, test.wantStatus, body)
			}
			if test.wantEventType == nil {
				if _, exists := body["timeline"]; exists {
					t.Fatalf("scope-denied response leaked timeline: %#v", body["timeline"])
				}
				if _, exists := body["incident"]; exists {
					t.Fatalf("scope-denied response leaked incident: %#v", body["incident"])
				}
				return
			}

			timeline, ok := body["timeline"].([]interface{})
			if !ok {
				t.Fatalf("timeline type = %T, want JSON array; body=%v", body["timeline"], body)
			}
			if len(timeline) != len(test.wantEventType) {
				t.Fatalf("timeline length = %d, want %d; timeline=%v", len(timeline), len(test.wantEventType), timeline)
			}
			for index, expectedType := range test.wantEventType {
				event, ok := timeline[index].(map[string]interface{})
				if !ok || event["event_type"] != expectedType {
					t.Fatalf("timeline[%d] = %#v, want event_type %q", index, timeline[index], expectedType)
				}
			}
		})
	}
}

func openProviderWorkspaceIntegrationDB(t *testing.T) *database.DB {
	t.Helper()
	if os.Getenv("LINKWATCH_ENV") == "production" && os.Getenv("LINKWATCH_TEST_DATABASE_URL") == "" {
		t.Skip("provider workspace integration test requires LINKWATCH_TEST_DATABASE_URL outside production")
	}
	dsn := os.Getenv("LINKWATCH_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = database.DefaultDSN()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Skipf("provider workspace integration test requires PostgreSQL: %v", err)
	}
	return db
}

func createProviderWorkspaceIntegrationFixture(t *testing.T, db *database.DB) providerWorkspaceIntegrationFixture {
	t.Helper()
	prefix := fmt.Sprintf("provider-workspace-regression-%d", time.Now().UnixNano())
	t.Cleanup(func() { cleanupProviderWorkspaceIntegrationFixture(t, db, prefix) })
	now := time.Now().UTC().Truncate(time.Second)
	orgID := prefix + "-org"
	providerID := prefix + "-provider"
	lineID := prefix + "-line-only"
	oneEventLineID := prefix + "-one-event-line"
	multipleEventLineID := prefix + "-multiple-event-line"
	providerUserID := prefix + "-allowed-user"
	deniedUserID := prefix + "-denied-user"
	allowedLegacyToken := prefix + "-allowed-legacy"
	deniedLegacyToken := prefix + "-denied-legacy"

	exec := func(query string, args ...interface{}) {
		t.Helper()
		if _, err := db.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatalf("fixture query failed: %v", err)
		}
	}
	queryID := func(query string, args ...interface{}) int64 {
		t.Helper()
		var id int64
		if err := db.Pool.QueryRow(context.Background(), query, args...).Scan(&id); err != nil {
			t.Fatalf("fixture query returning id failed: %v", err)
		}
		return id
	}

	exec(`INSERT INTO organizations(id,school_id,name,district,created_at) VALUES ($1,$2,$3,$4,$5)`, orgID, prefix+"-school", "Provider workspace regression", prefix+"-district", now)
	exec(`INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, providerID, prefix+" provider", now)
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, lineID, orgID, providerID, now)
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, oneEventLineID, orgID, providerID, now)
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, multipleEventLineID, orgID, providerID, now)
	exec(`INSERT INTO users(id,username,role,token_hash,created_at) VALUES ($1,$2,'PROVIDER',$3,$4)`, providerUserID, prefix+"-allowed", auth.TokenHash(allowedLegacyToken), now)
	exec(`INSERT INTO users(id,username,role,token_hash,created_at) VALUES ($1,$2,'PROVIDER',$3,$4)`, deniedUserID, prefix+"-denied", auth.TokenHash(deniedLegacyToken), now)
	exec(`INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,'PROVIDER',$2)`, providerUserID, providerID)
	exec(`INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,'PROVIDER',$2)`, deniedUserID, prefix+"-foreign-provider")

	allowedToken, _, err := auth.IssueSession(context.Background(), db, providerUserID, time.Hour, "127.0.0.1", "provider workspace regression")
	if err != nil {
		t.Fatalf("issue allowed session: %v", err)
	}
	deniedToken, _, err := auth.IssueSession(context.Background(), db, deniedUserID, time.Hour, "127.0.0.1", "provider workspace regression")
	if err != nil {
		t.Fatalf("issue denied session: %v", err)
	}

	createIncidentCase := func(label, incidentLineID string, eventTypes ...string) int64 {
		t.Helper()
		incidentID := queryID(`INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,opening_snapshot_json,created_at) VALUES ($1,$2,'AUTO','NO_INTERNET','NEW','NONE',$3,'{}'::jsonb,$3) RETURNING id`, prefix+"-"+label, incidentLineID, now)
		for index, eventType := range eventTypes {
			exec(`INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,$2,$3,$4::jsonb,$5)`, incidentID, eventType, prefix+"-actor", fmt.Sprintf(`{"note":"event-%d"}`, index+1), now.Add(time.Duration(index)*time.Second))
		}
		return queryID(`INSERT INTO provider_cases(incident_id,line_id,source_context,draft_text,status,delivery_status,created_by,created_at) VALUES ($1,NULL,'INCIDENT','regression draft','DRAFT','PENDING',$2,$3) RETURNING id`, incidentID, providerUserID, now)
	}

	return providerWorkspaceIntegrationFixture{
		oneEventCase: createIncidentCase("one-event", oneEventLineID, "CONFIRMED"),
		multipleCase: createIncidentCase("multiple-events", multipleEventLineID, "CONFIRMED", "RECOVERY_OBSERVED"),
		lineOnlyCase: queryID(`INSERT INTO provider_cases(incident_id,line_id,source_context,draft_text,status,delivery_status,created_by,created_at) VALUES (NULL,$1,'LINE','line regression draft','DRAFT','PENDING',$2,$3) RETURNING id`, lineID, providerUserID, now),
		allowedToken: allowedToken,
		deniedToken:  deniedToken,
	}
}

func cleanupProviderWorkspaceIntegrationFixture(t *testing.T, db *database.DB, prefix string) {
	t.Helper()
	pattern := prefix + "%"
	queries := []string{
		`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE id LIKE $1)`,
		`DELETE FROM role_scopes WHERE user_id IN (SELECT id FROM users WHERE id LIKE $1)`,
		`DELETE FROM provider_cases WHERE created_by LIKE $1 OR line_id LIKE $1 OR incident_id IN (SELECT id FROM incidents WHERE incident_no LIKE $1)`,
		`DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE incident_no LIKE $1)`,
		`DELETE FROM incidents WHERE incident_no LIKE $1`,
		`DELETE FROM users WHERE id LIKE $1`,
		`DELETE FROM lines WHERE id LIKE $1`,
		`DELETE FROM providers WHERE id LIKE $1`,
		`DELETE FROM organizations WHERE id LIKE $1`,
	}
	for _, query := range queries {
		if _, err := db.Pool.Exec(context.Background(), query, pattern); err != nil {
			t.Errorf("cleanup query failed: %v", err)
		}
	}
}

func getProviderCaseDetail(t *testing.T, server *Server, caseID int64, token string) (int, map[string]interface{}) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/provider-cases/%d", caseID), nil)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode provider case response: %v; body=%q", err, recorder.Body.String())
	}
	return recorder.Code, body
}
