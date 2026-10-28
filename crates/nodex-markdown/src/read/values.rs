//! Attribute contracts shared by containers, atoms and text colors.

use super::{error, syntax::Directive};
use crate::attributes::Attribute;
use crate::{AgentConfig, Attachment, AttachmentKind, Color, Colors, DateMention, ReadError};

pub(super) fn value<'a>(attrs: &'a [Attribute], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|a| a.name == name)
        .and_then(|a| a.value.as_deref())
}

pub(super) fn allowed(d: &Directive, names: &[&str]) -> Result<(), ReadError> {
    for a in &d.attrs {
        if !names.contains(&a.name.as_str()) {
            return Err(error(
                d.line,
                format!(
                    "{} takes {}; remove the `{}` attribute",
                    d.name,
                    names
                        .iter()
                        .map(|s| format!("`{s}`"))
                        .collect::<Vec<_>>()
                        .join(", "),
                    a.name
                ),
            ));
        }
        if a.value.is_none() && a.name != "underline" {
            return Err(error(
                d.line,
                format!("`{}` needs a value; write `{}=\"value\"`", a.name, a.name),
            ));
        }
    }
    Ok(())
}

pub(super) fn required<'a>(d: &'a Directive, name: &str) -> Result<&'a str, ReadError> {
    value(&d.attrs, name)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            error(
                d.line,
                format!("{} needs its `{name}`; write `{name}=\"…\"`", d.name),
            )
        })
}

pub(super) fn color(
    attrs: &[Attribute],
    name: &str,
    line: usize,
) -> Result<Option<Color>, ReadError> {
    let Some(a) = attrs.iter().find(|a| a.name == name) else {
        return Ok(None);
    };
    let Some(color) = a.value.as_deref().and_then(Color::from_name) else {
        return Err(error(
            line,
            format!(
                "`{}` is not a Nodex color; use gray, brown, red, orange, yellow, green, blue, purple or pink",
                a.value.as_deref().unwrap_or(name)
            ),
        ));
    };
    Ok(Some(color))
}

pub(super) fn colors(attrs: &[Attribute], line: usize) -> Result<Colors, ReadError> {
    Ok(Colors {
        text: color(attrs, "color", line)?,
        background: color(attrs, "background", line)?,
    })
}

pub(super) fn date(d: &Directive) -> Result<DateMention, ReadError> {
    allowed(
        d,
        &["start", "end", "tz", "format", "time-format", "reminder"],
    )?;
    let start = required(d, "start")?;
    for (name, text) in [("start", Some(start)), ("end", value(&d.attrs, "end"))] {
        if text.is_some_and(|s| !valid_date(s)) {
            return Err(error(
                d.line,
                format!(
                    "`{name}` is a date or a date and time; use `YYYY-MM-DD` or an ISO date and time with its offset"
                ),
            ));
        }
    }
    one_of(
        d,
        "format",
        &["relative", "ll", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD"],
    )?;
    one_of(d, "time-format", &["12h", "24h"])?;
    one_of(
        d,
        "reminder",
        &[
            "minute:0",
            "minute:10",
            "minute:30",
            "hour:1",
            "day:0@09:00",
            "day:1@09:00",
        ],
    )?;
    if let Some(tz) = value(&d.attrs, "tz")
        && (tz.is_empty()
            || tz.chars().any(char::is_whitespace)
            || tz != "UTC" && !tz.contains('/'))
    {
        return Err(error(
            d.line,
            "`tz` is an IANA time zone, such as `Asia/Shanghai`",
        ));
    }
    Ok(DateMention {
        start: start.into(),
        end: owned(d, "end"),
        tz: owned(d, "tz"),
        format: owned(d, "format"),
        time_format: owned(d, "time-format"),
        reminder: owned(d, "reminder"),
    })
}

fn number(source: &str) -> Option<u32> {
    if source.is_empty() || !source.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    source.parse().ok()
}

fn valid_date(source: &str) -> bool {
    let Some(date) = source.get(..10) else {
        return false;
    };
    if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (
        date.get(..4).and_then(number),
        date.get(5..7).and_then(number),
        date.get(8..).and_then(number),
    ) else {
        return false;
    };
    let max = match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    if day == 0 || day > max {
        return false;
    }
    if source.len() == 10 {
        return true;
    }
    let Some(time) = source.strip_prefix(date).and_then(|s| s.strip_prefix('T')) else {
        return false;
    };
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, None)
    } else {
        let Some(index) = time.find(['+', '-']) else {
            return false;
        };
        (&time[..index], Some(&time[index + 1..]))
    };
    if let Some(offset) = offset {
        let parts: Vec<_> = offset.split(':').collect();
        if parts.len() != 2
            || parts[0].len() != 2
            || parts[1].len() != 2
            || number(parts[0]).is_none_or(|n| n > 23)
            || number(parts[1]).is_none_or(|n| n > 59)
        {
            return false;
        }
    }
    let parts: Vec<_> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len())
        || parts[0].len() != 2
        || parts[1].len() != 2
        || number(parts[0]).is_none_or(|n| n > 23)
        || number(parts[1]).is_none_or(|n| n > 59)
    {
        return false;
    }
    if let Some(seconds) = parts.get(2) {
        let (seconds, fraction) = seconds
            .split_once('.')
            .map_or((*seconds, None), |(s, f)| (s, Some(f)));
        if seconds.len() != 2
            || number(seconds).is_none_or(|n| n > 59)
            || fraction.is_some_and(|s| number(s).is_none())
        {
            return false;
        }
    }
    true
}

pub(super) fn attachment(d: &Directive) -> Result<Attachment, ReadError> {
    allowed(
        d,
        &["kind", "mode", "source", "name", "mime", "bytes", "origin"],
    )?;
    let kind = AttachmentKind::from_name(required(d, "kind")?)
        .ok_or_else(|| error(d.line, "attachment `kind` is `file`, `folder` or `text`"))?;
    one_of(d, "mode", &["link", "materialized"])?;
    let bytes = value(&d.attrs, "bytes")
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| error(d.line, "attachment `bytes` is a nonnegative whole number"))
        })
        .transpose()?;
    if kind == AttachmentKind::Folder && bytes.is_some() {
        return Err(error(
            d.line,
            "a folder has no `bytes`; remove the attribute",
        ));
    }
    Ok(Attachment {
        kind,
        link: value(&d.attrs, "mode") == Some("link"),
        source: required(d, "source")?.into(),
        name: required(d, "name")?.into(),
        mime: owned(d, "mime"),
        bytes,
        origin: owned(d, "origin"),
    })
}

pub(super) fn agent(d: &Directive) -> Result<AgentConfig, ReadError> {
    // Runtime availability is checked when the prompt is sent; the document keeps explicit settings.
    let known = AgentConfig::KNOWN;
    for a in &d.attrs {
        if known.contains(&a.name.as_str()) && a.value.is_none() {
            return Err(error(
                d.line,
                format!("Agent config `{}` needs a value", a.name),
            ));
        }
    }
    Ok(AgentConfig {
        mode: owned(d, "mode"),
        provider: owned(d, "provider"),
        model: owned(d, "model"),
        reasoning: owned(d, "reasoning"),
        speed: owned(d, "speed"),
        unknown: d
            .attrs
            .iter()
            .filter(|a| !known.contains(&a.name.as_str()))
            .map(|a| (a.name.clone(), a.value.clone().unwrap_or_default()))
            .collect(),
    })
}
fn owned(d: &Directive, name: &str) -> Option<String> {
    value(&d.attrs, name)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub(super) fn one_of(d: &Directive, name: &str, choices: &[&str]) -> Result<(), ReadError> {
    if let Some(v) = value(&d.attrs, name)
        && !choices.contains(&v)
    {
        return Err(error(
            d.line,
            format!(
                "`{name}` must be {}; replace `{v}`",
                choices
                    .iter()
                    .map(|s| format!("`{s}`"))
                    .collect::<Vec<_>>()
                    .join(" or ")
            ),
        ));
    }
    Ok(())
}
