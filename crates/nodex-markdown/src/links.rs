//! Nodex links: `nodex://pages/ID` names a Page and `nodex://sessions/ID` names a chat.
//!
//! Ids are percent-encoded as JavaScript's `encodeURIComponent` encodes them, so the app and
//! Core write the same link for the same id, and a link reads back only to a non-empty id with
//! no surrounding whitespace.

const PAGE_PREFIX: &str = "nodex://pages/";
const SESSION_PREFIX: &str = "nodex://sessions/";

/// The link to a Page.
pub fn page_link(page_id: &str) -> String {
    format!("{PAGE_PREFIX}{}", encode_component(page_id))
}

/// The link to a chat, by its Session.
pub fn session_link(session_id: &str) -> String {
    format!("{SESSION_PREFIX}{}", encode_component(session_id))
}

/// The Page a link names, if it names one.
pub fn parse_page_link(link: &str) -> Option<String> {
    parse_link(link, "pages")
}

/// The Session a link names, if it names one.
pub fn parse_session_link(link: &str) -> Option<String> {
    parse_link(link, "sessions")
}

fn parse_link(link: &str, kind: &str) -> Option<String> {
    let rest = link
        .get(..8)?
        .eq_ignore_ascii_case("nodex://")
        .then(|| &link[8..])?;
    let (host, path) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case(kind) || path.is_empty() || path.contains('/') {
        return None;
    }
    let id = decode_component(path)?;
    (!id.is_empty() && id.trim() == id).then_some(id)
}

/// Percent-encodes everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )`, as `encodeURIComponent` does.
pub fn encode_component(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

/// Decodes percent-encoded UTF-8; `None` for malformed escapes or bytes.
pub fn decode_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let hex = std::str::from_utf8(bytes.get(cursor + 1..cursor + 3)?).ok()?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            cursor += 3;
        } else {
            output.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8(output).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_ids_like_encode_uri_component() {
        let id = "page 1/ü?";
        let link = page_link(id);
        assert_eq!(link, "nodex://pages/page%201%2F%C3%BC%3F");
        assert_eq!(parse_page_link(&link).as_deref(), Some(id));
        assert_eq!(
            parse_session_link(&session_link("s-1")).as_deref(),
            Some("s-1")
        );
    }

    #[test]
    fn reads_only_its_own_kind_of_link() {
        assert_eq!(parse_page_link("nodex://sessions/s-1"), None);
        assert_eq!(parse_page_link("nodex://pages/"), None);
        assert_eq!(parse_page_link("nodex://pages/a/b"), None);
        assert_eq!(parse_page_link("nodex://pages/%20a"), None);
        assert_eq!(parse_page_link("NODEX://Pages/p1").as_deref(), Some("p1"));
    }
}
