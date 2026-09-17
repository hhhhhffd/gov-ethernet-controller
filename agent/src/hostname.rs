use std::{env, fs, process::Command};

/// Return the operating system hostname without making it part of device
/// identity.  COMPUTERNAME is the native Windows value; HOSTNAME covers the
/// usual Linux environment; `/etc/hostname` and the command fallback also work
/// for minimal service environments where neither variable is exported.
pub fn detect() -> Option<String> {
    #[cfg(windows)]
    {
        return env::var("COMPUTERNAME")
            .ok()
            .and_then(normalize)
            .or_else(command_hostname)
            .or_else(|| env::var("HOSTNAME").ok().and_then(normalize));
    }
    #[cfg(not(windows))]
    {
        command_hostname()
            .or_else(|| env::var("HOSTNAME").ok().and_then(normalize))
            .or_else(file_hostname)
            .or_else(|| env::var("COMPUTERNAME").ok().and_then(normalize))
    }
}

fn command_hostname() -> Option<String> {
    Command::new("hostname")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(normalize)
}

#[cfg(not(windows))]
fn file_hostname() -> Option<String> {
    fs::read_to_string("/etc/hostname").ok().and_then(normalize)
}

fn normalize(value: String) -> Option<String> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > 255 {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn hostname_is_trimmed_and_bounded() {
        assert_eq!(
            normalize(" DESKTOP-ABC123\n".into()).as_deref(),
            Some("DESKTOP-ABC123")
        );
        assert!(normalize(String::new()).is_none());
        assert!(normalize("x".repeat(256)).is_none());
    }
}
