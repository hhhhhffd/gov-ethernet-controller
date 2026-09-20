package api

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"
	"time"
)

// The report is deliberately printable HTML rather than a server-side PDF.
// This keeps the export deterministic and avoids an external renderer/upload
// dependency while allowing operators to print/save it as PDF in a browser.
const evidenceReportTemplateVersion = "evidence-report-v1"

type evidenceReportMetadata struct {
	From, To        time.Time
	GeneratedAt     time.Time
	TemplateVersion string
	Role            string
	Locale          string
}

type evidenceReportCopy struct {
	title, period, generated, scope, source, template, technical, stateCode     string
	periodStatus, chainTitle, noData, unknownChain, observedAt, line, baseline  string
	contract, completeness, verification, reason, technicalPayload              string
	available, noDataState, unknown, baselineOK, baselineViolation              string
	contractMeets, contractDeviates, verificationConfirmed, verificationPending string
	verificationExpired, verificationUnknown                                    string
}

func evidenceReportLocale(value string) string {
	for _, part := range strings.Split(strings.ToLower(value), ",") {
		language := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if strings.HasPrefix(language, "kk") {
			return "kk"
		}
		if strings.HasPrefix(language, "ru") {
			return "ru"
		}
	}
	return "ru"
}

func evidenceReportCopyFor(locale string) evidenceReportCopy {
	if evidenceReportLocale(locale) == "kk" {
		return evidenceReportCopy{
			title: "Тарихи дәлелдемелер есебі", period: "Кезең", generated: "Жасалған уақыты", scope: "Қамту", source: "Дереккөз", template: "Үлгі", technical: "Техникалық деректер", stateCode: "Күй коды", periodStatus: "Кезең күйі", chainTitle: "Өзгермейтін дәлелдемелер тізбегі", noData: "Таңдалған кезеңде сақталған бақылаулар жоқ.", unknownChain: "Тарихи дәлелдемелер тізбегінің күйін анықтау мүмкін болмады: бұл кезең үшін тізбек жоқ.", observedAt: "Бақыланған уақыты", line: "Желі", baseline: "Негізгі саясат", contract: "Шарт", completeness: "Толықтығы / тексерілуі", verification: "Тексерілуі", reason: "Себеп", technicalPayload: "Дәлелдемелердің техникалық жүктемесі", available: "Деректер қолжетімді", noDataState: "Кезең бойынша деректер жоқ", unknown: "Күйді анықтау мүмкін болмады", baselineOK: "Негізгі саясатқа сәйкес", baselineViolation: "Негізгі саясаттан ауытқу", contractMeets: "Шартқа сәйкес", contractDeviates: "Шартқа сәйкес емес", verificationConfirmed: "Тексеру расталды", verificationPending: "Тексеру күтілуде", verificationExpired: "Тексеру мерзімі аяқталды", verificationUnknown: "Тексеру күйі белгісіз",
		}
	}
	return evidenceReportCopy{
		title: "Отчёт по историческим доказательствам", period: "Период", generated: "Время формирования", scope: "Охват", source: "Источник", template: "Шаблон", technical: "Технические данные", stateCode: "Код состояния", periodStatus: "Состояние периода", chainTitle: "Неизменяемая цепочка доказательств", noData: "За выбранный период сохранённых наблюдений нет.", unknownChain: "Состояние исторической цепочки доказательств не удалось определить: для этого периода цепочка отсутствует.", observedAt: "Время наблюдения", line: "Линия", baseline: "Базовая политика", contract: "Договор", completeness: "Полнота / проверка", verification: "Проверка", reason: "Причина", technicalPayload: "Техническая нагрузка доказательств", available: "Данные доступны", noDataState: "Данных за период нет", unknown: "Состояние не удалось определить", baselineOK: "Соответствует базовой политике", baselineViolation: "Есть отклонение от базовой политики", contractMeets: "Соответствует договору", contractDeviates: "Не соответствует договору", verificationConfirmed: "Проверка подтверждена", verificationPending: "Проверка ожидается", verificationExpired: "Срок проверки истёк", verificationUnknown: "Состояние проверки неизвестно",
	}
}

func evidenceReportLocaleFromRequest(r *http.Request) string {
	if r == nil {
		return "ru"
	}
	return evidenceReportLocale(r.Header.Get("Accept-Language"))
}

func evidenceStatusLabel(state string, copy evidenceReportCopy) string {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "AVAILABLE":
		return copy.available
	case "NO_DATA":
		return copy.noDataState
	default:
		return copy.unknown
	}
}

func evidenceBaselineLabel(state string, copy evidenceReportCopy) string {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "OK":
		return copy.baselineOK
	case "VIOLATION":
		return copy.baselineViolation
	default:
		return copy.unknown
	}
}

func evidenceContractLabel(state string, copy evidenceReportCopy) string {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "MEETS":
		return copy.contractMeets
	case "DEVIATES":
		return copy.contractDeviates
	default:
		return copy.unknown
	}
}

func evidenceVerificationLabel(state string, copy evidenceReportCopy) string {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "CONFIRMED":
		return copy.verificationConfirmed
	case "PENDING":
		return copy.verificationPending
	case "EXPIRED":
		return copy.verificationExpired
	default:
		return copy.verificationUnknown
	}
}

func evidenceReportTime(value time.Time) string {
	return value.UTC().Format("02.01.2006 15:04:05 UTC")
}

func renderEvidenceReport(rows []reportRow, metadata evidenceReportMetadata) (string, error) {
	if metadata.TemplateVersion == "" {
		return "", fmt.Errorf("evidence report template version is required")
	}
	if metadata.From.IsZero() || metadata.To.IsZero() || !metadata.From.Before(metadata.To) {
		return "", fmt.Errorf("evidence report period is invalid")
	}
	ordered := append([]reportRow(nil), rows...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].ObservedAt.Equal(ordered[j].ObservedAt) {
			return ordered[i].ID < ordered[j].ID
		}
		return ordered[i].ObservedAt.Before(ordered[j].ObservedAt)
	})
	state := "AVAILABLE"
	if len(ordered) == 0 {
		state = "NO_DATA"
	}
	locale := evidenceReportLocale(metadata.Locale)
	copy := evidenceReportCopyFor(locale)
	var body strings.Builder
	write := func(value string) { body.WriteString(html.EscapeString(value)) }
	body.WriteString("<!doctype html><html lang=\"")
	write(locale)
	body.WriteString("\"><head><meta charset=\"utf-8\"><meta name=\"historical_only\" content=\"true\">")
	body.WriteString("<meta name=\"generator\" content=\"Linkwatch evidence report ")
	write(metadata.TemplateVersion)
	body.WriteString("\"><title>")
	write(copy.title)
	body.WriteString("</title><style>")
	body.WriteString("body{font:14px system-ui,sans-serif;color:#17202a;max-width:1100px;margin:32px auto;padding:0 24px}h1{margin-bottom:4px}h2{margin-top:28px;border-bottom:1px solid #ccd5dd;padding-bottom:6px}.meta,.chain{background:#f5f7f9;border:1px solid #d9e0e6;border-radius:6px;padding:12px;margin:10px 0}.unknown{color:#7a4b00}.no-data{color:#6b7280}.technical{margin-top:10px}dt{font-weight:600;float:left;clear:left;width:190px}dd{margin-left:205px;margin-bottom:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #e2e8f0;padding:7px;vertical-align:top}@media print{body{margin:0;max-width:none}.chain{break-inside:avoid}}</style></head><body>")
	body.WriteString("<h1>")
	write(copy.title)
	body.WriteString("</h1><div class=\"meta\"><dl><dt>")
	write(copy.period)
	body.WriteString("</dt><dd>")
	write(evidenceReportTime(metadata.From))
	body.WriteString(" — ")
	write(evidenceReportTime(metadata.To))
	body.WriteString("</dd><dt>")
	write(copy.generated)
	body.WriteString("</dt><dd>")
	write(evidenceReportTime(metadata.GeneratedAt))
	body.WriteString("</dd><dt>")
	write(copy.source)
	body.WriteString("</dt><dd>")
	write(map[string]string{"ru": "Только сохранённые оценки наблюдений и исторические снимки; текущая конфигурация не используется.", "kk": "Тек конфигурация қолданылмайды; тек сақталған бақылау бағалары мен тарихи суреттер пайдаланылды."}[locale])
	body.WriteString("</dd></dl><details class=\"technical\"><summary>")
	write(copy.technical)
	body.WriteString("</summary><dl><dt>")
	write(copy.template)
	body.WriteString("</dt><dd>")
	write(metadata.TemplateVersion)
	body.WriteString("</dd><dt>")
	write(copy.scope)
	body.WriteString("</dt><dd>")
	write(metadata.Role)
	body.WriteString("</dd><dt>")
	write(copy.stateCode)
	body.WriteString("</dt><dd>")
	write(state)
	body.WriteString("</dd></dl></details></div>")
	body.WriteString("<h2>")
	write(copy.periodStatus)
	body.WriteString(": <span data-state=\"")
	write(state)
	body.WriteString("\">")
	write(evidenceStatusLabel(state, copy))
	body.WriteString("</span></h2>")
	if len(ordered) == 0 {
		body.WriteString("<p class=\"no-data\">")
		write(copy.noData)
		body.WriteString("</p>")
	}
	body.WriteString("<table><thead><tr><th>")
	write(copy.observedAt)
	body.WriteString("</th><th>")
	write(copy.line)
	body.WriteString("</th><th>")
	write(copy.baseline)
	body.WriteString("</th><th>")
	write(copy.contract)
	body.WriteString("</th><th>")
	write(copy.completeness)
	body.WriteString("</th></tr></thead><tbody>")
	for _, row := range ordered {
		chain := evidenceChain(row.measurementRecord)
		completenessMap, _ := chain["completeness"].(map[string]interface{})
		completenessState, _ := completenessMap["status"].(string)
		verification, _ := chain["verification"].(map[string]interface{})
		body.WriteString("<tr><td>")
		write(evidenceReportTime(row.ObservedAt))
		body.WriteString("</td><td>")
		write(row.LineID)
		body.WriteString("</td><td>")
		write(evidenceBaselineLabel(row.BaselineState, copy))
		body.WriteString("</td><td>")
		write(evidenceContractLabel(row.ContractState, copy))
		body.WriteString("</td><td>")
		write(evidenceStatusLabel(completenessState, copy))
		body.WriteString(" / ")
		verificationState, _ := verification["status"].(string)
		write(evidenceVerificationLabel(verificationState, copy))
		if strings.TrimSpace(row.Reason) != "" {
			body.WriteString("<br><small>")
			write(copy.reason)
			body.WriteString(": ")
			write(row.Reason)
			body.WriteString("</small>")
		}
		body.WriteString("</td></tr>")
	}
	body.WriteString("</tbody></table><h2>")
	write(copy.chainTitle)
	body.WriteString("</h2>")
	if len(ordered) == 0 {
		body.WriteString("<p class=\"unknown\">")
		write(copy.unknownChain)
		body.WriteString("</p>")
	}
	for _, row := range ordered {
		chain := evidenceChain(row.measurementRecord)
		chainStatus, _ := chain["status"].(string)
		baseline, _ := chain["baseline"].(map[string]interface{})
		contract, _ := chain["contract"].(map[string]interface{})
		encoded, err := jsonCompact(evidenceChain(row.measurementRecord))
		if err != nil {
			return "", fmt.Errorf("encode evidence chain: %w", err)
		}
		body.WriteString("<section class=\"chain\"><strong>Line ")
		write(row.LineID)
		body.WriteString(" · ")
		write(evidenceReportTime(row.ObservedAt))
		body.WriteString("</strong><p>")
		write(evidenceStatusLabel(chainStatus, copy))
		body.WriteString("; ")
		baselineState, _ := baseline["state"].(string)
		write(evidenceBaselineLabel(baselineState, copy))
		body.WriteString("; ")
		contractState, _ := contract["state"].(string)
		write(evidenceContractLabel(contractState, copy))
		body.WriteString("</p><details class=\"technical\"><summary>")
		write(copy.technicalPayload)
		body.WriteString("</summary><pre>")
		write(encoded)
		body.WriteString("</pre></details></section>")
	}
	body.WriteString("</body></html>")
	return body.String(), nil
}

func jsonCompact(value interface{}) (string, error) {
	encoded, err := json.Marshal(value)
	return string(encoded), err
}

func (s *Server) evidenceReport(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	start, end, err := periodBounds(map[string]string{"from": r.URL.Query().Get("from"), "to": r.URL.Query().Get("to"), "period": r.URL.Query().Get("period")}, 30)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	rows, err := s.reportRows(r, p, start, end)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not query evidence report")
		return
	}
	content, err := renderEvidenceReport(rows, evidenceReportMetadata{From: start, To: end, GeneratedAt: time.Now().UTC().Truncate(time.Second), TemplateVersion: evidenceReportTemplateVersion, Role: p.Role, Locale: evidenceReportLocaleFromRequest(r)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not render evidence report")
		return
	}
	w.Header().Set("Vary", "Accept-Language")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="linkwatch-evidence-report.html"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}
