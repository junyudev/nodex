use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::Request};
use serde::Serialize;
use serde_json::Value;

use crate::document_wire;

pub(crate) const MAX_JSON_REQUEST_BYTES: usize =
    nodex_core_protocol::MAX_ORDINARY_JSON_REQUEST_BYTES;
pub(crate) const MAX_DOCUMENT_REQUEST_BYTES: usize =
    nodex_core_protocol::MAX_DOCUMENT_JSON_REQUEST_BYTES;
const MAX_JSON_RESPONSE_BYTES: usize = nodex_core_protocol::MAX_ORDINARY_JSON_RESPONSE_BYTES;
const MAX_DOCUMENT_RESPONSE_BYTES: usize = nodex_core_protocol::MAX_DOCUMENT_RESPONSE_BYTES;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 100_000;
const MAX_JSON_ARRAY_ITEMS: usize = 65_536;
const MAX_JSON_OBJECT_FIELDS: usize = 4_096;
const MAX_JSON_KEY_BYTES: usize = 256;
const MAX_JSON_STRING_BYTES: usize = 1024 * 1024;
const DOCUMENT_ROUTE_PREFIX: &str = "/core/v1/modules/document/";
const FILE_BLOB_ROUTE_PREFIX: &str = "/core/v1/files/blobs/";
pub(crate) const BOUNDED_STREAM_HEADER: &str = "x-nodex-bounded-stream";

#[derive(Serialize)]
struct TransportError<'a> {
    error: &'a str,
}

pub(crate) async fn enforce(mut request: Request, next: Next) -> Response {
    let document_json =
        request.uri().path().starts_with(DOCUMENT_ROUTE_PREFIX) && is_json(request.headers());
    let request_limit = if document_json {
        MAX_DOCUMENT_REQUEST_BYTES
    } else if request.uri().path().starts_with(DOCUMENT_ROUTE_PREFIX) {
        document_wire::MAX_DOCUMENT_FRAME_BYTES
    } else if request.uri().path() == "/core/v1/blobs/prepare" {
        nodex_core_protocol::MAX_MANAGED_BLOB_BYTES
    } else if request.uri().path().starts_with(FILE_BLOB_ROUTE_PREFIX) {
        nodex_core_protocol::MAX_FILE_BLOB_BYTES
    } else {
        MAX_JSON_REQUEST_BYTES
    };
    if content_length_exceeds(request.headers(), request_limit) {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body exceeds its bound",
        );
    }

    if is_json(request.headers()) && request.method() != axum::http::Method::GET {
        let (parts, body) = request.into_parts();
        let bytes = match to_bytes(body, request_limit).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request body exceeds its bound",
                );
            }
        };
        if !bytes.is_empty()
            && let Err(message) = validate_json(
                &bytes,
                if document_json {
                    nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES
                } else {
                    MAX_JSON_STRING_BYTES
                },
            )
        {
            return error_response(StatusCode::BAD_REQUEST, message);
        }
        request = Request::from_parts(parts, Body::from(bytes));
    }

    let mut response = next.run(request).await;
    if response.headers().contains_key(BOUNDED_STREAM_HEADER) {
        response.headers_mut().remove(BOUNDED_STREAM_HEADER);
        return response;
    }
    let Some(limit) = response_limit(response.headers()) else {
        return response;
    };
    if content_length_exceeds(response.headers(), limit) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Core response exceeds its bound",
        );
    }
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, limit).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Core response exceeds its bound",
            );
        }
    };
    Response::from_parts(parts, Body::from(bytes))
}

fn validate_json(bytes: &[u8], max_string_bytes: usize) -> Result<(), &'static str> {
    let value = serde_json::from_slice::<Value>(bytes)
        .map_err(|_| "request body is not valid UTF-8 JSON")?;
    let mut nodes = 0;
    validate_json_value(&value, 1, &mut nodes, max_string_bytes)
}

fn validate_json_value(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    max_string_bytes: usize,
) -> Result<(), &'static str> {
    if depth > MAX_JSON_DEPTH {
        return Err("request JSON exceeds its nesting bound");
    }
    *nodes = nodes
        .checked_add(1)
        .ok_or("request JSON exceeds its node bound")?;
    if *nodes > MAX_JSON_NODES {
        return Err("request JSON exceeds its node bound");
    }
    match value {
        Value::String(value) if value.len() > max_string_bytes => {
            Err("request JSON string exceeds its bound")
        }
        Value::Array(values) => {
            if values.len() > MAX_JSON_ARRAY_ITEMS {
                return Err("request JSON array exceeds its bound");
            }
            for value in values {
                validate_json_value(value, depth + 1, nodes, max_string_bytes)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            if values.len() > MAX_JSON_OBJECT_FIELDS {
                return Err("request JSON object exceeds its field bound");
            }
            for (key, value) in values {
                if key.len() > MAX_JSON_KEY_BYTES {
                    return Err("request JSON key exceeds its bound");
                }
                validate_json_value(value, depth + 1, nodes, max_string_bytes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn is_json(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn response_limit(headers: &axum::http::HeaderMap) -> Option<usize> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())?
        .split(';')
        .next()?
        .trim();
    if content_type.eq_ignore_ascii_case("text/event-stream") {
        return None;
    }
    if content_type.eq_ignore_ascii_case(document_wire::CONTENT_TYPE) {
        return Some(MAX_DOCUMENT_RESPONSE_BYTES);
    }
    if content_type.eq_ignore_ascii_case("application/json") {
        return Some(MAX_JSON_RESPONSE_BYTES);
    }
    Some(MAX_JSON_RESPONSE_BYTES)
}

fn content_length_exceeds(headers: &axum::http::HeaderMap, limit: usize) -> bool {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|value| value > u64::try_from(limit).expect("transport limit fits u64"))
}

fn error_response(status: StatusCode, message: &'static str) -> Response {
    let mut response = (status, Json(TransportError { error: message })).into_response();
    response.headers_mut().insert(
        header::CONNECTION,
        header::HeaderValue::from_static("close"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_normal_protocol_object() {
        validate_json(
            br#"{"version":1,"read":{"kind":"metadata"}}"#,
            MAX_JSON_STRING_BYTES,
        )
        .expect("normal protocol JSON");
    }

    #[test]
    fn rejects_invalid_utf8_depth_and_container_bombs() {
        assert_eq!(
            validate_json(
                &[b'{', b'"', b'x', b'"', b':', b'"', 0xff, b'"', b'}'],
                MAX_JSON_STRING_BYTES,
            ),
            Err("request body is not valid UTF-8 JSON")
        );
        let nested = format!(
            "{}0{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert_eq!(
            validate_json(nested.as_bytes(), MAX_JSON_STRING_BYTES),
            Err("request JSON exceeds its nesting bound")
        );
        let array = serde_json::to_vec(&vec![0_u8; MAX_JSON_ARRAY_ITEMS + 1])
            .expect("oversized array JSON");
        assert_eq!(
            validate_json(&array, MAX_JSON_STRING_BYTES),
            Err("request JSON array exceeds its bound")
        );
    }

    #[test]
    fn rejects_oversized_keys_and_strings() {
        let key = serde_json::json!({ "x".repeat(MAX_JSON_KEY_BYTES + 1): true });
        assert_eq!(
            validate_json(
                &serde_json::to_vec(&key).expect("key JSON"),
                MAX_JSON_STRING_BYTES,
            ),
            Err("request JSON key exceeds its bound")
        );
        let string = serde_json::json!({ "value": "x".repeat(MAX_JSON_STRING_BYTES + 1) });
        assert_eq!(
            validate_json(
                &serde_json::to_vec(&string).expect("string JSON"),
                MAX_JSON_STRING_BYTES,
            ),
            Err("request JSON string exceeds its bound")
        );
    }

    #[test]
    fn document_json_uses_its_larger_decoded_string_bound() {
        let accepted = serde_json::json!({
            "nestedMarkdown": "x".repeat(nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES),
        });
        validate_json(
            &serde_json::to_vec(&accepted).expect("accepted Document JSON"),
            nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES,
        )
        .expect("Document JSON accepts an 8 MiB decoded string");

        let rejected = serde_json::json!({
            "nestedMarkdown": "x".repeat(
                nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES + 1
            ),
        });
        assert_eq!(
            validate_json(
                &serde_json::to_vec(&rejected).expect("rejected Document JSON"),
                nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES,
            ),
            Err("request JSON string exceeds its bound")
        );
    }

    #[test]
    fn ordinary_json_content_length_accepts_exact_limit_and_rejects_limit_plus_one() {
        let exact = axum::http::HeaderMap::from_iter([(
            CONTENT_LENGTH,
            axum::http::HeaderValue::from_str(&MAX_JSON_RESPONSE_BYTES.to_string())
                .expect("exact response length"),
        )]);
        let oversized = axum::http::HeaderMap::from_iter([(
            CONTENT_LENGTH,
            axum::http::HeaderValue::from_str(&(MAX_JSON_RESPONSE_BYTES + 1).to_string())
                .expect("oversized response length"),
        )]);

        assert!(!content_length_exceeds(&exact, MAX_JSON_RESPONSE_BYTES));
        assert!(content_length_exceeds(&oversized, MAX_JSON_RESPONSE_BYTES));
    }

    #[test]
    fn server_ordinary_transport_budgets_are_protocol_owned() {
        assert_eq!(
            MAX_JSON_REQUEST_BYTES,
            nodex_core_protocol::CORE_TRANSPORT_BUDGETS.ordinary_json_request_bytes as usize
        );
        assert_eq!(
            MAX_JSON_RESPONSE_BYTES,
            nodex_core_protocol::CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes as usize
        );
    }
}
