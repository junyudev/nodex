use nodex_markdown::{
    PortableOptions, ReadOptions, blocks_from_json, blocks_to_json, read, text, write,
    write_portable,
};
use serde_json::json;

#[test]
fn prompt_content_is_portable_and_searchable_without_send_history() {
    let blocks = read(
        ":::prompt[Review **this change**]{sent=\"nodex://sessions/deleted\" sent-at=\"2026-10-31T08:30:00.000Z\" sent-message=\"message:one\"}\n  Focus on correctness.\n\n  :::prompt[Boundary cases]\n    - Check empty inputs\n  :::\n:::",
        ReadOptions::EXACT,
    ).unwrap();
    let portable = write_portable(&blocks, &PortableOptions::default());
    assert!(!portable.exact);
    assert_eq!(
        portable.markdown,
        "Review **this change**\n\nFocus on correctness.\n\nBoundary cases\n- Check empty inputs"
    );
    assert_eq!(
        text::plain_text(&blocks),
        "Review this change Focus on correctness. Boundary cases Check empty inputs"
    );
    assert_eq!(
        text::block_lines(&blocks),
        "Review this change\nFocus on correctness.\nBoundary cases\nCheck empty inputs"
    );
}

#[test]
fn prompt_json_normalizes_send_history_without_resolving_the_session() {
    let blocks = blocks_from_json(&json!([{
        "type": "prompt", "props": {
            "sentSessionId": "deleted-session", "sentAt": "2026-10-31T16:30:00.123456+08:00"
        }
    }]))
    .unwrap();
    assert_eq!(
        blocks_to_json(&blocks),
        json!([{
            "type": "prompt", "props": {
                "sentSessionId": "deleted-session", "sentAt": "2026-10-31T08:30:00.123Z"
            }
        }])
    );
    assert_eq!(
        write(&blocks),
        ":::prompt{sent=\"nodex://sessions/deleted-session\" sent-at=\"2026-10-31T08:30:00.123Z\"}\n:::"
    );
    assert!(
        blocks_from_json(&json!([{"type":"prompt","props":{"sentSessionId":"","sentAt":""}}]))
            .is_ok()
    );
    for props in [
        json!({"sentSessionId":"chat"}),
        json!({"sentAt":"2026-10-31T08:30:00Z"}),
        json!({"sentSessionId":" chat ","sentAt":"2026-10-31T08:30:00Z"}),
        json!({"sentSessionId":"chat","sentAt":"2026-10-31"}),
        json!({"sentSessionId":3,"sentAt":"2026-10-31T08:30:00Z"}),
        json!({"sentSessionId":"chat","sentAt":null}),
        json!({"sentMessageId":"message:one"}),
        json!({"sentSessionId":"chat","sentAt":"2026-10-31T08:30:00Z","sentMessageId":3}),
        json!({"sentSessionId":"chat","sentAt":"2026-10-31T08:30:00Z","sentMessageId":" message "}),
        json!({"sentSessionId":"chat","sentAt":"2026-10-31T08:30:00Z","sentMessageId":"message\nnext"}),
    ] {
        assert!(blocks_from_json(&json!([{"type":"prompt","props":props}])).is_err());
    }
}

#[test]
fn empty_prompt_first_lines_do_not_hide_children_in_portable_text() {
    let blocks = read(":::prompt[]\n  Child\n:::", ReadOptions::EXACT).unwrap();
    let portable = write_portable(&blocks, &PortableOptions::default());
    assert_eq!(portable.markdown, "Child");
    assert!(!portable.exact);
}
