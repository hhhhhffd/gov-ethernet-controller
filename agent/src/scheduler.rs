use rand::{rngs::StdRng, Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const DAY_SECONDS: u64 = 24 * 60 * 60;
const MISSED_SLOT_GRACE_SECONDS: u64 = 60;

/// Durable cursor for the next slot that has not been fired on a calendar
/// day.  Keeping the cursor on disk makes a service restart idempotent: a
/// slot that was already handed to the probe is not immediately collected a
/// second time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    pub day: Option<u64>,
    pub slot_index: usize,
}

impl State {
    pub fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(raw) => serde_json::from_slice(&raw).map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let temporary = path.with_extension("tmp");
        let raw = serde_json::to_vec(self).map_err(io::Error::other)?;
        {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&raw)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, path)?;
        if let Some(parent) = path.parent() {
            if let Ok(directory) = fs::File::open(parent) {
                let _ = directory.sync_all();
            }
        }
        Ok(())
    }
}

/// Return calendar-day offsets for 3–5 performance runs.  Jitter is bounded
/// around evenly spaced slots and never creates a busy loop or a sixth run.
pub fn schedule_for_day(seed: &str, tests_per_day: u8, jitter_minutes: u32) -> Vec<Duration> {
    let count = tests_per_day.clamp(3, 5) as usize;
    let span = 24.0 * 60.0;
    let step = span / count as f64;
    let mut hash = 0u64;
    for byte in seed.as_bytes() {
        hash = hash
            .wrapping_mul(1099511628211)
            .wrapping_add(*byte as u64 + 1);
    }
    let mut rng = StdRng::seed_from_u64(hash);
    // Keep adjacent slots at least one minute apart even when a caller asks
    // for a jitter window wider than half the interval. The effective jitter
    // may therefore be smaller than the requested bound, but never larger.
    let jitter = (jitter_minutes.min(240) as f64 * 60.0).min(((step * 60.0) - 60.0).max(0.0) / 2.0);
    let mut values = (0..count)
        .map(|index| {
            let base = (index as f64 + 0.5) * step;
            let offset = if jitter == 0.0 {
                0.0
            } else {
                rng.gen_range(-jitter..=jitter) / 60.0
            };
            (base + offset).clamp(0.0, span - 1.0)
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.partial_cmp(right).unwrap());
    values
        .into_iter()
        .map(|minutes| Duration::from_secs((minutes * 60.0) as u64))
        .collect()
}

#[allow(dead_code)]
pub fn next_sleep(now: Duration, schedule: &[Duration]) -> Duration {
    schedule
        .iter()
        .copied()
        .find(|event| *event >= now)
        .and_then(|event| event.checked_sub(now))
        .unwrap_or_else(|| {
            Duration::from_secs(DAY_SECONDS)
                .saturating_sub(now.min(Duration::from_secs(DAY_SECONDS)))
        })
}

/// Return the absolute Unix-second deadline and slot index for the next
/// observation.  An uninitialised cursor skips slots that are already stale
/// when the service first starts, but an initialised cursor fires a slot that
/// became due while the process was asleep.  This gives exact-once behaviour
/// around a deadline without replaying an entire missed day after a restart.
pub fn next_deadline(
    epoch_seconds: u64,
    schedule: &[Duration],
    state: &State,
) -> Option<(u64, usize)> {
    if schedule.is_empty() {
        return None;
    }
    let current_day = epoch_seconds / DAY_SECONDS;
    let elapsed = epoch_seconds % DAY_SECONDS;
    let (mut day, mut index) = match state.day {
        Some(day) if day == current_day => {
            // Do not burst-replay a backlog after a long outage. A pending
            // slot is still eligible during the short wake-up grace window;
            // older missed slots are skipped in favour of the next future
            // deadline and the cursor advances when that slot fires.
            let first = schedule
                .iter()
                .enumerate()
                .skip(state.slot_index)
                .find(|(_, event)| {
                    let scheduled = event.as_secs();
                    scheduled >= elapsed
                        || elapsed.saturating_sub(scheduled) <= MISSED_SLOT_GRACE_SECONDS
                })
                .map(|(index, _)| index)
                .unwrap_or(schedule.len());
            (day, first)
        }
        Some(day) if day > current_day => (current_day, 0),
        _ => {
            let first = schedule
                .iter()
                .position(|event| {
                    let scheduled = event.as_secs();
                    scheduled >= elapsed
                        || elapsed.saturating_sub(scheduled) <= MISSED_SLOT_GRACE_SECONDS
                })
                .unwrap_or(schedule.len());
            (current_day, first)
        }
    };

    if index >= schedule.len() {
        day = day.saturating_add(1);
        index = 0;
    }
    Some((day * DAY_SECONDS + schedule[index].as_secs(), index))
}

pub fn mark_fired(state: &mut State, day: u64, slot: usize) {
    if state.day != Some(day) {
        state.day = Some(day);
        state.slot_index = slot.saturating_add(1);
    } else if slot >= state.slot_index {
        state.slot_index = slot.saturating_add(1);
    }
}

pub fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn produces_bounded_daily_runs() {
        for count in 3..=5 {
            let values = schedule_for_day("device-42", count, 30);
            assert_eq!(values.len(), count as usize);
            assert!(values.windows(2).all(|window| window[0] < window[1]));
            assert!(values
                .iter()
                .all(|value| *value < Duration::from_secs(24 * 60 * 60)));
        }
    }
    #[test]
    fn jitter_does_not_move_far_from_slot() {
        let values = schedule_for_day("device-42", 4, 30);
        let step = Duration::from_secs(6 * 60 * 60);
        for (index, value) in values.iter().enumerate() {
            let center = Duration::from_secs((index as u64 * 6 + 3) * 60 * 60);
            assert!((*value).abs_diff(center) <= step);
        }
    }

    #[test]
    fn wide_jitter_keeps_slots_distinct() {
        let values = schedule_for_day("device-wide-jitter", 5, 240);
        assert_eq!(values.len(), 5);
        assert!(values.windows(2).all(|window| window[0] < window[1]));
    }

    #[test]
    fn next_sleep_is_relative_and_due_at_exact_slot() {
        let schedule = vec![Duration::from_secs(3 * 60 * 60)];
        assert_eq!(
            next_sleep(Duration::from_secs(2 * 60 * 60 + 59 * 60 + 59), &schedule),
            Duration::from_secs(1)
        );
        assert_eq!(
            next_sleep(Duration::from_secs(3 * 60 * 60), &schedule),
            Duration::ZERO
        );
        assert_eq!(
            next_sleep(Duration::from_secs(3 * 60 * 60 + 1), &schedule),
            Duration::from_secs(21 * 60 * 60 - 1)
        );
    }

    #[test]
    fn deadline_cursor_fires_once_and_rolls_to_next_day() {
        let schedule = vec![
            Duration::from_secs(3 * 60 * 60),
            Duration::from_secs(9 * 60 * 60),
        ];
        let mut state = State::default();
        let at_025959 = 2 * 60 * 60 + 59 * 60 + 59;
        let (deadline, slot) = next_deadline(at_025959, &schedule, &state).unwrap();
        assert_eq!(deadline - at_025959, 1);
        assert_eq!(slot, 0);
        let at_030000 = 3 * 60 * 60;
        let (deadline, slot) = next_deadline(at_030000, &schedule, &state).unwrap();
        assert_eq!(deadline, at_030000);
        mark_fired(&mut state, 0, slot);
        let (next, next_slot) = next_deadline(at_030000 + 1, &schedule, &state).unwrap();
        assert_eq!(next_slot, 1);
        assert_eq!(next, 9 * 60 * 60);
        mark_fired(&mut state, 0, next_slot);
        let (tomorrow, tomorrow_slot) = next_deadline(23 * 60 * 60, &schedule, &state).unwrap();
        assert_eq!(tomorrow_slot, 0);
        assert_eq!(tomorrow, DAY_SECONDS + 3 * 60 * 60);
    }

    #[test]
    fn persisted_cursor_prevents_restart_duplicate() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule.state");
        let mut state = State::default();
        mark_fired(&mut state, 0, 0);
        state.save(&path).unwrap();
        let restored = State::load(&path).unwrap();
        assert_eq!(restored, state);
        let schedule = vec![
            Duration::from_secs(3 * 60 * 60),
            Duration::from_secs(9 * 60 * 60),
        ];
        let (deadline, slot) = next_deadline(3 * 60 * 60 + 1, &schedule, &restored).unwrap();
        assert_eq!(slot, 1);
        assert!(deadline > 3 * 60 * 60 + 1);
    }

    #[test]
    fn a_wakeup_just_after_a_slot_still_fires_that_slot_once() {
        let schedule = vec![
            Duration::from_secs(3 * 60 * 60),
            Duration::from_secs(9 * 60 * 60),
        ];
        let state = State::default();
        let (deadline, slot) = next_deadline(3 * 60 * 60 + 1, &schedule, &state).unwrap();
        assert_eq!(deadline, 3 * 60 * 60);
        assert_eq!(slot, 0);
    }

    #[test]
    fn long_restart_does_not_burst_replay_missed_slots() {
        let schedule = vec![
            Duration::from_secs(3 * 60 * 60),
            Duration::from_secs(9 * 60 * 60),
            Duration::from_secs(15 * 60 * 60),
        ];
        let state = State {
            day: Some(0),
            slot_index: 1,
        };
        let (deadline, slot) = next_deadline(12 * 60 * 60, &schedule, &state).unwrap();
        assert_eq!(slot, 2);
        assert_eq!(deadline, 15 * 60 * 60);
    }
}
