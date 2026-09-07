use crate::error::{CliError, CliErrorCode};

pub const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PATCH_HUNKS: usize = 1_024;
pub const MAX_PATCH_LINES: usize = 100_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PatchDocument {
    pub page_id: String,
    pub hunks: Vec<PatchHunk>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PatchHunk {
    pub index: usize,
    pub input_line: usize,
    pub old_fragment: String,
    pub new_fragment: String,
}

pub fn parse(input: &[u8]) -> Result<PatchDocument, CliError> {
    if input.len() > MAX_PATCH_BYTES {
        return Err(CliError::new(
            CliErrorCode::PatchInvalid,
            format!("patch exceeds the {MAX_PATCH_BYTES}-byte limit"),
        ));
    }
    let input = std::str::from_utf8(input)
        .map_err(|_| CliError::new(CliErrorCode::PatchSyntax, "patch must be valid UTF-8"))?;
    if input.contains('\r') {
        return Err(CliError::new(
            CliErrorCode::PatchSyntax,
            "patch must use LF line endings",
        ));
    }

    let lines = split_lines(input)?;
    if lines.len() > MAX_PATCH_LINES {
        return Err(CliError::new(
            CliErrorCode::PatchInvalid,
            format!("patch exceeds the {MAX_PATCH_LINES}-line limit"),
        ));
    }
    if lines.first().map(|line| line.text) != Some("*** Begin Patch") {
        return Err(syntax("expected '*** Begin Patch'", 1));
    }
    let update = lines
        .get(1)
        .ok_or_else(|| syntax("expected Page update header", 2))?;
    let page_id = update
        .text
        .strip_prefix("*** Update Page: ")
        .filter(|value| valid_page_id(value))
        .ok_or_else(|| syntax("expected '*** Update Page: <page-id>'", 2))?
        .to_owned();

    let mut cursor = 2;
    let mut hunks = Vec::new();
    while cursor < lines.len() && lines[cursor].text != "*** End Patch" {
        let header = &lines[cursor];
        if header.text != "@@" {
            return Err(syntax("expected '@@' hunk header", header.number));
        }
        if hunks.len() == MAX_PATCH_HUNKS {
            return Err(CliError::new(
                CliErrorCode::PatchInvalid,
                format!("patch exceeds the {MAX_PATCH_HUNKS}-hunk limit"),
            ));
        }
        let hunk_index = hunks.len() + 1;
        cursor += 1;
        let input_line = lines
            .get(cursor)
            .map_or(header.number + 1, |line| line.number);
        let mut old_fragment = String::new();
        let mut new_fragment = String::new();
        let mut changed = false;
        let mut saw_line = false;
        while cursor < lines.len() {
            let line = &lines[cursor];
            if line.text == "@@" || line.text == "*** End Patch" {
                break;
            }
            let (marker, content) = line.text.split_at_checked(1).ok_or_else(|| {
                syntax(
                    "every hunk line requires a space, '+' or '-' marker",
                    line.number,
                )
                .in_hunk(hunk_index)
            })?;
            match marker {
                " " => {
                    old_fragment.push_str(content);
                    old_fragment.push('\n');
                    new_fragment.push_str(content);
                    new_fragment.push('\n');
                }
                "-" => {
                    old_fragment.push_str(content);
                    old_fragment.push('\n');
                    changed = true;
                }
                "+" => {
                    new_fragment.push_str(content);
                    new_fragment.push('\n');
                    changed = true;
                }
                _ => {
                    return Err(syntax(
                        "every hunk line requires a space, '+' or '-' marker",
                        line.number,
                    )
                    .in_hunk(hunk_index));
                }
            }
            saw_line = true;
            cursor += 1;
        }
        if !saw_line {
            return Err(
                syntax("hunk must contain at least one line", input_line).in_hunk(hunk_index)
            );
        }
        if !changed {
            return Err(CliError::new(
                CliErrorCode::PatchInvalid,
                "hunk must contain an addition or removal",
            )
            .at_line(input_line)
            .in_hunk(hunk_index));
        }
        if old_fragment.is_empty() {
            return Err(CliError::new(
                CliErrorCode::PatchInvalid,
                "hunk old fragment must be non-empty; use 'page insert' for insertion",
            )
            .at_line(input_line)
            .in_hunk(hunk_index));
        }
        hunks.push(PatchHunk {
            index: hunk_index,
            input_line,
            old_fragment,
            new_fragment,
        });
    }

    if hunks.is_empty() {
        return Err(syntax("Page update requires at least one hunk", 3));
    }
    let Some(end) = lines.get(cursor) else {
        return Err(syntax("expected '*** End Patch'", lines.len() + 1));
    };
    if end.text != "*** End Patch" {
        return Err(syntax("expected '*** End Patch'", end.number));
    }
    if cursor + 1 != lines.len() {
        return Err(syntax(
            "unexpected content after '*** End Patch'",
            end.number + 1,
        ));
    }

    Ok(PatchDocument { page_id, hunks })
}

pub fn preflight(document: &PatchDocument, canonical_body: &str) -> Result<(), CliError> {
    let mut spans = Vec::with_capacity(document.hunks.len());
    for hunk in &document.hunks {
        let starts = overlapping_match_starts(canonical_body, &hunk.old_fragment);
        if starts.is_empty() {
            return Err(CliError::new(
                CliErrorCode::PatchNotFound,
                format!(
                    "hunk {} does not occur in the current Page; inspect it with `nodex read {}`",
                    hunk.index, document.page_id
                ),
            )
            .at_line(hunk.input_line)
            .in_hunk(hunk.index));
        }
        if starts.len() > 1 {
            let lines = starts
                .iter()
                .take(8)
                .map(|start| line_number(canonical_body, *start))
                .collect::<Vec<_>>();
            let commands = lines
                .iter()
                .map(|line| format!("nodex sed -n '{line}p' {}", document.page_id))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(CliError::new(
                CliErrorCode::PatchAmbiguous,
                format!(
                    "hunk {} occurs {} times near lines {}; add unchanged context ({commands})",
                    hunk.index,
                    starts.len(),
                    lines
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
            .at_line(hunk.input_line)
            .in_hunk(hunk.index));
        }
        spans.push((starts[0], starts[0] + hunk.old_fragment.len(), hunk));
    }
    spans.sort_by_key(|(start, end, _)| (*start, *end));
    for pair in spans.windows(2) {
        let [
            (previous_start, previous_end, previous),
            (current_start, _, current),
        ] = pair
        else {
            unreachable!();
        };
        if current_start >= previous_end {
            continue;
        }
        return Err(CliError::new(
            CliErrorCode::PatchOverlap,
            format!(
                "hunks {} and {} overlap at body byte {}",
                previous.index,
                current.index,
                previous_start.max(current_start)
            ),
        )
        .at_line(current.input_line)
        .in_hunk(current.index));
    }
    Ok(())
}

fn overlapping_match_starts(source: &str, needle: &str) -> Vec<usize> {
    let needle = needle.as_bytes();
    if needle.is_empty() || needle.len() > source.len() {
        return Vec::new();
    }
    source
        .as_bytes()
        .windows(needle.len())
        .enumerate()
        .filter_map(|(start, candidate)| (candidate == needle).then_some(start))
        .collect()
}

fn line_number(source: &str, byte_offset: usize) -> u32 {
    source.as_bytes()[..byte_offset]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        .saturating_add(1)
        .try_into()
        .unwrap_or(u32::MAX)
}

#[derive(Clone, Copy)]
struct InputLine<'a> {
    number: usize,
    text: &'a str,
}

fn split_lines(input: &str) -> Result<Vec<InputLine<'_>>, CliError> {
    if input.is_empty() {
        return Err(syntax("expected '*** Begin Patch'", 1));
    }
    let mut lines = Vec::new();
    let mut remainder = input;
    let mut number = 1;
    while let Some(newline) = remainder.find('\n') {
        lines.push(InputLine {
            number,
            text: &remainder[..newline],
        });
        remainder = &remainder[newline + 1..];
        number += 1;
    }
    if !remainder.is_empty() {
        lines.push(InputLine {
            number,
            text: remainder,
        });
    }
    if lines
        .last()
        .is_some_and(|line| line.text != "*** End Patch" && !input.ends_with('\n'))
    {
        return Err(syntax(
            "patch content lines must end with LF",
            lines.last().map_or(1, |line| line.number),
        ));
    }
    Ok(lines)
}

fn valid_page_id(value: &str) -> bool {
    let id = value.strip_prefix('@').unwrap_or(value);
    !id.is_empty()
        && id.len() <= 512
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn syntax(message: impl Into<String>, line: usize) -> CliError {
    CliError::new(CliErrorCode::PatchSyntax, message).at_line(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_documented_patch_into_simultaneous_exact_fragments() {
        let document = parse(
            b"*** Begin Patch\n*** Update Page: @01J_PAGE\n@@\n ## Runtime\n-Core starts when the UI opens.\n+Core starts on demand.\n It remains the only SQLite owner.\n*** End Patch\n",
        )
        .expect("valid patch");

        assert_eq!(document.page_id, "@01J_PAGE");
        assert_eq!(document.hunks.len(), 1);
        assert_eq!(document.hunks[0].input_line, 4);
        assert_eq!(
            document.hunks[0].old_fragment,
            "## Runtime\nCore starts when the UI opens.\nIt remains the only SQLite owner.\n"
        );
        assert_eq!(
            document.hunks[0].new_fragment,
            "## Runtime\nCore starts on demand.\nIt remains the only SQLite owner.\n"
        );
    }

    #[test]
    fn rejects_context_free_insert_with_repair_guidance() {
        let error =
            parse(b"*** Begin Patch\n*** Update Page: @page\n@@\n+new line\n*** End Patch\n")
                .expect_err("pure insertion must use page insert");

        assert_eq!(error.code, CliErrorCode::PatchInvalid);
        assert_eq!(error.line, Some(4));
        assert_eq!(error.hunk, Some(1));
        assert!(error.message.contains("page insert"));
    }

    #[test]
    fn rejects_crlf_and_missing_change_markers() {
        let crlf = parse(b"*** Begin Patch\r\n").expect_err("CRLF must fail");
        assert_eq!(crlf.code, CliErrorCode::PatchSyntax);

        let marker =
            parse(b"*** Begin Patch\n*** Update Page: @page\n@@\nunmarked\n*** End Patch\n")
                .expect_err("unmarked content must fail");
        assert_eq!(marker.line, Some(4));
        assert_eq!(marker.hunk, Some(1));
    }

    #[test]
    fn permits_end_marker_without_final_newline() {
        let document =
            parse(b"*** Begin Patch\n*** Update Page: @page\n@@\n-old\n+new\n*** End Patch")
                .expect("optional final LF");
        assert_eq!(document.hunks[0].old_fragment, "old\n");
        assert_eq!(document.hunks[0].new_fragment, "new\n");
    }

    #[test]
    fn preflight_reports_exact_missing_ambiguous_and_overlapping_hunks() {
        let missing =
            parse(b"*** Begin Patch\n*** Update Page: @page\n@@\n-missing\n+new\n*** End Patch\n")
                .unwrap();
        let error = preflight(&missing, "present\n").expect_err("missing fragment");
        assert_eq!(error.code, CliErrorCode::PatchNotFound);
        assert_eq!(error.hunk, Some(1));

        let ambiguous =
            parse(b"*** Begin Patch\n*** Update Page: @page\n@@\n-same\n+new\n*** End Patch\n")
                .unwrap();
        let error = preflight(&ambiguous, "same\nother\nsame\n").expect_err("ambiguous fragment");
        assert_eq!(error.code, CliErrorCode::PatchAmbiguous);
        assert!(error.message.contains("lines 1, 3"));

        let overlapping = parse(
            b"*** Begin Patch\n*** Update Page: @page\n@@\n-a\n+A\n b\n@@\n-b\n+B\n c\n*** End Patch\n",
        )
        .unwrap();
        let error = preflight(&overlapping, "a\nb\nc\n").expect_err("overlapping hunks");
        assert_eq!(error.code, CliErrorCode::PatchOverlap);
        assert_eq!(error.hunk, Some(2));
    }
}
