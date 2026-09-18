#[cfg(not(windows))]
fn main() {
    eprintln!("linkwatch-tray is available on Windows only");
}

#[cfg(windows)]
mod win {
    #![allow(static_mut_refs)]
    use std::{
        ffi::{c_void, OsStr},
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };

    type Dword = u32;
    type Bool = i32;
    type Handle = *mut c_void;
    type Hwnd = Handle;
    type Hicon = Handle;
    type Hinstance = Handle;
    type Hmenu = Handle;

    const WM_DESTROY: u32 = 0x0002;
    const WM_COMMAND: u32 = 0x0111;
    const WM_TIMER: u32 = 0x0113;
    const WM_APP: u32 = 0x8000;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_LBUTTONDBLCLK: u32 = 0x0203;
    const TRAY_MESSAGE: u32 = WM_APP + 1;
    const TIMER_STATUS: usize = 1;
    const ID_PROBE: usize = 1001;
    const ID_DASHBOARD: usize = 1002;
    const ID_DIAGNOSTICS: usize = 1003;
    const ID_EXIT: usize = 1004;
    const NIM_ADD: Dword = 0;
    const NIM_MODIFY: Dword = 1;
    const NIM_DELETE: Dword = 2;
    const NIF_MESSAGE: Dword = 1;
    const NIF_ICON: Dword = 2;
    const NIF_TIP: Dword = 4;
    const MF_STRING: Dword = 0;
    const MF_SEPARATOR: Dword = 0x800;
    const TPM_RIGHTBUTTON: Dword = 2;
    const SW_SHOWNORMAL: i32 = 1;
    const MB_OK: u32 = 0;
    const GMEM_MOVEABLE: u32 = 2;
    const CF_UNICODETEXT: u32 = 13;
    const GENERIC_READ: Dword = 0x80000000;
    const GENERIC_WRITE: Dword = 0x40000000;
    const OPEN_EXISTING: Dword = 3;
    const FILE_ATTRIBUTE_NORMAL: Dword = 0x80;
    const IDI_APPLICATION: usize = 32512;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: Dword,
        point: Point,
    }
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;
    #[repr(C)]
    struct WndClassW {
        style: Dword,
        wnd_proc: Option<WndProc>,
        cls_extra: i32,
        wnd_extra: i32,
        instance: Hinstance,
        icon: Hicon,
        cursor: Handle,
        background: Handle,
        menu_name: *const u16,
        class_name: *const u16,
    }
    #[repr(C)]
    struct NotifyIconDataW {
        cb_size: Dword,
        hwnd: Hwnd,
        id: Dword,
        flags: Dword,
        callback_message: Dword,
        icon: Hicon,
        tip: [u16; 128],
        state: Dword,
        state_mask: Dword,
        info: [u16; 256],
        version: Dword,
        info_title: [u16; 64],
        info_flags: Dword,
        guid: [u8; 16],
        balloon_icon: Hicon,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> u16;
        fn CreateWindowExW(
            ex_style: Dword,
            class: *const u16,
            title: *const u16,
            style: Dword,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: Hmenu,
            instance: Hinstance,
            param: *mut c_void,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, message: u32, w_param: usize, l_param: isize) -> isize;
        fn DestroyWindow(hwnd: Hwnd) -> Bool;
        fn GetMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> Bool;
        fn DispatchMessageW(msg: *const Msg) -> isize;
        fn PostQuitMessage(code: i32);
        fn LoadIconW(instance: Hinstance, name: *const u16) -> Hicon;
        fn CreatePopupMenu() -> Hmenu;
        fn AppendMenuW(menu: Hmenu, flags: Dword, id: usize, text: *const u16) -> Bool;
        fn TrackPopupMenu(
            menu: Hmenu,
            flags: Dword,
            x: i32,
            y: i32,
            reserved: i32,
            hwnd: Hwnd,
            rect: *const c_void,
        ) -> Bool;
        fn DestroyMenu(menu: Hmenu) -> Bool;
        fn GetCursorPos(point: *mut Point) -> Bool;
        fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, flags: u32) -> i32;
        fn SetTimer(hwnd: Hwnd, id: usize, interval: u32, callback: *const c_void) -> usize;
        fn KillTimer(hwnd: Hwnd, id: usize) -> Bool;
        fn OpenClipboard(hwnd: Hwnd) -> Bool;
        fn EmptyClipboard() -> Bool;
        fn SetClipboardData(format: u32, data: Handle) -> Handle;
        fn CloseClipboard() -> Bool;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn Shell_NotifyIconW(message: Dword, data: *mut NotifyIconDataW) -> Bool;
        fn ShellExecuteW(
            hwnd: Hwnd,
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
        fn CreateFileW(
            name: *const u16,
            access: Dword,
            share: Dword,
            security: *mut c_void,
            creation: Dword,
            flags: Dword,
            template: Handle,
        ) -> Handle;
        fn ReadFile(
            file: Handle,
            buffer: *mut u8,
            length: Dword,
            read: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
        fn WriteFile(
            file: Handle,
            buffer: *const u8,
            length: Dword,
            written: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn GlobalAlloc(flags: Dword, bytes: usize) -> Handle;
        fn GlobalLock(handle: Handle) -> *mut c_void;
        fn GlobalUnlock(handle: Handle) -> Bool;
        fn FreeConsole() -> Bool;
    }

    static mut TRAY: Option<NotifyIconDataW> = None;
    static mut STATUS: String = String::new();
    static mut DASHBOARD: String = String::new();

    pub fn run() {
        unsafe {
            // Keep the console-subsystem binary for the existing CLI modes,
            // but make tray a quiet session UI. FreeConsole detaches only
            // this process, so a shell that launched `tray` stays intact.
            FreeConsole();
            let class = wide("LINKWATCH_TRAY_WINDOW");
            let instance = GetModuleHandleW(null());
            let icon = LoadIconW(null_mut(), IDI_APPLICATION as *const u16);
            let window_class = WndClassW {
                style: 0,
                wnd_proc: Some(window_proc),
                cls_extra: 0,
                wnd_extra: 0,
                instance,
                icon,
                cursor: null_mut(),
                background: null_mut(),
                menu_name: null(),
                class_name: class.as_ptr(),
            };
            RegisterClassW(&window_class);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                null_mut(),
            );
            let mut data: NotifyIconDataW = zeroed();
            data.cb_size = size_of::<NotifyIconDataW>() as Dword;
            data.hwnd = hwnd;
            data.id = 1;
            data.flags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            data.callback_message = TRAY_MESSAGE;
            data.icon = icon;
            set_tip(&mut data, "LINKWATCH");
            Shell_NotifyIconW(NIM_ADD, &mut data);
            TRAY = Some(data);
            update_status(hwnd);
            SetTimer(hwnd, TIMER_STATUS, 30_000, null());

            let mut msg: Msg = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if let Some(mut data) = TRAY.take() {
                Shell_NotifyIconW(NIM_DELETE, &mut data);
            }
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
    ) -> isize {
        match message {
            TRAY_MESSAGE
                if (l_param as u32 == WM_RBUTTONUP || l_param as u32 == WM_LBUTTONDBLCLK) =>
            {
                if l_param as u32 == WM_LBUTTONDBLCLK {
                    diagnostics(hwnd);
                } else {
                    show_menu(hwnd);
                }
                0
            }
            WM_COMMAND => {
                match w_param & 0xffff {
                    ID_PROBE => {
                        let response = pipe_request("probe");
                        let response = String::from_utf8_lossy(&response);
                        let message = if response.contains("probe_already_running") {
                            "Замер уже выполняется"
                        } else if response.contains("\"ok\":true") {
                            "Замер поставлен в очередь"
                        } else {
                            "Агент недоступен; проверьте диагностику"
                        };
                        show_message(hwnd, message, "LINKWATCH");
                    }
                    ID_DASHBOARD => open_dashboard(hwnd),
                    ID_DIAGNOSTICS => diagnostics(hwnd),
                    ID_EXIT => {
                        KillTimer(hwnd, TIMER_STATUS);
                        DestroyWindow(hwnd);
                    }
                    _ => {}
                }
                0
            }
            WM_TIMER if w_param == TIMER_STATUS => {
                update_status(hwnd);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, w_param, l_param),
        }
    }

    unsafe fn show_menu(hwnd: Hwnd) {
        let menu = CreatePopupMenu();
        let status = status_label(field(&STATUS, "status").as_deref().unwrap_or("starting"));
        let last_probe = field(&STATUS, "last_probe_at").unwrap_or_else(|| "нет данных".into());
        let status_text = wide(&format!("Статус: {status}"));
        let probe_text = wide(&format!("Последний замер: {last_probe}"));
        let _ = AppendMenuW(menu, MF_STRING, 0, status_text.as_ptr());
        let _ = AppendMenuW(menu, MF_STRING, 0, probe_text.as_ptr());
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, null());
        let _ = AppendMenuW(
            menu,
            MF_STRING,
            ID_PROBE,
            wide("Провести замер сейчас").as_ptr(),
        );
        let _ = AppendMenuW(
            menu,
            MF_STRING,
            ID_DASHBOARD,
            wide("Открыть веб-панель").as_ptr(),
        );
        let _ = AppendMenuW(
            menu,
            MF_STRING,
            ID_DIAGNOSTICS,
            wide("Диагностика (скопировать)").as_ptr(),
        );
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, null());
        let _ = AppendMenuW(menu, MF_STRING, ID_EXIT, wide("Выход из tray").as_ptr());
        let mut point = Point { x: 0, y: 0 };
        GetCursorPos(&mut point);
        TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, hwnd, null());
        DestroyMenu(menu);
    }

    unsafe fn update_status(hwnd: Hwnd) {
        STATUS = String::from_utf8_lossy(&pipe_request("status")).into_owned();
        DASHBOARD = field(&STATUS, "dashboard_url")
            .or_else(|| field(&STATUS, "server"))
            .unwrap_or_default();
        if let Some(data) = TRAY.as_mut() {
            let state = status_label(field(&STATUS, "status").as_deref().unwrap_or("starting"));
            let queue = field(&STATUS, "queue_depth").unwrap_or_else(|| "0".into());
            let last_probe =
                field(&STATUS, "last_probe_at").unwrap_or_else(|| "нет данных".into());
            let tip = format!("LINKWATCH\nСостояние: {state}\nПоследний замер: {last_probe}\nОчередь: {queue}");
            set_tip(data, &tip);
            Shell_NotifyIconW(NIM_MODIFY, data);
        }
        let _ = hwnd;
    }

    unsafe fn diagnostics(hwnd: Hwnd) {
        let text = if STATUS.is_empty() {
            "Нет связи с агентом".into()
        } else {
            diagnostic_text(&STATUS)
        };
        copy_clipboard(&text);
        show_message(hwnd, &text, "LINKWATCH — диагностика (скопировано)");
    }

    unsafe fn open_dashboard(hwnd: Hwnd) {
        let url = if DASHBOARD.is_empty() {
            "http://127.0.0.1:8080"
        } else {
            &DASHBOARD
        };
        let _ = ShellExecuteW(
            hwnd,
            wide("open").as_ptr(),
            wide(url).as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        );
    }

    unsafe fn show_message(hwnd: Hwnd, text: &str, caption: &str) {
        MessageBoxW(hwnd, wide(text).as_ptr(), wide(caption).as_ptr(), MB_OK);
    }

    unsafe fn copy_clipboard(value: &str) {
        if OpenClipboard(null_mut()) == 0 {
            return;
        }
        EmptyClipboard();
        let raw = wide(value);
        let memory = GlobalAlloc(GMEM_MOVEABLE, raw.len() * 2);
        if !memory.is_null() {
            let target = GlobalLock(memory) as *mut u16;
            if !target.is_null() {
                std::ptr::copy_nonoverlapping(raw.as_ptr(), target, raw.len());
                GlobalUnlock(memory);
                SetClipboardData(CF_UNICODETEXT, memory);
            }
        }
        CloseClipboard();
    }

    unsafe fn pipe_request(request: &str) -> Vec<u8> {
        let pipe = CreateFileW(
            wide(r"\\.\pipe\LINKWATCH").as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        );
        if pipe.is_null() || pipe as isize == -1 {
            return br#"{"status":"server_unavailable"}"#.to_vec();
        }
        let bytes = request.as_bytes();
        let mut written = 0;
        let _ = WriteFile(
            pipe,
            bytes.as_ptr(),
            bytes.len() as Dword,
            &mut written,
            null_mut(),
        );
        let mut buffer = [0u8; 16 * 1024];
        let mut read = 0;
        let ok = ReadFile(
            pipe,
            buffer.as_mut_ptr(),
            buffer.len() as Dword,
            &mut read,
            null_mut(),
        ) != 0;
        CloseHandle(pipe);
        if ok {
            buffer[..read as usize].to_vec()
        } else {
            br#"{"status":"server_unavailable"}"#.to_vec()
        }
    }

    unsafe fn set_tip(data: &mut NotifyIconDataW, value: &str) {
        data.tip = [0; 128];
        let raw = wide(value);
        let count = raw.len().min(data.tip.len() - 1);
        data.tip[..count].copy_from_slice(&raw[..count]);
    }

    fn field(json: &str, name: &str) -> Option<String> {
        let needle = format!("\"{name}\":");
        let start = json.find(&needle)? + needle.len();
        let value = json[start..].trim_start();
        if let Some(value) = value.strip_prefix('\"') {
            return value.split('\"').next().map(str::to_string);
        }
        Some(value.split([',', '}']).next()?.trim().to_string())
    }

    fn diagnostic_text(json: &str) -> String {
        let value = |name: &str, fallback: &str| {
            field(json, name).filter(|value| !value.is_empty()).unwrap_or_else(|| fallback.into())
        };
        format!(
            "Device ID: {}\nHostname: {}\nAgent version: {}\nServer: {}\nСтатус связи: {}\nПоследний heartbeat: {}\nПоследний замер: {}\nПоследний probe status: {}\nQueue depth: {}\nUptime: {} s",
            value("device_id", "нет данных"),
            value("hostname", "нет данных"),
            value("agent_version", "нет данных"),
            value("server", "нет данных"),
            status_label(&value("status", "starting")),
            value("last_successful_heartbeat", "нет данных"),
            value("last_probe_at", "нет данных"),
            value("last_probe_status", "нет данных"),
            value("queue_depth", "0"),
            value("uptime_seconds", "0"),
        )
    }

    fn status_label(value: &str) -> &'static str {
        match value {
            "working" => "Работает",
            "server_unavailable" => "Нет связи с сервером",
            "connection_problem" => "Проблема соединения",
            "error" => "Ошибка агента",
            "starting" => "Запускается",
            _ => "Неизвестно",
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(windows)]
pub fn run() {
    win::run();
}

#[cfg(windows)]
fn main() {
    run();
}
