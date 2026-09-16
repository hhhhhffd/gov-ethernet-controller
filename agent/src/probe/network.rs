use super::Probe;
use crate::config::ProbeConfig;
use serde_json::{json, Map, Value};
use std::{
    io::Read,
    net::{TcpStream, ToSocketAddrs},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const PING_SAMPLES: usize = 3;
const MAX_TRANSFER_BYTES: usize = 256 * 1024 * 1024;

struct TransferResult {
    mbps: f64,
    bytes: usize,
    requests: usize,
    elapsed_seconds: f64,
}

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
        let mut ping_attempts = 0usize;
        let mut ping_successes = 0usize;
        let mut ping_samples = Vec::new();
        let mut ping_methods = Vec::new();

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
                ping_attempts += 1;
                let started = Instant::now();
                let method = if icmp_check(host, timeout).is_ok() {
                    Some("icmp")
                } else if tcp_check(&address, timeout).is_ok() {
                    Some("tcp_connect")
                } else {
                    None
                };
                if let Some(method) = method {
                    successes += 1;
                    ping_successes += 1;
                    ping_samples.push(started.elapsed().as_secs_f64() * 1000.0);
                    ping_methods.push(method);
                }
            }
        }

        let connection_ok = successes > 0;
        // Packet loss describes the ping sample set, not the independent
        // reachability targets used for availability. Mixing those counts
        // would report loss whenever a target list contains an HTTP failure.
        let packet_loss = if ping_attempts == 0 {
            100.0
        } else {
            (ping_attempts - ping_successes) as f64 / ping_attempts as f64 * 100.0
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
        raw.insert("method_version".into(), Value::String("network-v2".into()));
        raw.insert("reachability".into(), Value::Array(reachability));
        raw.insert("ping_samples_ms".into(), json!(ping_samples));
        raw.insert("ping_methods".into(), json!(ping_methods));
        let latency_method = latency_method(&ping_methods);
        raw.insert(
            "latency_method".into(),
            Value::String(latency_method.into()),
        );
        raw.insert("ping_method".into(), Value::String(latency_method.into()));
        raw.insert("warmup".into(), Value::Bool(true));
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
            let target_duration =
                Duration::from_secs(self.config.throughput_duration_seconds.clamp(3, 5));
            output["raw"]["throughput_target_seconds"] = json!(target_duration.as_secs());
            if let Some(url) = &self.config.throughput_url {
                match download(url, timeout, target_duration) {
                    Ok(value) => {
                        output["download"] = json!(value.mbps);
                        output["raw"]["download_bytes"] = json!(value.bytes);
                        output["raw"]["download_requests"] = json!(value.requests);
                        output["raw"]["download_elapsed_seconds"] = json!(value.elapsed_seconds);
                    }
                    Err(error) => output["raw"]["download_error"] = json!(error),
                }
            }
            if let Some(url) = &self.config.upload_url {
                match upload(url, timeout, target_duration) {
                    Ok(value) => {
                        output["upload"] = json!(value.mbps);
                        output["raw"]["upload_bytes"] = json!(value.bytes);
                        output["raw"]["upload_requests"] = json!(value.requests);
                        output["raw"]["upload_elapsed_seconds"] = json!(value.elapsed_seconds);
                    }
                    Err(error) => output["raw"]["upload_error"] = json!(error),
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
    let status = response.status();
    if status.is_success() || status.is_redirection() {
        Ok(())
    } else if status == reqwest::StatusCode::METHOD_NOT_ALLOWED
        || status == reqwest::StatusCode::NOT_IMPLEMENTED
    {
        // Some captive portals and simple health endpoints do not implement
        // HEAD. A one-byte ranged GET still proves reachability without
        // turning the reachability check into a throughput test.
        let mut retry = client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .map_err(|error| error.to_string())?;
        if retry.status().is_success() || retry.status().is_redirection() {
            let mut byte = [0u8; 1];
            let _ = retry.read(&mut byte);
            Ok(())
        } else {
            Err(format!("target returned HTTP {}", retry.status()))
        }
    } else {
        Err(format!("target returned HTTP {status}"))
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

fn icmp_check(host: &str, timeout: Duration) -> Result<(), String> {
    #[cfg(windows)]
    let status = Command::new("ping.exe")
        .args([
            "-n",
            "1",
            "-w",
            &timeout.as_millis().clamp(1, u32::MAX as u128).to_string(),
            host,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    let status = Command::new("ping")
        .args(["-c", "1", "-W", &timeout.as_secs().max(1).to_string(), host])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("ICMP ping exited with {status}"))
    }
}

fn latency_method(methods: &[&str]) -> &'static str {
    if methods.is_empty() {
        return "unavailable";
    }
    if methods.iter().all(|method| *method == "icmp") {
        "icmp"
    } else if methods.iter().all(|method| *method == "tcp_connect") {
        "tcp_connect"
    } else {
        "mixed"
    }
}

fn download(
    url: &str,
    timeout: Duration,
    target_duration: Duration,
) -> Result<TransferResult, String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let mut bytes = 0usize;
    let mut requests = 0usize;
    let mut buffer = [0u8; 8192];
    while started.elapsed() < target_duration && bytes < MAX_TRANSFER_BYTES {
        requests += 1;
        let response = client.get(url).send().map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("download returned HTTP {}", response.status()));
        }
        let remaining = (MAX_TRANSFER_BYTES - bytes) as u64;
        let mut reader = response.take(remaining);
        loop {
            if started.elapsed() >= target_duration {
                break;
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            bytes += read;
        }
    }
    if bytes == 0 {
        return Err("download returned no bytes".into());
    }
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    Ok(TransferResult {
        mbps: bytes as f64 * 8.0 / seconds / 1_000_000.0,
        bytes,
        requests,
        elapsed_seconds: seconds,
    })
}

fn upload(
    url: &str,
    timeout: Duration,
    target_duration: Duration,
) -> Result<TransferResult, String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let body = vec![0u8; 1024 * 1024];
    let mut bytes = 0usize;
    let mut requests = 0usize;
    while started.elapsed() < target_duration && bytes < MAX_TRANSFER_BYTES {
        requests += 1;
        let response = client
            .post(url)
            .header("Content-Type", "application/octet-stream")
            .body(body.clone())
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("upload returned HTTP {}", response.status()));
        }
        bytes = bytes.saturating_add(body.len());
    }
    if bytes == 0 {
        return Err("upload did not send bytes".into());
    }
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    Ok(TransferResult {
        mbps: bytes as f64 * 8.0 / seconds / 1_000_000.0,
        bytes,
        requests,
        elapsed_seconds: seconds,
    })
}
