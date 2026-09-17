//! Small Windows SCM adapter.  The monitoring runtime remains in `main.rs`;
//! this module only translates SCM start/stop events into the existing
//! process-local StopToken so Linux and the diagnostic CLI keep their current
//! behaviour.

#![cfg(windows)]

use crate::lifecycle::StopToken;
use std::{
    ffi::c_void,
    ptr,
    sync::{Mutex, OnceLock},
};

type Dword = u32;
type Bool = i32;
type ServiceStatusHandle = *mut c_void;
type ServiceMain = unsafe extern "system" fn(Dword, *mut *mut u16);
type HandlerEx = unsafe extern "system" fn(Dword, Dword, *mut c_void, *mut c_void) -> Dword;

#[repr(C)]
struct ServiceTableEntry {
    service_name: *mut u16,
    service_main: Option<ServiceMain>,
}

#[repr(C)]
struct ServiceStatus {
    service_type: Dword,
    current_state: Dword,
    controls_accepted: Dword,
    win32_exit_code: Dword,
    service_specific_exit_code: Dword,
    check_point: Dword,
    wait_hint: Dword,
}

const SERVICE_WIN32_OWN_PROCESS: Dword = 0x00000010;
const SERVICE_START_PENDING: Dword = 0x00000002;
const SERVICE_RUNNING: Dword = 0x00000004;
const SERVICE_STOP_PENDING: Dword = 0x00000003;
const SERVICE_STOPPED: Dword = 0x00000001;
const SERVICE_ACCEPT_STOP: Dword = 0x00000001;
const SERVICE_ACCEPT_SHUTDOWN: Dword = 0x00000004;
const SERVICE_CONTROL_STOP: Dword = 0x00000001;
const SERVICE_CONTROL_SHUTDOWN: Dword = 0x00000005;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: Dword = 1063;

#[link(name = "advapi32")]
extern "system" {
    fn StartServiceCtrlDispatcherW(table: *const ServiceTableEntry) -> Bool;
    fn RegisterServiceCtrlHandlerExW(
        service_name: *const u16,
        handler: Option<HandlerEx>,
        context: *mut c_void,
    ) -> ServiceStatusHandle;
    fn SetServiceStatus(handle: ServiceStatusHandle, status: *const ServiceStatus) -> Bool;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> Dword;
}

static STOP_TOKEN: OnceLock<Mutex<Option<StopToken>>> = OnceLock::new();
static STATUS_HANDLE: OnceLock<Mutex<Option<usize>>> = OnceLock::new();

pub fn try_dispatch() -> Result<bool, String> {
    let mut name = "LINKWATCH"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let table = [
        ServiceTableEntry {
            service_name: name.as_mut_ptr(),
            service_main: Some(service_main),
        },
        ServiceTableEntry {
            service_name: ptr::null_mut(),
            service_main: None,
        },
    ];
    let started = unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } != 0;
    if started {
        return Ok(true);
    }
    let error = unsafe { GetLastError() };
    if error == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT {
        return Ok(false);
    }
    Err(format!(
        "StartServiceCtrlDispatcherW failed with Windows error {error}"
    ))
}

unsafe extern "system" fn service_main(_argc: Dword, _argv: *mut *mut u16) {
    let service_name = "LINKWATCH"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = RegisterServiceCtrlHandlerExW(
        service_name.as_ptr(),
        Some(service_handler),
        ptr::null_mut(),
    );
    if handle.is_null() {
        return;
    }
    let _ = STATUS_HANDLE.set(Mutex::new(Some(handle as usize)));
    report(SERVICE_START_PENDING, 0, 10_000);
    let stop = StopToken::new();
    let _ = STOP_TOKEN.set(Mutex::new(Some(stop.clone())));
    report(
        SERVICE_RUNNING,
        SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN,
        0,
    );
    let result = crate::run_service_mode(stop);
    report(SERVICE_STOP_PENDING, 0, 10_000);
    if let Err(error) = result {
        crate::logging::event(format!("fatal service runtime error: {error}"));
    }
    report(SERVICE_STOPPED, 0, 0);
}

unsafe extern "system" fn service_handler(
    control: Dword,
    _event_type: Dword,
    _event_data: *mut c_void,
    _context: *mut c_void,
) -> Dword {
    if control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN {
        if let Some(lock) = STOP_TOKEN.get() {
            if let Ok(guard) = lock.lock() {
                if let Some(stop) = guard.as_ref() {
                    stop.request_stop();
                }
            }
        }
    }
    0
}

fn report(state: Dword, accepted: Dword, wait_hint: Dword) {
    let Some(lock) = STATUS_HANDLE.get() else {
        return;
    };
    let Ok(guard) = lock.lock() else { return };
    let Some(handle) = *guard else { return };
    let status = ServiceStatus {
        service_type: SERVICE_WIN32_OWN_PROCESS,
        current_state: state,
        controls_accepted: accepted,
        win32_exit_code: 0,
        service_specific_exit_code: 0,
        check_point: 0,
        wait_hint,
    };
    unsafe {
        let _ = SetServiceStatus(handle as ServiceStatusHandle, &status);
    }
}
