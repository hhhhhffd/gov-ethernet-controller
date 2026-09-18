package api

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

// DraftGenerator is the boundary for provider-case draft generation.  A
// generator must return text suitable for human review; it does not persist
// or send a case.
type DraftGenerator interface {
	Generate(context.Context, ProviderDraftInput) (string, error)
}

// ProviderDraftInput contains only the evidence already selected for the
// incident.  Keeping this input structured makes an eventual AI adapter
// replaceable without changing the provider-case workflow.
type ProviderDraftInput struct {
	LineID           string
	SchoolID         string
	Organization     string
	ViolationType    string
	StartedAt        string
	PolicyJSON       string
	ContractJSON     string
	ObservationsJSON string
	EvidenceJSON     string
	Comment          string
}

type deterministicDraftGenerator struct{}

func (deterministicDraftGenerator) Generate(_ context.Context, input ProviderDraftInput) (string, error) {
	return fmt.Sprintf("Здравствуйте! Просим проверить качество услуги на линии %s (школа %s, %s).\n\nСистема мониторинга подтвердила нарушение %s с %s.\n\nПрименённые пороги: %s.\nДоговорный ориентир и его срок действия на момент наблюдений: %s.\nНаблюдения: %s.\nПакет доказательств: measurement IDs %s; значения и effective policy/contract сохранены в системе без перезаписи истории.\n\nКомментарий заказчика: %s\n\nФормулировка описывает технически наблюдаемое отклонение и требует проверки оператором.",
		input.LineID, input.SchoolID, input.Organization, input.ViolationType, input.StartedAt,
		input.PolicyJSON, input.ContractJSON, input.ObservationsJSON, input.EvidenceJSON, input.Comment), nil
}

const maxProviderDraftLength = 32 << 10

// validateProviderDraft bounds output from any future generator and rejects
// malformed or control-bearing text before it is persisted and displayed.
func validateProviderDraft(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("draft is empty")
	}
	if len(value) > maxProviderDraftLength {
		return fmt.Errorf("draft exceeds %d bytes", maxProviderDraftLength)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("draft is not valid UTF-8")
	}
	for _, r := range value {
		if r == '\x00' || (r < 0x20 && r != '\n' && r != '\r' && r != '\t') {
			return fmt.Errorf("draft contains unsupported control characters")
		}
	}
	return nil
}

func safeDraftField(value string) string {
	value = strings.ToValidUTF8(value, "�")
	var b strings.Builder
	for _, r := range value {
		if r == '\x00' || (r < 0x20 && r != '\n' && r != '\r' && r != '\t') {
			r = ' '
		}
		b.WriteRune(r)
	}
	return b.String()
}

func generateProviderDraft(ctx context.Context, generator DraftGenerator, input ProviderDraftInput) string {
	fallbackGenerator := deterministicDraftGenerator{}
	if generator == nil {
		generator = fallbackGenerator
	}
	input = safeProviderDraftInput(input)
	draft, err := generator.Generate(ctx, input)
	if err == nil && validateProviderDraft(draft) == nil {
		return draft
	}
	// The deterministic template is deliberately the last-resort output.  It
	// is bounded and validated too, so generator failures never block review.
	draft, _ = fallbackGenerator.Generate(ctx, input)
	if validateProviderDraft(draft) != nil {
		return "Система мониторинга сформировала пакет доказательств нарушения. Требуется проверка оператором."
	}
	return draft
}

func safeProviderDraftInput(input ProviderDraftInput) ProviderDraftInput {
	input.LineID = safeDraftField(input.LineID)
	input.SchoolID = safeDraftField(input.SchoolID)
	input.Organization = safeDraftField(input.Organization)
	input.ViolationType = safeDraftField(input.ViolationType)
	input.StartedAt = safeDraftField(input.StartedAt)
	input.PolicyJSON = safeDraftField(input.PolicyJSON)
	input.ContractJSON = safeDraftField(input.ContractJSON)
	input.ObservationsJSON = safeDraftField(input.ObservationsJSON)
	input.EvidenceJSON = safeDraftField(input.EvidenceJSON)
	input.Comment = safeDraftField(input.Comment)
	return input
}
