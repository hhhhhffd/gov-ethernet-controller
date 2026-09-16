use crate::{config::Config, queue::Queue};
use serde_json::{json, Value};
use std::time::Duration;

pub struct Client {
    config: Config,
}

impl Client {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
    pub fn upload_pending(&self, queue: &Queue) -> Result<(usize, usize), String> {
        let pending = queue
            .pending(100)
            .map_err(|error| format!("read queue: {error}"))?;
        let mut uploaded = 0usize;
        for (path, payload) in pending {
            match self.post_batch(&payload) {
                Ok(response)
                    if response
                        .get("accepted")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        >= 1
                        || response
                            .get("results")
                            .and_then(Value::as_array)
                            .map(|items| !items.is_empty())
                            .unwrap_or(false) =>
                {
                    queue
                        .remove(&path)
                        .map_err(|error| format!("remove acknowledged queue item: {error}"))?;
                    uploaded += 1;
                }
                Ok(_) => break,
                Err(_) => break,
            }
        }
        let remaining = queue
            .count()
            .map_err(|error| format!("count queue: {error}"))?;
        Ok((uploaded, remaining))
    }
    fn post_batch(&self, payload: &Value) -> Result<Value, String> {
        let url = format!(
            "{}/api/v1/agent/measurements:batch",
            self.config.server_url.trim_end_matches('/')
        );
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(
                self.config.probe.timeout_seconds.max(1),
            ))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .post(url)
            .header("X-Device-ID", &self.config.device_id)
            .header("X-Device-Token", &self.config.device_token)
            .json(&json!({"measurements":[payload]}))
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
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(
                self.config.probe.timeout_seconds.max(1),
            ))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
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
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(
                self.config.probe.timeout_seconds.max(1),
            ))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
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
