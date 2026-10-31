import { describe, expect, test } from "vite-plus/test";
import {
  describeNfmPromptSend,
  describeNfmPromptTurnState,
  findNfmPromptBlockAtCaret,
  nfmPromptStartsNewTurn,
  resolveNfmPromptSentPresentation,
} from "./nfm-prompt-block-model";

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
