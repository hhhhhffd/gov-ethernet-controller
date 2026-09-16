use serde_json::Value;
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
        if let Ok(directory) = fs::File::open(&self.dir) {
            let _ = directory.sync_all();
        }
        Ok(final_path)
    }
    pub fn pending(&self, limit: usize) -> io::Result<Vec<(PathBuf, Value)>> {
        let mut entries = fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
            .map(|entry| {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(UNIX_EPOCH);
                (entry.path(), modified)
            })
            .collect::<Vec<_>>();
        // Filesystem mtime tracks enqueue order across restarts, while the
        // path tie-breaker keeps simultaneous writes deterministic.
        entries.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
        entries.truncate(limit);
        entries
            .into_iter()
            .map(|(path, _)| {
                let payload =
                    serde_json::from_slice(&fs::read(&path)?).map_err(io::Error::other)?;
                Ok((path, payload))
            })
            .collect()
    }
    pub fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)?;
        Ok(())
    }
    pub fn count(&self) -> io::Result<usize> {
        Ok(fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .count())
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
}
