package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticModuleAssetsUseJavaScriptContentType(t *testing.T) {
	webDir := t.TempDir()
	for name, content := range map[string]string{
		"app.js":       "window.app = true;",
		"core/api.mjs": "export const api = true;",
	} {
		path := filepath.Join(webDir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create asset directory for %s: %v", name, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write asset %s: %v", name, err)
		}
	}

	server := httptest.NewServer((&Server{WebDir: webDir}).Handler())
	defer server.Close()

	for _, asset := range []string{"app.js", "core/api.mjs"} {
		response, err := http.Get(server.URL + "/static/" + asset)
		if err != nil {
			t.Fatalf("GET /static/%s: %v", asset, err)
		}
		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if readErr != nil {
			t.Fatalf("read /static/%s response: %v", asset, readErr)
		}
		if closeErr != nil {
			t.Fatalf("close /static/%s response: %v", asset, closeErr)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET /static/%s status = %d, body = %q", asset, response.StatusCode, body)
		}
		if got, want := response.Header.Get("Content-Type"), "text/javascript; charset=utf-8"; got != want {
			t.Fatalf("GET /static/%s Content-Type = %q, want %q", asset, got, want)
		}
		if len(body) == 0 {
			t.Fatalf("GET /static/%s returned an empty module", asset)
		}
	}
}
