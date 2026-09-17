//! First-run bootstrap for the single Windows release binary.  It performs
//! only local installation work and never puts the device token in a service
//! command line.  Subsequent service/tray starts use the normal `run` and
//! `tray` modes.

#![cfg(windows)]

use crate::config::Config;
use serde_json::json;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

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

    run_sc("stop", "LINKWATCH");
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
    run_reg_run(&install_root.join("linkwatch-agent.exe"))?;
    run_sc_args(&["start", "LINKWATCH"])?;

    let tray_command = format!(
        "& '{}' tray",
        installed.display().to_string().replace('\'', "''")
    );
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &tray_command,
        ])
        .spawn();
    crate::logging::event("Windows installation completed; service and tray started");
    // The original bootstrap may be removed by the operator after this
    // process exits. Windows does not permit unlinking the currently running
    // image, so do not invoke a shell with an untrusted path just to delete it.
    if current != installed {
        let _ = fs::remove_file(&current);
    }
    Ok(())
}

pub fn uninstall(purge_data: bool) -> Result<(), String> {
    let program_files =
        env::var("ProgramFiles").map_err(|_| "ProgramFiles is not set".to_string())?;
    let program_data = env::var("ProgramData").map_err(|_| "ProgramData is not set".to_string())?;
    run_sc("stop", "LINKWATCH");
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
        fs::remove_dir_all(&install_root)
            .map_err(|error| format!("remove installed binaries: {error}"))?;
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
        .args(["/grant:r", "SYSTEM:(R)", "Administrators:(R)"])
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
    let escaped = binary.display().to_string().replace('\'', "''");
    let command = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -Command \"& '{}' tray\"",
        escaped
    );
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
