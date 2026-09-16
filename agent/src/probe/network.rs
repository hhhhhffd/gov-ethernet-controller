use super::Probe;
use crate::config::ProbeConfig;
use serde_json::{json, Map, Value};
use std::{
    io::Read,
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

const PING_SAMPLES: usize = 3;

pub struct NetworkProbe {
    config: ProbeConfig,
}

impl NetworkProbe {
    pub fn new(config: ProbeConfig) -> Self {
        Self { config }
    }
}

impl Probe for NetworkProbe {
    fn measure(&mut self, mode: &str) -> Result<Value, String> {
        if !mode.eq_ignore_ascii_case("light") && !mode.eq_ignore_ascii_case("performance") {
            return Err("mode must be light or performance".into());
        }
        let timeout = Duration::from_secs(self.config.timeout_seconds.max(1));
        let mut reachability = Vec::new();
        let mut successes = 0usize;
        let mut attempts = 0usize;
        let mut ping_samples = Vec::new();

        for target in &self.config.targets {
            let started = Instant::now();
            let result = http_head(target, timeout);
            let ok = result.is_ok();
            attempts += 1;
            if ok {
                successes += 1;
            }
            reachability.push(json!({
                "target": target,
                "ok": ok,
                "latency_ms": started.elapsed().as_secs_f64() * 1000.0,
                "error": result.err(),
            }));
        }

        if let Some(host) = &self.config.ping_host {
            let address = format!("{host}:{}", self.config.ping_port);
            for _ in 0..PING_SAMPLES {
                attempts += 1;
                let started = Instant::now();
                if tcp_check(&address, timeout).is_ok() {
                    successes += 1;
                    ping_samples.push(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
        }

        let connection_ok = successes > 0;
        let packet_loss = if attempts == 0 {
            100.0
        } else {
            (attempts - successes) as f64 / attempts as f64 * 100.0
        };
        let ping = average(&ping_samples);
        let jitter = if ping_samples.len() < 2 {
            None
        } else {
            Some(
                ping_samples
                    .windows(2)
                    .map(|pair| (pair[1] - pair[0]).abs())
                    .sum::<f64>()
                    / (ping_samples.len() - 1) as f64,
            )
        };
        let mut raw = Map::new();
        raw.insert("probe".into(), Value::String("network".into()));
        raw.insert("reachability".into(), Value::Array(reachability));
        raw.insert("ping_samples_ms".into(), json!(ping_samples));
        let availability = if attempts == 0 {
            0.0
        } else {
            successes as f64 / attempts as f64 * 100.0
        };
        let mut output = json!({
            "mode": if mode.eq_ignore_ascii_case("light") { "LIGHT" } else { "PERFORMANCE" },
            "download": null,
            "upload": null,
            "ping": ping,
            "jitter": jitter,
            "packet_loss": packet_loss,
            "availability": availability,
            "connection_status": if connection_ok { "OK" } else { "NO_INTERNET" },
            "raw": raw,
        });
        if mode.eq_ignore_ascii_case("performance") && connection_ok {
            if let Some(url) = &self.config.throughput_url {
                if let Ok(value) = download(url, timeout) {
                    output["download"] = json!(value);
                }
            }
            if let Some(url) = &self.config.upload_url {
                if let Ok(value) = upload(url, timeout) {
                    output["upload"] = json!(value);
                }
            }
        }
        Ok(output)
    }
}

fn average(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

fn http_head(url: &str, timeout: Duration) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.head(url).send().map_err(|error| error.to_string())?;
    if response.status().is_success() || response.status().is_redirection() {
        Ok(())
    } else {
        Err(format!("target returned HTTP {}", response.status()))
    }
}

fn tcp_check(address: &str, timeout: Duration) -> Result<(), String> {
    let mut addresses = address
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    let address = addresses.next().ok_or("target did not resolve")?;
    TcpStream::connect_timeout(&address, timeout)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn download(url: &str, timeout: Duration) -> Result<f64, String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }
    let mut reader = response.take(2 * 1024 * 1024);
    let mut bytes = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        bytes += read;
    }
    if bytes == 0 {
        return Err("download returned no bytes".into());
    }
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    Ok(bytes as f64 * 8.0 / seconds / 1_000_000.0)
}

fn upload(url: &str, timeout: Duration) -> Result<f64, String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let body = vec![0u8; 256 * 1024];
    let response = client
        .post(url)
        .header("Content-Type", "application/octet-stream")
        .body(body.clone())
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("upload returned HTTP {}", response.status()));
    }
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    Ok(body.len() as f64 * 8.0 / seconds / 1_000_000.0)
}
