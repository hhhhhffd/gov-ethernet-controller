package admin

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"linkwatch/server/internal/database"
	"linkwatch/server/internal/measurements"
)

func TestResetDemoClearsDraftGenerationsBeforeProviderCases(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("LINKWATCH_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run the demo reset integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Skipf("demo reset integration test requires PostgreSQL: %v", err)
	}
	t.Cleanup(db.Close)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if err := ResetDemo(cleanupCtx, db); err != nil {
			t.Errorf("restore demo database after reset integration test: %v", err)
		}
	})

	if err := ResetDemo(ctx, db); err != nil {
		t.Fatalf("prepare demo database: %v", err)
	}
	assertRowCount(t, ctx, db, "demo line context versions", `SELECT COUNT(*) FROM line_context_versions`, 4)
	var schoolID, schoolName, district, address string
	var latitude, longitude float64
	if err := db.Pool.QueryRow(ctx, `SELECT school_id,name,district,address,latitude,longitude FROM organizations WHERE id='org-42'`).Scan(&schoolID, &schoolName, &district, &address, &latitude, &longitude); err != nil {
		t.Fatalf("read seeded registry school: %v", err)
	}
	if schoolID != demoRegistrySchoolID || schoolName != demoRegistrySchoolName || district != demoRegistrySchoolDistrict || address != demoRegistrySchoolAddress {
		t.Fatalf("seeded organization identity = (%q, %q, %q, %q), want registry school 18383", schoolID, schoolName, district, address)
	}
	if latitude != demoRegistrySchoolLatitude || longitude != demoRegistrySchoolLongitude {
		t.Fatalf("seeded organization coordinates = (%v, %v), want official registry coordinates (%v, %v)", latitude, longitude, demoRegistrySchoolLatitude, demoRegistrySchoolLongitude)
	}
	demoObservationAt := time.Date(2020, time.January, 2, 0, 0, 0, 0, time.UTC)
	if _, err := measurements.ResolveContext(ctx, db.Pool, "line-42-primary", demoObservationAt); err != nil {
		t.Fatalf("resolve seeded demo line context for historical observation: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	incidentNo := fmt.Sprintf("TASK-018-RESET-%d", now.UnixNano())
	var incidentID, caseID int64
	if err := db.Pool.QueryRow(ctx, `INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,created_at)
		VALUES ($1,'line-42-primary','AUTO','CONTRACT','NEW','NONE',$2,$2) RETURNING id`, incidentNo, now).Scan(&incidentID); err != nil {
		t.Fatalf("insert reset fixture incident: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO provider_cases(incident_id,draft_text,created_by,created_at)
		VALUES ($1,'reset fixture draft','task018-reset-test',$2) RETURNING id`, incidentID, now).Scan(&caseID); err != nil {
		t.Fatalf("insert reset fixture provider case: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO provider_case_draft_generations(provider_case_id,requested_by,provider,model,prompt_version,evidence_digest,status,created_at)
		VALUES ($1,'task018-reset-test','test-provider','test-model','v1','reset-fixture-digest','FAILED',$2)`, caseID, now); err != nil {
		t.Fatalf("insert reset fixture draft generation: %v", err)
	}

	assertRowCount(t, ctx, db, "provider_case_draft_generations", `SELECT COUNT(*) FROM provider_case_draft_generations`, 1)
	assertRowCount(t, ctx, db, "provider_cases", `SELECT COUNT(*) FROM provider_cases`, 1)

	if err := ResetDemo(ctx, db); err != nil {
		t.Fatalf("reset demo with dependent draft generation: %v", err)
	}
	assertRowCount(t, ctx, db, "provider_case_draft_generations", `SELECT COUNT(*) FROM provider_case_draft_generations`, 0)
	assertRowCount(t, ctx, db, "provider_cases", `SELECT COUNT(*) FROM provider_cases`, 0)

	if err := ResetDemo(ctx, db); err != nil {
		t.Fatalf("repeat empty demo reset: %v", err)
	}
	assertRowCount(t, ctx, db, "provider_case_draft_generations", `SELECT COUNT(*) FROM provider_case_draft_generations`, 0)
	assertRowCount(t, ctx, db, "provider_cases", `SELECT COUNT(*) FROM provider_cases`, 0)
	assertRowCount(t, ctx, db, "organizations", `SELECT COUNT(*) FROM organizations`, 3)
}

func assertRowCount(t *testing.T, ctx context.Context, db *database.DB, name, query string, want int) {
	t.Helper()
	var got int
	if err := db.Pool.QueryRow(ctx, query).Scan(&got); err != nil {
		t.Fatalf("count %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("count %s = %d, want %d", name, got, want)
	}
}
