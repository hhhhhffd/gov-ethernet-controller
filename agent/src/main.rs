mod client;
mod config;
mod health;
mod hostname;
mod lifecycle;
mod logging;
mod probe;
mod queue;
mod scheduler;
mod update;
#[cfg(windows)]
mod windows_install;
#[cfg(windows)]
mod windows_ipc;
#[cfg(windows)]
mod windows_service;
#[cfg(windows)]
mod windows_tray {
    include!("bin/linkwatch-tray.rs");
}

use client::{Client, HeartbeatTelemetry};
use config::Config;
use lifecycle::{install_signal_handler, InstanceLock, StopToken};
use probe::Probe;
use queue::Queue;
use serde_json::{json, Value};
use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

fn main() {
    if let Err(error) = run() {
        logging::event(format!("fatal runtime error: {error}"));
        eprintln!("linkwatch-agent: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("--activation-watchdog") {
        let record = args
            .get(1)
            .ok_or("activation watchdog record path missing")?;
        return update::run_activation_watchdog(std::path::Path::new(record));
    }
    if args.first().map(String::as_str) == Some("--apply-update-helper") {
        let record = args.get(1).ok_or("update helper record path missing")?;
        return update::run_activation_helper(std::path::Path::new(record));
    }
    if args
        .iter()
        .any(|arg| arg == "version" || arg == "--version")
    {
        println!("linkwatch-agent {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let mode = if args.iter().any(|arg| arg == "--elevated-install") {
        "install".to_string()
    } else if args.iter().any(|arg| arg == "--once") {
        "once".to_string()
    } else {
        args.first().cloned().unwrap_or_else(|| {
            #[cfg(windows)]
            {
                return "install".into();
            }
            #[cfg(not(windows))]
            {
                "run".into()
            }
        })
    };
    #[cfg(windows)]
    if mode == "install" {
        if !args.iter().any(|arg| arg == "--elevated-install")
            && windows_install::request_elevation()?
        {
            return Ok(());
        }
        return windows_install::install();
    }
    #[cfg(windows)]
    if mode == "uninstall" {
        return windows_install::uninstall(args.iter().any(|arg| arg == "--purge-data"));
    }
    #[cfg(windows)]
    if mode == "tray" {
        windows_tray::run();
        return Ok(());
    }
    #[cfg(windows)]
    if mode == "run" && windows_service::try_dispatch()? {
        return Ok(());
    }
    run_mode(mode, None)
}

#[cfg(windows)]
pub(crate) fn run_service_mode(stop: StopToken) -> Result<(), String> {
    run_mode("run".into(), Some(stop))
}

fn run_mode(mode: String, service_stop: Option<StopToken>) -> Result<(), String> {
    let service_mode = service_stop.is_some();
    let mut config = Config::load()?;
    let log_path = logging::init(&config.queue_dir)?;
    logging::event(format!("startup mode={mode} log={}", log_path.display()));
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
    let queue = Queue::open(&config.queue_dir).map_err(|error| format!("open queue: {error}"))?;
    update::resume_activation_guard(&config.queue_dir, update::running_version())?;
    let restart_args = vec![mode.clone()];
    // Both long-running and one-shot modes write the durable spool. Keep
    // them mutually exclusive so a one-shot upload cannot race the scheduler
    // or remove an item while the run loop is processing the same batch.
    let _instance_lock = if mode == "run" || mode == "once" {
        let lock_path = queue.lock_path();
        Some(
            InstanceLock::acquire(&lock_path)
                .map_err(|error| format!("acquire agent instance lock: {error}"))?,
        )
    } else {
        None
    };
    let stop_token = if mode == "run" {
        Some(match service_stop {
            Some(stop) => stop,
            None => install_signal_handler()?,
        })
    } else {
        None
    };
    let initial_client = Client::new(config.clone())?;
    if use_server_config() {
        if let Ok(remote) = initial_client.server_config() {
            config.apply_server_config(&remote);
        }
    }
    let mut probe = probe::build(&config)?;
    let mut client = Client::new(config.clone())?;
    if mode == "once" {
        run_once(
            &mut config,
            &mut *probe,
            &queue,
            &mut client,
            &restart_args,
            service_mode,
        )
    } else {
        let manual_probe = Arc::new(ManualProbeControl::default());
        #[cfg(windows)]
        let _ipc = if service_mode {
            Some(windows_ipc::start(queue.dir_path(), manual_probe.clone()))
        } else {
            None
        };
        run_loop(
            config,
            probe,
            queue,
            client,
            stop_token.expect("run mode installs a stop token"),
            manual_probe,
            restart_args,
            service_mode,
        )
    }
}

#[derive(Default)]
pub(crate) struct ManualProbeControl {
    pub(crate) requested: AtomicBool,
    pub(crate) running: AtomicBool,
}

struct RuntimeTelemetry {
    hostname: Option<String>,
    boot_id: String,
    boot_started_at: String,
    started_at: Instant,
    last_probe_at: Option<String>,
    last_probe_status: Option<String>,
    last_heartbeat_at: Option<String>,
    heartbeat_attempted: bool,
    server_connected: bool,
}

impl RuntimeTelemetry {
    fn new() -> Self {
        Self {
            hostname: hostname::detect(),
            boot_id: Uuid::new_v4().to_string(),
            boot_started_at: boot_started_at_now(),
            started_at: Instant::now(),
            last_probe_at: None,
            last_probe_status: None,
            last_heartbeat_at: None,
            heartbeat_attempted: false,
            server_connected: false,
        }
    }

    fn snapshot(&self, queue: &Queue) -> HeartbeatTelemetry {
        let queue_depth = match queue.count() {
            Ok(depth) => Some(depth),
            Err(error) => {
                eprintln!("linkwatch-agent: queue depth unavailable: {error}");
                None
            }
        };
        HeartbeatTelemetry {
            hostname: self.hostname.clone(),
            boot_id: Some(self.boot_id.clone()),
            boot_started_at: Some(self.boot_started_at.clone()),
            uptime_seconds: Some(self.started_at.elapsed().as_secs()),
            queue_depth,
            last_probe_at: self.last_probe_at.clone(),
            last_probe_status: self.last_probe_status.clone(),
        }
    }

    fn record_success(&mut self, value: &Value) {
        self.last_probe_at = value
            .get("observed_at")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(chrono_like_now()));
        self.last_probe_status = Some(
            if value.get("connection_status").and_then(Value::as_str) == Some("NO_INTERNET") {
                "no_internet"
            } else {
                "ok"
            }
            .into(),
        );
    }

    fn record_error(&mut self) {
        self.last_probe_at = Some(chrono_like_now());
        self.last_probe_status = Some("error".into());
    }

    fn record_heartbeat(&mut self, success: bool) {
        self.heartbeat_attempted = true;
        self.server_connected = success;
        if success {
            self.last_heartbeat_at = Some(chrono_like_now());
        }
    }
}

fn run_once(
    config: &mut Config,
    probe: &mut dyn Probe,
    queue: &Queue,
    client: &mut Client,
    restart_args: &[String],
    service_mode: bool,
) -> Result<(), String> {
    let mut telemetry = RuntimeTelemetry::new();
    if process_commands(
        config,
        probe,
        queue,
        client,
        &telemetry,
        restart_args,
        service_mode,
    ) {
        return Ok(());
    }
    match client.heartbeat(&telemetry.snapshot(queue)) {
        Ok(_) => telemetry.record_heartbeat(true),
        Err(error) => {
            telemetry.record_heartbeat(false);
            logging::event(format!("heartbeat failure: {error}"));
            eprintln!("linkwatch-agent: heartbeat failed: {error}");
        }
    }
    logging::event("measurement started mode=performance");
    let value = match probe.measure("performance") {
        Ok(value) => value,
        Err(error) => {
            logging::event(format!("measurement failure: {error}"));
            telemetry.record_error();
            if let Err(heartbeat_error) = client.heartbeat(&telemetry.snapshot(queue)) {
                telemetry.record_heartbeat(false);
                eprintln!("linkwatch-agent: heartbeat failed: {heartbeat_error}");
            } else {
                telemetry.record_heartbeat(true);
            }
            return Err(error);
        }
    };
    let payload = event(config, value);
    telemetry.record_success(&payload);
    let event_id = queue::Queue::event_id(&payload);
    queue
        .enqueue(&event_id, &payload)
        .map_err(|error| format!("enqueue measurement: {error}"))?;
    let (uploaded, remaining) = match client.upload_pending(queue) {
        Ok(result) => result,
        Err(error) => {
            logging::event(format!("server unavailable/upload failure: {error}"));
            return Err(error);
        }
    };
    logging::event(format!(
        "measurement complete event={event_id} uploaded={uploaded} queue={remaining}"
    ));
    if let Err(error) = client.heartbeat(&telemetry.snapshot(queue)) {
        telemetry.record_heartbeat(false);
        eprintln!("linkwatch-agent: heartbeat failed: {error}");
    } else {
        telemetry.record_heartbeat(true);
    }
    println!("measurement collected: {}", event_id);
    println!("queued: {}", remaining);
    println!("uploaded: {}", uploaded);
    println!("accepted: {}", uploaded > 0);
    Ok(())
}

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const LIGHT_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn run_loop(
    mut config: Config,
    mut probe: Box<dyn Probe>,
    queue: Queue,
    mut client: Client,
    stop: StopToken,
    manual_probe: Arc<ManualProbeControl>,
    restart_args: Vec<String>,
    service_mode: bool,
) -> Result<(), String> {
    let state_path = queue.state_path();
    let mut state = scheduler::State::load(&state_path)
        .map_err(|error| format!("load scheduler state: {error}"))?;
    let mut last_maintenance: Option<SystemTime> = None;
    // LIGHT is an independent, repeating reachability sample. It must not be
    // a single follow-up probe attached to the preceding PERFORMANCE run.
    let mut light_due = config
        .light_checks_between
        .then(|| SystemTime::now() + LIGHT_CHECK_INTERVAL);
    let mut telemetry = RuntimeTelemetry::new();
    persist_runtime_state(&config, &telemetry, &queue);

    loop {
        if stop.is_requested() {
            logging::event("shutdown requested; pending measurements remain queued");
            println!("shutdown requested; pending measurements remain queued");
            return Ok(());
        }
        let now = SystemTime::now();
        persist_runtime_state(&config, &telemetry, &queue);

        if manual_probe.requested.swap(false, Ordering::SeqCst) {
            if manual_probe.running.swap(true, Ordering::SeqCst) {
                logging::event("manual probe request ignored: probe already running");
            } else {
                logging::event("manual probe started");
                match probe.measure("performance") {
                    Ok(value) => {
                        let payload = event(&config, value);
                        telemetry.record_success(&payload);
                        let id = queue::Queue::event_id(&payload);
                        match queue.enqueue(&id, &payload) {
                            Ok(_) => {
                                flush_pending(&client, &queue);
                                logging::event(format!("manual probe complete event={id}"));
                            }
                            Err(error) => {
                                logging::event(format!("manual probe enqueue failure: {error}"))
                            }
                        }
                    }
                    Err(error) => {
                        telemetry.record_error();
                        logging::event(format!("manual probe failure: {error}"));
                    }
                }
                manual_probe.running.store(false, Ordering::SeqCst);
            }
            continue;
        }

        // Maintenance is independent of scheduled probes. It keeps the
        // durable spool moving after an outage and applies operator changes
        // without requiring an agent restart.
        let maintenance_due = last_maintenance
            .map(|last| now.duration_since(last).unwrap_or_default() >= MAINTENANCE_INTERVAL)
            .unwrap_or(true);
        if maintenance_due {
            if let Err(error) = client.heartbeat(&telemetry.snapshot(&queue)) {
                telemetry.record_heartbeat(false);
                logging::event(format!("heartbeat failure: {error}"));
                eprintln!("linkwatch-agent: heartbeat failed: {error}");
            } else {
                telemetry.record_heartbeat(true);
            }
            flush_pending(&client, &queue);
            if process_commands(
                &mut config,
                &mut *probe,
                &queue,
                &mut client,
                &telemetry,
                &restart_args,
                service_mode,
            ) {
                return Ok(());
            }
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
                        logging::event("received new server config");
                    }
                }
            }
            last_maintenance = Some(now);
        }
        if stop.is_requested() {
            logging::event("shutdown requested; pending measurements remain queued");
            println!("shutdown requested; pending measurements remain queued");
            return Ok(());
        }

        if !config.light_checks_between {
            light_due = None;
        } else if light_due.is_none() {
            light_due = Some(now + LIGHT_CHECK_INTERVAL);
        }

        if let Some(deadline) = light_due {
            if now >= deadline {
                let run_light = config.light_checks_between;
                light_due = run_light.then(|| SystemTime::now() + LIGHT_CHECK_INTERVAL);
                if run_light {
                    if stop.is_requested() {
                        println!("shutdown requested; pending measurements remain queued");
                        return Ok(());
                    }
                    logging::event("measurement started mode=light");
                    manual_probe.running.store(true, Ordering::SeqCst);
                    let light_result = probe.measure("light");
                    manual_probe.running.store(false, Ordering::SeqCst);
                    match light_result {
                        Ok(value) => {
                            let light = event(&config, value);
                            telemetry.record_success(&light);
                            let id = queue::Queue::event_id(&light);
                            queue
                                .enqueue(&id, &light)
                                .map_err(|error| format!("enqueue light measurement: {error}"))?;
                            flush_pending(&client, &queue);
                        }
                        Err(error) => {
                            logging::event(format!("measurement failure mode=light: {error}"));
                            telemetry.record_error();
                            eprintln!("linkwatch-agent: light probe failed: {error}");
                        }
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
                if stop.is_requested() {
                    println!("shutdown requested; pending measurements remain queued");
                    return Ok(());
                }
                let day = deadline / scheduler::DAY_SECONDS;
                logging::event("measurement started mode=performance");
                manual_probe.running.store(true, Ordering::SeqCst);
                let performance_result = probe.measure("performance");
                manual_probe.running.store(false, Ordering::SeqCst);
                match performance_result {
                    Ok(value) => {
                        // A deterministic slot id makes the enqueue + cursor
                        // update recoverable if the process crashes between
                        // those two filesystem operations.
                        let mut payload = event(&config, value);
                        telemetry.record_success(&payload);
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
                        logging::event(format!("measurement complete event={event_id}"));
                    }
                    Err(error) => {
                        telemetry.record_error();
                        eprintln!("linkwatch-agent: performance probe failed: {error}");
                        logging::event(format!("measurement failure mode=performance: {error}"));
                        if stop.wait(Duration::from_secs(1)) {
                            println!("shutdown requested; pending measurements remain queued");
                            return Ok(());
                        }
                    }
                }
                // Keep an already scheduled LIGHT cadence intact. If the
                // previous configuration disabled it, the loop above starts
                // a fresh interval on the next iteration after re-enable.
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
                .min(Duration::from_secs(1));
            if stop.wait(sleep_for.max(Duration::from_secs(1))) {
                println!("shutdown requested; pending measurements remain queued");
                return Ok(());
            }
        } else {
            if stop.wait(Duration::from_secs(1)) {
                println!("shutdown requested; pending measurements remain queued");
                return Ok(());
            }
        }
    }
}

fn flush_pending(client: &Client, queue: &Queue) {
    match client.upload_pending(queue) {
        Ok((uploaded, remaining)) => {
            if uploaded > 0 {
                logging::event(format!(
                    "upload recovered: uploaded={uploaded} queue={remaining}"
                ));
            }
            if remaining > 0 {
                logging::event(format!("queue accumulating: depth={remaining}"));
            }
        }
        Err(error) => {
            logging::event(format!("server unavailable/upload failure: {error}"));
            eprintln!("linkwatch-agent: upload queue flush failed: {error}");
        }
    }
}

fn process_commands(
    config: &mut Config,
    probe: &mut dyn Probe,
    queue: &Queue,
    client: &mut Client,
    telemetry: &RuntimeTelemetry,
    restart_args: &[String],
    service_mode: bool,
) -> bool {
    let commands = match client.poll_commands(1) {
        Ok(commands) => commands,
        Err(error) => {
            logging::event(format!("command poll failure: {error}"));
            return false;
        }
    };
    for command in commands {
        if command.command_type == "REMOTE_CONFIG" {
            let payload = command
                .payload
                .get("config")
                .cloned()
                .unwrap_or(Value::Null);
            let version = command
                .payload
                .get("config_version")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            match config.apply_remote_config(&payload) {
                Ok(()) => {
                    let _ = config.persist_remote_snapshot(version, &payload, Some(version));
                    let _ = client.acknowledge_command(
                        command.id,
                        "DONE",
                        json!({"config_version": version, "status": "APPLIED"}),
                        None,
                    );
                    client.update_config(config.clone());
                }
                Err(error) => {
                    let _ = client.acknowledge_command(
                        command.id,
                        "FAILED",
                        json!({"config_version": version, "status": "ROLLED_BACK"}),
                        Some(&error),
                    );
                }
            }
            continue;
        }
        if command.command_type == "AGENT_UPDATE" {
            let status = match update::apply_command(
                &command.payload,
                update::running_version(),
                &config.queue_dir,
            ) {
                Ok(status) => status,
                Err(error) => {
                    let status = if error.contains("rollback") {
                        "ROLLED_BACK"
                    } else {
                        "FAILED"
                    };
                    let _ = client.acknowledge_command(
                        command.id,
                        "FAILED",
                        json!({"status":status}),
                        Some(&error),
                    );
                    continue;
                }
            };
            let result = update::ack_payload(&status, &telemetry.boot_id);
            match client.acknowledge_command(command.id, "DONE", result, None) {
                Ok(_) if status.phase == update::UpdatePhase::Installing => {
                    if let Err(error) =
                        update::activate_pending(&status, restart_args, service_mode)
                    {
                        logging::event(format!(
                            "agent update activation failed release={} version={}: {error}",
                            status.release_id, status.version
                        ));
                        let report = json!({
                            "release_id": status.release_id,
                            "version": status.version,
                            "status": "ROLLED_BACK",
                            "error": error,
                        });
                        if let Err(report_error) = client
                            .heartbeat_with_activation(&telemetry.snapshot(queue), Some(report))
                        {
                            logging::event(format!(
                                "agent update rollback report failed: {report_error}"
                            ));
                        }
                    } else {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(error) => logging::event(format!(
                    "agent update acknowledgement failed release={}: {error}",
                    status.release_id
                )),
            }
            continue;
        }
        if command.command_type != "LIVE_VERIFY" {
            let _ = client.acknowledge_command(
                command.id,
                "FAILED",
                json!({}),
                Some("unsupported command type"),
            );
            continue;
        }
        let mut result = match probe.measure("performance") {
            Ok(value) => event(config, value),
            Err(error) => {
                let _ = client.acknowledge_command(command.id, "FAILED", json!({}), Some(&error));
                continue;
            }
        };
        if let Some(object) = result.as_object_mut() {
            object.insert("mode".into(), json!("PERFORMANCE"));
            object.insert("raw".into(), json!({
                "trigger": "LIVE_VERIFY",
                "live_verify_command_id": command.id,
                "situation_id": command.payload.get("situation_id").cloned().unwrap_or(Value::Null),
            }));
        }
        let event_id = Queue::event_id(&result);
        if queue.enqueue(&event_id, &result).is_err() {
            continue;
        }
        match client.upload_pending(queue) {
            Ok(_) => {
                let _ = client.acknowledge_command(
                    command.id,
                    "DONE",
                    json!({"client_event_id": event_id}),
                    None,
                );
            }
            Err(error) => logging::event(format!("LIVE_VERIFY upload deferred: {error}")),
        }
    }
    false
}

fn persist_runtime_state(config: &Config, telemetry: &RuntimeTelemetry, queue: &Queue) {
    let depth = queue.count().unwrap_or_default();
    let state = json!({
        "device_id": &config.device_id,
        "hostname": &telemetry.hostname,
        "agent_version": update::running_version(),
        "server": &config.server_url,
        "dashboard_url": config.dashboard_url.as_ref().unwrap_or(&config.server_url),
        // A non-empty spool is actionable even when heartbeat still reaches
        // the server (for example, the ingest endpoint is down). Keep this
        // visible in the tray instead of reporting a misleading healthy state.
        "status": if depth > 0 {
            "server_unavailable"
        } else if !telemetry.server_connected && telemetry.heartbeat_attempted {
            "server_unavailable"
        } else if telemetry.last_probe_status.as_deref() == Some("error") {
            "error"
        } else if telemetry.last_probe_status.as_deref() == Some("no_internet") {
            "connection_problem"
        } else {
            "working"
        },
        "last_probe_at": &telemetry.last_probe_at,
        "last_probe_status": &telemetry.last_probe_status,
        "server_connected": telemetry.server_connected,
        "heartbeat_attempted": telemetry.heartbeat_attempted,
        "last_successful_heartbeat": &telemetry.last_heartbeat_at,
        "queue_depth": depth,
        "boot_started_at": &telemetry.boot_started_at,
        "uptime_seconds": telemetry.started_at.elapsed().as_secs(),
    });
    // Keep the state file extensionless so Queue::pending never treats it as
    // an observation payload.
    let path = queue.dir_path().join(".runtime-state");
    let temporary = queue.dir_path().join(".runtime-state.tmp");
    if let Ok(raw) = serde_json::to_vec(&state) {
        if std::fs::write(&temporary, raw).is_ok() {
            #[cfg(windows)]
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::rename(&temporary, &path);
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
    object.insert("agent_version".into(), json!(update::running_version()));
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

fn boot_started_at_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let base = time_format(now.as_secs(), now.subsec_nanos());
    format!("{}.{:09}Z", base.trim_end_matches('Z'), now.subsec_nanos())
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
    use crate::update;
    use serde_json::json;

    #[test]
    fn event_uses_device_identity_only() {
        let mut config = Config::default();
        config.school_id = "legacy-school".into();
        config.line_id = "legacy-line".into();
        config.monitoring_point_id = "legacy-point".into();
        config.agent_version = "configured-but-not-running".into();
        config.device_id = "enrolled-device".into();

        let payload = event(&config, json!({"mode": "LIGHT"}));
        assert_eq!(payload["device_id"], "enrolled-device");
        assert_eq!(payload["agent_version"], update::running_version());
        assert!(payload.get("school_id").is_none());
        assert!(payload.get("line_id").is_none());
        assert!(payload.get("monitoring_point_id").is_none());
    }
}
