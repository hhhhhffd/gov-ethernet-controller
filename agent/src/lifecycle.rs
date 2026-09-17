use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

struct StopState {
    requested: AtomicBool,
    wake: (Mutex<()>, Condvar),
}

/// A process-local cancellation token that can also wake a sleeping run loop.
#[derive(Clone)]
pub struct StopToken {
    state: Arc<StopState>,
}

impl StopToken {
    pub fn new() -> Self {
        Self {
            state: Arc::new(StopState {
                requested: AtomicBool::new(false),
                wake: (Mutex::new(()), Condvar::new()),
            }),
        }
    }

    pub fn request_stop(&self) {
        self.state.requested.store(true, Ordering::SeqCst);
        self.state.wake.1.notify_all();
    }

    pub fn is_requested(&self) -> bool {
        self.state.requested.load(Ordering::SeqCst)
    }

    /// Wait for either the duration to elapse or a stop request to arrive.
    /// Returns `true` when shutdown has been requested.
    pub fn wait(&self, duration: Duration) -> bool {
        if self.is_requested() {
            return true;
        }
        let guard = match self.state.wake.0.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if self.is_requested() {
            return true;
        }
        match self.state.wake.1.wait_timeout(guard, duration) {
            Ok((_guard, _timeout)) => self.is_requested(),
            Err(poisoned) => {
                let (_guard, _timeout) = poisoned.into_inner();
                self.is_requested()
            }
        }
    }
}

pub fn install_signal_handler() -> Result<StopToken, String> {
    let token = StopToken::new();
    let handler_token = token.clone();
    ctrlc::set_handler(move || handler_token.request_stop())
        .map_err(|error| format!("install shutdown signal handler: {error}"))?;
    Ok(token)
}

/// Holds an advisory OS file lock for the lifetime of a running agent.
///
/// The lock is deliberately tied to the queue directory so two processes that
/// share a spool cannot race on the scheduler cursor or upload acknowledgements.
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    pub fn acquire(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { _file: file }),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "another agent instance is already running ({})",
                    path.display()
                ),
            )),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{InstanceLock, StopToken};
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    use tempfile::tempdir;

    #[test]
    fn stop_token_interrupts_wait() {
        let token = StopToken::new();
        let worker_token = token.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            ready_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(25));
            worker_token.request_stop();
        });

        ready_rx.recv().unwrap();
        let started = Instant::now();
        assert!(token.wait(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(1));
        worker.join().unwrap();
    }

    #[test]
    fn instance_lock_rejects_a_second_holder_and_releases_on_drop() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".instance.lock");
        let first = InstanceLock::acquire(&path).unwrap();
        let second = match InstanceLock::acquire(&path) {
            Ok(_) => panic!("a second instance unexpectedly acquired the lock"),
            Err(error) => error,
        };
        assert_eq!(second.kind(), std::io::ErrorKind::AlreadyExists);
        drop(first);
        InstanceLock::acquire(path).unwrap();
    }
}
