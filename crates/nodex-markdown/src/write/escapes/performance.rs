//! Exercise the writer's real call path, including nested labels and table cells.

use super::{CHECK_EXHAUSTIVE, EXHAUSTIVE_CHECKS};
use crate::{ReadOptions, read, write};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(in crate::write) fn with_exhaustive<T>(operation: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            CHECK_EXHAUSTIVE.set(self.0);
        }
    }
    let _reset = Reset(CHECK_EXHAUSTIVE.replace(true));
    operation()
}

pub(in crate::write) fn mixed_writer_timings() {
    for (size, budget) in [
        (8192, Duration::from_millis(250)),
        (65536, Duration::from_secs(3)),
    ] {
        for (name, unit) in [
            ("mixed", "*_[]<>$:{}\\` "),
            ("style", "*word* "),
            ("links", "[text](url) "),
            ("lines", "*a*\n"),
        ] {
            let value = unit.repeat(size / unit.len());
            let blocks = vec![crate::Block::new(crate::BlockKind::Paragraph {
                text: vec![crate::Inline::Text {
                    text: value,
                    style: crate::Style::default(),
                }],
                colors: crate::Colors::default(),
            })];
            let start = Instant::now();
            let result = write(&blocks);
            let elapsed = start.elapsed();
            eprintln!("{name} {} bytes: {elapsed:?}", size);
            assert!(elapsed < budget, "{name} {size} bytes: {elapsed:?}");
            assert_eq!(read(&result, ReadOptions::EXACT).unwrap(), blocks);
        }
    }
}

fn markdown_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .expect("corpus directory")
        .map(|entry| entry.expect("directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            markdown_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            files.push(path);
        }
    }
}

fn corpus() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for directory in ["docs", "agent-skills"] {
        markdown_files(&root.join(directory), &mut files);
    }
    assert!(files.len() > 20);
    files
}

pub(in crate::write) fn corpus_writer_timings() {
    let filter = std::env::var("NODEX_MARKDOWN_CORPUS_FILTER").unwrap_or_default();
    let mut total = Duration::ZERO;
    let mut maximum = (Duration::ZERO, PathBuf::new(), String::new());
    let mut slow = 0;
    let mut count = 0;
    for path in corpus()
        .into_iter()
        .filter(|path| path.to_string_lossy().contains(&filter))
    {
        let source = std::fs::read_to_string(&path).expect("Markdown");
        let blocks = read(&source, ReadOptions::DOCUMENT).expect("corpus reads");
        let mut pending: Vec<_> = blocks
            .iter()
            .enumerate()
            .rev()
            .map(|(index, block)| (index.to_string(), block))
            .collect();
        while let Some((index, block)) = pending.pop() {
            pending.extend(
                block
                    .children
                    .iter()
                    .enumerate()
                    .rev()
                    .map(|(child, block)| (format!("{index}.{child}"), block)),
            );
            let elapsed = best_time(|| {
                std::hint::black_box(write(std::slice::from_ref(block)));
            });
            count += 1;
            if elapsed > Duration::from_millis(5) {
                slow += 1;
            }
            if elapsed > maximum.0 {
                maximum = (elapsed, path.clone(), index.clone());
            }
            if path.ends_with("workbench-shell.md") && index == "20" {
                eprintln!("workbench-shell Block 20: {elapsed:?}");
            }
        }
        let elapsed = best_time(|| {
            std::hint::black_box(write(&blocks));
        });
        total += elapsed;
        if path.ends_with("workbench-shell.md") {
            eprintln!("workbench-shell whole: {elapsed:?}");
            assert!(
                elapsed < Duration::from_millis(30),
                "workbench-shell: {elapsed:?}"
            );
        }
    }
    eprintln!(
        "corpus: {count} Blocks including children, total {total:?}, {slow} above 5ms; maximum {:?} {} Block {}",
        maximum.0,
        maximum.1.display(),
        maximum.2
    );
    assert_eq!(slow, 0, "corpus Block budget");
}

// Minima of three serial runs reduce scheduler noise without timing parsing or
// the exhaustive checker. CI runs this gate with the other release budgets.
fn best_time(mut operation: impl FnMut()) -> Duration {
    (0..3)
        .map(|_| {
            let start = Instant::now();
            operation();
            start.elapsed()
        })
        .min()
        .expect("three samples")
}

#[test]
#[ignore = "exhaustive comparison over every minimization in the real corpus; run in release"]
fn corpus_minimizations_match_exhaustive() {
    with_exhaustive(corpus_minimizations);
}

fn corpus_minimizations() {
    let start = Instant::now();
    for path in corpus() {
        let blocks = read(
            &std::fs::read_to_string(path).expect("Markdown"),
            ReadOptions::DOCUMENT,
        )
        .expect("corpus reads");
        std::hint::black_box(write(&blocks));
    }
    eprintln!(
        "{} minimizations equal exhaustive in {:?}",
        EXHAUSTIVE_CHECKS.get(),
        start.elapsed()
    );
    assert!(EXHAUSTIVE_CHECKS.get() > 100);
}

#[test]
fn seeded_prose_and_styles_match_exhaustive() {
    with_exhaustive(seeded_prose_and_styles);
}

fn seeded_prose_and_styles() {
    use crate::{Block, BlockKind, Colors, Inline, Style, StyledText};
    let words = [
        "technical prose",
        "ordinary (details)",
        "中英文，标点。",
        "[a@b.com",
        "snake_case",
        "- + # > = . !",
        "*emphasis*",
        ":span[x]{underline}",
        "[label](url)",
        "`code` and $$math$$",
        "\\[x\\] \\(y\\)",
        "{color=\"red\"}",
        "a | b",
        "<tag>",
        "plain first line, with details",
    ];
    let mut random = 0x49a1_37d2_c501_9b2f_u64;
    for case in 0..240 {
        let mut items = Vec::new();
        for _ in 0..case % 7 + 1 {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let value = words[random as usize % words.len()].to_owned();
            let style = Style {
                bold: random & 1 != 0,
                italic: random & 2 != 0,
                strike: random & 4 != 0,
                underline: random & 8 != 0,
                code: random & 16 != 0,
                ..Style::default()
            };
            items.push(match random % 5 {
                0 => Inline::Link {
                    href: "https://example.com/path".into(),
                    content: vec![StyledText { text: value, style }],
                },
                1 => Inline::Math { source: value },
                _ => Inline::Text { text: value, style },
            });
            items.push(Inline::Text {
                text: " ordinary prose, with details! ".into(),
                style: Style::default(),
            });
        }
        let kind = match case % 4 {
            0 => BlockKind::Paragraph {
                text: items,
                colors: Colors::default(),
            },
            1 => BlockKind::Bullet {
                text: items,
                colors: Colors::default(),
            },
            2 => BlockKind::Quote {
                text: items,
                colors: Colors::default(),
            },
            _ => BlockKind::Heading {
                level: 2,
                toggleable: false,
                text: items,
                colors: Colors::default(),
            },
        };
        let mut blocks = vec![Block::new(kind)];
        crate::normalize_blocks(&mut blocks);
        let output = write(&blocks);
        assert_eq!(
            read(&output, ReadOptions::EXACT).unwrap(),
            blocks,
            "case {case}: {output}"
        );
    }
}
