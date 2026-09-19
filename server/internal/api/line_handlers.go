package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/measurements"
)

type lineRecord struct {
	ID, OrganizationID, SchoolID, OrganizationName, District, Address, ContactName, ContactPhone string
	ProviderID, ProviderName, SupportContact, Role, Technology, Status                           string
	Latitude, Longitude                                                                          *float64
	State                                                                                        *stateRecord
	Latest                                                                                       *latestRecord
	LatestLoaded                                                                                 bool
}

func scanLine(row pgx.Row) (lineRecord, error) {
	var item lineRecord
	var providerID, providerName, supportContact *string
	err := row.Scan(&item.ID, &item.OrganizationID, &providerID, &item.Role, &item.Technology, &item.Status, &item.SchoolID, &item.OrganizationName, &item.District, &item.Address, &item.ContactName, &item.ContactPhone, &item.Latitude, &item.Longitude, &providerName, &supportContact)
	if providerID != nil {
		item.ProviderID = *providerID
	}
	if providerName != nil {
		item.ProviderName = *providerName
	}
	if supportContact != nil {
		item.SupportContact = *supportContact
	}
	return item, err
}

func (s *Server) queryLine(ctx context.Context, id string) (lineRecord, error) {
	return scanLine(s.DB.Pool.QueryRow(ctx, `SELECT l.id,l.organization_id,l.provider_id,l.role,l.technology,l.status,o.school_id,o.name,o.district,o.address,o.contact_name,o.contact_phone,o.latitude,o.longitude,p.name,p.support_contact FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE l.id=$1`, id))
}

func scopeSQL(p *auth.Principal, start int) (string, []interface{}) {
	if p == nil || p.IsAdmin() {
		return "TRUE", nil
	}
	params := []interface{}{}
	clauses := []string{}
	for _, scope := range p.Scopes {
		switch strings.ToUpper(scope.Type) {
		case "LINE":
			clauses = append(clauses, "l.id=$"+itoa(start+len(params)))
			params = append(params, scope.ID)
		case "ORGANIZATION":
			if p.Role == "DISTRICT" || p.Role == "SCHOOL" {
				clauses = append(clauses, "l.organization_id=$"+itoa(start+len(params)))
				params = append(params, scope.ID)
			}
		case "DISTRICT":
			if p.Role == "DISTRICT" {
				clauses = append(clauses, "o.district=$"+itoa(start+len(params)))
				params = append(params, scope.ID)
			}
		case "PROVIDER":
			if p.Role == "PROVIDER" {
				clauses = append(clauses, "l.provider_id=$"+itoa(start+len(params)))
				params = append(params, scope.ID)
			}
		}
	}
	if len(clauses) == 0 {
		return "FALSE", params
	}
	return "(" + strings.Join(clauses, " OR ") + ")", params
}

func itoa(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	result := ""
	for value > 0 {
		result = string(digits[value%10]) + result
		value /= 10
	}
	return result
}

func (s *Server) lineVisible(ctx context.Context, p *auth.Principal, id string) (lineRecord, bool, error) {
	line, err := s.queryLine(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return lineRecord{}, false, nil
		}
		return lineRecord{}, false, err
	}
	return line, auth.HasLineScope(p, line.ID, line.OrganizationID, line.District, line.ProviderID), nil
}

type stateRecord struct {
	DataState, ConnectionState, ContractState, RecoveryState, Reason string
	EffectiveSince, UpdatedAt                                        *time.Time
	Evidence                                                         []int64
	PolicyID                                                         *int64
}

func (s *Server) state(ctx context.Context, lineID string) (stateRecord, error) {
	var result stateRecord
	var evidence []byte
	err := s.DB.Pool.QueryRow(ctx, `SELECT data_state,connection_state,contract_state,recovery_state,reason,effective_since,updated_at,evidence_ids_json,policy_id FROM line_states WHERE line_id=$1`, lineID).Scan(&result.DataState, &result.ConnectionState, &result.ContractState, &result.RecoveryState, &result.Reason, &result.EffectiveSince, &result.UpdatedAt, &evidence, &result.PolicyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return stateRecord{DataState: "NO_DATA", ConnectionState: "UNKNOWN", ContractState: "UNKNOWN", RecoveryState: "NONE", Reason: "No observations yet", Evidence: []int64{}}, nil
	}
	if err != nil {
		return stateRecord{}, err
	}
	if err := jsonUnmarshal(evidence, &result.Evidence); err != nil {
		return stateRecord{}, fmt.Errorf("decode line state evidence: %w", err)
	}
	return result, nil
}

func stateMap(value stateRecord) map[string]interface{} {
	return map[string]interface{}{"data_state": value.DataState, "connection_state": value.ConnectionState, "contract_state": value.ContractState, "recovery_state": value.RecoveryState, "effective_since": nullableTime(value.EffectiveSince), "updated_at": nullableTime(value.UpdatedAt), "reason": value.Reason, "evidence_ids": value.Evidence}
}

type latestRecord struct {
	ID                                                       int64
	ClientEventID                                            string
	ObservedAt                                               time.Time
	DeviceID                                                 string
	Mode, ConnectionStatus                                   string
	Download, Upload, Ping, Jitter, PacketLoss, Availability *float64
}

func (s *Server) latest(ctx context.Context, lineID string) (map[string]interface{}, error) {
	var row latestRecord
	err := s.DB.Pool.QueryRow(ctx, `SELECT id,client_event_id,observed_at,device_id,mode,connection_status,download,upload,ping,jitter,packet_loss,availability FROM measurements WHERE line_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1`, lineID).Scan(&row.ID, &row.ClientEventID, &row.ObservedAt, &row.DeviceID, &row.Mode, &row.ConnectionStatus, &row.Download, &row.Upload, &row.Ping, &row.Jitter, &row.PacketLoss, &row.Availability)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]interface{}{}, nil
	}
	if err != nil {
		return nil, err
	}
	return latestMap(row), nil
}

func latestMap(row latestRecord) map[string]interface{} {
	return map[string]interface{}{"id": row.ID, "client_event_id": row.ClientEventID, "observed_at": row.ObservedAt, "device_id": row.DeviceID, "mode": row.Mode, "connection_status": row.ConnectionStatus, "download": row.Download, "upload": row.Upload, "ping": row.Ping, "jitter": row.Jitter, "packet_loss": row.PacketLoss, "loss": row.PacketLoss, "availability": row.Availability, "at": row.ObservedAt}
}

func (s *Server) lineMap(ctx context.Context, line lineRecord) (map[string]interface{}, error) {
	state := stateRecord{}
	if line.State != nil {
		state = *line.State
	} else {
		loaded, err := s.state(ctx, line.ID)
		if err != nil {
			return nil, err
		}
		state = loaded
	}
	status := state.ConnectionState
	if state.DataState == "NO_DATA" {
		status = "NO_DATA"
	}
	latest := map[string]interface{}{}
	if line.Latest != nil {
		latest = latestMap(*line.Latest)
	} else if line.LatestLoaded {
		// The list query already checked for a latest measurement and found
		// none. Do not issue a per-line fallback query while rows are open.
		latest = map[string]interface{}{}
	} else {
		loaded, err := s.latest(ctx, line.ID)
		if err != nil {
			return nil, err
		}
		latest = loaded
	}
	return map[string]interface{}{"id": line.ID, "line_id": line.ID, "organization_id": line.OrganizationID, "school_id": line.SchoolID, "organization_name": line.OrganizationName, "school_name": line.OrganizationName, "district": line.District, "address": line.Address, "contact_name": line.ContactName, "contact_phone": line.ContactPhone, "latitude": line.Latitude, "longitude": line.Longitude, "provider_id": line.ProviderID, "provider_name": line.ProviderName, "provider": line.ProviderName, "support_contact": line.SupportContact, "role": line.Role, "technology": line.Technology, "line_status": line.Status, "status": status, "status_mode": "CURRENT_OPERATIONAL", "data_state": state.DataState, "quality_state": state.ConnectionState, "connection_state": state.ConnectionState, "contract_state": state.ContractState, "state": stateMap(state), "latest": latest, "latest_semantics": "latest measurement/state; not a historical period summary"}, nil
}

func (s *Server) listLines(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	filters := []string{"l.status <> 'DELETED'"}
	if where != "TRUE" {
		filters = append(filters, where)
	}
	add := func(key, column string) {
		if value := r.URL.Query().Get(key); value != "" {
			params = append(params, value)
			filters = append(filters, column+"=$"+itoa(len(params)))
		}
	}
	add("district", "o.district")
	add("provider_id", "l.provider_id")
	add("role", "l.role")
	add("line_status", "l.status")
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT l.id,l.organization_id,l.provider_id,l.role,l.technology,l.status,o.school_id,o.name,o.district,o.address,o.contact_name,o.contact_phone,o.latitude,o.longitude,p.name,p.support_contact,
		ls.data_state,ls.connection_state,ls.contract_state,ls.recovery_state,ls.reason,ls.effective_since,ls.updated_at,ls.evidence_ids_json,ls.policy_id,
		latest.id,latest.client_event_id,latest.observed_at,latest.device_id,latest.mode,latest.connection_status,latest.download,latest.upload,latest.ping,latest.jitter,latest.packet_loss,latest.availability
		FROM lines l
		JOIN organizations o ON o.id=l.organization_id
		LEFT JOIN providers p ON p.id=l.provider_id
		LEFT JOIN line_states ls ON ls.line_id=l.id
		LEFT JOIN LATERAL (
			SELECT id,client_event_id,observed_at,device_id,mode,connection_status,download,upload,ping,jitter,packet_loss,availability
			FROM measurements WHERE line_id=l.id ORDER BY observed_at DESC,id DESC LIMIT 1
		) latest ON TRUE
		WHERE `+strings.Join(filters, " AND ")+` ORDER BY o.district,o.name,l.role`, params...)
	if err != nil {
		writeError(w, 500, "could not query lines")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var line lineRecord
		var providerID, providerName, supportContact *string
		var dataState, connectionState, contractState, recoveryState, reason *string
		var effectiveSince, updatedAt *time.Time
		var evidence []byte
		var policyID *int64
		var latestID *int64
		var latestClientEventID, latestDeviceID, latestMode, latestConnectionStatus *string
		var latestObservedAt *time.Time
		var latestDownload, latestUpload, latestPing, latestJitter, latestPacketLoss, latestAvailability *float64
		if err := rows.Scan(&line.ID, &line.OrganizationID, &providerID, &line.Role, &line.Technology, &line.Status, &line.SchoolID, &line.OrganizationName, &line.District, &line.Address, &line.ContactName, &line.ContactPhone, &line.Latitude, &line.Longitude, &providerName, &supportContact, &dataState, &connectionState, &contractState, &recoveryState, &reason, &effectiveSince, &updatedAt, &evidence, &policyID, &latestID, &latestClientEventID, &latestObservedAt, &latestDeviceID, &latestMode, &latestConnectionStatus, &latestDownload, &latestUpload, &latestPing, &latestJitter, &latestPacketLoss, &latestAvailability); err != nil {
			writeError(w, 500, "could not read line")
			return
		}
		line.ProviderID = stringValue(providerID)
		line.ProviderName = stringValue(providerName)
		line.SupportContact = stringValue(supportContact)
		line.State = &stateRecord{DataState: "NO_DATA", ConnectionState: "UNKNOWN", ContractState: "UNKNOWN", RecoveryState: "NONE", Reason: "No observations yet", Evidence: []int64{}}
		if dataState != nil {
			line.State.DataState = *dataState
			line.State.ConnectionState = stringValue(connectionState)
			line.State.ContractState = stringValue(contractState)
			line.State.RecoveryState = stringValue(recoveryState)
			line.State.Reason = stringValue(reason)
			line.State.EffectiveSince = effectiveSince
			line.State.UpdatedAt = updatedAt
			line.State.PolicyID = policyID
			if err := jsonUnmarshal(evidence, &line.State.Evidence); err != nil {
				writeError(w, 500, "could not decode line state evidence")
				return
			}
		}
		if latestID != nil && latestObservedAt != nil && latestClientEventID != nil && latestDeviceID != nil && latestMode != nil && latestConnectionStatus != nil {
			line.Latest = &latestRecord{ID: *latestID, ClientEventID: *latestClientEventID, ObservedAt: *latestObservedAt, DeviceID: *latestDeviceID, Mode: *latestMode, ConnectionStatus: *latestConnectionStatus, Download: latestDownload, Upload: latestUpload, Ping: latestPing, Jitter: latestJitter, PacketLoss: latestPacketLoss, Availability: latestAvailability}
		}
		line.LatestLoaded = true
		mapped, mapErr := s.lineMap(r.Context(), line)
		if mapErr != nil {
			writeError(w, 500, "could not load line state")
			return
		}
		result = append(result, mapped)
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read lines")
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) lineRoute(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, 404, "line not found")
		return
	}
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	line, visible, lineErr := s.lineVisible(r.Context(), p, parts[0])
	if lineErr != nil {
		writeError(w, 500, "could not query line")
		return
	}
	if !visible {
		writeError(w, 404, "line not found")
		return
	}
	if len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "context" {
		s.lineContext(w, r, line)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		result, err := s.lineDetailMap(r.Context(), line)
		if err != nil {
			writeError(w, 500, "could not load line state")
			return
		}
		writeJSON(w, 200, result)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "measurements" {
		s.lineMeasurements(w, r, line.ID)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "states" {
		s.lineStates(w, r, line.ID)
		return
	}
	writeError(w, 404, "not found")
}

type measurementRecord struct {
	ID                                                                        int64
	DeviceID, LineID, PointID, ClientEventID, Mode, ConnectionStatus, Quality string
	ObservedAt, ReceivedAt                                                    time.Time
	Download, Upload, Ping, Jitter, PacketLoss, Availability                  *float64
	Raw, Violations, PolicySnapshot, ContractSnapshot, LineContextSnapshot    []byte
	BaselineState, ContractState, Reason                                      string
	Valid                                                                     bool
	VerificationStatus, VerificationReason                                    string
	CandidateSnapshot, VerifyingSnapshot                                      []byte
	VerifyingMeasurementID                                                    *int64
	VerificationVerifiedAt                                                    *time.Time
}

func scanMeasurement(scanner interface{ Scan(...interface{}) error }) (measurementRecord, error) {
	var item measurementRecord
	err := scanner.Scan(&item.ID, &item.DeviceID, &item.LineID, &item.PointID, &item.ClientEventID, &item.ObservedAt, &item.ReceivedAt, &item.Mode, &item.Download, &item.Upload, &item.Ping, &item.Jitter, &item.PacketLoss, &item.Availability, &item.ConnectionStatus, &item.Raw, &item.Quality, &item.BaselineState, &item.ContractState, &item.Violations, &item.Valid, &item.Reason, &item.PolicySnapshot, &item.ContractSnapshot, &item.LineContextSnapshot, &item.VerificationStatus, &item.VerificationReason, &item.CandidateSnapshot, &item.VerifyingMeasurementID, &item.VerifyingSnapshot, &item.VerificationVerifiedAt)
	return item, err
}

func measurementMap(item measurementRecord) map[string]interface{} {
	return map[string]interface{}{"id": item.ID, "device_id": item.DeviceID, "line_id": item.LineID, "monitoring_point_id": item.PointID, "client_event_id": item.ClientEventID, "observed_at": item.ObservedAt, "received_at": item.ReceivedAt, "mode": item.Mode, "download": item.Download, "upload": item.Upload, "ping": item.Ping, "jitter": item.Jitter, "packet_loss": item.PacketLoss, "loss": item.PacketLoss, "availability": item.Availability, "connection_status": item.ConnectionStatus, "quality": item.Quality, "raw": decodeJSONBytes(item.Raw), "baseline_state": item.BaselineState, "contract_state": item.ContractState, "violations": decodeJSONBytes(item.Violations), "valid": item.Valid, "reason": item.Reason, "policy_snapshot": decodeJSONBytes(item.PolicySnapshot), "contract_snapshot": decodeJSONBytes(item.ContractSnapshot), "line_context_snapshot": decodeJSONBytes(item.LineContextSnapshot), "verification_status": item.VerificationStatus, "evidence_chain": evidenceChain(item)}
}

func (s *Server) lineDetailMap(ctx context.Context, line lineRecord) (map[string]interface{}, error) {
	result, err := s.lineMap(ctx, line)
	if err != nil {
		return nil, err
	}
	var policy map[string]interface{}
	var policyID, version int
	var scopeType, scopeID string
	var validFrom time.Time
	var validTo *time.Time
	var d, u, ping, jit, loss, av float64
	var cc, cm, rc, rm, fs int
	var duration *int
	policyErr := s.DB.Pool.QueryRow(ctx, `SELECT id,scope_type,COALESCE(scope_id,''),version,valid_from,valid_to,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,confirm_duration_minutes,recovery_count,recovery_minutes,freshness_seconds FROM threshold_policy_versions WHERE (scope_type='LINE' AND scope_id=$1 OR scope_type='GLOBAL') AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY CASE WHEN scope_type='LINE' THEN 0 ELSE 1 END,valid_from DESC LIMIT 1`, line.ID).Scan(&policyID, &scopeType, &scopeID, &version, &validFrom, &validTo, &d, &u, &ping, &jit, &loss, &av, &cc, &cm, &duration, &rc, &rm, &fs)
	if policyErr == nil {
		policy = map[string]interface{}{"id": policyID, "scope_type": scopeType, "scope_id": scopeID, "version": version, "valid_from": validFrom, "valid_to": validTo, "download_min": d, "upload_min": u, "ping_max": ping, "jitter_max": jit, "packet_loss_max": loss, "availability_min": av, "confirm_count": cc, "confirm_minutes": cm, "confirm_duration_minutes": duration, "recovery_count": rc, "recovery_minutes": rm, "freshness_seconds": fs}
	} else if !errors.Is(policyErr, pgx.ErrNoRows) {
		return nil, policyErr
	}
	var contract map[string]interface{}
	var cid int64
	var cfrom time.Time
	var cto *time.Time
	var cno *string
	var cd, cu, cp, cj, cl, ca *float64
	contractErr := s.DB.Pool.QueryRow(ctx, `SELECT id,valid_from,valid_to,contract_no,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min FROM contract_versions WHERE line_id=$1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from DESC LIMIT 1`, line.ID).Scan(&cid, &cfrom, &cto, &cno, &cd, &cu, &cp, &cj, &cl, &ca)
	if contractErr == nil {
		contract = map[string]interface{}{"id": cid, "line_id": line.ID, "valid_from": cfrom, "valid_to": cto, "contract_no": cno, "download_min": cd, "upload_min": cu, "ping_max": cp, "jitter_max": cj, "packet_loss_max": cl, "availability_min": ca}
	} else if !errors.Is(contractErr, pgx.ErrNoRows) {
		return nil, contractErr
	}
	result["policy"] = policy
	result["contract"] = contract
	contracts := []map[string]interface{}{}
	contractRows, contractErr := s.DB.Pool.Query(ctx, `SELECT id,line_id,valid_from,valid_to,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at FROM contract_versions WHERE line_id=$1 ORDER BY valid_from DESC`, line.ID)
	if contractErr != nil {
		return nil, contractErr
	}
	for contractRows.Next() {
		var id int64
		var lineID string
		var from, createdAt time.Time
		var to, contractDate *time.Time
		var number, createdBy *string
		var download, upload, maxPing, maxJitter, maxLoss, minAvailability *float64
		if err := contractRows.Scan(&id, &lineID, &from, &to, &number, &contractDate, &download, &upload, &maxPing, &maxJitter, &maxLoss, &minAvailability, &createdBy, &createdAt); err != nil {
			contractRows.Close()
			return nil, err
		}
		contracts = append(contracts, map[string]interface{}{"id": id, "line_id": lineID, "valid_from": from, "valid_to": to, "contract_no": number, "contract_date": contractDate, "download_min": download, "upload_min": upload, "ping_max": maxPing, "jitter_max": maxJitter, "packet_loss_max": maxLoss, "availability_min": minAvailability, "created_by": createdBy, "created_at": createdAt})
	}
	if err := contractRows.Err(); err != nil {
		contractRows.Close()
		return nil, err
	}
	contractRows.Close()
	result["contracts"] = contracts
	var primaryDeviceID, primaryAgentVersion string
	var primaryHostname *string
	var primaryLastSeen *time.Time
	deviceErr := s.DB.Pool.QueryRow(ctx, `SELECT d.id,d.hostname,d.agent_version,d.last_seen FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id WHERE mp.line_id=$1 ORDER BY mp.is_primary DESC,d.id LIMIT 1`, line.ID).Scan(&primaryDeviceID, &primaryHostname, &primaryAgentVersion, &primaryLastSeen)
	if deviceErr == nil {
		result["device_id"] = primaryDeviceID
		result["hostname"] = primaryHostname
		result["agent_version"] = primaryAgentVersion
		result["last_seen"] = primaryLastSeen
	} else if errors.Is(deviceErr, pgx.ErrNoRows) {
		result["device_id"] = nil
		result["hostname"] = nil
		result["agent_version"] = nil
		result["last_seen"] = nil
	} else {
		return nil, deviceErr
	}
	rows, err := s.DB.Pool.Query(ctx, `SELECT m.id,m.device_id,m.line_id,m.monitoring_point_id,m.client_event_id,m.observed_at,m.received_at,m.mode,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,m.connection_status,m.raw_json,m.quality,e.baseline_state,e.contract_state,e.violations_json,e.valid,e.reason,e.policy_snapshot_json,e.contract_snapshot_json,e.line_context_snapshot_json,COALESCE(v.status,''),COALESCE(v.reason,''),v.candidate_snapshot_json,v.verifying_measurement_id,v.verifying_snapshot_json,v.verified_at FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id LEFT JOIN measurement_verifications v ON v.candidate_measurement_id=m.id WHERE m.line_id=$1 ORDER BY m.observed_at DESC,m.id DESC LIMIT 50`, line.ID)
	if err != nil {
		return nil, err
	}
	items := []map[string]interface{}{}
	records := []measurementRecord{}
	for rows.Next() {
		item, scanErr := scanMeasurement(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		items = append(items, measurementMap(item))
		records = append(records, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	result["measurements"] = items
	stateForEvidence, stateErr := s.state(ctx, line.ID)
	if stateErr != nil {
		return nil, stateErr
	}
	selected := records
	if len(stateForEvidence.Evidence) > 0 {
		wanted := map[int64]bool{}
		for _, id := range stateForEvidence.Evidence {
			wanted[id] = true
		}
		selected = []measurementRecord{}
		for _, record := range records {
			if wanted[record.ID] {
				selected = append(selected, record)
			}
		}
	}
	result["evidence_chain"] = evidenceChainForRecords(selected)
	currentContext := map[string]interface{}{}
	if resolved, contextErr := measurements.ResolveContext(ctx, s.DB.Pool, line.ID, time.Now().UTC()); contextErr == nil {
		currentContext = contextMap(resolved)
	}
	result["configuration_governance"] = map[string]interface{}{
		"historical": result["evidence_chain"],
		"current_operational": map[string]interface{}{
			"source":    "current operational configuration tables",
			"policy":    policy,
			"contract":  contract,
			"context":   currentContext,
			"hierarchy": configurationHierarchy(snapshotMap(policy), snapshotMap(contract), currentContext, false),
			"warning":   "current values are not used to explain historical evidence",
		},
	}
	monitoring, err := s.monitoringPoints(ctx, line.ID)
	if err != nil {
		return nil, err
	}
	result["monitoring_points"] = monitoring
	incidents, err := s.incidentListForLine(ctx, line.ID)
	if err != nil {
		return nil, err
	}
	result["incidents"] = incidents
	return result, nil
}

func (s *Server) monitoringPoints(ctx context.Context, lineID string) ([]map[string]interface{}, error) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT id,line_id,location,is_primary,active,created_at FROM monitoring_points WHERE line_id=$1 ORDER BY is_primary DESC,id`, lineID)
	if err != nil {
		return nil, err
	}
	points := []struct {
		id, lineID, location string
		primary, active      bool
		created              time.Time
	}{}
	for rows.Next() {
		var id, pointLineID, location string
		var primary, active bool
		var created time.Time
		if err := rows.Scan(&id, &pointLineID, &location, &primary, &active, &created); err != nil {
			rows.Close()
			return nil, err
		}
		points = append(points, struct {
			id, lineID, location string
			primary, active      bool
			created              time.Time
		}{id: id, lineID: pointLineID, location: location, primary: primary, active: active, created: created})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	result := []map[string]interface{}{}
	for _, point := range points {
		devices := []map[string]interface{}{}
		drows, e := s.DB.Pool.Query(ctx, `SELECT id,hostname,display_name,agent_version,last_seen,blocked_at,created_at FROM devices WHERE monitoring_point_id=$1 ORDER BY id`, point.id)
		if e != nil {
			return nil, e
		}
		for drows.Next() {
			var did, ver string
			var hostname, displayName *string
			var seen, blocked *time.Time
			var dc time.Time
			if err := drows.Scan(&did, &hostname, &displayName, &ver, &seen, &blocked, &dc); err != nil {
				drows.Close()
				return nil, err
			}
			devices = append(devices, map[string]interface{}{"id": did, "hostname": hostname, "display_name": displayName, "agent_version": ver, "last_seen": seen, "blocked_at": blocked, "created_at": dc})
		}
		if err := drows.Err(); err != nil {
			drows.Close()
			return nil, err
		}
		drows.Close()
		result = append(result, map[string]interface{}{"id": point.id, "line_id": point.lineID, "location": point.location, "is_primary": point.primary, "active": point.active, "created_at": point.created, "devices": devices})
	}
	return result, nil
}

func (s *Server) lineMeasurements(w http.ResponseWriter, r *http.Request, lineID string) {
	start, end := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	where := []string{"m.line_id=$1"}
	params := []interface{}{lineID}
	if mode := strings.TrimSpace(r.URL.Query().Get("mode")); mode != "" {
		params = append(params, mode)
		where = append(where, "m.mode=$"+itoa(len(params)))
	}
	if start != "" {
		value, e := parseTime(start, time.Now())
		if e != nil {
			writeError(w, 422, "invalid from")
			return
		}
		params = append(params, value)
		where = append(where, "m.observed_at >= $"+itoa(len(params)))
	}
	if end != "" {
		value, e := parseTime(end, time.Now())
		if e != nil {
			writeError(w, 422, "invalid to")
			return
		}
		params = append(params, value)
		where = append(where, "m.observed_at < $"+itoa(len(params)))
	}
	limit, offset, paginated := 50, 0, r.URL.Query().Has("limit") || r.URL.Query().Has("offset")
	if value := r.URL.Query().Get("limit"); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		} else {
			writeError(w, 422, "limit must be 1-200")
			return
		}
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil && parsed >= 0 {
			offset = parsed
		} else {
			writeError(w, 422, "offset must be non-negative")
			return
		}
	}
	params = append(params, limit+1, offset)
	query := `SELECT m.id,m.device_id,m.line_id,m.monitoring_point_id,m.client_event_id,m.observed_at,m.received_at,m.mode,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,m.connection_status,m.raw_json,m.quality,e.baseline_state,e.contract_state,e.violations_json,e.valid,e.reason,e.policy_snapshot_json,e.contract_snapshot_json,e.line_context_snapshot_json,COALESCE(v.status,''),COALESCE(v.reason,''),v.candidate_snapshot_json,v.verifying_measurement_id,v.verifying_snapshot_json,v.verified_at FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id LEFT JOIN measurement_verifications v ON v.candidate_measurement_id=m.id WHERE ` + strings.Join(where, " AND ") + ` ORDER BY m.observed_at DESC,m.id DESC LIMIT $` + itoa(len(params)-1) + ` OFFSET $` + itoa(len(params))
	rows, err := s.DB.Pool.Query(r.Context(), query, params...)
	if err != nil {
		writeError(w, 500, "could not query measurements")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		item, e := scanMeasurement(rows)
		if e != nil {
			writeError(w, 500, "could not read measurements")
			return
		}
		result = append(result, measurementMap(item))
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read measurements")
		return
	}
	hasMore := len(result) > limit
	if hasMore {
		result = result[:limit]
	}
	if paginated {
		writeJSON(w, 200, map[string]interface{}{"items": result, "offset": offset, "limit": limit, "has_more": hasMore, "next_offset": func() interface{} {
			if hasMore {
				return offset + limit
			}
			return nil
		}()})
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) lineStates(w http.ResponseWriter, r *http.Request, lineID string) {
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT previous_data_state,previous_connection_state,previous_contract_state,data_state,connection_state,contract_state,recovery_state,reason,effective_since,updated_at,evidence_ids_json,config_snapshot_json,occurred_at FROM line_state_events WHERE line_id=$1 ORDER BY occurred_at DESC,id DESC`, lineID)
	if err != nil {
		writeError(w, 500, "could not query states")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var previousData, previousConnection, previousContract *string
		var data, connection, contract, recovery, reason string
		var effective, updated, occurred *time.Time
		var evidence, configSnapshot []byte
		if err := rows.Scan(&previousData, &previousConnection, &previousContract, &data, &connection, &contract, &recovery, &reason, &effective, &updated, &evidence, &configSnapshot, &occurred); err != nil {
			writeError(w, 500, "could not read states")
			return
		}
		var ids []int64
		if err := jsonUnmarshal(evidence, &ids); err != nil {
			writeError(w, 500, "could not decode state evidence")
			return
		}
		result = append(result, map[string]interface{}{"previous_data_state": previousData, "previous_connection_state": previousConnection, "previous_contract_state": previousContract, "data_state": data, "connection_state": connection, "contract_state": contract, "recovery_state": recovery, "reason": reason, "effective_since": effective, "updated_at": updated, "occurred_at": occurred, "evidence_ids": ids, "config_snapshot": decodeJSONBytes(configSnapshot)})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read states")
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) deviceDetail(w http.ResponseWriter, r *http.Request, deviceID string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var lineID, orgID, school, name, district, pointID, location, agent, role, technology, lineStatus, address, contactName, contactPhone string
	var hostname, displayName *string
	var providerID, providerName *string
	var blocked, lastSeen, created *time.Time
	var primary, active bool
	err := s.DB.Pool.QueryRow(r.Context(), `SELECT mp.line_id,l.organization_id,o.school_id,o.name,o.district,l.provider_id,p.name,mp.id,mp.location,d.hostname,d.display_name,d.agent_version,d.blocked_at,d.last_seen,d.created_at,mp.is_primary,mp.active,l.role,l.technology,l.status,o.address,o.contact_name,o.contact_phone FROM devices d JOIN monitoring_points mp ON mp.id=d.monitoring_point_id JOIN lines l ON l.id=mp.line_id JOIN organizations o ON o.id=l.organization_id LEFT JOIN providers p ON p.id=l.provider_id WHERE d.id=$1`, deviceID).Scan(&lineID, &orgID, &school, &name, &district, &providerID, &providerName, &pointID, &location, &hostname, &displayName, &agent, &blocked, &lastSeen, &created, &primary, &active, &role, &technology, &lineStatus, &address, &contactName, &contactPhone)
	if err != nil || !auth.HasLineScope(p, lineID, orgID, district, stringValue(providerID)) {
		writeError(w, 404, "device not found")
		return
	}
	items := []map[string]interface{}{}
	deviceLimit, deviceOffset := 100, 0
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, parseErr := strconv.Atoi(value)
		if parseErr != nil || parsed < 1 || parsed > 200 {
			writeError(w, 422, "limit must be 1-200")
			return
		}
		deviceLimit = parsed
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		parsed, parseErr := strconv.Atoi(value)
		if parseErr != nil || parsed < 0 {
			writeError(w, 422, "offset must be non-negative")
			return
		}
		deviceOffset = parsed
	}
	rows, rowsErr := s.DB.Pool.Query(r.Context(), `SELECT m.id,m.device_id,m.line_id,m.monitoring_point_id,m.client_event_id,m.observed_at,m.received_at,m.mode,m.download,m.upload,m.ping,m.jitter,m.packet_loss,m.availability,m.connection_status,m.raw_json,m.quality,e.baseline_state,e.contract_state,e.violations_json,e.valid,e.reason,e.policy_snapshot_json,e.contract_snapshot_json,e.line_context_snapshot_json,COALESCE(v.status,''),COALESCE(v.reason,''),v.candidate_snapshot_json,v.verifying_measurement_id,v.verifying_snapshot_json,v.verified_at FROM measurements m JOIN measurement_evaluations e ON e.measurement_id=m.id LEFT JOIN measurement_verifications v ON v.candidate_measurement_id=m.id WHERE m.device_id=$1 ORDER BY m.observed_at DESC,m.id DESC LIMIT $2 OFFSET $3`, deviceID, deviceLimit+1, deviceOffset)
	if rowsErr == nil {
		for rows.Next() {
			if measurement, scanErr := scanMeasurement(rows); scanErr == nil {
				items = append(items, measurementMap(measurement))
			}
		}
		rows.Close()
	}
	hasMore := len(items) > deviceLimit
	if hasMore {
		items = items[:deviceLimit]
	}
	lineState, stateErr := s.state(r.Context(), lineID)
	if stateErr != nil {
		writeError(w, 500, "could not load line state")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"id": deviceID, "hostname": hostname, "display_name": displayName, "line_id": lineID, "organization_id": orgID, "school_id": school, "organization_name": name, "district": district, "address": address, "contact_name": contactName, "contact_phone": contactPhone, "provider_id": providerID, "provider_name": providerName, "role": role, "technology": technology, "line_status": lineStatus, "monitoring_point_id": pointID, "monitoring_point_location": location, "agent_version": agent, "blocked": blocked != nil, "blocked_at": blocked, "last_seen": lastSeen, "created_at": created, "monitoring_point_primary": primary, "monitoring_point_active": active, "state": stateMap(lineState), "measurements": items, "history": map[string]interface{}{"offset": deviceOffset, "limit": deviceLimit, "has_more": hasMore, "next_offset": func() interface{} {
		if hasMore {
			return deviceOffset + deviceLimit
		}
		return nil
	}()}})
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func jsonUnmarshal(raw []byte, target interface{}) error { return json.Unmarshal(raw, target) }
