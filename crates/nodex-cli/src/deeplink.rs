use crate::error::{CliError, CliErrorCode};
use serde::Serialize;
use utoipa::ToSchema;

const PROTOCOL_PREFIX: &str = "nodex://";
const MAX_ID_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodexDeepLinkKind {
    Page,
    Session,
    View,
}

impl NodexDeepLinkKind {
    fn path(self) -> &'static str {
        match self {
            Self::Page => "pages",
            Self::Session => "sessions",
            Self::View => "views",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodexDeepLink {
    pub kind: NodexDeepLinkKind,
    pub id: String,
}

pub fn build(kind: NodexDeepLinkKind, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    Some(format!(
        "{PROTOCOL_PREFIX}{}/{id}",
        kind.path(),
        id = percent_encode(id)
    ))
}

pub(crate) fn resource_url(kind: NodexDeepLinkKind, id: &str) -> Result<String, CliError> {
    build(kind, id).ok_or_else(|| {
        CliError::new(
            CliErrorCode::Internal,
            "Validated Core identity cannot be encoded as a Nodex link",
        )
    })
}

pub(crate) fn page_url(id: &str) -> Result<String, CliError> {
    resource_url(NodexDeepLinkKind::Page, id)
}

/// Adds a link to a primary CLI result while retaining its typed Core fields.
#[derive(Serialize, ToSchema)]
pub(crate) struct LinkedPage<T> {
    #[serde(flatten)]
    #[schema(inline)]
    pub page: T,
    pub url: String,
}

impl<T> LinkedPage<T> {
    pub(crate) fn new(page: T, page_id: impl FnOnce(&T) -> &str) -> Result<Self, CliError> {
        let url = page_url(page_id(&page))?;
        Ok(Self { page, url })
    }
}

pub fn parse(value: &str) -> Option<NodexDeepLink> {
    if value.trim() != value {
        return None;
    }
    let (scheme, remainder) = value.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("nodex") {
        return None;
    }
    let path = remainder.strip_prefix('/').unwrap_or(remainder);
    let path = path.split(['?', '#']).next()?;
    let mut segments = path.split('/');
    let kind = match segments.next()?.to_ascii_lowercase().as_str() {
        "pages" => NodexDeepLinkKind::Page,
        "sessions" => NodexDeepLinkKind::Session,
        "views" => NodexDeepLinkKind::View,
        _ => return None,
    };
    let id = percent_decode(segments.next()?)?;
    if segments.next().is_some() || !valid_id(&id) {
        return None;
    }
    Some(NodexDeepLink { kind, id })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && value.trim() == value
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(*byte));
            continue;
        }
        use std::fmt::Write as _;
        write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
    }
    encoded
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = hex_value(*bytes.get(index + 1)?)?;
        let low = hex_value(*bytes.get(index + 2)?)?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Vectors {
        valid: Vec<ValidVector>,
        invalid: Vec<InvalidVector>,
    }

    #[derive(Deserialize)]
    struct ValidVector {
        kind: String,
        id: String,
        canonical: String,
        accepted: Vec<String>,
    }

    #[derive(Deserialize)]
    struct InvalidVector {
        value: String,
    }

    fn kind(value: &str) -> NodexDeepLinkKind {
        match value {
            "page" => NodexDeepLinkKind::Page,
            "session" => NodexDeepLinkKind::Session,
            "view" => NodexDeepLinkKind::View,
            _ => panic!("unknown fixture kind"),
        }
    }

    #[test]
    fn conforms_to_the_shared_deep_link_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../../../tests/fixtures/nodex-deeplinks.json"))
                .expect("deep-link vectors");

        for vector in vectors.valid {
            let expected_kind = kind(&vector.kind);
            assert_eq!(
                build(expected_kind, &vector.id).as_deref(),
                Some(vector.canonical.as_str())
            );
            for accepted in vector.accepted {
                assert_eq!(
                    parse(&accepted),
                    Some(NodexDeepLink {
                        kind: expected_kind,
                        id: vector.id.clone(),
                    })
                );
            }
        }
        for vector in vectors.invalid {
            assert_eq!(parse(&vector.value), None);
        }
    }
}
