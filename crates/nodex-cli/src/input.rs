use std::fs::File;
use std::io::{self, IsTerminal, Read};
use std::path::Path;

use serde::de::DeserializeOwned;

use crate::error::{CliError, CliErrorCode};

pub const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;

/// A regular file and redirected stdin use the same bounded decoder.
pub(crate) fn read_bytes(path: &Path, limit: usize, label: &str) -> Result<Vec<u8>, CliError> {
    if path.as_os_str() == "-" {
        let stdin = io::stdin();
        if stdin.is_terminal() {
            return Err(invalid(format!("{label} requires redirected stdin")));
        }
        return read_bounded(&mut stdin.lock(), limit, label);
    }
    let metadata = std::fs::metadata(path).map_err(|error| invalid(error.to_string()))?;
    if !metadata.is_file() {
        return Err(invalid(format!("{label} input must be a regular file")));
    }
    if metadata.len() > limit as u64 {
        return Err(invalid(format!("{label} input exceeds {limit} bytes")));
    }
    let mut file = File::open(path).map_err(|error| invalid(error.to_string()))?;
    if !file
        .metadata()
        .map_err(|error| invalid(error.to_string()))?
        .is_file()
    {
        return Err(invalid(format!("{label} input must be a regular file")));
    }
    read_bounded(&mut file, limit, label).map_err(|error| error.at_path(path.display().to_string()))
}

pub(crate) fn read_json<T: DeserializeOwned>(path: &Path, label: &str) -> Result<T, CliError> {
    decode_json(&read_bytes(path, MAX_JSON_BYTES, label)?, label)
}

pub(crate) fn decode_json<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T, CliError> {
    serde_json::from_slice(bytes).map_err(|error| {
        invalid(format!("{label} must match its JSON input schema: {error}")).at_line(error.line())
    })
}

fn read_bounded(reader: &mut impl Read, limit: usize, label: &str) -> Result<Vec<u8>, CliError> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| invalid(error.to_string()))?;
    if bytes.len() > limit {
        return Err(invalid(format!("{label} input exceeds {limit} bytes")));
    }
    Ok(bytes)
}

fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(deny_unknown_fields)]
    struct Input {
        value: Option<String>,
    }

    #[test]
    fn decoder_rejects_unknown_fields_trailing_data_and_invalid_utf8() {
        for input in [
            b"{\"other\":1}".as_slice(),
            b"{} {}",
            b"{\"value\":\"\xff\"}",
        ] {
            assert!(decode_json::<Input>(input, "test").is_err());
        }
        assert_eq!(
            decode_json::<Input>(b"{\"value\":null}", "test").unwrap(),
            Input { value: None }
        );
    }

    #[test]
    fn bounded_input_accepts_the_limit_and_rejects_one_more_byte() {
        assert_eq!(
            read_bounded(&mut b"abc".as_slice(), 3, "test").unwrap(),
            b"abc"
        );
        assert!(read_bounded(&mut b"abcd".as_slice(), 3, "test").is_err());
    }
}
