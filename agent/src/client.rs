use crate::{config::Config, queue::Queue};
use serde_json::{json, Value};
use std::time::Duration;

const UPLOAD_FETCH_LIMIT: usize = 100;
const UPLOAD_BATCH_SIZE: usize = 50;

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
        let pending = queue
            .pending(UPLOAD_FETCH_LIMIT)
            .map_err(|error| format!("read queue: {error}"))?;
        let mut uploaded = 0usize;
        for batch in pending.chunks(UPLOAD_BATCH_SIZE) {
            let payloads = batch
                .iter()
                .map(|(_, payload)| payload.clone())
                .collect::<Vec<_>>();
            let response = match self.post_batch(&payloads) {
                Ok(response) => response,
                Err(_) => break,
            };
            let mut acknowledged_any = false;
            for (path, payload) in batch {
                if acknowledged(&response, payload) {
                    queue
                        .remove(path)
                        .map_err(|error| format!("remove acknowledged queue item: {error}"))?;
                    uploaded += 1;
                    acknowledged_any = true;
                }
            }
            // A successful HTTP response that acknowledges nothing is not
            // safe to interpret as progress. Leave the queue intact and retry
            // after the server contract or network becomes available.
            if !acknowledged_any {
                break;
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
    pub fn heartbeat(&self) -> Result<Value, String> {
        let url = format!(
            "{}/api/v1/agent/heartbeat",
            self.config.server_url.trim_end_matches('/')
        );
        let response = self
            .http
            .post(url)
            .header("X-Device-ID", &self.config.device_id)
            .header("X-Device-Token", &self.config.device_token)
            .json(&json!({"agent_version":self.config.agent_version}))
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

#[cfg(test)]
mod tests {
    use super::acknowledged;
    use serde_json::json;

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
}
