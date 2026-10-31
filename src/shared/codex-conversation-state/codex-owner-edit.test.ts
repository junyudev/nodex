import { expect, test, vi } from "vite-plus/test";
import { parseLocalImagePath } from "../image-source";
import { produce } from "immer";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { mutateCodexCanonicalRevert } from "./codex-revert-state";
import { residentConversationTurns } from "./codex-turn-mutation";
import {
  editCanonicalUserTurn,
  replaceCanonicalEditedPrompt,
  type CanonicalEditClient,
} from "./codex-owner-edit";
import type {
  ThreadRevertResponse,
  Thread,
  Turn,
  TurnStartParams,
} from "@nodex/codex-app-server-protocol/v2";

function harness(
  options: {
    historyMode?: "legacy" | "paginated";
    ephemeral?: boolean;
    supportsRevert?: boolean;
    input?: TurnStartParams["input"];
    resolveImageInput?: CanonicalEditClient["resolveImageInput"];
    /** Later Turns after the edited message; by default one automatic Turn without user input. */
    later?: ReadonlyArray<{
      readonly id: string;
      readonly input: TurnStartParams["input"];
      readonly status?: Turn["status"];
    }>;
  } = {},
) {
  const later = options.later ?? [{ id: "automatic", input: [] }];
  const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
    rootTurnId: null,
    id,
    status,
    itemsView: "full",
    items: [],
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
  const thread: Thread = {
    ...buildAgentActivityV2CorpusThread([]),
    historyMode: options.historyMode ?? "paginated",
    ephemeral: options.ephemeral ?? false,
    turns: [turn("message"), ...later.map((entry) => turn(entry.id, entry.status))],
  };
  let state: CodexCanonicalConversationState = {
    ...createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "m",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    }),
    lastInjectedPassiveContextKey: "confirmed-before-revert",
  };
  state = produce(state, (draft) => {
    draft.turns[0]!.params.input = options.input ?? [
      { type: "text", text: "# Files\n## My request for Codex:\nold", text_elements: [] },
      { type: "localImage", path: "/image.png" },
    ];
    later.forEach((entry, index) => {
      draft.turns[index + 1]!.params.input = entry.input;
    });
    replaceCanonicalHistoryDraft(draft, draft.turns, false);
  });
  const calls: string[] = [];
  const starts: TurnStartParams[] = [];
  const response: ThreadRevertResponse = {
    thread: { ...thread, turns: [], cwd: "/returned" },
    turnsBackwardsCursor: "retained",
    itemsBackwardsCursor: "items",
  };
  const client: CanonicalEditClient = {
    getConversation: () => state,
    awaitSettings: async () => {
      calls.push("settings");
    },
    supportsRevert: () => options.supportsRevert ?? true,
    resolveImageInput:
      options.resolveImageInput ??
      ((source) => {
        const path = parseLocalImagePath(source);
        if (path) return { type: "localImage", path };
        if (source.startsWith("data:image/")) return { type: "image", url: source };
        throw new Error(`Unsupported image source: ${source}`);
      }),

    revert: async (_id, before) => {
      calls.push(`revert:${before}`);
      return response;
    },
    applyRevert: (_id, result, turns) => {
      state = produce(state, (draft) =>
        mutateCodexCanonicalRevert(draft, result, new Set(turns.map((turn) => turn.turnId))),
      );
    },
    start: async (request, _original, preparedPrompt) => {
      expect(preparedPrompt.inputItems).toEqual(request.input);
      expect(preparedPrompt.pendingInputItems).toEqual(request.input);
      starts.push(request);
    },
  };
  return { client, calls, starts, read: () => state };
}

test("editing the latest message also reverts trailing automatic turns and keeps non-text input", async () => {
  const f = harness();
  await editCanonicalUserTurn(f.client, "id", {
    turnId: "message",
    message: "new",
  });
  expect(f.calls).toEqual(["settings", "revert:message"]);
  expect(f.starts[0]?.input).toEqual([
    { type: "text", text: "# Files\n## My request:\nnew\n", text_elements: [] },
    { type: "localImage", path: "/image.png" },
  ]);
  expect(f.starts[0]?.turnTrigger).toBe("edit_user_message");
  expect(f.read().lastInjectedPassiveContextKey).toBeUndefined();
  expect(residentConversationTurns(f.read())).toEqual([]);
  expect(f.read().turnHistory?.history.islands.at(-1)?.olderBoundary).toMatchObject({
    status: "available",
    handle: { cursor: "retained", oldestLoadedTurnId: null },
  });
  expect(f.read().paginatedHistory).toEqual({ itemsBackwardsCursor: "items" });
});

test("editing projects written images after the original image inputs", async () => {
  const f = harness();
  await editCanonicalUserTurn(f.client, "id", {
    turnId: "message",
    message: "![shot](/tmp/x.png)",
  });
  expect(f.starts[0]?.input).toEqual([
    {
      type: "text",
      text: "# Files\n## My request:\n[Image #2] (caption: shot; path: /tmp/x.png)\n",
      text_elements: [],
    },
    { type: "localImage", path: "/image.png" },
    { type: "localImage", path: "/tmp/x.png" },
  ]);
});

test("editing keeps hosted images and appends written data, file URL and materialized Library images in order", async () => {
  const f = harness({ input: [{ type: "image", fileId: "file_123", detail: "high" }] });
  await editCanonicalUserTurn(f.client, "id", {
    turnId: "message",
    message:
      "![inline](data:image/png;base64,AQID)\n\n![disk](file:///tmp/my%20shot.png)\n\n![library](nodex://files/shot)\n\n![web](https://example.com/web.png)",
    writtenImages: [
      { source: "data:image/png;base64,AQID" },
      { source: "file:///tmp/my%20shot.png" },
      { source: "data:image/png;base64,BAUG" },
    ],
  });
  expect(f.starts[0]?.input).toEqual([
    {
      type: "text",
      text: "[Image #2] (caption: inline)\n\n[Image #3] (caption: disk; path: /tmp/my shot.png)\n\n[Image #4] (caption: library)\n\n![web](https://example.com/web.png)",
      text_elements: [],
    },
    { type: "image", fileId: "file_123", detail: "high" },
    { type: "image", url: "data:image/png;base64,AQID" },
    { type: "localImage", path: "/tmp/my shot.png" },
    { type: "image", url: "data:image/png;base64,BAUG" },
  ]);
});

test("an unavailable written image leaves the original history intact", async () => {
  const resolveImageInput = vi.fn(() => {
    throw new Error("Image unavailable");
  });
  const f = harness({ resolveImageInput });
  await expect(
    editCanonicalUserTurn(f.client, "id", {
      turnId: "message",
      message: "![shot](nodex://assets/shot.png)",
    }),
  ).rejects.toThrow("Image unavailable");
  expect(resolveImageInput).toHaveBeenCalledExactlyOnceWith("nodex://assets/shot.png");
  expect(f.calls).toEqual(["settings"]);
  expect(f.starts).toEqual([]);
  expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual([
    "message",
    "automatic",
  ]);
});

test.each(["  rewritten\n\ntext  ", "", "![web](https://example.com/web.png)"])(
  "editing without written images preserves exact text and other inputs (%j)",
  async (message) => {
    const original: TurnStartParams["input"] = [
      { type: "image", fileId: "file_123" },
      {
        type: "text",
        text: "old",
        text_elements: [{ byteRange: { start: 0, end: 3 }, placeholder: "old" }],
      },
      { type: "text", text: "retained context", text_elements: [] },
      { type: "mention", name: "notes", path: "/notes.md" },
    ];
    const f = harness({ input: original });
    await editCanonicalUserTurn(f.client, "id", { turnId: "message", message });
    expect(f.starts[0]?.input).toEqual([
      original[0],
      { type: "text", text: message, text_elements: [] },
      ...original.slice(2),
    ]);
  },
);

test("editing an earlier message reverts it with every later user Turn", async () => {
  const f = harness({
    later: [
      { id: "follow-up", input: [{ type: "text", text: "follow up", text_elements: [] }] },
      { id: "latest", input: [{ type: "text", text: "latest", text_elements: [] }] },
    ],
  });
  await editCanonicalUserTurn(f.client, "id", { turnId: "message", message: "rewritten" });

  expect(f.calls).toEqual(["settings", "revert:message"]);
  expect(f.starts[0]?.input).toEqual([
    { type: "text", text: "# Files\n## My request:\nrewritten\n", text_elements: [] },
    { type: "localImage", path: "/image.png" },
  ]);
  expect(residentConversationTurns(f.read())).toEqual([]);
});

test("editing waits for every later Turn to settle", async () => {
  const f = harness({
    later: [
      {
        id: "running",
        input: [{ type: "text", text: "still going", text_elements: [] }],
        status: "inProgress",
      },
    ],
  });

  await expect(
    editCanonicalUserTurn(f.client, "id", { turnId: "message", message: "rewritten" }),
  ).rejects.toThrow("Cannot edit a message while a turn is in progress.");
  expect(f.calls).toEqual(["settings"]);
  expect(f.starts).toEqual([]);
});

test("editing an attachment-only message sends the new text alongside its image", async () => {
  const f = harness({ input: [{ type: "image", fileId: "file_123" }] });
  await editCanonicalUserTurn(f.client, "id", { turnId: "message", message: "Describe it" });

  expect(f.starts[0]?.input).toEqual([
    { type: "text", text: "Describe it", text_elements: [] },
    { type: "image", fileId: "file_123" },
  ]);
});

test.each([{ historyMode: "legacy" as const }, { ephemeral: true }, { supportsRevert: false }])(
  "rejects unsupported message edits before native mutation (%j)",
  async (options) => {
    const f = harness(options);
    await expect(
      editCanonicalUserTurn(f.client, "id", { turnId: "message", message: "new" }),
    ).rejects.toThrow("Editing messages requires");
    expect(f.calls).toEqual(["settings"]);
    expect(f.starts).toEqual([]);
  },
);

test("prompt editing replaces only the last request marker and resets plain text", () => {
  expect(
    replaceCanonicalEditedPrompt(
      "one\n## My request:\nquoted\n## My request for Codex:\nold",
      "new",
    ),
  ).toBe("one\n## My request:\nquoted\n## My request:\nnew\n");
  expect(replaceCanonicalEditedPrompt("plain old", "new")).toBe("new");
});
