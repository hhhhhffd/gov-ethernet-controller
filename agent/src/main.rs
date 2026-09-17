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
    let initial_client = Client::new(config.clone())?;
    if use_server_config() {
        if let Ok(remote) = initial_client.server_config() {
            config.apply_server_config(&remote);
        }
    }
    let mut probe = probe::build(&config)?;
    let queue = Queue::open(&config.queue_dir).map_err(|error| format!("open queue: {error}"))?;
    let client = Client::new(config.clone())?;
    if mode == "once" {
        run_once(&config, &mut *probe, &queue, &client)
    } else {
        run_loop(config, probe, queue, client)
    }
}

fn run_once(
    config: &Config,
    probe: &mut dyn Probe,
    queue: &Queue,
    client: &Client,
) -> Result<(), String> {
    if let Err(error) = client.heartbeat() {
        eprintln!("linkwatch-agent: heartbeat failed: {error}");
    }
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

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const LIGHT_CHECK_DELAY: Duration = Duration::from_secs(5 * 60);

fn run_loop(
    mut config: Config,
    mut probe: Box<dyn Probe>,
    queue: Queue,
    mut client: Client,
) -> Result<(), String> {
    let state_path = queue.state_path();
    let mut state = scheduler::State::load(&state_path)
        .map_err(|error| format!("load scheduler state: {error}"))?;
    let mut last_maintenance: Option<SystemTime> = None;
    let mut light_due: Option<SystemTime> = None;

    loop {
        let now = SystemTime::now();

        // Maintenance is independent of scheduled probes. It keeps the
        // durable spool moving after an outage and applies operator changes
        // without requiring an agent restart.
        let maintenance_due = last_maintenance
            .map(|last| now.duration_since(last).unwrap_or_default() >= MAINTENANCE_INTERVAL)
            .unwrap_or(true);
        if maintenance_due {
            if let Err(error) = client.heartbeat() {
                eprintln!("linkwatch-agent: heartbeat failed: {error}");
            }
            flush_pending(&client, &queue);
            if use_server_config() {
                if let Ok(remote) = client.server_config() {
                    let before = (
                        config.performance_tests_per_day,
                        config.jitter_minutes,
                        config.light_checks_between,
                    );
                    config.apply_server_config(&remote);
                    let after = (
                        config.performance_tests_per_day,
                        config.jitter_minutes,
                        config.light_checks_between,
                    );
                    if before != after {
                        client.update_config(config.clone());
                    }
                }
            }
            last_maintenance = Some(now);
        }

        if let Some(deadline) = light_due {
            if now >= deadline {
                light_due = None;
                if config.light_checks_between {
                    match probe.measure("light") {
                        Ok(value) => {
                            let light = event(&config, value);
                            let id = queue::Queue::event_id(&light);
                            queue
                                .enqueue(&id, &light)
                                .map_err(|error| format!("enqueue light measurement: {error}"))?;
                            flush_pending(&client, &queue);
                        }
                        Err(error) => eprintln!("linkwatch-agent: light probe failed: {error}"),
                    }
                }
                continue;
            }
        }

        let epoch_seconds = scheduler::unix_seconds(now);
        let current_day = epoch_seconds / scheduler::DAY_SECONDS;
        let schedule_seed = format!("{}:{current_day}", config.device_id);
        let schedule = scheduler::schedule_for_day(
            &schedule_seed,
            config.performance_tests_per_day,
            config.jitter_minutes,
        );
        if let Some((deadline, slot)) = scheduler::next_deadline(epoch_seconds, &schedule, &state) {
            if deadline <= epoch_seconds {
                let day = deadline / scheduler::DAY_SECONDS;
                match probe.measure("performance") {
                    Ok(value) => {
                        // A deterministic slot id makes the enqueue + cursor
                        // update recoverable if the process crashes between
                        // those two filesystem operations.
                        let mut payload = event(&config, value);
                        payload["client_event_id"] = json!(format!("scheduled-{day}-{slot}"));
                        let event_id = queue::Queue::event_id(&payload);
                        queue
                            .enqueue(&event_id, &payload)
                            .map_err(|error| format!("enqueue measurement: {error}"))?;
                        scheduler::mark_fired(&mut state, day, slot);
                        state
                            .save(&state_path)
                            .map_err(|error| format!("save scheduler state: {error}"))?;
                        flush_pending(&client, &queue);
                        println!("measurement collected: {event_id}");
                    }
                    Err(error) => {
                        eprintln!("linkwatch-agent: performance probe failed: {error}");
                        thread::sleep(Duration::from_secs(30));
                    }
                }
                if config.light_checks_between {
                    light_due = Some(SystemTime::now() + LIGHT_CHECK_DELAY);
                }
                continue;
            }

            let until_deadline = Duration::from_secs(deadline.saturating_sub(epoch_seconds));
            let until_light = light_due
                .and_then(|due| due.duration_since(now).ok())
                .unwrap_or(MAINTENANCE_INTERVAL);
            // A short upper bound keeps shutdowns and reconfiguration
            // responsive even when the next scheduled slot is hours away.
            let sleep_for = until_deadline
                .min(until_light)
                .min(MAINTENANCE_INTERVAL)
                .min(Duration::from_secs(30));
            thread::sleep(sleep_for.max(Duration::from_secs(1)));
        } else {
            thread::sleep(Duration::from_secs(30));
        }
    }
}

fn flush_pending(client: &Client, queue: &Queue) {
    if let Err(error) = client.upload_pending(queue) {
        eprintln!("linkwatch-agent: upload queue flush failed: {error}");
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

#[cfg(test)]
mod tests {
    use super::event;
    use crate::config::Config;
    use serde_json::json;

    #[test]
    fn event_uses_device_identity_only() {
        let mut config = Config::default();
        config.school_id = "legacy-school".into();
        config.line_id = "legacy-line".into();
        config.monitoring_point_id = "legacy-point".into();

        let payload = event(&config, json!({"mode": "LIGHT"}));
        assert_eq!(payload["device_id"], "device-42-primary");
        assert!(payload.get("school_id").is_none());
        assert!(payload.get("line_id").is_none());
        assert!(payload.get("monitoring_point_id").is_none());
    }
}
