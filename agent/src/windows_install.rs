//! First-run bootstrap for the single Windows release binary.  It performs
//! only local installation work and never puts the device token in a service
//! command line.  Subsequent service/tray starts use the normal `run` and
//! `tray` modes.

#![cfg(windows)]

use crate::{client::Client, config::Config, hostname};
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
type Hwnd = Handle;
type Hinstance = Handle;
type Wparam = usize;
type Lparam = isize;
type Lresult = isize;
const SW_HIDE: i32 = 0;
const SW_SHOW: i32 = 5;
const WM_NCCREATE: u32 = 0x0081;
const WM_CREATE: u32 = 0x0001;
const WM_COMMAND: u32 = 0x0111;
const WM_CLOSE: u32 = 0x0010;
const WM_DESTROY: u32 = 0x0002;
const GWLP_USERDATA: i32 = -21;
const WS_OVERLAPPED: u32 = 0x0000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const WS_BORDER: u32 = 0x0080_0000;
const ES_AUTOHSCROLL: u32 = 0x0080;
const BS_DEFPUSHBUTTON: u32 = 0x0001;
const MB_OK: u32 = 0;
const MB_ICONINFORMATION: u32 = 0x40;
const MB_ICONERROR: u32 = 0x10;
const ID_CONNECT: usize = 1001;
const ID_CANCEL: usize = 1002;
const ID_CODE_INPUT: usize = 1003;

#[repr(C)]
struct WndClassW {
    style: u32,
    window_proc: Option<unsafe extern "system" fn(Hwnd, u32, Wparam, Lparam) -> Lresult>,
    class_extra: i32,
    window_extra: i32,
    instance: Hinstance,
    icon: Handle,
    cursor: Handle,
    background: Handle,
    menu_name: *const u16,
    class_name: *const u16,
}

#[repr(C)]
struct CreateStructW {
    create_params: *mut c_void,
    instance: Hinstance,
    menu: Handle,
    parent: Hwnd,
    height: i32,
    width: i32,
    y: i32,
    x: i32,
    style: i32,
    name: *const u16,
    class_name: *const u16,
    extended_style: u32,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Message {
    hwnd: Hwnd,
    message: u32,
    wparam: Wparam,
    lparam: Lparam,
    time: u32,
    point: Point,
    private: u32,
}

struct EnrollmentDialogState {
    code: Option<String>,
    input: Hwnd,
}

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

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Hinstance;
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(class: *const WndClassW) -> u16;
    fn CreateWindowExW(
        extended_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Hwnd,
        menu: Handle,
        instance: Hinstance,
        parameter: *mut c_void,
    ) -> Hwnd;
    fn DefWindowProcW(hwnd: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
    fn DestroyWindow(hwnd: Hwnd) -> i32;
    fn PostQuitMessage(exit_code: i32);
    fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
    fn UpdateWindow(hwnd: Hwnd) -> i32;
    fn GetMessageW(message: *mut Message, hwnd: Hwnd, minimum: u32, maximum: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> Lresult;
    fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
    fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
    fn GetWindowTextW(hwnd: Hwnd, buffer: *mut u16, maximum: i32) -> i32;
    fn SetFocus(hwnd: Hwnd) -> Hwnd;
    fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, style: u32) -> i32;
    fn LoadCursorW(instance: Hinstance, cursor_name: *const u16) -> Handle;
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
    let token_path = data_root.join("device-token");
    let config_path = data_root.join("config.json");
    let has_existing_installation = token_path.exists() || config_path.exists();
    let mut config = Config::load_for_install()?;
    if has_existing_installation && !config.has_device_credentials() {
        return Err("the existing LINKWATCH installation has incomplete credentials; restore its protected ProgramData files before reinstalling".into());
    }
    if !config.has_device_credentials() {
        let hostname = hostname::detect().unwrap_or_else(|| "Windows device".into());
        let credentials =
            enroll_with_code(&config.server_url, config.probe.timeout_seconds, &hostname)?;
        config.device_id = credentials.device_id;
        config.device_token = credentials.device_token;
    }
    config.validate_device_credentials()?;

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
    // Reinstall/upgrade runs under the service account or an administrator
    // that may not be the owner of the protected token file. Preserve the
    // existing credential and ACL; token rotation is an explicit operation,
    // not a side effect of replacing the binary.
    ensure_token(&token_path, config.device_token.trim(), protect_token)?;

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
    show_installer_message("LINKWATCH подключён и работает.", MB_ICONINFORMATION);
    Ok(())
}

fn enroll_with_code(
    server_url: &str,
    timeout_seconds: u64,
    hostname: &str,
) -> Result<crate::client::EnrollmentCredentials, String> {
    loop {
        let code = prompt_enrollment_code()?;
        match Client::enroll(
            server_url,
            Duration::from_secs(timeout_seconds.max(1)),
            &code,
            hostname,
            env!("CARGO_PKG_VERSION"),
        ) {
            Ok(credentials) => return Ok(credentials),
            Err(error) => {
                // The code is intentionally not interpolated into this message
                // or an error log. A user can safely retry after correcting it.
                show_installer_message(
                    &format!("Не удалось подключить агент: {error}"),
                    MB_ICONERROR,
                );
            }
        }
    }
}

fn prompt_enrollment_code() -> Result<String, String> {
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    if instance.is_null() {
        return Err("load Windows installer module".into());
    }
    let class_name = wide("LINKWATCHEnrollmentDialog");
    let class = WndClassW {
        style: 0,
        window_proc: Some(enrollment_window_proc),
        class_extra: 0,
        window_extra: 0,
        instance,
        icon: ptr::null_mut(),
        cursor: unsafe { LoadCursorW(ptr::null_mut(), 32512usize as *const u16) },
        background: 6usize as Handle,
        menu_name: ptr::null(),
        class_name: class_name.as_ptr(),
    };
    // A retry opens another dialog in the same process. Windows reports the
    // already-registered class as an error, but it remains safe to reuse.
    unsafe { RegisterClassW(&class) };
    let mut state = EnrollmentDialogState {
        code: None,
        input: ptr::null_mut(),
    };
    let window = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("LINKWATCH").as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
            i32::MIN,
            i32::MIN,
            380,
            190,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            &mut state as *mut EnrollmentDialogState as *mut c_void,
        )
    };
    if window.is_null() {
        return Err("create connection-code window".into());
    }
    unsafe {
        ShowWindow(window, SW_SHOW);
        UpdateWindow(window);
        SetFocus(state.input);
    }
    let mut message = Message {
        hwnd: ptr::null_mut(),
        message: 0,
        wparam: 0,
        lparam: 0,
        time: 0,
        point: Point { x: 0, y: 0 },
        private: 0,
    };
    loop {
        let result = unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    state
        .code
        .filter(|code| !code.trim().is_empty())
        .ok_or_else(|| "connection was cancelled".into())
}

unsafe extern "system" fn enrollment_window_proc(
    window: Hwnd,
    message: u32,
    wparam: Wparam,
    lparam: Lparam,
) -> Lresult {
    if message == WM_NCCREATE {
        let create = lparam as *const CreateStructW;
        if !create.is_null() {
            SetWindowLongPtrW(window, GWLP_USERDATA, (*create).create_params as isize);
        }
    }
    let state = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut EnrollmentDialogState;
    match message {
        WM_NCCREATE => 1,
        WM_COMMAND => {
            let control_id = wparam & 0xffff;
            if control_id == ID_CONNECT {
                if state.is_null() {
                    return 0;
                }
                let code = read_window_text((*state).input);
                if code.trim().is_empty() {
                    show_installer_message("Введите код подключения.", MB_ICONERROR);
                    SetFocus((*state).input);
                    return 0;
                }
                (*state).code = Some(code);
                DestroyWindow(window);
                return 0;
            }
            if control_id == ID_CANCEL {
                DestroyWindow(window);
                return 0;
            }
            0
        }
        WM_CLOSE => {
            DestroyWindow(window);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => {
            if message == WM_CREATE && !state.is_null() {
                create_enrollment_controls(window, state);
                return 0;
            }
            DefWindowProcW(window, message, wparam, lparam)
        }
    }
}

unsafe fn create_enrollment_controls(window: Hwnd, state: *mut EnrollmentDialogState) {
    let instance = GetModuleHandleW(ptr::null());
    CreateWindowExW(
        0,
        wide("STATIC").as_ptr(),
        wide("Код подключения:").as_ptr(),
        WS_CHILD | WS_VISIBLE,
        24,
        28,
        300,
        24,
        window,
        ptr::null_mut(),
        instance,
        ptr::null_mut(),
    );
    (*state).input = CreateWindowExW(
        0,
        wide("EDIT").as_ptr(),
        ptr::null(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
        24,
        55,
        330,
        28,
        window,
        ID_CODE_INPUT as Handle,
        instance,
        ptr::null_mut(),
    );
    CreateWindowExW(
        0,
        wide("BUTTON").as_ptr(),
        wide("Подключить").as_ptr(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
        150,
        105,
        120,
        32,
        window,
        ID_CONNECT as Handle,
        instance,
        ptr::null_mut(),
    );
    CreateWindowExW(
        0,
        wide("BUTTON").as_ptr(),
        wide("Отмена").as_ptr(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        278,
        105,
        76,
        32,
        window,
        ID_CANCEL as Handle,
        instance,
        ptr::null_mut(),
    );
}

unsafe fn read_window_text(window: Hwnd) -> String {
    let length = GetWindowTextLengthW(window).max(0) as usize;
    let mut buffer = vec![0u16; length + 1];
    let copied = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32).max(0) as usize;
    String::from_utf16_lossy(&buffer[..copied])
        .trim()
        .to_string()
}

fn show_installer_message(message: &str, style: u32) {
    let text = wide(message);
    let caption = wide("LINKWATCH");
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | style,
        );
    }
}

fn ensure_token(
    path: &Path,
    token: &str,
    protect: fn(&Path) -> Result<(), String>,
) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    fs::write(path, format!("{token}\n"))
        .map_err(|error| format!("write protected device token: {error}"))?;
    protect(path)?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::ensure_token;
    use std::fs;

    #[test]
    fn reinstall_preserves_existing_token() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("device-token");
        fs::write(&path, "original-token\n").expect("seed token");

        let created = ensure_token(&path, "replacement-token", |_| Ok(())).expect("preserve token");

        assert!(!created);
        assert_eq!(
            fs::read_to_string(path).expect("read token"),
            "original-token\n"
        );
    }
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
