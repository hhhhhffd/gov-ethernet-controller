mod client;
mod config;
mod health;
mod probe;
mod queue;
mod scheduler;

use client::Client;
use config::Config;
use probe::Probe;
use queue::Queue;
use serde_json::{json, Value};
use std::{
    env, thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

fn main() {
    if let Err(error) = run() {
        eprintln!("linkwatch-agent: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| arg == "version" || arg == "--version")
    {
        println!("linkwatch-agent {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let mode = if args.iter().any(|arg| arg == "--once") {
        "once".to_string()
    } else {
        args.first().cloned().unwrap_or_else(|| "run".into())
    };
    let mut config = Config::load()?;
    if mode == "probe" {
        let mut probe = probe::build(&config)?;
        let value = probe.measure("performance")?;
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if mode != "once" && mode != "run" {
        return Err(format!(
            "unknown command {mode}; expected run, once, probe or version"
        ));
    }
    let initial_client = Client::new(config.clone());
    if use_server_config() {
        if let Ok(remote) = initial_client.server_config() {
            config.apply_server_config(&remote);
        }
    }
    let mut probe = probe::build(&config)?;
    let queue = Queue::open(&config.queue_dir).map_err(|error| format!("open queue: {error}"))?;
    let client = Client::new(config.clone());
    if mode == "once" {
        run_once(&config, &mut *probe, &queue, &client)
    } else {
        run_loop(&config, &mut *probe, &queue, &client)
    }
}

fn run_once(
    config: &Config,
    probe: &mut dyn Probe,
    queue: &Queue,
    client: &Client,
) -> Result<(), String> {
    let _ = client.heartbeat();
    let payload = event(config, probe.measure("performance")?);
    let event_id = queue::Queue::event_id(&payload);
    queue
        .enqueue(&event_id, &payload)
        .map_err(|error| format!("enqueue measurement: {error}"))?;
    let (uploaded, remaining) = client.upload_pending(queue)?;
    println!("measurement collected: {}", event_id);
    println!("queued: {}", remaining);
    println!("uploaded: {}", uploaded);
    println!("accepted: {}", uploaded > 0);
    Ok(())
}

fn run_loop(
    config: &Config,
    probe: &mut dyn Probe,
    queue: &Queue,
    client: &Client,
) -> Result<(), String> {
    loop {
        let _ = client.heartbeat();
        let payload = event(config, probe.measure("performance")?);
        let event_id = queue::Queue::event_id(&payload);
        queue
            .enqueue(&event_id, &payload)
            .map_err(|error| format!("enqueue measurement: {error}"))?;
        let _ = client.upload_pending(queue);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let schedule = scheduler::schedule_for_day(
            &config.device_id,
            config.performance_tests_per_day,
            config.jitter_minutes,
        );
        let elapsed = Duration::from_secs(now.as_secs() % 86400);
        let sleep = scheduler::next_sleep(elapsed, &schedule).min(Duration::from_secs(3600));
        if config.light_checks_between {
            thread::sleep(sleep.min(Duration::from_secs(300)));
            let light = event(config, probe.measure("light")?);
            let id = queue::Queue::event_id(&light);
            queue
                .enqueue(&id, &light)
                .map_err(|error| error.to_string())?;
            let _ = client.upload_pending(queue);
        } else {
            thread::sleep(sleep);
        }
    }
}

fn use_server_config() -> bool {
    env::var("LINKWATCH_USE_SERVER_CONFIG")
        .or_else(|_| env::var("VKO_USE_SERVER_CONFIG"))
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn event(config: &Config, result: Value) -> Value {
    let mut object = result.as_object().cloned().unwrap_or_default();
    object.insert("client_event_id".into(), json!(Uuid::new_v4()));
    object.insert("device_id".into(), json!(config.device_id));
    object.insert("school_id".into(), json!(config.school_id));
    object.insert("line_id".into(), json!(config.line_id));
    object.insert(
        "monitoring_point_id".into(),
        json!(config.monitoring_point_id),
    );
    object.insert("agent_version".into(), json!(config.agent_version));
    object.insert("observed_at".into(), json!(chrono_like_now()));
    Value::Object(object)
}
fn chrono_like_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs();
    let nanos = now.subsec_nanos();
    format!("{}", time_format(seconds, nanos))
}
fn time_format(seconds: u64, nanos: u32) -> String {
    // UTC RFC3339 without an extra time crate
    const DAYS: [u64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut days = seconds / 86400;
    let mut year = 1970u64;
    loop {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let year_days = if leap { 366 } else { 365 };
        if days < year_days {
            break;
        };
        days -= year_days;
        year += 1
    }
    let mut month = 1u64;
    for (index, base) in DAYS.iter().enumerate() {
        let mut count = *base;
        if index == 1 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
            count = 29
        };
        if days < count {
            break;
        };
        days -= count;
        month += 1
    }
    let day = days + 1;
    let day_seconds = seconds % 86400;
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;
    let _ = nanos;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}
