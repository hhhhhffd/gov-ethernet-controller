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
	"reflect"
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
	LatencyMethod     string                 `json:"latency_method,omitempty"`
	LatencyEvidence   map[string]interface{} `json:"latency_evidence,omitempty"`
	Raw               map[string]interface{} `json:"raw,omitempty"`
}

type Result struct {
	ClientEventID string                 `json:"client_event_id"`
	MeasurementID int64                  `json:"measurement_id"`
	Duplicate     bool                   `json:"duplicate"`
	Accepted      bool                   `json:"accepted"`
	Error         string                 `json:"error,omitempty"`
	ErrorCode     string                 `json:"error_code,omitempty"`
	Retryable     bool                   `json:"retryable"`
	StateApplied  bool                   `json:"state_applied"`
	Evaluation    map[string]interface{} `json:"evaluation,omitempty"`
}

// InputError marks a rejection caused by the submitted measurement rather
// than by the database or another transient server dependency. The batch API
// uses it to tell an agent when retrying the same JSON cannot succeed.
type InputError struct {
	Code string
	Err  error
}

func (e *InputError) Error() string { return e.Err.Error() }
func (e *InputError) Unwrap() error { return e.Err }

type Service struct{ DB *database.DB }

type policyRow struct{ Value *evaluation.Policy }
type contractRow struct{ Value *evaluation.Contract }

type recentEvaluation struct {
	ID               int64
	ObservedAt       time.Time
	Mode             string
	ConnectionStatus string
	Metrics          map[string]bool
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

func (s *Service) Process(ctx context.Context, deviceID, lineID, pointID, _agentVersion string, input Input) (Result, error) {
	if input.ClientEventID == "" {
		return Result{}, &InputError{Code: "client_event_id_required", Err: fmt.Errorf("client_event_id is required")}
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
	preserveLatencyEvidence(&input)
	if input.ObservedAt.IsZero() {
		return Result{}, &InputError{Code: "observed_at_required", Err: fmt.Errorf("observed_at is required")}
	}
	if err := validateInput(input); err != nil {
		return Result{}, &InputError{Code: "invalid_measurement", Err: err}
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
	// Serialize the state machine per line. The duplicate check above is kept
	// fast for the common retry path; after acquiring the row lock we check it
	// again because another transaction may have committed while we waited.
	var lockedLineID string
	if err := tx.QueryRow(ctx, `SELECT id FROM lines WHERE id=$1 FOR UPDATE`, lineID).Scan(&lockedLineID); err != nil {
		return Result{}, err
	}
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
	lineContext, err := ResolveContext(ctx, tx, lineID, input.ObservedAt)
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
	violations, err := json.Marshal(evaluated.Violations)
	if err != nil {
		return Result{}, fmt.Errorf("marshal violations: %w", err)
	}
	policySnapshot, err := json.Marshal(evaluated.PolicySnapshot)
	if err != nil {
		return Result{}, fmt.Errorf("marshal policy snapshot: %w", err)
	}
	contractSnapshot, err := json.Marshal(evaluated.ContractSnapshot)
	if err != nil {
		return Result{}, fmt.Errorf("marshal contract snapshot: %w", err)
	}
	lineContextSnapshot, err := json.Marshal(SnapshotContext(lineContext))
	if err != nil {
		return Result{}, fmt.Errorf("marshal line context snapshot: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO measurement_evaluations(measurement_id,baseline_state,contract_state,violations_json,valid,reason,policy_snapshot_json,contract_snapshot_json,line_context_snapshot_json,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`, measurementID, evaluated.BaselineState, evaluated.ContractState, string(violations), evaluated.Valid, evaluated.Reason, string(policySnapshot), string(contractSnapshot), string(lineContextSnapshot), now); err != nil {
		return Result{}, err
	}

	late := hasLatest && input.ObservedAt.Before(latestBefore)
	if !late {
		if err := applyState(ctx, tx, lineID, input.Mode, input.ObservedAt, measurementID, evaluated, policy.Value, contract.Value); err != nil {
			return Result{}, err
		}
	}
	// Heartbeat is authoritative for fleet version. Measurement uploads may be
	// delayed in the agent spool, so accepting their embedded version here
	// could roll a device back from a newer heartbeat to an older queued item.
	if _, err := tx.Exec(ctx, `UPDATE devices SET last_seen=GREATEST(COALESCE(last_seen,$1),$1) WHERE id=$2`, now, deviceID); err != nil {
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

// updateVerification persists only the explicit evidence relation. It runs
// under the existing per-line lock, so a retry or concurrent ingest cannot
// choose two different verifiers or rewrite current line state.
func updateVerification(ctx context.Context, tx pgx.Tx, lineID string, measurementID int64, input Input, evaluated evaluation.Result, policy *evaluation.Policy, contract *evaluation.Contract, now time.Time) error {
	if input.Quality == "SUSPECT" {
		expires := input.ObservedAt.Add(24 * time.Hour)
		if policy != nil && policy.FreshnessSec > 0 {
			expires = input.ObservedAt.Add(time.Duration(policy.FreshnessSec) * time.Second)
		}
		snapshot, err := json.Marshal(map[string]interface{}{
			"measurement_id": measurementID, "observed_at": input.ObservedAt, "quality": input.Quality,
			"connection_status": input.ConnectionStatus, "download": input.Download, "upload": input.Upload,
			"ping": input.Ping, "jitter": input.Jitter, "packet_loss": input.PacketLoss, "availability": input.Availability,
			"evaluation":      map[string]interface{}{"baseline_state": evaluated.BaselineState, "contract_state": evaluated.ContractState, "valid": evaluated.Valid, "reason": evaluated.Reason, "violations": evaluated.Violations},
			"policy_snapshot": evaluated.PolicySnapshot, "contract_snapshot": evaluated.ContractSnapshot,
		})
		if err != nil {
			return fmt.Errorf("marshal verification candidate snapshot: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO measurement_verifications(candidate_measurement_id,status,reason,candidate_snapshot_json,candidate_observed_at,expires_at,created_at,updated_at)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7) ON CONFLICT (candidate_measurement_id) DO NOTHING`, measurementID, VerificationPending, "suspicious measurement requires subsequent evidence", string(snapshot), input.ObservedAt, expires, now)
		if err != nil {
			return fmt.Errorf("persist verification candidate: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,after_json,created_at)
            VALUES ('SYSTEM','system','measurement.verification_pending','measurement',$1,$2::jsonb,$3) ON CONFLICT DO NOTHING`, strconv.FormatInt(measurementID, 10), fmt.Sprintf(`{"status":%q}`, VerificationPending), now)
		return err
	}

	rows, err := tx.Query(ctx, `SELECT v.id,v.status,v.candidate_observed_at,v.expires_at
        FROM measurement_verifications v JOIN measurements cm ON cm.id=v.candidate_measurement_id
        WHERE cm.line_id=$1 AND v.status=$2 AND cm.observed_at < $3
        ORDER BY cm.observed_at,cm.id FOR UPDATE OF v`, lineID, VerificationPending, input.ObservedAt)
	if err != nil {
		return fmt.Errorf("load pending verifications: %w", err)
	}
	defer rows.Close()
	outcome := VerificationOutcome(evaluated.Valid, evaluated.BaselineState, evaluated.ContractState, input.ConnectionStatus)
	for rows.Next() {
		var id int64
		var status string
		var candidateAt, expiresAt time.Time
		if err := rows.Scan(&id, &status, &candidateAt, &expiresAt); err != nil {
			return err
		}
		next, changed := TransitionVerification(VerificationCandidate{Status: status, CandidateAt: candidateAt, ExpiresAt: expiresAt}, input.ObservedAt, outcome)
		if !changed {
			continue
		}
		verifyingSnapshot, marshalErr := json.Marshal(map[string]interface{}{
			"measurement_id": measurementID, "observed_at": input.ObservedAt, "quality": input.Quality,
			"connection_status": input.ConnectionStatus, "baseline_state": evaluated.BaselineState,
			"contract_state": evaluated.ContractState, "valid": evaluated.Valid, "reason": evaluated.Reason,
			"violations": evaluated.Violations, "policy_snapshot": evaluated.PolicySnapshot, "contract_snapshot": evaluated.ContractSnapshot,
		})
		if marshalErr != nil {
			return fmt.Errorf("marshal verification snapshot: %w", marshalErr)
		}
		reason := "subsequent evidence classified the candidate"
		if next == VerificationExpired {
			reason = "no eligible subsequent evidence before expiry"
		}
		_, err = tx.Exec(ctx, `UPDATE measurement_verifications SET status=$1,verifying_measurement_id=CASE WHEN $1=$2 THEN $3 ELSE NULL END,verifying_snapshot_json=CASE WHEN $1=$2 THEN $4::jsonb ELSE NULL END,reason=$5,updated_at=$6,verified_at=$6 WHERE id=$7 AND status=$8`, next, VerificationExpired, measurementID, string(verifyingSnapshot), reason, now, id, VerificationPending)
		if err != nil {
			return fmt.Errorf("update verification: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return nil
}

// preserveLatencyEvidence keeps the agent's top-level latency fields in the
// durable raw payload. Older agents put the same fields only under raw, while
// newer agents expose latency_method at the top level for wire compatibility.
// If both forms disagree, retain the original raw values under an explicit
// compatibility key instead of silently discarding either representation.
func preserveLatencyEvidence(input *Input) {
	if input == nil {
		return
	}
	if input.Raw == nil {
		input.Raw = map[string]interface{}{}
	}
	if input.LatencyMethod != "" {
		if existing, ok := input.Raw["latency_method"]; ok && !reflect.DeepEqual(existing, input.LatencyMethod) {
			input.Raw["latency_method_raw"] = existing
		}
		input.Raw["latency_method"] = input.LatencyMethod
	}
	if input.LatencyEvidence != nil {
		if existing, ok := input.Raw["latency_evidence"]; ok && !reflect.DeepEqual(existing, input.LatencyEvidence) {
			input.Raw["latency_evidence_raw"] = existing
		}
		input.Raw["latency_evidence"] = input.LatencyEvidence
	}
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

func loadPolicy(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}, lineID string, at time.Time) (policyRow, error) {
	row := &evaluation.Policy{}
	var validFrom time.Time
	var validTo *time.Time
	var durationMinutes *int
	err := q.QueryRow(ctx, `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds
        FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from DESC LIMIT 1`, lineID, at).Scan(&row.ID, &row.ScopeType, &row.ScopeID, &row.Version, &validFrom, &validTo, &row.DownloadMin, &row.UploadMin, &row.PingMax, &row.JitterMax, &row.PacketLossMax, &row.AvailabilityMin, &row.ConfirmCount, &row.ConfirmMinutes, &durationMinutes, &row.RecoveryCount, &row.RecoveryMinutes, &row.FreshnessSec)
	if errors.Is(err, pgx.ErrNoRows) {
		err = q.QueryRow(ctx, `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds
            FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1) ORDER BY valid_from DESC LIMIT 1`, at).Scan(&row.ID, &row.ScopeType, &row.ScopeID, &row.Version, &validFrom, &validTo, &row.DownloadMin, &row.UploadMin, &row.PingMax, &row.JitterMax, &row.PacketLossMax, &row.AvailabilityMin, &row.ConfirmCount, &row.ConfirmMinutes, &durationMinutes, &row.RecoveryCount, &row.RecoveryMinutes, &row.FreshnessSec)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return policyRow{}, nil
	}
	if err != nil {
		return policyRow{}, err
	}
	row.ConfirmDurationMinutes = durationMinutes
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
	rows, err := q.Query(ctx, `SELECT m.id,m.observed_at,m.mode,m.connection_status,
	        m.download IS NOT NULL,m.upload IS NOT NULL,m.ping IS NOT NULL,m.jitter IS NOT NULL,
	        m.packet_loss IS NOT NULL,m.availability IS NOT NULL,
	        e.baseline_state,e.contract_state,e.valid,e.violations_json
        FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id WHERE m.line_id=$1 ORDER BY m.observed_at DESC,m.id DESC LIMIT $2`, lineID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []recentEvaluation{}
	for rows.Next() {
		var item recentEvaluation
		var raw []byte
		var download, upload, ping, jitter, packetLoss, availability bool
		if err := rows.Scan(&item.ID, &item.ObservedAt, &item.Mode, &item.ConnectionStatus,
			&download, &upload, &ping, &jitter, &packetLoss, &availability,
			&item.BaselineState, &item.ContractState, &item.Valid, &raw); err != nil {
			return nil, err
		}
		item.Metrics = map[string]bool{
			"download": download, "upload": upload, "ping": ping,
			"jitter": jitter, "packet_loss": packetLoss, "availability": availability,
		}
		if err := json.Unmarshal(raw, &item.Violations); err != nil {
			return nil, fmt.Errorf("decode evaluation violations: %w", err)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

type confirmationMode string

const (
	confirmationDisabled confirmationMode = "DISABLED"
	confirmationCount    confirmationMode = "COUNT"
	confirmationDuration confirmationMode = "DURATION"
	confirmationEither   confirmationMode = "EITHER"
	confirmationBoth     confirmationMode = "BOTH"
)

type confirmationPolicy struct {
	Mode     confirmationMode
	Count    int
	Duration time.Duration
}

// policyConfirmation keeps the existing database contract usable while making
// count and duration independent. confirm_minutes remains the legacy duration
// rule; the explicit duration field is the independent problem-confirmation
// rule. A zero count is allowed only for an explicit duration-only policy.
func policyConfirmation(policy *evaluation.Policy, recovery bool) confirmationPolicy {
	result := confirmationPolicy{Mode: confirmationCount, Count: 3}
	if policy != nil {
		result.Count = policy.ConfirmCount
		minutes := policy.ConfirmMinutes
		if !recovery && policy.ConfirmDurationMinutes != nil {
			minutes = *policy.ConfirmDurationMinutes
		}
		if recovery {
			result.Count = policy.RecoveryCount
			minutes = policy.RecoveryMinutes
		}
		if minutes > 0 {
			result.Duration = time.Duration(minutes) * time.Minute
			if result.Count > 0 {
				result.Mode = confirmationEither
			} else {
				result.Mode = confirmationDuration
			}
		}
	}
	if result.Count < 1 && result.Mode != confirmationDuration {
		result.Count = 0
		result.Mode = confirmationDisabled
	}
	return result
}

func confirmationSatisfied(policy confirmationPolicy, count int, duration time.Duration) bool {
	countOK := policy.Count > 0 && count >= policy.Count
	durationOK := policy.Duration > 0 && duration >= policy.Duration
	switch policy.Mode {
	case confirmationDisabled:
		return false
	case confirmationDuration:
		return durationOK
	case confirmationEither:
		return countOK || durationOK
	case confirmationBoth:
		return countOK && durationOK
	default:
		return countOK
	}
}

func confirmationEvidence(rows []recentEvaluation, policy confirmationPolicy, relevant, predicate func(recentEvaluation) bool) []recentEvaluation {
	selected := make([]recentEvaluation, 0, len(rows))
	for _, row := range rows {
		if !relevant(row) {
			continue
		}
		if !predicate(row) {
			break
		}
		selected = append(selected, row)
		duration := selected[0].ObservedAt.Sub(selected[len(selected)-1].ObservedAt)
		if confirmationSatisfied(policy, len(selected), duration) {
			return selected
		}
	}
	return nil
}

type evidenceKey struct {
	LineID        string
	Axis          string
	ViolationCode string
	Mode          string
}

func keyFor(lineID, code, mode string) evidenceKey {
	axis := "BASELINE"
	if code == "NO_INTERNET" {
		axis = "CONNECTION"
	} else if strings.HasPrefix(code, "CONTRACT_") {
		axis = "CONTRACT"
	}
	return evidenceKey{LineID: lineID, Axis: axis, ViolationCode: code, Mode: mode}
}

func metricForViolation(code string) string {
	if code == "NO_INTERNET" {
		return "connection_status"
	}
	name := strings.TrimPrefix(code, "BASELINE_")
	name = strings.TrimPrefix(name, "CONTRACT_")
	return strings.ToLower(name)
}

func hasViolation(row recentEvaluation, code string) bool {
	if !row.Valid {
		return false
	}
	for _, violation := range row.Violations {
		if violation.Code == code {
			return true
		}
	}
	return false
}

func relevantEvidence(row recentEvaluation, key evidenceKey) bool {
	if row.Mode != key.Mode {
		return false
	}
	if key.ViolationCode == "NO_INTERNET" {
		return true
	}
	// A connectivity failure is an unavailable performance sample. Include it
	// in the scan so confirmationEvidence can break a continuous candidate
	// instead of silently skipping over the NO_DATA interval.
	if row.ConnectionStatus == "NO_INTERNET" {
		return true
	}
	return row.Metrics[metricForViolation(key.ViolationCode)]
}

func confirmedForCode(lineID string, rows []recentEvaluation, mode string, policy confirmationPolicy, code string, healthy bool) []recentEvaluation {
	key := keyFor(lineID, code, mode)
	return confirmationEvidence(rows, policy,
		func(row recentEvaluation) bool { return relevantEvidence(row, key) },
		func(row recentEvaluation) bool {
			if healthy {
				return row.Valid && !hasViolation(row, code)
			}
			return hasViolation(row, code)
		})
}

func violationCodes(result evaluation.Result) []string {
	resultCodes := make([]string, 0, len(result.Violations))
	seen := map[string]bool{}
	for _, violation := range result.Violations {
		if !seen[violation.Code] {
			seen[violation.Code] = true
			resultCodes = append(resultCodes, violation.Code)
		}
	}
	return resultCodes
}

func baselineHealthy(result evaluation.Result) bool {
	return result.Valid && result.BaselineState == "OK"
}

func connectionStateForResult(result evaluation.Result) string {
	for _, violation := range result.Violations {
		if violation.Code == "NO_INTERNET" {
			return "NO_INTERNET"
		}
	}
	switch result.BaselineState {
	case "OK":
		return "OK"
	case "VIOLATION":
		return "DEGRADED"
	default:
		return "UNKNOWN"
	}
}

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
	if err := json.Unmarshal(evidence, &state.EvidenceIDs); err != nil {
		return nil, fmt.Errorf("decode line state evidence: %w", err)
	}
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
	evidenceJSON, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal line state evidence: %w", err)
	}
	policyID := nullablePolicyID(policy)
	if _, err := q.Exec(ctx, `INSERT INTO line_states(line_id,data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json,policy_id)
        VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb,$9) ON CONFLICT(line_id) DO UPDATE SET data_state=EXCLUDED.data_state,connection_state=EXCLUDED.connection_state,contract_state=EXCLUDED.contract_state,recovery_state=EXCLUDED.recovery_state,effective_since=EXCLUDED.effective_since,updated_at=EXCLUDED.updated_at,reason=EXCLUDED.reason,evidence_ids_json=EXCLUDED.evidence_ids_json,policy_id=EXCLUDED.policy_id`, lineID, dataState, connectionState, contractState, recoveryState, effectiveSince, reason, string(evidenceJSON), policyID); err != nil {
		return err
	}
	if !changed {
		return nil
	}
	snapshot, err := json.Marshal(map[string]interface{}{"policy": evaluation.SnapshotPolicy(policy), "contract": evaluation.SnapshotContract(contract)})
	if err != nil {
		return fmt.Errorf("marshal line state snapshot: %w", err)
	}
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

func applyState(ctx context.Context, tx pgx.Tx, lineID, mode string, at time.Time, measurementID int64, result evaluation.Result, policy *evaluation.Policy, contract *evaluation.Contract) error {
	confirmPolicy := policyConfirmation(policy, false)
	recoveryPolicy := policyConfirmation(policy, true)
	// Keep enough durable evidence to reconstruct a candidate after restart.
	// Duration is expressed in minutes; using that as a lower bound is safe for
	// the usual one-or-more observations per minute while retaining the bounded
	// 1000-row baseline for count-only policies.
	durationRows := int(confirmPolicy.Duration / time.Minute)
	recent, err := readRecent(ctx, tx, lineID, maxInt(maxInt(maxInt(confirmPolicy.Count, recoveryPolicy.Count), durationRows+1), 1000))
	if err != nil {
		return err
	}
	current, err := loadState(ctx, tx, lineID)
	if err != nil {
		return err
	}
	active, err := activeIncident(ctx, tx, lineID)
	if err != nil {
		return err
	}
	confirmedByCode := make(map[evidenceKey][]recentEvaluation)
	for _, code := range violationCodes(result) {
		if evidence := confirmedForCode(lineID, recent, mode, confirmPolicy, code, false); len(evidence) > 0 {
			confirmedByCode[keyFor(lineID, code, mode)] = evidence
		}
	}
	var confirmedRows []recentEvaluation
	confirmedCode := ""
	if active != nil {
		confirmedCode = active.ViolationType
		confirmedRows = confirmedByCode[keyFor(lineID, confirmedCode, mode)]
	} else {
		for _, code := range violationCodes(result) {
			if strings.HasPrefix(code, "BASELINE_") || code == "NO_INTERNET" {
				confirmedRows = confirmedByCode[keyFor(lineID, code, mode)]
				if len(confirmedRows) > 0 {
					confirmedCode = code
					break
				}
			}
		}
		if len(confirmedRows) == 0 {
			for _, code := range violationCodes(result) {
				if strings.HasPrefix(code, "CONTRACT_") {
					confirmedRows = confirmedByCode[keyFor(lineID, code, mode)]
					if len(confirmedRows) > 0 {
						confirmedCode = code
						break
					}
				}
			}
		}
	}
	// An active incident can only be changed by an observation that measured
	// the same metric in the same mode. Missing/foreign metrics are evidence
	// for their own stream, never confirmation or recovery for this incident.
	if active != nil && (len(recent) == 0 || !relevantEvidence(recent[0], keyFor(lineID, active.ViolationType, mode))) {
		return nil
	}
	if len(confirmedRows) > 0 {
		connectionState := connectionStateForResult(result)
		contractState := result.ContractState
		if contractState != "MEETS" && contractState != "DEVIATES" {
			contractState = "UNKNOWN"
		}
		evidence := make([]int64, 0, len(confirmedRows))
		for _, row := range confirmedRows {
			evidence = append(evidence, row.ID)
		}
		if err := writeState(ctx, tx, lineID, at, "FRESH", connectionState, contractState, "NONE", fmt.Sprintf("Confirmed evidence (%s): %s", confirmPolicy.Mode, result.Reason), evidence, policy, contract); err != nil {
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
		if err := tx.QueryRow(ctx, `INSERT INTO notifications(source_type,source_id,channel,recipient_scope,message,status,generated_at) VALUES ('INCIDENT',$1,'WEB',$2,$3,'PENDING',$4) RETURNING id`, strconv.FormatInt(incidentID, 10), lineID, message, generatedAt).Scan(&notificationID); err != nil {
			return err
		}
		// Notification delivery is an outbox concern. Commit the observation,
		// incident and PENDING row first; a dispatcher performs network I/O only
		// after this transaction has completed.
		if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'NOTIFICATION_QUEUED','system',$2::jsonb,$3)`, incidentID, fmt.Sprintf(`{"notification_id":%d}`, notificationID), generatedAt); err != nil {
			return err
		}
		return nil
	}

	healthyObservation := baselineHealthy(result)
	if active != nil {
		healthyObservation = len(recent) > 0 && recent[0].Valid && !hasViolation(recent[0], active.ViolationType)
	}
	healthyStreak := false
	if healthyObservation && current != nil && (current.ConnectionState == "NO_INTERNET" || current.ConnectionState == "DEGRADED") {
		if active != nil {
			healthyStreak = len(confirmedForCode(lineID, recent, mode, recoveryPolicy, active.ViolationType, true)) > 0
		}
	}
	connectionState := connectionStateForResult(result)
	if connectionState == "UNKNOWN" && current != nil {
		connectionState = current.ConnectionState
	}
	if healthyObservation && connectionState == "OK" && current != nil && (current.ConnectionState == "NO_INTERNET" || current.ConnectionState == "DEGRADED") && !healthyStreak {
		connectionState = current.ConnectionState
	}
	if !healthyObservation && current != nil {
		connectionState = current.ConnectionState
	}
	contractState := result.ContractState
	if active == nil && strings.HasPrefix(confirmedCode, "CONTRACT_") {
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
	return updateRecovery(ctx, tx, lineID, mode, at, recent, recoveryPolicy)
}

type pendingNotification struct {
	ID          int64
	SourceType  string
	SourceID    string
	Scope       string
	Message     string
	GeneratedAt time.Time
	Attempts    int
}

// DispatchPendingNotifications drains the PostgreSQL notification outbox.
// Rows are claimed and marked DELIVERING in a short transaction, then the
// provider is called after that transaction has committed. A second short
// transaction records SENT/FAILED and retry metadata, so no database lock is
// held during network I/O.
func (s *Service) DispatchPendingNotifications(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = 100
	}
	dispatched := 0
	processed := 0
	var firstErr error
	for processed < limit {
		item, ok, err := s.claimNotification(ctx, 0)
		if err != nil {
			return dispatched, err
		}
		if !ok {
			break
		}
		processed++
		result, deliveryErr := providers.SendNotification(ctx, providers.Notification{
			ID:          item.ID,
			SourceType:  item.SourceType,
			SourceID:    item.SourceID,
			Scope:       item.Scope,
			Message:     item.Message,
			GeneratedAt: item.GeneratedAt,
		})
		if err := s.finishNotification(ctx, *item, result, deliveryErr); err != nil {
			return dispatched, err
		}
		if deliveryErr != nil {
			if firstErr == nil {
				firstErr = deliveryErr
			}
			continue
		}
		dispatched++
	}
	return dispatched, firstErr
}

// DispatchNotification claims and delivers one specific outbox row. It is
// used by the administrator retry endpoint and follows the same outbox path
// as the background worker.
func (s *Service) DispatchNotification(ctx context.Context, notificationID int64) (providers.Result, error) {
	item, ok, err := s.claimNotification(ctx, notificationID)
	if err != nil {
		return providers.Result{}, err
	}
	if !ok {
		return providers.Result{}, fmt.Errorf("notification %d is not pending", notificationID)
	}
	result, deliveryErr := providers.SendNotification(ctx, providers.Notification{
		ID:          item.ID,
		SourceType:  item.SourceType,
		SourceID:    item.SourceID,
		Scope:       item.Scope,
		Message:     item.Message,
		GeneratedAt: item.GeneratedAt,
	})
	if err := s.finishNotification(ctx, *item, result, deliveryErr); err != nil {
		return providers.Result{}, err
	}
	return result, deliveryErr
}

func (s *Service) claimNotification(ctx context.Context, notificationID int64) (*pendingNotification, bool, error) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	query := `SELECT id,source_type,source_id,recipient_scope,message,generated_at,delivery_attempts
		FROM notifications WHERE `
	args := []interface{}{}
	if notificationID > 0 {
		// An explicit administrator retry may bypass exponential backoff, but
		// never steals a live DELIVERING row from the worker.
		query += `id=$1 AND (status IN ('PENDING','GENERATED','FAILED') OR (status='DELIVERING' AND delivery_started_at < now() - interval '5 minutes'))`
		args = append(args, notificationID)
	} else {
		query += `(status IN ('PENDING','GENERATED') OR (status='FAILED' AND delivery_retryable)
			OR (status='DELIVERING' AND delivery_started_at < now() - interval '5 minutes'))
		  AND (next_attempt_at IS NULL OR next_attempt_at <= now())`
	}
	query += ` ORDER BY generated_at,id FOR UPDATE SKIP LOCKED LIMIT 1`
	item := &pendingNotification{}
	if err := tx.QueryRow(ctx, query, args...).Scan(&item.ID, &item.SourceType, &item.SourceID, &item.Scope, &item.Message, &item.GeneratedAt, &item.Attempts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	started := time.Now().UTC().Truncate(time.Second)
	if _, err := tx.Exec(ctx, `UPDATE notifications SET status='DELIVERING',delivery_attempts=delivery_attempts+1,delivery_error=NULL,next_attempt_at=NULL,delivery_started_at=$1 WHERE id=$2`, started, item.ID); err != nil {
		return nil, false, err
	}
	item.Attempts++
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return item, true, nil
}

func (s *Service) finishNotification(ctx context.Context, item pendingNotification, result providers.Result, deliveryErr error) error {
	now := time.Now().UTC().Truncate(time.Second)
	if deliveryErr != nil {
		retryable := false
		if typed, ok := deliveryErr.(*providers.DeliveryError); ok {
			retryable = typed.Retryable
		}
		var nextAttempt interface{}
		if retryable {
			exponent := minInt(maxInt(item.Attempts-1, 0), 5)
			backoff := time.Duration(1<<exponent) * time.Minute
			nextAttempt = now.Add(backoff)
		}
		tag, err := s.DB.Pool.Exec(ctx, `UPDATE notifications SET status='FAILED',delivery_error=$1,delivery_retryable=$2,next_attempt_at=$3,delivery_started_at=NULL WHERE id=$4 AND status='DELIVERING' AND delivery_attempts=$5`, deliveryErr.Error(), retryable, nextAttempt, item.ID, item.Attempts)
		if err == nil && tag.RowsAffected() == 0 {
			// A newer worker reclaimed this row after the provider call exceeded
			// the stale-delivery timeout; its result is now authoritative.
			return nil
		}
		return err
	}
	channel := result.Channel
	if channel == "" {
		channel = "WEB"
	}
	tag, err := s.DB.Pool.Exec(ctx, `UPDATE notifications SET status='SENT',channel=$1,sent_at=$2,delivery_error=NULL,delivery_retryable=FALSE,next_attempt_at=NULL,delivery_started_at=NULL WHERE id=$3 AND status='DELIVERING' AND delivery_attempts=$4`, channel, now, item.ID, item.Attempts)
	if err == nil && tag.RowsAffected() == 0 {
		// See the failure branch above: do not let a stale provider response
		// overwrite a later attempt.
		return nil
	}
	return err
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
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
	if err := json.Unmarshal(raw, &item.Opening); err != nil {
		return nil, fmt.Errorf("decode incident snapshot: %w", err)
	}
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
	snapshot, err := json.Marshal(map[string]interface{}{"line_id": lineID, "confirmed_at": at.UTC().Format(time.RFC3339), "evidence_measurement_ids": ids(evidence), "violations": result.Violations, "policy": result.PolicySnapshot, "contract": result.ContractSnapshot, "reason": result.Reason})
	if err != nil {
		return 0, fmt.Errorf("marshal incident snapshot: %w", err)
	}
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
	placeholder := "PENDING-" + RandomEventID()
	err = tx.QueryRow(ctx, `INSERT INTO incidents(incident_no,line_id,source,violation_type,status,recovery_state,started_at,confirmed_at,recurrence_of,opening_snapshot_json,created_at)
	        VALUES ($1,$2,'AUTO',$3,'NEW','NONE',$4,$5,$6,$7::jsonb,$5) RETURNING id`, placeholder, lineID, violationType, started, at, previousID, string(snapshot)).Scan(&id)
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

func updateRecovery(ctx context.Context, tx pgx.Tx, lineID, mode string, at time.Time, recent []recentEvaluation, recoveryPolicy confirmationPolicy) error {
	item, err := activeIncident(ctx, tx, lineID)
	if err != nil || item == nil {
		return err
	}
	key := keyFor(lineID, item.ViolationType, mode)
	if len(recent) == 0 || !relevantEvidence(recent[0], key) {
		return nil
	}
	isProblem := hasViolation(recent[0], item.ViolationType)
	if isProblem {
		if item.Status == "RESOLVED" {
			if _, err := tx.Exec(ctx, `UPDATE incidents SET status='IN_PROGRESS',recovery_state='NONE',resolved_at=NULL WHERE id=$1`, item.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'REOPENED','system','{"reason":"violation returned during recovery verification"}'::jsonb,$2)`, item.ID, at); err != nil {
				return err
			}
		}
		return nil
	}
	good := confirmedForCode(lineID, recent, mode, recoveryPolicy, item.ViolationType, true)
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
		if _, err := tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'RECOVERY_OBSERVED','system',$2::jsonb,$3)`, item.ID, fmt.Sprintf(`{"measurement_id":%d,"status":"RESOLVED"}`, good[0].ID), at); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE incidents SET recovery_state='CONFIRMED',status='CLOSED',closed_at=COALESCE(closed_at,$2),duration_minutes=EXTRACT(EPOCH FROM ($2-started_at))/60 WHERE id=$1`, item.ID, at); err != nil {
		return err
	}
	evidenceJSON, err := json.Marshal(ids(good))
	if err != nil {
		return fmt.Errorf("marshal recovery evidence: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO incident_events(incident_id,event_type,actor,payload_json,created_at) VALUES ($1,'RECOVERY_CONFIRMED','system',$2::jsonb,$3)`, item.ID, fmt.Sprintf(`{"evidence_measurement_ids":%s}`, evidenceJSON), at)
	return err
}

// Freshness is intentionally evaluated from observed_at.  A replayed backlog
// can be accepted as evidence while it still leaves the current data axis
// NO_DATA until a recent observation arrives.
// RefreshFreshness updates materialized freshness for every non-deleted line.
// It is called by the server worker, never by a read handler, so HTTP reads do
// not acquire line locks or mutate state.
func (s *Service) RefreshFreshness(ctx context.Context, now time.Time) (int, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT id FROM lines WHERE status <> 'DELETED' ORDER BY id`)
	if err != nil {
		return 0, err
	}
	lineIDs := []string{}
	for rows.Next() {
		var lineID string
		if err := rows.Scan(&lineID); err != nil {
			rows.Close()
			return 0, err
		}
		lineIDs = append(lineIDs, lineID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	refreshed := 0
	var firstErr error
	for _, lineID := range lineIDs {
		if err := s.MarkFreshness(ctx, lineID, now); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("refresh line %s: %w", lineID, err)
			}
			continue
		}
		refreshed++
	}
	return refreshed, firstErr
}

func (s *Service) MarkFreshness(ctx context.Context, lineID string, now time.Time) error {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var lockedLineID string
	if err := tx.QueryRow(ctx, `SELECT id FROM lines WHERE id=$1 FOR UPDATE`, lineID).Scan(&lockedLineID); err != nil {
		return err
	}
	var current lineState
	var effective, updated *time.Time
	var evidence []byte
	var policyID *int64
	err = tx.QueryRow(ctx, `SELECT line_id,data_state,connection_state,contract_state,recovery_state,effective_since,updated_at,reason,evidence_ids_json,policy_id FROM line_states WHERE line_id=$1`, lineID).Scan(&current.LineID, &current.DataState, &current.ConnectionState, &current.ContractState, &current.RecoveryState, &effective, &updated, &current.Reason, &evidence, &policyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	policy, err := loadPolicy(ctx, tx, lineID, now.UTC())
	if err != nil {
		return err
	}
	contract, err := loadContract(ctx, tx, lineID, now.UTC())
	if err != nil {
		return err
	}
	// Preserve a historical policy reference even if its version is no longer
	// temporally resolvable (for example while an operator repairs a catalog).
	if policy.Value == nil && policyID != nil {
		policy.Value = &evaluation.Policy{ID: *policyID}
	}
	var last *time.Time
	if err := tx.QueryRow(ctx, `SELECT MAX(observed_at) FROM measurements WHERE line_id=$1`, lineID).Scan(&last); err != nil {
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
	if err := writeState(ctx, tx, lineID, now.UTC(), dataState, connectionState, contractState, current.RecoveryState, reason, current.EvidenceIDs, policy.Value, contract.Value); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
