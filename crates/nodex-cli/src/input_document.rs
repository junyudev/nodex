//! Explicit pipe inputs for commands that consume another CLI command's JSON output.
use serde::{Deserialize, Deserializer, de::Error};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, Deserialize, ToSchema)]
#[serde(untagged)]
pub(crate) enum InputDocument<T> {
    Raw(T),
    Success(SuccessInput<T>),
}
#[derive(Clone, Debug, PartialEq, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SuccessInput<T> {
    #[serde(deserialize_with = "version_one")]
    #[schema(minimum = 1, maximum = 1)]
    version: u8,
    #[serde(deserialize_with = "success_only")]
    #[schema(schema_with = true_schema)]
    ok: bool,
    result: T,
}
impl<T> InputDocument<T> {
    pub(crate) fn into_inner(self) -> T {
        match self {
            Self::Raw(value) => value,
            Self::Success(envelope) => envelope.result,
        }
    }
}
fn true_schema() -> utoipa::openapi::schema::Object {
    utoipa::openapi::schema::ObjectBuilder::new()
        .schema_type(utoipa::openapi::schema::Type::Boolean)
        .enum_values(Some([true]))
        .build()
}
fn version_one<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(deserializer)?;
    if value != 1 {
        return Err(D::Error::custom("CLI input envelope version must be 1"));
    }
    Ok(value)
}
fn success_only<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    if !bool::deserialize(deserializer)? {
        return Err(D::Error::custom("Cannot apply an unsuccessful CLI result"));
    }
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Example {
        edits: Vec<String>,
    }
    #[test]
    fn success_flag_schema_matches_decoder() {
        let validator =
            jsonschema::validator_for(&serde_json::to_value(true_schema()).unwrap()).unwrap();
        assert!(validator.is_valid(&serde_json::json!(true)));
        assert!(!validator.is_valid(&serde_json::json!(false)));
    }
    #[test]
    fn accepts_raw_or_success_and_rejects_failed_unknown_or_future_envelopes() {
        for input in [
            r#"{"edits":["a"]}"#,
            r#"{"version":1,"ok":true,"result":{"edits":["a"]}}"#,
        ] {
            assert_eq!(
                serde_json::from_str::<InputDocument<Example>>(input)
                    .unwrap()
                    .into_inner()
                    .edits,
                vec!["a"]
            );
        }
        for input in [
            r#"{"version":1,"ok":false,"result":{"edits":[]}}"#,
            r#"{"version":2,"ok":true,"result":{"edits":[]}}"#,
            r#"{"version":1,"ok":true,"result":{"edits":[]},"extra":1}"#,
        ] {
            assert!(serde_json::from_str::<InputDocument<Example>>(input).is_err());
        }
    }
}
