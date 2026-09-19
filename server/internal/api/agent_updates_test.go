package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestDecodeSignedAgentManifestRejectsTamperingAndAcceptsRotationKey(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"schema":"linkwatch.agent-release/v1","release_id":"release-1","version":"1.0.1","min_agent_version":"0.1.0","artifact_url":"https://updates.example/release.bin","artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","artifact_size":1}`)
	manifest := map[string]string{"signed_payload": base64.RawURLEncoding.EncodeToString(payload), "signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, payload)), "key_id": "rotated"}
	raw, _ := json.Marshal(manifest)
	t.Setenv("LINKWATCH_UPDATE_TRUST_KEYS", "rotated="+base64.RawStdEncoding.EncodeToString(public))
	t.Setenv("LINKWATCH_UPDATE_PUBLIC_KEY", "")
	if _, _, _, err := decodeSignedAgentManifest(raw); err != nil {
		t.Fatalf("rotated key manifest rejected: %v", err)
	}
	manifest["signature"] = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	raw, _ = json.Marshal(manifest)
	if _, _, _, err := decodeSignedAgentManifest(raw); err == nil {
		t.Fatal("tampered signature accepted")
	}
}

func TestUpdateAckStatusPreservesRollback(t *testing.T) {
	if got := updateAckStatus(json.RawMessage(`{"status":"ROLLED_BACK"}`), "FAILED"); got != "ROLLED_BACK" {
		t.Fatalf("status = %q", got)
	}
	if got := updateAckStatus(json.RawMessage(`{"status":"INSTALLING","restart_requested":true}`), "DONE"); got != "INSTALLING" {
		t.Fatalf("status = %q", got)
	}
	if got := updateAckStatus(json.RawMessage(`{"status":"DOWNLOADING"}`), "DONE"); got != "DOWNLOADING" {
		t.Fatalf("downloading ACK status = %q", got)
	}
	if got := updateAckStatus(json.RawMessage(`{"status":"SUCCEEDED"}`), "DONE"); got != "INSTALLING" {
		t.Fatalf("legacy success ACK status = %q", got)
	}
	if got := updateAckStatus(json.RawMessage(`{"status":"ALREADY_CURRENT"}`), "DONE"); got != "VERIFIED" {
		t.Fatalf("already-current ACK status = %q", got)
	}
}

func TestUpdateHeartbeatTransitionRequiresNewBootAndExactVersion(t *testing.T) {
	if got := updateHeartbeatTransition("INSTALLING", "1.0.1", "1.0.1", "boot-old", "boot-new", true); got != "SUCCEEDED" {
		t.Fatalf("success transition = %q", got)
	}
	if got := updateHeartbeatTransition("INSTALLING", "1.0.1", "1.0.0", "boot-old", "boot-new", true); got != "ROLLED_BACK" {
		t.Fatalf("rollback transition = %q", got)
	}
	if got := updateHeartbeatTransition("INSTALLING", "1.0.1", "1.0.1", "boot-old", "boot-old", true); got != "" {
		t.Fatalf("same-boot transition = %q", got)
	}
	if got := updateHeartbeatTransition("VERIFIED", "1.0.1", "1.0.1", "boot-old", "boot-new", true); got != "" {
		t.Fatalf("verified transition = %q", got)
	}
}
