import { describe, expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import { MOBILE_UPLOAD_MAX_BYTES, MOBILE_FILE_CHUNK_BYTES } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { fileSource, parseFileSource } from "../../shared/file-resources";
import { testLayer as configLayer } from "../../main/app/MainConfig";
import { CoreAuthority } from "../../main/core-runtime/CoreAuthority";
import { FileExportRuntime } from "../../main/library-application/FileExportRuntime";
import { LibraryModule } from "../../main/library-application/LibraryModule";
import { live as profileFiles } from "../../main/platform/node/PhoneFiles";
import {
  ChatAttachmentRefusal,
  ChatAttachments,
  type ChatAttachmentRead,
} from "../ChatAttachments";
import { attachmentRef, makeMobileFiles, decodeUploadChunk, parseAttachmentRef } from "./files";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import {
  MemberMessages,
  type HostedChatMessageInput,
  type HostedChatStartInput,
  type MemberChatStartInput,
} from "../MemberMessages";
import {
  agentRuntimeProviderFixture,
  agentRuntimeSnapshotFixture,
} from "../../shared/testing/agent-runtime-snapshot";
import { createUuidV7, createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { makeMobileChatCommands } from "./chat-commands";
import {
  mobileAgentChoice,
  inboxBody,
  mobileOperationId,
  projectInboxEntry,
  projectTurnReplyCapability,
  makeMobileInbox,
} from "./inbox";
import { HostInvocation } from "../HostInvocation";
import { invokeMobileRpc, type MobileHandlers } from "./rpc";
import type { InboxItem, InboxProposal, InboxScope, InboxDispatchInput } from "../../shared/inbox";
import { isBoundedOperationId } from "../../shared/operation-identity";
import { WorkApplication } from "../work-application/WorkApplication";
import { InboxApplication } from "../inbox-application/InboxApplication";
import {
  captureInbox,
  inboxOverRealCore,
} from "../inbox-application/InboxApplication.test-support";

describe("files", () => {
  const fixture = (library?: LibraryModule["Service"]) =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-mobile-files-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const versionReads: number[] = [];
      let version = 1;
      let content = Buffer.from("abcdefgh");
      const attachmentReads: ChatAttachmentRead[] = [];
      let staged: Uint8Array = new Uint8Array();
      const uploaded = new Map<string, { bytes: Uint8Array; mimeType: string; name: string }>();
      const files = yield* makeMobileFiles.pipe(
        Effect.provide(configLayer({ nodexHome: home })),
        Effect.provide(profileFiles),
        Effect.provide(NodeFileSystem.layer),
        Effect.provideService(ChatAttachments, {
          read: (input: ChatAttachmentRead) =>
            Effect.suspend(() => {
              attachmentReads.push(input);
              if (input.attachmentId === "gone")
                return Effect.fail(new ChatAttachmentRefusal({ reason: "missing" }));
              if (input.version === "stale")
                return Effect.fail(new ChatAttachmentRefusal({ reason: "changed" }));
              return Effect.succeed({
                base64: "YWI=",
                totalBytes: 8,
                mimeType: "image/png",
                name: "photo.png",
                version: "current",
              });
            }),
        }),
        Effect.provideService(FileExportRuntime, {} as FileExportRuntime["Service"]),
        Effect.provideService(CoreAuthority, {
          identity: { storeEpoch: "epoch" },
        } as CoreAuthority["Service"]),
        Effect.provideService(
          LibraryModule,
          library ??
            ({
              read: (_: unknown, { read }: { read: { mode: string; file_id: string } }) =>
                Effect.sync(() => {
                  const file = uploaded.get(read.file_id);
                  if (file)
                    return {
                      ok: true,
                      value: {
                        value: {
                          kind: read.mode,
                          value: {
                            version: 1,
                            head_version: 1,
                            revision: 1,
                            lifecycle: "live",
                            mime_type: file.mimeType,
                            default_name: file.name,
                            byte_length: file.bytes.length,
                            blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                          },
                        },
                      },
                    };
                  if (read.file_id !== "example")
                    return { ok: false, error: { code: "resource_not_found" } };
                  return {
                    ok: true,
                    value: {
                      value: {
                        kind: "file_presentation",
                        value: {
                          version,
                          mime_type: "text/plain",
                          default_name: "example.txt",
                        },
                      },
                    },
                  };
                }),
              prepareFileBlob: (_: unknown, _operation: string, _slot: string, bytes: Uint8Array) =>
                Effect.sync(() => {
                  staged = bytes;
                  return { receipt_id: "prepared" };
                }),
              apply: (
                _: unknown,
                {
                  operation,
                }: {
                  operation: {
                    change: { file_id: string; mime_type: string; default_name: string };
                  };
                },
              ) =>
                Effect.sync(() => {
                  const change = operation.change;
                  if (uploaded.has(change.file_id)) return { ok: false };
                  uploaded.set(change.file_id, {
                    bytes: staged,
                    mimeType: change.mime_type,
                    name: change.default_name,
                  });
                  return { ok: true };
                }),
              readFileBlob: (_: unknown, input: { version?: number }) =>
                Effect.sync(() => {
                  versionReads.push(input.version!);
                  return { bytes: content, mimeType: "text/plain", etag: String(version) };
                }),
            } as unknown as LibraryModule["Service"]),
        ),
      );
      return {
        home,
        files,
        versionReads,
        attachmentReads,
        replaceContent: () => {
          version++;
          content = Buffer.from("ABCDEFGH");
        },
      };
    });

  it.effect("reserves upload slots and writes each offset once under concurrent requests", () =>
    Effect.gen(function* () {
      const { home, files } = yield* fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handlers = yield* files.open;
          const begin = handlers["files.upload.begin"];
          const chunk = handlers["files.upload.chunk"];
          const commit = handlers["files.upload.commit"];
          const input = { name: "example.txt", mimeType: "text/plain", size: 2 };
          const attempts = yield* Effect.all(
            Array.from({ length: 6 }, () => begin(input).pipe(Effect.result)),
            { concurrency: "unbounded" },
          );
          const opened = attempts.filter(Result.isSuccess);
          expect(opened).toHaveLength(4);
          expect(attempts.filter(Result.isFailure).map(({ failure }) => failure.code)).toEqual([
            "unavailable",
            "unavailable",
          ]);
          const directories = yield* Effect.promise(() => readdir(home));
          expect(directories).toHaveLength(1);

          const { uploadId } = opened[0]!.success;
          const first = { uploadId, offset: 0, base64: "YQ==" };
          const duplicate = yield* Effect.all(
            [chunk(first).pipe(Effect.result), chunk(first).pipe(Effect.result)],
            { concurrency: 2 },
          );
          expect(duplicate.filter(Result.isSuccess)).toHaveLength(1);
          expect(duplicate.filter(Result.isFailure)[0]?.failure.code).toBe("invalid_params");
          yield* chunk({ uploadId, offset: 1, base64: "Yg==" });
          expect(yield* commit({ uploadId })).toMatchObject({ size: 2, name: input.name });

          const abandoned = opened[1]!.success.uploadId;
          yield* chunk({ uploadId: abandoned, offset: 0, base64: "YQ==" });
          yield* TestClock.adjust("150 seconds");
          expect(
            yield* chunk({ uploadId: abandoned, offset: 1, base64: "Yg==" }).pipe(Effect.flip),
          ).toMatchObject({ code: "not_found" });
          expect(yield* Effect.promise(() => readdir(join(home, directories[0]!)))).toEqual([]);
          yield* begin({ ...input, size: MOBILE_UPLOAD_MAX_BYTES });
        }),
      );
      expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
    }),
  );

  it.effect("downloads many ranges with one Core blob fetch and rejects a replaced version", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const read = (yield* test.files.open)["files.read"];
          const ref = fileSource("example");
          const first = yield* read({ ref, offset: 0, length: 1 });
          const remaining = yield* Effect.forEach(
            [1, 2, 3, 4, 5, 6, 7],
            (offset) => read({ ref, offset, length: 1, version: first.version }),
            { concurrency: 4 },
          );
          expect(
            Buffer.concat(
              [first, ...remaining].map(({ base64 }) => Buffer.from(base64, "base64")),
            ).toString(),
          ).toBe("abcdefgh");
          expect(new Set([first, ...remaining].map(({ version }) => version))).toEqual(
            new Set(["1"]),
          );
          expect(test.versionReads).toEqual([1]);
          test.replaceContent();
          expect(
            yield* read({ ref, offset: 1, length: 1, version: first.version }).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          expect(test.versionReads).toEqual([1]);
          expect(yield* read({ ref, offset: 0, length: 2 })).toMatchObject({
            version: "2",
            base64: "QUI=",
          });
          expect(test.versionReads).toEqual([1, 2]);
        }),
      );
      expect(yield* Effect.promise(() => readdir(test.home))).toEqual([]);
    }),
  );

  it.effect(
    "reads a chat's attachments through the one owner every Device of the Member uses",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture();
        const read = (yield* test.files.open)["files.read"];
        const ref = attachmentRef(["session", "source", "item", "photo"]);
        expect(yield* read({ ref, offset: 0, length: 2 })).toEqual({
          base64: "YWI=",
          totalBytes: 8,
          mimeType: "image/png",
          name: "photo.png",
          version: "current",
        });
        yield* read({ ref, offset: 2, length: 2, version: "current" });
        expect(test.attachmentReads).toEqual([
          {
            sessionId: "session",
            sourceThreadId: "source",
            itemId: "item",
            attachmentId: "photo",
            offset: 0,
            length: 2,
          },
          {
            sessionId: "session",
            sourceThreadId: "source",
            itemId: "item",
            attachmentId: "photo",
            offset: 2,
            length: 2,
            version: "current",
          },
        ]);
        // A connected conversation's picture is also named by its Run.
        yield* read({
          ref: attachmentRef(["session", "codex-thread", "item", "input:1", "run"]),
          offset: 0,
          length: 2,
        });
        expect(test.attachmentReads.at(-1)).toEqual({
          sessionId: "session",
          sourceThreadId: "codex-thread",
          itemId: "item",
          attachmentId: "input:1",
          runId: "run",
          offset: 0,
          length: 2,
        });
        expect(
          yield* read({ ref, offset: 2, length: 2, version: "stale" }).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* read({
            ref: attachmentRef(["session", "source", "item", "gone"]),
            offset: 0,
            length: 2,
          }).pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
      }).pipe(Effect.scoped),
  );

  it.effect.each(["bytes", "type", "trashed"] as const)(
    "an upload leaves an existing File alone after its %s changed on the desktop",
    (change) =>
      Effect.gen(function* () {
        type Stored = { bytes: Uint8Array; mimeType: string; lifecycle: "live" | "trashed" };
        const stored = new Map<string, Stored>();
        let prepared: Uint8Array = new Uint8Array();
        const library = {
          read: (_: unknown, { read }: { read: { mode: string; file_id: string } }) =>
            Effect.sync(() => {
              const file = stored.get(read.file_id);
              if (!file) return { ok: false, error: { code: "resource_not_found" } };
              return {
                ok: true,
                value: {
                  value: {
                    kind: read.mode,
                    value: {
                      lifecycle: file.lifecycle,
                      version: 1,
                      default_name: "photo.png",
                      mime_type: file.mimeType,
                      byte_length: file.bytes.length,
                      blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                    },
                  },
                },
              };
            }),
          prepareFileBlob: (_: unknown, _operation: string, _slot: string, bytes: Uint8Array) =>
            Effect.sync(() => {
              prepared = bytes;
              return { receipt_id: "prepared" };
            }),
          apply: (
            _: unknown,
            {
              operation: { change },
            }: { operation: { change: { kind: string; file_id: string; mime_type: string } } },
          ) =>
            Effect.sync(() => {
              expect(change.kind).toBe("create");
              if (stored.has(change.file_id)) return { ok: false };
              stored.set(change.file_id, {
                bytes: prepared,
                mimeType: change.mime_type,
                lifecycle: "live",
              });
              return { ok: true };
            }),
        } as unknown as LibraryModule["Service"];
        const { files } = yield* fixture(library);
        const handlers = yield* files.open;
        const bytes = Buffer.from("original photo");
        const upload = Effect.gen(function* () {
          const { uploadId } = yield* handlers["files.upload.begin"]({
            name: "photo.png",
            mimeType: "image/png",
            size: bytes.length,
          });
          yield* handlers["files.upload.chunk"]({
            uploadId,
            offset: 0,
            base64: bytes.toString("base64"),
          });
          return { uploadId, ref: yield* handlers["files.upload.commit"]({ uploadId }) };
        });

        const first = yield* upload;
        expect((yield* upload).ref).toEqual(first.ref);
        const firstId = parseFileSource(first.ref.ref)!;
        const edited: Stored = {
          bytes: change === "bytes" ? Buffer.from("desktop edit") : bytes,
          mimeType: change === "type" ? "text/plain" : "image/png",
          lifecycle: change === "trashed" ? "trashed" : "live",
        };
        stored.set(firstId, edited);

        const second = yield* upload;
        expect(second.ref.ref).not.toBe(first.ref.ref);
        expect(stored.get(firstId)).toBe(edited);
        const secondFile = stored.get(parseFileSource(second.ref.ref)!)!;
        expect(Buffer.from(secondFile.bytes).toString()).toBe(bytes.toString());
        expect(secondFile.mimeType).toBe("image/png");

        expect((yield* upload).ref).toEqual(second.ref);
        expect(yield* handlers["files.upload.commit"]({ uploadId: second.uploadId })).toEqual(
          second.ref,
        );
        expect(stored.size).toBe(2);

        // However many copies have since been changed, the photo still lands.
        for (let copy = 0; copy < 12; copy++)
          stored.set(parseFileSource((yield* upload).ref.ref)!, edited);
        const latest = stored.get(parseFileSource((yield* upload).ref.ref)!)!;
        expect(Buffer.from(latest.bytes).toString()).toBe(bytes.toString());
        expect(stored.size).toBe(14);
      }),
  );
});

describe("rpc", () => {
  it.effect("refuses a phone call without Member invocation before invoking its owner", () =>
    Effect.gen(function* () {
      let calls = 0;
      const handlers = {
        "projects.list": () =>
          Effect.sync(() => {
            calls++;
            return { projects: [], libraryInboxCount: 0 };
          }),
      } as unknown as MobileHandlers;
      const refused = yield* Effect.result(invokeMobileRpc(handlers, "projects.list", {}));
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { code: "rejected", retryable: false },
      });
      expect(calls).toBe(0);
      const admitted = yield* invokeMobileRpc(handlers, "projects.list", {}).pipe(
        Effect.provideService(HostInvocation, "core-invocation-context"),
      );
      expect(admitted).toEqual({ projects: [], libraryInboxCount: 0 });
      expect(calls).toBe(1);
    }),
  );

  it.effect(
    "starts chats at the phone's offered effort and leaves other choices to the model",
    () =>
      Effect.gen(function* () {
        const starts: HostedChatStartInput[] = [];
        const commands = yield* makeMobileChatCommands({
          agentChoice: (choice) => Effect.succeed(mobileAgentChoice(choice!)),
        }).pipe(
          Effect.provideService(AgentRuntimeApplication, {
            catalog: () => Effect.succeed([provider]),
          } as unknown as AgentRuntimeApplication["Service"]),
          Effect.provideService(MemberMessages, {
            start: (input: MemberChatStartInput<never>) =>
              Effect.gen(function* () {
                const modelSelection =
                  "resolve" in input.modelSelection
                    ? yield* input.modelSelection.resolve
                    : input.modelSelection;
                starts.push({ ...input, modelSelection });
                return { sessionId: input.sessionId };
              }),
          } as unknown as MemberMessages["Service"]),
          Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
        );
        for (const [effort, expected] of [
          ["high", "high"],
          ["unoffered", "medium"],
          [null, null],
        ] as const) {
          yield* commands.handlers["chats.start"]({
            sessionId: "chat",
            launchId: createUuidV7(),
            messageId: "message",
            text: "Start",
            projectId: null,
            location: "local",
            fileRefs: [],
            agent: { providerInstanceId: "codex", model: "model", reasoningEffort: effort },
          });
          expect(starts.at(-1)?.modelSelection).toEqual({
            instanceId: "codex",
            model: "model",
            ...(expected ? { options: [{ id: "reasoningEffort", value: expected }] } : {}),
          });
        }
      }),
  );

  it.effect(
    "changes only an offered, different effort on a message, preserving the chat's other options",
    () =>
      Effect.gen(function* () {
        const sent: unknown[] = [];
        let reads = 0;
        let alreadyAccepted = false;
        const selection = {
          instanceId: "codex",
          model: "model",
          options: [
            { id: "serviceTier", value: "fast" },
            { id: "futureOption", value: true },
          ],
        };
        const commands = yield* makeMobileChatCommands({
          agentChoice: () => Effect.die("Send uses the chat's Agent"),
        }).pipe(
          Effect.provideService(AgentRuntimeApplication, {
            catalog: () => Effect.succeed([provider]),
            read: () =>
              Effect.sync(() => {
                reads++;
                return {
                  snapshot: agentRuntimeSnapshotFixture({ thread: { modelSelection: selection } }),
                };
              }),
          } as unknown as AgentRuntimeApplication["Service"]),
          Effect.provideService(MemberMessages, {
            send: (
              input: HostedChatMessageInput,
              effort: Parameters<MemberMessages["Service"]["send"]>[1],
            ) =>
              Effect.gen(function* () {
                if (alreadyAccepted) return;
                const modelSelection = effort
                  ? yield* effort.resolve({ sessionId: "chat", threadId: "thread" })
                  : undefined;
                sent.push({
                  ...input,
                  message: { ...input.message, ...(modelSelection ? { modelSelection } : {}) },
                });
              }),
          } as unknown as MemberMessages["Service"]),
          Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
        );
        for (const delivery of ["queue", "steer"] as const) {
          for (const effort of ["high", "medium", "unoffered", null, undefined]) {
            const input = {
              sessionId: "chat",
              messageId: "message",
              text: "Continue",
              fileRefs: ["file"],
              delivery,
            };
            yield* commands.handlers["chat.send"]({
              ...input,
              ...(effort === undefined ? {} : { reasoningEffort: effort }),
            });
            expect(sent.at(-1)).toEqual({
              sessionId: "chat",
              delivery,
              message: {
                messageId: "message",
                text: "Continue",
                fileRefs: ["file"],
                ...(effort === "high"
                  ? {
                      modelSelection: {
                        ...selection,
                        options: [...selection.options, { id: "reasoningEffort", value: "high" }],
                      },
                    }
                  : {}),
              },
            });
          }
        }
        expect(reads).toBe(6); // Null and absent keep the existing send path, with no extra Runtime read.
        alreadyAccepted = true;
        yield* commands.handlers["chat.send"]({
          sessionId: "chat",
          messageId: "message",
          text: "Continue",
          fileRefs: ["file"],
          delivery: "steer",
          reasoningEffort: "high",
        });
        expect(reads).toBe(6);
      }),
  );

  const provider = agentRuntimeProviderFixture({
    models: [
      {
        slug: "model",
        name: "Model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              type: "select",
              id: "reasoningEffort",
              label: "Reasoning",
              currentValue: "medium",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
    ],
  });
});

describe("inbox-files", () => {
  test("Inbox capture uses the same File image Markdown and stable operation identity", () => {
    expect(inboxBody("Keep this", ["file-id"])).toBe("![](nodex://files/file-id)\n\nKeep this");
    const timestamp = 1_000;
    const id = createUuidV7FromTimestamp(timestamp);
    const operation = mobileOperationId("mobile.inbox.capture", id, timestamp);
    expect(operation && isBoundedOperationId(operation)).toBe(true);
    expect(mobileOperationId("mobile.inbox.capture", id, timestamp)).toBe(operation);
    expect(mobileOperationId("mobile.inbox.capture", id, timestamp + 1)).toBeNull();
  });

  const suggestion: InboxProposal = {
    explicitRequest: false,
    confirmedBy: null,
    failureKind: null,
    proposalId: "proposal",
    revision: 2,
    origin: "agent",
    state: "open",
    pageIds: ["page"],
    basis: [{ pageId: "page", contentHash: "hash" }],
    outdated: false,
    action: { type: "move_to_project", projectId: "project" },
    kind: null,
    summary: "File this",
    rationale: null,
    producedBy: null,
    decisionSessionId: null,
    targetProjectName: "Project",
    chat: null,
    failureMessage: null,
    createdAt: "2026-11-04",
    updatedAt: "2026-11-04",
  };

  const inboxItem = (scope: InboxScope): InboxItem => ({
    rowKind: "intake",
    snooze: null,
    turn: null,
    replyToPageId: null,
    pageId: "page",
    pageKey: "P-1",
    pageStatus: null,
    title: "Title",
    body: "Content",
    bodyTruncated: false,
    bodyEditable: true,
    submittedAt: "2026-11-04",
    source: { kind: "user" },
    kind: "question",
    important: true,
    waiting: true,
    suggestionState: "settled",
    suggestionError: null,
    scope,
    location: { kind: "inbox" },
    automationDecision: null,
    revision: 3,
    basis: { pageId: "page", contentHash: "hash" },
    proposal: suggestion,
  });

  test("Inbox projections expose the decision and the kind the phone leads its holds with", () => {
    const scope = { kind: "project" as const, projectId: "project" };
    const message = projectInboxEntry(inboxItem(scope));
    expect(message).toMatchObject({
      scope,
      revision: 3,
      source: { kind: "user", label: null },
      proposal: {
        revision: 2,
        action: { type: "move_to_project", projectId: "project", projectName: "Project" },
      },
    });
    expect(message).toMatchObject({ kind: "question" });
  });

  test.each(["high", null])(
    "a chat suggestion reaches the phone whole with its effort (%s)",
    (reasoningEffort) => {
      const message = projectInboxEntry({
        ...inboxItem({ kind: "library" }),
        proposal: {
          ...suggestion,
          action: {
            type: "new_chat",
            projectId: "project",
            prompt: "Fix the flaky test",
            agent: { instanceId: "codex", model: "gpt", reasoningEffort, serviceTier: null },
            additions: ["Open a pull request when it passes"],
            skills: [{ name: "test-review", reason: "Check the reproduction." }],
          },
          summary: "Start on the flaky test",
          rationale: "It failed three times this week",
          producedBy: "GPT",
          targetProjectName: "Nodex",
        },
      });
      expect(message.rowKind).toBe("intake");
      if (message.rowKind !== "intake") throw new Error("Expected intake");
      expect(message.proposal).toMatchObject({
        summary: "Start on the flaky test",
        rationale: "It failed three times this week",
        origin: "agent",
        producedBy: "GPT",
        action: {
          type: "new_chat",
          projectName: "Nodex",
          prompt: "Fix the flaky test",
          additions: ["Open a pull request when it passes"],
          skills: [{ name: "test-review", reason: "Check the reproduction." }],
          agent: { providerInstanceId: "codex", model: "gpt", reasoningEffort },
        },
      });
    },
  );

  test("file refs carry locators and chunks have a strict decoded byte ceiling", () => {
    expect(parseAttachmentRef(attachmentRef(["session", "thread", "item", "attachment"]))).toEqual([
      "session",
      "thread",
      "item",
      "attachment",
    ]);
    expect(parseAttachmentRef("nodex://chat-attachments/../private")).toBeNull();
    expect(decodeUploadChunk("AQID")).toEqual(Buffer.from([1, 2, 3]));
    expect(decodeUploadChunk("A QID")).toBeNull();
    expect(
      decodeUploadChunk(Buffer.alloc(MOBILE_FILE_CHUNK_BYTES).toString("base64"))?.length,
    ).toBe(MOBILE_FILE_CHUNK_BYTES);
    expect(
      decodeUploadChunk(Buffer.alloc(MOBILE_FILE_CHUNK_BYTES + 1).toString("base64")),
    ).toBeNull();
  });

  test("Turn reply capability stays with the chat's execution owner", () => {
    const native = {
      session_id: "chat",
      project_id: null,
      project_name: null,
      display_title: "Chat",
      thread_id: "native-thread",
      execution_ref: null,
      status: null,
      unread: false,
      archived: false,
    };
    expect(projectTurnReplyCapability(native)).toMatchObject({ kind: "unavailable" });
    expect(
      projectTurnReplyCapability({
        ...native,
        execution_ref: { runtime_id: "runtime", thread_id: "thread" },
      }),
    ).toEqual({ kind: "available" });
    expect(projectTurnReplyCapability(null)).toEqual({ kind: "available" });
  });
});

describe("inbox-over-core", () => {
  it.effect("captures through the mobile Inbox and reads the same Page through Core", () =>
    Effect.gen(function* () {
      const { inbox, client, projectId } = yield* inboxOverRealCore();
      const authority = {
        identity: {
          profileId: client.handshake.generation.profile_id,
          libraryId: client.handshake.library_id,
          storeEpoch: client.handshake.store_epoch,
        },
      } as CoreAuthority["Service"];
      const handlers = yield* makeMobileInbox({
        captureImages: () => Effect.succeed([]),
      }).pipe(
        Effect.provide(profileFiles),
        Effect.provideService(WorkApplication, {
          startWork: () => Effect.die("Capture does not start work"),
          acceptWork: () => Effect.die("Capture does not accept work"),
        }),
        Effect.provideService(InboxApplication, inbox),
        Effect.provideService(CoreAuthority, authority),
      );
      const issuedAt = Date.now();
      const scope = { kind: "project", projectId } as const;
      const input = {
        scope,
        operationId: createUuidV7FromTimestamp(issuedAt),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt,
        text: "Read the capture on the phone.",
        fileRefs: [],
      };
      expect(yield* handlers["inbox.capture"](input)).toEqual({ pageId: input.pageId });
      expect(yield* handlers["inbox.capture"](input)).toEqual({ pageId: input.pageId });
      const window = yield* handlers["inbox.window"]({ scope, filter: "inbox" });
      expect(window.items.filter((item) => item.pageId === input.pageId)).toEqual([
        expect.objectContaining({ body: input.text, source: { kind: "user", label: null }, scope }),
      ]);
      expect(yield* handlers["inbox.message"]({ entryId: input.pageId })).toMatchObject({
        pageId: input.pageId,
        body: input.text,
        bodyTruncated: false,
      });
    }),
  );

  it.effect(
    "freezes the phone's offered effort through Inbox start_chat and guards decision replay",
    () =>
      Effect.gen(function* () {
        const provider = agentRuntimeProviderFixture({
          models: [
            {
              slug: "model",
              name: "Model",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    type: "select",
                    id: "effort",
                    label: "Effort",
                    currentValue: "medium",
                    options: [
                      { id: "medium", label: "Medium" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
        });
        const { inbox, client } = yield* inboxOverRealCore(Effect.void, () =>
          Effect.succeed([provider]),
        );
        const dispatched: InboxDispatchInput[] = [];
        const handlers = yield* makeMobileInbox({ captureImages: () => Effect.succeed([]) }).pipe(
          Effect.provide(profileFiles),
          Effect.provideService(WorkApplication, {
            startWork: () => Effect.die("This starts a chat"),
            acceptWork: () => Effect.die("This starts a chat"),
          }),
          Effect.provideService(InboxApplication, {
            ...inbox,
            dispatch: (input) =>
              Effect.sync(() => dispatched.push(input)).pipe(Effect.andThen(inbox.dispatch(input))),
          }),
          Effect.provideService(CoreAuthority, {
            identity: {
              profileId: client.handshake.generation.profile_id,
              libraryId: client.handshake.library_id,
              storeEpoch: client.handshake.store_epoch,
            },
          } as CoreAuthority["Service"]),
        );
        for (const [effort, expected] of [
          ["high", "high"],
          ["unoffered", "medium"],
        ] as const) {
          const { pageId } = yield* captureInbox(inbox, "Start this chat");
          const input = {
            operationId: createUuidV7(),
            entryId: pageId,
            decision: {
              type: "start_chat" as const,
              projectId: null,
              prompt: null,
              agent: { providerInstanceId: "codex", model: "model", reasoningEffort: effort },
            },
          };
          const started = yield* handlers["inbox.decide"](input);
          expect(started.sessionId).toBeTruthy();
          expect(dispatched.at(-1)?.executionSelection?.modelSelection).toEqual({
            instanceId: "codex",
            model: "model",
            options: [{ id: "effort", value: expected }],
          });
          expect(yield* handlers["inbox.decide"](input)).toEqual(started);
          expect(
            yield* Effect.result(
              handlers["inbox.decide"]({
                ...input,
                decision: {
                  ...input.decision,
                  agent: { ...input.decision.agent, reasoningEffort: "medium" },
                },
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
        }
      }),
  );
});
