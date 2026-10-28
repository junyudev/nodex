//! A linear reduction for literal paragraphs with isolated ASCII delimiters.

use super::{Escape, Text};
use crate::{Block, BlockKind, Colors, Inline, ReadError, ReadOptions, Style, read};

pub(super) fn minimize(
    text: &Text,
    context: &impl Fn(&str) -> String,
    reference: &Result<Vec<Block>, ReadError>,
) -> Option<String> {
    if context("x") != "x" || !context("").is_empty() {
        return None;
    }
    let plain = literal(text)?;
    let expected = vec![Block::new(BlockKind::Paragraph {
        text: vec![Inline::Text {
            text: plain.clone(),
            style: Style::default(),
        }],
        colors: Colors::default(),
    })];
    if reference.as_ref().ok() != Some(&expected) {
        return None;
    }
    if let Some(result) = flat_pairs(&plain) {
        return (read(&result, ReadOptions::EXACT).as_ref().ok() == Some(&expected))
            .then_some(result);
    }
    let body = if text.source.ends_with("<br>") {
        plain.strip_suffix('\n')?
    } else {
        &plain
    };
    if !certified(body) || read(&text.source, ReadOptions::EXACT).as_ref().ok() != Some(&expected) {
        return None;
    }

    // Prepend into a fixed allocation: neither deleting an escape nor building
    // its decided suffix moves an already written byte. All undecided offsets
    // still refer to the original, fully escaped prefix.
    let mut output = vec![0_u8; text.source.len()];
    let mut start = output.len();
    let mut cursor = text.source.len();
    let mut closers = [false; 2];
    let mut backtick = false;
    let initial_digits = text.source.bytes().take_while(u8::is_ascii_digit).count();
    for escape in text.escapes.iter().rev() {
        prepend(
            &mut output,
            &mut start,
            &text.source.as_bytes()[escape.index + escape.length..cursor],
        );
        let suffix = &output[start..];
        let raw_before = text
            .source
            .as_bytes()
            .get(escape.index.wrapping_sub(1))
            .copied();
        let raw_after = suffix.first().copied();
        let marker = escape.plain as u8;
        let (opens, closes) = flanking(marker, raw_before, raw_after);
        let emphasis = emphasis(marker);
        let keep = match marker {
            b' ' | b'\t' => suffix.is_empty() || suffix.first() == Some(&b'\n'),
            b'\\' => raw_after.is_some_and(|b| b.is_ascii_punctuation() || b == b'\n'),
            b'`' => backtick,
            b'*' | b'_' => opens && closers[emphasis.expect("emphasis")],
            // An empty attribute list is literal except at the end of the
            // paragraph, preceded by whitespace (or standing alone).
            b'{' => suffix == b"}" && matches!(raw_before, None | Some(b' ')),
            _ => false,
        };
        let keep = if block_marker(escape, initial_digits) {
            let suffix = std::str::from_utf8(suffix).expect("UTF-8 suffix");
            let candidate = format!("{}{}{suffix}", &text.source[..escape.index], escape.plain);
            read(&candidate, ReadOptions::EXACT).as_ref().ok() != Some(&expected)
        } else {
            keep
        };
        if !keep
            && let Some(index) = emphasis
            && closes
        {
            closers[index] = true;
        }
        backtick |= marker == b'`';
        if keep {
            prepend(
                &mut output,
                &mut start,
                &text.source.as_bytes()[escape.index..escape.index + escape.length],
            );
        } else {
            prepend(&mut output, &mut start, &[marker]);
        }
        cursor = escape.index;
    }
    prepend(&mut output, &mut start, &text.source.as_bytes()[..cursor]);
    let result = String::from_utf8(output.split_off(start)).expect("ASCII literal output");
    (read(&result, ReadOptions::EXACT).as_ref().ok() == Some(&expected)).then_some(result)
}

fn prepend(output: &mut [u8], start: &mut usize, bytes: &[u8]) {
    *start -= bytes.len();
    output[*start..*start + bytes.len()].copy_from_slice(bytes);
}

/// Flat, nonempty alphanumeric []/() pairs are a second closed subgrammar.
/// In the backslash seed they are disjoint LaTeX atoms. With at least two,
/// removing any one escape leaves another atom, or merges several into one;
/// no first-pass trial can equal plain text. In the reference seed, every ')',
/// '(' and ']' is removable: earlier openers are still references. A '[' is
/// retained exactly when its own close is immediately followed by '(word)',
/// which would make a link. All other retained '[' to its right are protected,
/// so no matching can cross pairs. Finally each retained reference becomes
/// '\[': there are no escaped ']' left to open LaTeX. The final edge-space
/// reference survives; this grammar has no other syntax or whitespace edges.
fn flat_pairs(plain: &str) -> Option<String> {
    let bytes = plain.as_bytes();
    if bytes
        .first()
        .is_none_or(|b| !b.is_ascii_alphanumeric() && !matches!(b, b'[' | b'('))
        || plain.ends_with("  ")
    {
        return None;
    }
    let mut index = 0;
    let mut pairs = 0;
    let mut result = String::with_capacity(plain.len());
    while index < bytes.len() {
        let byte = bytes[index];
        if matches!(byte, b'[' | b'(') {
            let start = index;
            let close = if byte == b'[' { b']' } else { b')' };
            index += 1;
            let content = index;
            while bytes.get(index).is_some_and(u8::is_ascii_alphanumeric) {
                index += 1;
            }
            if index == content || bytes.get(index) != Some(&close) {
                return None;
            }
            if byte == b'[' && bytes.get(index + 1) == Some(&b'(') {
                result.push('\\');
            }
            result.push_str(&plain[start..=index]);
            pairs += 1;
        } else if byte.is_ascii_alphanumeric() || byte == b' ' {
            if byte == b' ' && index + 1 == bytes.len() {
                result.push_str("&#32;");
            } else {
                result.push(char::from(byte));
            }
        } else {
            return None;
        }
        index += 1;
    }
    (pairs >= 2).then_some(result)
}

/// Every punctuation byte must belong to a text escape, except a final owned
/// `<br>`. This excludes wrappers, code, links, atoms, and attributes. The final
/// break has no delimiters, cannot pair with earlier syntax in this subgrammar,
/// and supplies its actual '<' punctuation flank to the reduction above.
fn literal(text: &Text) -> Option<String> {
    let mut plain = String::with_capacity(text.source.len());
    let mut cursor = 0;
    for escape in &text.escapes {
        let gap = &text.source[cursor..escape.index];
        if gap
            .bytes()
            .any(|b| b.is_ascii_punctuation() || !b.is_ascii())
        {
            return None;
        }
        plain.push_str(gap);
        plain.push(escape.plain);
        cursor = escape.index + escape.length;
    }
    let gap = &text.source[cursor..];
    let (gap, trailing_break) = gap
        .strip_suffix("<br>")
        .map_or((gap, false), |gap| (gap, true));
    if gap
        .bytes()
        .any(|b| b.is_ascii_punctuation() || !b.is_ascii())
    {
        return None;
    }
    plain.push_str(gap);
    if trailing_break {
        plain.push('\n');
    }
    Some(plain)
}

/// Certificate for a closed literal subgrammar. Empty [] cannot form a link or
/// reference; <> cannot be HTML/an autolink; {} has no content that can hide a
/// delimiter and is kept away from emphasis flanks because its lexer token is
/// not punctuation. There are no entities, emails, URL openers, or LaTeX pairs.
/// All code/emphasis runs have length one, so no run merging or rule-of-three
/// state is needed. Tildes are excluded: Comrak skips them when determining
/// neighboring flanks, so removing one could change an already-decided flank.
/// The suffix stays literal by induction. An opening emphasis mark changes it
/// iff an exposed closer exists; a backtick changes it iff another tick exists
/// (code ignores escapes). Earlier punctuation is still escaped. Removing any
/// other certified mark cannot change these states or their character classes.
/// Continuation lines begin with a word or an emphasis mark immediately before
/// a word, and never an ordered marker. They cannot open Block syntax (including
/// a table delimiter), so matching across their whitespace newline is inline
/// matching only. Block trials are confined to the first line's opening edge.
/// Uncertified input always uses the general reader oracle.
fn certified(plain: &str) -> bool {
    let bytes = plain.as_bytes();
    if !plain.is_ascii()
        || bytes.first().is_none_or(|b| b.is_ascii_whitespace())
        || plain.contains(['\r', '(', ')', '@', '&', '~'])
        || bytes
            .iter()
            .any(|b| b.is_ascii_control() && !matches!(b, b'\t' | b'\n'))
        || plain.split('\n').any(|line| {
            line.bytes()
                .rev()
                .take_while(u8::is_ascii_whitespace)
                .count()
                > 1
        })
    {
        return false;
    }
    for line in plain.split('\n').skip(1) {
        let first = line.as_bytes().first().copied();
        let second = line.as_bytes().get(1).copied();
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        if !(first.is_some_and(|b| b.is_ascii_alphanumeric())
            || matches!(first, Some(b'*' | b'_'))
                && second.is_some_and(|b| b.is_ascii_alphanumeric()))
            || digits > 0 && line.as_bytes().get(digits) == Some(&b'.')
        {
            return false;
        }
    }
    for (i, &byte) in bytes.iter().enumerate() {
        let before = i.checked_sub(1).and_then(|n| bytes.get(n)).copied();
        let after = bytes.get(i + 1).copied();
        let invalid = match byte {
            b'*' | b'_' | b'`' => before == Some(byte) || after == Some(byte),
            b'[' => after != Some(b']') || matches!(bytes.get(i + 2), Some(b'(' | b'[' | b':')),
            b']' => before != Some(b'['),
            b'<' => after != Some(b'>'),
            b'{' => {
                after != Some(b'}')
                    || before.is_some_and(|b| emphasis(b).is_some())
                    || bytes.get(i + 2).is_some_and(|b| emphasis(*b).is_some())
            }
            b'}' => before != Some(b'{'),
            b'$' => matches!(after, Some(b'$' | b'`')),
            b':' => after.is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'/' | b':')),
            b'.' => plain[..i]
                .get(i.saturating_sub(3)..)
                .is_some_and(|s| s.eq_ignore_ascii_case("www")),
            _ => false,
        };
        if invalid {
            return false;
        }
    }
    true
}

fn emphasis(marker: u8) -> Option<usize> {
    match marker {
        b'*' => Some(0),
        b'_' => Some(1),
        _ => None,
    }
}

/// ASCII CommonMark flanking (including the intraword underscore restriction).
/// The certificate excludes tokens that could change adjacent character classes.
fn flanking(marker: u8, before: Option<u8>, after: Option<u8>) -> (bool, bool) {
    let before_white = before.is_none_or(|b| b.is_ascii_whitespace());
    let after_white = after.is_none_or(|b| b.is_ascii_whitespace());
    let before_punct = before.is_some_and(|b| b.is_ascii_punctuation());
    let after_punct = after.is_some_and(|b| b.is_ascii_punctuation());
    let left = !after_white && (!after_punct || before_white || before_punct);
    let right = !before_white && (!before_punct || after_white || after_punct);
    if marker == b'_' {
        return (
            left && (!right || before_punct),
            right && (!left || after_punct),
        );
    }
    (left, right)
}

/// At most the first punctuation mark (or the dot after initial digits) can
/// open Block syntax. One full trial retains the exact Block rules at that edge.
fn block_marker(escape: &Escape, initial_digits: usize) -> bool {
    if escape.index == 0 && matches!(escape.plain, '*' | '_' | '~' | '>' | '-' | '+' | '#' | '=') {
        return true;
    }
    escape.plain == '.' && initial_digits > 0 && escape.index == initial_digits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certified_literals_match_exhaustive_reduction() {
        let atoms = [
            "word", "a", "0", " ", "\t", "\nword", "\n*a*", "*", "_", "~", "`", "[]", "<>", "{}",
            "$", ":", "\\", ",", "/", "-", ">", "#", ".", "!", "+", "=",
        ];
        let mut random = 0x7e01_c390_d217_5aa9_u64;
        let mut checked = 0;
        for index in 0..12_000 {
            let mut value = String::from("text ");
            for _ in 0..index % 32 + 1 {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                value.push_str(atoms[random as usize % atoms.len()]);
            }
            if !certified(&value) {
                continue;
            }
            let expected = vec![Block::new(BlockKind::Paragraph {
                text: vec![Inline::Text {
                    text: value.clone(),
                    style: Style::default(),
                }],
                colors: Colors::default(),
            })];
            let encoded = Text::escaped(&value);
            let reference = encoded
                .clone()
                .minimize(str::to_owned, false, Some(expected.clone()));
            assert_eq!(
                minimize(&encoded, &str::to_owned, &Ok(expected)),
                Some(reference),
                "{value:?}"
            );
            checked += 1;
            if checked == 2000 {
                break;
            }
        }
        assert_eq!(checked, 2000);
        for value in [
            "*_[]<>$:{}\\` ".repeat(5),
            "1. item".into(),
            "# title".into(),
            "* item".into(),
            "x {}".into(),
            "{}".into(),
            "x {} ".into(),
            "*a*\n".repeat(8).trim_end_matches('\n').to_owned(),
            "text\\\nwords *a*".into(),
        ] {
            let encoded = Text::escaped(&value);
            let expected = vec![Block::new(BlockKind::Paragraph {
                text: vec![Inline::Text {
                    text: value.clone(),
                    style: Style::default(),
                }],
                colors: Colors::default(),
            })];
            let reference = encoded
                .clone()
                .minimize(str::to_owned, false, Some(expected.clone()));
            assert_eq!(
                minimize(&encoded, &str::to_owned, &Ok(expected)),
                Some(reference),
                "{value:?}"
            );
        }
    }

    #[test]
    fn final_owned_break_matches_exhaustive_reduction() {
        use crate::write::inline::{self, Position};
        let values = [
            "*a*\n".repeat(10),
            "text *`[]<>${}\\\nword _a_\n".into(),
            "text \n".into(),
            "text\\\n".into(),
            "a*_\nword_*\n".into(),
            "text\n*word* \n".into(),
        ];
        for value in values {
            let items = vec![Inline::Text {
                text: value.clone(),
                style: Style::default(),
            }];
            let expected = vec![Block::new(BlockKind::Paragraph {
                text: items.clone(),
                colors: Colors::default(),
            })];
            let encoded = inline::text(&items, Position::Text);
            let reference = encoded
                .clone()
                .minimize(str::to_owned, false, Some(expected.clone()));
            assert_eq!(
                minimize(&encoded, &str::to_owned, &Ok(expected)),
                Some(reference),
                "{value:?}"
            );
        }
    }

    #[test]
    fn flat_pairs_match_exhaustive_reduction() {
        let units = [
            "[text](url)",
            "(word)",
            "[word]",
            "(a)[b]",
            "[a][b](c)",
            "text(a)word[b]",
        ];
        for case in 0..180 {
            let mut value = String::new();
            for pair in 0..case % 7 + 2 {
                value.push_str(units[(case + pair * 5) % units.len()]);
                if case % 2 == 0 {
                    value.push(' ');
                }
            }
            let expected = vec![Block::new(BlockKind::Paragraph {
                text: vec![Inline::Text {
                    text: value.clone(),
                    style: Style::default(),
                }],
                colors: Colors::default(),
            })];
            let encoded = Text::escaped(&value);
            let reference = encoded
                .clone()
                .minimize(str::to_owned, false, Some(expected.clone()));
            assert_eq!(
                minimize(&encoded, &str::to_owned, &Ok(expected)),
                Some(reference),
                "{value:?}"
            );
        }
    }
}
