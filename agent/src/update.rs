use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::{digest, signature};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Deserialize)]
pub struct ReleasePayload {
    pub schema: String,
    pub release_id: String,
    pub version: String,
    pub min_agent_version: String,
    #[serde(default)]
    pub max_agent_version: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub artifact_size: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct SignedManifest {
    signed_payload: String,
    signature: String,
    key_id: String,
}

#[derive(Debug, Clone)]
pub struct UpdateStatus {
    pub version: String,
    pub artifact_sha256: String,
}

pub fn verify_manifest(manifest: &Value, current_version: &str) -> Result<ReleasePayload, String> {
    let raw: SignedManifest = serde_json::from_value(manifest.clone())
        .map_err(|_| "malformed signed manifest".to_string())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(&raw.signed_payload)
        .or_else(|_| STANDARD.decode(&raw.signed_payload))
        .map_err(|_| "manifest payload is not base64".to_string())?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&raw.signature)
        .or_else(|_| STANDARD.decode(&raw.signature))
        .map_err(|_| "manifest signature is not base64".to_string())?;
    let key = trusted_key(&raw.key_id)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(&payload_bytes, &signature_bytes)
        .map_err(|_| "manifest signature verification failed".to_string())?;
    let payload: ReleasePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "malformed release payload".to_string())?;
    if payload.schema != "linkwatch.agent-release/v1"
        || payload.release_id.trim().is_empty()
        || payload.version.trim().is_empty()
        || payload.min_agent_version.trim().is_empty()
    {
        return Err("invalid release metadata".into());
    }
    if !payload.artifact_url.starts_with("https://")
        || payload.artifact_url.contains('@')
        || payload.artifact_size <= 0
        || payload.artifact_sha256.len() != 64
        || !payload
            .artifact_sha256
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("unsafe or incomplete artifact metadata".into());
    }
    if compare_versions(&payload.version, current_version)? <= 0 {
        return Err("rollback or equal-version update rejected".into());
    }
    if compare_versions(current_version, &payload.min_agent_version)? < 0 {
        return Err("current agent is below manifest compatibility floor".into());
    }
    if !payload.max_agent_version.is_empty()
        && compare_versions(current_version, &payload.max_agent_version)? > 0
    {
        return Err("current agent is above manifest compatibility ceiling".into());
    }
    Ok(payload)
}

pub fn apply_command(
    command: &Value,
    current_version: &str,
    queue_dir: &Path,
) -> Result<UpdateStatus, String> {
    let manifest = command.get("manifest").ok_or("update manifest missing")?;
    let payload = verify_manifest(manifest, current_version)?;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .get(&payload.artifact_url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("read artifact failed: {e}"))?;
    if bytes.len() as i64 != payload.artifact_size {
        return Err("artifact size mismatch".into());
    }
    let actual = digest::digest(&digest::SHA256, &bytes);
    let actual_hex = actual
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual_hex != payload.artifact_sha256.to_ascii_lowercase() {
        return Err("artifact hash mismatch".into());
    }
    fs::create_dir_all(queue_dir).map_err(|e| e.to_string())?;
    let staged = queue_dir.join(format!("update-{}.verified", payload.release_id));
    fs::write(&staged, &bytes).map_err(|e| format!("stage artifact failed: {e}"))?;
    atomic_install(&staged)?;
    Ok(UpdateStatus {
        version: payload.version,
        artifact_sha256: actual_hex,
    })
}

fn trusted_key(key_id: &str) -> Result<Vec<u8>, String> {
    let configured_id =
        std::env::var("LINKWATCH_UPDATE_KEY_ID").unwrap_or_else(|_| "primary".into());
    let value = if let Ok(rotating) = std::env::var("LINKWATCH_UPDATE_TRUST_KEYS") {
        rotating
            .split(',')
            .find_map(|entry| {
                let (id, key) = entry.trim().split_once('=')?;
                (id.trim() == key_id).then(|| key.trim().to_string())
            })
            .ok_or_else(|| "untrusted manifest key id".to_string())?
    } else {
        if key_id != configured_id {
            return Err("untrusted manifest key id".into());
        }
        std::env::var("LINKWATCH_UPDATE_PUBLIC_KEY")
            .map_err(|_| "update trust anchor is not configured".to_string())?
    };
    URL_SAFE_NO_PAD
        .decode(&value)
        .or_else(|_| STANDARD.decode(&value))
        .map_err(|_| "invalid update trust anchor".into())
        .and_then(|key| {
            if key.len() == 32 {
                Ok(key)
            } else {
                Err("invalid update trust anchor length".into())
            }
        })
}

fn atomic_install(staged: &Path) -> Result<(), String> {
    let target = std::env::var_os("LINKWATCH_AGENT_BINARY")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .ok_or("agent binary path unavailable")?;
    let backup = target.with_extension("previous");
    if target.exists() {
        fs::copy(&target, &backup)
            .map_err(|e| format!("preserve known-good binary failed: {e}"))?;
    }
    let temp = target.with_extension("new");
    fs::copy(staged, &temp).map_err(|e| format!("prepare atomic install failed: {e}"))?;
    #[cfg(unix)]
    if let Ok(mode) = target.metadata().map(|metadata| metadata.permissions()) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = mode;
        permissions.set_mode(0o755);
        let _ = fs::set_permissions(&temp, permissions);
    }
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::copy(&backup, &target);
        format!("install failed; rollback restored: {e}")
    })?;
    Ok(())
}

fn compare_versions(left: &str, right: &str) -> Result<i32, String> {
    let parse = |value: &str| {
        value
            .split('.')
            .map(|part| {
                part.parse::<u64>()
                    .map_err(|_| "versions must be numeric semver".to_string())
            })
            .collect::<Result<Vec<_>, _>>()
    };
    let a = parse(left)?;
    let b = parse(right)?;
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x != y {
            return Ok(if x > y { 1 } else { -1 });
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn rejects_malformed_and_tampered_manifest() {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let payload = br#"{"schema":"linkwatch.agent-release/v1","release_id":"r1","version":"1.0.1","min_agent_version":"0.1.0","artifact_url":"https://example.test/a","artifact_sha256":"0000000000000000000000000000000000000000000000000000000000000000","artifact_size":1}"#;
        std::env::set_var("LINKWATCH_UPDATE_KEY_ID", "primary");
        std::env::set_var(
            "LINKWATCH_UPDATE_PUBLIC_KEY",
            STANDARD.encode(pair.public_key().as_ref()),
        );
        let manifest = serde_json::json!({"signed_payload":URL_SAFE_NO_PAD.encode(payload),"signature":URL_SAFE_NO_PAD.encode(pair.sign(payload).as_ref()),"key_id":"primary"});
        assert!(verify_manifest(&manifest, "0.1.0").is_ok());
        let mut bad = manifest.clone();
        bad["signature"] = Value::String(URL_SAFE_NO_PAD.encode([0u8; 64]));
        assert!(verify_manifest(&bad, "0.1.0").is_err());
        assert!(verify_manifest(&manifest, "2.0.0").is_err());
    }
}
