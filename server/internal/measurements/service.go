package measurements

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"linkwatch/server/internal/database"
	"linkwatch/server/internal/evaluation"
	"linkwatch/server/internal/providers"
)

type Input struct {
	ClientEventID     string                 `json:"client_event_id"`
	DeviceID          string                 `json:"device_id,omitempty"`
	SchoolID          string                 `json:"school_id,omitempty"`
	LineID            string                 `json:"line_id,omitempty"`
	MonitoringPointID string                 `json:"monitoring_point_id,omitempty"`
	AgentVersion      string                 `json:"agent_version,omitempty"`
	ObservedAt        time.Time              `json:"observed_at"`
	Mode              string                 `json:"mode"`
	Download          *float64               `json:"download,omitempty"`
	Upload            *float64               `json:"upload,omitempty"`
	Ping              *float64               `json:"ping,omitempty"`
	Jitter            *float64               `json:"jitter,omitempty"`
	PacketLoss        *float64               `json:"packet_loss,omitempty"`
	Availability      *float64               `json:"availability,omitempty"`
	ConnectionStatus  string                 `json:"connection_status"`
	Quality           string                 `json:"quality,omitempty"`
	Raw               map[string]interface{} `json:"raw,omitempty"`
}

type Result struct {
	ClientEventID string                 `json:"client_event_id"`
	MeasurementID int64                  `json:"measurement_id"`
	Duplicate     bool                   `json:"duplicate"`
	Accepted      bool                   `json:"accepted"`
	StateApplied  bool                   `json:"state_applied"`
	Evaluation    map[string]interface{} `json:"evaluation,omitempty"`
}

type Service struct{ DB *database.DB }

type policyRow struct{ Value *evaluation.Policy }
type contractRow struct{ Value *evaluation.Contract }

type recentEvaluation struct {
	ID               int64
	ObservedAt       time.Time
	ConnectionStatus string
	BaselineState    string
	ContractState    string
	Valid            bool
	Violations       []evaluation.Violation
}

type incident struct {
	ID            int64
	LineID        string
	ViolationType string
	Status        string
	RecoveryState string
	StartedAt     time.Time
	ConfirmedAt   *time.Time
	ClosedAt      *time.Time
	ResolvedAt    *time.Time
	Opening       map[string]interface{}
}

type lineState struct {
	LineID          string
	DataState       string
	ConnectionState string
	ContractState   string
	RecoveryState   string
	EffectiveSince  *time.Time
	UpdatedAt       time.Time
	Reason          string
	EvidenceIDs     []int64
	PolicyID        *int64
}

type execer interface {
	Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error)
}

func (s *Service) Process(ctx context.Context, deviceID, lineID, pointID, agentVersion string, input Input) (Result, error) {
	if input.ClientEventID == "" {
		return Result{}, fmt.Errorf("client_event_id is required")
	}
	if input.Mode == "" {
		input.Mode = "PERFORMANCE"
	}
	if input.Quality == "" {
		input.Quality = "VALID"
	}
	if input.ConnectionStatus == "" {
		input.ConnectionStatus = "OK"
	}
	if input.Raw == nil {
		input.Raw = map[string]interface{}{}
	}
	if input.ObservedAt.IsZero() {
		return Result{}, fmt.Errorf("observed_at is required")
	}
	if err := validateInput(input); err != nil {
		return Result{}, err
	}
	input.ObservedAt = input.ObservedAt.UTC().Truncate(time.Second)
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var duplicateID int64
	if err := tx.QueryRow(ctx, `SELECT id FROM measurements WHERE device_id=$1 AND client_event_id=$2`, deviceID, input.ClientEventID).Scan(&duplicateID); err == nil {
		if err := tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return Result{ClientEventID: input.ClientEventID, MeasurementID: duplicateID, Duplicate: true, Accepted: true}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}

	policy, err := loadPolicy(ctx, tx, lineID, input.ObservedAt)
	if err != nil {
		return Result{}, err
	}
	contract, err := loadContract(ctx, tx, lineID, input.ObservedAt)
	if err != nil {
		return Result{}, err
	}
	// Capture the watermark before insertion. Looking it up after the insert
	// would include the new row and incorrectly treat every backfill as current.
	latestBefore, hasLatest, err := latestObserved(ctx, tx, lineID)
	if err != nil {
		return Result{}, err
	}
	measurement := evaluation.Measurement{ConnectionStatus: input.ConnectionStatus, Quality: input.Quality, Download: input.Download, Upload: input.Upload, Ping: input.Ping, Jitter: input.Jitter, PacketLoss: input.PacketLoss, Availability: input.Availability}
	evaluated := evaluation.Evaluate(measurement, policy.Value, contract.Value)
	raw, err := json.Marshal(input.Raw)
	if err != nil {
		return Result{}, fmt.Errorf("marshal raw measurement: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	var measurementID int64
	err = tx.QueryRow(ctx, `INSERT INTO measurements(device_id,line_id,monitoring_point_id,client_event_id,observed_at,received_at,mode,download,upload,ping,jitter,packet_loss,availability,connection_status,raw_json,quality,policy_id,contract_version_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18) RETURNING id`,
		deviceID, lineID, pointID, input.ClientEventID, input.ObservedAt, now, input.Mode, input.Download, input.Upload, input.Ping, input.Jitter, input.PacketLoss, input.Availability, input.ConnectionStatus, string(raw), input.Quality, nullablePolicyID(policy.Value), nullableContractID(contract.Value)).Scan(&measurementID)
	if err != nil {
		// A concurrent retry can win the unique constraint. Return the canonical
		// row as a duplicate instead of turning an idempotent upload into 500.
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			// PostgreSQL marks the transaction failed after a unique violation;
			// roll it back before looking up the winner on the pool.
			_ = tx.Rollback(ctx)
			if scanErr := s.DB.Pool.QueryRow(ctx, `SELECT id FROM measurements WHERE device_id=$1 AND client_event_id=$2`, deviceID, input.ClientEventID).Scan(&duplicateID); scanErr == nil {
				return Result{ClientEventID: input.ClientEventID, MeasurementID: duplicateID, Duplicate: true, Accepted: true}, nil
			}
		}
		return Result{}, err
	}
	violations, _ := json.Marshal(evaluated.Violations)
	policySnapshot, _ := json.Marshal(evaluated.PolicySnapshot)
	contractSnapshot, _ := json.Marshal(evaluated.ContractSnapshot)
	if _, err := tx.Exec(ctx, `INSERT INTO measurement_evaluations(measurement_id,baseline_state,contract_state,violations_json,valid,reason,policy_snapshot_json,contract_snapshot_json,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8::jsonb,$9)`, measurementID, evaluated.BaselineState, evaluated.ContractState, string(violations), evaluated.Valid, evaluated.Reason, string(policySnapshot), string(contractSnapshot), now); err != nil {
		return Result{}, err
	}

	late := hasLatest && input.ObservedAt.Before(latestBefore)
	if !late {
		if err := applyState(ctx, tx, lineID, input.ObservedAt, measurementID, evaluated, policy.Value, contract.Value); err != nil {
			return Result{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE devices SET last_seen=$1,agent_version=$2 WHERE id=$3`, now, firstNonEmpty(input.AgentVersion, agentVersion), deviceID); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	result := Result{ClientEventID: input.ClientEventID, MeasurementID: measurementID, Accepted: true, StateApplied: !late}
	result.Evaluation = map[string]interface{}{"baseline_state": evaluated.BaselineState, "contract_state": evaluated.ContractState, "violations": evaluated.Violations, "reason": evaluated.Reason}
	if late {
		result.Evaluation["reason"] = "Backfilled observation stored without rewriting current state; " + evaluated.Reason
	}
	return result, nil
}

func validateInput(input Input) error {
	if strings.TrimSpace(input.ClientEventID) == "" || len(input.ClientEventID) > 128 {
		return fmt.Errorf("client_event_id must contain 1-128 characters")
	}
	if input.Mode != "LIGHT" && input.Mode != "PERFORMANCE" {
		return fmt.Errorf("mode must be LIGHT or PERFORMANCE")
	}
	if input.ConnectionStatus != "OK" && input.ConnectionStatus != "NO_INTERNET" {
		return fmt.Errorf("connection_status must be OK or NO_INTERNET")
	}
	if input.Quality != "VALID" && input.Quality != "SUSPECT" && input.Quality != "INVALID" {
		return fmt.Errorf("quality must be VALID, SUSPECT or INVALID")
	}
	for name, value := range map[string]*float64{"download": input.Download, "upload": input.Upload, "ping": input.Ping, "jitter": input.Jitter, "packet_loss": input.PacketLoss, "availability": input.Availability} {
		if value != nil && (*value < 0 || math.IsNaN(*value) || math.IsInf(*value, 0)) {
			return fmt.Errorf("%s must be a non-negative finite number", name)
		}
	}
	if input.Availability != nil && *input.Availability > 100 {
		return fmt.Errorf("availability must be between 0 and 100")
	}
	if input.ConnectionStatus == "OK" && input.Download == nil && input.Upload == nil && input.Ping == nil && input.Jitter == nil && input.PacketLoss == nil && input.Availability == nil {
		return fmt.Errorf("an online measurement needs at least one metric")
	}
	return nil
}

func nullablePolicyID(p *evaluation.Policy) interface{} {
	if p == nil {
		return nil
	}
	return p.ID
}
func nullableContractID(c *evaluation.Contract) interface{} {
	if c == nil {
		return nil
	}
	return c.ID
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return "0.1.0"
}

func loadPolicy(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string, at time.Time) (policyRow, error) {
	row := &evaluation.Policy{}
	var validFrom time.Time
	var validTo *time.Time
	err := q.QueryRow(ctx, `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds
        FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from DESC LIMIT 1`, lineID, at).Scan(&row.ID, &row.ScopeType, &row.ScopeID, &row.Version, &validFrom, &validTo, &row.DownloadMin, &row.UploadMin, &row.PingMax, &row.JitterMax, &row.PacketLossMax, &row.AvailabilityMin, &row.ConfirmCount, &row.ConfirmMinutes, &row.RecoveryCount, &row.RecoveryMinutes, &row.FreshnessSec)
	if errors.Is(err, pgx.ErrNoRows) {
		err = q.QueryRow(ctx, `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds
            FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1) ORDER BY valid_from DESC LIMIT 1`, at).Scan(&row.ID, &row.ScopeType, &row.ScopeID, &row.Version, &validFrom, &validTo, &row.DownloadMin, &row.UploadMin, &row.PingMax, &row.JitterMax, &row.PacketLossMax, &row.AvailabilityMin, &row.ConfirmCount, &row.ConfirmMinutes, &row.RecoveryCount, &row.RecoveryMinutes, &row.FreshnessSec)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return policyRow{}, nil
	}
	if err != nil {
		return policyRow{}, err
	}
	row.ValidFrom = validFrom.UTC().Format(time.RFC3339)
	if validTo != nil {
		value := validTo.UTC().Format(time.RFC3339)
		row.ValidTo = &value
	}
	return policyRow{Value: row}, nil
}

func loadContract(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string, at time.Time) (contractRow, error) {
	row := &evaluation.Contract{}
	var validFrom time.Time
	var validTo *time.Time
	var contractNo *string
	err := q.QueryRow(ctx, `SELECT id,line_id,valid_from,valid_to,contract_no,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min
        FROM contract_versions WHERE line_id=$1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from DESC LIMIT 1`, lineID, at).Scan(&row.ID, &row.LineID, &validFrom, &validTo, &contractNo, &row.DownloadMin, &row.UploadMin, &row.PingMax, &row.JitterMax, &row.PacketLossMax, &row.AvailabilityMin)
	if errors.Is(err, pgx.ErrNoRows) {
		return contractRow{}, nil
	}
	if err != nil {
		return contractRow{}, err
	}
	row.ValidFrom = validFrom.UTC().Format(time.RFC3339)
	if validTo != nil {
		value := validTo.UTC().Format(time.RFC3339)
		row.ValidTo = &value
	}
	row.ContractNo = contractNo
	return contractRow{Value: row}, nil
}

func latestObserved(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string) (time.Time, bool, error) {
	var at *time.Time
	err := q.QueryRow(ctx, `SELECT MAX(observed_at) FROM measurements WHERE line_id=$1`, lineID).Scan(&at)
	if err != nil {
		return time.Time{}, false, err
	}
	if at == nil {
		return time.Time{}, false, nil
	}
	return at.UTC(), true, nil
}

func readRecent(ctx context.Context, q interface {
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
}, lineID string, limit int) ([]recentEvaluation, error) {
	rows, err := q.Query(ctx, `SELECT m.id,m.observed_at,m.connection_status,e.baseline_state,e.contract_state,e.valid,e.violations_json
        FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id WHERE m.line_id=$1 ORDER BY m.observed_at DESC,m.id DESC LIMIT $2`, lineID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []recentEvaluation{}
	for rows.Next() {
		var item recentEvaluation
		var raw []byte
		if err := rows.Scan(&item.ID, &item.ObservedAt, &item.ConnectionStatus, &item.BaselineState, &item.ContractState, &item.Valid, &raw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Violations)
		result = append(result, item)
	}
	return result, rows.Err()
}

func confirmed(rows []recentEvaluation, required, minutes int, predicate func(recentEvaluation) bool) []recentEvaluation {
	if required < 1 {
		required = 1
	}
	if len(rows) < required {
		return nil
	}
	selected := rows[:required]
	if minutes > 0 {
		newest, oldest := selected[0].ObservedAt, selected[len(selected)-1].ObservedAt
		if newest.Sub(oldest) > time.Duration(minutes)*time.Minute {
			return nil
		}
	}
	for _, row := range selected {
		if !predicate(row) {
			return nil
		}
	}
	return selected
}

func problem(row recentEvaluation) bool {
	return row.Valid && (row.BaselineState == "VIOLATION" || row.ContractState == "DEVIATES")
}
func baselineProblem(row recentEvaluation) bool { return row.Valid && row.BaselineState == "VIOLATION" }
func contractProblem(row recentEvaluation) bool { return row.Valid && row.ContractState == "DEVIATES" }
func healthyConnection(row recentEvaluation) bool {
	return row.Valid && row.ConnectionStatus == "OK" && row.BaselineState != "VIOLATION"
}
func healthyBaseline(row recentEvaluation) bool { return row.Valid && row.BaselineState == "OK" }
func healthyContract(row recentEvaluation) bool { return row.Valid && row.ContractState == "MEETS" }

func loadState(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string) (*lineState, error) {
	state := &lineState{}
	var effective *time.Time
	var policyID *int64
	var evidence []byte
	err := q.QueryRow(ctx, `SELECT line_id,data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json,policy_id FROM line_states WHERE line_id=$1`, lineID).Scan(&state.LineID, &state.DataState, &state.ConnectionState, &state.ContractState, &state.RecoveryState, &effective, &state.UpdatedAt, &state.Reason, &evidence, &policyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	state.EffectiveSince, state.PolicyID = effective, policyID
	_ = json.Unmarshal(evidence, &state.EvidenceIDs)
	return state, nil
}

func writeState(ctx context.Context, q interface {
	Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string, at time.Time, dataState, connectionState, contractState, recoveryState, reason string, evidence []int64, policy *evaluation.Policy, contract *evaluation.Contract) error {
	previous, err := loadState(ctx, q, lineID)
	if err != nil {
		return err
	}
	changed := previous == nil || previous.DataState != dataState || previous.ConnectionState != connectionState || previous.ContractState != contractState || previous.RecoveryState != recoveryState
	effectiveSince := at
	if previous != nil && previous.ConnectionState == connectionState && previous.ContractState == contractState && previous.EffectiveSince != nil {
		effectiveSince = *previous.EffectiveSince
	}
	evidenceJSON, _ := json.Marshal(evidence)
	policyID := nullablePolicyID(policy)
	if _, err := q.Exec(ctx, `INSERT INTO line_states(line_id,data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json,policy_id)
        VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb,$9) ON CONFLICT(line_id) DO UPDATE SET data_state=EXCLUDED.data_state,connection_state=EXCLUDED.connection_state,contract_state=EXCLUDED.contract_state,recovery_state=EXCLUDED.recovery_state,effective_since=EXCLUDED.effective_since,updated_at=EXCLUDED.updated_at,reason=EXCLUDED.reason,evidence_ids_json=EXCLUDED.evidence_ids_json,policy_id=EXCLUDED.policy_id`, lineID, dataState, connectionState, contractState, recoveryState, effectiveSince, reason, string(evidenceJSON), policyID); err != nil {
		return err
	}
	if !changed {
		return nil
	}
	snapshot, _ := json.Marshal(map[string]interface{}{"policy": evaluation.SnapshotPolicy(policy), "contract": evaluation.SnapshotContract(contract)})
	var previousData, previousConnection, previousContract interface{}
	if previous != nil {
		previousData, previousConnection, previousContract = previous.DataState, previous.ConnectionState, previous.ContractState
	}
	if _, err := q.Exec(ctx, `INSERT INTO line_state_events(line_id,previous_data_state,previous_connection_state,previous_contract_state,data_state,connection_state,contract_state,recovery_state,reason,evidence_ids_json,config_snapshot_json,effective_since,updated_at,occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$13)`, lineID, previousData, previousConnection, previousContract, dataState, connectionState, contractState, recoveryState, reason, string(evidenceJSON), string(snapshot), effectiveSince, at); err != nil {
		return err
	}
	return nil
}

func applyState(ctx context.Context, tx pgx.Tx, lineID string, at time.Time, measurementID int64, result evaluation.Result, policy *evaluation.Policy, contract *evaluation.Contract) error {
	required := 3
	confirmMinutes := 0
	recoveryRequired := 3
	recoveryMinutes := 0
	if policy != nil {
		required, confirmMinutes, recoveryRequired, recoveryMinutes = policy.ConfirmCount, policy.ConfirmMinutes, policy.RecoveryCount, policy.RecoveryMinutes
	}
	recent, err := readRecent(ctx, tx, lineID, maxInt(required, recoveryRequired))
	if err != nil {
		return err
	}
	confirmedBaseline := confirmed(recent, required, confirmMinutes, baselineProblem)
	confirmedContract := confirmed(recent, required, confirmMinutes, contractProblem)
	current, err := loadState(ctx, tx, lineID)
	if err != nil {
		return err
	}
	active, err := activeIncident(ctx, tx, lineID)
	if err != nil {
		return err
	}
	confirmedRows := confirmedBaseline
	if active != nil && strings.HasPrefix(active.ViolationType, "CONTRACT_") {
		confirmedRows = confirmedContract
	} else if len(confirmedRows) == 0 {
		confirmedRows = confirmedContract
	}
	if len(confirmedRows) > 0 {
		connectionState := "OK"
		for _, violation := range result.Violations {
			if violation.Code == "NO_INTERNET" {
				connectionState = "NO_INTERNET"
				break
			}
		}
		if connectionState == "OK" && result.BaselineState == "VIOLATION" {
			connectionState = "DEGRADED"
		}
		contractState := result.ContractState
		if contractState != "MEETS" && contractState != "DEVIATES" {
			contractState = "UNKNOWN"
		}
		evidence := make([]int64, 0, len(confirmedRows))
		for _, row := range confirmedRows {
			evidence = append(evidence, row.ID)
		}
		if err := writeState(ctx, tx, lineID, at, "FRESH", connectionState, contractState, "NONE", fmt.Sprintf("Confirmed after %d consecutive observations: %s", required, result.Reason), evidence, policy, contract); err != nil {
			return err
		}
		var incidentID int64
		if active == nil {
			id, err := createIncident(ctx, tx, lineID, at, confirmedRows, result, nil)
			if err != nil {
				return err
			}
			incidentID = id
		} else if active.Status == "RESOLVED" {
			if _, err := tx.Exec(ctx, `UPDATE incidents SET status='IN_PROGRESS',recovery_state='NONE',resolved_at=NULL WHERE id=$1`, active.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'REOPENED','system','{"reason":"violation returned during recovery verification"}'::jsonb,$2)`, active.ID, at); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,after_json,created_at) VALUES ('SYSTEM','system','incident.reopened','incident',$1,'{"status":"IN_PROGRESS"}'::jsonb,$2)`, strconv.FormatInt(active.ID, 10), at); err != nil {
				return err
			}
			incidentID = active.ID
		} else {
			return nil
		}
		generatedAt := time.Now().UTC().Truncate(time.Second)
		message := "Подтверждено нарушение линии " + lineID + ": " + result.Reason
		var notificationID int64
		if err := tx.QueryRow(ctx, `INSERT INTO notifications(source_type,source_id,channel,recipient_scope,message,status,generated_at) VALUES ('INCIDENT',$1,'WEB',$2,$3,'GENERATED',$4) RETURNING id`, strconv.FormatInt(incidentID, 10), lineID, message, generatedAt).Scan(&notificationID); err != nil {
			return err
		}
		// Delivery is best-effort but durable: a failed adapter attempt is
		// persisted as FAILED and can be retried by an administrator.
		delivery, deliveryErr := providers.SendNotification(ctx, providers.Notification{ID: notificationID, SourceType: "INCIDENT", SourceID: strconv.FormatInt(incidentID, 10), Scope: lineID, Message: message, GeneratedAt: generatedAt})
		if deliveryErr != nil {
			retryable := false
			if typed, ok := deliveryErr.(*providers.DeliveryError); ok {
				retryable = typed.Retryable
			}
			_, _ = tx.Exec(ctx, `UPDATE notifications SET status='FAILED',delivery_attempts=delivery_attempts+1,delivery_error=$1 WHERE id=$2`, deliveryErr.Error(), notificationID)
			_, _ = tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'NOTIFICATION_DELIVERY_FAILED','system',$2::jsonb,$3)`, incidentID, fmt.Sprintf(`{"notification_id":%d,"error":%q,"retryable":%t}`, notificationID, deliveryErr.Error(), retryable), generatedAt)
		} else {
			if delivery.Channel == "WEB" {
				_, _ = tx.Exec(ctx, `UPDATE notifications SET channel=$1,delivery_attempts=delivery_attempts+1,delivery_error=NULL WHERE id=$2`, delivery.Channel, notificationID)
			} else {
				_, _ = tx.Exec(ctx, `UPDATE notifications SET status='SENT',channel=$1,delivery_attempts=delivery_attempts+1,sent_at=$2 WHERE id=$3`, delivery.Channel, generatedAt, notificationID)
			}
		}
		return nil
	}

	healthyObservation := result.Valid && result.BaselineState != "VIOLATION"
	for _, violation := range result.Violations {
		if violation.Code == "NO_INTERNET" {
			healthyObservation = false
			break
		}
	}
	healthyStreak := false
	healthyTarget := healthyBaseline
	if active != nil {
		if active.ViolationType == "NO_INTERNET" {
			healthyTarget = healthyConnection
		} else if strings.HasPrefix(active.ViolationType, "CONTRACT_") {
			healthyTarget = healthyContract
		}
	}
	if healthyObservation && current != nil && (current.ConnectionState == "NO_INTERNET" || current.ConnectionState == "DEGRADED") {
		healthyStreak = len(confirmed(recent, recoveryRequired, recoveryMinutes, healthyTarget)) > 0
	}
	connectionState := "UNKNOWN"
	if healthyObservation {
		connectionState = "OK"
		if current != nil && (current.ConnectionState == "NO_INTERNET" || current.ConnectionState == "DEGRADED") && !healthyStreak {
			connectionState = current.ConnectionState
		}
	} else if current != nil {
		connectionState = current.ConnectionState
	}
	contractState := result.ContractState
	if confirmedContract != nil && len(confirmedContract) > 0 {
		contractState = "DEVIATES"
	} else if current != nil && current.ContractState == "DEVIATES" && result.ContractState == "DEVIATES" {
		contractState = "DEVIATES"
	}
	recoveryState := "NONE"
	if current != nil && (current.ConnectionState == "NO_INTERNET" || current.ConnectionState == "DEGRADED") && healthyObservation {
		recoveryState = "OBSERVED"
		if healthyStreak {
			recoveryState = "CONFIRMED"
		}
	}
	if err := writeState(ctx, tx, lineID, at, "FRESH", connectionState, contractState, recoveryState, result.Reason, []int64{measurementID}, policy, contract); err != nil {
		return err
	}
	return updateRecovery(ctx, tx, lineID, at, recent, result, policy, recoveryRequired, recoveryMinutes)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func activeIncident(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string) (*incident, error) {
	item := &incident{}
	var confirmedAt, resolvedAt, closedAt *time.Time
	var raw []byte
	err := q.QueryRow(ctx, `SELECT id,line_id,violation_type,status,recovery_state,started_at,confirmed_at,resolved_at,closed_at,opening_snapshot_json FROM incidents WHERE line_id=$1 AND status IN ('NEW','SENT_TO_PROVIDER','IN_PROGRESS','WAITING_INFO','RESOLVED') ORDER BY id DESC LIMIT 1`, lineID).Scan(&item.ID, &item.LineID, &item.ViolationType, &item.Status, &item.RecoveryState, &item.StartedAt, &confirmedAt, &resolvedAt, &closedAt, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.ConfirmedAt, item.ResolvedAt, item.ClosedAt = confirmedAt, resolvedAt, closedAt
	_ = json.Unmarshal(raw, &item.Opening)
	return item, nil
}

func createIncident(ctx context.Context, tx pgx.Tx, lineID string, at time.Time, evidence []recentEvaluation, result evaluation.Result, previous *incident) (int64, error) {
	violationType := "QUALITY_DEVIATION"
	if len(result.Violations) > 0 {
		violationType = result.Violations[0].Code
	}
	started := at
	if len(evidence) > 0 {
		started = evidence[len(evidence)-1].ObservedAt
	}
	snapshot, _ := json.Marshal(map[string]interface{}{"line_id": lineID, "confirmed_at": at.UTC().Format(time.RFC3339), "evidence_measurement_ids": ids(evidence), "violations": result.Violations, "policy": result.PolicySnapshot, "contract": result.ContractSnapshot, "reason": result.Reason})
	var previousID interface{}
	if previous != nil {
		previousID = previous.ID
	} else {
		// Keep recurrence links for a new violation after a previously closed
		// incident of the same type. The closed row remains immutable evidence.
		var closedID int64
		err := tx.QueryRow(ctx, `SELECT id FROM incidents WHERE line_id=$1 AND status='CLOSED' AND violation_type=$2 ORDER BY id DESC LIMIT 1`, lineID, violationType).Scan(&closedID)
		if err == nil {
			previousID = closedID
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
	}
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,confirmed_at,recurrence_of,opening_snapshot_json,created_at)
        VALUES ('PENDING',$1,'AUTO',$2,'NEW','NONE',$3,$4,$5,$6::jsonb,$4) RETURNING id`, lineID, violationType, started, at, previousID, string(snapshot)).Scan(&id)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE incidents SET incident_no=$1 WHERE id=$2`, fmt.Sprintf("INC-%06d", id), id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'CONFIRMED','system',$2::jsonb,$3)`, id, string(snapshot), at); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,after_json,created_at) VALUES ('SYSTEM','system','incident.created','incident',$1,$2::jsonb,$3)`, strconv.FormatInt(id, 10), string(snapshot), at); err != nil {
		return 0, err
	}
	return id, nil
}

func ids(rows []recentEvaluation) []int64 {
	result := make([]int64, 0, len(rows))
	for _, row := range rows {
		result = append(result, row.ID)
	}
	return result
}

func updateRecovery(ctx context.Context, tx pgx.Tx, lineID string, at time.Time, recent []recentEvaluation, result evaluation.Result, policy *evaluation.Policy, required, minutes int) error {
	item, err := activeIncident(ctx, tx, lineID)
	if err != nil || item == nil {
		return err
	}
	isProblem := false
	if item.ViolationType == "NO_INTERNET" {
		for _, violation := range result.Violations {
			if violation.Code == "NO_INTERNET" {
				isProblem = true
			}
		}
	} else if strings.HasPrefix(item.ViolationType, "CONTRACT_") {
		isProblem = result.ContractState == "DEVIATES"
	} else {
		isProblem = result.BaselineState == "VIOLATION"
	}
	if isProblem {
		if item.Status == "RESOLVED" {
			if _, err := tx.Exec(ctx, `UPDATE incidents SET status='IN_PROGRESS',recovery_state='NONE',resolved_at=NULL WHERE id=$1`, item.ID); err != nil {
				return err
			}
			_, _ = tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'REOPENED','system','{"reason":"violation returned during recovery verification"}'::jsonb,$2)`, item.ID, at)
		}
		return nil
	}
	target := healthyBaseline
	if item.ViolationType == "NO_INTERNET" {
		target = healthyConnection
	} else if strings.HasPrefix(item.ViolationType, "CONTRACT_") {
		target = healthyContract
	}
	good := confirmed(recent, required, minutes, target)
	if len(good) == 0 {
		// A first healthy observation starts recovery verification even when
		// the configured sustained-recovery window is not complete yet. Keep
		// this lifecycle marker separate from the eventual CLOSED transition.
		if item.RecoveryState == "NONE" {
			if _, err := tx.Exec(ctx, `UPDATE incidents SET recovery_state='OBSERVED' WHERE id=$1`, item.ID); err != nil {
				return err
			}
			evidenceID := "null"
			if len(recent) > 0 {
				evidenceID = strconv.FormatInt(recent[0].ID, 10)
			}
			payload := `{"measurement_id":` + evidenceID + `}`
			if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'RECOVERY_OBSERVED','system',$2::jsonb,$3)`, item.ID, payload, at); err != nil {
				return err
			}
		}
		return nil
	}
	if item.RecoveryState == "NONE" {
		if _, err := tx.Exec(ctx, `UPDATE incidents SET status=CASE WHEN status IN ('NEW','SENT_TO_PROVIDER','IN_PROGRESS','WAITING_INFO') THEN 'RESOLVED' ELSE status END,recovery_state='OBSERVED',resolved_at=COALESCE(resolved_at,$2) WHERE id=$1`, item.ID, at); err != nil {
			return err
		}
		_, _ = tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'RECOVERY_OBSERVED','system',$2::jsonb,$3)`, item.ID, fmt.Sprintf(`{"measurement_id":%d,"status":"RESOLVED"}`, good[0].ID), at)
	}
	if _, err := tx.Exec(ctx, `UPDATE incidents SET recovery_state='CONFIRMED',status='CLOSED',closed_at=COALESCE(closed_at,$2),duration_minutes=EXTRACT(EPOCH FROM ($2-started_at))/60 WHERE id=$1`, item.ID, at); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'RECOVERY_CONFIRMED','system',$2::jsonb,$3)`, item.ID, fmt.Sprintf(`{"evidence_measurement_ids":%v}`, mustJSON(ids(good))), at)
	return err
}

func mustJSON(value interface{}) string { data, _ := json.Marshal(value); return string(data) }

// Freshness is intentionally evaluated from observed_at.  A replayed backlog
// can be accepted as evidence while it still leaves the current data axis
// NO_DATA until a recent observation arrives.
func (s *Service) MarkFreshness(ctx context.Context, lineID string, now time.Time) error {
	var current lineState
	var effective, updated *time.Time
	var evidence []byte
	var policyID *int64
	err := s.DB.Pool.QueryRow(ctx, `SELECT line_id,data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json,policy_id FROM line_states WHERE line_id=$1`, lineID).Scan(&current.LineID, &current.DataState, &current.ConnectionState, &current.ContractState, &current.RecoveryState, &effective, &updated, &current.Reason, &evidence, &policyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	policy, err := loadPolicy(ctx, s.DB.Pool, lineID, now.UTC())
	if err != nil {
		return err
	}
	contract, err := loadContract(ctx, s.DB.Pool, lineID, now.UTC())
	if err != nil {
		return err
	}
	// Preserve a historical policy reference even if its version is no longer
	// temporally resolvable (for example while an operator repairs a catalog).
	if policy.Value == nil && policyID != nil {
		policy.Value = &evaluation.Policy{ID: *policyID}
	}
	var last *time.Time
	if err := s.DB.Pool.QueryRow(ctx, `SELECT MAX(observed_at) FROM measurements WHERE line_id=$1`, lineID).Scan(&last); err != nil {
		return err
	}
	freshSeconds := 86400
	if policy.Value != nil && policy.Value.FreshnessSec > 0 {
		freshSeconds = policy.Value.FreshnessSec
	}
	dataState := "NO_DATA"
	if last != nil && now.Sub(last.UTC()) <= time.Duration(freshSeconds)*time.Second {
		dataState = "FRESH"
	}
	if dataState == current.DataState {
		return nil
	}
	connectionState, contractState := current.ConnectionState, current.ContractState
	if dataState == "NO_DATA" {
		connectionState, contractState = "UNKNOWN", "UNKNOWN"
	}
	reason := current.Reason
	if dataState == "NO_DATA" {
		reason = "No fresh observations from monitoring point"
	}
	return writeState(ctx, s.DB.Pool, lineID, now.UTC(), dataState, connectionState, contractState, current.RecoveryState, reason, current.EvidenceIDs, policy.Value, contract.Value)
}

func RandomEventID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("event-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func MaxBackfillDays() int {
	value, err := strconv.Atoi(os.Getenv("LINKWATCH_MAX_BACKFILL_DAYS"))
	if err != nil || value < 0 {
		return 90
	}
	return value
}
