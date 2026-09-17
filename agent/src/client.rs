use crate::{config::Config, queue::Queue};
use serde_json::{json, Value};
use std::time::Duration;

const UPLOAD_FETCH_LIMIT: usize = 100;
const UPLOAD_BATCH_SIZE: usize = 50;

#[derive(Debug, Clone, Default)]
pub struct HeartbeatTelemetry {
    pub boot_id: Option<String>,
    pub boot_started_at: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub queue_depth: Option<usize>,
    pub last_probe_at: Option<String>,
    pub last_probe_status: Option<String>,
}

pub struct Client {
    config: Config,
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new(config: Config) -> Result<Self, String> {
        let http = build_http_client(&config)?;
        Ok(Self { config, http })
    }

    pub fn update_config(&mut self, config: Config) {
        self.config = config;
    }
    pub fn upload_pending(&self, queue: &Queue) -> Result<(usize, usize), String> {
        self.upload_pending_with(queue, |payloads| self.post_batch(payloads))
    }

    fn upload_pending_with<F>(
        &self,
        queue: &Queue,
        mut post_batch: F,
    ) -> Result<(usize, usize), String>
    where
        F: FnMut(&[Value]) -> Result<Value, String>,
    {
        let pending = queue
            .pending(UPLOAD_FETCH_LIMIT)
            .map_err(|error| format!("read queue: {error}"))?;
        let mut uploaded = 0usize;
        for batch in pending.chunks(UPLOAD_BATCH_SIZE) {
            let payloads = batch
                .iter()
                .map(|(_, payload)| payload.clone())
                .collect::<Vec<_>>();
            let response = match post_batch(&payloads) {
                Ok(response) => response,
                Err(error) => {
                    eprintln!("linkwatch-agent: upload batch failed: {error}");
                    break;
                }
            };
            let mut progressed = false;
            for (path, payload) in batch {
                if acknowledged(&response, payload) {
                    queue
                        .remove(path)
                        .map_err(|error| format!("remove acknowledged queue item: {error}"))?;
                    uploaded += 1;
                    progressed = true;
                } else if let Some(rejection) = permanent_rejection(&response, payload) {
                    queue
                        .reject(path, &rejection.error_code, &rejection.error)
                        .map_err(|error| format!("quarantine rejected queue item: {error}"))?;
                    eprintln!(
                        "linkwatch-agent: permanently rejected {} ({})",
                        rejection.event_id, rejection.error_code
                    );
                    progressed = true;
                }
            }
            // A successful HTTP response that acknowledges nothing is not
            // safe to interpret as progress for this batch. Leave its items
            // intact, but continue with later batches so permanently rejected
            // or malformed items cannot starve otherwise valid observations.
            if !progressed {
                continue;
            }
        }
        let remaining = queue
            .count()
            .map_err(|error| format!("count queue: {error}"))?;
        Ok((uploaded, remaining))
    }
    fn post_batch(&self, payloads: &[Value]) -> Result<Value, String> {
        let url = format!(
            "{}/api/v1/agent/measurements:batch",
            self.config.server_url.trim_end_matches('/')
        );
        let response = self
            .http
            .post(url)
            .header("X-Device-ID", &self.config.device_id)
            .header("X-Device-Token", &self.config.device_token)
            .json(&json!({"measurements":payloads}))
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("server returned HTTP {}", response.status()));
        }
        response
            .json()
            .map_err(|error| format!("decode server response: {error}"))
    }
    pub fn heartbeat(&self, telemetry: &HeartbeatTelemetry) -> Result<Value, String> {
        let url = format!(
            "{}/api/v1/agent/heartbeat",
            self.config.server_url.trim_end_matches('/')
        );
        let payload = heartbeat_payload(&self.config.agent_version, telemetry);
        let response = self
            .http
            .post(url)
            .header("X-Device-ID", &self.config.device_id)
            .header("X-Device-Token", &self.config.device_token)
            .json(&payload)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("server returned HTTP {}", response.status()));
        }
        response
            .json()
            .map_err(|error| format!("decode heartbeat response: {error}"))
    }
    pub fn server_config(&self) -> Result<Value, String> {
        let url = format!(
            "{}/api/v1/agent/config",
            self.config.server_url.trim_end_matches('/')
        );
        let response = self
            .http
            .get(url)
            .header("X-Device-ID", &self.config.device_id)
            .header("X-Device-Token", &self.config.device_token)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("server returned HTTP {}", response.status()));
        }
        response
            .json()
            .map_err(|error| format!("decode config response: {error}"))
    }
}

fn heartbeat_payload(agent_version: &str, telemetry: &HeartbeatTelemetry) -> Value {
    json!({
        "agent_version": agent_version,
        "boot_id": telemetry.boot_id,
        "boot_started_at": telemetry.boot_started_at,
        "uptime_seconds": telemetry.uptime_seconds,
        "queue_depth": telemetry.queue_depth,
        "last_probe_at": telemetry.last_probe_at,
        "last_probe_status": telemetry.last_probe_status,
    })
}

fn build_http_client(config: &Config) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(config.probe.timeout_seconds.max(1)))
        .build()
        .map_err(|error| format!("build HTTP client: {error}"))
}

fn acknowledged(response: &Value, payload: &Value) -> bool {
    let Some(event_id) = payload.get("client_event_id").and_then(Value::as_str) else {
        return false;
    };
    response
        .get("results")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("client_event_id").and_then(Value::as_str) == Some(event_id)
                    && item.get("accepted").and_then(Value::as_bool) == Some(true)
            })
        })
        .unwrap_or_else(|| {
            response.get("client_event_id").and_then(Value::as_str) == Some(event_id)
                && response.get("accepted").and_then(Value::as_bool) == Some(true)
        })
}

struct PermanentRejection {
    event_id: String,
    error_code: String,
    error: String,
}

fn permanent_rejection(response: &Value, payload: &Value) -> Option<PermanentRejection> {
    let event_id = payload.get("client_event_id").and_then(Value::as_str)?;
    let item = response
        .get("results")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("client_event_id").and_then(Value::as_str) == Some(event_id))
        })
        .or_else(|| {
            (response.get("client_event_id").and_then(Value::as_str) == Some(event_id))
                .then_some(response)
        })?;
    if item.get("accepted").and_then(Value::as_bool) != Some(false)
        || item.get("retryable").and_then(Value::as_bool) != Some(false)
    {
        return None;
    }
    Some(PermanentRejection {
        event_id: event_id.to_string(),
        error_code: item
            .get("error_code")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("rejected")
            .to_string(),
        error: item
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("server rejected measurement")
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{acknowledged, heartbeat_payload, permanent_rejection, Client, HeartbeatTelemetry};
    use crate::{config::Config, queue::Queue};
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn queue_ack_requires_matching_accepted_result() {
        let payload = json!({"client_event_id":"event-a"});
        assert!(acknowledged(
            &json!({"results":[{"client_event_id":"event-a","accepted":true}]}),
            &payload
        ));
        assert!(!acknowledged(
            &json!({"results":[{"client_event_id":"event-b","accepted":true}]}),
            &payload
        ));
        assert!(!acknowledged(
            &json!({"results":[{"client_event_id":"event-a","accepted":false}]}),
            &payload
        ));
    }

    #[test]
    fn heartbeat_payload_keeps_nullable_probe_snapshot_fields() {
        let payload = heartbeat_payload("0.1.0", &HeartbeatTelemetry::default());
        assert_eq!(payload["agent_version"], "0.1.0");
        assert!(payload["boot_id"].is_null());
        assert!(payload["boot_started_at"].is_null());
        assert!(payload["uptime_seconds"].is_null());
        assert!(payload["queue_depth"].is_null());
        assert!(payload["last_probe_at"].is_null());
        assert!(payload["last_probe_status"].is_null());

        let payload = heartbeat_payload(
            "0.1.0",
            &HeartbeatTelemetry {
                boot_id: Some("boot-1".into()),
                boot_started_at: Some("2026-09-17T00:00:00Z".into()),
                uptime_seconds: Some(7),
                queue_depth: Some(3),
                last_probe_at: Some("2026-09-17T00:00:00Z".into()),
                last_probe_status: Some("ok".into()),
            },
        );
        assert_eq!(payload["boot_id"], "boot-1");
        assert_eq!(payload["boot_started_at"], "2026-09-17T00:00:00Z");
        assert_eq!(payload["uptime_seconds"], 7);
        assert_eq!(payload["queue_depth"], 3);
        assert_eq!(payload["last_probe_status"], "ok");
    }

    #[test]
    fn unknown_or_retryable_rejections_are_not_quarantined() {
        let payload = json!({"client_event_id":"event-a"});
        assert!(permanent_rejection(
            &json!({"results":[{"client_event_id":"event-a","accepted":false,"retryable":true}]}),
            &payload
        )
        .is_none());
        assert!(permanent_rejection(
            &json!({"results":[{"client_event_id":"event-a","accepted":false}]}),
            &payload
        )
        .is_none());
    }

    #[test]
    fn rejected_batch_does_not_starve_a_later_batch() {
        let dir = tempdir().unwrap();
        let queue = Queue::open(dir.path()).unwrap();
        for index in 0..51 {
            let event_id = format!("event-{index:03}");
            queue
                .enqueue(&event_id, &json!({"client_event_id": event_id}))
                .unwrap();
        }
        let client = Client::new(Config::default()).unwrap();

        let mut batch_index = 0;
        let (uploaded, remaining) = client
            .upload_pending_with(&queue, |_payloads| {
                let response = if batch_index == 0 {
                    json!({
                        "results": [{
                            "client_event_id": "event-000",
                            "accepted": false,
                            "retryable": false,
                            "error_code": "invalid_measurement",
                            "error": "invalid payload"
                        }]
                    })
                } else {
                    json!({
                        "results": [{"client_event_id": "event-050", "accepted": true}]
                    })
                };
                batch_index += 1;
                Ok(response)
            })
            .unwrap();
        assert_eq!(uploaded, 1);
        assert_eq!(remaining, 49);
        assert!(!dir.path().join("event-050.json").exists());
        assert!(!dir.path().join("event-000.json").exists());
        assert!(dir.path().join("rejected/event-000.json").exists());
        assert!(dir
            .path()
            .join("rejected/event-000.json.error.json")
            .exists());
    }
}
