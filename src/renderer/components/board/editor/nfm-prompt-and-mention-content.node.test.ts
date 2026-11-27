import { describe, expect, test, it } from "vite-plus/test";
import { buildDateMentionUpdate } from "./date-mention-inline-content";
import { findInlineMathInputRuleMatch } from "@blocknote/math-block";
import {
  describeNfmPromptSend,
  describeNfmPromptTurnState,
  findNfmPromptBlockAtCaret,
  matchesNodexAgentMention,
  nfmPromptStartsNewTurn,
  resolveNfmPromptSendAnchor,
  resolveNfmPromptSentPresentation,
} from "./nfm-prompt-block-model";

describe("date mention inline content", () => {
  test("repairs reversed ranges before emitting an inline-content update", () => {
    const update = buildDateMentionUpdate(
      {
        start: "2050-06-30",
        end: "2050-06-28",
        format: "ll",
      },
      {},
    );

    expect(update.props.start).toBe("2050-06-28");
    expect(update.props.end).toBe("2050-06-30");
    expect(update.props.format).toBe("ll");
  });
});

describe("inline Equation typing syntax", () => {
  it.each([
    ["$$x$$", "x"],
    ["before $$x + y$$", "x + y"],
    ["($$x^$$", "x^"],
    [String.raw`$$x\$y$$`, String.raw`x\$y`],
  ])("recognizes %s", (text, source) => {
    const match = findInlineMathInputRuleMatch(text);

    expect(match?.data.delimitedSource).toBe(`$$${source}$$`);
    expect(match?.data.source).toBe(source);
  });

  it.each([
    "$x$",
    "$$$$",
    "$$ x$$",
    "$$x $$",
    "$$x$",
    "before$$x$$",
    "0$$x$$",
    "_$$x$$",
    "[$$x$$",
    "{$$x$$",
    ".$$x$$",
    ",$$x$$",
    ":$$x$$",
    ";$$x$$",
    "!$$x$$",
    "?$$x$$",
    "-$$x$$",
    "+$$x$$",
    "=$$x$$",
    "‘$$x$$",
    "“$$x$$",
    "—$$x$$",
    String.raw`\$$x$$`,
  ])("keeps %s as literal text", (text) => {
    expect(findInlineMathInputRuleMatch(text)).toBeNull();
  });
});

describe("Prompt block model", () => {
  test("names where a send goes, and a repeat send", () => {
    const beside = { kind: "beside", sessionId: "s1", title: "Fix landing page" } as const;
    expect(describeNfmPromptSend(beside, false)).toBe("Send to Fix landing page");
    expect(describeNfmPromptSend(beside, true)).toBe("Send again to Fix landing page");
    expect(describeNfmPromptSend({ kind: "new-chat" }, false)).toBe("Send to a new chat");
  });

  test("shows the Prompt's own Turn, and only when it went once nothing more is known", () => {
    const sentAt = "2026-10-31T08:00:00.000Z";
    const nowMs = Date.parse("2026-10-31T08:05:00.000Z");
    const label = (phase: Parameters<typeof resolveNfmPromptSentPresentation>[0]["phase"]) =>
      resolveNfmPromptSentPresentation({ phase, sentAt, nowMs });
    expect(label("queued")).toEqual({ tone: "idle", label: "Queued" });
    expect(label("working")).toEqual({ tone: "working", label: "Working…" });
    expect(label("waiting")).toEqual({ tone: "attention", label: "Needs you" });
    expect(label("done")).toEqual({ tone: "done", label: "Answered" });
    expect(label("failed")).toEqual({ tone: "attention", label: "Failed" });
    expect(label("interrupted")).toEqual({ tone: "idle", label: "Stopped" });
    expect(label("unknown")).toEqual({ tone: "idle", label: "Sent 5m ago" });
    expect(label(null)).toEqual({ tone: "idle", label: "Sent 5m ago" });
    expect(resolveNfmPromptSentPresentation({ phase: null, sentAt: "", nowMs }).label).toBe("Sent");
  });

  test("explains a Turn that has no reply to show", () => {
    expect(describeNfmPromptTurnState("queued")).toBe(
      "Queued until the chat finishes its current turn.",
    );
    expect(describeNfmPromptTurnState("failed")).toBe(
      "This turn failed. Open the chat to see why.",
    );
    expect(describeNfmPromptTurnState(null)).toBe("The chat no longer has a record of this send.");
  });

  test("finds the Prompt holding the caret through its own children", () => {
    const blocks = {
      prompt: { id: "prompt", type: "prompt" },
      child: { id: "child", type: "paragraph" },
      outside: { id: "outside", type: "paragraph" },
    } as const;
    const parents: Record<string, keyof typeof blocks | undefined> = { child: "prompt" };
    const editorAt = (id: keyof typeof blocks) => ({
      getTextCursorPosition: () => ({ block: { id } }),
      getBlock: (blockId: string) => blocks[blockId as keyof typeof blocks],
      getParentBlock: (blockId: string) => {
        const parent = parents[blockId];
        return parent ? blocks[parent] : undefined;
      },
    });
    expect(findNfmPromptBlockAtCaret(editorAt("child"))).toBe("prompt");
    expect(findNfmPromptBlockAtCaret(editorAt("prompt"))).toBe("prompt");
    expect(findNfmPromptBlockAtCaret(editorAt("outside"))).toBeNull();
  });

  test("Agent config anywhere in a Prompt makes its send a Turn of its own", () => {
    const text = { type: "text", text: "Review", styles: {} };
    expect(nfmPromptStartsNewTurn({ type: "prompt", content: [text], children: [] })).toBe(false);
    expect(
      nfmPromptStartsNewTurn({
        type: "prompt",
        content: [text],
        children: [
          { type: "paragraph", content: [{ type: "agentConfig", props: { mode: "plan" } }] },
        ],
      }),
    ).toBe(true);
    expect(
      nfmPromptStartsNewTurn({
        type: "prompt",
        content: [{ type: "link", content: [{ type: "agentConfig", props: {} }] }],
      }),
    ).toBe(true);
  });
});

describe("Prompt send anchor", () => {
  const line = { left: 0, right: 300, top: 40, bottom: 60 };

  test("follows the last line of text while that line has room for the button", () => {
    expect(resolveNfmPromptSendAnchor({ lastLine: line, width: 400 })).toEqual({
      placement: "inline",
      left: 304,
      top: 38,
    });
  });

  test("takes a row beneath the text when the last line is full", () => {
    expect(resolveNfmPromptSendAnchor({ lastLine: line, width: 320 })).toEqual({
      placement: "below",
      left: 0,
      top: 64,
    });
  });

  test("sits at the start of the column before any text is measured", () => {
    expect(resolveNfmPromptSendAnchor({ lastLine: null, width: 400 })).toEqual({
      placement: "inline",
      left: 0,
      top: 0,
    });
  });
});

describe("Nodex agent mention", () => {
  test("offers Nodex for an empty query or a prefix of its name, and not for other text", () => {
    expect(matchesNodexAgentMention("")).toBe(true);
    expect(matchesNodexAgentMention("no")).toBe(true);
    expect(matchesNodexAgentMention("Agent")).toBe(true);
    expect(matchesNodexAgentMention("landing")).toBe(false);
  });
});
