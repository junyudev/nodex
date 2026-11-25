import { describe, expect, test } from "vite-plus/test";
import type { ConversationPromptTurn } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { buildLocalConversationPromptRailItems } from "./local-conversation-prompt-rail-model";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import type { VisibleConversationTurnEntry } from "../selectors";
import {
  buildThreadUserMessageNavigationItems,
  getThreadUserMessageNavigationVisibleOutputs,
} from "./thread-user-message-navigation-items";

describe("local conversation prompt rail model", () => {
  const indexedTurns = (count: number): ConversationPromptTurn[] =>
    Array.from({ length: count }, (_, index) => ({ turnId: `turn-${index + 1}` }));

  const residentItem = (
    turnId: string | null,
    label: string,
    id = `${turnId}:user:0`,
  ): ThreadUserMessageNavigationItem => ({
    id,
    turnId,
    turnKey: turnId ?? id,
    ordinal: 1,
    label,
    responsePreview: "resident response",
    outputs: [],
    isHeartbeat: false,
  });

  describe("local conversation prompt rail model", () => {
    test("keeps one item-free marker per indexed Turn and replaces only resident or previewed Turns", () => {
      const resident = residentItem("turn-999", "resident prompt");
      const items = buildLocalConversationPromptRailItems({
        turns: indexedTurns(1_000),
        residentItems: [resident],
        previewsByTurnId: new Map([
          [
            "turn-4",
            [
              {
                itemId: "prompt-4",
                promptPreview: "lazy prompt",
                responsePreview: "lazy response",
                isHeartbeat: false,
              },
            ],
          ],
        ]),
      });

      expect(items).toHaveLength(1_000);
      expect(items[0]).toMatchObject({
        label: "Load prompt preview",
        promptRailShell: { turnId: "turn-1", hasPreview: false },
      });
      expect(items[3]).toMatchObject({
        id: "turn-4:user:0",
        label: "lazy prompt",
        responsePreview: "lazy response",
        promptRailShell: { turnId: "turn-4", hasPreview: true },
      });
      expect(items[998]).toEqual({ ...resident, ordinal: 999 });
    });

    test("shows previews an owner read with its index without another read", () => {
      const [item] = buildLocalConversationPromptRailItems({
        turns: [
          {
            turnId: "run-1",
            previews: [
              {
                itemId: "message-1",
                promptPreview: "Align the theme",
                responsePreview: "Aligned",
                isHeartbeat: false,
              },
            ],
          },
        ],
        residentItems: [],
        previewsByTurnId: new Map(),
      });

      expect(item).toMatchObject({
        label: "Align the theme",
        responsePreview: "Aligned",
        promptRailShell: { turnId: "run-1", hasPreview: true },
      });
    });

    test("keeps resident markers outside the index in conversation order", () => {
      const items = buildLocalConversationPromptRailItems({
        turns: indexedTurns(3),
        residentItems: [
          residentItem(null, "imported prompt", "imported:user:0"),
          residentItem("turn-2", "second prompt"),
          residentItem("turn-unindexed", "between prompt"),
          residentItem("turn-3", "third prompt"),
          residentItem("turn-new", "newest prompt"),
        ],
        previewsByTurnId: new Map(),
      });

      expect(items.map((item) => item.label)).toEqual([
        "Load prompt preview",
        "imported prompt",
        "second prompt",
        "between prompt",
        "third prompt",
        "newest prompt",
      ]);
      expect(items.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("navigates resident messages alone without an index", () => {
      const resident = residentItem("turn-1", "resident prompt");
      expect(
        buildLocalConversationPromptRailItems({
          turns: null,
          residentItems: [resident],
          previewsByTurnId: new Map(),
        }),
      ).toEqual([resident]);
    });
  });
});

describe("thread user message navigation items", () => {
  function buildUserItem(
    turnId: string,
    index: number,
    markdownText: string,
  ): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: `user_${index}`,
      entryId: `user_${index}`,
      type: "user_message",
      kind: "userMessage",
      semanticKind: "userMessage",
      role: "user",
      markdownText,
      createdAt: index,
      updatedAt: index,
    };
  }

  function buildAssistantItem(
    turnId: string,
    index: number,
    markdownText = "Done",
  ): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: `assistant_${index}`,
      entryId: `assistant_${index}`,
      type: "assistant_message",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      assistantPhase: "final_answer",
      role: "assistant",
      markdownText,
      status: "completed",
      createdAt: index,
      updatedAt: index,
    };
  }

  function buildFileChangeItem(turnId: string): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: "file_1",
      entryId: "file_1",
      type: "file_change",
      kind: "fileChange",
      semanticKind: "patch",
      status: "completed",
      fileChange: {
        changes: buildCodexFileChangeMap([
          { type: "add", path: "src/app.ts", content: "export {};" },
        ]),
        label: "src/app.ts",
      },
      createdAt: 3,
      updatedAt: 3,
    };
  }

  function buildWebsiteItem(turnId: string): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: "web_1",
      entryId: "web_1",
      type: "web_search",
      kind: "toolCall",
      semanticKind: "webSearch",
      toolCall: {
        subtype: "webSearch",
        toolName: "web_search",
        args: { query: "reference docs" },
      },
      webSearch: {
        query: "reference docs",
        action: null,
        completed: true,
        sources: [],
      },
      markdownText: "https://example.com/reference",
      createdAt: 4,
      updatedAt: 4,
    };
  }

  function buildMcpAppItem(
    turnId: string,
    mcpAppResourceUri = "nodex://mcp-app/calendar/event",
  ): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: "mcp_1",
      entryId: "mcp_1",
      type: "mcpToolCall",
      kind: "toolCall",
      semanticKind: "mcpToolCall",
      status: "completed",
      mcpToolCall: {
        callId: "mcp_1",
        functionName: "calendar__open",
        pluginId: "calendar",
        readOnlyHint: false,
        mcpAppResourceUri,
        source: null,
        invocation: {
          server: "calendar",
          tool: "open",
          arguments: {},
        },
        result: {
          type: "success",
          content: [],
          structuredContent: null,
          raw: {
            content: [],
            structuredContent: null,
            _meta: null,
          },
        },
        durationMs: 1,
        completed: true,
      },
      createdAt: 5,
      updatedAt: 5,
    };
  }

  function buildImageItem(turnId: string): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId: "image_1",
      entryId: "image_1",
      type: "dynamicToolCall",
      kind: "toolCall",
      semanticKind: "dynamicToolCall",
      status: "completed",
      dynamicToolCall: {
        callId: "image_1",
        namespace: "image",
        tool: "generate",
        arguments: {},
        status: "completed",
        contentItems: [{ type: "inputImage", imageUrl: "nodex://assets/image.png" }],
        success: true,
        durationMs: 1,
        completed: true,
      },
      createdAt: 6,
      updatedAt: 6,
    };
  }

  function buildGitItem(
    turnId: string,
    itemId: string,
    markdownText: string,
  ): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId,
      entryId: itemId,
      type: "assistant_message",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      role: "assistant",
      markdownText,
      status: "completed",
      createdAt: 7,
      updatedAt: 7,
    };
  }

  function buildTurn(turnId: string, items: CodexConversationItem[]): CodexConversationTurn {
    return {
      threadId: "thread_1",
      turnId,
      status: "completed",
      itemIds: items.map((item) => item.itemId),
      items,
    };
  }

  function buildEntry(
    turn: CodexConversationTurn,
    isMostRecentTurn = false,
  ): VisibleConversationTurnEntry {
    const turnKey = turn.turnId ?? "turn-index-0";
    return {
      turn,
      turnId: turn.turnId,
      turnKey,
      turnSearchKey: turnKey,
      requests: [],
      isMostRecentTurn,
    };
  }

  describe("thread user message navigation items", () => {
    test("builds one rail item for each rendered user message", () => {
      const entries = [1, 2, 3, 4].map((index) => {
        const turnId = `turn_${index}`;
        return buildEntry(
          buildTurn(turnId, [
            buildUserItem(turnId, 1, `Message ${index}`),
            buildAssistantItem(turnId, 2, `Answer ${index}`),
          ]),
          index === 4,
        );
      });

      const items = buildThreadUserMessageNavigationItems(entries);

      expect(items.length).toBe(4);
      expect(items.map((item) => item.id).join(",")).toBe(
        "turn_1:user:0,turn_2:user:0,turn_3:user:0,turn_4:user:0",
      );
      expect(items[3]?.label).toBe("Message 4");
      expect(items[3]?.responsePreview).toBe("Answer 4");
    });

    test("uses Codex-compatible labels for empty and implement-plan prompts", () => {
      const items = buildThreadUserMessageNavigationItems([
        buildEntry(
          buildTurn("turn_empty", [
            buildUserItem("turn_empty", 1, ""),
            buildAssistantItem("turn_empty", 2, "Empty handled"),
          ]),
        ),
        buildEntry(
          buildTurn("turn_plan", [
            buildUserItem("turn_plan", 1, "PLEASE IMPLEMENT THIS PLAN:\n- ship it"),
            buildAssistantItem("turn_plan", 2, "Plan implemented"),
          ]),
        ),
      ]);

      expect(items[0]?.label).toBe("(No content)");
      expect(items[0]?.responsePreview).toBe("Empty handled");
      expect(items[1]?.label).toBe("Yes, implement this plan");
    });

    test("keeps later user messages addressable inside the same turn", () => {
      const items = buildThreadUserMessageNavigationItems([
        buildEntry(
          buildTurn("turn_multi", [
            buildUserItem("turn_multi", 1, "First request"),
            buildAssistantItem("turn_multi", 2, "First answer"),
            buildUserItem("turn_multi", 3, "Follow-up"),
            buildAssistantItem("turn_multi", 4, "Second answer"),
          ]),
        ),
      ]);

      expect(items.length).toBe(2);
      expect(items.map((item) => item.id).join(",")).toBe("turn_multi:user:0,turn_multi:user:1");
      expect(items[1]?.label).toBe("Follow-up");
    });

    test("sorts, dedupes, and caps output pills", () => {
      const turnId = "turn_outputs";
      const items = buildThreadUserMessageNavigationItems([
        buildEntry(
          buildTurn(turnId, [
            buildUserItem(turnId, 1, "Create outputs"),
            buildMcpAppItem(turnId),
            buildWebsiteItem(turnId),
            buildFileChangeItem(turnId),
            buildImageItem(turnId),
            buildGitItem(turnId, "commit_1", '::git-commit{cwd="/tmp"}'),
            buildGitItem(turnId, "pr_1", '::git-create-pr{url="https://example.com/pr"}'),
          ]),
        ),
      ]);

      const outputs = items[0]?.outputs ?? [];
      expect(outputs.map((output) => output.type).join(",")).toBe(
        "app,website,file,image,commit,pull-request",
      );

      const visible = getThreadUserMessageNavigationVisibleOutputs(outputs);
      expect(visible.length).toBe(3);
      expect(visible.map((output) => output.label).join(",")).toBe("calendar,Web,+4");
    });

    test("classifies Google Drive only from exact domains and their subdomains", () => {
      const buildOutputs = (resourceUri: string) => {
        const turnId = "turn_drive_domain";
        return (
          buildThreadUserMessageNavigationItems([
            buildEntry(
              buildTurn(turnId, [
                buildUserItem(turnId, 1, "Open output"),
                buildMcpAppItem(turnId, resourceUri),
              ]),
            ),
          ])[0]?.outputs ?? []
        );
      };

      expect(
        buildOutputs("https://drive.google.com/file/d/1").some(
          ({ type }) => type === "google-drive",
        ),
      ).toBe(true);
      expect(
        buildOutputs("https://lh3.googleusercontent.com/image.png").some(
          ({ type }) => type === "google-drive",
        ),
      ).toBe(true);
      expect(
        buildOutputs("https://drive.google.com.attacker.example/file").some(
          ({ type }) => type === "google-drive",
        ),
      ).toBe(false);
    });
  });
});
