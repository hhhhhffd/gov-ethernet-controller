package api

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/evaluation"
)

const impactPreviewMaxMeasurements = 10000

type impactPreviewRequest struct {
	LineIDs     []string               `json:"line_ids"`
	From        time.Time              `json:"from"`
	To          time.Time              `json:"to"`
	Idempotency string                 `json:"idempotency_key"`
	Policy      impactPolicyProposal   `json:"policy"`
	Contract    impactContractProposal `json:"contract"`
}

type impactPolicyProposal struct {
	DownloadMin            *float64 `json:"download_min"`
	UploadMin              *float64 `json:"upload_min"`
	PingMax                *float64 `json:"ping_max"`
	JitterMax              *float64 `json:"jitter_max"`
	PacketLossMax          *float64 `json:"packet_loss_max"`
	AvailabilityMin        *float64 `json:"availability_min"`
	ConfirmCount           *int     `json:"confirm_count"`
	ConfirmMinutes         *int     `json:"confirm_minutes"`
	ConfirmDurationMinutes *int     `json:"confirm_duration_minutes"`
	RecoveryCount          *int     `json:"recovery_count"`
	RecoveryMinutes        *int     `json:"recovery_minutes"`
	FreshnessSeconds       *int     `json:"freshness_seconds"`
}

type impactContractProposal struct {
	DownloadMin     *float64 `json:"download_min"`
	UploadMin       *float64 `json:"upload_min"`
	PingMax         *float64 `json:"ping_max"`
	JitterMax       *float64 `json:"jitter_max"`
	PacketLossMax   *float64 `json:"packet_loss_max"`
	AvailabilityMin *float64 `json:"availability_min"`
}

func impactNumber(value interface{}) (float64, bool) {
	number, ok := value.(float64)
	return number, ok
}

func impactInt(value interface{}) (int, bool) {
	number, ok := impactNumber(value)
	return int(number), ok
}

func impactFloat(snapshot map[string]interface{}, key string) *float64 {
	value, ok := impactNumber(snapshot[key])
	if !ok {
		return nil
	}
	return &value
}

func impactIntPtr(snapshot map[string]interface{}, key string) *int {
	value, ok := impactInt(snapshot[key])
	if !ok {
		return nil
	}
	return &value
}

func impactPolicy(snapshot map[string]interface{}, proposal impactPolicyProposal) *evaluation.Policy {
	if len(snapshot) == 0 && proposalPolicyEmpty(proposal) {
		return nil
	}
	policy := &evaluation.Policy{ScopeType: "PREVIEW", ScopeID: "PROPOSED", Version: 0,
		DownloadMin: valueOrFloat(snapshot, "download_min"), UploadMin: valueOrFloat(snapshot, "upload_min"),
		PingMax: valueOrFloat(snapshot, "ping_max"), JitterMax: valueOrFloat(snapshot, "jitter_max"),
		PacketLossMax: valueOrFloat(snapshot, "packet_loss_max"), AvailabilityMin: valueOrFloat(snapshot, "availability_min"),
		ConfirmCount: valueOrInt(snapshot, "confirm_count"), ConfirmMinutes: valueOrInt(snapshot, "confirm_minutes"),
		RecoveryCount: valueOrInt(snapshot, "recovery_count"), RecoveryMinutes: valueOrInt(snapshot, "recovery_minutes"), FreshnessSec: valueOrInt(snapshot, "freshness_seconds")}
	if proposal.DownloadMin != nil {
		policy.DownloadMin = *proposal.DownloadMin
	}
	if proposal.UploadMin != nil {
		policy.UploadMin = *proposal.UploadMin
	}
	if proposal.PingMax != nil {
		policy.PingMax = *proposal.PingMax
	}
	if proposal.JitterMax != nil {
		policy.JitterMax = *proposal.JitterMax
	}
	if proposal.PacketLossMax != nil {
		policy.PacketLossMax = *proposal.PacketLossMax
	}
	if proposal.AvailabilityMin != nil {
		policy.AvailabilityMin = *proposal.AvailabilityMin
	}
	if proposal.ConfirmCount != nil {
		policy.ConfirmCount = *proposal.ConfirmCount
	}
	if proposal.ConfirmMinutes != nil {
		policy.ConfirmMinutes = *proposal.ConfirmMinutes
	}
	if proposal.ConfirmDurationMinutes != nil {
		policy.ConfirmDurationMinutes = proposal.ConfirmDurationMinutes
	}
	if proposal.RecoveryCount != nil {
		policy.RecoveryCount = *proposal.RecoveryCount
	}
	if proposal.RecoveryMinutes != nil {
		policy.RecoveryMinutes = *proposal.RecoveryMinutes
	}
	if proposal.FreshnessSeconds != nil {
		policy.FreshnessSec = *proposal.FreshnessSeconds
	}
	return policy
}

func proposalPolicyEmpty(proposal impactPolicyProposal) bool {
	return proposal.DownloadMin == nil && proposal.UploadMin == nil && proposal.PingMax == nil && proposal.JitterMax == nil && proposal.PacketLossMax == nil && proposal.AvailabilityMin == nil && proposal.ConfirmCount == nil && proposal.ConfirmMinutes == nil && proposal.ConfirmDurationMinutes == nil && proposal.RecoveryCount == nil && proposal.RecoveryMinutes == nil && proposal.FreshnessSeconds == nil
}

func valueOrFloat(snapshot map[string]interface{}, key string) float64 {
	value, _ := impactNumber(snapshot[key])
	return value
}
func valueOrInt(snapshot map[string]interface{}, key string) int {
	value, _ := impactInt(snapshot[key])
	return value
}

func impactContract(snapshot map[string]interface{}, proposal impactContractProposal, lineID string) *evaluation.Contract {
	if len(snapshot) == 0 && proposal.ContractEmpty() {
		return nil
	}
	contract := &evaluation.Contract{LineID: lineID, ID: int64(valueOrInt(snapshot, "id")), DownloadMin: impactFloat(snapshot, "download_min"), UploadMin: impactFloat(snapshot, "upload_min"), PingMax: impactFloat(snapshot, "ping_max"), JitterMax: impactFloat(snapshot, "jitter_max"), PacketLossMax: impactFloat(snapshot, "packet_loss_max"), AvailabilityMin: impactFloat(snapshot, "availability_min")}
	if proposal.DownloadMin != nil {
		contract.DownloadMin = proposal.DownloadMin
	}
	if proposal.UploadMin != nil {
		contract.UploadMin = proposal.UploadMin
	}
	if proposal.PingMax != nil {
		contract.PingMax = proposal.PingMax
	}
	if proposal.JitterMax != nil {
		contract.JitterMax = proposal.JitterMax
	}
	if proposal.PacketLossMax != nil {
		contract.PacketLossMax = proposal.PacketLossMax
	}
	if proposal.AvailabilityMin != nil {
		contract.AvailabilityMin = proposal.AvailabilityMin
	}
	return contract
}

func (proposal impactContractProposal) ContractEmpty() bool {
	return proposal.DownloadMin == nil && proposal.UploadMin == nil && proposal.PingMax == nil && proposal.JitterMax == nil && proposal.PacketLossMax == nil && proposal.AvailabilityMin == nil
}

func impactMeasurement(row reportRow) evaluation.Measurement {
	return evaluation.Measurement{ConnectionStatus: row.ConnectionStatus, Quality: row.Quality, Download: row.Download, Upload: row.Upload, Ping: row.Ping, Jitter: row.Jitter, PacketLoss: row.PacketLoss, Availability: row.Availability}
}

func impactLineResults(values map[string]map[string]interface{}) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i]["line_id"].(string) < result[j]["line_id"].(string)
	})
	return result
}

func impactProposalEmpty(request impactPreviewRequest) bool {
	p := request.Policy
	c := request.Contract
	return p.DownloadMin == nil && p.UploadMin == nil && p.PingMax == nil && p.JitterMax == nil && p.PacketLossMax == nil && p.AvailabilityMin == nil && p.ConfirmCount == nil && p.ConfirmMinutes == nil && p.ConfirmDurationMinutes == nil && p.RecoveryCount == nil && p.RecoveryMinutes == nil && p.FreshnessSeconds == nil && c.DownloadMin == nil && c.UploadMin == nil && c.PingMax == nil && c.JitterMax == nil && c.PacketLossMax == nil && c.AvailabilityMin == nil
}

func impactProposalValid(request impactPreviewRequest) bool {
	for _, value := range []*float64{request.Policy.DownloadMin, request.Policy.UploadMin, request.Policy.PingMax, request.Policy.JitterMax, request.Policy.PacketLossMax, request.Policy.AvailabilityMin, request.Contract.DownloadMin, request.Contract.UploadMin, request.Contract.PingMax, request.Contract.JitterMax, request.Contract.PacketLossMax, request.Contract.AvailabilityMin} {
		if value != nil && *value < 0 {
			return false
		}
	}
	for _, value := range []*int{request.Policy.ConfirmCount, request.Policy.ConfirmMinutes, request.Policy.ConfirmDurationMinutes, request.Policy.RecoveryCount, request.Policy.RecoveryMinutes, request.Policy.FreshnessSeconds} {
		if value != nil && *value < 0 {
			return false
		}
	}
	for _, value := range []*float64{request.Policy.PacketLossMax, request.Policy.AvailabilityMin, request.Contract.PacketLossMax, request.Contract.AvailabilityMin} {
		if value != nil && *value > 100 {
			return false
		}
	}
	return true
}

func (s *Server) impactPreview(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if !requireAdmin(w, p) {
		return
	}
	var request impactPreviewRequest
	if err := decodeJSON(r, &request); err != nil || request.From.IsZero() || request.To.IsZero() {
		writeError(w, http.StatusUnprocessableEntity, "from, to and a valid preview payload are required")
		return
	}
	request.From = request.From.UTC().Truncate(time.Second)
	request.To = request.To.UTC().Truncate(time.Second)
	if !request.From.Before(request.To) || request.To.Sub(request.From) > 90*24*time.Hour {
		writeError(w, http.StatusUnprocessableEntity, "preview period must be positive and no longer than 90 days")
		return
	}
	if len(request.LineIDs) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "line_ids must contain at least one line")
		return
	}
	lineSet := map[string]bool{}
	for _, id := range request.LineIDs {
		if strings.TrimSpace(id) != "" {
			lineSet[strings.TrimSpace(id)] = true
		}
	}
	if len(lineSet) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "line_ids must contain at least one line")
		return
	}
	if impactProposalEmpty(request) || !impactProposalValid(request) {
		writeError(w, http.StatusUnprocessableEntity, "preview proposal must contain valid non-negative thresholds or policy controls")
		return
	}
	for lineID := range lineSet {
		_, visible, lineErr := s.lineVisible(r.Context(), p, lineID)
		if lineErr != nil {
			writeError(w, http.StatusInternalServerError, "could not resolve preview line scope")
			return
		}
		if !visible {
			writeError(w, http.StatusNotFound, "line not found or not permitted")
			return
		}
	}
	rows, err := s.reportRows(r, p, request.From, request.To)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query historical preview source")
		return
	}
	selected := make([]reportRow, 0, len(rows))
	for _, row := range rows {
		if lineSet[row.LineID] {
			selected = append(selected, row)
		}
	}
	if len(selected) > impactPreviewMaxMeasurements {
		writeError(w, http.StatusUnprocessableEntity, "preview source exceeds the synchronous limit; narrow the period or line set")
		return
	}
	seenLines := map[string]bool{}
	lineResults := map[string]map[string]interface{}{}
	for _, row := range selected {
		seenLines[row.LineID] = true
	}
	for lineID := range lineSet {
		if _, ok := lineResults[lineID]; !ok {
			lineResults[lineID] = map[string]interface{}{"line_id": lineID, "measurements": 0, "changed_measurements": 0, "projected_incident_measurements": 0, "current_statuses": map[string]int{}, "projected_statuses": map[string]int{}}
		}
	}
	changed := 0
	projectedIncidents := 0
	unknown := 0
	snapshotVersions := map[string]map[string]interface{}{}
	for _, row := range selected {
		var policySnapshot, contractSnapshot map[string]interface{}
		_ = json.Unmarshal(row.PolicySnapshot, &policySnapshot)
		_ = json.Unmarshal(row.ContractSnapshot, &contractSnapshot)
		result := evaluation.Evaluate(impactMeasurement(row), impactPolicy(policySnapshot, request.Policy), impactContract(contractSnapshot, request.Contract, row.LineID))
		if result.BaselineState == "UNKNOWN" || result.ContractState == "UNKNOWN" {
			unknown++
		}
		if result.BaselineState != row.BaselineState || result.ContractState != row.ContractState {
			changed++
		}
		if result.BaselineState == "VIOLATION" || result.ContractState == "DEVIATES" {
			projectedIncidents++
		}
		line := lineResults[row.LineID]
		if line == nil {
			line = map[string]interface{}{"line_id": row.LineID, "measurements": 0, "changed_measurements": 0, "projected_incident_measurements": 0, "current_statuses": map[string]int{}, "projected_statuses": map[string]int{}}
			lineResults[row.LineID] = line
		}
		if _, ok := snapshotVersions[row.LineID]; !ok {
			var contextSnapshot, policySnapshot, contractSnapshot map[string]interface{}
			_ = json.Unmarshal(row.LineContextSnapshot, &contextSnapshot)
			_ = json.Unmarshal(row.PolicySnapshot, &policySnapshot)
			_ = json.Unmarshal(row.ContractSnapshot, &contractSnapshot)
			snapshotVersions[row.LineID] = map[string]interface{}{"context_version": contextSnapshot["version"], "policy_version": policySnapshot["version"], "contract_id": contractSnapshot["id"]}
		}
		line["measurements"] = line["measurements"].(int) + 1
		currentStatuses := line["current_statuses"].(map[string]int)
		projectedStatuses := line["projected_statuses"].(map[string]int)
		currentStatuses[row.BaselineState+"/"+row.ContractState]++
		projectedStatuses[result.BaselineState+"/"+result.ContractState]++
		if result.BaselineState != row.BaselineState || result.ContractState != row.ContractState {
			line["changed_measurements"] = line["changed_measurements"].(int) + 1
		}
		if result.BaselineState == "VIOLATION" || result.ContractState == "DEVIATES" {
			line["projected_incident_measurements"] = line["projected_incident_measurements"].(int) + 1
		}
	}
	input := map[string]interface{}{"line_ids": request.LineIDs, "from": request.From, "to": request.To, "policy": request.Policy, "contract": request.Contract, "measurement_count": len(selected)}
	canonical, _ := json.Marshal(map[string]interface{}{"input": input, "rows": selected})
	digest := sha256.Sum256(canonical)
	previewID := fmt.Sprintf("preview-%x", digest[:8])
	status := "AVAILABLE"
	if len(selected) == 0 {
		status = "NO_DATA"
	}
	after := map[string]interface{}{"preview_id": previewID, "mode": "IMPACT_PREVIEW", "status": status, "source_period": map[string]interface{}{"from": request.From, "to": request.To}, "proposal": map[string]interface{}{"policy": request.Policy, "contract": request.Contract}, "input": map[string]interface{}{"measurement_count": len(selected), "line_count": len(lineSet), "historical_snapshots": true, "snapshot_versions": snapshotVersions}, "result": map[string]interface{}{"affected_lines": impactLineResults(lineResults), "measurements": len(selected), "changed_measurements": changed, "projected_incident_measurements": projectedIncidents, "unknown_measurements": unknown}, "actual_truth": "NOT_MUTATED", "apply": map[string]interface{}{"available": false, "next_step": "create an explicit policy or contract version through the admin API"}, "execution": "SYNCHRONOUS_IMMUTABLE", "idempotency_key": request.Idempotency}
	var alreadyAudited bool
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM audit_events WHERE action='configuration.impact_preview' AND object_type='impact_preview' AND object_id=$1)`, previewID).Scan(&alreadyAudited); err == nil && !alreadyAudited {
		writeAudit(r.Context(), s, p, "configuration.impact_preview", "impact_preview", previewID, nil, after)
	}
	writeJSON(w, http.StatusOK, after)
}
