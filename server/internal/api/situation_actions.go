package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
)

type situationActionRequest struct {
	SituationIDs      []int64    `json:"situation_ids"`
	IncidentIDs       []int64    `json:"incident_ids"`
	ExpectedUpdatedAt *time.Time `json:"expected_updated_at"`
	Reason            string     `json:"reason"`
	AnchorSituationID int64      `json:"-"`
}

type situationActionResult struct {
	ID         int64
	Status     string
	Action     string
	CreatedIDs []int64
	Superseded []int64
}

func (s *Server) situationRoute(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusNotFound, "situation not found")
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		s.situationDetail(w, r, parts[0])
		return
	}
	if len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "live-verify" {
		s.issueLiveVerify(w, r, parts[0])
		return
	}
	if len(parts) == 2 && r.Method == http.MethodPost && (parts[1] == "merge" || parts[1] == "split") {
		s.situationAction(w, r, id, strings.ToLower(parts[1]))
		return
	}
	writeError(w, http.StatusNotFound, "situation action not found")
}

func situationManageAllowed(p *auth.Principal) bool {
	for _, capability := range auth.EffectiveCapabilities(p) {
		if capability == "situation.manage" {
			return true
		}
	}
	return false
}

func actionKey(r *http.Request) (string, error) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = strings.TrimSpace(r.Header.Get("X-Request-ID"))
	}
	if len(key) < 1 || len(key) > 128 {
		return "", fmt.Errorf("Idempotency-Key is required and must be 1-128 characters")
	}
	return key, nil
}

func uniquePositive(values []int64) ([]int64, error) {
	seen := map[int64]bool{}
	result := []int64{}
	for _, value := range values {
		if value < 1 {
			return nil, fmt.Errorf("ids must be positive")
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result, nil
}

func partitionSituationMembers(members, selected []int64) ([]int64, []int64, error) {
	selectedIDs, err := uniquePositive(selected)
	if err != nil {
		return nil, nil, err
	}
	allowed := map[int64]bool{}
	for _, id := range members {
		allowed[id] = true
	}
	left, right := []int64{}, []int64{}
	for _, id := range members {
		if containsInt64(selectedIDs, id) {
			left = append(left, id)
		} else {
			right = append(right, id)
		}
	}
	for _, id := range selectedIDs {
		if !allowed[id] {
			return nil, nil, fmt.Errorf("incident is not a situation member")
		}
	}
	if len(left) == 0 || len(right) == 0 {
		return nil, nil, fmt.Errorf("split requires selected members and remaining members")
	}
	return left, right, nil
}

func containsInt64(values []int64, target int64) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (s *Server) situationAction(w http.ResponseWriter, r *http.Request, situationID int64, action string) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if !situationManageAllowed(p) {
		writeError(w, http.StatusForbidden, "situation management capability required")
		return
	}
	var request situationActionRequest
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid situation action payload")
		return
	}
	key, err := actionKey(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	request.Reason = strings.TrimSpace(request.Reason)
	request.AnchorSituationID = situationID
	if request.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "reason is required")
		return
	}
	if action == "merge" {
		if len(request.SituationIDs) == 0 {
			request.SituationIDs = []int64{situationID}
		}
		request.SituationIDs = append(request.SituationIDs, situationID)
		request.SituationIDs, err = uniquePositive(request.SituationIDs)
	} else {
		request.SituationIDs = []int64{situationID}
		request.IncidentIDs, err = uniquePositive(request.IncidentIDs)
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "could not begin situation action")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(742034)`); err != nil {
		writeError(w, 500, "could not lock situation actions")
		return
	}
	if replay, replayErr := replaySituationAction(r.Context(), tx, key); replayErr != nil {
		writeError(w, 500, "could not check situation idempotency")
		return
	} else if replay != nil {
		writeJSON(w, http.StatusOK, replay)
		return
	}
	var result situationActionResult
	if action == "merge" {
		result, err = mergeSituations(r.Context(), tx, p, request, key)
	} else {
		result, err = splitSituation(r.Context(), tx, p, request, key)
	}
	if err != nil {
		status := http.StatusConflict
		if strings.Contains(err.Error(), "scope") {
			status = http.StatusForbidden
		} else if strings.Contains(err.Error(), "required") || strings.Contains(err.Error(), "member") {
			status = http.StatusUnprocessableEntity
		}
		writeError(w, status, err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "could not commit situation action")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func replaySituationAction(ctx context.Context, tx pgx.Tx, key string) (map[string]interface{}, error) {
	var payload []byte
	if err := tx.QueryRow(ctx, `SELECT payload_json FROM situation_events WHERE request_id=$1`, key).Scan(&payload); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, err
	}
	result["idempotent_replay"] = true
	return result, nil
}

type lockedSituation struct {
	ID                                                 int64
	Title, Status, ProviderID, District, ViolationType string
	StartAt, UpdatedAt                                 time.Time
	Members                                            []int64
}

func lockSituations(ctx context.Context, tx pgx.Tx, p *auth.Principal, ids []int64) (map[int64]*lockedSituation, error) {
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	result := map[int64]*lockedSituation{}
	for _, id := range ids {
		var item lockedSituation
		var provider, district, violation *string
		if err := tx.QueryRow(ctx, `SELECT id,title,status,provider_id,district,violation_type,start_at,updated_at FROM situations WHERE id=$1 FOR UPDATE`, id).Scan(&item.ID, &item.Title, &item.Status, &provider, &district, &violation, &item.StartAt, &item.UpdatedAt); err != nil {
			if err == pgx.ErrNoRows {
				return nil, fmt.Errorf("situation not found")
			}
			return nil, err
		}
		if provider != nil {
			item.ProviderID = *provider
		}
		if district != nil {
			item.District = *district
		}
		if violation != nil {
			item.ViolationType = *violation
		}
		rows, err := tx.Query(ctx, `SELECT i.id FROM situation_members sm JOIN incidents i ON i.id=sm.incident_id JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE sm.situation_id=$1 ORDER BY i.id`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var member int64
			if err := rows.Scan(&member); err != nil {
				rows.Close()
				return nil, err
			}
			item.Members = append(item.Members, member)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, member := range item.Members {
			var lineID, orgID, districtID, providerID string
			if err := tx.QueryRow(ctx, `SELECT i.line_id,l.organization_id,o.district,COALESCE(l.provider_id,'') FROM incidents i JOIN lines l ON l.id=i.line_id JOIN organizations o ON o.id=l.organization_id WHERE i.id=$1`, member).Scan(&lineID, &orgID, &districtID, &providerID); err != nil {
				return nil, err
			}
			if !auth.HasLineScope(p, lineID, orgID, districtID, providerID) {
				return nil, fmt.Errorf("scope does not include situation member")
			}
		}
		result[id] = &item
	}
	return result, nil
}

func createSituationProjection(ctx context.Context, tx pgx.Tx, base *lockedSituation, members []int64, reason string, action string, now time.Time) (int64, error) {
	payload := map[string]interface{}{"correlation_only": true, "manual_action": action, "reason": reason, "member_count": len(members), "historical_parent_id": base.ID}
	reasonJSON, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO situations(title,status,provider_id,district,violation_type,start_at,reason_json,created_at,updated_at) VALUES ($1,'OPEN',$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING id`, base.Title, nullableString(base.ProviderID), nullableString(base.District), nullableString(base.ViolationType), base.StartAt, string(reasonJSON), now).Scan(&id)
	if err != nil {
		return 0, err
	}
	for _, member := range members {
		if _, err := tx.Exec(ctx, `INSERT INTO situation_members(situation_id,incident_id) VALUES ($1,$2)`, id, member); err != nil {
			return 0, err
		}
	}
	return id, nil
}

func insertSituationEvent(ctx context.Context, tx pgx.Tx, situationID int64, action, actor, requestID string, payload map[string]interface{}, now time.Time) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO situation_events(situation_id,action,actor_id,request_id,payload_json,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`, situationID, action, actor, requestID, string(raw), now).Scan(&id)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_events(actor_type,actor_id,action,object_type,object_id,scope_type,scope_id,after_json,request_id,created_at) VALUES ('USER',$1,$2,'situation',$3,'SITUATION',$3,$4::jsonb,$5,$6)`, actor, "situation."+action, strconv.FormatInt(situationID, 10), string(raw), requestID, now); err != nil {
		return 0, err
	}
	return id, nil
}

func addSituationRelation(ctx context.Context, tx pgx.Tx, source, target, eventID int64, relation string, now time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO situation_relations(source_situation_id,target_situation_id,relation_type,event_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, source, target, relation, eventID, now)
	return err
}

func mergeSituations(ctx context.Context, tx pgx.Tx, p *auth.Principal, request situationActionRequest, key string) (situationActionResult, error) {
	locked, err := lockSituations(ctx, tx, p, request.SituationIDs)
	if err != nil {
		return situationActionResult{}, err
	}
	for _, item := range locked {
		if item.Status != "OPEN" {
			return situationActionResult{}, fmt.Errorf("stale conflict: situation is not OPEN")
		}
		if request.ExpectedUpdatedAt != nil && item.ID == request.AnchorSituationID && !item.UpdatedAt.Equal(request.ExpectedUpdatedAt.UTC()) {
			return situationActionResult{}, fmt.Errorf("stale conflict: situation changed")
		}
	}
	base := locked[request.AnchorSituationID]
	all := []int64{}
	for _, id := range request.SituationIDs {
		all = append(all, locked[id].Members...)
	}
	all, _ = uniquePositive(all)
	now := time.Now().UTC().Truncate(time.Second)
	created, err := createSituationProjection(ctx, tx, base, all, request.Reason, "MERGE", now)
	if err != nil {
		return situationActionResult{}, err
	}
	payload := map[string]interface{}{"action": "MERGE", "source_situation_ids": request.SituationIDs, "created_situation_ids": []int64{created}, "correlation_only": true, "reason": request.Reason}
	eventID, err := insertSituationEvent(ctx, tx, created, "merged", p.ID, key, payload, now)
	if err != nil {
		return situationActionResult{}, err
	}
	for _, id := range request.SituationIDs {
		if _, err := tx.Exec(ctx, `UPDATE situations SET status='SUPERSEDED',updated_at=$1 WHERE id=$2`, now, id); err != nil {
			return situationActionResult{}, err
		}
		if err := addSituationRelation(ctx, tx, id, created, eventID, "MERGED_INTO", now); err != nil {
			return situationActionResult{}, err
		}
	}
	return situationActionResult{ID: created, Status: "OPEN", Action: "MERGE", CreatedIDs: []int64{created}, Superseded: request.SituationIDs}, nil
}

func splitSituation(ctx context.Context, tx pgx.Tx, p *auth.Principal, request situationActionRequest, key string) (situationActionResult, error) {
	locked, err := lockSituations(ctx, tx, p, request.SituationIDs)
	if err != nil {
		return situationActionResult{}, err
	}
	base := locked[request.AnchorSituationID]
	if base.Status != "OPEN" {
		return situationActionResult{}, fmt.Errorf("stale conflict: situation is not OPEN")
	}
	if request.ExpectedUpdatedAt != nil && !base.UpdatedAt.Equal(request.ExpectedUpdatedAt.UTC()) {
		return situationActionResult{}, fmt.Errorf("stale conflict: situation changed")
	}
	left, right, partitionErr := partitionSituationMembers(base.Members, request.IncidentIDs)
	if partitionErr != nil {
		return situationActionResult{}, partitionErr
	}
	now := time.Now().UTC().Truncate(time.Second)
	createdIDs := []int64{}
	for _, members := range [][]int64{left, right} {
		id, createErr := createSituationProjection(ctx, tx, base, members, request.Reason, "SPLIT", now)
		if createErr != nil {
			return situationActionResult{}, createErr
		}
		createdIDs = append(createdIDs, id)
	}
	payload := map[string]interface{}{"action": "SPLIT", "source_situation_ids": []int64{base.ID}, "created_situation_ids": createdIDs, "selected_incident_ids": left, "correlation_only": true, "reason": request.Reason}
	eventID, err := insertSituationEvent(ctx, tx, base.ID, "split", p.ID, key, payload, now)
	if err != nil {
		return situationActionResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE situations SET status='SUPERSEDED',updated_at=$1 WHERE id=$2`, now, base.ID); err != nil {
		return situationActionResult{}, err
	}
	for _, id := range createdIDs {
		if err := addSituationRelation(ctx, tx, base.ID, id, eventID, "SPLIT_INTO", now); err != nil {
			return situationActionResult{}, err
		}
	}
	return situationActionResult{ID: base.ID, Status: "SUPERSEDED", Action: "SPLIT", CreatedIDs: createdIDs, Superseded: []int64{base.ID}}, nil
}
