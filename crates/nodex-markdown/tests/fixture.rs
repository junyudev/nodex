//! The round-trip contract of Nodex Markdown, `tests/fixtures/cases.json`.
//!
//! Every case's `markdown` is the one exact text of its `blocks`: writing the Blocks gives the
//! text, and reading the text gives the Blocks. `reads` and `nodexReads` are other spellings that
//! read as the same Blocks; `rejects` are refused by an exact write; `boundaryReads` say how such
//! text reads everywhere else. Set `NODEX_MARKDOWN_CASE` to a substring of case names to run
//! only those cases, and `NODEX_MARKDOWN_CHECK` to `read` or `write` to run only those checks.

use nodex_markdown::{ReadOptions, blocks_from_json, blocks_to_json, read, write};
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/cases.json");

fn selected(name: &str) -> bool {
    std::env::var("NODEX_MARKDOWN_CASE").map_or(true, |filter| name.contains(&filter))
}

fn checking(kind: &str) -> bool {
    std::env::var("NODEX_MARKDOWN_CHECK").map_or(true, |check| check == kind)
}

fn strings(case: &Value, key: &str) -> Vec<String> {
    case[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn describe(result: &Result<Vec<nodex_markdown::Block>, nodex_markdown::ReadError>) -> String {
    match result {
        Ok(blocks) => serde_json::to_string_pretty(&blocks_to_json(blocks)).unwrap_or_default(),
        Err(error) => format!("refused: {error}"),
    }
}

#[test]
fn every_case_round_trips() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    let mut failures = Vec::new();
    let mut checked = 0;

    for case in fixture["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        if !selected(name) {
            continue;
        }
        checked += 1;
        let markdown = case["markdown"].as_str().expect("markdown");
        let blocks = match blocks_from_json(&case["blocks"]) {
            Ok(blocks) => blocks,
            Err(error) => {
                failures.push(format!("[{name}] blocks do not read as the model: {error}"));
                continue;
            }
        };
        let json = blocks_to_json(&blocks);
        if json != case["blocks"] {
            failures.push(format!(
                "[{name}] the model does not write the fixture's Blocks back:\n{}",
                serde_json::to_string_pretty(&json).unwrap_or_default()
            ));
        }

        let written = if checking("write") {
            write(&blocks)
        } else {
            markdown.to_owned()
        };
        if written != markdown {
            failures.push(format!(
                "[{name}] write\n  expected: {markdown:?}\n  actual:   {written:?}"
            ));
        }

        let spellings = std::iter::once(markdown.to_owned())
            .chain(strings(case, "reads"))
            .chain(strings(case, "nodexReads"))
            .filter(|_| checking("read"));
        for spelling in spellings {
            let result = read(&spelling, ReadOptions::EXACT);
            if result.as_ref().ok() != Some(&blocks) {
                failures.push(format!(
                    "[{name}] read {spelling:?}\n  expected: {}\n  actual:   {}",
                    serde_json::to_string(&case["blocks"]).unwrap_or_default(),
                    describe(&result)
                ));
            }
            if case["gfm"].as_bool() == Some(true) {
                let boundary = read(&spelling, ReadOptions::BOUNDARY);
                if boundary.as_ref().ok() != Some(&blocks) {
                    failures.push(format!(
                        "[{name}] boundary read {spelling:?}\n  actual: {}",
                        describe(&boundary)
                    ));
                }
            }
        }
    }

    for reject in fixture["rejects"].as_array().expect("rejects") {
        let name = reject["name"].as_str().expect("name");
        if !selected(name) || !checking("read") {
            continue;
        }
        checked += 1;
        let markdown = reject["markdown"].as_str().expect("markdown");
        if let Ok(blocks) = read(markdown, ReadOptions::EXACT) {
            failures.push(format!(
                "[{name}] an exact write of {markdown:?} should be refused but read as:\n{}",
                serde_json::to_string_pretty(&blocks_to_json(&blocks)).unwrap_or_default()
            ));
        }
    }

    for boundary in fixture["boundaryReads"].as_array().expect("boundaryReads") {
        let name = boundary["name"].as_str().expect("name");
        if !selected(name) || !checking("read") {
            continue;
        }
        checked += 1;
        let markdown = boundary["markdown"].as_str().expect("markdown");
        let blocks = blocks_from_json(&boundary["blocks"]).expect("boundary blocks");
        let result = read(markdown, ReadOptions::BOUNDARY);
        if result.as_ref().ok() != Some(&blocks) {
            failures.push(format!(
                "[{name}] boundary read {markdown:?}\n  expected: {}\n  actual:   {}",
                serde_json::to_string(&boundary["blocks"]).unwrap_or_default(),
                describe(&result)
            ));
        }
    }

    assert!(checked > 0, "no case matched NODEX_MARKDOWN_CASE");
    assert!(
        failures.is_empty(),
        "{} of the fixture's checks failed:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn the_model_reads_and_writes_every_fixture_block() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    for case in fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .chain(fixture["boundaryReads"].as_array().expect("boundaryReads"))
    {
        let name = case["name"].as_str().expect("name");
        let blocks =
            blocks_from_json(&case["blocks"]).unwrap_or_else(|error| panic!("[{name}] {error}"));
        assert_eq!(blocks_to_json(&blocks), case["blocks"], "[{name}]");
    }
}
