//! One-shot native filesystem admission for Main, independent of Core's daemon and Store.
use std::io::{self, Read};
use std::path::PathBuf;

use nodex_platform::private_fs::{self, EntryKind};
use serde::Deserialize;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    verify: bool,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    directory: bool,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// Paths arrive on bounded stdin, never in process arguments or an HTTP endpoint.
pub fn run(input: impl Read) -> io::Result<()> {
    let mut bytes = Vec::new();
    input.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(invalid("Private filesystem request exceeds its byte limit"));
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
    if request.entries.is_empty() || request.entries.len() > 64 {
        return Err(invalid(
            "Private filesystem request requires 1 to 64 entries",
        ));
    }
    for entry in &request.entries {
        if !entry.path.is_absolute() || private_fs::has_traversal(&entry.path) {
            return Err(invalid(
                "Private filesystem entry requires an absolute native path",
            ));
        }
        private_fs::entry_metadata(&entry.path, kind(entry))?;
    }
    for entry in request.entries {
        let kind = kind(&entry);
        if request.verify {
            private_fs::checked_metadata(
                &entry.path,
                kind,
                Some(if entry.directory { 0o700 } else { 0o600 }),
            )?;
        } else {
            private_fs::prepare_private_path(&entry.path, kind)?;
        }
    }
    Ok(())
}

fn kind(entry: &Entry) -> EntryKind {
    if entry.directory {
        EntryKind::Directory
    } else {
        EntryKind::File
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_platform::test_support::tempdir;
    use serde_json::json;

    #[test]
    fn publishes_and_independently_verifies_owned_files_and_directories() {
        let root = tempdir().unwrap();
        let directory = root.path().join("private");
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("record");
        std::fs::write(&file, b"private").unwrap();
        let entries = json!([{"path":directory,"directory":true},{"path":file,"directory":false}]);
        run(json!({"verify":false,"entries":entries})
            .to_string()
            .as_bytes())
        .unwrap();
        run(json!({"verify":true,"entries":entries})
            .to_string()
            .as_bytes())
        .unwrap();
        assert_eq!(std::fs::read(file).unwrap(), b"private");
    }

    #[test]
    fn rejects_relative_alias_and_oversized_inputs() {
        assert!(
            run(
                br#"{"verify":false,"entries":[{"path":"relative","directory":false}]}"#.as_slice()
            )
            .is_err()
        );
        assert!(run(vec![b' '; MAX_REQUEST_BYTES as usize + 1].as_slice()).is_err());
        let root = tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, b"unchanged").unwrap();
        let alias = root.path().join("alias");
        private_fs::symlink(&file, &alias).unwrap();
        assert!(
            run(
                json!({"verify":false,"entries":[{"path":alias,"directory":false}]})
                    .to_string()
                    .as_bytes()
            )
            .is_err()
        );
        assert_eq!(std::fs::read(file).unwrap(), b"unchanged");
    }
}
