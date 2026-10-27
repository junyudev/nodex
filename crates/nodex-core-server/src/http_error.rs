use axum::Json;
use axum::body::to_bytes;
use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use nodex_core_contracts::{CoreError, CoreErrorCode, CoreErrorRecovery};
use nodex_core_protocol::HttpErrorResponse;

const MAX_REJECTION_MESSAGE_BYTES: usize = 8 * 1024;

#[derive(Clone)]
struct StructuredHttpError;

pub(crate) struct ApiError {
    status: StatusCode,
    error: CoreError,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        let code = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CoreErrorCode::Unauthorized,
            StatusCode::NOT_FOUND => CoreErrorCode::NotFound,
            StatusCode::CONFLICT => CoreErrorCode::Conflict,
            StatusCode::TOO_MANY_REQUESTS => CoreErrorCode::Overloaded,
            status if status.is_client_error() => CoreErrorCode::InvalidInput,
            _ => CoreErrorCode::CoreUnavailable,
        };
        Self::from_core(
            status,
            CoreError {
                code,
                message: message.into(),
                retryable: status == StatusCode::SERVICE_UNAVAILABLE
                    || status == StatusCode::TOO_MANY_REQUESTS,
                recovery: CoreErrorRecovery::None,
            },
        )
    }

    pub(crate) fn from_core(status: StatusCode, error: CoreError) -> Self {
        Self { status, error }
    }

    pub(crate) fn with_recovery(mut self, recovery: CoreErrorRecovery) -> Self {
        self.error.recovery = recovery;
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(HttpErrorResponse::Error(crate::record_core_error(
                self.error,
            ))),
        )
            .into_response();
        response.extensions_mut().insert(StructuredHttpError);
        response
    }
}

/// Axum turns extractor and routing rejections into responses before middleware sees them.
/// Keep this outside every route layer so new extractors cannot leak framework error formats.
pub(crate) async fn normalize(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if !status.is_client_error() && !status.is_server_error() {
        return response;
    }
    if response.extensions().get::<StructuredHttpError>().is_some() {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let message = to_bytes(body, MAX_REJECTION_MESSAGE_BYTES)
        .await
        .ok()
        .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("Core request failed")
                .to_owned()
        });
    let normalized = ApiError::new(status, message).into_response();
    // Preserve routing and lifecycle headers, but recalculate the representation headers.
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_TYPE);
    parts.headers.extend(normalized.headers().clone());
    parts.extensions.insert(StructuredHttpError);
    Response::from_parts(parts, normalized.into_body())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::extract::{DefaultBodyLimit, Extension, Path, Query};
    use axum::middleware;
    use axum::routing::{get, post};
    use nodex_core_protocol::ResponseEnvelope;
    use serde::Deserialize;
    use tower::ServiceExt;

    #[derive(Deserialize)]
    struct Input {
        sources: Vec<String>,
    }

    #[derive(Clone, Deserialize)]
    struct Window {
        after: u64,
    }

    fn test_router() -> Router {
        Router::new()
            .route(
                "/json",
                post(|Json(input): Json<Input>| async move { Json(input.sources) }),
            )
            .route(
                "/query",
                get(|Query(window): Query<Window>| async move { Json(window.after) }),
            )
            .route(
                "/path/{id}",
                get(|Path(id): Path<u64>| async move { Json(id) }),
            )
            .route(
                "/extension",
                get(|Extension(_): Extension<Window>| async {}),
            )
            .route("/bounded", post(|_: Bytes| async {}))
            .layer(DefaultBodyLimit::max(64))
            .layer(middleware::from_fn(normalize))
    }

    async fn rejection(
        method: &str,
        uri: &str,
        content_type: Option<&str>,
        body: &str,
    ) -> (StatusCode, CoreError) {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let response = test_router()
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        let ResponseEnvelope::Error(error) =
            serde_json::from_slice::<ResponseEnvelope<()>>(&bytes).unwrap()
        else {
            panic!("expected Core error envelope");
        };
        assert!(!error.message.is_empty());
        (status, error)
    }

    #[tokio::test]
    async fn extractor_rejections_share_the_core_error_envelope() {
        for (method, uri, content_type, body, expected) in [
            (
                "POST",
                "/json",
                Some("application/json"),
                "{",
                StatusCode::BAD_REQUEST,
            ),
            (
                "POST",
                "/json",
                Some("application/json"),
                r#"{"sources":[{"path":"/tmp"}]}"#,
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                "POST",
                "/json",
                None,
                "{}",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "POST",
                "/json",
                Some("text/plain"),
                "{}",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "GET",
                "/query?after=invalid",
                None,
                "",
                StatusCode::BAD_REQUEST,
            ),
            ("GET", "/path/invalid", None, "", StatusCode::BAD_REQUEST),
            (
                "POST",
                "/bounded",
                None,
                &"x".repeat(65),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let (status, error) = rejection(method, uri, content_type, body).await;
            assert_eq!(status, expected, "{method} {uri}");
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
            assert!(!error.retryable);
            assert_eq!(error.recovery, CoreErrorRecovery::None);
        }
    }

    #[tokio::test]
    async fn internal_and_routing_rejections_preserve_their_category_and_headers() {
        let (status, error) = rejection("GET", "/extension", None, "").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.code, CoreErrorCode::CoreUnavailable);
        let (status, error) = rejection("GET", "/missing", None, "").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, CoreErrorCode::NotFound);

        let response = test_router()
            .oneshot(Request::get("/json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(
            response.headers()[header::ALLOW]
                .to_str()
                .unwrap()
                .contains("POST")
        );
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    }

    #[tokio::test]
    async fn existing_envelopes_keep_their_recovery_evidence() {
        use nodex_core_contracts::document::{
            RecoveryFailureEffect, RecoveryFailureReason, RecoveryPackageFailure,
        };
        let recovery = CoreErrorRecovery::RecoveryPackage {
            failure: Box::new(RecoveryPackageFailure {
                reason: RecoveryFailureReason::RequestTooLarge,
                effect: RecoveryFailureEffect::NotApplied,
                actual: Some(65),
                limit: Some(64),
            }),
        };
        let expected = recovery.clone();
        let app = Router::new()
            .route(
                "/",
                get(move || async move {
                    ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "request body exceeds its bound",
                    )
                    .with_recovery(recovery)
                }),
            )
            .layer(middleware::from_fn(normalize));
        let response = app
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        let ResponseEnvelope::Error(error) =
            serde_json::from_slice::<ResponseEnvelope<()>>(&bytes).unwrap()
        else {
            panic!("Core error envelope")
        };
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(error.recovery, expected);
    }
}
