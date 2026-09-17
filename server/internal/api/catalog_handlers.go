package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	var linesCount, schoolsCount, devicesCount, activeDevices int
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT COUNT(*),COUNT(DISTINCT l.organization_id),COUNT(d.id),COUNT(d.id) FILTER (WHERE d.last_seen IS NOT NULL AND d.last_seen >= now() - INTERVAL '24 hours') FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN monitoring_points mp ON mp.line_id=l.id LEFT JOIN devices d ON d.monitoring_point_id=mp.id WHERE l.status <> 'DELETED' AND `+where, params...).Scan(&linesCount, &schoolsCount, &devicesCount, &activeDevices); err != nil {
		writeError(w, 500, "could not calculate overview")
		return
	}
	var fresh int
	since := time.Now().UTC().Add(-24 * time.Hour)
	whereWithSince, paramsWithSince := scopeSQL(p, 2)
	freshArgs := append([]interface{}{since}, paramsWithSince...)
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM measurements m JOIN lines l ON l.id=m.line_id JOIN organizations o ON o.id=l.organization_id WHERE m.observed_at >= $1 AND `+whereWithSince, freshArgs...).Scan(&fresh); err != nil {
		writeError(w, 500, "could not calculate fresh measurements")
		return
	}
	var problemLines int
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM lines l JOIN organizations o ON o.id=l.organization_id LEFT JOIN line_states ls ON ls.line_id=l.id WHERE l.status <> 'DELETED' AND `+where+` AND (ls.connection_state IN ('DEGRADED','NO_INTERNET') OR ls.contract_state='DEVIATES')`, params...).Scan(&problemLines); err != nil {
		writeError(w, 500, "could not calculate problem lines")
		return
	}
	var avgDownload, avgUpload, avgPing *float64
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT AVG(m.download),AVG(m.upload),AVG(m.ping) FROM measurements m JOIN lines l ON l.id=m.line_id JOIN organizations o ON o.id=l.organization_id WHERE m.observed_at >= $1 AND `+whereWithSince, freshArgs...).Scan(&avgDownload, &avgUpload, &avgPing); err != nil {
		writeError(w, 500, "could not calculate overview averages")
		return
	}
	complete := 0.0
	var tests int
	if err := s.DB.Pool.QueryRow(r.Context(), `SELECT tests_per_day FROM agent_schedules WHERE id=1`).Scan(&tests); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 500, "could not load agent schedule")
		return
	} else if errors.Is(err, pgx.ErrNoRows) {
		tests = 4
	}
	if linesCount > 0 {
		complete = float64(fresh) / float64(linesCount*tests) * 100
		if complete > 100 {
			complete = 100
		}
	}
	writeJSON(w, 200, map[string]interface{}{"counts": map[string]interface{}{"schools": schoolsCount, "lines": linesCount, "devices": devicesCount, "active_devices": activeDevices, "fresh_measurements": fresh, "problem_lines": problemLines}, "schools": schoolsCount, "lines": linesCount, "active_devices": activeDevices, "problem_lines": problemLines, "averages": map[string]interface{}{"download": avgDownload, "upload": avgUpload, "ping": avgPing}, "completeness": complete, "data_completeness": complete})
}

func (s *Server) mapPoints(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT l.id,l.organization_id,l.provider_id,l.role,l.technology,l.status,o.school_id,o.name,o.district,o.address,o.contact_name,o.contact_phone,o.latitude,o.longitude,p.name,p.support_contact,
		COALESCE(ls.data_state,'NO_DATA'),COALESCE(ls.connection_state,'UNKNOWN'),COALESCE(ls.contract_state,'UNKNOWN'),COALESCE(ls.recovery_state,'NONE'),COALESCE(ls.reason,'No observations yet'),ls.effective_since,ls.updated_at,ls.evidence_ids_json,ls.policy_id
		FROM lines l
		JOIN organizations o ON o.id=l.organization_id
		LEFT JOIN providers p ON p.id=l.provider_id
		LEFT JOIN line_states ls ON ls.line_id=l.id
		WHERE l.status <> 'DELETED' AND `+where, params...)
	if err != nil {
		writeError(w, 500, "could not query map")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var line lineRecord
		var providerID, providerName, supportContact *string
		var dataState, connectionState, contractState, recoveryState, reason string
		var effectiveSince, updatedAt *time.Time
		var evidence []byte
		var policyID *int64
		if err := rows.Scan(&line.ID, &line.OrganizationID, &providerID, &line.Role, &line.Technology, &line.Status, &line.SchoolID, &line.OrganizationName, &line.District, &line.Address, &line.ContactName, &line.ContactPhone, &line.Latitude, &line.Longitude, &providerName, &supportContact, &dataState, &connectionState, &contractState, &recoveryState, &reason, &effectiveSince, &updatedAt, &evidence, &policyID); err != nil {
			writeError(w, 500, "could not read map")
			return
		}
		line.ProviderID = stringValue(providerID)
		line.ProviderName = stringValue(providerName)
		line.SupportContact = stringValue(supportContact)
		line.State = &stateRecord{DataState: dataState, ConnectionState: connectionState, ContractState: contractState, RecoveryState: recoveryState, Reason: reason, EffectiveSince: effectiveSince, UpdatedAt: updatedAt, Evidence: []int64{}, PolicyID: policyID}
		if len(evidence) > 0 {
			if err := jsonUnmarshal(evidence, &line.State.Evidence); err != nil {
				writeError(w, 500, "could not decode map evidence")
				return
			}
		}
		result = append(result, map[string]interface{}{"line_id": line.ID, "school_id": line.SchoolID, "organization_name": line.OrganizationName, "district": line.District, "latitude": line.Latitude, "longitude": line.Longitude, "provider_id": line.ProviderID, "provider_name": line.ProviderName, "role": line.Role, "technology": line.Technology, "state": stateMap(*line.State)})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read map")
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) listOrganizations(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT DISTINCT o.id,o.school_id,o.name,o.district,o.address,o.latitude,o.longitude,o.contact_name,o.contact_phone,o.active,o.created_at FROM organizations o JOIN lines l ON l.organization_id=o.id WHERE l.status <> 'DELETED' AND `+where+` ORDER BY o.district,o.name`, params...)
	if err != nil {
		writeError(w, 500, "could not query organizations")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id, school, name, district, address, contact, phone string
		var lat, lon *float64
		var active bool
		var created time.Time
		if err := rows.Scan(&id, &school, &name, &district, &address, &lat, &lon, &contact, &phone, &active, &created); err != nil {
			writeError(w, 500, "could not read organizations")
			return
		}
		result = append(result, map[string]interface{}{"id": id, "school_id": school, "name": name, "district": district, "address": address, "latitude": lat, "longitude": lon, "contact_name": contact, "contact_phone": phone, "active": active, "created_at": created})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read organizations")
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	where, params := scopeSQL(p, 1)
	rows, err := s.DB.Pool.Query(r.Context(), `SELECT DISTINCT p.id,p.name,p.support_contact,p.active,p.created_at FROM providers p JOIN lines l ON l.provider_id=p.id JOIN organizations o ON o.id=l.organization_id WHERE l.status <> 'DELETED' AND `+where+` ORDER BY p.name`, params...)
	if err != nil {
		writeError(w, 500, "could not query providers")
		return
	}
	defer rows.Close()
	result := []map[string]interface{}{}
	for rows.Next() {
		var id, name, contact string
		var active bool
		var created time.Time
		if err := rows.Scan(&id, &name, &contact, &active, &created); err != nil {
			writeError(w, 500, "could not read providers")
			return
		}
		result = append(result, map[string]interface{}{"id": id, "name": name, "support_contact": contact, "active": active, "created_at": created})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "could not read providers")
		return
	}
	writeJSON(w, 200, result)
}

var _ = errors.Is
var _ = pgx.ErrNoRows
