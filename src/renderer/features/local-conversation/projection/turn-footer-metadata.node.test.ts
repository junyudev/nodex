import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { buildTurnFooterMetadata } from "./turn-footer-metadata";
import { buildTurnRenderModel } from "./build-turn-render-model";

function item(
  itemId: string,
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread",
    turnId: "turn",
    itemId,
    type: "assistantMessage",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    status: "completed",
    markdownText: "",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
function turn(
  items: CodexConversationItem[],
  overrides: Partial<CodexConversationTurn> = {},
): CodexConversationTurn {
  return {
    threadId: "thread",
    turnId: "turn",
    status: "completed",
    itemIds: items.map((entry) => entry.itemId),
    items,
    ...overrides,
  };
}

describe("turn footer metadata", () => {
  test("deduplicates skills across explicit input and command paths and preserves plugin roots", () => {
    const items = [
      item("input", {
        rawItem: {
          type: "userMessage",
          content: [{ type: "skill", path: "/work/.agents/skills/a/SKILL.md" }],
        },
      }),
      item("read", {
        commandActions: [
          {
            type: "read",
            command: "cat",
            name: "SKILL.md",
            path: "/work/.agents/skills/a/SKILL.md",
          },
          { type: "read", command: "cat", name: "other", path: "/work/ordinary.md" },
          {
            type: "read",
            command: "cat",
            name: "plugin",
            path: "/home/.codex/plugins/cache/bundled/demo/1.0/skills/b/SKILL.md",
          },
        ],
      }),
    ];
    const metadata = buildTurnFooterMetadata(turn(items), "/work");
    expect(metadata?.skills).toEqual([
      {
        path: "/home/.codex/plugins/cache/bundled/demo/1.0/skills/b/SKILL.md",
        name: "B",
        source: "Plugin",
        pluginId: "demo",
        pluginMarketplaceName: "bundled",
      },
      { path: "/work/.agents/skills/a/SKILL.md", name: "A", source: "Project" },
    ]);
    expect(buildTurnFooterMetadata(turn(items, { status: "inProgress" }), "/work")).toBeUndefined();
  });

  test("includes only decided timed command reviews and clamps negative duration", () => {
    const review = (id: string, status: string, completedAtMs: number | null) =>
      item(id, {
        rawItem: {
          type: "automaticApprovalReview",
          id,
          action: { type: "command", command: "ls /work" },
          status,
          startedAtMs: 20,
          completedAtMs,
          rationale: "Allowed by the user",
        },
      });
    const metadata = buildTurnFooterMetadata(
      turn([
        review("ok", "approved", 30),
        review("no", "denied", 10),
        review("pending", "inProgress", null),
        review("timeout", "timedOut", 50),
      ]),
    );
    expect(metadata?.reviews).toEqual([
      {
        id: "ok",
        command: "ls /work",
        decision: "accepted",
        durationMs: 10,
        rationale: "Allowed by the user",
      },
      {
        id: "no",
        command: "ls /work",
        decision: "rejected",
        durationMs: 0,
        rationale: "Allowed by the user",
      },
    ]);
  });

  test("uses the final assistant memory citations and excludes blank paths", () => {
    const citation = { path: "MEMORY.md", lineStart: 2, lineEnd: 5, note: "Project conventions" };
    const metadata = buildTurnFooterMetadata(
      turn([
        item("answer", {
          rawItem: {
            type: "agentMessage",
            memoryCitation: { entries: [citation, { ...citation, path: " " }] },
          },
        }),
      ]),
    );
    expect(metadata?.memories).toEqual([citation]);
  });

  test("rating does not depend on copyable text and preview permits streaming copy", () => {
    const answer = item("answer", { assistantPhase: "final_answer" });
    const completed = buildTurnRenderModel({
      turn: turn([answer]),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
    });
    expect(completed.buckets.assistantItem?.assistantMessageActions).toMatchObject({
      copyText: null,
      canRate: true,
    });
    const running = turn(
      [
        item("answer", {
          assistantPhase: "final_answer",
          markdownText: "Partial reply",
          status: "inProgress",
        }),
      ],
      { status: "inProgress" },
    );
    const preview = buildTurnRenderModel({
      turn: running,
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
      surface: "preview",
    });
    expect(preview.buckets.assistantItem?.assistantMessageActions).toMatchObject({
      copyText: "Partial reply",
      canRate: false,
      showTimestampWithoutActions: true,
    });
    const main = buildTurnRenderModel({
      turn: running,
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    expect(main.buckets.assistantItem?.assistantMessageActions).toBeUndefined();
  });
});
