//! The code language catalog: canonical ids and every token that reads as them.
//!
//! A fence's language matches a catalog language by its id, label, alias or file extension,
//! normalized as the app normalizes them (NFKC, trimmed, without a leading `.`, lowercase); the
//! first language in catalog order that claims a token keeps it. Anything else is plain text.

use std::collections::HashMap;
use std::sync::OnceLock;

use unicode_normalization::UnicodeNormalization;

const CATALOG: &str =
    include_str!("../../../src/shared/nfm/code-language-catalog-v1.json");

fn lookup_token(value: &str) -> String {
    let normalized: String = value.nfkc().collect();
    let trimmed = normalized.trim();
    trimmed.strip_prefix('.').unwrap_or(trimmed).to_lowercase()
}

fn languages_by_token() -> &'static HashMap<String, String> {
    static TOKENS: OnceLock<HashMap<String, String>> = OnceLock::new();
    TOKENS.get_or_init(|| {
        let catalog: serde_json::Value =
            serde_json::from_str(CATALOG).expect("the code language catalog is valid JSON");
        let mut tokens = HashMap::new();
        for language in catalog["languages"].as_array().into_iter().flatten() {
            let Some(id) = language["id"].as_str() else {
                continue;
            };
            let names = [&language["id"], &language["label"]].into_iter().chain(
                ["aliases", "extensions"]
                    .into_iter()
                    .flat_map(|key| language[key].as_array().into_iter().flatten()),
            );
            for name in names.filter_map(serde_json::Value::as_str) {
                let token = lookup_token(name);
                if !token.is_empty() {
                    tokens.entry(token).or_insert_with(|| id.to_owned());
                }
            }
        }
        tokens
    })
}

/// The catalog id a code fence's language reads as; an unknown language is plain text.
pub fn language_id(language: &str) -> &'static str {
    languages_by_token()
        .get(&lookup_token(language))
        .map(String::as_str)
        .unwrap_or(crate::model::PLAIN_CODE_LANGUAGE)
}

#[cfg(test)]
mod tests {
    use super::language_id;

    #[test]
    fn reads_ids_labels_aliases_and_extensions() {
        assert_eq!(language_id("ts"), "typescript");
        assert_eq!(language_id("TypeScript"), "typescript");
        assert_eq!(language_id("sh"), "bash");
        assert_eq!(language_id(".py"), "python");
        assert_eq!(language_id(""), "text");
        assert_eq!(language_id("no-such-language"), "text");
    }
}
