use nodex_markdown::{PortableOptions, ReadOptions, read, write, write_portable};

#[test]
fn pending_round_trips_in_nodex_markdown_and_is_omitted_from_portable_output() {
    let input = r#"Before

::pending{intent="Write results" discussion="discussion-id"}

After"#;
    let blocks = read(input, ReadOptions::EXACT).unwrap();
    assert_eq!(write(&blocks).trim(), input);
    let portable = write_portable(&blocks, &PortableOptions::default());
    assert_eq!(portable.markdown.trim(), "Before\n\nAfter");
    assert!(!portable.exact);
}
