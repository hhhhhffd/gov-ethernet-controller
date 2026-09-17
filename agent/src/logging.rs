use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 1_048_576;
static LOGGER: OnceLock<Mutex<File>> = OnceLock::new();

pub fn init(queue_dir: &Path) -> Result<PathBuf, String> {
    let path = std::env::var_os("LINKWATCH_LOG_FILE")
        .or_else(|| std::env::var_os("VKO_LOG_FILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let root = if queue_dir.file_name().and_then(|name| name.to_str()) == Some("queue") {
                queue_dir.parent().unwrap_or(queue_dir)
            } else {
                queue_dir
            };
            root.join("logs").join("agent.log")
        });
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create log directory: {error}"))?;
    }
    if fs::metadata(&path)
        .map(|meta| meta.len() >= MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let rotated = path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        fs::rename(&path, rotated).map_err(|error| format!("rotate operational log: {error}"))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("open operational log: {error}"))?;
    let _ = LOGGER.set(Mutex::new(file));
    Ok(path)
}

pub fn event(message: impl AsRef<str>) {
    let Some(logger) = LOGGER.get() else { return };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Ok(mut file) = logger.lock() {
        let _ = writeln!(file, "{timestamp} {}", message.as_ref());
        let _ = file.flush();
    }
}
