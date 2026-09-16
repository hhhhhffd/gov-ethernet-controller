mod demo;
mod network;

use crate::config::Config;
use serde_json::Value;

pub trait Probe {
    fn measure(&mut self, mode: &str) -> Result<Value, String>;
}

pub fn build(config: &Config) -> Result<Box<dyn Probe>, String> {
    match config.probe_type.to_ascii_lowercase().as_str() {
        "demo" | "fixture" => {
            if std::env::var("LINKWATCH_ENV")
                .or_else(|_| std::env::var("VKO_ENV"))
                .unwrap_or_default()
                .eq_ignore_ascii_case("production")
                && std::env::var("LINKWATCH_ALLOW_DEMO_PROBE")
                    .or_else(|_| std::env::var("VKO_ALLOW_DEMO_PROBE"))
                    .ok()
                    .as_deref()
                    != Some("1")
            {
                return Err(
                    "DemoProbe is disabled in production; use LINKWATCH_PROBE=network".into(),
                );
            }
            Ok(Box::new(demo::DemoProbe::default()))
        }
        "network" | "real" | "production" => {
            Ok(Box::new(network::NetworkProbe::new(config.probe.clone())))
        }
        value => Err(format!(
            "unknown probe type {value}; expected demo or network"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn demo_probe_is_deterministic() {
        let mut probe = demo::DemoProbe::default();
        let first = probe.measure("performance").unwrap();
        assert_eq!(first["download"], 96.0);
        assert_eq!(first["connection_status"], "OK");
    }
}
