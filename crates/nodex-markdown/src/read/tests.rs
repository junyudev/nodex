//! Regression boundaries beyond the shared round-trip fixture.

use crate::{
    Block, BlockKind, Inline, ReadOptions, blocks_from_json, blocks_to_json, read, read_inline,
    read_located,
};
use serde_json::{Value, json};

fn expect(source: &str, options: ReadOptions, expected: Value) {
    assert_eq!(
        blocks_to_json(&read(source, options).unwrap()),
        expected,
        "{source:?}"
    );
}

#[test]
fn document_breaks_and_comment_indentation() {
    expect(
        "  one\n   two\nthree",
        ReadOptions::BOUNDARY,
        json!([{"type":"paragraph","content":[{"type":"text","text":"  one\n   two\nthree"}]}]),
    );
    expect(
        "  one\n   two\nthree",
        ReadOptions::DOCUMENT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"one two three"}]}]),
    );
    expect(
        "a\\\nb<br>c",
        ReadOptions::DOCUMENT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"a\nb\nc"}]}]),
    );
}

#[test]
fn footnotes_and_single_dollars_are_ordinary_markdown() {
    expect(
        "$**bold**$ and $a\nb$",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"$"},{"type":"text","text":"bold","styles":{"bold":true}},{"type":"text","text":"$ and $a\nb$"}]}]),
    );
    let blocks = read("A[^n]\n\n[^n]: a footnote", ReadOptions::EXACT).unwrap();
    assert!(
        matches!(&blocks[0].kind, BlockKind::Paragraph {text,..} if crate::text::inline_text(text) == "A[^n]")
    );
}

#[test]
fn unsupported_html_styles_keep_only_the_text_at_the_boundary() {
    for tag in ["sub", "sup", "kbd"] {
        let source = format!("Use <{tag}>x</{tag}>");
        assert!(read(&source, ReadOptions::EXACT).is_err());
        expect(
            &source,
            ReadOptions::BOUNDARY,
            json!([{"type":"paragraph","content":[{"type":"text","text":"Use x"}]}]),
        );
    }
    expect(
        "Use <widget>x</widget>",
        ReadOptions::BOUNDARY,
        json!([{"type":"paragraph","content":[{"type":"text","text":"Use <widget>x</widget>"}]}]),
    );
}

#[test]
fn images_stay_inline_in_text_tables_items_and_links() {
    let blocks = read("Text ![alt|40](image) here\n\n[![build](badge)](ci)\n\n![icon](image)<!-- -->\n\n- ![item](image)\n\n| icon |\n| --- |\n| ![cell](image) |", ReadOptions::EXACT).unwrap();
    assert!(
        matches!(&blocks[0].text().unwrap()[1], Inline::Image(i) if i.alt == "alt" && i.width == Some(40))
    );
    assert!(
        matches!(&blocks[1].text().unwrap()[0], Inline::Image(i) if i.href.as_deref() == Some("ci"))
    );
    assert!(
        matches!(&blocks[2].kind, BlockKind::Paragraph {text,..} if matches!(&text[0], Inline::Image(_)))
    );
    assert!(matches!(&blocks[3].text().unwrap()[0], Inline::Image(_)));
    assert!(
        matches!(&blocks[4].kind, BlockKind::Table(t) if matches!(&t.rows[1][0].text[0], Inline::Image(_)))
    );
}

#[test]
fn flat_and_unclosed_containers_respect_their_parent() {
    let flat = read(
        ":::paragraph[Outer]\n:::toggle[Inner]\ntext\n:::\n:::",
        ReadOptions::EXACT,
    )
    .unwrap();
    assert!(matches!(
        &flat[0].children[0].kind,
        BlockKind::Toggle { .. }
    ));
    let streaming = read(":::toggle[Open]\n  text\n\nafter", ReadOptions::BOUNDARY).unwrap();
    assert_eq!(streaming.len(), 2);
    assert!(
        read(":::toggle[Open]\n  text\n\nafter", ReadOptions::EXACT)
            .unwrap_err()
            .message
            .contains("closing `:::`")
    );
    let quote = read("> :::toggle[Open]\n> text\n\nafter", ReadOptions::BOUNDARY).unwrap();
    assert_eq!(quote.len(), 2, "{quote:#?}");
}

#[test]
fn math_is_literal_and_has_independent_fences() {
    expect(
        "\\(a_b\\) and $$$a $$ b$$$",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"math","content":"a_b"},{"type":"text","text":" and "},{"type":"math","content":"a $$ b"}]}]),
    );
    for source in ["```math\na_b\n```", "\\[\na_b\n\\]", "$$\na_b\n$$"] {
        expect(
            source,
            ReadOptions::EXACT,
            json!([{"type":"mathBlock","content":[{"type":"text","text":"a_b"}]}]),
        );
    }
    expect(
        "$$$\na\n\n- :date{}\n$$\n:::toggle[Text]\n$$$",
        ReadOptions::EXACT,
        json!([{"type":"mathBlock","content":[{"type":"text","text":"a\n\n- :date{}\n$$\n:::toggle[Text]"}]}]),
    );
}

#[test]
fn link_titles_are_dropped_and_deep_headings_clamp() {
    expect(
        "##### Deep\n\n###### Deeper\n\n[label](url \"title\")",
        ReadOptions::EXACT,
        json!([{"type":"heading","props":{"level":4},"content":[{"type":"text","text":"Deep"}]},{"type":"heading","props":{"level":4},"content":[{"type":"text","text":"Deeper"}]},{"type":"paragraph","content":[{"type":"link","href":"url","content":[{"type":"text","text":"label"}]}]}]),
    );
}

#[test]
fn table_pipe_escapes_do_not_change_mentions_or_links() {
    let blocks = read("| a\\|b <nodex://pages/p%20one> [nodex://pages/p](nodex://pages/p) <nodex://sessions/s%2Fone> |\n| --- |", ReadOptions::EXACT).unwrap();
    let BlockKind::Table(table) = &blocks[0].kind else {
        panic!("table");
    };
    assert!(
        table.rows[0][0]
            .text
            .iter()
            .any(|i| matches!(i, Inline::PageMention {page} if page == "p one"))
    );
    assert!(
        table.rows[0][0]
            .text
            .iter()
            .any(|i| matches!(i, Inline::Link {href,..} if href == "nodex://pages/p"))
    );
    assert!(
        table.rows[0][0]
            .text
            .iter()
            .any(|i| matches!(i, Inline::ChatMention {session} if session == "s/one"))
    );
}

#[test]
fn a_code_span_after_a_table_pipe_escape_keeps_its_literal_text() {
    expect(
        "| a | b |\n| --- | --- |\n| `x\\|y` | `:span[t]{underline}` |\n| z | `:date{start=\"2026-10-27\"}` |",
        ReadOptions::EXACT,
        json!([{"type":"table","content":{"type":"tableContent","headerRows":1,"rows":[
            {"cells":[{"content":[{"type":"text","text":"a"}]},{"content":[{"type":"text","text":"b"}]}]},
            {"cells":[
                {"content":[{"type":"text","text":"x|y","styles":{"code":true}}]},
                {"content":[{"type":"text","text":":span[t]{underline}","styles":{"code":true}}]}
            ]},
            {"cells":[
                {"content":[{"type":"text","text":"z"}]},
                {"content":[{"type":"text","text":":date{start=\"2026-10-27\"}","styles":{"code":true}}]}
            ]}
        ]}}]),
    );
}

#[test]
fn attribute_values_are_literal_and_agent_fields_are_kept() {
    let blocks = read(r#":attachment{kind="file" source="C:\tmp\*x" name="**name** [link](u) &quot;quoted&quot;"} :agent-config{mode="future" extra="a&amp;b"}"#, ReadOptions::EXACT).unwrap();
    let items = blocks[0].text().unwrap();
    assert!(
        matches!(&items[0], Inline::Attachment(a) if a.source == r"C:\tmp\*x" && a.name == "**name** [link](u) \"quoted\"")
    );
    assert!(
        matches!(&items[2], Inline::AgentConfig(a) if a.mode.as_deref() == Some("future") && a.unknown == [("extra".into(), "a&b".into())])
    );
}

#[test]
fn inline_api_has_no_block_syntax_and_keeps_span_edges() {
    assert_eq!(
        read_inline("# Title", ReadOptions::EXACT).unwrap(),
        vec![Inline::Text {
            text: "# Title".into(),
            style: Default::default()
        }]
    );
    assert!(read_inline("line\nline", ReadOptions::EXACT).is_err());
    let items = read_inline(
        ":span[**Note:**]plain<br>:span[*x*]{underline}",
        ReadOptions::EXACT,
    )
    .unwrap();
    assert!(matches!(&items[0], Inline::Text {text,style} if text == "Note:" && style.bold));
    assert!(
        matches!(items.last(), Some(Inline::Text {text,style}) if text == "x" && style.italic && style.underline)
    );
    assert!(read_inline(":date{}", ReadOptions::EXACT).is_err());
}

#[test]
fn syntax_in_multiline_code_and_indented_code_is_literal() {
    expect(
        "`one\n:date{}\nthree`",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"one :date{} three","styles":{"code":true}}]}]),
    );
    expect(
        "    :date{}\n    {color=\"red\"}",
        ReadOptions::EXACT,
        json!([{"type":"codeBlock","content":[{"type":"text","text":":date{}\n{color=\"red\"}"}]}]),
    );
}

fn count(blocks: &[Block]) -> usize {
    blocks.iter().map(|b| 1 + count(&b.children)).sum()
}

#[test]
fn every_fixture_block_owns_its_original_nonseparator_lines_once() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/cases.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let source = case["markdown"].as_str().unwrap();
        let located = read_located(source, ReadOptions::EXACT).unwrap();
        assert_eq!(
            located.blocks,
            blocks_from_json(&case["blocks"]).unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            located.locations.len(),
            count(&located.blocks),
            "{}",
            case["name"]
        );
        let mut coverage = vec![0; source.len()];
        for location in &located.locations {
            for range in &location.spans {
                assert!(range.end <= source.len());
                for byte in &mut coverage[range.clone()] {
                    *byte += 1;
                }
            }
        }
        let mut start = 0;
        for line in source.split_inclusive('\n') {
            let separator =
                line.trim_matches([' ', '\t', '\n', '>']).is_empty() && source.trim() != ">";
            let owned = &coverage[start..start + line.len()];
            assert!(
                owned.iter().all(|n| *n <= 1),
                "overlap in {}: {line:?}",
                case["name"]
            );
            if !separator {
                assert!(
                    owned.iter().all(|n| *n == 1),
                    "unowned line in {}: {line:?}",
                    case["name"]
                );
            }
            start += line.len();
        }
    }
}

#[test]
fn original_byte_offsets_keep_crlf_unicode_and_code_blank_lines() {
    let source = ":::toggle[好]\r\n  ```\r\n  a\r\n\r\n  b\r\n  ```\r\n:::\r\n\r\nAfter";
    let located = read_located(source, ReadOptions::EXACT).unwrap();
    assert_eq!(located.locations.len(), 3);
    let parts: Vec<_> = located.locations[0]
        .spans
        .iter()
        .map(|s| &source[s.clone()])
        .collect();
    assert_eq!(parts, [":::toggle[好]\r\n", ":::\r\n"]);
    assert_eq!(
        &source[located.locations[1].spans[0].clone()],
        "  ```\r\n  a\r\n\r\n  b\r\n  ```\r\n"
    );
}

#[test]
fn arbitrary_unicode_and_garbage_never_panic() {
    let alphabet = [
        'a', '中', '\u{e000}', '\u{e001}', '\0', ':', '{', '}', '[', ']', '"', '\\', '\n', ' ',
        '`', '$', '*', '>', '|', 'é',
    ];
    let mut state = 431u64;
    for n in 0..600 {
        let mut source = String::new();
        for _ in 0..n % 180 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            source.push(alphabet[(state >> 32) as usize % alphabet.len()]);
        }
        for options in [
            ReadOptions::EXACT,
            ReadOptions::BOUNDARY,
            ReadOptions::DOCUMENT,
        ] {
            let _ = read_located(&source, options);
        }
    }
}

#[test]
fn one_megabyte_document_has_linear_block_ownership() {
    let paragraph =
        "A paragraph with **bold**, [a link](url), and :date{start=\"2026-10-28\"}.\n\n";
    let source = paragraph.repeat(1_048_576 / paragraph.len() + 1);
    let started = std::time::Instant::now();
    let located = read_located(&source, ReadOptions::EXACT).unwrap();
    assert_eq!(located.blocks.len(), located.locations.len());
    assert_eq!(located.blocks.len(), source.matches("A paragraph").count());
    eprintln!("read {} bytes in {:?}", source.len(), started.elapsed());
}

#[test]
fn located_reader_and_writer_agree_on_fixture_ownership() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/cases.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let blocks = blocks_from_json(&case["blocks"]).unwrap();
        let (markdown, locations) = crate::write_located(&blocks);
        let read = read_located(&markdown, ReadOptions::EXACT).unwrap();
        assert_eq!(read.blocks, blocks, "{}", case["name"]);
        assert_eq!(read.locations, locations, "{}: {markdown:?}", case["name"]);
    }
}

#[test]
fn multiline_styles_keep_comment_indentation() {
    expect(
        "  **one\n   two**",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"  "},{"type":"text","text":"one\n   two","styles":{"bold":true}}]}]),
    );
    // The line break joins the bold runs it separates, and the exact text reads back the same.
    let blocks = read("  **one\n   two**", ReadOptions::EXACT).unwrap();
    assert_eq!(read(&crate::write(&blocks), ReadOptions::EXACT), Ok(blocks));
}

#[test]
fn indented_container_syntax_is_code_and_nested_list_containers_still_work() {
    expect(
        "    :::toggle[Literal]\n    :::",
        ReadOptions::EXACT,
        json!([{"type":"codeBlock","content":[{"type":"text","text":":::toggle[Literal]\n:::"}]}]),
    );
    let blocks = read(
        "- outer\n  - inner\n\n    :::toggle[Details]\n      text\n    :::",
        ReadOptions::EXACT,
    )
    .unwrap();
    assert!(matches!(
        &blocks[0].children[0].children[0].kind,
        BlockKind::Toggle { .. }
    ));
}

#[test]
fn invalid_boundary_attributes_keep_the_original_spelling() {
    expect(
        ":date{start=\"tomorrow\" format=\"&quot;x&quot;\"}",
        ReadOptions::BOUNDARY,
        json!([{"type":"paragraph","content":[{"type":"text","text":":date{start=\"tomorrow\" format=\"&quot;x&quot;\"}"}]}]),
    );
}

#[test]
fn colon_lines_inside_multiline_code_spans_and_comments_are_literal() {
    expect(
        "`one\n:::toggle[Example]\n::: \nend`",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"one :::toggle[Example] :::  end","styles":{"code":true}}]}]),
    );
    expect(
        "<!--\n:::toggle[Ignored]\n-->\n\ntext",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"text"}]}]),
    );
}

#[test]
fn excessive_nesting_is_refused_without_panicking() {
    let source = (0..180)
        .map(|depth| format!("{}- item\n", "  ".repeat(depth)))
        .collect::<String>();
    assert!(read(&source, ReadOptions::EXACT).is_err());
}

#[test]
fn inline_block_markers_are_text_and_entities_cannot_forge_tokens() {
    assert_eq!(
        crate::text::inline_text(&read_inline("::page", ReadOptions::EXACT).unwrap()),
        "::page"
    );
    let source = "&#xe000;ndx0:0&#xe001; :date{start=\"2026-10-28\"}";
    let items = read_inline(source, ReadOptions::EXACT).unwrap();
    assert!(
        matches!(&items[0], Inline::Text {text,..} if text == "�ndx0:0\u{e001} "),
        "{items:?}"
    );
    assert!(matches!(&items[1], Inline::DateMention(_)));
}

#[test]
fn leaf_directives_own_their_lines_without_needing_blank_separators() {
    expect(
        "Before\n::page{id=\"p\"}\n::canvas{id=\"c\"}\nAfter",
        ReadOptions::EXACT,
        json!([{"type":"paragraph","content":[{"type":"text","text":"Before"}]},{"id":"p","type":"page"},{"id":"c","type":"canvas"},{"type":"paragraph","content":[{"type":"text","text":"After"}]}]),
    );
    let blocks = read("> ::page-ref{page=\"p\"}", ReadOptions::EXACT).unwrap();
    assert!(blocks[0].text().unwrap().is_empty());
    assert!(matches!(&blocks[0].children[0].kind, BlockKind::PageRef {page} if page == "p"));
}

#[test]
fn a_long_unbroken_line_and_ampersands_do_not_trigger_repeated_scans() {
    for source in ["a".repeat(1_048_576), "&".repeat(1_048_576)] {
        let started = std::time::Instant::now();
        let located = read_located(&source, ReadOptions::EXACT).unwrap();
        assert_eq!(located.blocks.len(), 1);
        assert_eq!(
            crate::text::inline_text(located.blocks[0].text().unwrap()),
            source
        );
        assert_eq!(located.locations[0].spans, vec![0..source.len()]);
        eprintln!(
            "read a {} byte unbroken line in {:?}",
            source.len(),
            started.elapsed()
        );
    }
}

#[test]
#[ignore = "release profiling; run with --release --ignored --nocapture"]
fn adversarial_read_timings() {
    let size = std::env::var("NODEX_MARKDOWN_PERF_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2 * 1024 * 1024);
    for (name, unit) in [
        ("prose", "Ordinary words, with punctuation. More words! "),
        ("backticks", "`"),
        ("dollars", "$"),
        ("stars", "*"),
        ("underscores", "_"),
        ("brackets", "["),
        ("angles", "<"),
        ("colons", ":"),
        ("braces", "{"),
        ("slashes", "\\"),
        ("unclosed-latex", "\\(x "),
        ("unclosed-html", "<!--x "),
        ("short-lines", "a\n"),
        ("containers", ":::toggle[x]\n  a\n:::\n\n"),
        ("spans", ":span[text]{underline} "),
        ("table", "| a | b | c |\n"),
        ("backtick-label", "`"),
        ("ampersand-attribute", "&"),
    ] {
        let body = unit.repeat(size / unit.len());
        let source = match name {
            "table" => format!("| a | b | c |\n| --- | --- | --- |\n{body}"),
            "backticks" | "dollars" | "unclosed-html" => format!("text {body}"),
            "backtick-label" => format!(":span[{body}]{{underline}}"),
            "ampersand-attribute" => format!(":agent-config{{source=\"{body}\"}}"),
            _ => body,
        };
        let start = std::time::Instant::now();
        let result = read_located(&source, ReadOptions::BOUNDARY);
        eprintln!(
            "read {name}: {} bytes {:?} ok={}",
            source.len(),
            start.elapsed(),
            result.is_ok()
        );
        assert!(result.is_ok(), "{name}");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(1),
            "{name}"
        );
    }
    let prose = "Ordinary words, with punctuation. More words! ".repeat(1024 * 1024 / 44);
    let start = std::time::Instant::now();
    let _ = read_located(&prose, ReadOptions::EXACT).unwrap();
    eprintln!("read 1 MiB prose: {:?}", start.elapsed());
    assert!(start.elapsed() < std::time::Duration::from_millis(100));

    for (name, source) in [
        (
            "variable-backtick-runs",
            (1..2048)
                .map(|n| format!("x{} ", "`".repeat(n)))
                .collect::<String>(),
        ),
        (
            "variable-dollar-runs",
            (1..2048).map(|n| format!("x{} ", "$".repeat(n))).collect(),
        ),
        (
            "unmatched-html-styles",
            format!("x {}{}y", "<b>".repeat(size / 7), "</i>".repeat(size / 7)),
        ),
        (
            "many-attributes",
            format!(
                ":agent-config{{{}}}",
                (0..size / 10)
                    .map(|n| format!("a{n}=\"\" "))
                    .collect::<String>()
                    .trim_end()
            ),
        ),
        (
            "unclosed-latex-next-paragraph",
            format!("{}\n\n\\)", "\\(x ".repeat(size / 4)),
        ),
    ] {
        let start = std::time::Instant::now();
        let _ = read_located(&source, ReadOptions::BOUNDARY).unwrap();
        eprintln!("read {name}: {} bytes {:?}", source.len(), start.elapsed());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(1),
            "{name}"
        );
    }

    for (name, source) in [
        (
            "lists",
            (0..500)
                .map(|n| format!("{}- x\n", "  ".repeat(n)))
                .collect::<String>(),
        ),
        ("quotes", format!("{}x", "> ".repeat(500))),
        (
            "containers",
            (0..500)
                .map(|n| format!("{}:::toggle[x]\n", "  ".repeat(n)))
                .collect(),
        ),
    ] {
        let start = std::time::Instant::now();
        assert!(read_located(&source, ReadOptions::EXACT).is_err(), "{name}");
        eprintln!("read 500 levels {name}: {:?}", start.elapsed());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(1),
            "{name}"
        );
    }
}

#[test]
fn unmatched_delimiters_keep_their_literal_meaning() {
    for unit in ["`", "$$$", "\\(x ", "<", ":span["] {
        let source = format!("literal {}", unit.repeat(400));
        let items = read_inline(&source, ReadOptions::BOUNDARY).unwrap();
        assert_eq!(
            crate::text::inline_text(&items),
            source.replace("\\(", "(").trim_end()
        );
    }
    let label = "`".repeat(4096);
    let source = format!(":span[{label}]{{underline}}");
    let items = read_inline(&source, ReadOptions::EXACT).unwrap();
    assert_eq!(
        items,
        vec![Inline::Text {
            text: label,
            style: crate::Style {
                underline: true,
                ..crate::Style::default()
            }
        }]
    );
}

#[test]
fn crossing_html_style_closers_restore_the_matching_openers_state() {
    let items = read_inline("<b><i>x</b>y</i>", ReadOptions::BOUNDARY).unwrap();
    assert_eq!(
        items,
        vec![
            Inline::Text {
                text: "x".into(),
                style: crate::Style {
                    bold: true,
                    italic: true,
                    ..crate::Style::default()
                }
            },
            Inline::Text {
                text: "y".into(),
                style: crate::Style::default()
            },
        ]
    );
    let source = format!("{}{}x", "<b>".repeat(2000), "</i>".repeat(2000));
    assert_eq!(
        read_inline(&source, ReadOptions::BOUNDARY).unwrap(),
        vec![Inline::Text {
            text: "x".into(),
            style: crate::Style {
                bold: true,
                ..crate::Style::default()
            }
        }]
    );
}

#[test]
fn table_pipe_column_translation_keeps_mentions_and_links_distinct() {
    let source = format!(
        "| {} |\n| --- |",
        "\\|<nodex://pages/p> [label](nodex://pages/p) ".repeat(1000)
    );
    let blocks = read(&source, ReadOptions::EXACT).unwrap();
    let BlockKind::Table(table) = &blocks[0].kind else {
        panic!("table");
    };
    assert_eq!(
        table.rows[0][0]
            .text
            .iter()
            .filter(|item| matches!(item, Inline::PageMention { .. }))
            .count(),
        1000
    );
    assert_eq!(
        table.rows[0][0]
            .text
            .iter()
            .filter(|item| matches!(item, Inline::Link { .. }))
            .count(),
        1000
    );
}

#[test]
fn math_fences_depend_only_on_their_own_literal_body() {
    let source = format!("prefix {}\n\n$$\nx\n$$\n\n$$\n```\n$$", "`".repeat(4096));
    let blocks = read(&source, ReadOptions::EXACT).unwrap();
    assert!(matches!(&blocks[1].kind, BlockKind::Math { source } if source == "x"));
    assert!(matches!(&blocks[2].kind, BlockKind::Math { source } if source == "```"));
}

#[test]
fn a_code_span_never_spans_paragraphs_so_later_syntax_still_reads() {
    // The first paragraph's last backtick is literal; it must not pair with one in a later
    // paragraph and hide the directives between them.
    let blocks = blocks_from_json(&json!([
        {"type":"paragraph","content":[{"type":"text","text":"see `a/b`, and `c/d"}]},
        {"type":"paragraph","content":[{"type":"text","text":"x "},{"type":"text","text":"y","styles":{"underline":true}}]},
        {"type":"paragraph","content":[{"type":"attachment","props":{"kind":"file","source":"nodex://files/f1","name":"a.txt"}}]},
        {"type":"paragraph","content":[{"type":"text","text":"then `e f` and $$6"}]}
    ]))
    .unwrap();
    let text = crate::write(&blocks);
    assert_eq!(read(&text, ReadOptions::EXACT), Ok(blocks), "{text:?}");
}
