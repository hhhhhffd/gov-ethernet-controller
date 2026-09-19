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
	var body strings.Builder
	write := func(value string) { body.WriteString(html.EscapeString(value)) }
	body.WriteString("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"historical_only\" content=\"true\">")
	body.WriteString("<meta name=\"generator\" content=\"Linkwatch evidence report ")
	write(metadata.TemplateVersion)
	body.WriteString("\"><title>Linkwatch evidence report</title><style>")
	body.WriteString("body{font:14px system-ui,sans-serif;color:#17202a;max-width:1100px;margin:32px auto;padding:0 24px}h1{margin-bottom:4px}h2{margin-top:28px;border-bottom:1px solid #ccd5dd;padding-bottom:6px}.meta,.chain{background:#f5f7f9;border:1px solid #d9e0e6;border-radius:6px;padding:12px;margin:10px 0}.unknown{color:#7a4b00}.no-data{color:#6b7280}dt{font-weight:600;float:left;clear:left;width:190px}dd{margin-left:205px;margin-bottom:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #e2e8f0;padding:7px;vertical-align:top}@media print{body{margin:0;max-width:none}.chain{break-inside:avoid}}</style></head><body>")
	body.WriteString("<h1>Historical evidence report</h1><div class=\"meta\"><dl><dt>Template</dt><dd>")
	write(metadata.TemplateVersion)
	body.WriteString("</dd><dt>Period</dt><dd>")
	write(metadata.From.UTC().Format(time.RFC3339))
	body.WriteString(" — ")
	write(metadata.To.UTC().Format(time.RFC3339))
	body.WriteString("</dd><dt>Generated</dt><dd>")
	write(metadata.GeneratedAt.UTC().Format(time.RFC3339))
	body.WriteString("</dd><dt>Scope role</dt><dd>")
	write(metadata.Role)
	body.WriteString("</dd><dt>Source</dt><dd>Stored measurement evaluation and historical snapshot data only; current configuration is not used.</dd></dl></div>")
	body.WriteString("<h2>Period status: <span data-state=\"")
	write(state)
	body.WriteString("\">")
	write(state)
	body.WriteString("</span></h2>")
	if len(ordered) == 0 {
		body.WriteString("<p class=\"no-data\">NO_DATA: no stored observations are available for this scoped period.</p>")
	}
	body.WriteString("<table><thead><tr><th>Observed at</th><th>Line</th><th>Baseline</th><th>Contract</th><th>Completeness / verification</th></tr></thead><tbody>")
	for _, row := range ordered {
		chain := evidenceChain(row.measurementRecord)
		status, _ := chain["status"].(string)
		completeness := "{}"
		if encoded, err := jsonCompact(chain["completeness"]); err == nil {
			completeness = encoded
		}
		verification, _ := chain["verification"].(map[string]interface{})
		verificationJSON := "{}"
		if encoded, err := jsonCompact(verification); err == nil {
			verificationJSON = encoded
		}
		body.WriteString("<tr><td>")
		write(row.ObservedAt.UTC().Format(time.RFC3339))
		body.WriteString("</td><td>")
		write(row.LineID)
		body.WriteString("</td><td>")
		write(row.BaselineState)
		body.WriteString("</td><td>")
		write(row.ContractState)
		body.WriteString("</td><td>")
		write(completeness)
		body.WriteString(" / ")
		write(status)
		if strings.TrimSpace(row.Reason) != "" {
			body.WriteString("<br><small>Reason: ")
			write(row.Reason)
			body.WriteString("</small>")
		}
		body.WriteString("<br><small>")
		write(verificationJSON)
		body.WriteString("</small></td></tr>")
	}
	body.WriteString("</tbody></table><h2>Immutable evidence chain</h2>")
	if len(ordered) == 0 {
		body.WriteString("<p class=\"unknown\">UNKNOWN: no historical evidence chain exists for this period.</p>")
	}
	for _, row := range ordered {
		encoded, err := jsonCompact(evidenceChain(row.measurementRecord))
		if err != nil {
			return "", fmt.Errorf("encode evidence chain: %w", err)
		}
		body.WriteString("<section class=\"chain\"><strong>Line ")
		write(row.LineID)
		body.WriteString(" · ")
		write(row.ObservedAt.UTC().Format(time.RFC3339))
		body.WriteString("</strong><pre>")
		write(encoded)
		body.WriteString("</pre></section>")
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
	content, err := renderEvidenceReport(rows, evidenceReportMetadata{From: start, To: end, GeneratedAt: time.Now().UTC().Truncate(time.Second), TemplateVersion: evidenceReportTemplateVersion, Role: p.Role})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not render evidence report")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="linkwatch-evidence-report.html"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}
