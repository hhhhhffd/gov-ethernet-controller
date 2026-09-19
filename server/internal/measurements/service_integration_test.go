package measurements

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"linkwatch/server/internal/database"
)

type measurementIntegrationFixture struct {
	prefix         string
	organizationID string
	providerID     string
	lineID         string
	pointID        string
	deviceID       string
}

type incidentIntegrationRecord struct {
	ID           int64
	Violation    string
	Status       string
	Recovery     string
	StartedAt    time.Time
	ConfirmedAt  *time.Time
	ResolvedAt   *time.Time
	ClosedAt     *time.Time
	Duration     *float64
	RecurrenceOf *int64
	Snapshot     []byte
}

func TestIncidentUsesConfirmedBaselineViolationForMixedEvaluation(t *testing.T) {
	db := openMeasurementIntegrationDB(t)
	t.Cleanup(db.Close)
	fixture := createMeasurementIntegrationFixture(t, db, nil, 3)
	t.Cleanup(func() { cleanupMeasurementIntegrationFixture(t, db, fixture) })
	service := &Service{DB: db}
	base := time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)

	first := submitMeasurement(t, service, fixture, base, "mixed-1", 100, 10)
	second := submitMeasurement(t, service, fixture, base.Add(time.Minute), "mixed-2", 100, 10)
	confirmed := submitMeasurement(t, service, fixture, base.Add(2*time.Minute), "mixed-3", 10, 10)
	incident := readLatestIncident(t, db, fixture.lineID)
	if incident.Violation != "BASELINE_UPLOAD" {
		t.Fatalf("incident violation_type = %q, want BASELINE_UPLOAD", incident.Violation)
	}
	assertIDsEqual(t, incidentEvidenceIDs(t, incident.Snapshot), []int64{confirmed.MeasurementID, second.MeasurementID, first.MeasurementID})
	assertSnapshotContainsViolation(t, incident.Snapshot, "BASELINE_DOWNLOAD")
	assertSnapshotContainsViolation(t, incident.Snapshot, "BASELINE_UPLOAD")

	// Download recovers while upload remains violated. It must not resolve the
	// upload incident because recovery is keyed by the canonical type.
	submitMeasurement(t, service, fixture, base.Add(3*time.Minute), "mixed-download-only-recovery", 100, 10)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status == "CLOSED" || incident.Recovery == "CONFIRMED" {
		t.Fatalf("download-only recovery changed upload incident: status=%s recovery=%s", incident.Status, incident.Recovery)
	}

	// Three upload recoveries are required. Keep download violated for the
	// first two to prove that the unrelated axis cannot close the incident.
	firstRecovery := submitMeasurement(t, service, fixture, base.Add(4*time.Minute), "mixed-upload-recovery-1", 10, 100)
	secondRecovery := submitMeasurement(t, service, fixture, base.Add(5*time.Minute), "mixed-upload-recovery-2", 10, 100)
	lastRecovery := submitMeasurement(t, service, fixture, base.Add(6*time.Minute), "mixed-upload-recovery-3", 100, 100)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "CLOSED" || incident.Recovery != "CONFIRMED" {
		t.Fatalf("upload recovery did not close incident: status=%s recovery=%s", incident.Status, incident.Recovery)
	}
	if incident.Duration == nil || *incident.Duration < 0 {
		t.Fatalf("incident duration = %v, want non-negative duration", incident.Duration)
	}
	assertIDsEqual(t, incidentEvidenceIDsFromEvent(t, db, incident.ID, "RECOVERY_CONFIRMED"), []int64{lastRecovery.MeasurementID, secondRecovery.MeasurementID, firstRecovery.MeasurementID})

	closedSnapshot := append([]byte(nil), incident.Snapshot...)

	// Repeated upload violations create a same-type recurrence. The old closed
	// incident must remain unchanged and the new incident must link to it.
	submitMeasurement(t, service, fixture, base.Add(7*time.Minute), "mixed-recurrence-1", 100, 10)
	submitMeasurement(t, service, fixture, base.Add(8*time.Minute), "mixed-recurrence-2", 100, 10)
	submitMeasurement(t, service, fixture, base.Add(9*time.Minute), "mixed-recurrence-3", 100, 10)
	recurrence := readLatestIncident(t, db, fixture.lineID)
	if recurrence.ID == incident.ID || recurrence.Violation != "BASELINE_UPLOAD" {
		t.Fatalf("upload recurrence = %#v, want a new BASELINE_UPLOAD incident", recurrence)
	}
	if recurrence.RecurrenceOf == nil || *recurrence.RecurrenceOf != incident.ID {
		t.Fatalf("upload recurrence_of = %v, want %d", recurrence.RecurrenceOf, incident.ID)
	}
	oldSnapshot := readIncidentSnapshot(t, db, incident.ID)
	if string(oldSnapshot) != string(closedSnapshot) {
		t.Fatalf("closed incident opening snapshot changed after recurrence: before=%s after=%s", closedSnapshot, oldSnapshot)
	}

	// A different violation type must not inherit the upload recurrence link.
	// The active upload recurrence closes on these upload-healthy observations;
	// the following three download violations then open a separate incident.
	submitMeasurement(t, service, fixture, base.Add(10*time.Minute), "mixed-different-type-1", 10, 100)
	submitMeasurement(t, service, fixture, base.Add(11*time.Minute), "mixed-different-type-2", 10, 100)
	submitMeasurement(t, service, fixture, base.Add(12*time.Minute), "mixed-different-type-3", 10, 100)
	submitMeasurement(t, service, fixture, base.Add(13*time.Minute), "mixed-different-type-4", 10, 100)
	submitMeasurement(t, service, fixture, base.Add(14*time.Minute), "mixed-different-type-5", 10, 100)
	submitMeasurement(t, service, fixture, base.Add(15*time.Minute), "mixed-different-type-6", 10, 100)
	different := readLatestIncident(t, db, fixture.lineID)
	if different.Violation != "BASELINE_DOWNLOAD" {
		t.Fatalf("different violation incident type = %q, want BASELINE_DOWNLOAD", different.Violation)
	}
	if different.RecurrenceOf != nil {
		t.Fatalf("different violation recurrence_of = %v, want NULL", different.RecurrenceOf)
	}
}

func TestIncidentUsesConfirmedContractViolationWithLateBaselineViolation(t *testing.T) {
	db := openMeasurementIntegrationDB(t)
	t.Cleanup(db.Close)
	contractUploadMinimum := 100.0
	fixture := createMeasurementIntegrationFixture(t, db, &contractUploadMinimum, 3)
	t.Cleanup(func() { cleanupMeasurementIntegrationFixture(t, db, fixture) })
	service := &Service{DB: db}
	base := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)

	first := submitMeasurement(t, service, fixture, base, "contract-1", 100, 50)
	second := submitMeasurement(t, service, fixture, base.Add(time.Minute), "contract-2", 100, 50)
	confirmed := submitMeasurement(t, service, fixture, base.Add(2*time.Minute), "contract-3", 100, 10)
	incident := readLatestIncident(t, db, fixture.lineID)
	if incident.Violation != "CONTRACT_UPLOAD" {
		t.Fatalf("incident violation_type = %q, want CONTRACT_UPLOAD", incident.Violation)
	}
	assertIDsEqual(t, incidentEvidenceIDs(t, incident.Snapshot), []int64{confirmed.MeasurementID, second.MeasurementID, first.MeasurementID})
	assertSnapshotContainsViolation(t, incident.Snapshot, "BASELINE_UPLOAD")
	assertSnapshotContainsViolation(t, incident.Snapshot, "CONTRACT_UPLOAD")

	// Baseline is healthy at 50 Mbps, but the contract remains violated. The
	// incident must continue to use CONTRACT_UPLOAD for recovery matching.
	submitMeasurement(t, service, fixture, base.Add(3*time.Minute), "contract-still-deviates", 100, 50)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status == "CLOSED" {
		t.Fatal("baseline-only recovery incorrectly closed contract incident")
	}

	lastRecovery := submitMeasurement(t, service, fixture, base.Add(4*time.Minute), "contract-recovery-1", 100, 150)
	state := readLineState(t, db, fixture.lineID)
	if state.RecoveryState != "OBSERVED" {
		t.Fatalf("contract-only recovery line state = %q, want OBSERVED", state.RecoveryState)
	}
	submitMeasurement(t, service, fixture, base.Add(5*time.Minute), "contract-recovery-2", 100, 150)
	submitMeasurement(t, service, fixture, base.Add(6*time.Minute), "contract-recovery-3", 100, 150)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "CLOSED" || incident.Recovery != "CONFIRMED" {
		t.Fatalf("contract recovery did not close incident: status=%s recovery=%s", incident.Status, incident.Recovery)
	}
	if len(incidentEvidenceIDsFromEvent(t, db, incident.ID, "RECOVERY_CONFIRMED")) != 3 || lastRecovery.MeasurementID <= 0 {
		t.Fatalf("contract recovery evidence was not persisted")
	}
}

func TestRecoveryViolationReopensProviderSentIncident(t *testing.T) {
	db := openMeasurementIntegrationDB(t)
	t.Cleanup(db.Close)
	contractUploadMinimum := 100.0
	fixture := createMeasurementIntegrationFixture(t, db, &contractUploadMinimum, 2)
	t.Cleanup(func() { cleanupMeasurementIntegrationFixture(t, db, fixture) })
	service := &Service{DB: db}
	base := time.Date(2026, 9, 19, 13, 0, 0, 0, time.UTC)

	submitMeasurement(t, service, fixture, base, "provider-reopen-1", 100, 10)
	submitMeasurement(t, service, fixture, base.Add(time.Minute), "provider-reopen-2", 100, 10)
	submitMeasurement(t, service, fixture, base.Add(2*time.Minute), "provider-reopen-3", 100, 10)
	incident := readLatestIncident(t, db, fixture.lineID)
	setLifecycleIncidentStatus(t, db, incident.ID, "SENT_TO_PROVIDER", "SENT_TO_PROVIDER", base.Add(2*time.Minute))

	submitMeasurement(t, service, fixture, base.Add(3*time.Minute), "provider-reopen-recovery", 100, 150)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "SENT_TO_PROVIDER" || incident.Recovery != "OBSERVED" {
		t.Fatalf("provider-sent recovery = status %s recovery %s, want SENT_TO_PROVIDER/OBSERVED", incident.Status, incident.Recovery)
	}

	submitMeasurement(t, service, fixture, base.Add(4*time.Minute), "provider-reopen-violation", 100, 10)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" || incident.Recovery != "NONE" {
		t.Fatalf("provider-sent violation return = status %s recovery %s, want IN_PROGRESS/NONE", incident.Status, incident.Recovery)
	}
	if got := incidentEventTypes(t, db, incident.ID); !containsEventType(got, "REOPENED") {
		t.Fatalf("provider-sent recovery reopen event missing: %v", got)
	}
}

func openMeasurementIntegrationDB(t *testing.T) *database.DB {
	t.Helper()
	dsn := os.Getenv("LINKWATCH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LINKWATCH_TEST_DATABASE_URL to run PostgreSQL measurement integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open measurement integration database: %v", err)
	}
	return db
}

func createMeasurementIntegrationFixture(t *testing.T, db *database.DB, contractUploadMinimum *float64, recoveryCount int) measurementIntegrationFixture {
	t.Helper()
	if recoveryCount < 1 {
		t.Fatalf("recovery count must be positive, got %d", recoveryCount)
	}
	prefix := fmt.Sprintf("measurement-core-%d", time.Now().UnixNano())
	fixture := measurementIntegrationFixture{
		prefix:         prefix,
		organizationID: prefix + "-org",
		providerID:     prefix + "-provider",
		lineID:         prefix + "-line",
		pointID:        prefix + "-point",
		deviceID:       prefix + "-device",
	}
	now := time.Now().UTC().Truncate(time.Second)
	validFrom := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	exec := func(query string, args ...interface{}) {
		t.Helper()
		if _, err := db.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatalf("measurement fixture query failed: %v", err)
		}
	}

	exec(`INSERT INTO organizations(id,school_id,name,district,created_at) VALUES ($1,$2,$3,$4,$5)`, fixture.organizationID, prefix+"-school", "Measurement core regression", prefix+"-district", now)
	exec(`INSERT INTO providers(id,name,created_at) VALUES ($1,$2,$3)`, fixture.providerID, prefix+" provider", now)
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER','ACTIVE',$4)`, fixture.lineID, fixture.organizationID, fixture.providerID, now)
	exec(`INSERT INTO monitoring_points(id,line_id,location,is_primary,created_at) VALUES ($1,$2,'integration',TRUE,$3)`, fixture.pointID, fixture.lineID, now)
	exec(`INSERT INTO devices(id,monitoring_point_id,auth_token_hash,created_at) VALUES ($1,$2,'integration-test',$3)`, fixture.deviceID, fixture.pointID, now)
	exec(`INSERT INTO line_context_versions(line_id,provider_id,technology,role,valid_from,version,reason,changed_by,created_at) VALUES ($1,$2,'FIBER','PRIMARY',$3,1,'integration fixture','integration-test',$4)`, fixture.lineID, fixture.providerID, validFrom, now)
	exec(`INSERT INTO threshold_policy_versions(scope_type,scope_id,valid_from,version,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds,created_by,created_at) VALUES ('LINE',$1,$2,1,20,20,100,30,2,99,3,0,NULL,$3,0,86400,'integration-test',$4)`, fixture.lineID, validFrom, recoveryCount, now)
	exec(`INSERT INTO contract_versions(line_id,valid_from,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at) VALUES ($1,$2,$3,$2,NULL,$4,NULL,NULL,NULL,NULL,'integration-test',$5)`, fixture.lineID, validFrom, prefix+"-contract", contractUploadMinimum, now)
	return fixture
}

func cleanupMeasurementIntegrationFixture(t *testing.T, db *database.DB, fixture measurementIntegrationFixture) {
	t.Helper()
	ctx := context.Background()
	queries := []struct {
		name  string
		query string
	}{
		{"audit events", `DELETE FROM audit_events WHERE (object_type='measurement' AND object_id IN (SELECT id::text FROM measurements WHERE line_id=$1)) OR (object_type='measurement_verification' AND object_id IN (SELECT v.id::text FROM measurement_verifications v JOIN measurements m ON m.id=v.candidate_measurement_id WHERE m.line_id=$1)) OR (object_type='incident' AND object_id IN (SELECT id::text FROM incidents WHERE line_id=$1))`},
		{"measurement verifications", `DELETE FROM measurement_verifications WHERE candidate_measurement_id IN (SELECT id FROM measurements WHERE line_id=$1) OR verifying_measurement_id IN (SELECT id FROM measurements WHERE line_id=$1)`},
		{"notifications", `DELETE FROM notifications WHERE source_type='INCIDENT' AND source_id IN (SELECT id::text FROM incidents WHERE line_id=$1)`},
		{"incident events", `DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE line_id=$1)`},
		{"incidents", `DELETE FROM incidents WHERE line_id=$1`},
		{"line state events", `DELETE FROM line_state_events WHERE line_id=$1`},
		{"line states", `DELETE FROM line_states WHERE line_id=$1`},
		{"measurement evaluations", `DELETE FROM measurement_evaluations WHERE measurement_id IN (SELECT id FROM measurements WHERE line_id=$1)`},
		{"measurements", `DELETE FROM measurements WHERE line_id=$1`},
		{"line context versions", `DELETE FROM line_context_versions WHERE line_id=$1`},
		{"contracts", `DELETE FROM contract_versions WHERE line_id=$1`},
		{"policy", `DELETE FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1`},
		{"devices", `DELETE FROM devices WHERE id=$1`},
		{"monitoring points", `DELETE FROM monitoring_points WHERE id=$1`},
		{"lines", `DELETE FROM lines WHERE id=$1`},
		{"providers", `DELETE FROM providers WHERE id=$1`},
		{"organizations", `DELETE FROM organizations WHERE id=$1`},
	}
	for _, item := range queries {
		args := []interface{}{fixture.lineID}
		if item.name == "devices" {
			args = []interface{}{fixture.deviceID}
		}
		if item.name == "monitoring points" {
			args = []interface{}{fixture.pointID}
		}
		if item.name == "lines" {
			args = []interface{}{fixture.lineID}
		}
		if item.name == "providers" {
			args = []interface{}{fixture.providerID}
		}
		if item.name == "organizations" {
			args = []interface{}{fixture.organizationID}
		}
		if _, err := db.Pool.Exec(ctx, item.query, args...); err != nil {
			t.Errorf("cleanup %s failed: %v", item.name, err)
		}
	}
}

func submitMeasurement(t *testing.T, service *Service, fixture measurementIntegrationFixture, observedAt time.Time, eventID string, download, upload float64) Result {
	t.Helper()
	result, err := service.Process(context.Background(), fixture.deviceID, fixture.lineID, fixture.pointID, "integration-test", Input{
		ClientEventID:    fixture.prefix + "-" + eventID,
		ObservedAt:       observedAt,
		Mode:             "PERFORMANCE",
		Download:         floatPointer(download),
		Upload:           floatPointer(upload),
		Ping:             floatPointer(20),
		Jitter:           floatPointer(1),
		PacketLoss:       floatPointer(0),
		Availability:     floatPointer(100),
		ConnectionStatus: "OK",
		Quality:          "VALID",
	})
	if err != nil {
		t.Fatalf("process measurement %s: %v", eventID, err)
	}
	if !result.Accepted || result.MeasurementID <= 0 {
		t.Fatalf("measurement %s was not accepted: %#v", eventID, result)
	}
	return result
}

func floatPointer(value float64) *float64 { return &value }

func readLatestIncident(t *testing.T, db *database.DB, lineID string) incidentIntegrationRecord {
	t.Helper()
	var item incidentIntegrationRecord
	if err := db.Pool.QueryRow(context.Background(), `SELECT id,violation_type,status,recovery_state,started_at,confirmed_at,resolved_at,closed_at,duration_minutes,recurrence_of,opening_snapshot_json FROM incidents WHERE line_id=$1 ORDER BY id DESC LIMIT 1`, lineID).Scan(&item.ID, &item.Violation, &item.Status, &item.Recovery, &item.StartedAt, &item.ConfirmedAt, &item.ResolvedAt, &item.ClosedAt, &item.Duration, &item.RecurrenceOf, &item.Snapshot); err != nil {
		t.Fatalf("read latest incident: %v", err)
	}
	return item
}

func readIncidentSnapshot(t *testing.T, db *database.DB, incidentID int64) []byte {
	t.Helper()
	var snapshot []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT opening_snapshot_json FROM incidents WHERE id=$1`, incidentID).Scan(&snapshot); err != nil {
		t.Fatalf("read incident snapshot: %v", err)
	}
	return snapshot
}

func incidentEvidenceIDs(t *testing.T, snapshot []byte) []int64 {
	t.Helper()
	var value map[string]interface{}
	if err := json.Unmarshal(snapshot, &value); err != nil {
		t.Fatalf("decode incident snapshot: %v", err)
	}
	encoded, ok := value["evidence_measurement_ids"].([]interface{})
	if !ok {
		t.Fatalf("incident snapshot evidence_measurement_ids = %#v", value["evidence_measurement_ids"])
	}
	result := make([]int64, 0, len(encoded))
	for _, item := range encoded {
		number, ok := item.(float64)
		if !ok {
			t.Fatalf("incident evidence id = %#v, want number", item)
		}
		result = append(result, int64(number))
	}
	return result
}

func incidentEvidenceIDsFromEvent(t *testing.T, db *database.DB, incidentID int64, eventType string) []int64 {
	t.Helper()
	var payload []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT payload_json FROM incident_events WHERE incident_id=$1 AND event_type=$2 ORDER BY id DESC LIMIT 1`, incidentID, eventType).Scan(&payload); err != nil {
		t.Fatalf("read incident event %s: %v", eventType, err)
	}
	var value struct {
		EvidenceMeasurementIDs []int64 `json:"evidence_measurement_ids"`
	}
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("decode incident event %s: %v", eventType, err)
	}
	return value.EvidenceMeasurementIDs
}

func assertIDsEqual(t *testing.T, got, want []int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("IDs = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("IDs = %#v, want %#v", got, want)
		}
	}
}

func assertSnapshotContainsViolation(t *testing.T, snapshot []byte, want string) {
	t.Helper()
	var value map[string]interface{}
	if err := json.Unmarshal(snapshot, &value); err != nil {
		t.Fatalf("decode incident snapshot: %v", err)
	}
	violations, ok := value["violations"].([]interface{})
	if !ok {
		t.Fatalf("incident snapshot violations = %#v", value["violations"])
	}
	for _, raw := range violations {
		item, ok := raw.(map[string]interface{})
		if ok && item["code"] == want {
			return
		}
	}
	t.Fatalf("incident snapshot does not contain violation %q: %#v", want, violations)
}
