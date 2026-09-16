use rand::{rngs::StdRng, Rng, SeedableRng};
use std::time::Duration;

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

pub fn next_sleep(now: Duration, schedule: &[Duration]) -> Duration {
    schedule
        .iter()
        .copied()
        .find(|event| *event > now)
        .unwrap_or_else(|| Duration::from_secs(24 * 60 * 60) - now)
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
}
