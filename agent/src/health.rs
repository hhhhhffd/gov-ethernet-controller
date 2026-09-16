use crate::config::Config;
use std::time::Duration;

#[allow(dead_code)]
pub fn server_reachable(config: &Config) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(config.probe.timeout_seconds.max(1)))
        .build()
        .and_then(|client| {
            client
                .get(format!(
                    "{}/health/live",
                    config.server_url.trim_end_matches('/')
                ))
                .send()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}
