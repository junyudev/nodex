use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::block_tree::{PortableValue, TextDelta};

pub const RICH_TEXT_ATOM: char = '\u{fffc}';
pub const MAX_RICH_TEXT_SEGMENTS: usize = 512;
pub const MAX_RICH_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_TITLE_UTF16_LENGTH: usize = 2_000;
const MAX_LINK_LENGTH: usize = 4_096;
const MAX_INLINE_PROPERTY_LENGTH: usize = 1_024;
const ATOM_ATTRIBUTE: &str = "nodexRichTitleAtom";
const LINK_ATTRIBUTE: &str = "link";
const ALLOWED_COLORS: &[&str] = &[
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
    "gray_bg",
    "brown_bg",
    "orange_bg",
    "yellow_bg",
    "green_bg",
    "blue_bg",
    "purple_bg",
    "pink_bg",
    "red_bg",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RichTextStyles {
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strikethrough: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum RichTextItem {
    #[serde(rename = "text")]
    Text {
        text: String,
        styles: RichTextStyles,
    },
    #[serde(rename = "link")]
    Link {
        text: String,
        href: String,
        styles: RichTextStyles,
    },
    #[serde(rename = "linebreak")]
    LineBreak,
    #[serde(rename = "threadMention")]
    ThreadMention { uuid: String },
    #[serde(rename = "pageMention", rename_all = "camelCase")]
    PageMention { target_page_id: String },
    #[serde(rename = "skillMention")]
    SkillMention { name: String },
    #[serde(rename = "dateMention", rename_all = "camelCase")]
    DateMention {
        start: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        end: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        time_format: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reminder: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextMaterialization {
    pub rich_text: Vec<RichTextItem>,
    pub plain_text: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RichTextError {
    #[error("title delta has too many segments")]
    TooManySegments,
    #[error("title delta attribute {0} is not supported")]
    UnsupportedAttribute(String),
    #[error("title delta attribute {0} has an invalid value")]
    InvalidAttribute(String),
    #[error("title delta atom is not canonical")]
    InvalidAtom,
    #[error("title delta contains an untyped atom")]
    UntypedAtom,
    #[error("title link is invalid")]
    InvalidLink,
    #[error("title inline item is invalid")]
    InvalidInlineItem,
    #[error("rich title plain text exceeds the UTF-16 length limit")]
    TitleTooLong,
    #[error("rich title exceeds the portable byte limit")]
    ByteLimitExceeded,
}

pub fn materialize_rich_text(
    delta: &[TextDelta],
) -> Result<RichTextMaterialization, RichTextError> {
    if delta.len() > MAX_RICH_TEXT_SEGMENTS {
        return Err(RichTextError::TooManySegments);
    }
    let mut items = Vec::new();
    for chunk in delta {
        decode_chunk(chunk, &mut items)?;
    }
    if items.len() > MAX_RICH_TEXT_SEGMENTS {
        return Err(RichTextError::TooManySegments);
    }
    let plain_text = rich_text_plain_text(&items);
    if plain_text.encode_utf16().count() > MAX_TITLE_UTF16_LENGTH {
        return Err(RichTextError::TitleTooLong);
    }
    if serde_json::to_vec(&items)
        .map_err(|_| RichTextError::InvalidInlineItem)?
        .len()
        > MAX_RICH_TEXT_BYTES
    {
        return Err(RichTextError::ByteLimitExceeded);
    }
    Ok(RichTextMaterialization {
        rich_text: items,
        plain_text,
    })
}

pub fn rich_text_plain_text(items: &[RichTextItem]) -> String {
    let mut text = String::new();
    let mut after_skill = false;
    for item in items {
        let next = match item {
            RichTextItem::Text { text, .. } | RichTextItem::Link { text, .. } => text.clone(),
            RichTextItem::LineBreak => "\n".to_owned(),
            RichTextItem::ThreadMention { uuid } => format!("@thread:{uuid}"),
            RichTextItem::PageMention { target_page_id } => format!("@page:{target_page_id}"),
            RichTextItem::SkillMention { name } => format!("${name}"),
            RichTextItem::DateMention { start, end, .. } => end
                .as_ref()
                .map(|end| format!("@date:{start}..{end}"))
                .unwrap_or_else(|| format!("@date:{start}")),
        };
        if next.is_empty() {
            continue;
        }
        let skill = matches!(item, RichTextItem::SkillMention { .. });
        if (skill || after_skill)
            && text.chars().next_back().is_some_and(|c| !c.is_whitespace())
            && next.chars().next().is_some_and(|c| !c.is_whitespace())
        {
            text.push(' ');
        }
        text.push_str(&next);
        after_skill = skill;
    }
    text
}

pub fn canonicalize_rich_text(
    items: &[RichTextItem],
) -> Result<RichTextMaterialization, RichTextError> {
    materialize_rich_text(&encode_rich_text_delta(items)?)
}

pub fn rich_text_to_delta(items: &[RichTextItem]) -> Result<Vec<TextDelta>, RichTextError> {
    let canonical = canonicalize_rich_text(items)?;
    encode_rich_text_delta(&canonical.rich_text)
}

fn encode_rich_text_delta(items: &[RichTextItem]) -> Result<Vec<TextDelta>, RichTextError> {
    if items.len() > MAX_RICH_TEXT_SEGMENTS {
        return Err(RichTextError::TooManySegments);
    }
    items
        .iter()
        .map(|item| match item {
            RichTextItem::Text { text, styles } => Ok(TextDelta {
                insert: text.clone(),
                attributes: encode_styles(styles),
            }),
            RichTextItem::Link { text, href, styles } => {
                if !valid_bounded_string(href, MAX_LINK_LENGTH)
                    || href.chars().any(char::is_control)
                {
                    return Err(RichTextError::InvalidLink);
                }
                let mut attributes = encode_styles(styles);
                attributes.insert(
                    LINK_ATTRIBUTE.to_owned(),
                    PortableValue::String(href.clone()),
                );
                Ok(TextDelta {
                    insert: text.clone(),
                    attributes,
                })
            }
            RichTextItem::LineBreak => Ok(TextDelta {
                insert: "\n".to_owned(),
                attributes: BTreeMap::new(),
            }),
            RichTextItem::ThreadMention { .. }
            | RichTextItem::PageMention { .. }
            | RichTextItem::SkillMention { .. }
            | RichTextItem::DateMention { .. } => {
                validate_atom(item)?;
                let encoded =
                    serde_json::to_string(item).map_err(|_| RichTextError::InvalidInlineItem)?;
                Ok(TextDelta {
                    insert: RICH_TEXT_ATOM.to_string(),
                    attributes: [(ATOM_ATTRIBUTE.to_owned(), PortableValue::String(encoded))]
                        .into_iter()
                        .collect(),
                })
            }
        })
        .collect()
}

fn encode_styles(styles: &RichTextStyles) -> BTreeMap<String, PortableValue> {
    let mut attributes = BTreeMap::new();
    for (key, enabled) in [
        ("bold", styles.bold),
        ("italic", styles.italic),
        ("underline", styles.underline),
        ("strike", styles.strikethrough),
        ("code", styles.code),
    ] {
        if enabled {
            attributes.insert(key.to_owned(), PortableValue::Boolean(true));
        }
    }
    if let Some(color) = &styles.color {
        attributes.insert(
            if color.ends_with("_bg") {
                "backgroundColor"
            } else {
                "textColor"
            }
            .to_owned(),
            PortableValue::String(color.clone()),
        );
    }
    attributes
}

fn decode_chunk(chunk: &TextDelta, output: &mut Vec<RichTextItem>) -> Result<(), RichTextError> {
    for key in chunk.attributes.keys() {
        if matches!(
            key.as_str(),
            "bold"
                | "italic"
                | "underline"
                | "strike"
                | "code"
                | "textColor"
                | "backgroundColor"
                | LINK_ATTRIBUTE
                | ATOM_ATTRIBUTE
        ) {
            continue;
        }
        return Err(RichTextError::UnsupportedAttribute(key.clone()));
    }

    if let Some(atom) = chunk.attributes.get(ATOM_ATTRIBUTE) {
        if chunk.insert != RICH_TEXT_ATOM.to_string() || chunk.attributes.len() != 1 {
            return Err(RichTextError::InvalidAtom);
        }
        let PortableValue::String(atom) = atom else {
            return Err(RichTextError::InvalidAtom);
        };
        let item: RichTextItem =
            serde_json::from_str(atom).map_err(|_| RichTextError::InvalidAtom)?;
        validate_atom(&item)?;
        output.push(item);
        return Ok(());
    }
    if chunk.insert.contains(RICH_TEXT_ATOM) {
        return Err(RichTextError::UntypedAtom);
    }

    let styles = read_styles(&chunk.attributes)?;
    let link = match chunk.attributes.get(LINK_ATTRIBUTE) {
        Some(PortableValue::String(href)) if valid_bounded_string(href, MAX_LINK_LENGTH) => {
            if href.chars().any(char::is_control) {
                return Err(RichTextError::InvalidLink);
            }
            Some(href.clone())
        }
        Some(_) => return Err(RichTextError::InvalidLink),
        None => None,
    };
    for (index, piece) in chunk.insert.split('\n').enumerate() {
        if !piece.is_empty() {
            let item = match &link {
                Some(href) => RichTextItem::Link {
                    text: piece.to_owned(),
                    href: href.clone(),
                    styles: styles.clone(),
                },
                None => RichTextItem::Text {
                    text: piece.to_owned(),
                    styles: styles.clone(),
                },
            };
            append_text(output, item);
        }
        if index + 1 < chunk.insert.split('\n').count() {
            output.push(RichTextItem::LineBreak);
        }
    }
    Ok(())
}

fn read_styles(
    attributes: &BTreeMap<String, PortableValue>,
) -> Result<RichTextStyles, RichTextError> {
    let mut styles = RichTextStyles::default();
    for (attribute, target) in [
        ("bold", &mut styles.bold),
        ("italic", &mut styles.italic),
        ("underline", &mut styles.underline),
        ("strike", &mut styles.strikethrough),
        ("code", &mut styles.code),
    ] {
        match attributes.get(attribute) {
            Some(PortableValue::Boolean(true)) => *target = true,
            Some(PortableValue::Boolean(false)) | None => {}
            Some(_) => return Err(RichTextError::InvalidAttribute(attribute.to_owned())),
        }
    }
    let background = attributes.get("backgroundColor");
    let foreground = attributes.get("textColor");
    if background.is_some() && foreground.is_some() {
        return Err(RichTextError::InvalidAttribute("color".to_owned()));
    }
    let (color, background_attribute) = match (background, foreground) {
        (Some(value), None) => (Some(value), true),
        (None, Some(value)) => (Some(value), false),
        (None, None) => (None, false),
        _ => unreachable!(),
    };
    if let Some(color) = color {
        let PortableValue::String(color) = color else {
            return Err(RichTextError::InvalidAttribute("color".to_owned()));
        };
        if !ALLOWED_COLORS.contains(&color.as_str())
            || background_attribute != color.ends_with("_bg")
        {
            return Err(RichTextError::InvalidAttribute("color".to_owned()));
        }
        styles.color = Some(color.clone());
    }
    Ok(styles)
}

fn append_text(output: &mut Vec<RichTextItem>, item: RichTextItem) {
    match (output.last_mut(), item) {
        (
            Some(RichTextItem::Text {
                text: previous,
                styles: previous_styles,
            }),
            RichTextItem::Text { text, styles },
        ) if *previous_styles == styles => previous.push_str(&text),
        (
            Some(RichTextItem::Link {
                text: previous,
                href: previous_href,
                styles: previous_styles,
            }),
            RichTextItem::Link { text, href, styles },
        ) if *previous_href == href && *previous_styles == styles => previous.push_str(&text),
        (_, item) => output.push(item),
    }
}

fn validate_atom(item: &RichTextItem) -> Result<(), RichTextError> {
    match item {
        RichTextItem::ThreadMention { uuid }
            if valid_bounded_string(uuid, MAX_INLINE_PROPERTY_LENGTH) =>
        {
            Ok(())
        }
        RichTextItem::PageMention { target_page_id }
            if valid_bounded_string(target_page_id, MAX_INLINE_PROPERTY_LENGTH) =>
        {
            Ok(())
        }
        RichTextItem::SkillMention { name } if nodex_markdown::valid_skill_name(name) => Ok(()),
        RichTextItem::DateMention {
            start,
            end,
            tz,
            format,
            time_format,
            reminder,
        } if valid_date_mention(
            start,
            end.as_deref(),
            tz.as_deref(),
            format.as_deref(),
            time_format.as_deref(),
            reminder.as_deref(),
        ) =>
        {
            Ok(())
        }
        _ => Err(RichTextError::InvalidAtom),
    }
}

fn valid_date_mention(
    start: &str,
    end: Option<&str>,
    tz: Option<&str>,
    format: Option<&str>,
    time_format: Option<&str>,
    reminder: Option<&str>,
) -> bool {
    let start_kind = date_value_kind(start);
    if start_kind.is_none() || end.is_some_and(|end| date_value_kind(end) != start_kind) {
        return false;
    }
    if format.is_some_and(|value| {
        !matches!(
            value,
            "relative" | "ll" | "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD"
        )
    }) {
        return false;
    }
    if time_format.is_some_and(|value| !matches!(value, "12h" | "24h")) {
        return false;
    }
    if start_kind == Some(DateValueKind::Date) && (tz.is_some() || time_format.is_some()) {
        return false;
    }
    [tz, reminder]
        .into_iter()
        .flatten()
        .all(valid_bounded_optional_string)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DateValueKind {
    Date,
    DateTime,
}

fn date_value_kind(value: &str) -> Option<DateValueKind> {
    if valid_iso_date(value) {
        return Some(DateValueKind::Date);
    }
    let (date, time_and_offset) = value.split_once('T')?;
    if !valid_iso_date(date) || time_and_offset.len() < 9 {
        return None;
    }
    let time = &time_and_offset[..8];
    if !valid_iso_time(time) {
        return None;
    }
    let offset = &time_and_offset[8..];
    if offset == "Z" || offset == "z" || valid_utc_offset(offset) {
        return Some(DateValueKind::DateTime);
    }
    None
}

fn valid_iso_date(value: &str) -> bool {
    let Some((year, rest)) = value.split_once('-') else {
        return false;
    };
    let Some((month, day)) = rest.split_once('-') else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        year.parse::<u32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=maximum).contains(&day)
}

fn valid_iso_time(value: &str) -> bool {
    let mut parts = value.split(':');
    let (Some(hour), Some(minute), Some(second), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    hour.len() == 2
        && minute.len() == 2
        && second.len() == 2
        && hour.parse::<u8>().is_ok_and(|value| value <= 23)
        && minute.parse::<u8>().is_ok_and(|value| value <= 59)
        && second.parse::<u8>().is_ok_and(|value| value <= 59)
}

fn valid_utc_offset(value: &str) -> bool {
    if value.len() != 6 || !matches!(value.as_bytes()[0], b'+' | b'-') {
        return false;
    }
    let mut parts = value[1..].split(':');
    let (Some(hour), Some(minute), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    hour.parse::<u8>().is_ok_and(|value| value <= 23)
        && minute.parse::<u8>().is_ok_and(|value| value <= 59)
}

fn valid_bounded_string(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.trim() == value && value.len() <= maximum
}

fn valid_bounded_optional_string(value: &str) -> bool {
    valid_bounded_string(value, MAX_INLINE_PROPERTY_LENGTH)
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    #[test]
    fn skill_mention_title_round_trips_without_an_inventory() {
        let items = vec![
            RichTextItem::Text {
                text: "Run(".into(),
                styles: RichTextStyles::default(),
            },
            RichTextItem::SkillMention {
                name: "missing:Review_2".into(),
            },
            RichTextItem::Text {
                text: ")".into(),
                styles: RichTextStyles::default(),
            },
        ];
        let delta = rich_text_to_delta(&items).unwrap();
        assert_eq!(delta[1].insert, RICH_TEXT_ATOM.to_string());
        let materialized = materialize_rich_text(&delta).unwrap();
        assert_eq!(materialized.rich_text, items);
        assert_eq!(materialized.plain_text, "Run( $missing:Review_2 )");

        let mut malformed = delta;
        malformed[1].attributes.insert(
            ATOM_ATTRIBUTE.to_owned(),
            PortableValue::String(r#"{"type":"skillMention","name":"bad/path"}"#.into()),
        );
        assert!(materialize_rich_text(&malformed).is_err());
    }

    use std::path::PathBuf;

    use serde_json::Value;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, Update};

    use crate::document::create_compatible_document;
    use crate::domain::block_tree::decode_text_delta;

    use super::*;

    #[test]
    fn matches_the_typescript_rich_title_oracle() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let document = create_compatible_document("rich-title-matrix");
        let update = std::fs::read(root.join("matrix-base.bin")).expect("fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&update).expect("valid fixture"))
            .expect("fixture applies");
        let transaction = document.transact();
        let title = transaction.get_text("title").expect("title root");
        let delta = decode_text_delta(&title, &transaction).expect("title delta");
        let actual = materialize_rich_text(&delta).expect("rich title");
        let expected: Value = serde_json::from_slice(
            &std::fs::read(root.join("matrix-materialization.json")).expect("oracle fixture"),
        )
        .expect("valid fixture");

        assert_eq!(
            serde_json::to_value(&actual.rich_text).expect("serialize rich title"),
            expected["richTitle"]
        );
        assert_eq!(actual.plain_text, expected["title"]);
    }

    #[test]
    fn rejects_unknown_marks_untyped_atoms_and_invalid_dates() {
        let unknown = TextDelta {
            insert: "unsafe".to_owned(),
            attributes: [("mystery".to_owned(), PortableValue::Boolean(true))]
                .into_iter()
                .collect(),
        };
        assert_eq!(
            materialize_rich_text(&[unknown]),
            Err(RichTextError::UnsupportedAttribute("mystery".to_owned()))
        );
        let untyped = TextDelta {
            insert: RICH_TEXT_ATOM.to_string(),
            attributes: BTreeMap::new(),
        };
        assert_eq!(
            materialize_rich_text(&[untyped]),
            Err(RichTextError::UntypedAtom)
        );
        let atom = serde_json::json!({
            "type": "dateMention",
            "start": "not-a-date",
        });
        let invalid_date = TextDelta {
            insert: RICH_TEXT_ATOM.to_string(),
            attributes: [(
                ATOM_ATTRIBUTE.to_owned(),
                PortableValue::String(atom.to_string()),
            )]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            materialize_rich_text(&[invalid_date]),
            Err(RichTextError::InvalidAtom)
        );
    }

    #[test]
    fn counts_title_length_in_utf16_code_units() {
        let valid = TextDelta {
            insert: "😀".repeat(MAX_TITLE_UTF16_LENGTH / 2),
            attributes: BTreeMap::new(),
        };
        assert!(materialize_rich_text(&[valid]).is_ok());
        let invalid = TextDelta {
            insert: format!("{}a", "😀".repeat(MAX_TITLE_UTF16_LENGTH / 2)),
            attributes: BTreeMap::new(),
        };
        assert_eq!(
            materialize_rich_text(&[invalid]),
            Err(RichTextError::TitleTooLong)
        );
    }

    #[test]
    fn canonical_rich_title_round_trips_back_to_y_text_delta() {
        let (actual, _) = {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
            let document = create_compatible_document("rich-title-inverse");
            let update = std::fs::read(root.join("matrix-base.bin")).expect("fixture");
            document
                .transact_mut()
                .apply_update(Update::decode_v1(&update).expect("valid fixture"))
                .expect("fixture applies");
            let transaction = document.transact();
            let title = transaction.get_text("title").expect("title root");
            let delta = decode_text_delta(&title, &transaction).expect("title delta");
            let materialized = materialize_rich_text(&delta).expect("rich title");
            (materialized, delta)
        };

        let encoded = rich_text_to_delta(&actual.rich_text).expect("inverse title Delta");
        let roundtrip = materialize_rich_text(&encoded).expect("round-trip title");
        assert_eq!(roundtrip, actual);
    }

    #[test]
    fn canonicalizes_adjacent_text_and_embedded_newlines() {
        let items = vec![
            RichTextItem::Text {
                text: "one".to_owned(),
                styles: RichTextStyles::default(),
            },
            RichTextItem::Text {
                text: "\ntwo".to_owned(),
                styles: RichTextStyles::default(),
            },
        ];
        let canonical = canonicalize_rich_text(&items).expect("canonical rich title");
        assert_eq!(
            canonical.rich_text,
            vec![
                RichTextItem::Text {
                    text: "one".to_owned(),
                    styles: RichTextStyles::default(),
                },
                RichTextItem::LineBreak,
                RichTextItem::Text {
                    text: "two".to_owned(),
                    styles: RichTextStyles::default(),
                },
            ]
        );
    }
}
