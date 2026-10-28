//! Writer contracts exercise content and source ownership, rather than syntax internals.

use crate::{
    Block, BlockKind, Colors, Inline, PortableOptions, ReadOptions, Style, blocks_from_json, read,
    write, write_inline, write_located, write_portable,
};
use serde_json::{Value, json};

fn fixture() -> Vec<(String, String, Vec<Block>)> {
    let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/cases.json"))
        .expect("fixture JSON");
    fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| {
            (
                case["name"].as_str().expect("name").to_owned(),
                case["markdown"].as_str().expect("markdown").to_owned(),
                blocks_from_json(&case["blocks"]).expect("fixture Blocks"),
            )
        })
        .collect()
}

fn text(value: &str) -> Vec<Inline> {
    vec![Inline::Text {
        text: value.to_owned(),
        style: Style::default(),
    }]
}

fn paragraph(value: &str) -> Block {
    Block::new(BlockKind::Paragraph {
        text: text(value),
        colors: Colors::default(),
    })
}

#[test]
fn fixture_writes_round_trip_and_own_their_lines() {
    for (name, expected, blocks) in fixture() {
        let (markdown, locations) = write_located(&blocks);
        assert_eq!(markdown, expected, "{name}");
        assert_eq!(write(&blocks), markdown, "{name}");
        let located = crate::read_located(&markdown, ReadOptions::EXACT).expect(&name);
        assert_eq!(
            located.locations, locations,
            "{name}: reader and writer ownership"
        );
        assert_eq!(
            read(&markdown, ReadOptions::EXACT).expect(&name),
            blocks,
            "{name}"
        );
        fn count(blocks: &[Block]) -> usize {
            blocks.iter().map(|block| 1 + count(&block.children)).sum()
        }
        assert_eq!(locations.len(), count(&blocks), "{name}");
        let mut owners = vec![0_u8; markdown.len()];
        for location in &locations {
            let mut previous = 0;
            for span in &location.spans {
                assert!(
                    span.start >= previous && span.start < span.end,
                    "{name}: ordered ranges"
                );
                assert!(markdown.get(span.clone()).is_some(), "{name}: UTF-8 ranges");
                assert!(
                    span.start == 0 || markdown.as_bytes()[span.start - 1] == b'\n',
                    "{name}: complete line start"
                );
                assert!(
                    span.end == markdown.len() || markdown.as_bytes()[span.end - 1] == b'\n',
                    "{name}: complete line end"
                );
                for owner in &mut owners[span.clone()] {
                    *owner += 1;
                }
                previous = span.end;
            }
        }
        let mut offset = 0;
        for line in markdown.split_inclusive('\n') {
            let ownership = &owners[offset..offset + line.len()];
            assert!(
                ownership.iter().all(|count| *count <= 1),
                "{name}: no overlap"
            );
            let content = line.trim();
            if !content.is_empty() && content != ">" {
                assert!(
                    ownership.iter().all(|count| *count == 1),
                    "{name}: {line:?} has one owner"
                );
            }
            offset += line.len();
        }
    }
}

#[test]
fn containers_own_their_fences_and_children_own_their_lines() {
    let blocks = vec![Block::with_children(
        BlockKind::Toggle {
            text: text("外层"),
            colors: Colors::default(),
        },
        vec![Block::with_children(
            BlockKind::Quote {
                text: text("Inner"),
                colors: Colors::default(),
            },
            vec![Block::new(BlockKind::Code {
                language: "text".into(),
                code: "😀\n\ncode".into(),
            })],
        )],
    )];
    let (markdown, locations) = write_located(&blocks);
    let owned = locations
        .iter()
        .map(|location| {
            location
                .spans
                .iter()
                .map(|span| &markdown[span.clone()])
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        owned,
        vec![
            vec![":::toggle[外层]\n", ":::"],
            vec!["  > Inner\n"],
            vec!["  > ```\n  > 😀\n  >\n  > code\n  > ```\n"]
        ]
    );
}

#[test]
fn punctuation_heavy_text_round_trips_in_each_block_position() {
    let alphabet = b"ab *_[]()<>#-+.!|{}:$`\\\t";
    let mut random = 0x8d31_4a29_u64;
    for index in 0..320 {
        let mut value = String::new();
        for _ in 0..(index % 40 + 1) {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            value.push(char::from(alphabet[random as usize % alphabet.len()]));
        }
        let kinds = [
            BlockKind::Paragraph {
                text: text(&value),
                colors: Colors::default(),
            },
            BlockKind::Heading {
                level: 2,
                toggleable: false,
                text: text(&value),
                colors: Colors::default(),
            },
            BlockKind::Bullet {
                text: text(&value),
                colors: Colors::default(),
            },
            BlockKind::Quote {
                text: text(&value),
                colors: Colors::default(),
            },
            BlockKind::Toggle {
                text: text(&value),
                colors: Colors::default(),
            },
        ];
        for kind in kinds {
            let blocks = vec![Block::new(kind)];
            let markdown = write(&blocks);
            assert_eq!(
                read(&markdown, ReadOptions::EXACT).expect(&markdown),
                blocks,
                "{value:?} -> {markdown:?}"
            );
        }
        let items = text(&value);
        let label = write_inline(&items);
        assert!(!label.contains('\n'));
        assert_eq!(
            crate::read_inline(&label, ReadOptions::EXACT).expect(&label),
            items
        );
        let read = read(&format!(":::paragraph[{label}]\n:::"), ReadOptions::EXACT).expect(&label);
        assert_eq!(
            read[0].text(),
            Some(items.as_slice()),
            "{value:?} -> {label:?}"
        );
    }
}

#[test]
fn portable_text_uses_the_current_export_forms() {
    for (input, expected) in [
        (
            "snake_case_word, #5 and [draft or a & b",
            "snake_case_word, #5 and [draft or a & b",
        ),
        (
            "see https://example.com/a and 看https://example.com。",
            "see https://example.com/a and 看https://example.com。",
        ),
        (
            "\\- stays text\n1\\. stays text\n\\*not emphasis*",
            "\\- stays text\n1\\. stays text\n\\*not emphasis*",
        ),
        ("* one\n+ two\n\n1) first", "- one\n- two\n\n1. first"),
        ("first\nsecond", "first\nsecond"),
        (
            "> [!TIP]\n> Use **tabs**\n> - or spaces",
            "> [!TIP]\n> Use **tabs**\n> - or spaces",
        ),
    ] {
        let blocks = read(input, ReadOptions::EXACT).expect(input);
        let portable = write_portable(&blocks, &PortableOptions::default());
        assert_eq!(portable.markdown, expected, "{input}");
        assert!(portable.exact, "{input}");
    }
}

#[test]
fn portable_extensions_become_outlines_links_and_plain_text() {
    let blocks = blocks_from_json(&json!([
        {"type":"paragraph","content":[{"type":"text","text":"underlined","styles":{"underline":true}},{"type":"text","text":" and "},{"type":"text","text":"red","styles":{"textColor":"red"}}]},
        {"type":"toggleListItem","content":[{"type":"text","text":"Toggle title"}],"children":[{"type":"paragraph","content":[{"type":"text","text":"Inside the toggle"}]}]},
        {"type":"paragraph","content":[{"type":"pageMention","props":{"targetPageId":"page-1"}}]},
        {"type":"image","props":{"url":"nodex://files/f","caption":"Shot","previewWidth":320}}
    ])).expect("Blocks");
    let title = |page: &str| (page == "page-1").then(|| "Roadmap".to_owned());
    let portable = write_portable(
        &blocks,
        &PortableOptions {
            page_title: Some(&title),
            ..PortableOptions::default()
        },
    );
    assert_eq!(
        portable.markdown,
        "underlined and red\n- Toggle title\n  - Inside the toggle\n\n[Roadmap](nodex://pages/page-1)\n\n![Shot](nodex://files/f)"
    );
    assert!(!portable.exact);
}

#[test]
fn portable_document_breaks_are_explicit() {
    let portable = write_portable(
        &[paragraph("first\nsecond")],
        &PortableOptions {
            line_breaks: crate::LineBreaks::Document,
            ..PortableOptions::default()
        },
    );
    assert_eq!(portable.markdown, "first\\\nsecond");
    assert!(portable.exact);
}

#[test]
fn styled_punctuation_and_literal_spelling_round_trip() {
    let values = [
        "*a*",
        "[x](url)",
        "(a) [b]",
        "Note:",
        ":b",
        " a ",
        "&amp;",
        "<br>",
        "\\(x\\)",
        "[a] [b]",
        "**",
        "😀注意：",
    ];
    for value in values {
        for bits in 0..16 {
            let style = Style {
                bold: bits & 1 != 0,
                italic: bits & 2 != 0,
                strike: bits & 4 != 0,
                underline: bits & 8 != 0,
                ..Style::default()
            };
            let items = vec![
                Inline::Text {
                    text: "before".into(),
                    style: Style::default(),
                },
                Inline::Text {
                    text: value.into(),
                    style,
                },
                Inline::Text {
                    text: "after".into(),
                    style: Style::default(),
                },
            ];
            let mut blocks = vec![Block::new(BlockKind::Paragraph {
                text: items,
                colors: Colors::default(),
            })];
            crate::normalize_blocks(&mut blocks);
            let markdown = write(&blocks);
            assert_eq!(
                read(&markdown, ReadOptions::EXACT).expect(&markdown),
                blocks,
                "{value:?}, styles {bits}: {markdown}"
            );
        }
    }
}

#[test]
fn nested_paragraphs_keep_their_leading_space() {
    let t = |text: &str| json!({"type":"text","text":text,"styles":{}});
    for (parent, expected) in [
        ("bulletListItem", "- parent\n\n  &#x20;what? (note)"),
        (
            "toggleListItem",
            ":::toggle[parent]\n  &#x20;what? (note)\n:::",
        ),
        (
            "paragraph",
            ":::paragraph[parent]\n  &#x20;what? (note)\n:::",
        ),
    ] {
        let blocks = blocks_from_json(&json!([{
            "type":parent,"content":[t("parent")],
            "children":[{"type":"paragraph","content":[t(" what? (note)")]}]
        }]))
        .unwrap();
        let markdown = super::escapes::performance::with_exhaustive(|| write(&blocks));
        assert_eq!(
            read(&markdown, ReadOptions::EXACT),
            Ok(blocks),
            "{parent}: {markdown}"
        );
        assert_eq!(markdown, expected);
    }
}

#[test]
fn styled_edge_spaces_before_atoms_keep_their_style() {
    let t = |text: &str, styles: Value| json!({"type":"text","text":text,"styles":styles});
    for atom in [
        json!({"type":"dateMention","props":{"start":"2026-10-25","format":"relative"}}),
        json!({"type":"pageMention","props":{"targetPageId":"page-1"}}),
        json!({"type":"attachment","props":{"kind":"file","source":"nodex://files/file-1","name":"notes.txt"}}),
        json!({"type":"math","content":"x"}),
    ] {
        for parent in ["paragraph", "toggleListItem"] {
            let mut value = json!({"type":parent,"content":[
                t("0.00 ", json!({"bold":true})), atom,
                t(" ", json!({})), t("- review0.", json!({"bold":true}))
            ]});
            if parent == "toggleListItem" {
                value["children"] = json!([{"type":"paragraph","content":[t("body", json!({}))]}]);
            }
            let blocks = blocks_from_json(&json!([value])).unwrap();
            let markdown = super::escapes::performance::with_exhaustive(|| write(&blocks));
            assert_eq!(
                read(&markdown, ReadOptions::EXACT),
                Ok(blocks),
                "{parent}, {atom}: {markdown}"
            );
        }
    }
}

#[test]
fn bare_url_links_keep_adjacent_punctuation_outside_the_link() {
    let t = |text: &str| json!({"type":"text","text":text,"styles":{}});
    let url = "https://example.com/a-b";
    for (before, after, expected) in [
        ("see (", ").", Some(format!("see ({url})."))),
        ("见（", "）。", Some(format!("见（{url}）。"))),
    ]
    .into_iter()
    .chain(
        [
            ")",
            ".",
            ",",
            ";",
            "?",
            "!",
            ":",
            "*",
            "_",
            "~",
            "'",
            "\"",
            "&copy;",
            "&unknown;",
            "&#41;",
            "&#x29;",
            ").",
            ",;",
            "?!",
            "*_",
            "&copy;.",
        ]
        .into_iter()
        .flat_map(|mark| [("see ", mark, None), (mark, " end", None)]),
    ) {
        for parent in ["paragraph", "toggleListItem"] {
            let blocks = blocks_from_json(&json!([{"type":parent,"content":[
                t(before), {"type":"link","href":url,"content":[t(url)]}, t(after)
            ]}]))
            .unwrap();
            let markdown = super::escapes::performance::with_exhaustive(|| write(&blocks));
            assert_eq!(
                read(&markdown, ReadOptions::EXACT),
                Ok(blocks),
                "{parent}, {before:?}, {after:?}: {markdown}"
            );
            if let Some(expected) = &expected {
                let expected = if parent == "paragraph" {
                    expected.clone()
                } else {
                    format!(":::toggle[{expected}]\n:::")
                };
                assert_eq!(markdown, expected);
            }
        }
    }
}

#[test]
fn inline_images_keep_literal_captions_and_links() {
    let items = vec![Inline::Image(crate::InlineImage {
        url: "https://example.com/a(b".into(),
        alt: "Step *1* |10".into(),
        width: Some(480),
        href: Some("https://example.com/my page".into()),
    })];
    let blocks = vec![Block::new(BlockKind::Paragraph {
        text: items.clone(),
        colors: Colors::default(),
    })];
    let markdown = write(&blocks);
    assert_eq!(
        read(&markdown, ReadOptions::EXACT).expect(&markdown),
        blocks
    );
    let label = write_inline(&items);
    assert_eq!(
        crate::read_inline(&label, ReadOptions::EXACT).expect(&label),
        items
    );
}

#[test]
fn table_literals_keep_pipes_and_line_breaks() {
    let table = crate::Table {
        header_row: true,
        rows: vec![
            vec![crate::Cell {
                text: vec![Inline::Text {
                    text: "a|b".into(),
                    style: Style {
                        code: true,
                        ..Style::default()
                    },
                }],
                ..crate::Cell::default()
            }],
            vec![crate::Cell {
                text: vec![Inline::Math {
                    source: "x|y".into(),
                }],
                ..crate::Cell::default()
            }],
        ],
        ..crate::Table::default()
    };
    let blocks = vec![Block::new(BlockKind::Table(table))];
    let markdown = write(&blocks);
    assert_eq!(
        read(&markdown, ReadOptions::EXACT).expect(&markdown),
        blocks,
        "{markdown}"
    );
}

#[test]
fn a_megabyte_of_prose_does_not_trial_each_punctuation_mark() {
    let value =
        "Words, sentences. Ordinary prose's punctuation! More words: prose. ".repeat(16_384);
    let blocks = vec![paragraph(&value)];
    let markdown = write(&blocks);
    assert_eq!(
        read(&markdown, ReadOptions::EXACT).expect("large paragraph"),
        blocks
    );
}

#[test]
fn numbered_continuations_minimize_their_own_text() {
    let blocks = blocks_from_json(&json!([
        {"type":"numberedListItem","props":{"start":9},"content":[{"type":"text","text":"Nine."}]},
        {"type":"numberedListItem","content":[{"type":"text","text":"Ten!"}]}
    ]))
    .expect("numbered Blocks");
    assert_eq!(write(&blocks), "9. Nine.\n10. Ten!");
    assert_eq!(
        read(&write(&blocks), ReadOptions::EXACT).expect("numbers"),
        blocks
    );
}

#[test]
fn long_delimiter_runs_do_not_trial_each_marker() {
    for marker in ['*', '`', '|', '\\'] {
        let blocks = vec![paragraph(&marker.to_string().repeat(65_536))];
        let markdown = write(&blocks);
        assert_eq!(
            read(&markdown, ReadOptions::EXACT).expect("long delimiter run"),
            blocks
        );
    }
}

#[test]
fn inline_images_in_cells_keep_widths_and_caption_pipes() {
    let table = crate::Table {
        header_row: true,
        rows: vec![vec![crate::Cell {
            text: vec![Inline::Image(crate::InlineImage {
                url: "image.png".into(),
                alt: "Score |10".into(),
                width: Some(480),
                href: None,
            })],
            ..crate::Cell::default()
        }]],
        ..crate::Table::default()
    };
    let blocks = vec![Block::new(BlockKind::Table(table))];
    let markdown = write(&blocks);
    assert_eq!(
        read(&markdown, ReadOptions::EXACT).expect(&markdown),
        blocks,
        "{markdown}"
    );
}

#[test]
fn portable_tables_drop_extras_and_flatten_cell_breaks() {
    let blocks = blocks_from_json(&json!([{
        "type":"table", "props":{"textColor":"blue"}, "content":{"type":"tableContent", "columnWidths":[160], "headerCols":1, "rows":[
            {"cells":[{"props":{"backgroundColor":"green"},"content":[{"type":"text","text":"one\ntwo"}]}]},
            {"cells":[{"content":[{"type":"text","text":"three"}]}]}
        ]}
    }])).expect("table");
    let portable = write_portable(&blocks, &PortableOptions::default());
    assert_eq!(portable.markdown, "| one two |\n| --- |\n| three |");
    assert!(!portable.exact);
}

#[test]
fn portable_atoms_and_resource_blocks_have_plain_markdown_forms() {
    let blocks = blocks_from_json(&json!([
        {"type":"paragraph", "content":[
            {"type":"dateMention","props":{"start":"2026-10-27"}},
            {"type":"text","text":" "},
            {"type":"attachment","props":{"kind":"file","source":"file.txt","name":" notes.txt "}},
            {"type":"text","text":" "},
            {"type":"threadMention","props":{"uuid":"session-1"}},
            {"type":"agentConfig"}
        ]},
        {"id":"page-1","type":"page"},
        {"type":"pageRef","props":{"targetBlockId":"page-2"}},
        {"id":"canvas-1","type":"canvas"},
        {"id":"db-1","type":"database"},
        {"type":"syncedBlockRef","props":{"sourceBlockId":"b-1"}},
        {"type":"templateRef","props":{"sourceBlockId":"b-2"}}
    ]))
    .expect("portable Blocks");
    let portable = write_portable(&blocks, &PortableOptions::default());
    assert_eq!(
        portable.markdown,
        "@Oct 27, 2026 [notes.txt](file.txt) [Thread](nodex://sessions/session-1)\n\n[Page](nodex://pages/page-1)\n\n[Page](nodex://pages/page-2)"
    );
    assert!(!portable.exact);
}

#[test]
fn consecutive_and_edge_line_breaks_stay_inside_their_block() {
    for value in [
        "a\n\nb",
        "\n\nb",
        "a\n\n",
        "\n\n",
        "a\n\n\nb",
        "first\nsecond",
    ] {
        for kind in [
            BlockKind::Paragraph {
                text: text(value),
                colors: Colors::default(),
            },
            BlockKind::Heading {
                level: 2,
                toggleable: false,
                text: text(value),
                colors: Colors::default(),
            },
            BlockKind::Bullet {
                text: text(value),
                colors: Colors::default(),
            },
        ] {
            let blocks = vec![Block::new(kind)];
            let markdown = write(&blocks);
            assert_eq!(
                read(&markdown, ReadOptions::EXACT).expect(&markdown),
                blocks,
                "{value:?} -> {markdown:?}"
            );
        }
    }
}

#[test]
fn urls_keep_literal_entities_brackets_and_backslashes() {
    for url in [
        "https://example.com/?a=1&b=2",
        "https://example.com/&amp;",
        "https://example.com/&copy;",
        "https://example.com/<x>?q=&copy;",
        "my (file.png",
        "file\\(name)",
    ] {
        let blocks = vec![
            Block::new(BlockKind::Paragraph {
                text: vec![Inline::Link {
                    href: url.into(),
                    content: vec![crate::StyledText {
                        text: "label".into(),
                        style: Style::default(),
                    }],
                }],
                colors: Colors::default(),
            }),
            Block::new(BlockKind::Image {
                url: url.into(),
                caption: "Caption".into(),
                width: None,
            }),
        ];
        let markdown = write(&blocks);
        assert_eq!(
            read(&markdown, ReadOptions::EXACT).expect(&markdown),
            blocks,
            "{url:?}: {markdown}"
        );
    }
}

#[test]
fn literal_padding_keeps_all_space_code_and_math() {
    for value in [" ", "  ", " x ", "`", "a`b", "$$"] {
        for item in [
            Inline::Text {
                text: value.into(),
                style: Style {
                    code: true,
                    ..Style::default()
                },
            },
            Inline::Math {
                source: value.into(),
            },
        ] {
            let blocks = vec![Block::new(BlockKind::Paragraph {
                text: vec![item],
                colors: Colors::default(),
            })];
            let markdown = write(&blocks);
            assert_eq!(
                read(&markdown, ReadOptions::EXACT).expect(&markdown),
                blocks,
                "{value:?} -> {markdown:?}"
            );
        }
    }
}

#[test]
#[ignore = "release stress profiling of general escape contexts"]
fn adversarial_write_timings() {
    let size = std::env::var("NODEX_MARKDOWN_PERF_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8192);
    for (name, unit) in [
        ("prose", "Ordinary words, with punctuation. More words! "),
        ("mixed", "*_[]<>$:{}\\` "),
        ("repeated-style", "*word* "),
        ("repeated-links", "[text](url) "),
        ("short-lines", "*a*\n"),
    ] {
        let value = unit.repeat(size / unit.len());
        let blocks = vec![Block::new(BlockKind::Paragraph {
            text: text(&value),
            colors: Colors::default(),
        })];
        let start = std::time::Instant::now();
        let markdown = crate::write_located(&blocks).0;
        eprintln!("write {name}: {} bytes {:?}", value.len(), start.elapsed());
        assert_eq!(read(&markdown, ReadOptions::EXACT).unwrap(), blocks);
    }
}

#[test]
#[ignore = "release performance budget; run with --release --ignored --nocapture"]
fn linear_writer_hotspot_timings() {
    super::escapes::performance::mixed_writer_timings();
    super::escapes::performance::corpus_writer_timings();
    let prose = "Ordinary words, with punctuation. More words! ".repeat(1024 * 1024 / 44);
    let blocks = vec![Block::new(BlockKind::Paragraph {
        text: text(&prose),
        colors: Colors::default(),
    })];
    let start = std::time::Instant::now();
    let markdown = crate::write_located(&blocks).0;
    eprintln!("write 1 MiB prose: {:?}", start.elapsed());
    assert!(start.elapsed() < std::time::Duration::from_millis(100));
    assert_eq!(read(&markdown, ReadOptions::EXACT).unwrap(), blocks);

    let rows = vec![
        vec![
            crate::Cell {
                text: text("a"),
                ..crate::Cell::default()
            };
            3
        ];
        150_000
    ];
    let blocks = vec![Block::new(BlockKind::Table(crate::Table {
        rows,
        header_row: true,
        ..crate::Table::default()
    }))];
    let start = std::time::Instant::now();
    let markdown = crate::write_located(&blocks).0;
    eprintln!(
        "write table: {} bytes {:?}",
        markdown.len(),
        start.elapsed()
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(read(&markdown, ReadOptions::EXACT).unwrap(), blocks);

    let blocks = vec![Block::new(BlockKind::Paragraph {
        text: vec![Inline::AgentConfig(crate::AgentConfig {
            unknown: vec![("source".into(), "&".repeat(2 * 1024 * 1024))],
            ..crate::AgentConfig::default()
        })],
        colors: Colors::default(),
    })];
    let start = std::time::Instant::now();
    let markdown = crate::write_located(&blocks).0;
    eprintln!(
        "write attribute: {} bytes {:?}",
        markdown.len(),
        start.elapsed()
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(read(&markdown, ReadOptions::EXACT).unwrap(), blocks);
}
