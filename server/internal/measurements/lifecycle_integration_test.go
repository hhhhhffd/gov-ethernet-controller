package measurements

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"linkwatch/server/internal/database"
)

type lineStateIntegrationRecord struct {
	DataState       string
	ConnectionState string
	ContractState   string
	RecoveryState   string
	EffectiveSince  *time.Time
	UpdatedAt       time.Time
	Reason          string
	Evidence        []int64
}

func TestIncidentLifecycleRegressionPreservesHistoryAndCurrentState(t *testing.T) {
	db := openMeasurementIntegrationDB(t)
	t.Cleanup(db.Close)
	fixture := createMeasurementIntegrationFixture(t, db, nil, 2)
	t.Cleanup(func() { cleanupMeasurementIntegrationFixture(t, db, fixture) })
	service := &Service{DB: db}
	base := time.Date(2026, 9, 19, 14, 0, 0, 0, time.UTC)

	first := submitLifecycleMeasurement(t, service, fixture, base, "lifecycle-violation-1", "PERFORMANCE", floatPointer(100), floatPointer(10))
	second := submitLifecycleMeasurement(t, service, fixture, base.Add(time.Minute), "lifecycle-violation-2", "PERFORMANCE", floatPointer(100), floatPointer(10))
	third := submitLifecycleMeasurement(t, service, fixture, base.Add(2*time.Minute), "lifecycle-violation-3", "PERFORMANCE", floatPointer(100), floatPointer(10))
	incident := readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "NEW" || incident.Violation != "BASELINE_UPLOAD" {
		t.Fatalf("initial incident = status %q type %q, want NEW/BASELINE_UPLOAD", incident.Status, incident.Violation)
	}
	assertIDsEqual(t, incidentEvidenceIDs(t, incident.Snapshot), []int64{third.MeasurementID, second.MeasurementID, first.MeasurementID})

	// Provider/operator workflow is an external boundary to measurements.Service.
	// Persist it in the same incident tables before continuing through Process.
	setLifecycleIncidentStatus(t, db, incident.ID, "SENT_TO_PROVIDER", "SENT_TO_PROVIDER", base.Add(2*time.Minute))
	setLifecycleIncidentStatus(t, db, incident.ID, "IN_PROGRESS", "STATUS_CHANGED", base.Add(2*time.Minute))
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" {
		t.Fatalf("incident status after provider workflow = %q, want IN_PROGRESS", incident.Status)
	}

	// A healthy observation of another metric cannot be recovery evidence for
	// the upload incident when upload is absent.
	submitLifecycleMeasurement(t, service, fixture, base.Add(3*time.Minute), "lifecycle-unrelated-metric", "PERFORMANCE", floatPointer(100), nil)
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" || incident.Recovery != "NONE" {
		t.Fatalf("unrelated metric changed recovery: status=%s recovery=%s", incident.Status, incident.Recovery)
	}

	// LIGHT evidence does not satisfy a PERFORMANCE incident even when the
	// measured upload is healthy.
	submitLifecycleMeasurement(t, service, fixture, base.Add(4*time.Minute), "lifecycle-light-recovery", "LIGHT", floatPointer(100), floatPointer(100))
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" || incident.Recovery != "NONE" {
		t.Fatalf("LIGHT evidence changed PERFORMANCE recovery: status=%s recovery=%s", incident.Status, incident.Recovery)
	}

	submitLifecycleMeasurement(t, service, fixture, base.Add(5*time.Minute), "lifecycle-recovery-1", "PERFORMANCE", floatPointer(100), floatPointer(100))
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" || incident.Recovery != "OBSERVED" {
		t.Fatalf("first recovery = status %s recovery %s, want IN_PROGRESS/OBSERVED", incident.Status, incident.Recovery)
	}
	if got := incidentEventTypes(t, db, incident.ID); !containsEventType(got, "RECOVERY_OBSERVED") {
		t.Fatalf("recovery observation event missing: %v", got)
	}

	// Mark the operator-confirmed RESOLVED boundary, then prove that a
	// violation return reopens the same incident before confirmed recovery.
	setLifecycleIncidentStatus(t, db, incident.ID, "RESOLVED", "PROVIDER_REPORTED_FIXED", base.Add(5*time.Minute))
	returned := submitLifecycleMeasurement(t, service, fixture, base.Add(6*time.Minute), "lifecycle-violation-return", "PERFORMANCE", floatPointer(100), floatPointer(10))
	if returned.MeasurementID <= 0 {
		t.Fatal("violation return was not persisted")
	}
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "IN_PROGRESS" || incident.Recovery != "NONE" {
		t.Fatalf("returned violation did not reopen incident: status=%s recovery=%s", incident.Status, incident.Recovery)
	}
	if got := incidentEventTypes(t, db, incident.ID); !containsEventType(got, "REOPENED") {
		t.Fatalf("reopen event missing: %v", got)
	}

	// Two consecutive upload recoveries satisfy the fixture's recovery policy.
	secondRecovery := submitLifecycleMeasurement(t, service, fixture, base.Add(7*time.Minute), "lifecycle-recovery-2", "PERFORMANCE", floatPointer(100), floatPointer(100))
	lastRecovery := submitLifecycleMeasurement(t, service, fixture, base.Add(8*time.Minute), "lifecycle-recovery-3", "PERFORMANCE", floatPointer(100), floatPointer(100))
	incident = readLatestIncident(t, db, fixture.lineID)
	if incident.Status != "CLOSED" || incident.Recovery != "CONFIRMED" {
		t.Fatalf("confirmed recovery = status %s recovery %s, want CLOSED/CONFIRMED", incident.Status, incident.Recovery)
	}
	if incident.Duration == nil || *incident.Duration < 0 {
		t.Fatalf("closed incident duration = %v, want non-negative", incident.Duration)
	}
	recoveryEvidence := incidentEvidenceIDsFromEvent(t, db, incident.ID, "RECOVERY_CONFIRMED")
	if len(recoveryEvidence) != 2 || recoveryEvidence[0] != lastRecovery.MeasurementID || recoveryEvidence[1] != secondRecovery.MeasurementID {
		t.Fatalf("recovery evidence = %#v, want [%d %d]", recoveryEvidence, lastRecovery.MeasurementID, secondRecovery.MeasurementID)
	}

	closedSnapshot := append([]byte(nil), incident.Snapshot...)
	closedEventCount := countIncidentEvents(t, db, incident.ID)
	stateBeforeBackfill := readLineState(t, db, fixture.lineID)

	// This old violation is accepted as evidence but must not rewrite current
	// line state or the immutable closed incident.
	backfill := submitLifecycleMeasurement(t, service, fixture, base.Add(time.Minute), "lifecycle-backfilled-old-violation", "PERFORMANCE", floatPointer(100), floatPointer(10))
	if backfill.StateApplied {
		t.Fatal("backfilled observation rewrote current state")
	}
	stateAfterBackfill := readLineState(t, db, fixture.lineID)
	assertLineStateEqual(t, stateAfterBackfill, stateBeforeBackfill)
	closedAfterBackfill := readLatestIncident(t, db, fixture.lineID)
	if closedAfterBackfill.ID != incident.ID || closedAfterBackfill.Status != "CLOSED" || string(closedAfterBackfill.Snapshot) != string(closedSnapshot) {
		t.Fatalf("backfill changed closed incident: before=%#v after=%#v", incident, closedAfterBackfill)
	}
	if got := countIncidentEvents(t, db, incident.ID); got != closedEventCount {
		t.Fatalf("backfill added history to closed incident: before=%d after=%d", closedEventCount, got)
	}

	// A new confirmed violation after closure creates a same-type recurrence.
	submitLifecycleMeasurement(t, service, fixture, base.Add(9*time.Minute), "lifecycle-recurrence-1", "PERFORMANCE", floatPointer(100), floatPointer(10))
	submitLifecycleMeasurement(t, service, fixture, base.Add(10*time.Minute), "lifecycle-recurrence-2", "PERFORMANCE", floatPointer(100), floatPointer(10))
	submitLifecycleMeasurement(t, service, fixture, base.Add(11*time.Minute), "lifecycle-recurrence-3", "PERFORMANCE", floatPointer(100), floatPointer(10))
	recurrence := readLatestIncident(t, db, fixture.lineID)
	if recurrence.ID == incident.ID || recurrence.Violation != "BASELINE_UPLOAD" {
		t.Fatalf("recurrence = %#v, want a new BASELINE_UPLOAD incident", recurrence)
	}
	if recurrence.RecurrenceOf == nil || *recurrence.RecurrenceOf != incident.ID {
		t.Fatalf("recurrence_of = %v, want %d", recurrence.RecurrenceOf, incident.ID)
	}
	if string(readIncidentSnapshot(t, db, incident.ID)) != string(closedSnapshot) {
		t.Fatal("closed incident snapshot changed after recurrence")
	}
}

func submitLifecycleMeasurement(t *testing.T, service *Service, fixture measurementIntegrationFixture, observedAt time.Time, eventID, mode string, download, upload *float64) Result {
	t.Helper()
	result, err := service.Process(context.Background(), fixture.deviceID, fixture.lineID, fixture.pointID, "integration-test", Input{
		ClientEventID:    fixture.prefix + "-" + eventID,
		ObservedAt:       observedAt,
		Mode:             mode,
		Download:         download,
		Upload:           upload,
		Ping:             floatPointer(20),
		Jitter:           floatPointer(1),
		PacketLoss:       floatPointer(0),
		Availability:     floatPointer(100),
		ConnectionStatus: "OK",
		Quality:          "VALID",
	})
	if err != nil {
		t.Fatalf("process lifecycle measurement %s: %v", eventID, err)
	}
	if !result.Accepted || result.MeasurementID <= 0 {
		t.Fatalf("lifecycle measurement %s was not accepted: %#v", eventID, result)
	}
	return result
}

func setLifecycleIncidentStatus(t *testing.T, db *database.DB, incidentID int64, status, eventType string, at time.Time) {
	t.Helper()
	if _, err := db.Pool.Exec(context.Background(), `UPDATE incidents SET status=$1,recovery_state=CASE WHEN $1='RESOLVED' THEN 'OBSERVED' ELSE recovery_state END,resolved_at=CASE WHEN $1='RESOLVED' THEN $2 ELSE resolved_at END WHERE id=$3`, status, at, incidentID); err != nil {
		t.Fatalf("set lifecycle incident status %s: %v", status, err)
	}
	if _, err := db.Pool.Exec(context.Background(), `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,$2,'integration-test',$3::jsonb,$4)`, incidentID, eventType, `{"status":"`+status+`"}`, at); err != nil {
		t.Fatalf("record lifecycle incident event %s: %v", eventType, err)
	}
}

func readLineState(t *testing.T, db *database.DB, lineID string) lineStateIntegrationRecord {
	t.Helper()
	var item lineStateIntegrationRecord
	var evidence []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json FROM line_states WHERE line_id=$1`, lineID).Scan(&item.DataState, &item.ConnectionState, &item.ContractState, &item.RecoveryState, &item.EffectiveSince, &item.UpdatedAt, &item.Reason, &evidence); err != nil {
		t.Fatalf("read line state: %v", err)
	}
	if err := json.Unmarshal(evidence, &item.Evidence); err != nil {
		t.Fatalf("decode line state evidence: %v", err)
	}
	return item
}

func assertLineStateEqual(t *testing.T, got, want lineStateIntegrationRecord) {
	t.Helper()
	if got.DataState != want.DataState || got.ConnectionState != want.ConnectionState || got.ContractState != want.ContractState || got.RecoveryState != want.RecoveryState || got.Reason != want.Reason || !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Fatalf("line state changed: got=%#v want=%#v", got, want)
	}
	if (got.EffectiveSince == nil) != (want.EffectiveSince == nil) || (got.EffectiveSince != nil && !got.EffectiveSince.Equal(*want.EffectiveSince)) {
		t.Fatalf("line state effective_since changed: got=%v want=%v", got.EffectiveSince, want.EffectiveSince)
	}
	assertIDsEqual(t, got.Evidence, want.Evidence)
}

func incidentEventTypes(t *testing.T, db *database.DB, incidentID int64) []string {
	t.Helper()
	rows, err := db.Pool.Query(context.Background(), `SELECT event_type FROM incident_events WHERE incident_id=$1 ORDER BY id`, incidentID)
	if err != nil {
		t.Fatalf("query incident event types: %v", err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var eventType string
		if err := rows.Scan(&eventType); err != nil {
			t.Fatalf("scan incident event type: %v", err)
		}
		result = append(result, eventType)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate incident event types: %v", err)
	}
	return result
}

func containsEventType(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func countIncidentEvents(t *testing.T, db *database.DB, incidentID int64) int {
	t.Helper()
	var count int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM incident_events WHERE incident_id=$1`, incidentID).Scan(&count); err != nil {
		t.Fatalf("count incident events: %v", err)
	}
	return count
}
