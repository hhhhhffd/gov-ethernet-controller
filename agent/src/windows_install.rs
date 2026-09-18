//! First-run bootstrap for the single Windows release binary.  It performs
//! only local installation work and never puts the device token in a service
//! command line.  Subsequent service/tray starts use the normal `run` and
//! `tray` modes.

#![cfg(windows)]

use crate::config::Config;
use serde_json::json;
use std::{
    env,
    ffi::c_void,
    fs,
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
    time::Duration,
};

type Handle = *mut c_void;
const SW_HIDE: i32 = 0;

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: Handle,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> Handle;
}

/// Ask the shell for a UAC-elevated copy when a user starts the one-file
/// installer from Explorer. The elevated child is marked by its private
/// argument and performs the actual Program Files/SCM changes.
pub fn request_elevation() -> Result<bool, String> {
    let current =
        env::current_exe().map_err(|error| format!("locate agent executable: {error}"))?;
    let file = wide(&current.to_string_lossy());
    let operation = wide("runas");
    let parameters = wide("--elevated-install");
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            ptr::null(),
            SW_HIDE,
        )
    };
    if result as isize <= 32 {
        return Err("Windows UAC elevation was cancelled or failed".into());
    }
    Ok(true)
}

pub fn install() -> Result<(), String> {
    let current =
        env::current_exe().map_err(|error| format!("locate agent executable: {error}"))?;
    let program_files =
        env::var("ProgramFiles").map_err(|_| "ProgramFiles is not set".to_string())?;
    let program_data = env::var("ProgramData").map_err(|_| "ProgramData is not set".to_string())?;
    let install_root = PathBuf::from(program_files).join("LINKWATCH");
    let data_root = PathBuf::from(program_data).join("LINKWATCH");
    let installed = install_root.join("linkwatch-agent.exe");
    fs::create_dir_all(&install_root)
        .map_err(|error| format!("create install directory: {error}"))?;
    fs::create_dir_all(data_root.join("queue"))
        .map_err(|error| format!("create data directory: {error}"))?;
    fs::create_dir_all(data_root.join("logs"))
        .map_err(|error| format!("create log directory: {error}"))?;
    let _ = crate::logging::init(&data_root.join("queue"));
    crate::logging::event("Windows installation started");

    // Make repeated launches idempotent: an existing service holds the
    // installed image open, so stop/remove it before replacing the binary.
    if current != installed && installed.exists() {
        stop_service("LINKWATCH");
        stop_installed_process("linkwatch-agent.exe");
        run_sc("delete", "LINKWATCH");
    }
    if current != installed {
        fs::copy(&current, &installed)
            .map_err(|error| format!("copy agent into Program Files: {error}"))?;
    }
    let config = Config::load()?;
    if config.device_token.trim().is_empty() {
        return Err("device token is required on first run (use a protected config/token file or LINKWATCH_DEVICE_TOKEN)".into());
    }
    let token_path = data_root.join("device-token");
    fs::write(&token_path, format!("{}\n", config.device_token.trim()))
        .map_err(|error| format!("write protected device token: {error}"))?;
    protect_token(&token_path)?;

    let config_path = data_root.join("config.json");
    let dashboard = config
        .dashboard_url
        .clone()
        .unwrap_or_else(|| config.server_url.clone());
    let persisted = json!({
        "server_url": &config.server_url,
        "device_id": &config.device_id,
        "device_token": "",
        "device_token_file": token_path,
        "queue_dir": data_root.join("queue"),
        "dashboard_url": dashboard,
        "probe_type": &config.probe_type,
        "performance_tests_per_day": config.performance_tests_per_day,
        "jitter_minutes": config.jitter_minutes,
        "light_checks_between": config.light_checks_between,
        "probe": &config.probe,
    });
    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write installed config: {error}"))?;

    stop_service("LINKWATCH");
    run_sc("delete", "LINKWATCH");
    let service_image = format!(r#""{}" run"#, installed.display());
    run_sc_args(&[
        "create",
        "LINKWATCH",
        "binPath=",
        &service_image,
        "start=",
        "auto",
        "obj=",
        "LocalSystem",
        "DisplayName=",
        "LINKWATCH monitoring agent",
    ])?;
    run_sc_args(&[
        "description",
        "LINKWATCH",
        "Background LINKWATCH monitoring runtime",
    ])?;
    // Let the SCM bring monitoring back after a transient runtime crash.
    run_sc_args(&[
        "failure",
        "LINKWATCH",
        "reset=",
        "86400",
        "actions=",
        "restart/60000/restart/60000/restart/60000",
    ])?;
    run_reg_run(&install_root.join("linkwatch-agent.exe"))?;
    run_sc_args(&["start", "LINKWATCH"])?;

    // Start the tray directly. The tray detaches from its inherited console
    // on Windows, so no PowerShell/cmd window becomes part of the user UI.
    let _ = Command::new(&installed).arg("tray").spawn();
    crate::logging::event("Windows installation completed; service and tray started");
    // Windows keeps the current image open until process exit. Schedule a
    // small, hidden helper only for deleting this trusted bootstrap path; no
    // token or other secret is passed to it.
    if current != installed {
        remove_after_exit(&current);
    }
    Ok(())
}

pub fn uninstall(purge_data: bool) -> Result<(), String> {
    let program_files =
        env::var("ProgramFiles").map_err(|_| "ProgramFiles is not set".to_string())?;
    let program_data = env::var("ProgramData").map_err(|_| "ProgramData is not set".to_string())?;
    stop_service("LINKWATCH");
    run_sc("delete", "LINKWATCH");
    let _ = Command::new("reg.exe")
        .args([
            "DELETE",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "LINKWATCH",
            "/f",
        ])
        .status();
    let install_root = PathBuf::from(program_files).join("LINKWATCH");
    if install_root.exists() {
        let current = env::current_exe().ok();
        let running_from_install = current
            .as_ref()
            .map(|path| path.starts_with(&install_root))
            .unwrap_or(false);
        if running_from_install {
            remove_after_exit(&install_root);
        } else {
            fs::remove_dir_all(&install_root)
                .map_err(|error| format!("remove installed binaries: {error}"))?;
        }
    }
    if purge_data {
        let data_root = PathBuf::from(program_data).join("LINKWATCH");
        if data_root.exists() {
            fs::remove_dir_all(data_root)
                .map_err(|error| format!("remove ProgramData: {error}"))?;
        }
    }
    Ok(())
}

fn protect_token(path: &Path) -> Result<(), String> {
    let status = Command::new("icacls.exe")
        .arg(path)
        .arg("/inheritance:r")
        // Use well-known SIDs instead of localized account names.  On a
        // non-English Windows image `SYSTEM`/`Administrators` can otherwise
        // fail with icacls error 1332 (name-to-SID mapping unavailable).
        .args(["/grant:r", "*S-1-5-18:(R)", "*S-1-5-32-544:(R)"])
        .status()
        .map_err(|error| format!("set token ACL: {error}"))?;
    if !status.success() {
        return Err(format!("icacls failed with {status}"));
    }
    Ok(())
}

fn run_sc(command: &str, name: &str) {
    let _ = run_sc_args(&[command, name]);
}

fn stop_service(name: &str) {
    let _ = Command::new("sc.exe").args(["stop", name]).status();
    for _ in 0..60 {
        let Ok(output) = Command::new("sc.exe").args(["query", name]).output() else {
            break;
        };
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).contains("STOPPED") {
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn stop_installed_process(image: &str) {
    // The tray is a separate process but uses the same image as the service.
    // Kill any old copy before replacing Program Files\LINKWATCH\*.exe.
    let _ = Command::new("taskkill").args(["/IM", image, "/F"]).status();
}

fn remove_after_exit(path: &Path) {
    let escaped = path.display().to_string().replace('\'', "''");
    let script = format!(
        "Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath '{escaped}' -Recurse -Force -ErrorAction SilentlyContinue"
    );
    let _ = Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .spawn();
}

fn run_sc_args(args: &[&str]) -> Result<(), String> {
    let status = Command::new("sc.exe")
        .args(args)
        .status()
        .map_err(|error| format!("run sc.exe: {error}"))?;
    if !status.success() {
        return Err(format!("sc.exe {:?} failed with {status}", args));
    }
    Ok(())
}

fn run_reg_run(binary: &Path) -> Result<(), String> {
    // Explorer starts Run entries from the interactive session. Keep the
    // value as the agent executable itself rather than routing through a
    // shell; tray mode detaches its console immediately.
    let command = format!("\"{}\" tray", binary.display());
    let status = Command::new("reg.exe")
        .args([
            "ADD",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "LINKWATCH",
            "/t",
            "REG_SZ",
            "/d",
            &command,
            "/f",
        ])
        .status()
        .map_err(|error| format!("register tray autostart: {error}"))?;
    if !status.success() {
        return Err(format!("reg.exe failed with {status}"));
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
