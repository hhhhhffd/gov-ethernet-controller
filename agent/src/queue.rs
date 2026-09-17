use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct Queue {
    dir: PathBuf,
}

impl Queue {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let dir = path.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }
    pub fn enqueue(&self, event_id: &str, payload: &Value) -> io::Result<PathBuf> {
        let final_path = self.dir.join(format!("{event_id}.json"));
        if final_path.exists() {
            return Ok(final_path);
        }
        let temporary = self
            .dir
            .join(format!(".{event_id}.{}.tmp", std::process::id()));
        let data = serde_json::to_vec(payload).map_err(io::Error::other)?;
        {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&data)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &final_path)?;
        sync_directory(&self.dir)?;
        Ok(final_path)
    }

    pub fn state_path(&self) -> PathBuf {
        self.dir.join(".schedule-state")
    }

    pub fn dir_path(&self) -> PathBuf {
        self.dir.clone()
    }

    pub fn lock_path(&self) -> PathBuf {
        self.dir.join(".instance.lock")
    }

    pub fn pending(&self, limit: usize) -> io::Result<Vec<(PathBuf, Value)>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let modified = entry.metadata()?.modified()?;
            entries.push((entry.path(), modified));
        }
        // Filesystem mtime tracks enqueue order across restarts, while the
        // path tie-breaker keeps simultaneous writes deterministic.
        entries.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
        let mut pending = Vec::with_capacity(limit.min(entries.len()));
        for (path, _) in entries {
            if pending.len() >= limit {
                break;
            }
            let raw = fs::read(&path)?;
            match serde_json::from_slice::<Value>(&raw) {
                Ok(payload)
                    if payload
                        .get("client_event_id")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty() && value.len() <= 128)
                        .unwrap_or(false) =>
                {
                    pending.push((path, payload))
                }
                Ok(_) => self.quarantine(&path, "missing or invalid client_event_id")?,
                Err(error) => self.quarantine(&path, error)?,
            }
        }
        Ok(pending)
    }
    pub fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)?;
        sync_directory(&self.dir)?;
        Ok(())
    }

    /// Move a permanently rejected item out of the retry spool and retain a
    /// bounded diagnostic sidecar for operator inspection.
    pub fn reject(&self, path: &Path, error_code: &str, error: &str) -> io::Result<PathBuf> {
        let rejected = self.dir.join("rejected");
        fs::create_dir_all(&rejected)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("queue-item.json");
        let target = rejected.join(name);
        let target = if target.exists() {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            rejected.join(format!("{name}.{stamp}.rejected.json"))
        } else {
            target
        };
        let target_name = target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(name);
        fs::rename(path, &target)?;

        let metadata = json!({
            "error_code": bounded_text(error_code, 128),
            "error": bounded_text(error, 1024),
            "rejected_at": super::chrono_like_now(),
        });
        let metadata_path = rejected.join(format!("{target_name}.error.json"));
        let temporary = rejected.join(format!(".{target_name}.{}.tmp", std::process::id()));
        let data = serde_json::to_vec(&metadata).map_err(io::Error::other)?;
        {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&data)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &metadata_path)?;
        sync_directory(&rejected)?;
        sync_directory(&self.dir)?;
        Ok(target)
    }
    pub fn count(&self) -> io::Result<usize> {
        let mut count = 0;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                count += 1;
            }
        }
        Ok(count)
    }

    fn quarantine(&self, path: &Path, error: impl std::fmt::Display) -> io::Result<()> {
        let quarantine = self.dir.join("quarantine");
        fs::create_dir_all(&quarantine)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("queue-item.json");
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let target = quarantine.join(format!("{name}.{stamp}.invalid"));
        fs::rename(path, &target).map_err(|rename_error| {
            io::Error::new(
                rename_error.kind(),
                format!("quarantine malformed queue item ({error}): {rename_error}"),
            )
        })?;
        sync_directory(&quarantine)?;
        sync_directory(&self.dir)?;
        Ok(())
    }

    pub fn event_id(payload: &Value) -> String {
        payload
            .get("client_event_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "event-{}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            })
    }
}

/// Persist a directory entry update where the platform exposes directory
/// handles. Windows has no equivalent of Unix directory fsync, so the file
/// contents and atomic rename remain the durability boundary there.
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)?.sync_all()
    }
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn crash_safe_queue_round_trip() {
        let dir = tempdir().unwrap();
        let queue = Queue::open(dir.path()).unwrap();
        let event = serde_json::json!({"client_event_id":"a"});
        let path = queue.enqueue("a", &event).unwrap();
        assert!(path.exists());
        assert_eq!(queue.pending(10).unwrap().len(), 1);
        drop(queue);
        let queue = Queue::open(dir.path()).unwrap();
        assert_eq!(queue.pending(10).unwrap()[0].1, event);
        let replacement = serde_json::json!({"client_event_id":"a","value":2});
        let same_path = queue.enqueue("a", &replacement).unwrap();
        assert_eq!(same_path, path);
        assert_eq!(queue.pending(10).unwrap()[0].1, event);
        assert!(queue.remove(&dir.path().join("missing.json")).is_err());
        assert_eq!(queue.count().unwrap(), 1);
        queue.remove(&path).unwrap();
        assert_eq!(queue.count().unwrap(), 0);
    }

    #[test]
    fn malformed_items_are_quarantined_without_blocking_valid_items() {
        let dir = tempdir().unwrap();
        let queue = Queue::open(dir.path()).unwrap();
        fs::write(dir.path().join("bad.json"), b"{not-json").unwrap();
        queue
            .enqueue("good", &serde_json::json!({"client_event_id":"good"}))
            .unwrap();
        let pending = queue.pending(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1["client_event_id"], "good");
        assert_eq!(queue.count().unwrap(), 1);
        let quarantine = dir.path().join("quarantine");
        assert!(quarantine.exists());
        assert_eq!(fs::read_dir(quarantine).unwrap().count(), 1);
    }

    #[test]
    fn semantically_invalid_items_are_quarantined() {
        let dir = tempdir().unwrap();
        let queue = Queue::open(dir.path()).unwrap();
        fs::write(
            dir.path().join("missing-id.json"),
            br#"{"mode":"PERFORMANCE"}"#,
        )
        .unwrap();
        assert!(queue.pending(10).unwrap().is_empty());
        assert_eq!(queue.count().unwrap(), 0);
        assert_eq!(
            fs::read_dir(dir.path().join("quarantine")).unwrap().count(),
            1
        );
    }

    #[test]
    fn rejected_items_leave_retry_spool_with_bounded_metadata() {
        let dir = tempdir().unwrap();
        let queue = Queue::open(dir.path()).unwrap();
        let path = queue
            .enqueue(
                "bad-event",
                &serde_json::json!({"client_event_id":"bad-event"}),
            )
            .unwrap();
        let target = queue
            .reject(&path, &"x".repeat(200), &"e".repeat(2_000))
            .unwrap();

        assert!(!path.exists());
        assert!(target.exists());
        assert_eq!(queue.count().unwrap(), 0);
        let metadata = fs::read_to_string(
            dir.path()
                .join("rejected")
                .join("bad-event.json.error.json"),
        )
        .unwrap();
        assert!(metadata.contains("error_code"));
        assert!(metadata.len() < 1_300);

        let second_path = queue
            .enqueue(
                "bad-event",
                &serde_json::json!({"client_event_id":"bad-event","retry":true}),
            )
            .unwrap();
        let second_target = queue
            .reject(&second_path, "again", "second rejection")
            .unwrap();
        assert_ne!(target, second_target);
        assert!(target.exists());
        assert!(second_target.exists());
    }
}
