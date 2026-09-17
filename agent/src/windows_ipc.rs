//! Local-only control channel for the tray.  A named pipe is not reachable
//! through TCP and therefore does not add a listening network surface.

#![cfg(windows)]

use crate::ManualProbeControl;
use std::{ffi::c_void, fs, os::windows::ffi::OsStrExt, path::PathBuf, ptr, sync::Arc, thread};

type Handle = *mut c_void;
type Dword = u32;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const PIPE_ACCESS_DUPLEX: Dword = 0x00000003;
const PIPE_TYPE_MESSAGE: Dword = 0x00000004;
const PIPE_READMODE_MESSAGE: Dword = 0x00000002;
const PIPE_WAIT: Dword = 0x00000000;
const GENERIC_READ: Dword = 0x80000000;
const GENERIC_WRITE: Dword = 0x40000000;
const OPEN_EXISTING: Dword = 3;
const ERROR_PIPE_CONNECTED: Dword = 535;

#[repr(C)]
struct SecurityAttributes {
    length: Dword,
    descriptor: *mut c_void,
    inherit_handle: i32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: Dword,
        pipe_mode: Dword,
        max_instances: Dword,
        out_buffer_size: Dword,
        in_buffer_size: Dword,
        default_timeout: Dword,
        security_attributes: *mut c_void,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> i32;
    fn DisconnectNamedPipe(pipe: Handle) -> i32;
    fn ReadFile(
        pipe: Handle,
        buffer: *mut u8,
        length: Dword,
        read: *mut Dword,
        overlapped: *mut c_void,
    ) -> i32;
    fn WriteFile(
        pipe: Handle,
        buffer: *const u8,
        length: Dword,
        written: *mut Dword,
        overlapped: *mut c_void,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> Dword;
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string_security_descriptor: *const u16,
        string_sd_revision: Dword,
        security_descriptor: *mut *mut c_void,
        security_descriptor_size: *mut Dword,
    ) -> i32;
}

pub fn start(queue_dir: PathBuf, control: Arc<ManualProbeControl>) -> thread::JoinHandle<()> {
    thread::spawn(move || serve(queue_dir, control))
}

fn serve(queue_dir: PathBuf, control: Arc<ManualProbeControl>) {
    let name = wide(r"\\.\pipe\LINKWATCH");
    // Let the logged-in interactive user control its own tray while keeping
    // the pipe local and excluding anonymous/network identities.
    let sddl = wide("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;IU)");
    let mut descriptor = ptr::null_mut();
    let mut descriptor_size = 0;
    let security_ready = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            &mut descriptor_size,
        ) != 0
    };
    if !security_ready {
        crate::logging::event("named pipe security descriptor setup failed");
        return;
    }
    let mut security = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as Dword,
        descriptor,
        inherit_handle: 0,
    };
    loop {
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                1,
                16 * 1024,
                16 * 1024,
                1_000,
                &mut security,
            )
        };
        if pipe == INVALID_HANDLE_VALUE || pipe.is_null() {
            return;
        }
        let connected = unsafe {
            ConnectNamedPipe(pipe, ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED
        };
        if connected {
            let mut buffer = [0u8; 16 * 1024];
            let mut read = 0;
            if unsafe {
                ReadFile(
                    pipe,
                    buffer.as_mut_ptr(),
                    buffer.len() as Dword,
                    &mut read,
                    ptr::null_mut(),
                )
            } != 0
            {
                let request = String::from_utf8_lossy(&buffer[..read as usize]);
                let response = handle_request(request.trim(), &queue_dir, &control);
                let mut written = 0;
                let _ = unsafe {
                    WriteFile(
                        pipe,
                        response.as_ptr(),
                        response.len() as Dword,
                        &mut written,
                        ptr::null_mut(),
                    )
                };
            }
            unsafe {
                let _ = DisconnectNamedPipe(pipe);
            }
        }
        unsafe {
            let _ = CloseHandle(pipe);
        }
    }
}

fn handle_request(request: &str, queue_dir: &PathBuf, control: &ManualProbeControl) -> Vec<u8> {
    match request {
        "probe" => {
            if control.running.load(std::sync::atomic::Ordering::SeqCst)
                || control
                    .requested
                    .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                br#"{"ok":false,"error":"probe_already_running"}"#.to_vec()
            } else {
                br#"{"ok":true,"status":"started"}"#.to_vec()
            }
        }
        "status" => fs::read(queue_dir.join(".runtime-state"))
            .unwrap_or_else(|_| br#"{"status":"starting"}"#.to_vec()),
        _ => br#"{"ok":false,"error":"unknown_command"}"#.to_vec(),
    }
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
