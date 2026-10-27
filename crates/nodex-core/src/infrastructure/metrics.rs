use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DurationMetricSnapshot {
    pub count: u64,
    pub total_micros: u64,
    pub last_micros: u64,
    pub max_micros: u64,
}

#[derive(Default)]
pub struct DurationMetric {
    count: AtomicU64,
    total_micros: AtomicU64,
    last_micros: AtomicU64,
    max_micros: AtomicU64,
}

impl DurationMetric {
    pub fn record(&self, duration: Duration) {
        let micros = u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
        let _ = self
            .count
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                Some(count.saturating_add(1))
            });
        let _ = self
            .total_micros
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                Some(total.saturating_add(micros))
            });
        self.last_micros.store(micros, Ordering::Relaxed);
        self.max_micros.fetch_max(micros, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> DurationMetricSnapshot {
        DurationMetricSnapshot {
            count: self.count.load(Ordering::Relaxed),
            total_micros: self.total_micros.load(Ordering::Relaxed),
            last_micros: self.last_micros.load(Ordering::Relaxed),
            max_micros: self.max_micros.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_metric_saturates_totals_and_tracks_last_and_max() {
        let metric = DurationMetric::default();
        metric.record(Duration::from_micros(7));
        metric.record(Duration::from_micros(3));
        assert_eq!(
            metric.snapshot(),
            DurationMetricSnapshot {
                count: 2,
                total_micros: 10,
                last_micros: 3,
                max_micros: 7,
            }
        );
    }
}
