pub(crate) fn local_timezone() -> Result<String, crate::infrastructure::sqlite::StoreError> {
    iana_time_zone::get_timezone().map_err(|_| {
        crate::infrastructure::sqlite::StoreError::new(
            crate::infrastructure::sqlite::StoreErrorCode::InvalidInput,
            "The local timezone is unavailable; choose an Automation timezone",
            false,
        )
    })
}
use std::collections::{BTreeMap, BTreeSet};

use chrono::{Datelike, Days, LocalResult, TimeZone, Timelike};
use rrule::{RRuleSet, Tz};
use sha2::{Digest, Sha256};

use nodex_core_contracts::automation::AutomationExecutionKind;

pub(super) const DEFAULT_RRULE: &str = "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0";
const JITTER_MAX_SECONDS: u32 = 120;
const HEARTBEAT_SPREAD_SECONDS: u32 = 300;
const HEARTBEAT_SPREAD_MIN_INTERVAL_MS: i64 = 60 * 60_000;

#[derive(Debug)]
pub(super) struct ScheduleError(pub(super) &'static str);

struct ParsedRule {
    text: String,
    has_dtstart: bool,
    options: BTreeMap<String, String>,
}

pub(super) fn normalize_rrule(value: Option<&str>) -> Result<String, ScheduleError> {
    let normalized = value.map(str::trim).filter(|value| !value.is_empty());
    let rule = normalized.unwrap_or(DEFAULT_RRULE);
    if rule.len() > 16 * 1024 {
        return Err(ScheduleError("RRULE exceeds its bound"));
    }
    Ok(rule.to_owned())
}

pub(super) fn next_run_at(
    automation_id: &str,
    kind: AutomationExecutionKind,
    rrule: &str,
    now_ms: i64,
    jitter_salt: &str,
    timezone: &str,
) -> Result<Option<i64>, ScheduleError> {
    if now_ms < 0 {
        return Err(ScheduleError("Core clock is invalid"));
    }
    if kind == AutomationExecutionKind::Heartbeat
        && let Some(interval_ms) = interval_millis(&parse_rule(rrule)?)?
    {
        return heartbeat_interval_next(automation_id, interval_ms, now_ms, jitter_salt).map(Some);
    }
    let timezone = timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| ScheduleError("Automation timezone is invalid"))?;
    let base = next_without_jitter(rrule, now_ms, timezone)?;
    let Some(base) = base else {
        return Ok(None);
    };
    if !should_jitter(rrule)? {
        return Ok(Some(base));
    }
    let jitter = i64::from(jitter_seconds(automation_id, base, jitter_salt)) * 1_000;
    base.checked_add(jitter)
        .map(Some)
        .ok_or(ScheduleError("Scheduled time exceeds its bound"))
}

/// An interval heartbeat beats one interval after its previous beat started, off any
/// wall-clock grid. Beats an hour or more apart spread around that instant, so heartbeats
/// that began together do not all reach their Agents in the same second.
fn heartbeat_interval_next(
    automation_id: &str,
    interval_ms: i64,
    started_at_ms: i64,
    jitter_salt: &str,
) -> Result<i64, ScheduleError> {
    let nominal = started_at_ms
        .checked_add(interval_ms)
        .ok_or(ScheduleError("Scheduled time exceeds its bound"))?;
    if interval_ms < HEARTBEAT_SPREAD_MIN_INTERVAL_MS {
        return Ok(nominal);
    }
    let offset = i64::from(
        jitter_digest(automation_id, nominal, jitter_salt) % (2 * HEARTBEAT_SPREAD_SECONDS + 1),
    ) - i64::from(HEARTBEAT_SPREAD_SECONDS);
    nominal
        .checked_add(offset * 1_000)
        .ok_or(ScheduleError("Scheduled time exceeds its bound"))
}

fn next_without_jitter(
    rrule: &str,
    now_ms: i64,
    timezone: chrono_tz::Tz,
) -> Result<Option<i64>, ScheduleError> {
    let parsed = parse_rule(rrule)?;
    if let Some(next) = wall_clock_next(&parsed, now_ms, timezone)? {
        return Ok(Some(next));
    }
    if let Some(next) = interval_next(&parsed, now_ms, timezone)? {
        return Ok(Some(next));
    }
    advanced_next(parsed, now_ms, timezone)
}

fn interval_millis(parsed: &ParsedRule) -> Result<Option<i64>, ScheduleError> {
    let frequency = parsed.options.get("FREQ").map(String::as_str);
    let interval = positive_integer(parsed.options.get("INTERVAL"))?.unwrap_or(1);
    let basic = ["FREQ", "INTERVAL", "DTSTART", "TZID"]
        .into_iter()
        .collect::<BTreeSet<_>>();
    if frequency == Some("MINUTELY") && has_only_keys(&parsed.options, &basic) {
        return interval
            .checked_mul(60_000)
            .map(Some)
            .ok_or(ScheduleError("RRULE interval exceeds its bound"));
    }

    let hourly = ["FREQ", "INTERVAL", "DTSTART", "TZID", "BYDAY", "BYMINUTE"]
        .into_iter()
        .collect::<BTreeSet<_>>();
    if frequency != Some("HOURLY") || !has_only_keys(&parsed.options, &hourly) {
        return Ok(None);
    }
    let minutes = integer_list(parsed.options.get("BYMINUTE"))?;
    if !minutes.is_empty() && minutes.as_slice() != [0] {
        return Ok(None);
    }
    let weekdays = weekday_list(parsed.options.get("BYDAY"))?;
    if parsed.options.contains_key("BYDAY") && weekdays.len() != 7 {
        return Ok(None);
    }
    interval
        .checked_mul(60 * 60_000)
        .map(Some)
        .ok_or(ScheduleError("RRULE interval exceeds its bound"))
}

fn interval_next(
    parsed: &ParsedRule,
    now_ms: i64,
    timezone: chrono_tz::Tz,
) -> Result<Option<i64>, ScheduleError> {
    let Some(interval_ms) = interval_millis(parsed)? else {
        return Ok(None);
    };
    let floor = now_ms - now_ms.rem_euclid(60_000);
    if parsed.options.get("FREQ").map(String::as_str) == Some("MINUTELY") {
        return floor
            .checked_add(interval_ms)
            .map(Some)
            .ok_or(ScheduleError("Scheduled time exceeds its bound"));
    }

    let local = timezone
        .timestamp_millis_opt(floor)
        .single()
        .ok_or(ScheduleError("Core local clock is invalid"))?;
    let minute = integer_list(parsed.options.get("BYMINUTE"))?
        .first()
        .copied()
        .map_or_else(|| i64::from(local.minute()), i64::from);
    let mut candidate = floor - i64::from(local.minute()) * 60_000 + minute * 60_000;
    while candidate <= now_ms {
        candidate = candidate
            .checked_add(interval_ms)
            .ok_or(ScheduleError("Scheduled time exceeds its bound"))?;
    }
    Ok(Some(candidate))
}

fn wall_clock_next(
    parsed: &ParsedRule,
    now_ms: i64,
    timezone: chrono_tz::Tz,
) -> Result<Option<i64>, ScheduleError> {
    if parsed.has_dtstart
        || parsed
            .text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
            != 1
    {
        return Ok(None);
    }
    let allowed = [
        "FREQ", "INTERVAL", "DTSTART", "TZID", "BYDAY", "BYMINUTE", "BYHOUR", "BYSECOND",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    if !has_only_keys(&parsed.options, &allowed) {
        return Ok(None);
    }
    if positive_integer(parsed.options.get("INTERVAL"))?.unwrap_or(1) != 1 {
        return Ok(None);
    }
    let frequency = parsed.options.get("FREQ").map(String::as_str);
    if !matches!(frequency, Some("DAILY" | "WEEKLY")) {
        return Ok(None);
    }
    let seconds = integer_list(parsed.options.get("BYSECOND"))?;
    if !seconds.is_empty() && seconds.as_slice() != [0] {
        return Ok(None);
    }
    let hours = integer_list(parsed.options.get("BYHOUR"))?;
    let minutes = integer_list(parsed.options.get("BYMINUTE"))?;
    if hours.is_empty() || minutes.is_empty() {
        return Ok(None);
    }
    if hours.iter().any(|hour| !(0..=23).contains(hour))
        || minutes.iter().any(|minute| !(0..=59).contains(minute))
    {
        return Err(ScheduleError("RRULE wall-clock time is invalid"));
    }
    let weekdays = weekday_list(parsed.options.get("BYDAY"))?;
    let local_now = timezone
        .timestamp_millis_opt(now_ms)
        .single()
        .ok_or(ScheduleError("Core local clock is invalid"))?;
    let mut candidates = Vec::new();
    for offset in 0..=7_u64 {
        let date = local_now
            .date_naive()
            .checked_add_days(Days::new(offset))
            .ok_or(ScheduleError("Scheduled date exceeds its bound"))?;
        let weekday = date.weekday().num_days_from_sunday();
        let allowed_day = frequency == Some("DAILY") && weekdays.is_empty()
            || weekdays.is_empty()
            || weekdays.contains(&weekday);
        if !allowed_day {
            continue;
        }
        for hour in &hours {
            for minute in &minutes {
                let Some(naive) = date.and_hms_opt(*hour as u32, *minute as u32, 0) else {
                    continue;
                };
                let candidate = match timezone.from_local_datetime(&naive) {
                    LocalResult::Single(value) => Some(value),
                    LocalResult::Ambiguous(first, second) => Some(first.min(second)),
                    LocalResult::None => None,
                };
                if let Some(candidate) = candidate
                    && candidate.timestamp_millis() > now_ms
                {
                    candidates.push(candidate.timestamp_millis());
                }
            }
        }
    }
    Ok(candidates.into_iter().min())
}

fn advanced_next(
    parsed: ParsedRule,
    now_ms: i64,
    timezone: chrono_tz::Tz,
) -> Result<Option<i64>, ScheduleError> {
    let text = normalize_content_lines(&parsed, now_ms, timezone)?;
    let set = text
        .parse::<RRuleSet>()
        .map_err(|_| ScheduleError("RRULE is invalid"))?;
    let after = Tz::from(timezone)
        .timestamp_millis_opt(now_ms)
        .single()
        .ok_or(ScheduleError("Core local clock is invalid"))?;
    Ok(set
        .after(after)
        .all(1)
        .dates
        .first()
        .map(chrono::DateTime::timestamp_millis))
}

fn normalize_content_lines(
    parsed: &ParsedRule,
    now_ms: i64,
    timezone: chrono_tz::Tz,
) -> Result<String, ScheduleError> {
    let mut lines = Vec::new();
    if !parsed.has_dtstart {
        let local = timezone
            .timestamp_millis_opt(now_ms - now_ms.rem_euclid(60_000))
            .single()
            .ok_or(ScheduleError("Core local clock is invalid"))?;
        lines.push(format!(
            "DTSTART;TZID={}:{}",
            timezone.name(),
            local.format("%Y%m%dT%H%M%S")
        ));
    }
    for line in parsed
        .text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line
            .strip_prefix("DTSTART:")
            .filter(|value| !value.ends_with('Z'))
        {
            lines.push(format!("DTSTART;TZID={}:{}", timezone.name(), value));
        } else if line.contains(':') {
            lines.push(line.to_owned());
        } else {
            lines.push(format!("RRULE:{line}"));
        }
    }
    Ok(lines.join("\n"))
}

fn should_jitter(rrule: &str) -> Result<bool, ScheduleError> {
    let parsed = parse_rule(rrule)?;
    if positive_integer(parsed.options.get("COUNT"))? == Some(1) {
        return Ok(false);
    }
    Ok(matches!(
        parsed.options.get("FREQ").map(String::as_str),
        Some("HOURLY" | "DAILY" | "WEEKLY")
    ))
}

fn jitter_seconds(automation_id: &str, next_run_at: i64, jitter_salt: &str) -> u32 {
    jitter_digest(automation_id, next_run_at, jitter_salt) % JITTER_MAX_SECONDS
}

fn jitter_digest(automation_id: &str, next_run_at: i64, jitter_salt: &str) -> u32 {
    let digest = Sha256::digest(format!("{jitter_salt}:{automation_id}:{next_run_at}").as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

fn parse_rule(value: &str) -> Result<ParsedRule, ScheduleError> {
    let text = value.trim();
    if text.is_empty() || text.len() > 16 * 1024 {
        return Err(ScheduleError("RRULE is empty or exceeds its bound"));
    }
    let mut options = BTreeMap::new();
    let mut has_dtstart = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("DTSTART") {
            has_dtstart = true;
            continue;
        }
        if upper.starts_with("RDATE") || upper.starts_with("EXDATE") || upper.starts_with("EXRULE")
        {
            continue;
        }
        let body = line
            .split_once(':')
            .filter(|(prefix, _)| prefix.eq_ignore_ascii_case("RRULE"))
            .map_or(line, |(_, body)| body);
        for part in body.split(';') {
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            let key = key.trim().to_ascii_uppercase();
            let value = value.trim().to_ascii_uppercase();
            if !key.is_empty() && !value.is_empty() {
                options.insert(key, value);
            }
        }
    }
    if !options.contains_key("FREQ") {
        return Err(ScheduleError("RRULE frequency is required"));
    }
    Ok(ParsedRule {
        text: text.to_owned(),
        has_dtstart,
        options,
    })
}

fn positive_integer(value: Option<&String>) -> Result<Option<i64>, ScheduleError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parsed = value
        .parse::<i64>()
        .map_err(|_| ScheduleError("RRULE positive integer is invalid"))?;
    if parsed < 1 {
        return Err(ScheduleError("RRULE positive integer is invalid"));
    }
    Ok(Some(parsed))
}

fn integer_list(value: Option<&String>) -> Result<Vec<i64>, ScheduleError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .split(',')
        .map(|part| {
            part.trim()
                .parse::<i64>()
                .map_err(|_| ScheduleError("RRULE integer list is invalid"))
        })
        .collect()
}

fn weekday_list(value: Option<&String>) -> Result<BTreeSet<u32>, ScheduleError> {
    let Some(value) = value else {
        return Ok(BTreeSet::new());
    };
    value
        .split(',')
        .map(
            |part| match part.trim().get(part.trim().len().saturating_sub(2)..) {
                Some("SU") => Ok(0),
                Some("MO") => Ok(1),
                Some("TU") => Ok(2),
                Some("WE") => Ok(3),
                Some("TH") => Ok(4),
                Some("FR") => Ok(5),
                Some("SA") => Ok(6),
                _ => Err(ScheduleError("RRULE weekday is invalid")),
            },
        )
        .collect()
}

fn has_only_keys(options: &BTreeMap<String, String>, allowed: &BTreeSet<&str>) -> bool {
    options.keys().all(|key| allowed.contains(key.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heartbeat_next(rrule: &str, started_at_ms: i64, automation_id: &str) -> i64 {
        next_run_at(
            automation_id,
            AutomationExecutionKind::Heartbeat,
            rrule,
            started_at_ms,
            "salt",
            "UTC",
        )
        .expect("schedule")
        .expect("next beat")
    }

    #[test]
    fn a_short_interval_heartbeat_beats_exactly_one_interval_after_it_started() {
        let started = 1_783_520_207_000_i64;
        assert_eq!(
            heartbeat_next("FREQ=MINUTELY;INTERVAL=5", started, "heartbeat-1"),
            started + 5 * 60_000
        );
        assert_eq!(
            heartbeat_next("FREQ=MINUTELY;INTERVAL=59", started, "heartbeat-1"),
            started + 59 * 60_000
        );
    }

    #[test]
    fn an_hourly_heartbeat_spreads_within_five_minutes_of_one_interval_after_it_started() {
        let started = 1_783_520_207_000_i64;
        let offsets = (0..64)
            .flat_map(|index| {
                let id = format!("heartbeat-{index}");
                [
                    "FREQ=HOURLY;INTERVAL=1",
                    "FREQ=HOURLY;INTERVAL=2;BYMINUTE=0",
                    "FREQ=MINUTELY;INTERVAL=60",
                ]
                .map(|rrule| {
                    let interval = if rrule.contains("INTERVAL=2") { 2 } else { 1 };
                    heartbeat_next(rrule, started, &id) - started - interval * 60 * 60_000
                })
            })
            .collect::<Vec<_>>();
        assert!(offsets.iter().all(|offset| offset.abs() <= 300_000));
        assert!(offsets.iter().any(|offset| *offset < 0));
        assert!(offsets.iter().any(|offset| *offset > 0));
        assert_eq!(
            heartbeat_next("FREQ=HOURLY;INTERVAL=1", started, "heartbeat-1"),
            heartbeat_next("FREQ=HOURLY;INTERVAL=1", started, "heartbeat-1"),
        );
    }

    #[test]
    fn jitter_matches_sha256_big_endian_oracle() {
        assert_eq!(jitter_seconds("cron-1", 1_783_504_200_000, "salt"), 108);
    }

    #[test]
    fn exhausted_count_one_rule_has_no_next_occurrence() {
        let next = next_run_at(
            "once",
            AutomationExecutionKind::Cron,
            "FREQ=MINUTELY;COUNT=1",
            1_783_520_207_000,
            "salt",
            "UTC",
        )
        .expect("valid schedule");
        assert_eq!(next, None);
    }
    #[test]
    fn persisted_clock_zone_preserves_wall_time_across_dst() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-03-07T15:00:00Z")
            .unwrap()
            .timestamp_millis();
        let expected = chrono::DateTime::parse_from_rfc3339("2026-03-08T13:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            next_without_jitter(
                "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
                now,
                chrono_tz::America::New_York
            )
            .unwrap(),
            Some(expected)
        );
        assert_eq!(
            next_without_jitter(
                "DTSTART:20260307T090000\nRRULE:FREQ=DAILY;COUNT=3",
                now,
                chrono_tz::America::New_York
            )
            .unwrap(),
            Some(expected)
        );
    }
}
