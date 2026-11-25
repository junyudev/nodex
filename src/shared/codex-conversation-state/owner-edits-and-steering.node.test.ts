import { expect, test, vi, describe } from "vite-plus/test";
import { parseLocalImagePath } from "../image-source";
import { produce, castDraft } from "immer";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalSteeringUserMessageItem,
  mergeCodexCanonicalTurnState,
  mergeCodexCanonicalTurnStates,
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
  UserInput,
  ThreadItem,
} from "@nodex/codex-app-server-protocol/v2";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import {
  runCanonicalOwnerSteer,
  type CanonicalOwnerSteerClient,
  type CanonicalSteerNativeRequest,
} from "./codex-owner-steer";
import type { CodexTurnDelivery } from "./codex-turn-delivery";
import {
  buildCodexSteeringCompareKey,
  serializeCodexSteeringCompareKey,
} from "./codex-steering-compare";
import { mergeCodexResumedHistory } from "./codex-history-resume";

describe("codex owner edit", () => {
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
      prepareStart: async (request, _original, preparedPrompt) => {
        expect(preparedPrompt.inputItems).toEqual(request.input);
        expect(preparedPrompt.pendingInputItems).toEqual(request.input);
        return {
          start: async () => {
            starts.push(request);
          },
          release: vi.fn(),
        };
      },
    };
    return { client, calls, starts, read: () => state };
  }

  test("editing the latest message also reverts trailing automatic turns and keeps non-text input", async () => {
    const f = harness();
    await editCanonicalUserTurn(f.client, "id", {
      images: [{ source: "/image.png" }],
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
      images: [{ source: "/image.png" }],
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
      images: [{ source: "file-service://file_123" }],
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
        images: [{ source: "/image.png" }],
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
      await editCanonicalUserTurn(f.client, "id", {
        images: [{ source: "file-service://file_123" }],
        turnId: "message",
        message,
      });
      expect(f.starts[0]?.input).toEqual([
        { type: "text", text: message, text_elements: [] },
        ...original.slice(2),
        original[0],
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
    await editCanonicalUserTurn(f.client, "id", {
      images: [{ source: "/image.png" }],
      turnId: "message",
      message: "rewritten",
    });

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
      editCanonicalUserTurn(f.client, "id", {
        images: [{ source: "/image.png" }],
        turnId: "message",
        message: "rewritten",
      }),
    ).rejects.toThrow("Cannot edit a message while a turn is in progress.");
    expect(f.calls).toEqual(["settings"]);
    expect(f.starts).toEqual([]);
  });

  test("editing an attachment-only message sends the new text alongside its image", async () => {
    const f = harness({ input: [{ type: "image", fileId: "file_123" }] });
    await editCanonicalUserTurn(f.client, "id", {
      images: [{ source: "file-service://file_123" }],
      turnId: "message",
      message: "Describe it",
    });

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
        editCanonicalUserTurn(f.client, "id", {
          images: [{ source: "/image.png" }],
          turnId: "message",
          message: "new",
        }),
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

  test("the selected image order replaces originals, preserving native detail and non-image inputs", async () => {
    const kept = {
      type: "image" as const,
      url: "https://example.com/kept.png",
      detail: "high" as const,
    };
    const mention = { type: "mention" as const, name: "notes", path: "/notes" };
    const f = harness({ input: [{ type: "localImage", path: "/missing.png" }, kept, mention] });
    await editCanonicalUserTurn(f.client, "id", {
      turnId: "message",
      message: "",
      images: [{ source: "/new.png" }, { source: kept.url }],
    });
    expect(f.starts[0]?.input).toEqual([
      { type: "text", text: "", text_elements: [] },
      mention,
      { type: "localImage", path: "/new.png" },
      kept,
    ]);
  });

  test("an empty selection removes every original image", async () => {
    const f = harness();
    await editCanonicalUserTurn(f.client, "id", { turnId: "message", message: "text", images: [] });
    expect(f.starts[0]?.input).toEqual([
      { type: "text", text: "# Files\n## My request:\ntext\n", text_elements: [] },
    ]);
  });

  test("a failing new image leaves revert uncalled", async () => {
    const f = harness({
      resolveImageInput: () => {
        throw new Error("Unreadable image");
      },
    });
    await expect(
      editCanonicalUserTurn(f.client, "id", {
        turnId: "message",
        message: "",
        images: [{ source: "/new.png" }],
      }),
    ).rejects.toThrow("Unreadable image");
    expect(f.calls).toEqual(["settings"]);
  });

  test.each(["revert", "start", "success"])(
    "prepared native resources are released on %s",
    async (failure) => {
      const f = harness();
      const release = vi.fn();
      const prepareStart = async () => {
        return {
          start: async () => {
            if (failure === "start") throw new Error("start failed");
          },
          release,
        };
      };
      const revert = vi.fn(async () => {
        if (failure === "revert") throw new Error("revert failed");
        return {} as ThreadRevertResponse;
      });
      const edit = editCanonicalUserTurn(
        { ...f.client, prepareStart, revert, applyRevert: () => {} },
        "id",
        { turnId: "message", message: "text", images: [] },
      );
      if (failure === "success") await edit;
      else await expect(edit).rejects.toThrow(`${failure} failed`);
      expect(release).toHaveBeenCalledOnce();
      expect(revert).toHaveBeenCalledOnce();
    },
  );

  test("native preparation failure leaves revert and history untouched", async () => {
    const f = harness();
    const original = f.read();
    const revert = vi.fn(f.client.revert);
    await expect(
      editCanonicalUserTurn(
        {
          ...f.client,
          revert,
          prepareStart: async () => {
            throw new Error("Image capture failed");
          },
        },
        "id",
        { turnId: "message", message: "new", images: [] },
      ),
    ).rejects.toThrow("Image capture failed");
    expect(revert).not.toHaveBeenCalled();
    expect(f.read()).toBe(original);
  });
});

describe("codex owner steer", () => {
  function buildState(): CodexCanonicalConversationState {
    return createCodexCanonicalHydratedConversationState(
      {
        model: null,
        reasoningEffort: null,
        id: "thread-a",
        environments: null,
        extra: null,
        sessionId: "session-a",
        forkedFromId: null,
        attachedToThreadId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        modelProvider: "openai",
        createdAt: 0,
        updatedAt: 0,
        recencyAt: null,
        status: { type: "active", activeFlags: [] },
        path: null,
        cwd: "/workspace",
        cliVersion: "test",
        originator: null,
        source: "appServer",
        canAcceptDirectInput: true,
        threadSource: "appServer",
        name: null,
        daybreakEnabled: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        turns: [
          {
            rootTurnId: null,
            id: "turn-a",
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
      {
        hostId: "local",
        ...{
          model: "gpt-test",
          reasoningEffort: null,
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: [],
        },
      },
    );
  }

  function buildSteer(id = "steer-a"): CodexCanonicalSteeringUserMessageItem {
    return {
      type: "steeringUserMessage",
      id,
      targetTurnId: "turn-a",
      targetTurnStartedAtMs: 10,
      status: "pending",
      clientUserMessageId: id,
      input: [{ type: "text", text: "continue", text_elements: [] }],
      attachments: [{ path: "/workspace/file.ts" }],
      restoreMessage: {
        queueRow: createCodexQueuedFollowUp({
          followUpId: `follow-up-${id}`,
          clientUserMessageId: `client-${id}`,
          threadId: "thread-a",
          prompt: "continue",
          createdAtMs: 10,
        }),
        context: { commentAttachments: [] },
      },
      compareKey: { rawText: "continue", imageCount: 0 },
    };
  }

  function harness(sendNative: CanonicalOwnerSteerClient["sendNative"]) {
    let state = buildState();
    const requests: CanonicalSteerNativeRequest[] = [];
    const item = buildSteer();
    const client: CanonicalOwnerSteerClient = {
      read: () => state,
      update: (recipe) => {
        state = produce(state, recipe);
      },
      subscribe: () => ({ [Symbol.dispose]() {} }),
      onDispose: () => ({ [Symbol.dispose]() {} }),
      createId: () => "steer-a",
      sendNative: (request, options) => {
        requests.push(request);
        return sendNative(request, options);
      },
      outcomeUnknown: () => null,
      mismatchTurnId: (error) =>
        error instanceof Error && error.message === "mismatch" ? "turn-b" : null,
      isLocalHost: true,
      emitSteered() {},
    };
    return {
      client,
      requests,
      read: () => state,
      input: {
        conversationId: "thread-a",
        input: [...item.input],
        restoreMessage: item.restoreMessage,
        clientUserMessageId: "client-a",
      },
    };
  }
  test("steers the execution Turn when a completed local marker follows it", async () => {
    const h = harness(async (request) => ({
      turnId: request.method === "turn/steer" ? request.params.expectedTurnId : "unexpected",
    }));
    h.client.update((draft) => {
      draft.turns.push({ ...draft.turns[0]!, turnId: null, status: "completed", items: [] });
    });
    expect(await runCanonicalOwnerSteer(h.client, h.input)).toEqual({ turnId: "turn-a" });
    expect(h.requests).toHaveLength(1);
    expect(h.read().turns[0]!.items).toEqual([
      expect.objectContaining({ type: "steeringUserMessage", targetTurnId: "turn-a" }),
    ]);
    expect(h.read().turns[1]!.items).toEqual([]);
  });

  test("steers the resident canonical Turn without mutating the display overlay", async () => {
    const h = harness(async (request) => ({
      turnId: request.method === "turn/steer" ? request.params.expectedTurnId : "unexpected",
    }));
    h.client.update((draft) => {
      const execution = draft.turns[0]!;
      replaceCanonicalHistoryDraft(
        draft,
        [execution, { ...execution, turnId: null, status: "completed", items: [] }],
        true,
      );
      draft.turns = [{ ...execution, turnId: "display-only", items: [] }];
    });
    await expect(runCanonicalOwnerSteer(h.client, h.input)).resolves.toEqual({ turnId: "turn-a" });
    const resident = residentConversationTurns(h.read());
    expect(resident[0]?.items).toEqual([
      expect.objectContaining({ clientUserMessageId: "client-a", status: "accepted" }),
    ]);
    expect(resident[1]?.items).toEqual([]);
    expect(h.read().turns[0]?.items).toEqual([]);
  });

  test("preserves a display Turn identity when native steering corrects its wrapped protocol ID", async () => {
    let attempts = 0;
    const h = harness(async () => {
      if (++attempts === 1) throw new Error("mismatch");
      return { turnId: "turn-b" };
    });
    h.client.update((draft) => {
      draft.turns[0]!.turnId = "turn-b-berry-display-1";
    });
    await expect(runCanonicalOwnerSteer(h.client, h.input)).resolves.toEqual({ turnId: "turn-b" });
    expect(
      h.requests.map((request) =>
        request.method === "turn/steer" ? request.params.expectedTurnId : null,
      ),
    ).toEqual(["turn-b-berry-display-1", "turn-b"]);
    expect(h.read().turns[0]?.turnId).toBe("turn-b-berry-display-1");
    expect(h.read().turns[0]?.items[0]).toMatchObject({
      targetTurnId: "turn-b-berry-display-1",
      status: "accepted",
    });
  });

  test("retains unknown steering until late native result then accepts and clears its receipt", async () => {
    let finish!: (result: { turnId: string }) => void;
    const h = harness((_request, options) => {
      options.onOutcomeUnknown({
        requestId: "request-a",
        method: "turn/steer",
        stage: "outcome-unknown",
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = runCanonicalOwnerSteer(h.client, h.input);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.read().unconfirmedTurnSubmissions?.[0]?.clientUserMessageId).toBe("client-a");
    await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow(
      "earlier turn submission",
    );
    finish({ turnId: "turn-a" });
    expect(await result).toEqual({ turnId: "turn-a" });
    expect(h.read().unconfirmedTurnSubmissions).toBeUndefined();
    expect(h.read().turns[0]?.items[0]).toMatchObject({
      type: "steeringUserMessage",
      status: "accepted",
    });
  });
  test("retries one corrected turn identity and removes optimistic state on a definite failure", async () => {
    let attempts = 0;
    const h = harness(async () => {
      if (++attempts === 1) throw new Error("mismatch");
      throw new Error("rejected");
    });
    h.client.update((draft) => {
      draft.turns[0]!.items.push(castDraft(buildSteer("unrelated-message")));
    });
    await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow("rejected");
    expect(
      h.requests.map((request) =>
        request.method === "turn/steer" ? request.params.expectedTurnId : null,
      ),
    ).toEqual(["turn-a", "turn-b"]);
    expect(h.read().turns[0]?.turnId).toBe("turn-b");
    expect(h.read().turns[0]?.items).toEqual([
      expect.objectContaining({ id: "unrelated-message" }),
    ]);
  });
  test("unknown delivery failure retains its optimistic row and submission fence", async () => {
    const delivery: CodexTurnDelivery = {
      requestId: "request-a",
      method: "turn/steer",
      stage: "outcome-unknown",
    };
    const error = new Error("disconnected");
    const h = harness(async () => {
      throw error;
    });
    h.client.outcomeUnknown = (failure) => (failure === error ? delivery : null);
    await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow("disconnected");
    expect(h.read().turns[0]?.items[0]).toMatchObject({ status: "pending" });
    expect(h.read().unconfirmedTurnSubmissions).toEqual([
      { ...delivery, clientUserMessageId: "client-a" },
    ]);
  });
});

describe("Codex steering compare key", () => {
  test("excludes serialized comment labels and image placeholders without live attachments", () => {
    const serializedPrompt = [
      "",
      "# Browser comments:",
      "## Comment 1",
      "File: browser:fixture",
      "Lines: 7",
      "Attached image: 1 additional labeled image for Comment 1",
      "",
      "## My request for Codex:",
      "steer fixture",
    ].join("\n");
    const label =
      "The next image was attached by the user as additional visual context for Comment 7.";
    const input = [
      { type: "text", text: serializedPrompt, text_elements: [] },
      { type: "text", text: label, text_elements: [] },
      { type: "text", text: "<image>", text_elements: [] },
      { type: "localImage", path: "/tmp/serialized-comment.png" },
      { type: "text", text: "</image>", text_elements: [] },
    ] satisfies readonly UserInput[];

    const compareKey = buildCodexSteeringCompareKey(input);

    expect(compareKey.rawText).toBe(serializedPrompt);
    expect(compareKey.imageCount).toBe(1);
  });

  test("serializes only the exact text and image subset", () => {
    const first = [
      { type: "text", text: "same", text_elements: [] },
      { type: "mention", name: "one", path: "/one" },
      { type: "localImage", path: "/tmp/one.png" },
    ] satisfies readonly UserInput[];
    const second = [
      { type: "text", text: "same", text_elements: [] },
      { type: "mention", name: "two", path: "/two" },
      { type: "localImage", path: "/tmp/two.png" },
    ] satisfies readonly UserInput[];

    expect(serializeCodexSteeringCompareKey(first)).toBe(serializeCodexSteeringCompareKey(second));
  });
});

describe("codex steering state", () => {
  function buildState(): CodexCanonicalConversationState {
    return createCodexCanonicalHydratedConversationState(
      {
        model: null,
        reasoningEffort: null,
        id: "thread-a",
        environments: null,
        extra: null,
        sessionId: "session-a",
        forkedFromId: null,
        attachedToThreadId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        modelProvider: "openai",
        createdAt: 0,
        updatedAt: 0,
        recencyAt: null,
        status: { type: "active", activeFlags: [] },
        path: null,
        cwd: "/workspace",
        cliVersion: "test",
        originator: null,
        source: "appServer",
        canAcceptDirectInput: true,
        threadSource: "appServer",
        name: null,
        daybreakEnabled: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        turns: [
          {
            rootTurnId: null,
            id: "turn-a",
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
      {
        hostId: "local",
        ...{
          model: "gpt-test",
          reasoningEffort: null,
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: [],
        },
      },
    );
  }

  function buildSteer(id = "steer-a"): CodexCanonicalSteeringUserMessageItem {
    return {
      type: "steeringUserMessage",
      id,
      targetTurnId: "turn-a",
      targetTurnStartedAtMs: 10,
      status: "pending",
      clientUserMessageId: id,
      input: [{ type: "text", text: "continue", text_elements: [] }],
      attachments: [{ path: "/workspace/file.ts" }],
      restoreMessage: {
        queueRow: createCodexQueuedFollowUp({
          followUpId: `follow-up-${id}`,
          clientUserMessageId: `client-${id}`,
          threadId: "thread-a",
          prompt: "continue",
          createdAtMs: 10,
        }),
        context: { commentAttachments: [] },
      },
      compareKey: { rawText: "continue", imageCount: 0 },
    };
  }

  describe("hydrated steering reconciliation", () => {
    test("retains pending steering beside a longer history snapshot and refreshes existing assistant text", () => {
      const base = buildState().turns[0]!;
      const answer = {
        type: "agentMessage",
        moderation: null,
        id: "answer",
        text: "old",
        phase: "final_answer",
        memoryCitation: null,
        questions: null,
        delivery: null,
      } as const;
      const result = mergeCodexCanonicalTurnState(
        { ...base, items: [answer, buildSteer()] },
        {
          ...base,
          items: [
            { ...answer, text: "complete" },
            { type: "plan", id: "plan-a", text: "a" },
            { type: "plan", id: "plan-b", text: "b" },
          ],
        },
      );
      expect(result.items.map((item) => item.id)).toEqual([
        "answer",
        "steer-a",
        "plan-a",
        "plan-b",
      ]);
      expect(result.items[0]).toMatchObject({ text: "complete" });
    });

    test("accepts a persisted correlated echo and places its local row before the echo marker", () => {
      const base = buildState().turns[0]!;
      const steer = buildSteer();
      const echo = {
        type: "userMessage",
        id: "echo",
        clientId: steer.clientUserMessageId,
        content: [...steer.input],
      } satisfies ThreadItem;
      const result = mergeCodexCanonicalTurnState(
        { ...base, items: [echo, steer] },
        { ...base, items: [echo] },
      );
      expect(result.items).toEqual([
        { ...steer, status: "accepted", serverUserMessageId: "echo", acceptedInput: echo.content },
        { type: "steered", id: "echo" },
      ]);
    });

    test("keeps the opening message distinct from a pending steer with the same correlation", () => {
      const base = buildState().turns[0]!;
      const steer = buildSteer();
      const echo = {
        type: "userMessage",
        id: "opening",
        clientId: steer.clientUserMessageId,
        content: [...steer.input],
      } satisfies ThreadItem;
      const turn = {
        ...base,
        params: {
          ...base.params,
          clientUserMessageId: steer.clientUserMessageId,
          input: [...steer.input],
        },
      };
      const result = mergeCodexCanonicalTurnState(
        { ...turn, items: [steer] },
        { ...turn, items: [echo] },
      );
      expect(result.items).toEqual([steer, echo]);
    });

    test("moves steering to a newly loaded target and reconciles its server echo", () => {
      const base = buildState().turns[0]!;
      const steer = { ...buildSteer(), targetTurnId: "turn-b" };
      const target = {
        ...base,
        turnId: "turn-b",
        items: [
          {
            type: "userMessage",
            id: "echo",
            clientId: steer.clientUserMessageId,
            content: [...steer.input],
          } satisfies ThreadItem,
        ],
      };
      const result = mergeCodexCanonicalTurnStates([{ ...base, items: [steer] }], [target]);
      expect(result[0]!.items).toEqual([]);
      expect(result[1]!.items).toEqual([
        {
          ...steer,
          status: "accepted",
          serverUserMessageId: "echo",
          acceptedInput: [...steer.input],
        },
        { type: "steered", id: "echo" },
      ]);
    });

    test("preserves correlated nonempty input when hydration has no input", () => {
      const base = buildState().turns[0]!;
      const params = {
        ...base.params,
        clientUserMessageId: "opening",
        input: [...buildSteer().input],
      };
      const result = mergeCodexCanonicalTurnState({ ...base, params }, base);
      expect(result.params).toBe(params);
    });

    test("retains a completed heartbeat Turn until its pending steer has a server echo", () => {
      const base = buildState().turns[0]!;
      const turn = {
        ...base,
        status: "completed" as const,
        items: [
          {
            type: "agentMessage",
            moderation: null,
            id: "decision",
            text: "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>",
            phase: "final_answer",
            memoryCitation: null,
            questions: null,
            delivery: null,
          } as const,
          buildSteer(),
        ],
      };
      expect(mergeCodexCanonicalTurnStates([turn], [])).toEqual([turn]);
      expect(
        mergeCodexCanonicalTurnStates(
          [{ ...turn, items: [turn.items[0]!, { ...buildSteer(), serverUserMessageId: "echo" }] }],
          [],
        ),
      ).toEqual([]);
    });
  });

  describe("paginated steering opening authority", () => {
    test.each(["echo", "different-opening", null, undefined])(
      "uses opening identity %s when reconciling a resumed echo",
      (openingUserMessageId) => {
        const state = buildState();
        const base = state.turns[0]!;
        const steer = buildSteer();
        const turn = {
          ...base,
          params: {
            ...base.params,
            clientUserMessageId: steer.clientUserMessageId,
            input: [...steer.input],
          },
        };
        const echo = {
          type: "userMessage",
          id: "echo",
          clientId: steer.clientUserMessageId,
          content: [...steer.input],
        } satisfies ThreadItem;
        const pagination = {
          olderCursor: "older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          itemsView: "summary" as const,
          openingUserMessageId,
        };
        const result = mergeCodexResumedHistory({
          existing: { ...state, turns: [{ ...turn, items: [steer] }] },
          incoming: { ...state, turns: [{ ...turn, items: [echo] }] },
          existingPagination: { "turn-a": pagination },
          incomingPagination: { "turn-a": pagination },
        });
        const accepted =
          openingUserMessageId === null || openingUserMessageId === "different-opening";
        expect(result.canonical.turns[0]!.items).toEqual(
          accepted
            ? [
                {
                  ...steer,
                  status: "accepted",
                  serverUserMessageId: "echo",
                  acceptedInput: echo.content,
                },
                { type: "steered", id: "echo" },
              ]
            : [steer, echo],
        );
      },
    );
  });

  test("relocates steering without consuming the target Turn's known opening message", () => {
    const state = buildState();
    const base = state.turns[0]!;
    const steer = { ...buildSteer(), targetTurnId: "turn-b" };
    const echo = {
      type: "userMessage",
      id: "opening-b",
      clientId: steer.clientUserMessageId,
      content: [...steer.input],
    } satisfies ThreadItem;
    const target = { ...base, turnId: "turn-b", items: [echo] };
    const result = mergeCodexResumedHistory({
      existing: { ...state, turns: [{ ...base, items: [steer] }] },
      incoming: { ...state, turns: [target] },
      existingPagination: {},
      incomingPagination: {
        "turn-b": {
          olderCursor: "older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          itemsView: "summary",
          openingUserMessageId: "opening-b",
        },
      },
    });
    expect(result.canonical.turns[0]!.items).toEqual([]);
    expect(result.canonical.turns[1]!.items).toEqual([echo, steer]);
  });
});
