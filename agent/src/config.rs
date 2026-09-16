use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProbeConfig {
    pub targets: Vec<String>,
    pub ping_host: Option<String>,
    pub ping_port: u16,
    pub throughput_url: Option<String>,
    pub upload_url: Option<String>,
    pub throughput_duration_seconds: u64,
    pub timeout_seconds: u64,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            targets: vec!["https://www.google.com/generate_204".into()],
            ping_host: Some("1.1.1.1".into()),
            ping_port: 443,
            throughput_url: Some("https://speed.cloudflare.com/__down?bytes=1000000".into()),
            upload_url: Some("https://speed.cloudflare.com/__up".into()),
            throughput_duration_seconds: 3,
            timeout_seconds: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server_url: String,
    pub device_id: String,
    pub device_token: String,
    pub school_id: String,
    pub line_id: String,
    pub monitoring_point_id: String,
    pub agent_version: String,
    pub performance_tests_per_day: u8,
    pub jitter_minutes: u32,
    pub light_checks_between: bool,
    pub queue_dir: PathBuf,
    pub probe: ProbeConfig,
    pub probe_type: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "http://127.0.0.1:8080".into(),
            device_id: "device-42-primary".into(),
            device_token: "demo-device-42-primary-token".into(),
            school_id: "school-42".into(),
            line_id: "line-42-primary".into(),
            monitoring_point_id: "point-42-primary".into(),
            agent_version: env!("CARGO_PKG_VERSION").into(),
            performance_tests_per_day: 4,
            jitter_minutes: 8,
            light_checks_between: false,
            queue_dir: PathBuf::from(".linkwatch-agent/queue"),
            probe: ProbeConfig::default(),
            probe_type: "demo".into(),
        }
    }
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let mut config = Config::default();
        let mut file_probe_explicit = false;
        if let Ok(path) = env::var("LINKWATCH_CONFIG_FILE").or_else(|_| env::var("VKO_CONFIG_FILE"))
        {
            let raw = fs::read_to_string(&path)
                .map_err(|error| format!("read config file {path}: {error}"))?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("parse config file: {error}"))?;
            file_probe_explicit = value.get("probe_type").is_some();
            config = serde_json::from_value(value)
                .map_err(|error| format!("parse config file: {error}"))?;
        }
        config.apply_env();
        config.performance_tests_per_day = config.performance_tests_per_day.clamp(3, 5);
        config.jitter_minutes = config.jitter_minutes.min(240);
        config.probe.throughput_duration_seconds =
            config.probe.throughput_duration_seconds.clamp(3, 5);
        config.server_url = config.server_url.trim_end_matches('/').to_string();
        if config.server_url.is_empty() {
            return Err("server_url must not be empty".into());
        }
        let production = env::var("LINKWATCH_ENV")
            .or_else(|_| env::var("VKO_ENV"))
            .unwrap_or_default();
        // The legacy agent selected a real network probe automatically in
        // production. Keep that safe default for config files that omit the
        // probe selector, while still rejecting an explicitly requested demo
        // probe unless the operator opts in through the existing guard.
        let probe_env_explicit = first_env(&["LINKWATCH_PROBE", "VKO_PROBE"]).is_some();
        if production.eq_ignore_ascii_case("production")
            && !probe_env_explicit
            && !file_probe_explicit
            && config.probe_type.eq_ignore_ascii_case("demo")
        {
            config.probe_type = "network".into();
        }
        if production.eq_ignore_ascii_case("production")
            && !config.server_url.starts_with("https://")
        {
            return Err("LINKWATCH_SERVER_URL must use HTTPS in production".into());
        }
        if production.eq_ignore_ascii_case("production") && config.device_token.starts_with("demo-")
        {
            return Err("production requires a provisioned device token".into());
        }
        if config.device_id.is_empty()
            || config.device_token.is_empty()
            || config.line_id.is_empty()
            || config.monitoring_point_id.is_empty()
        {
            return Err(
                "device_id, device_token, line_id and monitoring_point_id are required".into(),
            );
        }
        Ok(config)
    }

    pub fn apply_server_config(&mut self, value: &Value) {
        let Some(schedule) = value.get("schedule") else {
            return;
        };
        if let Some(value) = schedule
            .get("performance_tests_per_day")
            .or_else(|| schedule.get("tests_per_day"))
            .and_then(Value::as_u64)
        {
            self.performance_tests_per_day = value.min(u8::MAX as u64) as u8;
        }
        if let Some(value) = schedule.get("jitter_minutes").and_then(Value::as_u64) {
            self.jitter_minutes = value.min(240) as u32;
        }
        if let Some(value) = schedule
            .get("light_checks_between")
            .and_then(Value::as_bool)
        {
            self.light_checks_between = value;
        }
        self.performance_tests_per_day = self.performance_tests_per_day.clamp(3, 5);
    }

    fn apply_env(&mut self) {
        macro_rules! text {
            ($field:ident, $($name:literal),+) => {
                if let Some(value) = first_env(&[$($name),+]) {
                    self.$field = value;
                }
            };
        }
        text!(server_url, "LINKWATCH_SERVER_URL", "VKO_SERVER_URL");
        text!(device_id, "LINKWATCH_DEVICE_ID", "VKO_DEVICE_ID");
        text!(device_token, "LINKWATCH_DEVICE_TOKEN", "VKO_DEVICE_TOKEN");
        text!(school_id, "LINKWATCH_SCHOOL_ID", "VKO_SCHOOL_ID");
        text!(line_id, "LINKWATCH_LINE_ID", "VKO_LINE_ID");
        text!(
            monitoring_point_id,
            "LINKWATCH_MONITORING_POINT_ID",
            "VKO_MONITORING_POINT_ID",
            "VKO_POINT_ID"
        );
        text!(
            agent_version,
            "LINKWATCH_AGENT_VERSION",
            "VKO_AGENT_VERSION"
        );
        text!(probe_type, "LINKWATCH_PROBE", "VKO_PROBE");
        if let Ok(value) = env::var("LINKWATCH_QUEUE_DIR")
            .or_else(|_| env::var("VKO_QUEUE_DIR"))
            .or_else(|_| env::var("VKO_BUFFER_PATH"))
        {
            if !value.is_empty() {
                self.queue_dir = PathBuf::from(value);
            }
        }
        if let Ok(value) =
            env::var("LINKWATCH_TESTS_PER_DAY").or_else(|_| env::var("VKO_TESTS_PER_DAY"))
        {
            if let Ok(parsed) = value.parse() {
                self.performance_tests_per_day = parsed;
            }
        }
        if let Ok(value) =
            env::var("LINKWATCH_JITTER_MINUTES").or_else(|_| env::var("VKO_JITTER_MINUTES"))
        {
            if let Ok(parsed) = value.parse() {
                self.jitter_minutes = parsed;
            }
        }
        if let Ok(value) = env::var("LINKWATCH_LIGHT_CHECKS_BETWEEN")
            .or_else(|_| env::var("VKO_LIGHT_CHECKS_BETWEEN"))
        {
            self.light_checks_between = matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            );
        }
        if let Ok(value) =
            env::var("LINKWATCH_PROBE_TARGETS").or_else(|_| env::var("VKO_PROBE_TARGETS"))
        {
            self.probe.targets = value
                .split(',')
                .filter(|item| !item.trim().is_empty())
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("LINKWATCH_PROBE_HOST").or_else(|_| env::var("VKO_PROBE_HOST"))
        {
            self.probe.ping_host = Some(value);
        }
        if let Ok(value) = env::var("LINKWATCH_PROBE_PORT").or_else(|_| env::var("VKO_PROBE_PORT"))
        {
            if let Ok(parsed) = value.parse() {
                self.probe.ping_port = parsed;
            }
        }
        if let Ok(value) =
            env::var("LINKWATCH_THROUGHPUT_URL").or_else(|_| env::var("VKO_THROUGHPUT_URL"))
        {
            self.probe.throughput_url = Some(value);
        }
        if let Ok(value) = env::var("LINKWATCH_UPLOAD_URL").or_else(|_| env::var("VKO_UPLOAD_URL"))
        {
            self.probe.upload_url = Some(value);
        }
        if let Ok(value) = env::var("LINKWATCH_THROUGHPUT_DURATION_SECONDS")
            .or_else(|_| env::var("VKO_THROUGHPUT_DURATION_SECONDS"))
        {
            if let Ok(parsed) = value.parse() {
                self.probe.throughput_duration_seconds = parsed;
            }
        }
        if let Ok(value) = env::var("LINKWATCH_PROBE_TIMEOUT_SECONDS")
            .or_else(|_| env::var("VKO_PROBE_TIMEOUT_SECONDS"))
        {
            if let Ok(parsed) = value.parse() {
                self.probe.timeout_seconds = parsed;
            }
        }
    }
}

fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_config_keeps_defaults_for_omitted_fields() {
        let config: Config = serde_json::from_str(
            r#"{"server_url":"https://monitoring.example","device_id":"device-1","device_token":"token-1","line_id":"line-1","monitoring_point_id":"point-1"}"#,
        )
        .expect("partial config should parse");
        assert_eq!(config.server_url, "https://monitoring.example");
        assert_eq!(config.performance_tests_per_day, 4);
        assert_eq!(config.probe.timeout_seconds, 5);
        assert_eq!(config.probe.throughput_duration_seconds, 3);
    }

    #[test]
    fn server_schedule_is_clamped_to_safe_bounds() {
        let mut config = Config::default();
        config.apply_server_config(&serde_json::json!({
            "schedule": {"performance_tests_per_day": 99, "jitter_minutes": 999}
        }));
        assert_eq!(config.performance_tests_per_day, 5);
        assert_eq!(config.jitter_minutes, 240);
    }
}
