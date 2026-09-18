package api

import (
	"strings"
	"testing"
	"time"
)

func testEvidenceRow() reportRow {
	return reportRow{measurementRecord: measurementRecord{
		ID: 42, LineID: "line-1", ObservedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		BaselineState: "VIOLATION", ContractState: "DEVIATES", Reason: "operator <review> & note", Valid: true,
		PolicySnapshot:      []byte(`{"id":7,"version":3,"scope_type":"LINE","scope_id":"line-1","valid_from":"2025-12-01T00:00:00Z","confirm_duration_minutes":15}`),
		ContractSnapshot:    []byte(`{"id":8,"version":2,"valid_from":"2025-12-01T00:00:00Z"}`),
		LineContextSnapshot: []byte(`{"version":4,"line_id":"line-1","created_at":"2025-12-01T00:00:00Z"}`),
	}}
}

func TestRenderEvidenceReportEscapesAndUsesHistoricalSnapshots(t *testing.T) {
	row := testEvidenceRow()
	row.LineID = "line<unsafe>&1"
	content, err := renderEvidenceReport([]reportRow{row}, evidenceReportMetadata{From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC), GeneratedAt: time.Date(2026, 1, 3, 1, 0, 0, 0, time.UTC), TemplateVersion: evidenceReportTemplateVersion, Role: "DISTRICT"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"evidence-report-v1", "&#34;version&#34;:3", "&#34;version&#34;:2", "&#34;version&#34;:4", "DURATION", "historical_only"} {
		if !strings.Contains(content, want) {
			t.Fatalf("report does not contain %q", want)
		}
	}
	if strings.Contains(content, "line<unsafe>&1") || !strings.Contains(content, "line&lt;unsafe&gt;&amp;1") {
		t.Fatal("untrusted line identifier was not escaped")
	}
}

func TestRenderEvidenceReportExplicitNoData(t *testing.T) {
	content, err := renderEvidenceReport(nil, evidenceReportMetadata{From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), GeneratedAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), TemplateVersion: evidenceReportTemplateVersion})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, `data-state="NO_DATA"`) || !strings.Contains(content, "UNKNOWN") {
		t.Fatal("NO_DATA/UNKNOWN state is not explicit")
	}
}

func TestRenderEvidenceReportRejectsInvalidRenderMetadata(t *testing.T) {
	_, err := renderEvidenceReport(nil, evidenceReportMetadata{TemplateVersion: evidenceReportTemplateVersion})
	if err == nil {
		t.Fatal("expected invalid period render error")
	}
	_, err = renderEvidenceReport(nil, evidenceReportMetadata{From: time.Unix(1, 0), To: time.Unix(2, 0)})
	if err == nil {
		t.Fatal("expected missing template version render error")
	}
}

func TestRenderEvidenceReportEscapesMetadataRole(t *testing.T) {
	content, err := renderEvidenceReport(nil, evidenceReportMetadata{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		GeneratedAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), TemplateVersion: evidenceReportTemplateVersion, Role: "DISTRICT<unsafe>&1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(content, "DISTRICT<unsafe>&1") || !strings.Contains(content, "DISTRICT&lt;unsafe&gt;&amp;1") {
		t.Fatal("metadata role was not escaped")
	}
}
