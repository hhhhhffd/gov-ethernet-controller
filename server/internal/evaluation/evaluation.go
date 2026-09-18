package evaluation

import "fmt"

type Policy struct {
	ID              int64
	ScopeType       string
	ScopeID         string
	Version         int
	ValidFrom       string
	ValidTo         *string
	DownloadMin     float64
	UploadMin       float64
	PingMax         float64
	JitterMax       float64
	PacketLossMax   float64
	AvailabilityMin float64
	ConfirmCount    int
	ConfirmMinutes  int
	RecoveryCount   int
	RecoveryMinutes int
	FreshnessSec    int
}

type Contract struct {
	ID              int64
	LineID          string
	ValidFrom       string
	ValidTo         *string
	ContractNo      *string
	DownloadMin     *float64
	UploadMin       *float64
	PingMax         *float64
	JitterMax       *float64
	PacketLossMax   *float64
	AvailabilityMin *float64
}

type Measurement struct {
	ConnectionStatus string
	Quality          string
	Download         *float64
	Upload           *float64
	Ping             *float64
	Jitter           *float64
	PacketLoss       *float64
	Availability     *float64
}

type Violation struct {
	Code      string      `json:"code"`
	Metric    string      `json:"metric"`
	Actual    interface{} `json:"actual"`
	Threshold interface{} `json:"threshold"`
	Direction string      `json:"direction,omitempty"`
}

type Result struct {
	BaselineState    string
	ContractState    string
	Violations       []Violation
	Valid            bool
	Reason           string
	PolicySnapshot   map[string]interface{}
	ContractSnapshot map[string]interface{}
}

func SnapshotPolicy(p *Policy) map[string]interface{} {
	if p == nil {
		return map[string]interface{}{}
	}
	result := map[string]interface{}{
		"id": p.ID, "scope_type": p.ScopeType, "scope_id": p.ScopeID, "version": p.Version,
		"valid_from": p.ValidFrom, "valid_to": p.ValidTo, "download_min": p.DownloadMin,
		"upload_min": p.UploadMin, "ping_max": p.PingMax, "jitter_max": p.JitterMax,
		"packet_loss_max": p.PacketLossMax, "availability_min": p.AvailabilityMin,
		"confirm_count": p.ConfirmCount, "confirm_minutes": p.ConfirmMinutes,
		"recovery_count": p.RecoveryCount, "recovery_minutes": p.RecoveryMinutes,
		"freshness_seconds": p.FreshnessSec,
	}
	return result
}

func SnapshotContract(c *Contract) map[string]interface{} {
	if c == nil {
		return map[string]interface{}{}
	}
	return map[string]interface{}{
		"id": c.ID, "line_id": c.LineID, "valid_from": c.ValidFrom, "valid_to": c.ValidTo,
		"contract_no": c.ContractNo, "download_min": c.DownloadMin, "upload_min": c.UploadMin,
		"ping_max": c.PingMax, "jitter_max": c.JitterMax, "packet_loss_max": c.PacketLossMax,
		"availability_min": c.AvailabilityMin,
	}
}

func Evaluate(m Measurement, policy *Policy, contract *Contract) Result {
	result := Result{BaselineState: "UNKNOWN", ContractState: "UNKNOWN", Valid: m.Quality != "INVALID", PolicySnapshot: SnapshotPolicy(policy), ContractSnapshot: SnapshotContract(contract)}
	if !result.Valid {
		result.Reason = "measurement marked INVALID"
		return result
	}
	// SUSPECT measurements may be useful as diagnostics, but they are not
	// authoritative evidence for a line state or an incident. Keep all
	// aggregate states UNKNOWN so callers cannot accidentally treat them as a
	// confirmed evaluation.
	if m.Quality == "SUSPECT" {
		result.Valid = false
		result.Reason = "measurement marked SUSPECT"
		return result
	}
	if m.ConnectionStatus == "NO_INTERNET" {
		result.Violations = append(result.Violations, Violation{Code: "NO_INTERNET", Metric: "connection_status", Actual: "NO_INTERNET", Threshold: "reachable"})
	}
	baselineMetrics := metricEvaluation{}
	if policy != nil {
		baselineMetrics = evaluatePolicyMetrics(m, policy)
		result.Violations = append(result.Violations, baselineMetrics.violations...)
	}
	contractMetrics := metricEvaluation{}
	if contract != nil {
		contractMetrics = evaluateContractMetrics(m, contract)
		result.Violations = append(result.Violations, contractMetrics.violations...)
	}
	if policy == nil {
		if m.ConnectionStatus == "NO_INTERNET" {
			result.BaselineState = "VIOLATION"
		}
	} else if m.ConnectionStatus == "NO_INTERNET" {
		// Connectivity failure is authoritative independently of the missing
		// performance metrics that normally accompany it.
		result.BaselineState = "VIOLATION"
	} else if baselineMetrics.unknown == 0 && baselineMetrics.required > 0 {
		if len(baselineMetrics.violations) > 0 {
			result.BaselineState = "VIOLATION"
		} else {
			result.BaselineState = "OK"
		}
	}
	if contract != nil && contractMetrics.required > 0 && contractMetrics.unknown == 0 {
		if len(contractMetrics.violations) > 0 {
			result.ContractState = "DEVIATES"
		} else {
			result.ContractState = "MEETS"
		}
	}
	result.Reason = "No threshold violation"
	if (policy != nil && baselineMetrics.unknown > 0) || (contract != nil && contractMetrics.unknown > 0) {
		result.Reason = "Required metric unavailable"
	}
	if len(result.Violations) > 0 {
		for i, violation := range result.Violations {
			if i > 0 || result.Reason != "No threshold violation" {
				result.Reason += "; "
			}
			if violation.Direction == "" {
				result.Reason += violation.Code
			} else {
				result.Reason += fmt.Sprintf("%s %v (%s %v)", violation.Metric, violation.Actual, violation.Direction, violation.Threshold)
			}
		}
	}
	return result
}

const (
	metricObserved  = "observed"
	metricUnknown   = "UNKNOWN"
	metricOK        = "OK"
	metricViolation = "VIOLATION"
)

type metricEvaluation struct {
	required   int
	unknown    int
	violations []Violation
	states     map[string]string
}

// evaluateMetric classifies one metric before it contributes to an axis. A
// present value without a configured threshold is deliberately only observed:
// it cannot prove that an axis meets a policy or contract.
func evaluateMetric(name string, actual, threshold *float64, direction, code string) (string, *Violation) {
	if actual == nil {
		return metricUnknown, nil
	}
	if threshold == nil {
		return metricObserved, nil
	}
	bad := (direction == "<" && *actual < *threshold) || (direction == ">" && *actual > *threshold)
	if !bad {
		return metricOK, nil
	}
	return metricViolation, &Violation{Code: code, Metric: name, Actual: *actual, Threshold: *threshold, Direction: direction}
}

func evaluatePolicyMetrics(m Measurement, p *Policy) metricEvaluation {
	return evaluateMetrics([]metricCheck{
		{"download", m.Download, metricThreshold(p.DownloadMin), "<", "BASELINE_DOWNLOAD"},
		{"upload", m.Upload, metricThreshold(p.UploadMin), "<", "BASELINE_UPLOAD"},
		{"ping", m.Ping, metricThreshold(p.PingMax), ">", "BASELINE_PING"},
		{"jitter", m.Jitter, metricThreshold(p.JitterMax), ">", "BASELINE_JITTER"},
		{"packet_loss", m.PacketLoss, metricThreshold(p.PacketLossMax), ">", "BASELINE_PACKET_LOSS"},
		{"availability", m.Availability, metricThreshold(p.AvailabilityMin), "<", "BASELINE_AVAILABILITY"},
	})
}

func metricThreshold(value float64) *float64 { return &value }

func evaluateContractMetrics(m Measurement, c *Contract) metricEvaluation {
	return evaluateMetrics([]metricCheck{
		{"download", m.Download, c.DownloadMin, "<", "CONTRACT_DOWNLOAD"},
		{"upload", m.Upload, c.UploadMin, "<", "CONTRACT_UPLOAD"},
		{"ping", m.Ping, c.PingMax, ">", "CONTRACT_PING"},
		{"jitter", m.Jitter, c.JitterMax, ">", "CONTRACT_JITTER"},
		{"packet_loss", m.PacketLoss, c.PacketLossMax, ">", "CONTRACT_PACKET_LOSS"},
		{"availability", m.Availability, c.AvailabilityMin, "<", "CONTRACT_AVAILABILITY"},
	})
}

type metricCheck struct {
	name      string
	actual    *float64
	threshold *float64
	direction string
	code      string
}

func evaluateMetrics(checks []metricCheck) metricEvaluation {
	evaluation := metricEvaluation{states: make(map[string]string, len(checks))}
	for _, check := range checks {
		state, violation := evaluateMetric(check.name, check.actual, check.threshold, check.direction, check.code)
		evaluation.states[check.name] = state
		if check.threshold != nil {
			evaluation.required++
			if state == metricUnknown {
				evaluation.unknown++
			}
		}
		if violation != nil {
			evaluation.violations = append(evaluation.violations, *violation)
		}
	}
	return evaluation
}
