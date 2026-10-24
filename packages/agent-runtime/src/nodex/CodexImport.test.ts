import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { pathToFileURL } from "node:url";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import type { CodexNativeInteraction } from "@t3tools/provider-core/server/nativeInteraction";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import { layer as commandsLayer } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  CodexImportInput,
  localMarkdownImagePaths,
  make,
  resolveMarkdownImagePath,
} from "./CodexImport.ts";
import * as ExecutionLocation from "./ExecutionLocation.ts";
import * as Attachment from "./Attachment.ts";
import { turnItemText } from "../mcp/OrchestratorMcpService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: Adapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The import never starts a native execution"),
};
const database = Sqlite.layerMemory;
const registry = Registry.layerSingle(adapter);
const config = Layer.effect(
  ServerConfig.ServerConfig,
  Harness.makeReplayServerConfig("codex-import"),
).pipe(Layer.provide(NodeServices.layer));
const layer = Harness.layerWithRegistry({ name: "codex-import" }, registry, {
  runEffectWorker: false,
  databaseLayer: database,
}).pipe(
  Layer.provideMerge(projectionLayer.pipe(Layer.provideMerge(database))),
  Layer.provideMerge(registry),
  Layer.provideMerge(config),
  Layer.provideMerge(commandsLayer),
  Layer.provideMerge(NodeServices.layer),
);
const input = (id = "copy") =>
  CodexImportInput.make({
    commandId: CommandId.make(`import:${id}`),
    threadId: ThreadId.make(`thread:${id}`),
    projectId: ProjectId.make("project:imports"),
    title: "Imported chat",
    sourceNativeThreadId: "native:source",
    modelSelection: { instanceId, model: "gpt-5.4" },
    cwd: process.cwd(),
  });
const user: ThreadItemEntry = {
  turnId: "turn:source",
  startedAtMs: 1_700_000_000_000,
  completedAtMs: 1_700_000_001_000,
  item: {
    type: "userMessage",
    id: "user:source",
    clientId: null,
    content: [{ type: "text", text: "Remember original-marker-492", text_elements: [] }],
  },
};
const assistant: ThreadItemEntry = {
  ...user,
  item: {
    type: "agentMessage",
    id: "assistant:source",
    text: "Stored original-marker-492",
    phase: "final_answer",
    delivery: null,
    questions: null,
    memoryCitation: null,
  },
};
const extra: ThreadItemEntry = {
  ...user,
  turnId: "turn:newer",
  item: { ...assistant.item, id: "newer:source", text: "Appended later" } as typeof assistant.item,
};

it("owns Windows Markdown locators and rejects foreign or drive-relative paths", () => {
  const urls = localMarkdownImagePaths(
    [
      "![Drive](C:/images/a.png)",
      String.raw`![Backslash](C:\images\b.png)`,
      "![UNC](//server/share/c.png)",
      "![File URL](file:///C:/images/file%20image.png)",
      "![Relative](relative%20image.png)",
      "![Remote](https://example.com/remote.png)",
      "`![Example](D:/example.png)`",
    ].join("\n\n"),
    "win32",
  );
  assert.deepEqual(urls, [
    "C:/images/a.png",
    String.raw`C:\images\b.png`,
    "//server/share/c.png",
    "file:///C:/images/file%20image.png",
    "relative%20image.png",
  ]);
  assert.deepEqual(
    urls.map((url) => resolveMarkdownImagePath(url, String.raw`C:\source`, "win32")),
    [
      String.raw`C:\images\a.png`,
      String.raw`C:\images\b.png`,
      String.raw`\\server\share\c.png`,
      String.raw`C:\images\file image.png`,
      String.raw`C:\source\relative image.png`,
    ],
  );
  for (const url of urls.slice(0, 4))
    assert.throws(
      () => resolveMarkdownImagePath(url, "/source", "darwin"),
      /Windows image path this computer cannot read/,
    );
  assert.deepEqual(localMarkdownImagePaths("![Invalid](C:relative.png)"), ["C:relative.png"]);
  assert.throws(
    () => resolveMarkdownImagePath("C:relative.png", String.raw`C:\source`, "win32"),
    /relative Windows image path/,
  );
  assert.deepEqual(
    localMarkdownImagePaths(
      "![CDN](//cdn.example.com/image.png)\n![Local](relative.png)",
      "darwin",
    ),
    ["relative.png"],
  );
  assert.deepEqual(
    localMarkdownImagePaths(String.raw`![UNC](\\\\server\share\image.png)`, "darwin"),
    [String.raw`\\server\share\image.png`],
  );
});

const fixture = (
  options: {
    failSecondPage?: boolean;
    missingBoundary?: boolean;
    legacy?: boolean;
    voice?: boolean;
    media?: boolean;
    tool?: ThreadItemEntry;
    sourceCwd?: string;
    userEntry?: ThreadItemEntry;
    assistantEntry?: ThreadItemEntry;
    deniedImagePath?: string;
  } = {},
) => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let failSecondPage = options.failSecondPage ?? false;
  let serial = 0;
  const sourceUser = options.userEntry ?? user;
  const sourceAssistant = options.assistantEntry ?? assistant;
  const request = (method: string, params: Record<string, unknown>) =>
    Effect.suspend((): Effect.Effect<unknown, Error> => {
      calls.push({ method, params });
      if (method === "thread/read")
        return Effect.succeed({
          thread: {
            id: "native:source",
            ephemeral: false,
            status: { type: "idle" },
            historyMode: options.legacy ? "legacy" : "paginated",
            cwd: options.sourceCwd ?? process.cwd(),
          },
        });
      if (method === "thread/timeline/list")
        return Effect.succeed({
          data: options.voice ? [{ type: "realtime" }] : [],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: null,
        });
      if (method === "thread/turns/list" && params.sortDirection === "desc")
        return Effect.succeed({
          data: [
            {
              id: sourceUser.turnId,
              status: "completed",
              items: [sourceUser.item, sourceAssistant.item],
            },
          ],
          nextCursor: null,
        });
      if (method === "thread/turns/list")
        return Effect.succeed({
          data: [
            {
              id: user.turnId,
              status: "completed",
              items: [sourceUser.item, sourceAssistant.item],
              startedAt: 1_700_000_000,
              completedAt: 1_700_000_001,
            },
          ],
          nextCursor: null,
        });
      if (method !== "thread/items/list") return Effect.die(`Unexpected source mutation ${method}`);
      if (params.cursor === null)
        return Effect.succeed({
          data: [sourceUser, ...(options.tool ? [options.tool] : [])],
          nextCursor: "second",
        });
      if (failSecondPage) return Effect.fail(new Error("Source disconnected"));
      return Effect.succeed({
        data: options.missingBoundary
          ? [extra]
          : [
              ...(options.media
                ? [
                    {
                      ...user,
                      item: {
                        type: "imageGeneration",
                        id: "image:source",
                        result: "/source/private.png",
                        status: "completed",
                        revisedPrompt: null,
                        failure: null,
                      },
                    },
                  ]
                : []),
              sourceAssistant,
              extra,
            ],
        nextCursor: null,
      });
    });
  const native = {
    initialize: Effect.succeed({ userAgent: "test" }),
    request,
    notifications: Stream.empty,
  } as unknown as CodexNativeInteraction;
  const session = { codexNative: native } as Adapter.ProviderAdapterV2SessionRuntime;
  return {
    calls,
    recover: () => {
      failSecondPage = false;
    },
    makeImport: Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const fs = yield* FileSystem.FileSystem;
      return yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: (path) =>
            path === options.deniedImagePath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFile",
                    pathOrDescriptor: path,
                  }),
                )
              : fs.readFile(path),
        }),
        Effect.provide(
          Layer.mock(ProviderSessionManagerV2)({
            open: (request) =>
              Effect.gen(function* () {
                const at = yield* DateTime.now;
                yield* sink
                  .write({
                    events: [
                      {
                        id: EventId.make(`attach:${++serial}`),
                        type: "provider-session.attached",
                        threadId: request.threadId,
                        occurredAt: at,
                        payload: {
                          id: request.providerSessionId,
                          driver: ProviderDriverKind.make("codex"),
                          providerInstanceId: instanceId,
                          status: "ready",
                          cwd: request.runtimePolicy.cwd!,
                          model: request.modelSelection.model,
                          capabilities: CodexProviderCapabilitiesV2,
                          createdAt: at,
                          updatedAt: at,
                          lastError: null,
                        },
                      },
                    ],
                  })
                  .pipe(Effect.orDie);
                return session;
              }),
            close: () => Effect.void,
          }),
        ),
      );
    }),
  };
};

it.effect(
  "copies paginated history through its captured boundary and primes the first new Run",
  () =>
    Effect.gen(function* () {
      const source = fixture();
      const importThread = yield* source.makeImport;
      const target = input();
      yield* importThread(target);
      const store = yield* ProjectionStoreV2;
      const copied = yield* store.getThreadProjection(target.threadId);
      assert.deepEqual(
        copied.messages.map((message) => message.text),
        ["Remember original-marker-492", "Stored original-marker-492"],
      );
      assert.isNull(copied.thread.executionHandoff);
      assert.equal(copied.thread.historyOrigin, "native_import");
      assert.equal(copied.providerThreads.length, 0);
      assert.isFalse(
        source.calls.some(({ method }) => /start|resume|fork|delete|unarchive/.test(method)),
      );
      const before = source.calls.length;
      yield* importThread({
        ...target,
        title: "Catalog refreshed",
        modelSelection: { instanceId, model: "changed-default" },
      });
      assert.equal(source.calls.length, before);
      const writer = yield* OrchestratorV2;
      yield* writer.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:copy"),
        threadId: target.threadId,
        messageId: MessageId.make("message:copy"),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start" },
      });
      const continued = yield* store.getThreadProjection(target.threadId);
      assert.isTrue(
        continued.contextHandoffs.some((handoff) =>
          handoff.summaryText.includes("original-marker-492"),
        ),
      );
      assert.isTrue(continued.providerThreads.every((thread) => thread.nativeThreadRef === null));
    }).pipe(Effect.provide(layer)),
);

it.effect("resumes a partial import without duplicate history or an empty destination", () =>
  Effect.gen(function* () {
    const source = fixture({ failSecondPage: true });
    const target = input("resume");
    const first = yield* source.makeImport;
    assert.equal((yield* first(target).pipe(Effect.result))._tag, "Failure");
    const store = yield* ProjectionStoreV2;
    assert.isNotNull((yield* store.getThread(target.threadId)).executionHandoff);
    const location = yield* ExecutionLocation.make;
    assert.equal(
      (yield* location
        .hold({
          threadId: target.threadId,
          operationId: `codex-import:${target.commandId}`,
          action: "release",
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    const writer = yield* OrchestratorV2;
    assert.equal(
      (yield* writer
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:incomplete"),
          threadId: target.threadId,
          messageId: MessageId.make("message:incomplete"),
          text: "Continue",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "defer_start" },
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    source.recover();
    const reopened = yield* source.makeImport;
    yield* reopened(target);
    const copied = yield* store.getThreadProjection(target.threadId);
    assert.equal(copied.messages.length, 2);
    assert.equal(copied.turnItems.length, 2);
    assert.equal(source.calls.filter(({ method }) => method === "thread/turns/list").length, 1);
    const conflict = yield* reopened({ ...target, sourceNativeThreadId: "native:other" }).pipe(
      Effect.result,
    );
    assert.equal(conflict._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps an import sealed when the captured source history disappears", () =>
  Effect.gen(function* () {
    const source = fixture({ missingBoundary: true });
    const importThread = yield* source.makeImport;
    const target = input("changed");
    assert.equal((yield* importThread(target).pipe(Effect.result))._tag, "Failure");
    const store = yield* ProjectionStoreV2;
    assert.isNotNull((yield* store.getThread(target.threadId)).executionHandoff);
    assert.equal((yield* store.getThreadProjection(target.threadId)).messages.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("copies legacy history through bounded Turn pages", () =>
  Effect.gen(function* () {
    const source = fixture({ legacy: true });
    const importThread = yield* source.makeImport;
    const target = input("legacy");
    yield* importThread(target);
    assert.equal(
      (yield* (yield* ProjectionStoreV2).getThreadProjection(target.threadId)).messages.length,
      2,
    );
    assert.isFalse(source.calls.some(({ method }) => method === "thread/items/list"));
  }).pipe(Effect.provide(layer)),
);

it.effect("deletes an incomplete import through the normal conversation lifecycle", () =>
  Effect.gen(function* () {
    const source = fixture({ failSecondPage: true });
    const importThread = yield* source.makeImport;
    const target = input("discard");
    assert.equal((yield* importThread(target).pipe(Effect.result))._tag, "Failure");
    const writer = yield* OrchestratorV2;
    yield* writer.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:discard"),
      threadId: target.threadId,
    });
    const thread = yield* (yield* ProjectionStoreV2).getThread(target.threadId);
    assert.isNotNull(thread.deletedAt);
    assert.isNull(thread.executionHandoff);
    source.recover();
    assert.equal((yield* importThread(target).pipe(Effect.result))._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves tool images and result metadata as passive history", () =>
  Effect.gen(function* () {
    const source = fixture({
      tool: {
        ...user,
        item: {
          type: "mcpToolCall",
          id: "tool:source",
          server: "assets",
          tool: "render",
          status: "completed",
          arguments: {},
          appContext: null,
          mcpAppUi: null,
          pluginId: null,
          readOnlyHint: true,
          result: {
            content: [{ type: "image", mimeType: "image/png", data: "AQID" }],
            structuredContent: { caption: "Result" },
            _meta: null,
          },
          error: null,
          durationMs: 10,
        },
      },
    });
    const importThread = yield* source.makeImport;
    const target = input("tool");
    yield* importThread(target);
    const copied = yield* (yield* ProjectionStoreV2).getThreadProjection(target.threadId);
    const tool = copied.turnItems.find((item) => item.type === "dynamic_tool");
    assert.isDefined(tool);
    assert.deepEqual(
      tool?.type === "dynamic_tool" ? tool.mcpToolCall?.result?.structuredContent : null,
      { caption: "Result" },
    );
    assert.equal(copied.runtimeRequests.length, 0);
    assert.equal(copied.subagents.length, 0);
  }).pipe(Effect.provide(layer)),
);

for (const unsupported of ["voice", "media"] as const) {
  it.effect(
    `refuses unsupported ${unsupported} history without reporting an import as complete`,
    () =>
      Effect.gen(function* () {
        const source = fixture({ [unsupported]: true });
        const importThread = yield* source.makeImport;
        const target = input(unsupported);
        assert.equal((yield* importThread(target).pipe(Effect.result))._tag, "Failure");
        const thread = yield* (yield* ProjectionStoreV2).getThread(target.threadId);
        assert.isNotNull(thread.executionHandoff);
        assert.equal((yield* (yield* OrchestratorV2).getReceipt(target.commandId))._tag, "None");
      }).pipe(Effect.provide(layer)),
  );
}

it.effect(
  "retains missing message images and image inspections without borrowing the new directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = yield* fs.makeTempDirectoryScoped({ prefix: "codex-import-missing-" });
      const sourceCwd = path.join(destination, "removed-source");
      yield* fs.writeFile(path.join(destination, "viewed.png"), new Uint8Array([1, 2, 3]));
      yield* fs.writeFile(
        path.join(destination, "relative-assistant.png"),
        new Uint8Array([1, 2, 3]),
      );
      const originalUserPath = path.join(sourceCwd, "user.png");
      const originalAssistantPath = path.join(sourceCwd, "assistant.png");
      const assistantText = `![Historical assistant image](${originalAssistantPath})\n![Relative](relative-assistant.png)`;
      const source = fixture({
        sourceCwd,
        userEntry: {
          ...user,
          item: {
            type: "userMessage",
            id: user.item.id,
            clientId: null,
            content: [{ type: "localImage", path: originalUserPath }],
          },
        },
        tool: { ...user, item: { type: "imageView", id: "view:missing", path: "viewed.png" } },
        assistantEntry: {
          ...assistant,
          item: { ...assistant.item, text: assistantText } as typeof assistant.item,
        },
      });
      const importThread = yield* source.makeImport;
      const target = { ...input("missing-images"), cwd: destination };
      yield* importThread(target);
      const store = yield* ProjectionStoreV2;
      const copied = yield* store.getThreadProjection(target.threadId);
      const opening = copied.turnItems.find((item) => item.type === "user_message")!;
      const viewed = copied.turnItems.find((item) => item.type === "dynamic_tool")!;
      const reply = copied.turnItems.find((item) => item.type === "assistant_message")!;
      assert.deepEqual(opening.unavailableImages, [
        { name: "user.png", sourcePath: originalUserPath, reason: "source_missing" },
      ]);
      assert.deepEqual(viewed.unavailableImages, [
        { name: "viewed.png", sourcePath: "viewed.png", reason: "source_missing" },
      ]);
      assert.equal(opening.type === "user_message" ? opening.attachments.length : -1, 0);
      assert.isUndefined(viewed.type === "dynamic_tool" ? viewed.attachments : undefined);
      assert.equal(reply.type, "assistant_message");
      if (reply.type !== "assistant_message") return;
      assert.equal(reply.text, assistantText);
      assert.isUndefined(reply.attachments);
      assert.deepEqual(reply.unavailableImages, [
        { name: "assistant.png", sourcePath: originalAssistantPath, reason: "source_missing" },
        {
          name: "relative-assistant.png",
          sourcePath: "relative-assistant.png",
          reason: "source_missing",
        },
      ]);
      assert.deepEqual(reply.importedImageLinks, [
        { sourcePath: originalAssistantPath, attachmentId: null },
        { sourcePath: "relative-assistant.png", attachmentId: null },
      ]);
      assert.equal(copied.messages[0]?.text, "");
      assert.equal(
        turnItemText(opening),
        "[Image unavailable: user.png; original source file is missing.]",
      );
      assert.isTrue(
        turnItemText(viewed)?.includes(
          "[Image unavailable: viewed.png; original source file is missing.]",
        ) ?? false,
      );
      assert.equal(
        turnItemText(reply),
        `${assistantText}\n[Image unavailable: assistant.png; original source file is missing.]\n[Image unavailable: relative-assistant.png; original source file is missing.]`,
      );
      const history = yield* store.getHandoffHistory({
        scope: "conversation",
        threadId: target.threadId,
        runIds: [],
        includeImported: true,
        includeConversationSummary: true,
        budget: 16000,
      });
      assert.isTrue(
        history.history.messages.some((message) =>
          message.text.includes("Image unavailable: user.png"),
        ),
      );
      assert.isTrue(
        history.history.messages.some((message) =>
          message.text.includes("Image unavailable: viewed.png"),
        ),
      );
      assert.isTrue(
        history.history.messages.some((message) =>
          message.text.includes("Image unavailable: assistant.png"),
        ),
      );
      assert.isTrue(
        history.conversationSummary?.sections.some((section) =>
          section.body.includes("Image unavailable: viewed.png"),
        ) ?? false,
      );
      yield* (yield* OrchestratorV2).dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue:missing-images"),
        threadId: target.threadId,
        messageId: MessageId.make("message:missing-images"),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start" },
      });
      const continued = yield* store.getThreadProjection(target.threadId);
      assert.isTrue(
        continued.contextHandoffs.some(
          (handoff) =>
            handoff.summaryText.includes("Image unavailable: user.png") &&
            handoff.summaryText.includes("Image unavailable: viewed.png") &&
            handoff.summaryText.includes("Image unavailable: assistant.png"),
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("owns copied message and viewed images after their source directory disappears", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceParent = yield* fs.makeTempDirectoryScoped({ prefix: "codex-import-images-" });
    const sourceCwd = path.join(sourceParent, "source");
    yield* fs.makeDirectory(sourceCwd);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    yield* fs.writeFile(path.join(sourceCwd, "user.png"), bytes);
    yield* fs.writeFile(path.join(sourceCwd, "viewed.png"), bytes);
    const absolutePath = path.join(sourceCwd, "assistant.png");
    const encodedUrl = pathToFileURL(path.join(sourceCwd, "file image.png")).href;
    const relativeUrl = "relative%20image.png";
    for (const name of [
      "assistant.png",
      "file image.png",
      "relative image.png",
      "entity&image.png",
      "escaped(image).png",
    ])
      yield* fs.writeFile(path.join(sourceCwd, name), bytes);
    const assistantText = [
      `![Absolute](<${absolutePath}>)`,
      `![Encoded](${encodedUrl})`,
      "![Relative][saved]",
      `[saved]: ${relativeUrl}`,
      "![Entity](entity&amp;image.png)",
      "![Escaped](escaped\\(image\\).png)",
      "`![Example](/not-a-real-image.png)`",
      "```md\n![Example](unowned.png)\n```",
      "![Remote](https://example.com/remote.png)",
    ].join("\n\n");
    const source = fixture({
      sourceCwd,
      userEntry: {
        ...user,
        item: {
          type: "userMessage",
          id: user.item.id,
          clientId: null,
          content: [{ type: "localImage", path: "user.png" }],
        },
      },
      tool: { ...user, item: { type: "imageView", id: "view:available", path: "viewed.png" } },
      assistantEntry: {
        ...assistant,
        item: { ...assistant.item, text: assistantText } as typeof assistant.item,
      },
    });
    const importThread = yield* source.makeImport;
    const target = input("copied-images");
    yield* importThread(target);
    const store = yield* ProjectionStoreV2;
    const copied = yield* store.getThreadProjection(target.threadId);
    const reply = copied.turnItems.find((item) => item.type === "assistant_message");
    assert.equal(reply?.type, "assistant_message");
    if (reply?.type !== "assistant_message") return;
    assert.equal(reply.text, assistantText);
    assert.equal(reply.attachments?.length, 5);
    assert.deepEqual(
      reply.importedImageLinks,
      [absolutePath, encodedUrl, relativeUrl, "entity&image.png", "escaped(image).png"].map(
        (sourcePath, index) => ({
          sourcePath,
          attachmentId: reply.attachments![index]!.id,
        }),
      ),
    );
    yield* fs.remove(sourceCwd, { recursive: true });
    const readAttachment = yield* Attachment.make;
    const ids = [];
    for (const item of copied.turnItems) {
      if (
        item.type !== "user_message" &&
        item.type !== "dynamic_tool" &&
        item.type !== "assistant_message"
      )
        continue;
      assert.isUndefined(item.unavailableImages);
      assert.isTrue((item.attachments?.length ?? 0) > 0);
      for (const image of item.attachments ?? []) {
        ids.push(image.id);
        const resolved = yield* readAttachment({
          threadId: target.threadId,
          itemId: item.id,
          attachmentId: image.id,
        });
        assert.isTrue(resolved !== null && "path" in resolved);
        if (resolved && "path" in resolved)
          assert.deepEqual(yield* fs.readFile(resolved.path), bytes);
        assert.isTrue(turnItemText(item)?.includes(`[Image available: ${image.name};`) ?? false);
      }
    }
    assert.deepEqual(
      (yield* store.getThreadAttachmentIds(target.threadId)).toSorted(),
      ids.toSorted(),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps unreadable images as an import error instead of declaring them missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceCwd = yield* fs.makeTempDirectoryScoped({ prefix: "codex-import-denied-" });
    const originalPath = path.join(sourceCwd, "private.png");
    yield* fs.writeFile(originalPath, new Uint8Array([1, 2, 3]));
    const source = fixture({
      sourceCwd,
      deniedImagePath: originalPath,
      userEntry: {
        ...user,
        item: {
          type: "userMessage",
          id: user.item.id,
          clientId: null,
          content: [{ type: "localImage", path: originalPath }],
        },
      },
    });
    const importThread = yield* source.makeImport;
    const target = input("denied-image");
    const result = yield* importThread(target).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    const copied = yield* (yield* ProjectionStoreV2).getThreadProjection(target.threadId);
    assert.isNotNull(copied.thread.executionHandoff);
    assert.equal(copied.turnItems.length, 0);
  }).pipe(Effect.provide(layer)),
);
