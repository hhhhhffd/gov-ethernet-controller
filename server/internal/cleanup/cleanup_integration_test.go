package cleanup

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"linkwatch/server/internal/database"
)

func TestCleanupControlledFixtureDryRunApplyAndRepeat(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("LINKWATCH_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run the controlled cleanup integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Skipf("controlled cleanup integration test requires PostgreSQL: %v", err)
	}
	defer db.Close()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	prefix := "task016-ai-" + suffix
	organizationID := prefix + "-org"
	providerID := prefix + "-provider"
	lineID := prefix + "-line"
	pointID := prefix + "-point"
	deviceID := prefix + "-device"
	userID := "cleanup-protected-user-" + suffix
	realOrganizationID := "cleanup-real-" + suffix
	createdAt := time.Now().UTC().Truncate(time.Second)

	cleanupFixture := func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		var cleanupDatabaseName string
		if err := db.Pool.QueryRow(cleanupCtx, `SELECT current_database()`).Scan(&cleanupDatabaseName); err == nil {
			_, _ = Run(cleanupCtx, Options{DatabaseURL: dsn, Apply: true, Environment: "test", ConfirmTarget: cleanupDatabaseName, ConfirmApply: true})
		}
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1`, userID)
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM organizations WHERE id=$1`, realOrganizationID)
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM agent_config_versions WHERE created_by=$1`, userID)
		_, _ = db.Pool.Exec(cleanupCtx, `DELETE FROM agent_update_releases WHERE created_by=$1`, userID)
	}
	t.Cleanup(cleanupFixture)

	fixture := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,school_id,name,district,address,latitude,longitude,created_at) VALUES ($1,$2,$3,$4,'real address',51.1,82.1,$5),($6,$7,'Synthetic fixture','Test district','fixture',NULL,NULL,$5)`, []any{realOrganizationID, "real-school-" + suffix, "Real registry organization", "Test district", createdAt, organizationID, "fixture-school-" + suffix}},
		{`INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, []any{providerID, prefix + " provider", createdAt}},
		{`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, []any{lineID, organizationID, providerID, createdAt}},
		{`INSERT INTO monitoring_points(id,line_id,location,is_primary,created_at) VALUES ($1,$2,'fixture',TRUE,$3)`, []any{pointID, lineID, createdAt}},
		{`INSERT INTO devices(id,monitoring_point_id,auth_token_hash,created_at) VALUES ($1,$2,'fixture-hash',$3)`, []any{deviceID, pointID, createdAt}},
		{`INSERT INTO users(id,username,role,token_hash,created_at) VALUES ($1,$2,'ADMIN','fixture-token',$3)`, []any{userID, userID, createdAt}},
		{`INSERT INTO measurements(device_id,line_id,monitoring_point_id,client_event_id,observed_at,received_at,mode,raw_json) VALUES ($1,$2,$3,$4,$5,$5,'LIGHT','{}')`, []any{deviceID, lineID, pointID, prefix + "-event", createdAt}},
		{`INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,created_at) VALUES ($1,$2,'AUTO','NO_INTERNET','NEW','NONE',$3,$3) RETURNING id`, []any{"TASK-018-RESET-" + suffix, lineID, createdAt}},
	}
	var incidentID int64
	for index, statement := range fixture {
		if index == len(fixture)-1 {
			if err := db.Pool.QueryRow(ctx, statement.query, statement.args...).Scan(&incidentID); err != nil {
				t.Fatalf("insert cleanup fixture incident: %v", err)
			}
			continue
		}
		if _, err := db.Pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("insert cleanup fixture row %d: %v", index, err)
		}
	}

	var caseID int64
	if err := db.Pool.QueryRow(ctx, `INSERT INTO provider_cases(incident_id,draft_text,created_by,created_at) VALUES ($1,'fixture draft',$2,$3) RETURNING id`, incidentID, userID, createdAt).Scan(&caseID); err != nil {
		t.Fatalf("insert cleanup fixture provider case: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO provider_case_draft_generations(provider_case_id,requested_by,provider,model,prompt_version,evidence_digest,status,created_at) VALUES ($1,$2,'fixture-provider','fixture-model','v1','fixture-digest','FAILED',$3)`, caseID, userID, createdAt); err != nil {
		t.Fatalf("insert cleanup fixture draft generation: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO notifications(source_type,source_id,channel,recipient_scope,message,status,generated_at) VALUES ('PROVIDER_CASE',$1,'WEB','fixture-scope','fixture','PENDING',$2)`, fmt.Sprint(caseID), createdAt); err != nil {
		t.Fatalf("insert cleanup fixture notification: %v", err)
	}

	var databaseName string
	if err := db.Pool.QueryRow(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil {
		t.Fatalf("read cleanup test database name: %v", err)
	}
	options := Options{DatabaseURL: dsn}
	dryRun, err := Run(ctx, options)
	if err != nil {
		t.Fatalf("cleanup dry-run: %v", err)
	}
	if dryRun.Applied {
		t.Fatal("dry-run reported apply")
	}
	assertExists(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM provider_cases WHERE id=$1)`, caseID)
	assertExists(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM users WHERE id=$1)`, userID)
	assertExists(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM organizations WHERE id=$1)`, realOrganizationID)

	applyOptions := Options{DatabaseURL: dsn, Apply: true, Environment: "test", ConfirmTarget: databaseName, ConfirmApply: true}
	if result, err := Run(ctx, applyOptions); err != nil {
		t.Fatalf("cleanup apply: %v", err)
	} else if !result.Applied || result.Deleted["provider_cases"] != 1 {
		t.Fatalf("cleanup apply result = %#v, want committed provider case deletion", result)
	}
	assertMissing(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM provider_cases WHERE id=$1)`, caseID)
	assertMissing(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM devices WHERE id=$1)`, deviceID)
	assertExists(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM users WHERE id=$1)`, userID)
	assertExists(t, ctx, db, `SELECT EXISTS (SELECT 1 FROM organizations WHERE id=$1)`, realOrganizationID)

	secondDryRun, err := Run(ctx, options)
	if err != nil {
		t.Fatalf("second cleanup dry-run: %v", err)
	}
	for _, row := range secondDryRun.Rows {
		if row.Table == "provider_cases" || row.Table == "measurements" || row.Table == "devices" || row.Table == "lines" {
			if row.Targeted != 0 {
				t.Fatalf("second dry-run still targets %s: %d", row.Table, row.Targeted)
			}
		}
	}
}

func assertExists(t *testing.T, ctx context.Context, db *database.DB, query string, argument any) {
	t.Helper()
	var exists bool
	if err := db.Pool.QueryRow(ctx, query, argument).Scan(&exists); err != nil {
		t.Fatalf("existence query: %v", err)
	}
	if !exists {
		t.Fatalf("expected protected/fixture row to exist")
	}
}

func assertMissing(t *testing.T, ctx context.Context, db *database.DB, query string, argument any) {
	t.Helper()
	var exists bool
	if err := db.Pool.QueryRow(ctx, query, argument).Scan(&exists); err != nil {
		t.Fatalf("absence query: %v", err)
	}
	if exists {
		t.Fatalf("expected synthetic row to be deleted")
	}
}
