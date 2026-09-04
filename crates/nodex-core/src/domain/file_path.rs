use unicode_normalization::UnicodeNormalization;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) const MAX_PAGE_FILE_PATH_BYTES: usize = 1_024;
pub(crate) const MAX_PAGE_FILE_COMPONENT_BYTES: usize = 255;
pub(crate) const MAX_PAGE_FILE_PATH_DEPTH: usize = 32;

const WINDOWS_INVALID_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '\\', '|', '?', '*', '\0'];

/// One portable path in a Page's direct File namespace.
///
/// Callers persist `display` and compare `collision_key`; they never repeat
/// platform-specific path validation or infer durable Folder identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PortablePageFilePath {
    display: String,
    collision_key: String,
    components: Vec<String>,
}

impl PortablePageFilePath {
    pub(crate) fn parse(input: &str) -> Result<Self, StoreError> {
        if input.is_empty() {
            return Err(invalid("Page File path cannot be empty"));
        }
        if input.starts_with('/') || input.starts_with('\\') {
            return Err(invalid("Page File path must be relative"));
        }
        if input.contains('\\') {
            return Err(invalid("Page File path must use '/' separators"));
        }

        let raw_components = input.split('/').collect::<Vec<_>>();
        if raw_components.len() > MAX_PAGE_FILE_PATH_DEPTH {
            return Err(invalid("Page File path exceeds its depth bound"));
        }

        let mut components = Vec::with_capacity(raw_components.len());
        let mut collision_components = Vec::with_capacity(raw_components.len());
        for raw in raw_components {
            let component = normalize_component(raw)?;
            let collision = component
                .nfkc()
                .flat_map(char::to_lowercase)
                .collect::<String>();
            components.push(component);
            collision_components.push(collision);
        }

        let display = components.join("/");
        if display.len() > MAX_PAGE_FILE_PATH_BYTES {
            return Err(invalid("Page File path exceeds its byte bound"));
        }

        Ok(Self {
            display,
            collision_key: collision_components.join("/"),
            components,
        })
    }

    pub(crate) fn display(&self) -> &str {
        &self.display
    }

    pub(crate) fn collision_key(&self) -> &str {
        &self.collision_key
    }

    #[cfg(test)]
    pub(crate) fn parent_prefixes(&self) -> impl Iterator<Item = String> + '_ {
        (1..self.components.len()).map(|length| self.components[..length].join("/"))
    }
}

fn normalize_component(raw: &str) -> Result<String, StoreError> {
    if raw.is_empty() || matches!(raw, "." | "..") {
        return Err(invalid("Page File path contains an invalid component"));
    }
    if raw.ends_with(['.', ' ']) {
        return Err(invalid(
            "Page File path components cannot end with a dot or space",
        ));
    }
    if raw
        .chars()
        .any(|character| character.is_control() || WINDOWS_INVALID_CHARACTERS.contains(&character))
    {
        return Err(invalid("Page File path contains a non-portable character"));
    }

    let component = raw.nfc().collect::<String>();
    if component.len() > MAX_PAGE_FILE_COMPONENT_BYTES {
        return Err(invalid("Page File path component exceeds its byte bound"));
    }
    if is_windows_reserved_name(&component) {
        return Err(invalid("Page File path uses a reserved filename"));
    }
    Ok(component)
}

/// A Library File's default name is one portable component, independent of any
/// Page path. Equal names are legal; callers identify Files by their stable ID.
pub(crate) fn normalize_file_name(input: &str) -> Result<String, StoreError> {
    if input.contains('/') {
        return Err(invalid("File name cannot contain a directory"));
    }
    normalize_component(input)
}

fn is_windows_reserved_name(component: &str) -> bool {
    let basename = component.split('.').next().unwrap_or(component);
    let upper = basename.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

pub(crate) fn suffixed_path(
    directory: &str,
    stem: &str,
    extension: &str,
    suffix: &str,
) -> Option<String> {
    let directory_bytes = directory.len() + usize::from(!directory.is_empty());
    let basename_limit =
        MAX_PAGE_FILE_COMPONENT_BYTES.min(MAX_PAGE_FILE_PATH_BYTES.checked_sub(directory_bytes)?);
    let stem_limit = basename_limit.checked_sub(suffix.len() + extension.len())?;
    let mut stem_end = stem.len().min(stem_limit);
    while stem_end > 0 && !stem.is_char_boundary(stem_end) {
        stem_end -= 1;
    }
    if stem_end == 0 {
        return None;
    }
    let basename = format!("{}{suffix}{extension}", &stem[..stem_end]);
    Some(if directory.is_empty() {
        basename
    } else {
        format!("{directory}/{basename}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_file_names_are_single_portable_components() {
        assert_eq!(normalize_file_name("Cafe\u{301}.png").unwrap(), "Café.png");
        for name in [
            "",
            ".",
            "../image.png",
            "folder/image.png",
            "NUL.txt",
            "image.",
        ] {
            assert!(normalize_file_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn normalizes_display_and_builds_a_portable_collision_key() {
        let path =
            PortablePageFilePath::parse("Prototype/Cafe\u{301}/App.TS").expect("portable path");
        assert_eq!(path.display(), "Prototype/Café/App.TS");
        assert_eq!(path.collision_key(), "prototype/café/app.ts");
        assert_eq!(
            path.parent_prefixes().collect::<Vec<_>>(),
            vec!["Prototype", "Prototype/Café"]
        );
    }

    #[test]
    fn compatibility_equivalents_share_one_collision_key() {
        let full_width = PortablePageFilePath::parse("Ａpp/readme.md").expect("full width");
        let ascii = PortablePageFilePath::parse("app/README.md").expect("ascii");
        assert_eq!(full_width.collision_key(), ascii.collision_key());
        assert_ne!(full_width.display(), ascii.display());
    }

    #[test]
    fn rejects_traversal_absolute_and_windows_unsafe_paths() {
        for path in [
            "../secret",
            "/absolute",
            "folder//file",
            "folder\\file",
            "CON.txt",
            "nested/LPT9",
            "trailing. ",
            "bad:name",
        ] {
            assert!(
                PortablePageFilePath::parse(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn enforces_depth_component_and_total_byte_bounds() {
        let too_deep = std::iter::repeat_n("x", MAX_PAGE_FILE_PATH_DEPTH + 1)
            .collect::<Vec<_>>()
            .join("/");
        assert!(PortablePageFilePath::parse(&too_deep).is_err());

        let long_component = "x".repeat(MAX_PAGE_FILE_COMPONENT_BYTES + 1);
        assert!(PortablePageFilePath::parse(&long_component).is_err());

        let components = std::iter::repeat_n("x".repeat(40), MAX_PAGE_FILE_PATH_DEPTH)
            .collect::<Vec<_>>()
            .join("/");
        assert!(components.len() > MAX_PAGE_FILE_PATH_BYTES);
        assert!(PortablePageFilePath::parse(&components).is_err());
    }
}
