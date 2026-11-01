//! Independent reading and single-escape necessity checks over reproducible text samples.

use crate::{Block, BlockKind, Colors, Inline, PortableOptions, ReadOptions, Style, read, write};
use std::time::Instant;

fn paragraph(text: String) -> Vec<Block> {
    vec![Block::new(BlockKind::Paragraph {
        text: vec![Inline::Text {
            text,
            style: Style::default(),
        }],
        colors: Colors::default(),
    })]
}

/// Scan the finished spelling, independently of the writer's escape bookkeeping.
fn removals(source: &str) -> Vec<(std::ops::Range<usize>, char)> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let rest = &source[cursor..];
        if let Some(character) = rest.strip_prefix('\\').and_then(|s| s.chars().next())
            && character.is_ascii_punctuation()
        {
            result.push((cursor..cursor + 2, character));
            cursor += 2;
            continue;
        }
        if let Some(number) = rest.strip_prefix("&#").and_then(|s| s.split_once(';')) {
            let parsed = number
                .0
                .strip_prefix(['x', 'X'])
                .map_or_else(
                    || number.0.parse::<u32>().ok(),
                    |hex| u32::from_str_radix(hex, 16).ok(),
                )
                .and_then(char::from_u32);
            if let Some(character) = parsed {
                let end = cursor + number.0.len() + 3;
                result.push((cursor..end, character));
                cursor = end;
                continue;
            }
        }
        cursor += rest.chars().next().expect("character").len_utf8();
    }
    result
}

fn assert_minimal(output: &str, options: ReadOptions, label: &str) -> usize {
    let reading = read(output, options).expect("written text reads");
    let escapes = removals(output);
    for (range, plain) in &escapes {
        let mut candidate = output.to_owned();
        candidate.replace_range(range.clone(), &plain.to_string());
        assert_ne!(
            read(&candidate, options).as_deref(),
            Ok(reading.as_slice()),
            "unnecessary escape in {label}: {output:?} -> {candidate:?}"
        );
    }
    // Match decoded bracket characters in the complete line, including ordinary syntax
    // brackets. Only a pair whose two endpoints are escaped is a joint-removal candidate.
    let mut brackets = Vec::new();
    let mut cursor = 0;
    while cursor < output.len() {
        let escape = escapes.iter().position(|(range, _)| range.start == cursor);
        let (character, end) = escape.map_or_else(
            || {
                let character = output[cursor..].chars().next().unwrap();
                (character, cursor + character.len_utf8())
            },
            |index| (escapes[index].1, escapes[index].0.end),
        );
        match character {
            '\n' => brackets.clear(),
            '[' => brackets.push(escape),
            ']' => {
                if let Some(Some(open)) = brackets.pop()
                    && let Some(close) = escape
                {
                    let mut candidate = output.to_owned();
                    for index in [close, open] {
                        candidate
                            .replace_range(escapes[index].0.clone(), &escapes[index].1.to_string());
                    }
                    assert_ne!(
                        read(&candidate, options).as_deref(),
                        Ok(reading.as_slice()),
                        "jointly unnecessary bracket pair in {label}: {output:?} -> {candidate:?}"
                    );
                }
            }
            _ => {}
        }
        cursor = end;
    }
    escapes.len()
}

fn check(blocks: &[Block], label: &str) -> usize {
    let output = write(blocks);
    assert_eq!(
        read(&output, ReadOptions::EXACT).as_deref(),
        Ok(blocks),
        "{label}: {output:?}"
    );
    let mut escapes = assert_minimal(&output, ReadOptions::EXACT, label);
    let mut checked = vec![output];
    for line_breaks in [crate::LineBreaks::Comment, crate::LineBreaks::Document] {
        let portable = crate::write_portable(
            blocks,
            &PortableOptions {
                line_breaks,
                ..PortableOptions::default()
            },
        );
        let options = if line_breaks == crate::LineBreaks::Document {
            ReadOptions::DOCUMENT
        } else {
            ReadOptions::BOUNDARY
        };
        let restored = read(&portable.markdown, options).expect("portable output reads");
        if portable.exact {
            assert_eq!(
                restored, blocks,
                "portable {label}: {:?}",
                portable.markdown
            );
        }
        // Identical spellings have the same exact reading and removal candidates. Keep both
        // portable readability/exactness checks, but do not repeat an identical minimality proof.
        if !checked.contains(&portable.markdown) {
            escapes += assert_minimal(
                &portable.markdown,
                ReadOptions::EXACT,
                &format!("portable {line_breaks:?} {label}"),
            );
            checked.push(portable.markdown);
        }
    }
    escapes
}

#[test]
fn written_text_round_trips_and_every_remaining_escape_is_necessary() {
    let start = Instant::now();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/cases.json")).unwrap();
    let mut samples = 0;
    let mut escapes = 0;
    for case in fixture["cases"].as_array().unwrap() {
        escapes += check(
            &crate::blocks_from_json(&case["blocks"]).unwrap(),
            case["name"].as_str().unwrap(),
        );
        samples += 1;
    }
    let regressions: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/portable-cases.json")).unwrap();
    for case in regressions.as_array().unwrap() {
        let blocks = crate::blocks_from_json(&case["blocks"]).unwrap();
        escapes += check(&blocks, case["name"].as_str().unwrap());
        samples += 1;
    }
    // One bounded, deterministic window from each corpus file keeps ordinary cargo test fast.
    // The full corpus/fast-path equivalence and size budgets remain separate release gates.
    for (index, path) in super::performance::corpus().into_iter().enumerate() {
        let source = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = source
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let window = lines[index % lines.len()]
            .chars()
            .take(160)
            .collect::<String>();
        escapes += check(&paragraph(window), &path.display().to_string());
        samples += 1;
    }
    let atoms = [
        "[\na\n]\n[\nb\n]",
        "a (b) c.",
        "[a@b.com",
        "(a) b (c) d.",
        "[a](b)",
        "[x]",
        "(y, z)",
        "*_`$#|->+\\!\"%&'(),./:;=?@[]^{}~",
        "*emphasis*",
        "_d_",
        "**bold**",
        "`code`",
        "&amp; &#x20; & text",
        "https://example.com/a_(b)?x=1&y=2",
        "www.example.com",
        "a.b+tag@example.com",
        "\n1. item",
        "\n- item",
        "\n# title",
        "\n> quote",
        "\nword",
        " ",
        "\t",
        "中文，知乎。",
        "\\(x\\)",
        "\\[x\\]",
        "\n\\[\nx\n\\]",
    ];
    let mut random = 0x53bc_72f1_82ad_e069_u64;
    for case in 0..400 {
        let mut value = String::new();
        for _ in 0..case % 9 + 1 {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            value.push_str(atoms[random as usize % atoms.len()]);
        }
        if case % 10 == 0 {
            let json = serde_json::json!([
                {"type":"paragraph","props":{"textColor":"red"},"content":[
                    {"type":"text","text":"Before "},
                    {"type":"text","text":value,"styles":{"italic":true,"underline":true,"backgroundColor":"blue"}},
                    {"type":"text","text":" \u{a0}\t","styles":{"bold":true}},
                    {"type":"text","text":" after, and punctuation!"},
                    {"type":"pageMention","props":{"targetPageId":"page-1"}}
                ]},
                {"type":"toggleListItem","content":[{"type":"text","text":"[x] y"}],"children":[
                    {"type":"paragraph","content":[{"type":"text","text":"child, with punctuation!","styles":{"underline":true}}]}
                ]},
                {"type":"prompt","props":{"sentSessionId":"session-1","sentAt":"2026-10-31T08:30:00.000Z","sentMessageId":"message-1"},"content":[{"type":"text","text":"Prompt, with punctuation!"}]}
            ]);
            escapes += check(
                &crate::blocks_from_json(&json).unwrap(),
                &format!("lossy generated {case}"),
            );
            samples += 1;
        }
        escapes += check(&paragraph(value), &format!("generated {case}"));
        samples += 1;
    }
    eprintln!(
        "minimality: {samples} samples, {escapes} escape removals in {:?}",
        start.elapsed()
    );
}
