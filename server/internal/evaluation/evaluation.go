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
	if m.ConnectionStatus == "NO_INTERNET" {
		result.Violations = append(result.Violations, Violation{Code: "NO_INTERNET", Metric: "connection_status", Actual: "NO_INTERNET", Threshold: "reachable"})
	}
	if policy != nil {
		result.Violations = append(result.Violations, metricViolations(m, policy.DownloadMin, policy.UploadMin, policy.PingMax, policy.JitterMax, policy.PacketLossMax, policy.AvailabilityMin, "BASELINE")...)
	}
	contractViolations := []Violation{}
	if contract != nil {
		contractViolations = contractMetricViolations(m, contract)
		result.Violations = append(result.Violations, contractViolations...)
	}
	hasMetrics := m.Download != nil || m.Upload != nil || m.Ping != nil || m.Jitter != nil || m.PacketLoss != nil || m.Availability != nil
	if policy == nil {
		if m.ConnectionStatus == "NO_INTERNET" {
			result.BaselineState = "VIOLATION"
		}
	} else if len(result.Violations) > 0 {
		// Contract-only failures belong to the contract axis. Connectivity
		// remains healthy when no baseline/connection violation exists.
		baselineViolations := false
		for _, violation := range result.Violations {
			if violation.Code == "NO_INTERNET" || len(violation.Code) >= 9 && violation.Code[:9] == "BASELINE_" {
				baselineViolations = true
				break
			}
		}
		if baselineViolations {
			result.BaselineState = "VIOLATION"
		} else if hasMetrics || m.ConnectionStatus == "OK" {
			result.BaselineState = "OK"
		}
	} else if hasMetrics || m.ConnectionStatus == "OK" {
		result.BaselineState = "OK"
	}
	if len(contractViolations) > 0 {
		result.ContractState = "DEVIATES"
	} else if contract != nil && hasMetrics {
		result.ContractState = "MEETS"
	}
	result.Reason = "No threshold violation"
	if len(result.Violations) > 0 {
		for i, violation := range result.Violations {
			if i > 0 {
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

func metricViolations(m Measurement, downloadMin, uploadMin, pingMax, jitterMax, lossMax, availabilityMin float64, prefix string) []Violation {
	result := []Violation{}
	if m.Download != nil && *m.Download < downloadMin {
		result = append(result, Violation{Code: prefix + "_DOWNLOAD", Metric: "download", Actual: *m.Download, Threshold: downloadMin, Direction: "<"})
	}
	if m.Upload != nil && *m.Upload < uploadMin {
		result = append(result, Violation{Code: prefix + "_UPLOAD", Metric: "upload", Actual: *m.Upload, Threshold: uploadMin, Direction: "<"})
	}
	if m.Ping != nil && *m.Ping > pingMax {
		result = append(result, Violation{Code: prefix + "_PING", Metric: "ping", Actual: *m.Ping, Threshold: pingMax, Direction: ">"})
	}
	if m.Jitter != nil && *m.Jitter > jitterMax {
		result = append(result, Violation{Code: prefix + "_JITTER", Metric: "jitter", Actual: *m.Jitter, Threshold: jitterMax, Direction: ">"})
	}
	if m.PacketLoss != nil && *m.PacketLoss > lossMax {
		result = append(result, Violation{Code: prefix + "_PACKET_LOSS", Metric: "packet_loss", Actual: *m.PacketLoss, Threshold: lossMax, Direction: ">"})
	}
	if m.Availability != nil && *m.Availability < availabilityMin {
		result = append(result, Violation{Code: prefix + "_AVAILABILITY", Metric: "availability", Actual: *m.Availability, Threshold: availabilityMin, Direction: "<"})
	}
	return result
}

func contractMetricViolations(m Measurement, c *Contract) []Violation {
	result := []Violation{}
	checks := []struct {
		name      string
		actual    *float64
		threshold *float64
		direction string
	}{
		{"download", m.Download, c.DownloadMin, "<"}, {"upload", m.Upload, c.UploadMin, "<"},
		{"ping", m.Ping, c.PingMax, ">"}, {"jitter", m.Jitter, c.JitterMax, ">"},
		{"packet_loss", m.PacketLoss, c.PacketLossMax, ">"}, {"availability", m.Availability, c.AvailabilityMin, "<"},
	}
	for _, check := range checks {
		if check.actual == nil || check.threshold == nil {
			continue
		}
		bad := check.direction == "<" && *check.actual < *check.threshold || check.direction == ">" && *check.actual > *check.threshold
		if bad {
			result = append(result, Violation{Code: "CONTRACT_" + upper(check.name), Metric: check.name, Actual: *check.actual, Threshold: *check.threshold, Direction: check.direction})
		}
	}
	return result
}

func upper(value string) string {
	result := []byte(value)
	for i, char := range result {
		if char >= 'a' && char <= 'z' {
			result[i] = char - ('a' - 'A')
		}
	}
	return string(result)
}
