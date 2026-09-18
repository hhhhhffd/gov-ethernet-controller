use super::Probe;
use crate::config::ProbeConfig;
use serde_json::{json, Map, Value};
use std::{
    io::{self, Read},
    net::{TcpStream, ToSocketAddrs},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// Ten samples make packet-loss percentages useful for low single-digit
// thresholds while keeping one probe bounded by the configured timeout.
const PING_SAMPLES: usize = 10;
// The transfer is primarily time-bounded. Keep a large streaming ceiling as
// a last-resort guard for a broken endpoint without cutting off fast links
// before the configured 3–5 second measurement window elapses.
const MAX_TRANSFER_BYTES: u64 = 4 * 1024 * 1024 * 1024;

struct TransferResult {
    mbps: f64,
    bytes: u64,
    requests: usize,
    elapsed_seconds: f64,
    warmed_up: bool,
}

pub struct NetworkProbe {
    config: ProbeConfig,
    device_auth: Option<(String, String)>,
}

impl NetworkProbe {
    pub fn new(config: ProbeConfig) -> Self {
        Self {
            config,
            device_auth: None,
        }
    }

    pub fn with_device_auth(config: ProbeConfig, device_id: String, device_token: String) -> Self {
        Self {
            config,
            device_auth: Some((device_id, device_token)),
        }
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
                // Keep method timers independent. An ICMP timeout is not part
                // of the TCP-connect latency when ICMP is filtered.
                let icmp_started = Instant::now();
                let result = if icmp_check(host, timeout).is_ok() {
                    Some(("ICMP", icmp_started.elapsed()))
                } else {
                    let tcp_started = Instant::now();
                    tcp_check(&address, timeout)
                        .ok()
                        .map(|_| ("TCP_CONNECT", tcp_started.elapsed()))
                };
                if let Some((method, elapsed)) = result {
                    successes += 1;
                    ping_successes += 1;
                    ping_samples.push(elapsed.as_secs_f64() * 1000.0);
                    ping_methods.push(method);
                }
            }
        }

        let connection_ok = successes > 0;
        // Packet loss describes the ping sample set, not the independent
        // reachability targets used for availability. Mixing those counts
        // would report loss whenever a target list contains an HTTP failure.
        let packet_loss = if ping_attempts == 0 {
            None
        } else {
            Some((ping_attempts - ping_successes) as f64 / ping_attempts as f64 * 100.0)
        };
        let ping_failures = ping_attempts.saturating_sub(ping_successes);
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
        raw.insert("method_version".into(), Value::String("network-v6".into()));
        raw.insert("reachability".into(), Value::Array(reachability));
        raw.insert("ping_samples_ms".into(), json!(ping_samples));
        // Keep the historical successful-sample fields for compatibility, but
        // expose the denominator explicitly so packet loss is auditable.
        raw.insert("ping_sample_count".into(), json!(ping_samples.len()));
        raw.insert("ping_attempt_count".into(), json!(ping_attempts));
        raw.insert("ping_success_count".into(), json!(ping_successes));
        raw.insert("ping_failure_count".into(), json!(ping_failures));
        raw.insert(
            "ping_enabled".into(),
            json!(self.config.ping_host.is_some()),
        );
        raw.insert("ping_methods".into(), json!(ping_methods));
        let latency_method = latency_method(&ping_methods);
        raw.insert(
            "latency_method".into(),
            Value::String(latency_method.into()),
        );
        raw.insert("ping_method".into(), Value::String(latency_method.into()));
        raw.insert(
            "latency_evidence".into(),
            json!({
                "method": latency_method,
                "sample_count": ping_samples.len(),
                "attempt_count": ping_attempts,
                "successful_count": ping_successes,
                "samples_ms": ping_samples,
            }),
        );
        raw.insert(
            "sample_count".into(),
            json!({"ping": ping_samples.len(), "download": 0, "upload": 0}),
        );
        raw.insert(
            "sample_attempt_count".into(),
            json!({"ping": ping_attempts, "availability": attempts}),
        );
        raw.insert("availability_attempt_count".into(), json!(attempts));
        raw.insert("availability_success_count".into(), json!(successes));
        raw.insert(
            "availability_scope".into(),
            Value::String("reachability_targets_and_ping".into()),
        );
        raw.insert("warmup".into(), json!({"download": false, "upload": false}));
        // Availability is a sampled observation, not a percentage calculated
        // from the sub-attempts of one probe. The server aggregates these
        // reachability observations over its reporting period. Counts remain
        // in raw evidence so the observation is auditable.
        let availability = availability_observation(attempts, successes);
        let performance_partial = mode.eq_ignore_ascii_case("performance")
            && connection_ok
            && (output_metric_missing(&self.config.throughput_url)
                || output_metric_missing(&self.config.upload_url));
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
        output["latency_method"] = Value::String(latency_method.into());
        output["quality"] = Value::String(
            if performance_partial {
                "SUSPECT"
            } else {
                "VALID"
            }
            .into(),
        );
        output["raw"]["availability_observation"] = match availability {
            Some(value) if value == 100.0 => json!("REACHABLE"),
            Some(_) => json!("UNREACHABLE"),
            None => json!("NOT_SAMPLED"),
        };
        output["raw"]["availability_aggregation"] = json!("server_period_sampled_observations");
        if performance_partial {
            output["raw"]["verification_required"] = json!(true);
            output["raw"]["verification_reason"] = json!("partial_performance");
        }
        if mode.eq_ignore_ascii_case("performance") && connection_ok {
            let target_duration =
                Duration::from_secs(self.config.throughput_duration_seconds.clamp(3, 5));
            output["raw"]["throughput_target_seconds"] = json!(target_duration.as_secs());
            let auth = self
                .device_auth
                .as_ref()
                .map(|(device_id, token)| (device_id.as_str(), token.as_str()));
            if let Some(url) = &self.config.throughput_url {
                match download(url, timeout, target_duration, auth) {
                    Ok(value) => {
                        output["download"] = json!(value.mbps);
                        output["raw"]["download_bytes"] = json!(value.bytes);
                        output["raw"]["download_requests"] = json!(value.requests);
                        output["raw"]["download_elapsed_seconds"] = json!(value.elapsed_seconds);
                        output["raw"]["download_sample_count"] = json!(value.requests);
                        output["raw"]["warmup"]["download"] = json!(value.warmed_up);
                        output["raw"]["sample_count"]["download"] = json!(value.requests);
                    }
                    Err(error) => {
                        output["raw"]["download_error"] = json!(error);
                        output["raw"]["verification_required"] = json!(true);
                        output["raw"]["verification_reason"] = json!("download_failed");
                        output["quality"] = json!("SUSPECT");
                    }
                }
            }
            if let Some(url) = &self.config.upload_url {
                match upload(url, timeout, target_duration, auth) {
                    Ok(value) => {
                        output["upload"] = json!(value.mbps);
                        output["raw"]["upload_bytes"] = json!(value.bytes);
                        output["raw"]["upload_requests"] = json!(value.requests);
                        output["raw"]["upload_elapsed_seconds"] = json!(value.elapsed_seconds);
                        output["raw"]["upload_sample_count"] = json!(value.requests);
                        output["raw"]["warmup"]["upload"] = json!(value.warmed_up);
                        output["raw"]["sample_count"]["upload"] = json!(value.requests);
                    }
                    Err(error) => {
                        output["raw"]["upload_error"] = json!(error);
                        output["raw"]["verification_required"] = json!(true);
                        output["raw"]["verification_reason"] = json!("upload_failed");
                        output["quality"] = json!("SUSPECT");
                    }
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
        return "UNAVAILABLE";
    }
    if methods.iter().all(|method| *method == "ICMP") {
        "ICMP"
    } else if methods.iter().all(|method| *method == "TCP_CONNECT") {
        "TCP_CONNECT"
    } else {
        "MIXED"
    }
}

fn availability_observation(attempts: usize, successes: usize) -> Option<f64> {
    (attempts > 0).then_some(if successes > 0 { 100.0 } else { 0.0 })
}

fn output_metric_missing(url: &Option<String>) -> bool {
    url.is_none()
}

#[cfg(test)]
mod tests {
    use super::{availability_observation, latency_method, NetworkProbe, ProbeConfig};
    use crate::probe::Probe;

    #[test]
    fn availability_is_a_binary_sample_not_a_sub_attempt_percentage() {
        assert_eq!(availability_observation(10, 1), Some(100.0));
        assert_eq!(availability_observation(10, 0), Some(0.0));
        assert_eq!(availability_observation(0, 0), None);
    }

    #[test]
    fn latency_method_is_explicit_and_canonical() {
        assert_eq!(latency_method(&["ICMP", "ICMP"]), "ICMP");
        assert_eq!(latency_method(&["TCP_CONNECT"]), "TCP_CONNECT");
        assert_eq!(latency_method(&["ICMP", "TCP_CONNECT"]), "MIXED");
        assert_eq!(latency_method(&[]), "UNAVAILABLE");
    }

    #[test]
    fn raw_counts_expose_ping_and_availability_denominators() {
        let mut config = ProbeConfig::default();
        config.targets.clear();
        config.ping_host = None;
        let mut probe = NetworkProbe::new(config);

        let value = probe.measure("light").expect("empty probe should be valid");
        assert_eq!(value["raw"]["ping_sample_count"], 0);
        assert_eq!(value["raw"]["ping_attempt_count"], 0);
        assert_eq!(value["raw"]["ping_success_count"], 0);
        assert_eq!(value["raw"]["ping_failure_count"], 0);
        assert!(value["packet_loss"].is_null());
        assert!(!value["raw"]["ping_enabled"].as_bool().unwrap());
        assert_eq!(value["raw"]["availability_attempt_count"], 0);
        assert_eq!(value["raw"]["availability_success_count"], 0);
        assert_eq!(
            value["raw"]["availability_scope"],
            "reachability_targets_and_ping"
        );
    }
}

fn download(
    url: &str,
    timeout: Duration,
    target_duration: Duration,
    auth: Option<(&str, &str)>,
) -> Result<TransferResult, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    warmup_download(&client, url, auth)?;
    let started = Instant::now();
    let mut bytes = 0u64;
    let mut requests = 0usize;
    let mut buffer = [0u8; 8192];
    while started.elapsed() < target_duration && bytes < MAX_TRANSFER_BYTES {
        requests += 1;
        let response = with_auth(client.get(url), auth)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("download returned HTTP {}", response.status()));
        }
        let remaining = MAX_TRANSFER_BYTES - bytes;
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
            bytes = bytes.saturating_add(read as u64);
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
        warmed_up: true,
    })
}

fn upload(
    url: &str,
    timeout: Duration,
    target_duration: Duration,
    auth: Option<(&str, &str)>,
) -> Result<TransferResult, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let body = vec![0u8; 1024 * 1024];
    warmup_upload(&client, url, auth)?;
    let started = Instant::now();
    let mut bytes = 0u64;
    let mut requests = 0usize;
    while started.elapsed() < target_duration && bytes < MAX_TRANSFER_BYTES {
        requests += 1;
        let response = with_auth(client.post(url), auth)
            .header("Content-Type", "application/octet-stream")
            .body(body.clone())
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("upload returned HTTP {}", response.status()));
        }
        bytes = bytes.saturating_add(body.len() as u64);
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
        warmed_up: true,
    })
}

fn warmup_download(
    client: &reqwest::blocking::Client,
    url: &str,
    auth: Option<(&str, &str)>,
) -> Result<(), String> {
    // Keep warmup compatible with simple HTTP endpoints that do not implement
    // Range. The response is still bounded locally before the body is dropped.
    let response = with_auth(client.get(url), auth)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "download warmup returned HTTP {}",
            response.status()
        ));
    }
    let mut reader = response.take(64 * 1024);
    io::copy(&mut reader, &mut io::sink()).map_err(|error| error.to_string())?;
    Ok(())
}

fn warmup_upload(
    client: &reqwest::blocking::Client,
    url: &str,
    auth: Option<(&str, &str)>,
) -> Result<(), String> {
    let response = with_auth(client.post(url), auth)
        .header("Content-Type", "application/octet-stream")
        .body(vec![0u8; 64 * 1024])
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("upload warmup returned HTTP {}", response.status()));
    }
    Ok(())
}

fn with_auth(
    request: reqwest::blocking::RequestBuilder,
    auth: Option<(&str, &str)>,
) -> reqwest::blocking::RequestBuilder {
    if let Some((device_id, device_token)) = auth {
        request
            .header("X-Device-ID", device_id)
            .header("X-Device-Token", device_token)
    } else {
        request
    }
}
