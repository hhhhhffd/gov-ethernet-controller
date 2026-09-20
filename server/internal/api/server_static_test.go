package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticAssetsUseRuntimeContentTypes(t *testing.T) {
	webDir := t.TempDir()
	assets := map[string]struct {
		contentType string
		content     []byte
	}{
		"app.js": {
			contentType: "text/javascript; charset=utf-8",
			content:     []byte("window.app = true;"),
		},
		"core/api.mjs": {
			contentType: "text/javascript; charset=utf-8",
			content:     []byte("export const api = true;"),
		},
		"styles.css": {
			contentType: "text/css; charset=utf-8",
			content:     []byte("body { color: white; }"),
		},
		"data/registry.json": {
			contentType: "application/json; charset=utf-8",
			content:     []byte(`{"schools":[]}`),
		},
		"vendor/leaflet/images/marker.png": {
			contentType: "image/png",
			content:     []byte{0x89, 0x50, 0x4e, 0x47},
		},
		"opaque.bin": {
			contentType: "application/octet-stream",
			content:     []byte{0x00, 0x01, 0x02},
		},
	}
	for name, asset := range assets {
		path := filepath.Join(webDir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create asset directory for %s: %v", name, err)
		}
		if err := os.WriteFile(path, asset.content, 0o644); err != nil {
			t.Fatalf("write asset %s: %v", name, err)
		}
	}

	server := httptest.NewServer((&Server{WebDir: webDir}).Handler())
	defer server.Close()

	for name, asset := range assets {
		name, asset := name, asset
		t.Run(name, func(t *testing.T) {
			response, err := http.Get(server.URL + "/static/" + name)
			if err != nil {
				t.Fatalf("GET /static/%s: %v", name, err)
			}
			body, readErr := io.ReadAll(response.Body)
			closeErr := response.Body.Close()
			if readErr != nil {
				t.Fatalf("read /static/%s response: %v", name, readErr)
			}
			if closeErr != nil {
				t.Fatalf("close /static/%s response: %v", name, closeErr)
			}
			if response.StatusCode != http.StatusOK {
				t.Fatalf("GET /static/%s status = %d, body = %q", name, response.StatusCode, body)
			}
			if got, want := response.Header.Get("Content-Type"), asset.contentType; got != want {
				t.Fatalf("GET /static/%s Content-Type = %q, want %q", name, got, want)
			}
			if len(body) == 0 {
				t.Fatalf("GET /static/%s returned an empty asset", name)
			}
		})
	}
}
