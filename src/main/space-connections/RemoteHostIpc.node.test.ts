import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@nodex/agent-runtime/contracts";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { inboxNewChatAction } from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreSessionAccess, type CoreSessionOperation } from "../core-runtime/CoreAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { NativePromptImages } from "../agent-backend/NativePromptImages";
import { LibraryModule } from "../library-application/LibraryModule";
import { fileSource } from "../../shared/file-resources";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { make as makeChatAttachments } from "../../host/ChatAttachments";
import { testLayer } from "../app/MainConfig";
import type { HeadlessHost } from "../../host/HeadlessApplicationLive";
import { executeHostCommand } from "../../host/HostCommands";
import { HostInvocation } from "../../host/HostInvocation";
import { InboxApplicationError } from "../../host/inbox-application/InboxApplication";
import type { IpcApi } from "../../shared/ipc-api";
import { live } from "./RemoteHostIpc";
import { makeSpaceIpcCollector } from "./SpaceIpcCollector";
import type { components } from "@nodex/core-protocol";
import { HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES } from "../../shared/schemas/agent-runtime-api";

const basis = [{ pageId: "page:idea", contentHash: "a".repeat(64) }];
const changed = new CoreModuleResponseError({
  code: "conflict",
  message: "The Inbox decision changed; review it again",
  retryable: true,
  recovery: { kind: "none" },
});

interface Uploaded {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: string;
}
/** This desktop's image fitting and its Member's own Library, which hosted messages upload to. */
const memberLibrary = (uploaded: Uploaded[] = []) => {
  const prepared = new Map<string, Uint8Array>();
  const files = new Map<string, Uploaded>();
  return Layer.mergeAll(
    Layer.succeed(NativePromptImages, {
      prepare: (images: readonly { source: string }[]) =>
        Effect.succeed(
          images.map(({ source }) => ({
            mediaType: "image/png" as const,
            data: Buffer.from(`fitted:${source}`).toString("base64"),
          })),
        ),
    } as unknown as NativePromptImages["Service"]),
    Layer.succeed(CoreAuthority, {
      identity: { storeEpoch: "epoch" },
    } as unknown as CoreAuthority["Service"]),
    Layer.succeed(LibraryModule, {
      read: (_route: unknown, request: { read: { file_id: string } }) => {
        const file = files.get(request.read.file_id);
        return Effect.succeed(
          file
            ? {
                ok: true,
                value: {
                  value: {
                    kind: "file",
                    value: {
                      lifecycle: "live",
                      blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                      mime_type: file.mimeType,
                      byte_length: Buffer.byteLength(file.bytes),
                    },
                  },
                },
              }
            : { ok: false, error: { code: "resource_not_found", message: "Missing" } },
        );
      },
      prepareFileBlob: (_route: unknown, operationId: string, _slot: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          prepared.set(operationId, bytes);
          return { receipt_id: operationId };
        }),
      apply: (
        _route: unknown,
        request: {
          operation: {
            change: {
              file_id: string;
              default_name: string;
              mime_type: string;
              prepared_blob_receipt_id: string;
            };
          };
        },
      ) =>
        Effect.sync(() => {
          const change = request.operation.change;
          const file = {
            fileId: change.file_id,
            name: change.default_name,
            mimeType: change.mime_type,
            bytes: Buffer.from(prepared.get(change.prepared_blob_receipt_id)!).toString(),
          };
          files.set(change.file_id, file);
          uploaded.push(file);
          return { ok: true };
        }),
    } as unknown as LibraryModule["Service"]),
  );
};

it.effect(
  "a team desktop's Inbox decisions reach the Space host's Inbox with the Member's invocation",
  () =>
    Effect.gen(function* () {
      const received: { method: string; invocation: string | null; input: unknown }[] = [];
      const record = (method: string, input: unknown) =>
        Effect.flatMap(HostInvocation, (invocation) =>
          Effect.sync(() => {
            received.push({ method, invocation, input });
          }),
        );
      // Mutations come back as Core's typed refusal, so the desktop keeps the host's reason.
      const refuse = (method: string) => (input: unknown) =>
        record(method, input).pipe(
          Effect.andThen(
            Effect.fail(
              new InboxApplicationError({
                operation: method,
                message: changed.message,
                cause: changed,
              }),
            ),
          ),
        );
      const host = {
        inbox: {
          prepareConfirmation: (input: unknown) =>
            record("prepareConfirmation", input).pipe(Effect.as({ prepared: true })),
          chatTargets: (input: unknown) =>
            record("chatTargets", input).pipe(Effect.as({ items: [], nextCursor: null })),
          confirm: refuse("confirm"),
          dispatch: refuse("dispatch"),
          requestSuggestion: refuse("requestSuggestion"),
          stopSuggestion: refuse("stopSuggestion"),
          retryDispatch: refuse("retryDispatch"),
        },
      } as unknown as HeadlessHost["Service"];
      const client = {
        // The relayed call crosses Core's Promise-facing transport into the host's own owners.
        hostCall: (call: Parameters<typeof executeHostCommand>[1]["call"]) =>
          // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- Stands in for Core's Promise-facing host relay.
          Effect.runPromise(
            executeHostCommand(host, { id: "call", credential: "proof:bob", call }).pipe(
              Effect.map((value) => ({ status: "ok" as const, value: value ?? null })),
            ),
          ),
      };
      const collector = makeSpaceIpcCollector({ routes: () => true });
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(
            Layer.succeed(
              CoreSessionAccess,
              CoreSessionAccess.of({
                handshake: Effect.die("No handshake is needed"),
                use: (_operation, run) => Effect.promise((signal) => run(client as never, signal)),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(CoreModules, {} as CoreModules["Service"])),
          Layer.provide(memberLibrary()),
        ),
      );
      const invoke = <Channel extends keyof IpcApi>(channel: Channel, input: unknown) =>
        collector.invoke(channel, {} as IpcMainInvokeEvent, [input]);
      const operationId = createBoundedOperationId("test.inbox");
      const decisions = [
        [
          "inbox:prepare-confirmation",
          "prepareConfirmation",
          {
            kind: "proposal",
            storeEpoch: "epoch",
            proposalId: "proposal",
            expectedRevision: 1,
            basis,
          },
        ],
        [
          "inbox:chat-targets",
          "chatTargets",
          { scope: { kind: "library" }, query: "", after: null, first: 50 },
        ],
        [
          "inbox:confirm",
          "confirm",
          {
            storeEpoch: "epoch",
            operationId,
            sessionId: "session",
            basis,
            proposalId: "proposal",
            expectedRevision: 1,
          },
        ],
        [
          "inbox:dispatch",
          "dispatch",
          {
            storeEpoch: "epoch",
            operationId,
            proposalId: "proposal",
            sessionId: "session",
            basis,
            pageIds: ["page:idea"],
            action: inboxNewChatAction(null, "Draft the release notes"),
          },
        ],
        [
          "inbox:request-suggestion",
          "requestSuggestion",
          { requestId: "request", mode: "auto", pageIds: ["page:idea"], basis },
        ],
        ["inbox:stop-suggestion", "stopSuggestion", { pageId: "page:idea" }],
        ["inbox:retry-dispatch", "retryDispatch", { proposalId: "proposal" }],
      ] as const;
      for (const [channel, method, input] of decisions) {
        const result = yield* invoke(channel, input);
        assert.deepStrictEqual(
          received.at(-1),
          { method, invocation: "proof:bob", input },
          channel,
        );
        if (method === "prepareConfirmation") assert.deepStrictEqual(result, { prepared: true });
        else if (method === "chatTargets")
          assert.deepStrictEqual(result, { items: [], nextCursor: null });
        else assert.deepStrictEqual(result, { ok: false, error: changed.coreError }, channel);
      }
    }).pipe(Effect.scoped),
);

const target = { sessionId: "session", threadId: "thread" };
const message = { messageId: "message", text: "Run it again" };

it.effect("sends a team desktop's chat messages and queue controls to the Space host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const collector = makeSpaceIpcCollector({ routes: () => true });
      const calls: components["schemas"]["HostCall"][] = [];
      const uploaded: Uploaded[] = [];
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(
            Layer.succeed(CoreSessionAccess, {
              use: (_operation: string, run: CoreSessionOperation<unknown>) =>
                Effect.promise(async () =>
                  run(
                    {
                      hostCall: (call: components["schemas"]["HostCall"]) => {
                        calls.push(call);
                        return Promise.resolve({ status: "ok", value: { sequence: 7 } });
                      },
                    } as never,
                    new AbortController().signal,
                  ),
                ),
            } as unknown as CoreSessionAccess["Service"]),
          ),
          Layer.provide(Layer.succeed(CoreModules, {} as never)),
          Layer.provide(memberLibrary(uploaded)),
        ),
      );
      const event = {} as IpcMainInvokeEvent;
      const invoke = (channel: Parameters<typeof collector.invoke>[0], input: unknown) =>
        collector.invoke(channel, event, [input]);

      // The window here presents nothing for a hosted Run, so the send proceeds without a ticket.
      expect(
        yield* invoke("codex:turn-presentation:capture", {
          target: { kind: "thread", threadId: "thread" },
          presentation: { kind: "unavailable" },
        }),
      ).toBeUndefined();
      expect(yield* invoke("agent-runtime:session:message", { ...target, message })).toEqual({
        sequence: 7,
      });
      yield* invoke("agent-runtime:session:message", { ...target, message, intent: "steer" });
      yield* invoke("agent-runtime:session:queue-message", {
        ...target,
        message: { ...message, images: [], modelSelection: { instanceId: "codex", model: "m" } },
      });
      yield* invoke("agent-runtime:session:queue", {
        ...target,
        requestId: "edit",
        action: "edit",
        runId: "queued",
        presentationTicket: { ticketId: "00000000-0000-4000-8000-000000000000" },
        message: { messageId: "queued-message", text: "Wait for the loop" },
      });
      yield* invoke("agent-runtime:session:queue", {
        ...target,
        requestId: "cancel",
        action: "cancel",
        runId: "queued",
      });
      expect(calls).toEqual([
        { operation: "session_message", input: { ...target, message, delivery: "send" } },
        { operation: "session_message", input: { ...target, message, delivery: "steer" } },
        {
          operation: "session_message",
          input: {
            ...target,
            message: { ...message, modelSelection: { instanceId: "codex", model: "m" } },
            delivery: "queue",
          },
        },
        {
          operation: "session_queue",
          input: {
            ...target,
            requestId: "edit",
            action: "edit",
            runId: "queued",
            message: { messageId: "queued-message", text: "Wait for the loop" },
          },
        },
        {
          operation: "session_queue",
          input: { ...target, requestId: "cancel", action: "cancel", runId: "queued" },
        },
      ]);

      // This computer's images and files reach the host as the Member's own Library Files.
      const folder = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-hosted-upload-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const notes = join(folder, "notes.md");
      yield* Effect.promise(() => writeFile(notes, "# Plan\n"));
      const context = { version: 1, records: [{ kind: "page", label: "Plan", payload: {} }] };
      yield* invoke("agent-runtime:session:message", {
        ...target,
        message: {
          ...message,
          context,
          images: [{ source: "/Users/bob/Desktop/shot.png", caption: "shot.png" }],
          uploads: [{ name: "notes.md", path: notes }],
        },
      });
      expect(uploaded.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes }))).toEqual([
        { name: "shot.png", mimeType: "image/png", bytes: "fitted:/Users/bob/Desktop/shot.png" },
        { name: "notes.md", mimeType: "text/markdown", bytes: "# Plan\n" },
      ]);
      expect(calls.at(-1)).toEqual({
        operation: "session_message",
        input: {
          ...target,
          message: {
            ...message,
            fileRefs: uploaded.map(({ fileId }) => fileSource(fileId)),
            context,
          },
          delivery: "send",
        },
      });
      // The same bytes keep their File when a send is retried.
      yield* invoke("agent-runtime:session:message", {
        ...target,
        message: { ...message, uploads: [{ name: "notes.md", path: notes }] },
      });
      expect(uploaded).toHaveLength(2);
      expect((calls.at(-1)?.input as { message: { fileRefs: string[] } }).message.fileRefs).toEqual(
        [fileSource(uploaded[1]!.fileId)],
      );
      // A folder, or an attachment this computer's own Runtime recorded, never leaves it.
      const inside = join(folder, "inside");
      yield* Effect.promise(() => mkdir(inside));
      expect(
        yield* invoke("agent-runtime:session:message", {
          ...target,
          message: { ...message, uploads: [{ name: "inside", path: inside }] },
        }).pipe(Effect.flip),
      ).toMatchObject({
        message: "Attach files rather than folders to a chat on this Space's host.",
      });
      expect(
        yield* invoke("agent-runtime:session:message", {
          ...target,
          message: { ...message, attachments: [{ type: "image", id: "local" }] },
        }).pipe(Effect.flip),
      ).toMatchObject({ message: "Attach these files again to send them to this Space's host." });
      expect(calls).toHaveLength(7);
      // A fork's worktree environment is the host's; this computer's choice stays here.
      yield* invoke("agent-runtime:session:fork", {
        source: target,
        sessionId: "fork",
        requestId: "fork-request",
        acceptedAt: 1,
        environment: "worktree",
        runInEnvironmentPath: "/Users/bob/.codex/environment.toml",
      });
      expect(calls.at(-1)).toEqual({
        operation: "session_fork",
        input: {
          source: target,
          sessionId: "fork",
          requestId: "fork-request",
          acceptedAt: 1,
          environment: "worktree",
        },
      });
      // A side chat, and bringing a fork back, travel to the host as the Member's own calls.
      const side = { source: target, sessionId: "side", requestId: "side", acceptedAt: 2 };
      yield* invoke("agent-runtime:session:create-side-chat", side);
      yield* invoke("agent-runtime:session:merge-back", { sessionId: "side", requestId: "merge" });
      yield* invoke("agent-runtime:session:delete-side-chat", {
        sessionId: "side",
        requestId: "delete",
      });
      expect(calls.slice(-3)).toEqual([
        { operation: "session_side_chat_create", input: side },
        { operation: "session_merge_back", input: { sessionId: "side", requestId: "merge" } },
        {
          operation: "session_side_chat_delete",
          input: { sessionId: "side", requestId: "delete" },
        },
      ]);
      // Compacting, continuing a failed reply and clearing travel as the Member's calls.
      yield* invoke("agent-runtime:session:compact", {
        ...target,
        requestId: "retry",
        failedRunId: "failed",
      });
      yield* invoke("agent-runtime:session:clear-context", { ...target, requestId: "clear" });
      expect(calls.slice(-2)).toEqual([
        {
          operation: "session_compact",
          input: { ...target, requestId: "retry", failedRunId: "failed" },
        },
        { operation: "session_clear_context", input: { ...target, requestId: "clear" } },
      ]);
      // An edit reaches the host without this window's presentation.
      yield* invoke("agent-runtime:session:rewrite-message", {
        ...target,
        requestId: "edit",
        runId: "run",
        presentationTicket: { ticketId: "00000000-0000-4000-8000-000000000000" },
        message: { ...message, messageId: "edited" },
      });
      expect(calls.at(-1)).toEqual({
        operation: "session_rewrite_message",
        input: {
          ...target,
          requestId: "edit",
          runId: "run",
          message: { ...message, messageId: "edited" },
        },
      });
    }),
  ),
);

it.effect("shows a hosted chat's picture on a team desktop, read whole from its Space host", () =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-hosted-picture-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    // Larger than one range, so the desktop reads it in several pinned to one version.
    const photo = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES + 4096, 7),
    ]);
    const recorded = {
      photo: { bytes: photo, mimeType: "image/png" },
      page: { bytes: Buffer.from("<html><script>alert(1)</script>"), mimeType: "image/png" },
      poster: {
        bytes: Buffer.concat([
          photo.subarray(0, 8),
          Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
        ]),
        mimeType: "image/png",
      },
    };
    for (const [name, { bytes }] of Object.entries(recorded))
      yield* Effect.promise(() => writeFile(join(home, name), bytes));
    const attachments = yield* makeChatAttachments.pipe(
      Effect.provide(testLayer()),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: (sessionId: string) =>
          Effect.flatMap(HostInvocation, (proof) =>
            Effect.succeed(
              proof === "proof:bob" && sessionId === "session"
                ? ({ id: sessionId } as never)
                : null,
            ),
          ),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        attachment: ({ attachmentId }: { attachmentId: keyof typeof recorded }) =>
          Effect.succeed({
            path: join(home, attachmentId),
            attachment: { name: `${attachmentId}.png`, mimeType: recorded[attachmentId].mimeType },
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
    );
    const host = { attachments } as unknown as HeadlessHost["Service"];
    const calls: components["schemas"]["HostCall"][] = [];
    const collector = makeSpaceIpcCollector({ routes: () => true });
    yield* Layer.build(
      live.pipe(
        Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
        Layer.provide(
          Layer.succeed(
            CoreSessionAccess,
            CoreSessionAccess.of({
              handshake: Effect.die("No handshake is needed"),
              use: (_operation, run) =>
                Effect.promise((signal) =>
                  run(
                    {
                      hostCall: (call: components["schemas"]["HostCall"]) => {
                        calls.push(call);
                        // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- Stands in for Core's Promise-facing host relay.
                        return Effect.runPromise(
                          executeHostCommand(host, {
                            id: "call",
                            credential: "proof:bob",
                            call,
                          }).pipe(
                            Effect.map((value) => ({
                              status: "ok" as const,
                              value: value ?? null,
                            })),
                          ),
                        );
                      },
                    } as never,
                    signal,
                  ),
                ),
            }),
          ),
        ),
        Layer.provide(Layer.succeed(CoreModules, {} as CoreModules["Service"])),
        Layer.provide(memberLibrary()),
      ),
    );
    const read = (attachmentId: string) =>
      collector.invoke("agent-runtime:session:attachment", {} as IpcMainInvokeEvent, [
        { sessionId: "session", threadId: "thread", itemId: "message", attachmentId },
      ]);

    expect(yield* read("photo")).toEqual({
      dataUrl: `data:image/png;base64,${photo.toString("base64")}`,
    });
    expect(
      calls.map(({ operation, input }) => [operation, (input as { offset: number }).offset]),
    ).toEqual([
      ["session_attachment", 0],
      ["session_attachment", HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES],
    ]);
    const [first, second] = calls.map(({ input }) => input as { version?: string });
    expect(first?.version).toBeUndefined();
    expect(second?.version).toEqual(expect.any(String));

    // Bytes that are not a picture never become one, whatever the transcript recorded.
    calls.length = 0;
    expect(yield* read("page")).toBeNull();
    // A picture larger than a chat can hold is not read past its first range.
    expect(yield* read("poster")).toBeNull();
    expect(calls).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect("starts a team desktop's new chat on the Space host with only what the host reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const collector = makeSpaceIpcCollector({ routes: () => true });
      const calls: components["schemas"]["HostCall"][] = [];
      const uploaded: Uploaded[] = [];
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(
            Layer.succeed(CoreSessionAccess, {
              use: (_operation: string, run: CoreSessionOperation<unknown>) =>
                Effect.promise(async () =>
                  run(
                    {
                      hostCall: (call: components["schemas"]["HostCall"]) => {
                        calls.push(call);
                        return Promise.resolve({
                          status: "ok",
                          value: { sessionId: "draft", threadId: "thread", projectId: null },
                        });
                      },
                    } as never,
                    new AbortController().signal,
                  ),
                ),
            } as unknown as CoreSessionAccess["Service"]),
          ),
          Layer.provide(Layer.succeed(CoreModules, {} as never)),
          Layer.provide(memberLibrary(uploaded)),
        ),
      );
      const launched = yield* collector.invoke(
        "agent-runtime:session:launch",
        {} as IpcMainInvokeEvent,
        [
          {
            sessionId: "draft",
            projectId: null,
            launchId: "launch",
            acceptedAt: 1,
            presentationTicket: { ticketId: "00000000-0000-4000-8000-000000000000" },
            title: "Summarize the plan",
            modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
            interactionMode: "default",
            runtimeMode: "full-access",
            runInTarget: "localProject",
            runInEnvironmentPath: "/Users/bob/.codex/environment.toml",
            message: {
              messageId: "message",
              text: "Summarize the plan",
              images: [{ source: "/Users/bob/Desktop/shot.png", caption: "shot.png" }],
            },
          },
        ],
      );
      expect(launched).toEqual({ sessionId: "draft", threadId: "thread", projectId: null });
      // The host chooses where it runs and with what permissions; this computer's picture is the
      // Member's own Library File and nothing that presents the turn here crosses to it.
      expect(calls).toEqual([
        {
          operation: "session_start",
          input: {
            sessionId: "draft",
            launchId: "launch",
            acceptedAt: 1,
            projectId: null,
            title: "Summarize the plan",
            modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
            interactionMode: "default",
            runInTarget: "localProject",
            message: {
              messageId: "message",
              text: "Summarize the plan",
              fileRefs: [fileSource(uploaded[0]!.fileId)],
            },
          },
        },
      ]);
    }),
  ),
);

it.effect(
  "renames, archives and moves a hosted chat on its Space host as the Member, keeping Core's refusal",
  () =>
    Effect.gen(function* () {
      const notYours = new CoreModuleResponseError({
        code: "unauthorized",
        message: "Only the person who started this chat or a Space Owner can do this",
        retryable: false,
        recovery: { kind: "none" },
      });
      const received: { method: string; invocation: string | null; input: unknown }[] = [];
      const apply = { status: "no_op", observed: { store_epoch: "epoch", commit_seq: 9 } } as never;
      const record = <A>(method: string, input: unknown, value: A) =>
        Effect.flatMap(HostInvocation, (invocation) =>
          Effect.sync(() => {
            received.push({ method, invocation, input });
            return value;
          }),
        );
      const host = {
        sessions: {
          renameSession: (input: unknown) =>
            record("renameSession", input, { value: { id: "session" }, apply }),
          archiveSession: (input: unknown) =>
            record("archiveSession", input, null).pipe(
              Effect.andThen(
                Effect.fail(
                  new AgentRuntimeApplicationError({
                    operation: "archive-session",
                    message: "Agent operation failed",
                    cause: notYours,
                  }),
                ),
              ),
            ),
          unarchiveSession: (input: unknown) =>
            record("unarchiveSession", input, { value: { id: "session" }, apply }),
          moveSession: (input: unknown) =>
            record("moveSession", input, { sessionId: "session", projectId: "other" }),
        },
      } as unknown as HeadlessHost["Service"];
      const collector = makeSpaceIpcCollector({ routes: () => true });
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(
            Layer.succeed(
              CoreSessionAccess,
              CoreSessionAccess.of({
                handshake: Effect.die("No handshake is needed"),
                use: (_operation, run) =>
                  Effect.promise((signal) =>
                    run(
                      {
                        hostCall: (call: Parameters<typeof executeHostCommand>[1]["call"]) =>
                          // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- Stands in for Core's Promise-facing host relay.
                          Effect.runPromise(
                            executeHostCommand(host, {
                              id: "call",
                              credential: "proof:bob",
                              call,
                            }).pipe(
                              Effect.map((value) => ({
                                status: "ok" as const,
                                value: value ?? null,
                              })),
                            ),
                          ),
                      } as never,
                      signal,
                    ),
                  ),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(CoreModules, {} as CoreModules["Service"])),
          Layer.provide(memberLibrary()),
        ),
      );
      const invoke = <Channel extends keyof IpcApi>(channel: Channel, input: unknown) =>
        collector.invoke(channel, {} as IpcMainInvokeEvent, [input]);
      const operationId = createBoundedOperationId("test.chat");
      const rename = { operationId, payload: { sessionId: "session", input: { title: "Notes" } } };
      const archive = { operationId, payload: { sessionId: "session" } };
      const move = { operationId, sessionId: "session", projectId: "other" };

      const renamed = yield* invoke("project-sessions:rename", rename);
      assert.strictEqual((renamed as { ok: boolean }).ok, true);
      // Another Member's chat comes back as Core's typed refusal, which the window shows as is.
      assert.deepStrictEqual(yield* invoke("project-sessions:archive", archive), {
        ok: false,
        error: notYours.coreError,
      });
      assert.strictEqual(
        ((yield* invoke("project-sessions:unarchive", archive)) as { ok: boolean }).ok,
        true,
      );
      assert.deepStrictEqual(yield* invoke("agent-runtime:session:move", move), {
        sessionId: "session",
        projectId: "other",
      });
      assert.deepStrictEqual(received, [
        { method: "renameSession", invocation: "proof:bob", input: rename },
        { method: "archiveSession", invocation: "proof:bob", input: archive },
        { method: "unarchiveSession", invocation: "proof:bob", input: archive },
        { method: "moveSession", invocation: "proof:bob", input: move },
      ]);
      // The host validates what a Device sends before any owner sees it.
      const malformed = yield* Effect.exit(
        invoke("project-sessions:rename", { ...rename, payload: { sessionId: "session" } }),
      );
      assert.strictEqual(malformed._tag, "Failure");
      assert.strictEqual(received.length, 4);
    }).pipe(Effect.scoped),
);

/** A team window whose Space host answers every relayed call, recording what it was asked. */
const recordingHost = Effect.gen(function* () {
  const collector = makeSpaceIpcCollector({ routes: () => true });
  const calls: components["schemas"]["HostCall"][] = [];
  yield* Layer.build(
    live.pipe(
      Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
      Layer.provide(
        Layer.succeed(CoreSessionAccess, {
          use: (_operation: string, run: CoreSessionOperation<unknown>) =>
            Effect.promise(async () =>
              run(
                {
                  hostCall: (call: components["schemas"]["HostCall"]) => {
                    calls.push(call);
                    return Promise.resolve({ status: "ok", value: null });
                  },
                } as never,
                new AbortController().signal,
              ),
            ),
        } as unknown as CoreSessionAccess["Service"]),
      ),
      Layer.provide(Layer.succeed(CoreModules, {} as never)),
      Layer.provide(memberLibrary()),
    ),
  );
  return {
    calls,
    invoke: (channel: Parameters<typeof collector.invoke>[0], input: unknown) =>
      collector.invoke(channel, {} as IpcMainInvokeEvent, [input]),
  };
});

it.effect(
  "sends stopping a hosted chat's work, and reading its tasks' output, to the Space host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, invoke } = yield* recordingHost;
        const work = [
          ["agent-runtime:session:stop", "session_stop", { ...target, runId: "run" }],
          [
            "agent-runtime:session:stop-task",
            "session_stop_task",
            { ...target, requestId: "r", runId: "run", taskId: "subagent" },
          ],
          [
            "agent-runtime:session:cancel-task",
            "session_cancel_task",
            { ...target, requestId: "r", taskId: "delegated" },
          ],
          [
            "agent-runtime:session:stop-background",
            "session_stop_background",
            { ...target, requestId: "r", taskIds: ["build"] },
          ],
          [
            "agent-runtime:session:background-output",
            "session_background_output",
            { ...target, taskId: "build" },
          ],
        ] as const;
        for (const [channel, , input] of work) yield* invoke(channel, input);
        // Core admits each stop only from the Run's requester, the chat's owner or a Space Owner.
        expect(calls).toEqual(work.map(([, operation, input]) => ({ operation, input })));
      }),
    ),
);

it.effect("names a hosted transcript's sender by its host, as the Member reads it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, invoke } = yield* recordingHost;
      yield* invoke("agent-runtime:thread:identity", { threadId: "sender" });
      expect(calls).toEqual([{ operation: "thread_identity", input: { threadId: "sender" } }]);
    }),
  ),
);

it.effect("a team window's chat pickers search the host's chats with the Member's invocation", () =>
  Effect.gen(function* () {
    const asked: { method: string; invocation: string | null; input: unknown }[] = [];
    const record = (method: string, result: unknown) => (input: unknown) =>
      Effect.flatMap(HostInvocation, (invocation) =>
        Effect.sync(() => {
          asked.push({ method, invocation, input });
          return result;
        }),
      );
    const host = {
      chats: {
        search: record("search", { matches: [], complete: true }),
        searchMessages: record("searchMessages", { matches: [], sources: [] }),
      },
    } as unknown as HeadlessHost["Service"];
    const client = {
      hostCall: (call: Parameters<typeof executeHostCommand>[1]["call"]) =>
        // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- Stands in for Core's Promise-facing host relay.
        Effect.runPromise(
          executeHostCommand(host, { id: "call", credential: "proof:bob", call }).pipe(
            Effect.map((value) => ({ status: "ok" as const, value: value ?? null })),
          ),
        ),
    };
    const collector = makeSpaceIpcCollector({ routes: () => true });
    yield* Layer.build(
      live.pipe(
        Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
        Layer.provide(
          Layer.succeed(
            CoreSessionAccess,
            CoreSessionAccess.of({
              handshake: Effect.die("No handshake is needed"),
              use: (_operation, run) => Effect.promise((signal) => run(client as never, signal)),
            }),
          ),
        ),
        Layer.provide(Layer.succeed(CoreModules, {} as CoreModules["Service"])),
        Layer.provide(memberLibrary()),
      ),
    );
    const event = {} as IpcMainInvokeEvent;
    assert.deepStrictEqual(
      yield* collector.invoke("chats:search", event, [{ query: "deploy", limit: 20 }]),
      { matches: [], complete: true },
    );
    yield* collector.invoke("chats:search-messages", event, [{ query: "deploy", limit: 20 }]);
    assert.deepStrictEqual(asked, [
      { method: "search", invocation: "proof:bob", input: { query: "deploy", limit: 20 } },
      {
        method: "searchMessages",
        invocation: "proof:bob",
        input: { query: "deploy", limit: 20 },
      },
    ]);
    // The host checks the request before it reads anything.
    const oversized = yield* collector
      .invoke("chats:search", event, [{ query: "deploy", limit: 1_000 }])
      .pipe(Effect.exit);
    assert.isTrue(oversized._tag === "Failure");
    assert.lengthOf(asked, 2);
  }).pipe(Effect.scoped),
);
