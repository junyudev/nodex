//! Attribute lists: `{name="value" flag}`.
//!
//! An attribute is a name of lowercase letters, digits and hyphens, followed by `="value"` or
//! by nothing, as a flag. Values are double-quoted and decode character references; nothing else
//! in them is an escape, so a backslash is itself. A value holds no line break of its own.

/// One attribute of a list, in the order written. `value` is `None` for a flag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attribute {
    pub name: String,
    pub value: Option<String>,
}

impl Attribute {
    pub fn value(name: &str, value: impl Into<String>) -> Attribute {
        Attribute {
            name: name.to_owned(),
            value: Some(value.into()),
        }
    }

    pub fn flag(name: &str) -> Attribute {
        Attribute {
            name: name.to_owned(),
            value: None,
        }
    }
}

/// Why text that starts like an attribute list is not one.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AttributeError {
    #[error("an attribute list starts with `{{` and ends with `}}`")]
    Unclosed,
    #[error("attribute names are lowercase letters, digits and hyphens")]
    InvalidName,
    #[error("attribute values are double-quoted")]
    UnquotedValue,
    #[error("an attribute value holds no line break")]
    LineBreakInValue,
    #[error("attributes are separated by single spaces")]
    InvalidSeparator,
    #[error("`{0}` is written more than once")]
    Repeated(String),
}

/// Reads an attribute list that starts at the beginning of `source`, returning the attributes
/// and the length of the list in bytes, `{` and `}` included.
pub fn read_attribute_list(source: &str) -> Result<(Vec<Attribute>, usize), AttributeError> {
    let bytes = source.as_bytes();
    if bytes.first() != Some(&b'{') {
        return Err(AttributeError::Unclosed);
    }
    let mut index = 1;
    let mut attributes: Vec<Attribute> = Vec::new();
    let mut names = std::collections::HashSet::new();
    loop {
        match bytes.get(index) {
            None => return Err(AttributeError::Unclosed),
            Some(b'}') if attributes.is_empty() => return Ok((attributes, index + 1)),
            _ => {}
        }
        let name_start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        {
            index += 1;
        }
        if index == name_start || !bytes[name_start].is_ascii_lowercase() {
            return Err(AttributeError::InvalidName);
        }
        let name = &source[name_start..index];
        let value = if bytes.get(index) == Some(&b'=') {
            index += 1;
            if bytes.get(index) != Some(&b'"') {
                return Err(AttributeError::UnquotedValue);
            }
            index += 1;
            let value_start = index;
            loop {
                match bytes.get(index) {
                    None => return Err(AttributeError::Unclosed),
                    Some(b'"') => break,
                    Some(b'\n' | b'\r') => return Err(AttributeError::LineBreakInValue),
                    Some(_) => index += 1,
                }
            }
            let raw = &source[value_start..index];
            index += 1;
            Some(decode_references(raw))
        } else {
            None
        };
        if !names.insert(name) {
            return Err(AttributeError::Repeated(name.to_owned()));
        }
        attributes.push(Attribute {
            name: name.to_owned(),
            value,
        });
        match bytes.get(index) {
            Some(b'}') => return Ok((attributes, index + 1)),
            Some(b' ')
                if bytes
                    .get(index + 1)
                    .is_some_and(|byte| *byte != b' ' && *byte != b'}') =>
            {
                index += 1;
            }
            None => return Err(AttributeError::Unclosed),
            _ => return Err(AttributeError::InvalidSeparator),
        }
    }
}

/// Writes attributes as a list, `{}` when there are none.
pub fn write_attribute_list(attributes: &[Attribute]) -> String {
    let mut out = String::from("{");
    for (index, attribute) in attributes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&attribute.name);
        if let Some(value) = &attribute.value {
            out.push_str("=\"");
            out.push_str(&encode_value(value));
            out.push('"');
        }
    }
    out.push('}');
    out
}

/// A value as written between double quotes: a quotation mark as `&quot;`, a line break as
/// `&#10;`, and `&` as `&amp;` only where it would begin a character reference.
pub fn encode_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for (index, character) in value.char_indices() {
        match character {
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            '&' if reference_at(&value[index..]).is_some() => out.push_str("&amp;"),
            other => out.push(other),
        }
    }
    out
}

/// Decodes the character references in an attribute value.
pub fn decode_references(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        let rest = &raw[index..];
        if let Some((decoded, length)) = reference_at(rest) {
            out.push_str(&decoded);
            index += length;
        } else {
            let character = rest.chars().next().unwrap_or_default();
            out.push(character);
            index += character.len_utf8();
        }
    }
    out
}

/// The character reference at the start of `text`, decoded, with its length in bytes.
fn reference_at(text: &str) -> Option<(String, usize)> {
    let rest = text.strip_prefix('&')?;
    // A reference body is at most 32 bytes, so the search for its `;` never runs further.
    let end = rest.bytes().take(33).position(|byte| byte == b';')?;
    let body = &rest[..end];
    if body.is_empty() {
        return None;
    }
    let decoded = if let Some(number) = body.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) if !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
                u32::from_str_radix(hex, 16).ok()?
            }
            Some(_) => return None,
            None if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) => {
                number.parse().ok()?
            }
            None => return None,
        };
        char::from_u32(code)
            .filter(|character| *character != '\0')?
            .to_string()
    } else {
        named_reference(body)?.to_owned()
    };
    Some((decoded, end + 2))
}

fn named_reference(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "quot" => "\"",
        "apos" => "'",
        "lt" => "<",
        "gt" => ">",
        "nbsp" => "\u{a0}",
        _ => return None,
    })
}

/// Pairs read from attributes kept as written, such as an Agent config's unknown ones.
pub fn parse_attribute_pairs(raw: &str) -> Vec<(String, String)> {
    let wrapped = format!("{{{}}}", raw.trim());
    match read_attribute_list(&wrapped) {
        Ok((attributes, _)) => attributes
            .into_iter()
            .map(|attribute| (attribute.name, attribute.value.unwrap_or_default()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Pairs written as attributes, without the braces.
pub fn write_attribute_pairs(pairs: &[(String, String)]) -> String {
    let attributes: Vec<Attribute> = pairs
        .iter()
        .map(|(name, value)| Attribute::value(name, value.clone()))
        .collect();
    let list = write_attribute_list(&attributes);
    list[1..list.len() - 1].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_values_and_flags() {
        let (attributes, length) =
            read_attribute_list(r#"{underline color="red"} rest"#).expect("list");
        assert_eq!(
            attributes,
            vec![
                Attribute::flag("underline"),
                Attribute::value("color", "red")
            ]
        );
        assert_eq!(length, 23);
    }

    #[test]
    fn decodes_references_and_keeps_backslashes() {
        let (attributes, _) =
            read_attribute_list(r#"{hint="Say &quot;hi&quot; & wave" source="C:\tmp\notes.txt"}"#)
                .expect("list");
        assert_eq!(attributes[0].value.as_deref(), Some("Say \"hi\" & wave"));
        assert_eq!(attributes[1].value.as_deref(), Some(r"C:\tmp\notes.txt"));
    }

    #[test]
    fn refuses_other_spellings() {
        assert_eq!(
            read_attribute_list("{id='page-1'}"),
            Err(AttributeError::UnquotedValue)
        );
        assert_eq!(
            read_attribute_list("{id=page-1}"),
            Err(AttributeError::UnquotedValue)
        );
        assert_eq!(
            read_attribute_list("{#id}"),
            Err(AttributeError::InvalidName)
        );
        assert_eq!(
            read_attribute_list("{.class}"),
            Err(AttributeError::InvalidName)
        );
        assert_eq!(
            read_attribute_list("{a=\"x\"  b}"),
            Err(AttributeError::InvalidSeparator)
        );
        assert_eq!(
            read_attribute_list("{a=\"x\nb\"}"),
            Err(AttributeError::LineBreakInValue)
        );
    }

    #[test]
    fn writes_the_fewest_references() {
        let attributes = vec![
            Attribute::value("hint", "Say \"hi\" & wave"),
            Attribute::value("url", "https://example.com/?a=1&b=2"),
            Attribute::value("literal", "&amp;"),
        ];
        assert_eq!(
            write_attribute_list(&attributes),
            r#"{hint="Say &quot;hi&quot; & wave" url="https://example.com/?a=1&b=2" literal="&amp;amp;"}"#
        );
    }
}
