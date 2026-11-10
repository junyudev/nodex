use serde_json::{Map, Value};
use thiserror::Error;

use super::rich_text::{
    RichTextItem, RichTextMaterialization, RichTextStyles, canonicalize_rich_text,
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MaterializedInlineError {
    #[error("Block primary content is not title-safe")]
    UnsupportedPrimaryContent,
}

/// Converts canonical Page rich title atoms directly into BlockNote portable
/// inline content. This deliberately avoids a Markdown round-trip so marks and
/// typed mentions retain their identity.
pub fn materialized_inline_from_rich_text(
    items: &[RichTextItem],
) -> Result<Value, MaterializedInlineError> {
    let canonical = canonicalize_rich_text(items)
        .map_err(|_| MaterializedInlineError::UnsupportedPrimaryContent)?;
    Ok(Value::Array(
        canonical.rich_text.iter().map(encode_item).collect(),
    ))
}

/// Reads the portable inline subset that can serve as a Page rich title.
pub fn rich_text_from_materialized_inline(
    content: &Value,
) -> Result<RichTextMaterialization, MaterializedInlineError> {
    let content = content
        .as_array()
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let items = content
        .iter()
        .map(decode_item)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    canonicalize_rich_text(&items).map_err(|_| MaterializedInlineError::UnsupportedPrimaryContent)
}

fn encode_item(item: &RichTextItem) -> Value {
    match item {
        RichTextItem::Text { text, styles } => text_json(text, styles),
        RichTextItem::Link { text, href, styles } => serde_json::json!({
            "type": "link",
            "href": href,
            "content": [text_json(text, styles)],
        }),
        RichTextItem::LineBreak => text_json("\n", &RichTextStyles::default()),
        RichTextItem::ThreadMention { uuid } => serde_json::json!({
            "type": "threadMention",
            "props": { "uuid": uuid },
        }),
        RichTextItem::PageMention { target_page_id } => serde_json::json!({
            "type": "pageMention",
            "props": { "targetPageId": target_page_id },
        }),
        RichTextItem::SkillMention { name } => serde_json::json!({
            "type": "skillMention",
            "props": { "name": name },
        }),
        RichTextItem::DateMention {
            start,
            end,
            tz,
            format,
            time_format,
            reminder,
        } => serde_json::json!({
            "type": "dateMention",
            "props": {
                "start": start,
                "end": end.clone().unwrap_or_default(),
                "tz": tz.clone().unwrap_or_default(),
                "format": format.clone().unwrap_or_default(),
                "timeFormat": time_format.clone().unwrap_or_default(),
                "reminder": reminder.clone().unwrap_or_default(),
            }
        }),
    }
}

fn text_json(text: &str, styles: &RichTextStyles) -> Value {
    let mut output = Map::new();
    for (key, enabled) in [
        ("bold", styles.bold),
        ("italic", styles.italic),
        ("strike", styles.strikethrough),
        ("underline", styles.underline),
        ("code", styles.code),
    ] {
        if enabled {
            output.insert(key.to_owned(), Value::Bool(true));
        }
    }
    if let Some(color) = &styles.color {
        output.insert(
            if color.ends_with("_bg") {
                "backgroundColor"
            } else {
                "textColor"
            }
            .to_owned(),
            Value::String(color.strip_suffix("_bg").unwrap_or(color).to_owned()),
        );
    }
    serde_json::json!({ "type": "text", "text": text, "styles": output })
}

fn decode_item(value: &Value) -> Result<Vec<RichTextItem>, MaterializedInlineError> {
    let object = value
        .as_object()
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    match object.get("type").and_then(Value::as_str) {
        Some("text") => decode_text_item(object),
        Some("link") => decode_link_item(object),
        Some("threadMention") => Ok(vec![RichTextItem::ThreadMention {
            uuid: required_prop(object, "uuid")?,
        }]),
        Some("pageMention") => Ok(vec![RichTextItem::PageMention {
            target_page_id: required_prop(object, "targetPageId")?,
        }]),
        Some("skillMention") => Ok(vec![RichTextItem::SkillMention {
            name: required_prop(object, "name")?,
        }]),
        Some("dateMention") => decode_date_mention(object),
        _ => Err(MaterializedInlineError::UnsupportedPrimaryContent),
    }
}

fn decode_link_item(
    object: &Map<String, Value>,
) -> Result<Vec<RichTextItem>, MaterializedInlineError> {
    let href = object
        .get("href")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let mut output = Vec::new();
    for value in content {
        let child = value
            .as_object()
            .filter(|value| value.get("type").and_then(Value::as_str) == Some("text"))
            .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
        let text = child
            .get("text")
            .and_then(Value::as_str)
            .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
        let styles = child
            .get("styles")
            .map(decode_styles)
            .transpose()?
            .unwrap_or_default();
        output.extend(split_lines(text, |text| RichTextItem::Link {
            text,
            href: href.to_owned(),
            styles: styles.clone(),
        }));
    }
    Ok(output)
}

fn decode_text_item(
    object: &Map<String, Value>,
) -> Result<Vec<RichTextItem>, MaterializedInlineError> {
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let styles = object
        .get("styles")
        .map(decode_styles)
        .transpose()?
        .unwrap_or_default();
    Ok(split_lines(text, |text| RichTextItem::Text {
        text,
        styles: styles.clone(),
    }))
}

fn split_lines(text: &str, make: impl Fn(String) -> RichTextItem) -> Vec<RichTextItem> {
    let pieces = text.split('\n').collect::<Vec<_>>();
    let mut output = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        if !piece.is_empty() {
            output.push(make((*piece).to_owned()));
        }
        if index + 1 < pieces.len() {
            output.push(RichTextItem::LineBreak);
        }
    }
    output
}

fn decode_styles(value: &Value) -> Result<RichTextStyles, MaterializedInlineError> {
    let object = value
        .as_object()
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let flag = |name: &str| object.get(name).and_then(Value::as_bool).unwrap_or(false);
    let foreground = object
        .get("textColor")
        .and_then(Value::as_str)
        .filter(|value| *value != "default");
    let background = object
        .get("backgroundColor")
        .and_then(Value::as_str)
        .filter(|value| *value != "default")
        .map(|value| format!("{value}_bg"));
    Ok(RichTextStyles {
        bold: flag("bold"),
        italic: flag("italic"),
        underline: flag("underline"),
        strikethrough: flag("strike"),
        code: flag("code"),
        color: background.or_else(|| foreground.map(str::to_owned)),
    })
}

fn required_prop(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, MaterializedInlineError> {
    object
        .get("props")
        .and_then(Value::as_object)
        .and_then(|props| props.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)
}

fn decode_date_mention(
    object: &Map<String, Value>,
) -> Result<Vec<RichTextItem>, MaterializedInlineError> {
    let props = object
        .get("props")
        .and_then(Value::as_object)
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let start = props
        .get("start")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(MaterializedInlineError::UnsupportedPrimaryContent)?;
    let optional = |key: &str| {
        props
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Ok(vec![RichTextItem::DateMention {
        start: start.to_owned(),
        end: optional("end"),
        tz: optional("tz"),
        format: optional("format"),
        time_format: optional("timeFormat"),
        reminder: optional("reminder"),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_title_safe_inline_atom() {
        let items = vec![
            RichTextItem::Text {
                text: "Styled".to_owned(),
                styles: RichTextStyles {
                    bold: true,
                    color: Some("blue_bg".to_owned()),
                    ..RichTextStyles::default()
                },
            },
            RichTextItem::LineBreak,
            RichTextItem::Link {
                text: "link".to_owned(),
                href: "https://nodex.local".to_owned(),
                styles: RichTextStyles {
                    italic: true,
                    ..RichTextStyles::default()
                },
            },
            RichTextItem::ThreadMention {
                uuid: "thread-a".to_owned(),
            },
            RichTextItem::PageMention {
                target_page_id: "page-a".to_owned(),
            },
            RichTextItem::SkillMention {
                name: "review".into(),
            },
            RichTextItem::DateMention {
                start: "2026-08-23T09:30:00+08:00".to_owned(),
                end: None,
                tz: Some("Asia/Shanghai".to_owned()),
                format: None,
                time_format: None,
                reminder: None,
            },
        ];
        let encoded = materialized_inline_from_rich_text(&items).expect("encoded");
        let decoded = rich_text_from_materialized_inline(&encoded).expect("decoded");
        assert_eq!(decoded.rich_text, items);
    }
}
