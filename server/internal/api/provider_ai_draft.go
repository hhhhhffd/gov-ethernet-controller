package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"linkwatch/server/internal/auth"
)

type providerAIDraftPayload struct {
	Comment   string `json:"comment"`
	RequestID string `json:"request_id"`
}

func (s *Server) providerAIDraft(w http.ResponseWriter, r *http.Request, caseID, lineID string, p *auth.Principal) {
	if !requireRole(w, p, "provider_send") {
		return
	}
	var payload providerAIDraftPayload
	if r.Body != nil {
		if err := decodeJSON(r, &payload); err != nil {
			// An empty body is equivalent to an empty optional payload.
			if !errors.Is(err, io.EOF) {
				writeError(w, http.StatusUnprocessableEntity, "invalid provider AI draft payload")
				return
			}
		}
	}
	requestID := strings.TrimSpace(payload.RequestID)
	if requestID == "" {
		requestID = strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	}
	if len(requestID) > 128 {
		writeError(w, http.StatusUnprocessableEntity, "request_id must contain at most 128 characters")
		return
	}
	if requestID != "" {
		var status, draft string
		var generationID int64
		err := s.DB.Pool.QueryRow(r.Context(), `SELECT g.id,g.status,COALESCE(c.draft_text,'') FROM provider_case_draft_generations g JOIN provider_cases c ON c.id=g.provider_case_id WHERE g.provider_case_id=$1 AND g.request_id=$2 ORDER BY g.id DESC LIMIT 1`, caseID, requestID).Scan(&generationID, &status, &draft)
		if err == nil {
			if status == "SUCCEEDED" {
				writeJSON(w, http.StatusOK, map[string]interface{}{"id": caseID, "provider_case_id": caseID, "generation_id": generationID, "status": "DRAFT", "draft_text": draft, "deduplicated": true})
				return
			}
			writeError(w, http.StatusBadGateway, "this generation request already failed; use a new request_id")
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "could not read previous AI draft generation")
			return
		}
	}

	item, err := s.loadProviderCaseDraftContext(r.Context(), caseID, lineID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "provider case not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read provider case")
		return
	}
	if item.Status == "SENT" {
		writeError(w, http.StatusConflict, "sent provider case cannot regenerate a draft")
		return
	}
	input, err := s.providerDraftInput(r.Context(), item.Incident, payload.Comment)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not build provider evidence")
		return
	}
	generator := s.DraftGenerator
	if generator == nil {
		generator = newOllamaDraftGeneratorFromEnv()
	}
	metadata := DraftGenerationMetadata{Provider: "unknown", Model: "unknown", PromptVersion: providerDraftPromptVersion}
	if typed, ok := generator.(interface {
		Metadata() DraftGenerationMetadata
	}); ok {
		metadata = typed.Metadata()
	}
	digest := providerEvidenceDigest(input)
	started := time.Now()
	draft, generationErr := generator.Generate(r.Context(), input)
	latency := int(time.Since(started).Milliseconds())
	if generationErr != nil {
		generationID, persistErr := s.persistDraftGeneration(r.Context(), caseID, p.ID, requestID, metadata, digest, "FAILED", "", "", 0, latency, generationFailureCategory(generationErr), boundedGenerationError(generationErr))
		if persistErr != nil {
			if requestID != "" && isUniqueViolation(persistErr) && s.writeExistingGeneration(r.Context(), w, caseID, requestID) {
				return
			}
			writeError(w, http.StatusInternalServerError, "could not persist AI draft failure")
			return
		}
		writeAudit(r.Context(), s, p, "provider_case.ai_draft_failed", "provider_case", caseID, nil, map[string]interface{}{"generation_id": generationID, "status": "FAILED", "failure_category": generationFailureCategory(generationErr), "evidence_digest": digest})
		status := http.StatusBadGateway
		if typed, ok := generationErr.(*draftGenerationError); ok && typed.Status == http.StatusServiceUnavailable {
			status = http.StatusServiceUnavailable
		}
		writeError(w, status, "AI draft generation failed; provider case remains usable")
		return
	}

	draftHash := providerEvidenceDigest(ProviderDraftInput{EvidenceJSON: draft})
	generationID, persistErr := s.persistDraftGeneration(r.Context(), caseID, p.ID, requestID, metadata, digest, "SUCCEEDED", draft, draftHash, len(draft), latency, "", "")
	if persistErr != nil {
		if requestID != "" && isUniqueViolation(persistErr) && s.writeExistingGeneration(r.Context(), w, caseID, requestID) {
			return
		}
		if errors.Is(persistErr, errProviderCaseSent) {
			writeError(w, http.StatusConflict, "provider case changed while generating draft")
			return
		}
		writeError(w, http.StatusInternalServerError, "could not persist AI draft")
		return
	}
	writeAudit(r.Context(), s, p, "provider_case.ai_draft", "provider_case", caseID, nil, map[string]interface{}{"generation_id": generationID, "status": "SUCCEEDED", "provider": metadata.Provider, "model": metadata.Model, "prompt_version": metadata.PromptVersion, "evidence_digest": digest, "draft_bytes": len(draft)})
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": caseID, "provider_case_id": caseID, "generation_id": generationID, "status": "DRAFT", "draft_text": draft, "provider": metadata.Provider, "model": metadata.Model, "prompt_version": metadata.PromptVersion, "evidence_digest": digest})
}

func (s *Server) writeExistingGeneration(ctx context.Context, w http.ResponseWriter, caseID, requestID string) bool {
	var generationID int64
	var status, draft string
	err := s.DB.Pool.QueryRow(ctx, `SELECT g.id,g.status,COALESCE(c.draft_text,'') FROM provider_case_draft_generations g JOIN provider_cases c ON c.id=g.provider_case_id WHERE g.provider_case_id=$1 AND g.request_id=$2 ORDER BY g.id DESC LIMIT 1`, caseID, requestID).Scan(&generationID, &status, &draft)
	if err != nil || status != "SUCCEEDED" {
		return false
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": caseID, "provider_case_id": caseID, "generation_id": generationID, "status": "DRAFT", "draft_text": draft, "deduplicated": true})
	return true
}

func isUniqueViolation(err error) bool {
	value := strings.ToLower(err.Error())
	return strings.Contains(value, "duplicate") || strings.Contains(value, "unique")
}

type providerCaseDraftContext struct {
	ID       string
	Status   string
	Incident incidentRecord
}

func (s *Server) loadProviderCaseDraftContext(ctx context.Context, caseID, lineID string) (providerCaseDraftContext, error) {
	var incidentID int64
	var status string
	var storedLine string
	if err := s.DB.Pool.QueryRow(ctx, `SELECT i.id,c.status,i.line_id FROM provider_cases c JOIN incidents i ON i.id=c.incident_id WHERE c.id=$1`, caseID).Scan(&incidentID, &status, &storedLine); err != nil {
		return providerCaseDraftContext{}, err
	}
	if storedLine != lineID {
		return providerCaseDraftContext{}, pgx.ErrNoRows
	}
	incident, err := mustIncident(ctx, s, incidentID)
	if err != nil {
		return providerCaseDraftContext{}, pgx.ErrNoRows
	}
	return providerCaseDraftContext{ID: caseID, Status: status, Incident: incident}, nil
}

func (s *Server) providerDraftInput(ctx context.Context, incident incidentRecord, comment string) (ProviderDraftInput, error) {
	opening := decodeJSONBytes(incident.Opening)
	evidenceIDs := incidentEvidenceIDs(opening)
	observations := []map[string]interface{}{}
	if len(evidenceIDs) > 0 {
		rows, err := s.DB.Pool.Query(ctx, `SELECT id,observed_at,download,upload,ping,jitter,packet_loss,availability FROM measurements WHERE line_id=$1 AND id=ANY($2) ORDER BY observed_at,id`, incident.LineID, evidenceIDs)
		if err != nil {
			return ProviderDraftInput{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var at time.Time
			var download, upload, ping, jitter, loss, availability *float64
			if err := rows.Scan(&id, &at, &download, &upload, &ping, &jitter, &loss, &availability); err != nil {
				return ProviderDraftInput{}, err
			}
			observations = append(observations, map[string]interface{}{"id": id, "observed_at": at.UTC().Format(time.RFC3339), "download": download, "upload": upload, "ping": ping, "jitter": jitter, "packet_loss": loss, "availability": availability})
		}
		if err := rows.Err(); err != nil {
			return ProviderDraftInput{}, err
		}
	}
	observationsJSON, err := json.Marshal(observations)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	policyJSON, err := json.Marshal(mapValue(opening, "policy"))
	if err != nil {
		return ProviderDraftInput{}, err
	}
	contractJSON, err := json.Marshal(mapValue(opening, "contract"))
	if err != nil {
		return ProviderDraftInput{}, err
	}
	evidenceJSON, err := json.Marshal(evidenceIDs)
	if err != nil {
		return ProviderDraftInput{}, err
	}
	return ProviderDraftInput{LineID: incident.LineID, SchoolID: incident.SchoolID, Organization: incident.OrganizationName, ViolationType: incident.ViolationType, StartedAt: incident.StartedAt.UTC().Format(time.RFC3339), PolicyJSON: string(policyJSON), ContractJSON: string(contractJSON), ObservationsJSON: string(observationsJSON), EvidenceJSON: string(evidenceJSON), Comment: comment}, nil
}

var errProviderCaseSent = errors.New("provider case was sent")

func (s *Server) persistDraftGeneration(ctx context.Context, caseID, requester, requestID string, metadata DraftGenerationMetadata, digest, status, draftText, draftHash string, draftBytes, latency int, failureCategory, failureDetail string) (int64, error) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current string
	if err := tx.QueryRow(ctx, `SELECT status FROM provider_cases WHERE id=$1 FOR UPDATE`, caseID).Scan(&current); err != nil {
		return 0, err
	}
	stale := current == "SENT" && status == "SUCCEEDED"
	if stale {
		status = "STALE"
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO provider_case_draft_generations(provider_case_id,request_id,requested_by,provider,model,prompt_version,evidence_digest,status,draft_sha256,draft_bytes,latency_ms,failure_category,error_detail,created_at) VALUES ($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,0),$11,NULLIF($12,''),NULLIF($13,''),$14) RETURNING id`, caseID, requestID, requester, metadata.Provider, metadata.Model, metadata.PromptVersion, digest, status, draftHash, draftBytes, latency, failureCategory, failureDetail, time.Now().UTC().Truncate(time.Second)).Scan(&id)
	if err != nil {
		return 0, err
	}
	if status == "SUCCEEDED" {
		if _, err := tx.Exec(ctx, `UPDATE provider_cases SET draft_text=$1,status='DRAFT',delivery_status='PENDING' WHERE id=$2 AND status <> 'SENT'`, draftText, caseID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	if stale {
		return id, errProviderCaseSent
	}
	return id, nil
}

func generationFailureCategory(err error) string {
	if typed, ok := err.(*draftGenerationError); ok && typed.Category != "" {
		return typed.Category
	}
	return "generation"
}
func boundedGenerationError(err error) string {
	value := strings.Join(strings.Fields(err.Error()), " ")
	if len(value) > 512 {
		value = value[:512]
	}
	return value
}
