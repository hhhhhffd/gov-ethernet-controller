use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::{digest, signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};

const ACTIVATION_RECORD_NAME: &str = ".agent-update.activation.json";
const ACTIVATION_PART_SUFFIX: &str = ".part";
const ACTIVATION_VERIFIED_SUFFIX: &str = ".verified";
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(120);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePhase {
    AlreadyCurrent,
    Installing,
}

#[derive(Debug, Clone)]
pub struct UpdateStatus {
    pub release_id: String,
    pub version: String,
    pub artifact_sha256: String,
    pub phase: UpdatePhase,
    pub activation_record: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActivationRecord {
    release_id: String,
    version: String,
    artifact_sha256: String,
    target_path: PathBuf,
    staged_path: PathBuf,
    backup_path: PathBuf,
    #[serde(default)]
    restart_args: Vec<String>,
    #[serde(default)]
    service_mode: bool,
    #[serde(default)]
    launcher_pid: u32,
    #[serde(default)]
    rollback_requested: bool,
    #[serde(default)]
    installed: bool,
    #[serde(default)]
    helper_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationOutcome {
    NoRestartNeeded,
    RestartScheduled,
}

#[allow(dead_code)]
pub fn verify_manifest(manifest: &Value, current_version: &str) -> Result<ReleasePayload, String> {
    verify_manifest_for_update(manifest, current_version, false)
}

fn verify_manifest_for_update(
    manifest: &Value,
    current_version: &str,
    allow_equal: bool,
) -> Result<ReleasePayload, String> {
    let payload = decode_verified_manifest(manifest)?;
    validate_release_payload(&payload)?;
    let order = compare_versions(&payload.version, current_version)?;
    if order < 0 || (!allow_equal && order == 0) {
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

fn decode_verified_manifest(manifest: &Value) -> Result<ReleasePayload, String> {
    let raw: SignedManifest = serde_json::from_value(manifest.clone())
        .map_err(|_| "malformed signed manifest".to_string())?;
    let payload_bytes = decode_base64(&raw.signed_payload)
        .map_err(|_| "manifest payload is not base64".to_string())?;
    let signature_bytes = decode_base64(&raw.signature)
        .map_err(|_| "manifest signature is not base64".to_string())?;
    let key = trusted_key(&raw.key_id)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(&payload_bytes, &signature_bytes)
        .map_err(|_| "manifest signature verification failed".to_string())?;
    serde_json::from_slice(&payload_bytes).map_err(|_| "malformed release payload".to_string())
}

fn decode_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| STANDARD.decode(value))
}

fn validate_release_payload(payload: &ReleasePayload) -> Result<(), String> {
    if payload.schema != "linkwatch.agent-release/v1"
        || payload.release_id.trim().is_empty()
        || payload.version.trim().is_empty()
        || payload.min_agent_version.trim().is_empty()
    {
        return Err("invalid release metadata".into());
    }
    if !safe_path_component(&payload.release_id)
        || !payload.artifact_url.starts_with("https://")
        || payload.artifact_url.contains('@')
        || payload.artifact_size <= 0
        || payload.artifact_sha256.len() != 64
        || !payload
            .artifact_sha256
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("unsafe or incomplete artifact metadata".into());
    }
    Ok(())
}

fn safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || b"-_.".contains(&character))
}

pub fn apply_command(
    command: &Value,
    current_version: &str,
    queue_dir: &Path,
) -> Result<UpdateStatus, String> {
    let manifest = command.get("manifest").ok_or("update manifest missing")?;
    let payload = verify_manifest_for_update(manifest, current_version, true)?;
    if let Some(command_release_id) = command.get("release_id").and_then(Value::as_str) {
        if command_release_id != payload.release_id {
            return Err("update command release id does not match manifest".into());
        }
    }

    fs::create_dir_all(queue_dir).map_err(|error| format!("create update directory: {error}"))?;
    let activation_record = activation_record_path(queue_dir);
    let version_order = compare_versions(&payload.version, current_version)?;
    if let Some(record) = read_activation_record(&activation_record)? {
        if record.release_id != payload.release_id || record.version != payload.version {
            return Err("another update activation is pending".into());
        }
        if record.artifact_sha256 != payload.artifact_sha256.to_ascii_lowercase() {
            return Err("pending update artifact hash does not match manifest".into());
        }
        if record.version == current_version {
            return Ok(UpdateStatus {
                release_id: record.release_id,
                version: record.version,
                artifact_sha256: record.artifact_sha256,
                phase: UpdatePhase::AlreadyCurrent,
                activation_record,
            });
        }
        return Ok(UpdateStatus {
            release_id: record.release_id,
            version: record.version,
            artifact_sha256: record.artifact_sha256,
            phase: UpdatePhase::Installing,
            activation_record,
        });
    }
    if version_order == 0 {
        return Ok(UpdateStatus {
            release_id: payload.release_id,
            version: payload.version,
            artifact_sha256: payload.artifact_sha256.to_ascii_lowercase(),
            phase: UpdatePhase::AlreadyCurrent,
            activation_record,
        });
    }

    let staged = stage_artifact(&payload, queue_dir)?;
    let target = target_binary_path()?;
    prepare_activation(
        &payload.release_id,
        &payload.version,
        &payload.artifact_sha256,
        &staged,
        queue_dir,
        &target,
    )
}

fn stage_artifact(payload: &ReleasePayload, queue_dir: &Path) -> Result<PathBuf, String> {
    let staged = queue_dir.join(format!(
        "update-{}{}",
        payload.release_id, ACTIVATION_VERIFIED_SUFFIX
    ));
    if staged.exists() {
        if verify_staged_artifact(&staged, payload.artifact_size, &payload.artifact_sha256)? {
            return Ok(staged);
        }
        remove_file_if_exists(&staged)?;
    }
    let partial = queue_dir.join(format!(
        "update-{}{}",
        payload.release_id, ACTIVATION_PART_SUFFIX
    ));
    remove_file_if_exists(&partial)?;
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("build update HTTP client: {error}"))?
        .get(&payload.artifact_url)
        .send()
        .map_err(|error| format!("download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }
    let mut response = response;
    if let Err(error) = write_verified_artifact(
        &mut response,
        payload.artifact_size,
        &payload.artifact_sha256,
        &partial,
        &staged,
    ) {
        let _ = remove_file_if_exists(&partial);
        let _ = remove_file_if_exists(&staged);
        return Err(error);
    }
    Ok(staged)
}

fn write_verified_artifact<R: Read>(
    reader: &mut R,
    expected_size: i64,
    expected_sha256: &str,
    partial: &Path,
    staged: &Path,
) -> Result<(), String> {
    let mut file =
        File::create(partial).map_err(|error| format!("stage artifact failed: {error}"))?;
    let mut context = digest::Context::new(&digest::SHA256);
    let mut total = 0i64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("read artifact failed: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as i64)
            .ok_or("artifact size overflow")?;
        if total > expected_size {
            return Err("artifact size mismatch".into());
        }
        context.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|error| format!("write staged artifact failed: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("flush staged artifact failed: {error}"))?;
    if total != expected_size {
        return Err("artifact size mismatch".into());
    }
    let actual = hex_digest(context.finish());
    if actual != expected_sha256.to_ascii_lowercase() {
        return Err("artifact hash mismatch".into());
    }
    replace_file(partial, staged)
        .map_err(|error| format!("finalize staged artifact failed: {error}"))
}

fn verify_staged_artifact(
    path: &Path,
    expected_size: i64,
    expected_sha256: &str,
) -> Result<bool, String> {
    let mut file =
        File::open(path).map_err(|error| format!("read staged artifact failed: {error}"))?;
    let mut context = digest::Context::new(&digest::SHA256);
    let mut total = 0i64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read staged artifact failed: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as i64)
            .ok_or("artifact size overflow")?;
        context.update(&buffer[..read]);
    }
    Ok(total == expected_size
        && hex_digest(context.finish()) == expected_sha256.to_ascii_lowercase())
}

fn hex_digest(value: digest::Digest) -> String {
    value
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn prepare_activation(
    release_id: &str,
    version: &str,
    artifact_sha256: &str,
    staged: &Path,
    queue_dir: &Path,
    target: &Path,
) -> Result<UpdateStatus, String> {
    let activation_record = activation_record_path(queue_dir);
    let record = ActivationRecord {
        release_id: release_id.to_string(),
        version: version.to_string(),
        artifact_sha256: artifact_sha256.to_ascii_lowercase(),
        target_path: target.to_path_buf(),
        staged_path: staged.to_path_buf(),
        backup_path: target.with_extension("previous"),
        restart_args: Vec::new(),
        service_mode: false,
        launcher_pid: 0,
        rollback_requested: false,
        installed: false,
        helper_path: None,
    };
    write_activation_record(&activation_record, &record)?;

    #[cfg(not(windows))]
    {
        if let Err(error) = install_unix(&record) {
            let _ = rollback_record(&activation_record, &record);
            return Err(error);
        }
        let mut installed_record = record.clone();
        installed_record.installed = true;
        if let Err(error) = write_activation_record(&activation_record, &installed_record) {
            let _ = rollback_record(&activation_record, &installed_record);
            return Err(error);
        }
    }

    Ok(UpdateStatus {
        release_id: release_id.to_string(),
        version: version.to_string(),
        artifact_sha256: artifact_sha256.to_ascii_lowercase(),
        phase: UpdatePhase::Installing,
        activation_record,
    })
}

#[cfg(not(windows))]
fn install_unix(record: &ActivationRecord) -> Result<(), String> {
    if record.target_path.exists() {
        fs::copy(&record.target_path, &record.backup_path)
            .map_err(|error| format!("preserve known-good binary failed: {error}"))?;
    }
    let temporary = record.target_path.with_extension("new");
    remove_file_if_exists(&temporary)?;
    fs::copy(&record.staged_path, &temporary)
        .map_err(|error| format!("prepare atomic install failed: {error}"))?;
    if let Ok(metadata) = record.target_path.metadata() {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temporary, permissions)
            .map_err(|error| format!("set installed binary permissions failed: {error}"))?;
    } else {
        let mut permissions = fs::metadata(&temporary)
            .map_err(|error| format!("read staged binary permissions failed: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temporary, permissions)
            .map_err(|error| format!("set installed binary permissions failed: {error}"))?;
    }
    fs::rename(&temporary, &record.target_path).map_err(|error| {
        let _ = restore_backup(record);
        format!("install failed; rollback restored: {error}")
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
    decode_base64(&value)
        .map_err(|_| "invalid update trust anchor".into())
        .and_then(|key| {
            if key.len() == 32 {
                Ok(key)
            } else {
                Err("invalid update trust anchor length".into())
            }
        })
}

fn target_binary_path() -> Result<PathBuf, String> {
    std::env::var_os("LINKWATCH_AGENT_BINARY")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .ok_or_else(|| "agent binary path unavailable".into())
}

pub fn running_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn ack_payload(status: &UpdateStatus, previous_boot_id: &str) -> Value {
    let phase = match status.phase {
        UpdatePhase::AlreadyCurrent => "ALREADY_CURRENT",
        UpdatePhase::Installing => "INSTALLING",
    };
    json!({
        "status": phase,
        "release_id": status.release_id,
        "version": status.version,
        "artifact_sha256": status.artifact_sha256,
        "restart_requested": status.phase == UpdatePhase::Installing,
        "previous_version": running_version(),
        "previous_boot_id": if previous_boot_id.is_empty() { Value::Null } else { Value::String(previous_boot_id.to_string()) },
    })
}

pub fn activate_pending(
    status: &UpdateStatus,
    restart_args: &[String],
    service_mode: bool,
) -> Result<ActivationOutcome, String> {
    if status.phase == UpdatePhase::AlreadyCurrent {
        return Ok(ActivationOutcome::NoRestartNeeded);
    }
    let mut record = read_activation_record(&status.activation_record)?
        .ok_or("activation record missing after installation")?;
    #[cfg(unix)]
    if !record.installed {
        let _ = rollback_record(&status.activation_record, &record);
        return Err("activation record is not marked installed".into());
    }
    record.restart_args = restart_args.to_vec();
    record.service_mode = service_mode;
    record.launcher_pid = std::process::id();
    #[cfg(windows)]
    {
        let helper_path = record.helper_path.clone().unwrap_or_else(|| {
            status
                .activation_record
                .with_file_name("linkwatch-update-helper.exe")
        });
        if !helper_path.exists() {
            let current = std::env::current_exe()
                .map_err(|error| format!("locate agent binary for update helper: {error}"))?;
            fs::copy(&current, &helper_path)
                .map_err(|error| format!("copy update helper: {error}"))?;
        }
        record.helper_path = Some(helper_path);
    }
    write_activation_record(&status.activation_record, &record)?;

    #[cfg(unix)]
    {
        if let Err(error) = spawn_activation_watchdog(&status.activation_record) {
            let _ = rollback_record(&status.activation_record, &record);
            return Err(format!("start activation watchdog: {error}"));
        }
        let error = Command::new(&record.target_path).args(restart_args).exec();
        let rollback = rollback_record(&status.activation_record, &record);
        return Err(match rollback {
            Ok(()) => format!("activation exec failed: {error}"),
            Err(rollback_error) => {
                format!("activation exec failed: {error}; rollback failed: {rollback_error}")
            }
        });
    }

    #[cfg(windows)]
    {
        let helper = record
            .helper_path
            .clone()
            .ok_or("Windows update helper path missing")?;
        if let Err(error) = Command::new(helper)
            .args([
                "--apply-update-helper".to_string(),
                status.activation_record.to_string_lossy().into_owned(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = rollback_record(&status.activation_record, &record);
            return Err(format!("start Windows update helper: {error}"));
        }
        return Ok(ActivationOutcome::RestartScheduled);
    }

    #[allow(unreachable_code)]
    Ok(ActivationOutcome::RestartScheduled)
}

pub fn resume_activation_guard(queue_dir: &Path, version: &str) -> Result<(), String> {
    let record_path = activation_record_path(queue_dir);
    let Some(mut record) = read_activation_record(&record_path)? else {
        return Ok(());
    };
    if record.version != version || !record.installed {
        return Ok(());
    }
    record.launcher_pid = std::process::id();
    write_activation_record(&record_path, &record)?;
    spawn_activation_watchdog(&record_path)
}

pub fn handle_heartbeat_response(
    response: &Value,
    queue_dir: &Path,
    version: &str,
) -> Result<(), String> {
    let Some(status) = response
        .get("update_activation")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    match status {
        "SUCCEEDED" => finalize_activation(queue_dir, version),
        "ROLLED_BACK" => rollback_after_rejected_activation(queue_dir),
        _ => Ok(()),
    }
}

fn rollback_after_rejected_activation(queue_dir: &Path) -> Result<(), String> {
    let record_path = activation_record_path(queue_dir);
    let Some(record) = read_activation_record(&record_path)? else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        rollback_record(&record_path, &record)?;
        let error = Command::new(&record.target_path)
            .args(&record.restart_args)
            .exec();
        return Err(format!("restart known-good binary after rollback: {error}"));
    }
    #[cfg(windows)]
    {
        let mut record = record;
        record.rollback_requested = true;
        write_activation_record(&record_path, &record)?;
        let helper = record
            .helper_path
            .clone()
            .ok_or("Windows rollback helper path missing")?;
        Command::new(helper)
            .args([
                "--apply-update-helper".to_string(),
                record_path.to_string_lossy().into_owned(),
            ])
            .spawn()
            .map_err(|error| format!("start Windows rollback helper: {error}"))?;
        std::process::exit(0);
    }
    #[cfg(not(any(unix, windows)))]
    Ok(())
}

pub fn finalize_activation(queue_dir: &Path, version: &str) -> Result<(), String> {
    let record_path = activation_record_path(queue_dir);
    let Some(record) = read_activation_record(&record_path)? else {
        return Ok(());
    };
    if record.version != version {
        return Err(format!(
            "activation confirmation version {} does not match running version {version}",
            record.version
        ));
    }
    remove_file_if_exists(&record.backup_path)?;
    remove_file_if_exists(&record.staged_path)?;
    remove_file_if_exists(&record_path)
}

#[cfg(test)]
fn rollback_pending(queue_dir: &Path) -> Result<(), String> {
    let record_path = activation_record_path(queue_dir);
    let Some(record) = read_activation_record(&record_path)? else {
        return Ok(());
    };
    rollback_record(&record_path, &record)
}

pub fn run_activation_watchdog(record_path: &Path) -> Result<(), String> {
    let Some(record) = read_activation_record(record_path)? else {
        return Ok(());
    };
    let deadline = Instant::now() + activation_timeout();
    loop {
        if !record_path.exists() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = terminate_process(record.launcher_pid);
            rollback_record(record_path, &record)?;
            restart_after_rollback(&record)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
}

pub fn run_activation_helper(record_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let Some(mut record) = read_activation_record(record_path)? else {
            return Ok(());
        };
        if record.rollback_requested {
            rollback_record(record_path, &record)?;
            return restart_after_rollback(&record);
        }
        if let Err(error) = install_windows(&record) {
            let _ = rollback_record(record_path, &record);
            let _ = restart_after_rollback(&record);
            return Err(error);
        }
        record.installed = true;
        if let Err(error) = write_activation_record(record_path, &record) {
            let _ = rollback_record(record_path, &record);
            let _ = restart_after_rollback(&record);
            return Err(error);
        }
        let child_pid = launch_replacement(&record)?;
        return wait_for_activation(record_path, &record, child_pid);
    }

    #[cfg(not(windows))]
    {
        let _ = record_path;
        Err("Windows update helper is unavailable on this platform".into())
    }
}

fn activation_record_path(queue_dir: &Path) -> PathBuf {
    queue_dir.join(ACTIVATION_RECORD_NAME)
}

fn read_activation_record(path: &Path) -> Result<Option<ActivationRecord>, String> {
    match fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|error| format!("parse activation record: {error}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read activation record: {error}")),
    }
}

fn write_activation_record(path: &Path, record: &ActivationRecord) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let raw = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("serialize activation record: {error}"))?;
    let mut file = File::create(&temporary)
        .map_err(|error| format!("write activation record: {error}"))?;
    file.write_all(&raw)
        .map_err(|error| format!("write activation record: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("flush activation record: {error}"))?;
    replace_file(&temporary, path).map_err(|error| format!("commit activation record: {error}"))
}

fn rollback_record(path: &Path, record: &ActivationRecord) -> Result<(), String> {
    restore_backup(record)?;
    remove_file_if_exists(&record.target_path.with_extension("new"))?;
    remove_file_if_exists(&record.target_path.with_extension("rollback"))?;
    remove_file_if_exists(&record.staged_path)?;
    remove_file_if_exists(&record.backup_path)?;
    remove_file_if_exists(path)
}

fn restore_backup(record: &ActivationRecord) -> Result<(), String> {
    if !record.backup_path.exists() {
        return Ok(());
    }
    let temporary = record.target_path.with_extension("rollback");
    remove_file_if_exists(&temporary)?;
    fs::copy(&record.backup_path, &temporary)
        .map_err(|error| format!("prepare rollback binary failed: {error}"))?;
    #[cfg(windows)]
    remove_file_if_exists(&record.target_path)?;
    replace_file(&temporary, &record.target_path)
        .map_err(|error| format!("restore known-good binary failed: {error}"))
}

fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = fs::remove_file(target);
    }
    fs::rename(source, target)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

fn activation_timeout() -> Duration {
    std::env::var("LINKWATCH_UPDATE_ACTIVATION_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .map(Duration::from_secs)
        .unwrap_or(ACTIVATION_TIMEOUT)
}

fn spawn_activation_watchdog(record_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let launcher = read_activation_record(record_path)?
        .and_then(|record| record.helper_path)
        .ok_or("Windows activation watchdog helper path missing")?;
    #[cfg(not(windows))]
    let launcher =
        std::env::current_exe().map_err(|error| format!("locate activation watchdog: {error}"))?;
    Command::new(launcher)
        .args([
            "--activation-watchdog".to_string(),
            record_path.to_string_lossy().into_owned(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("start activation watchdog: {error}"))?;
    Ok(())
}

fn terminate_process(pid: u32) -> Result<(), String> {
    if pid == 0 || pid == std::process::id() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|error| format!("terminate failed activation process: {error}"))?;
        if !status.success() {
            return Err(format!(
                "terminate failed activation process returned {status}"
            ));
        }
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("terminate failed activation process: {error}"))?;
        if !status.success() {
            return Err(format!(
                "terminate failed activation process returned {status}"
            ));
        }
    }
    Ok(())
}

fn restart_after_rollback(record: &ActivationRecord) -> Result<(), String> {
    #[cfg(windows)]
    if record.service_mode {
        return start_windows_service();
    }
    Command::new(&record.target_path)
        .args(&record.restart_args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("restart known-good binary: {error}"))
}

#[cfg(windows)]
fn install_windows(record: &ActivationRecord) -> Result<(), String> {
    let deadline = Instant::now() + activation_timeout();
    loop {
        if record.target_path.exists() && !record.backup_path.exists() {
            if let Err(error) = fs::copy(&record.target_path, &record.backup_path) {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "preserve known-good Windows binary failed: {error}"
                    ));
                }
                thread::sleep(Duration::from_millis(250));
                continue;
            }
        }
        let temporary = record.target_path.with_extension("new");
        if let Err(error) = (|| -> Result<(), String> {
            remove_file_if_exists(&temporary)?;
            fs::copy(&record.staged_path, &temporary)
                .map_err(|error| format!("prepare Windows install failed: {error}"))?;
            remove_file_if_exists(&record.target_path)?;
            replace_file(&temporary, &record.target_path)
                .map_err(|error| format!("replace Windows binary failed: {error}"))
        })() {
            if Instant::now() >= deadline {
                return Err(error);
            }
            thread::sleep(Duration::from_millis(250));
            continue;
        }
        return Ok(());
    }
}

#[cfg(windows)]
fn launch_replacement(record: &ActivationRecord) -> Result<Option<u32>, String> {
    if record.service_mode {
        start_windows_service()?;
        return Ok(None);
    }
    Command::new(&record.target_path)
        .args(&record.restart_args)
        .spawn()
        .map(|child| Some(child.id()))
        .map_err(|error| format!("start updated Windows agent: {error}"))
}

#[cfg(windows)]
fn start_windows_service() -> Result<(), String> {
    let deadline = Instant::now() + activation_timeout();
    loop {
        let status = Command::new("sc.exe")
            .args(["start", "LINKWATCH"])
            .status()
            .map_err(|error| format!("start LINKWATCH service: {error}"))?;
        if status.success() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("sc.exe start LINKWATCH failed with {status}"));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(windows)]
fn wait_for_activation(
    record_path: &Path,
    record: &ActivationRecord,
    child_pid: Option<u32>,
) -> Result<(), String> {
    let deadline = Instant::now() + activation_timeout();
    loop {
        if !record_path.exists() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            if let Some(pid) = child_pid {
                let _ = terminate_process(pid);
            } else {
                let _ = Command::new("sc.exe").args(["stop", "LINKWATCH"]).status();
            }
            rollback_record(record_path, record)?;
            restart_after_rollback(record)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
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
    use std::{process::Command, sync::Mutex};
    use tempfile::tempdir;

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn trusted_manifest(version: &str, artifact: &[u8]) -> Value {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let payload = serde_json::json!({
            "schema":"linkwatch.agent-release/v1",
            "release_id":"r1",
            "version":version,
            "min_agent_version":"0.1.0",
            "artifact_url":"https://example.test/a",
            "artifact_sha256":hex_digest(digest::digest(&digest::SHA256, artifact)),
            "artifact_size":artifact.len()
        });
        let payload_bytes = serde_json::to_vec(&payload).unwrap();
        std::env::set_var("LINKWATCH_UPDATE_KEY_ID", "primary");
        std::env::set_var(
            "LINKWATCH_UPDATE_PUBLIC_KEY",
            STANDARD.encode(pair.public_key().as_ref()),
        );
        serde_json::json!({
            "signed_payload":URL_SAFE_NO_PAD.encode(&payload_bytes),
            "signature":URL_SAFE_NO_PAD.encode(pair.sign(&payload_bytes).as_ref()),
            "key_id":"primary"
        })
    }

    #[test]
    fn rejects_malformed_and_tampered_manifest() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
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

    #[test]
    fn install_success_stays_installing_until_activation_confirmation() {
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let target = directory.path().join("agent");
        let staged = queue.join("update-r1.verified");
        fs::write(&target, b"old-running-binary").unwrap();
        fs::write(&staged, b"new-installed-binary").unwrap();
        let status = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, b"new-installed-binary")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        assert_eq!(status.phase, UpdatePhase::Installing);
        assert_eq!(fs::read(&target).unwrap(), b"new-installed-binary");
        assert!(status.activation_record.exists());
        assert_eq!(ack_payload(&status, "boot-old")["status"], "INSTALLING");
        rollback_pending(&queue).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"old-running-binary");
        assert!(!status.activation_record.exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_activation_restores_the_known_good_binary() {
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let target = directory.path().join("agent");
        let staged = queue.join("update-r1.verified");
        fs::write(&target, b"old-running-binary").unwrap();
        fs::write(&staged, b"new-installed-binary").unwrap();
        let status = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, b"new-installed-binary")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&target, permissions).unwrap();
        let error = activate_pending(&status, &[], false).unwrap_err();
        assert!(error.contains("activation exec failed"));
        assert_eq!(fs::read(&target).unwrap(), b"old-running-binary");
        assert!(!status.activation_record.exists());
    }

    #[test]
    fn heartbeat_success_finalizes_only_after_matching_running_version() {
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let target = directory.path().join("agent");
        let staged = queue.join("update-r1.verified");
        fs::write(&target, b"old-running-binary").unwrap();
        fs::write(&staged, b"new-installed-binary").unwrap();
        let status = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, b"new-installed-binary")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        let error = handle_heartbeat_response(
            &serde_json::json!({"update_activation":{"status":"SUCCEEDED"}}),
            &queue,
            "1.0.2",
        )
        .unwrap_err();
        assert!(error.contains("does not match running version"));
        assert!(status.activation_record.exists());
        handle_heartbeat_response(
            &serde_json::json!({"update_activation":{"status":"SUCCEEDED"}}),
            &queue,
            "1.0.1",
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new-installed-binary");
        assert!(!status.activation_record.exists());
        assert!(!target.with_extension("previous").exists());
        assert!(!staged.exists());
    }

    #[test]
    fn already_current_and_repeated_pending_release_are_deterministic() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let manifest = trusted_manifest("0.1.0", b"artifact");
        let command = serde_json::json!({"manifest":manifest,"release_id":"r1"});
        let status = apply_command(&command, "0.1.0", &queue).unwrap();
        assert_eq!(status.phase, UpdatePhase::AlreadyCurrent);
        assert_eq!(ack_payload(&status, "boot")["status"], "ALREADY_CURRENT");

        let target = directory.path().join("agent");
        let staged = queue.join("update-r1.verified");
        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new").unwrap();
        let pending = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, b"new")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        let repeated = apply_command(
            &serde_json::json!({"manifest":trusted_manifest("1.0.1", b"new"),"release_id":"r1"}),
            "0.1.0",
            &queue,
        )
        .unwrap();
        assert_eq!(repeated.phase, UpdatePhase::Installing);
        assert_eq!(repeated.version, pending.version);
        rollback_pending(&queue).unwrap();

        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new-current").unwrap();
        let _current = prepare_activation(
            "r1",
            running_version(),
            &hex_digest(digest::digest(&digest::SHA256, b"new-current")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        let already = apply_command(
            &serde_json::json!({"manifest":trusted_manifest(running_version(), b"new-current"),"release_id":"r1"}),
            running_version(),
            &queue,
        )
        .unwrap();
        assert_eq!(already.phase, UpdatePhase::AlreadyCurrent);
        assert_eq!(ack_payload(&already, "boot")["status"], "ALREADY_CURRENT");
        rollback_pending(&queue).unwrap();
    }

    struct InterruptedReader {
        returned: bool,
    }

    impl Read for InterruptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.returned {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "interrupted",
                ));
            }
            self.returned = true;
            buffer[..4].copy_from_slice(b"part");
            Ok(4)
        }
    }

    #[test]
    fn interrupted_download_never_promotes_partial_artifact() {
        let directory = tempdir().unwrap();
        let partial = directory.path().join("update.part");
        let staged = directory.path().join("update.verified");
        let mut reader = InterruptedReader { returned: false };
        let error = write_verified_artifact(
            &mut reader,
            8,
            &hex_digest(digest::digest(&digest::SHA256, b"partmore")),
            &partial,
            &staged,
        )
        .unwrap_err();
        assert!(error.contains("interrupted"));
        assert!(!staged.exists());
        remove_file_if_exists(&partial).unwrap();
    }

    #[test]
    fn invalid_artifact_hash_never_promotes_verified_file() {
        let directory = tempdir().unwrap();
        let partial = directory.path().join("update.part");
        let staged = directory.path().join("update.verified");
        let mut reader = io::Cursor::new(b"artifact".to_vec());
        let error = write_verified_artifact(&mut reader, 8, &"0".repeat(64), &partial, &staged)
            .unwrap_err();
        assert!(error.contains("hash mismatch"));
        assert!(!staged.exists());
        remove_file_if_exists(&partial).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exec_boundary_starts_the_new_binary_and_clears_confirmation_record() {
        if std::env::var_os("LINKWATCH_ACTIVATION_CHILD").is_some() {
            return;
        }
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let target = directory.path().join("agent.sh");
        let staged = queue.join("update-r1.verified");
        let running_version = directory.path().join("running-version");
        fs::write(&target, b"#!/bin/sh\nexit 17\n").unwrap();
        let new_script = format!(
            "#!/bin/sh\nprintf new-running-version > '{}'\n",
            running_version.display(),
        );
        fs::write(&staged, &new_script).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        let status = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, new_script.as_bytes())),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        let child = std::env::current_exe().unwrap();
        let output = Command::new(child)
            .args([
                "--exact",
                "update::tests::activation_exec_child",
                "--nocapture",
            ])
            .env("LINKWATCH_ACTIVATION_CHILD", "1")
            .env("LINKWATCH_ACTIVATION_RECORD", &status.activation_record)
            .env("LINKWATCH_ACTIVATION_QUEUE", &queue)
            .env("LINKWATCH_RUNNING_VERSION", &running_version)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child activation failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        thread::sleep(Duration::from_millis(300));
        assert_eq!(
            fs::read_to_string(running_version).unwrap(),
            "new-running-version"
        );
        assert!(status.activation_record.exists());
        handle_heartbeat_response(
            &serde_json::json!({"update_activation":{"status":"SUCCEEDED"}}),
            &queue,
            "1.0.1",
        )
        .unwrap();
        assert!(!status.activation_record.exists());
    }

    #[cfg(unix)]
    #[test]
    fn activation_exec_child() {
        if std::env::var_os("LINKWATCH_ACTIVATION_CHILD").is_none() {
            return;
        }
        let record_path = PathBuf::from(std::env::var_os("LINKWATCH_ACTIVATION_RECORD").unwrap());
        let status = UpdateStatus {
            release_id: "r1".into(),
            version: "1.0.1".into(),
            artifact_sha256: String::new(),
            phase: UpdatePhase::Installing,
            activation_record: record_path,
        };
        let args = vec![
            std::env::var("LINKWATCH_RUNNING_VERSION").unwrap(),
            status.activation_record.to_string_lossy().into_owned(),
        ];
        activate_pending(&status, &args, false).expect("activation exec should replace process");
        panic!("activation exec returned");
    }

    #[cfg(windows)]
    #[test]
    fn windows_prepare_keeps_running_target_until_helper_boundary() {
        let directory = tempdir().unwrap();
        let queue = directory.path().join("queue");
        fs::create_dir_all(&queue).unwrap();
        let target = directory.path().join("agent.exe");
        let staged = queue.join("update-r1.verified");
        fs::write(&target, b"old-running-binary").unwrap();
        fs::write(&staged, b"new-installed-binary").unwrap();
        let status = prepare_activation(
            "r1",
            "1.0.1",
            &hex_digest(digest::digest(&digest::SHA256, b"new-installed-binary")),
            &staged,
            &queue,
            &target,
        )
        .unwrap();
        assert_eq!(status.phase, UpdatePhase::Installing);
        assert_eq!(fs::read(&target).unwrap(), b"old-running-binary");
        rollback_pending(&queue).unwrap();
    }
}
