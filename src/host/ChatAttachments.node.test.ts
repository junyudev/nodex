import { describe, expect } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../main/agent-runtime/AgentRuntimeApplication";
import { CodexNativeThreadLookup } from "../main/codex-application/CodexNativeThreadLookup";
import { ExecutionHostRuntime } from "../main/codex-application/ExecutionHostRuntime";
import { CodexGateway } from "../main/codex-runtime/CodexGateway";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
} from "../main/project-application/ProjectWorkspace";
import type { ProjectSession } from "../shared/types";
import { testLayer } from "../main/app/MainConfig";
import { HostInvocation } from "./HostInvocation";
import { make, type ChatAttachmentRead } from "./ChatAttachments";
import { replyPictureAttachmentId } from "../shared/agent-runtime-attachments";
import type { components } from "@nodex/core-protocol";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { FileExportRuntime } from "../main/library-application/FileExportRuntime";
import { LibraryModule } from "../main/library-application/LibraryModule";
import { fileSource } from "../shared/file-resources";
import type { HeadlessHost } from "./HeadlessApplicationLive";
import { executeHostCommand } from "./HostCommands";
import { make as makeMemberMessages, MemberMessageRefusal } from "./MemberMessages";
import { CodexGitProbe } from "../main/codex-application/CodexGitProbe";

describe("ChatAttachments", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const JPEG = Buffer.from("ffd8ffe000104a464946000101", "hex");

  const fixture = Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-chat-attachments-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const files: Record<string, { path: string; mimeType: string; name: string }> = {
      photo: { path: join(home, "photo"), mimeType: "image/png", name: "photo.png" },
      disguised: { path: join(home, "disguised"), mimeType: "image/png", name: "page.png" },
      report: { path: join(home, "report"), mimeType: "application/pdf", name: "report.pdf" },
    };
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(files.photo!.path, PNG),
        writeFile(files.disguised!.path, "<svg onload=alert(1)>"),
        writeFile(files.report!.path, "%PDF-1.7"),
      ]),
    );
    // Core's Session read for the invoking Member; a withdrawn Member reads no chat at all.
    const members = { readable: new Set(["proof:bob"]) };
    const sessionReads: (string | null)[] = [];
    let itemVersion = 1;
    let inline = JPEG;
    const runtimeReads: string[] = [];
    const attachments = yield* make.pipe(
      Effect.provide(testLayer()),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: (sessionId: string) =>
          Effect.flatMap(HostInvocation, (proof) => {
            sessionReads.push(proof);
            if (!proof || !members.readable.has(proof))
              return Effect.fail(
                new ProjectWorkspaceError({ operation: "session.read", cause: "Unauthorized" }),
              );
            return Effect.succeed(sessionId === "chat" ? ({ id: "chat" } as ProjectSession) : null);
          }),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        itemContent: () => Effect.sync(() => ({ contentVersion: String(itemVersion) })),
        attachment: ({ attachmentId }: { attachmentId: string }) =>
          Effect.sync(() => {
            runtimeReads.push(attachmentId);
            if (attachmentId === "tool-result:0")
              return { dataUrl: `data:image/jpeg;base64,${inline.toString("base64")}` };
            const file = files[attachmentId];
            return file ? { path: file.path, attachment: file } : null;
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
    );
    const read = (
      input: Partial<ChatAttachmentRead> & { attachmentId: string },
      proof = "proof:bob",
    ) =>
      attachments
        .read({ sessionId: "chat", itemId: "item", offset: 0, length: 4, ...input })
        .pipe(Effect.provideService(HostInvocation, proof));
    return {
      home,
      files,
      members,
      sessionReads,
      runtimeReads,
      read,
      editInline: () => {
        itemVersion++;
        inline = PNG;
      },
    };
  });

  it.effect(
    "reads a chat's attachment for the Member asking, in ranges pinned to one version",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        const first = yield* test.read({ attachmentId: "photo" });
        expect(first).toMatchObject({
          base64: PNG.subarray(0, 4).toString("base64"),
          totalBytes: PNG.length,
          mimeType: "image/png",
          name: "photo.png",
        });
        const rest = yield* test.read({
          attachmentId: "photo",
          offset: 4,
          length: 64,
          version: first.version,
        });
        const bytes = (...ranges: readonly { base64: string }[]) =>
          Buffer.concat(ranges.map(({ base64 }) => Buffer.from(base64, "base64")));
        expect(bytes(first, rest)).toEqual(PNG);
        expect(rest.version).toBe(first.version);
        // Every range is read as the Member, so Core's read rules apply each time.
        expect(test.sessionReads).toEqual(["proof:bob", "proof:bob"]);

        // A file replaced between ranges is read again from the start, never spliced.
        yield* Effect.promise(async () => {
          const replacement = join(test.home, "replacement");
          await writeFile(replacement, JPEG);
          await rename(replacement, test.files.photo!.path);
        });
        expect(
          yield* test
            .read({ attachmentId: "photo", offset: 4, version: first.version })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "changed" });
        expect(yield* test.read({ attachmentId: "photo" })).toMatchObject({
          mimeType: "image/jpeg",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("reads nothing for a Member Core no longer lets read the chat", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const first = yield* test.read({ attachmentId: "photo" });
      test.members.readable.delete("proof:bob");
      expect(
        yield* test
          .read({ attachmentId: "photo", offset: 4, version: first.version })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "changed" });
      expect(yield* test.read({ attachmentId: "photo" }).pipe(Effect.flip)).toMatchObject({
        reason: "missing",
      });
      // The host's own authority never stands in for a Member, and no other chat is read.
      expect(yield* test.read({ attachmentId: "photo" }, "").pipe(Effect.flip)).toMatchObject({
        reason: "missing",
      });
      test.members.readable.add("proof:bob");
      expect(
        yield* test.read({ sessionId: "other", attachmentId: "photo" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "missing" });
      expect(test.runtimeReads).toEqual(["photo"]);
    }).pipe(Effect.scoped),
  );

  it.effect("names a picture by its own bytes and never one its bytes are not", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      expect(yield* test.read({ attachmentId: "disguised" })).toMatchObject({
        mimeType: "application/octet-stream",
        name: "page.png",
      });
      expect(yield* test.read({ attachmentId: "report" })).toMatchObject({
        mimeType: "application/pdf",
      });
      // Its type is read from the start of the file, whichever range is asked for.
      expect(yield* test.read({ attachmentId: "photo", offset: 8, length: 1 })).toMatchObject({
        mimeType: "image/png",
        base64: PNG.subarray(8, 9).toString("base64"),
      });
    }).pipe(Effect.scoped),
  );

  it.effect("decodes an image a tool returned once per version of its item", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const image = { attachmentId: "tool-result:0" };
      const first = yield* test.read(image);
      expect(first).toMatchObject({ totalBytes: JPEG.length, mimeType: "image/jpeg", name: null });
      const rest = yield* test.read({ ...image, offset: 4, length: 64, version: first.version });
      expect(
        Buffer.concat([first, rest].map(({ base64 }) => Buffer.from(base64, "base64"))),
      ).toEqual(JPEG);
      expect(test.runtimeReads).toEqual(["tool-result:0"]);
      test.editInline();
      expect(
        yield* test.read({ ...image, offset: 4, version: first.version }).pipe(Effect.flip),
      ).toMatchObject({ reason: "changed" });
      expect(yield* test.read(image)).toMatchObject({
        totalBytes: PNG.length,
        mimeType: "image/png",
      });
      expect(test.runtimeReads).toEqual(["tool-result:0", "tool-result:0"]);
    }).pipe(Effect.scoped),
  );

  /**
   * A desktop's connected Codex conversation: its items come from the Codex app-server and a picture
   * saved as a file is read through the execution host that ran it.
   */
  /** A hosted chat's reply that shows pictures from files where its chat works on the host. */
  const replyFixture = Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-reply-pictures-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const star = join(home, "luna-star.png");
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(star, PNG),
        writeFile(join(home, "plot.png"), JPEG),
        writeFile(join(home, "notes.png"), "<svg onload=alert(1)>"),
        writeFile(join(home, "secret.png"), PNG),
      ]),
    );
    const text = [
      `Here it is: ![Luna](${star})`,
      "![Plot](plot.png) and ![Notes](notes.png)",
      "`![Not shown](secret.png)`",
    ].join("\n\n");
    const attachments = yield* make.pipe(
      Effect.provide(testLayer({ platform: process.platform })),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: (sessionId: string) =>
          Effect.succeed(sessionId === "chat" ? ({ id: "chat" } as ProjectSession) : null),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        item: ({ itemId }: { itemId: string }) =>
          Effect.succeed(
            itemId === "reply"
              ? { type: "assistant_message", id: "reply", threadId: "root", text }
              : { type: "user_message", id: itemId, threadId: "root", text },
          ),
        inspect: () => Effect.succeed({ thread: { worktreePath: home } }),
      } as unknown as AgentRuntimeApplication["Service"]),
    );
    const read = (address: string, itemId = "reply", range?: Partial<ChatAttachmentRead>) =>
      attachments
        .read({
          sessionId: "chat",
          itemId,
          attachmentId: replyPictureAttachmentId(address)!,
          offset: 0,
          length: 4,
          ...range,
        })
        .pipe(Effect.provideService(HostInvocation, "proof:bob"));
    return { home, star, read };
  });

  it.effect("reads the pictures a reply shows from this host's files, and nothing else", () =>
    Effect.gen(function* () {
      const test = yield* replyFixture;
      const first = yield* test.read(test.star);
      expect(first).toMatchObject({
        base64: PNG.subarray(0, 4).toString("base64"),
        totalBytes: PNG.length,
        mimeType: "image/png",
        name: "luna-star.png",
      });
      const rest = yield* test.read(test.star, "reply", {
        offset: 4,
        length: 64,
        version: first.version,
      });
      expect(
        Buffer.concat([first, rest].map(({ base64 }) => Buffer.from(base64, "base64"))),
      ).toEqual(PNG);
      // A relative address is read from where the chat works on the host.
      expect(yield* test.read("plot.png")).toMatchObject({ mimeType: "image/jpeg" });
      // Only a picture's bytes leave the host, only a picture the reply shows, only from a reply.
      for (const refused of [
        test.read("notes.png"),
        test.read("secret.png"),
        test.read(join(test.home, "secret.png")),
        test.read(test.star, "question"),
      ])
        expect((yield* refused.pipe(Effect.flip))._tag).toBe("ChatAttachmentRefusal");
    }),
  );

  const nativeFixture = Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-native-pictures-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const screenshot = join(home, "screenshot.png");
    const notes = join(home, "notes.png");
    yield* Effect.promise(() =>
      Promise.all([writeFile(screenshot, PNG), writeFile(notes, "-----BEGIN PRIVATE KEY-----")]),
    );
    const members = { readable: new Set(["proof:bob"]) };
    const hostReads: string[] = [];
    const item = {
      type: "userMessage",
      id: "message",
      content: [
        { type: "text", text: "Look at these", text_elements: [] },
        { type: "localImage", path: screenshot },
        { type: "image", url: `data:image/jpeg;base64,${JPEG.toString("base64")}` },
        { type: "localImage", path: notes },
      ],
    };
    const fileOf = async (path: string) => {
      const bytes = await readFile(path);
      return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const attachments = yield* make.pipe(
      Effect.provide(testLayer()),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: (sessionId: string) =>
          Effect.flatMap(HostInvocation, (proof) => {
            if (!proof || !members.readable.has(proof))
              return Effect.fail(
                new ProjectWorkspaceError({ operation: "session.read", cause: "Unauthorized" }),
              );
            if (sessionId === "runtime-chat")
              return Effect.succeed({
                id: sessionId,
                executionRef: { runtimeId: "runtime", threadId: "thread" },
              } as unknown as ProjectSession);
            return Effect.succeed(
              sessionId === "chat"
                ? ({
                    id: "chat",
                    executionRef: null,
                    thread: {
                      threadId: "codex-thread",
                      executionHostId: "local",
                      backendBinding: { driver: "codex", instanceId: "codex" },
                    },
                  } as unknown as ProjectSession)
                : null,
            );
          }),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(AgentRuntimeApplication, {} as AgentRuntimeApplication["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {
        resolve: (threadId: string, hostId: string) =>
          Effect.succeed({
            threadId,
            hostId,
            thread: {},
            manager: { generation: 1, assertCurrent: () => undefined },
          }),
      } as unknown as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        requestOnHost: (
          _host: string,
          _method: string,
          params: { turnId: string; itemIds: string[] },
        ) =>
          Effect.succeed({
            data:
              params.turnId === "run" && params.itemIds.includes(item.id)
                ? [{ turnId: "run", item }]
                : [],
          }),
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(ExecutionHostRuntime, {
        resolve: () =>
          Effect.succeed({
            transfer: {
              describe: (path: string) =>
                Effect.promise(() => {
                  hostReads.push(path);
                  return fileOf(path);
                }),
              download: ({
                source,
                destinationPath,
              }: {
                source: { path: string };
                destinationPath: string;
              }) =>
                Effect.promise(async () => {
                  await writeFile(destinationPath, await readFile(source.path));
                  return fileOf(destinationPath);
                }),
            },
          }),
      } as unknown as ExecutionHostRuntime["Service"]),
    );
    const read = (
      input: Partial<ChatAttachmentRead> & { attachmentId: string },
      proof = "proof:bob",
    ) =>
      attachments
        .read({
          sessionId: "chat",
          sourceThreadId: "codex-thread",
          itemId: "message",
          runId: "run",
          offset: 0,
          length: 4,
          ...input,
        })
        .pipe(Effect.provideService(HostInvocation, proof));
    return { screenshot, members, hostReads, read };
  });

  it.effect(
    "reads a connected conversation's pictures for the Member, wherever its desktop keeps them",
    () =>
      Effect.gen(function* () {
        const test = yield* nativeFixture;
        // A file on the machine that ran the conversation, read through its execution host.
        const first = yield* test.read({ attachmentId: "input:1" });
        expect(first).toMatchObject({
          totalBytes: PNG.length,
          mimeType: "image/png",
          name: "screenshot.png",
        });
        const rest = yield* test.read({
          attachmentId: "input:1",
          offset: 4,
          length: 64,
          version: first.version,
        });
        expect(
          Buffer.concat([first, rest].map(({ base64 }) => Buffer.from(base64, "base64"))),
        ).toEqual(PNG);
        // Later ranges of that version come from what the first one read.
        expect(test.hostReads).toEqual([test.screenshot]);
        // A picture held in the conversation itself.
        expect(yield* test.read({ attachmentId: "input:2", length: 64 })).toMatchObject({
          base64: JPEG.toString("base64"),
          mimeType: "image/jpeg",
        });

        // A replaced file is a new version, read whole again from the start.
        yield* Effect.promise(() => writeFile(test.screenshot, JPEG));
        const replaced = yield* test.read({ attachmentId: "input:1", length: 64 });
        expect(replaced).toMatchObject({ mimeType: "image/jpeg", base64: JPEG.toString("base64") });
        expect(replaced.version).not.toBe(first.version);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reads no connected conversation's file that is not a picture, nor one the Member cannot",
    () =>
      Effect.gen(function* () {
        const test = yield* nativeFixture;
        const refused = (
          input: Partial<ChatAttachmentRead> & { attachmentId: string },
          proof?: string,
        ) =>
          test.read(input, proof).pipe(
            Effect.flip,
            Effect.map(({ reason }) => reason),
          );
        // A conversation can name any file; only a picture's bytes ever leave the desktop.
        expect(yield* refused({ attachmentId: "input:3" })).toBe("missing");
        // The Member's Core read decides, for every range.
        test.members.readable.delete("proof:bob");
        expect(yield* refused({ attachmentId: "input:1" })).toBe("missing");
        test.members.readable.add("proof:bob");
        expect(yield* refused({ attachmentId: "input:1" }, "")).toBe("missing");
        // The picture is named only by the chat's own conversation, Run and item.
        expect(yield* refused({ attachmentId: "input:1", sourceThreadId: "another" })).toBe(
          "missing",
        );
        expect(yield* refused({ attachmentId: "input:1", runId: "another-run" })).toBe("missing");
        expect(yield* refused({ attachmentId: "input:0" })).toBe("missing");
        expect(yield* refused({ sessionId: "runtime-chat", attachmentId: "input:1" })).toBe(
          "missing",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("has no connected conversation to read where no desktop holds one", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      expect(
        yield* test.read({ attachmentId: "photo", runId: "run" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "missing" });
      expect(test.runtimeReads).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("MemberMessages", () => {
  const make = makeMemberMessages;
  /** The host's checkout of a Project is on its `main` branch. */
  const gitProbe = {
    readPath: (_root: string, args: readonly string[]) =>
      Effect.succeed(args.includes("HEAD") && args[0] === "symbolic-ref" ? "main" : null),
  } as unknown as CodexGitProbe["Service"];

  const sessions: Record<string, Partial<ProjectSession>> = {
    chat: { id: "chat", archived: false, executionRef: { runtimeId: "runtime", threadId: "root" } },
    paused: {
      id: "paused",
      archived: false,
      executionRef: { runtimeId: "runtime", threadId: "root" },
    },
    archived: {
      id: "archived",
      archived: true,
      executionRef: { runtimeId: "runtime", threadId: "root" },
    },
  };

  it.effect("delivers each Member's message as a local chat would, with that Member's proof", () =>
    Effect.gen(function* () {
      const calls: { method: string; input: unknown; proof: string | null }[] = [];
      const reads: { fileId: string; proof: string | null }[] = [];
      const accepted = new Map<string, { fingerprint: string; sequence: number }>();
      let chatArchived = false;
      const library: Record<string, object> = {
        photo: { default_name: "photo.png", mime_type: "image/png", byte_length: 3, version: 2 },
        notes: { default_name: "notes.md", mime_type: "text/markdown", byte_length: 9, version: 1 },
      };
      const record = (method: string) => (input: unknown) =>
        Effect.flatMap(HostInvocation, (proof) =>
          Effect.sync(() => {
            calls.push({ method, input, proof });
            return { sequence: calls.length };
          }),
        );
      const messages = yield* make.pipe(
        Effect.provideService(AgentRuntimeApplication, {
          replayMessage: ({
            sessionId,
            messageId,
            fingerprint,
          }: {
            sessionId: string;
            messageId: string;
            fingerprint: string;
          }) =>
            Effect.gen(function* () {
              const receipt = accepted.get(`${sessionId}:${messageId}`);
              if (receipt && receipt.fingerprint !== fingerprint)
                return yield* new AgentRuntimeApplicationError({
                  operation: "message-replay",
                  message: "This message was already submitted with different content.",
                  admissionRejected: true,
                });
              return receipt ?? null;
            }),
          sendMessage: (input: Parameters<AgentRuntimeApplication["Service"]["sendMessage"]>[0]) =>
            record("sendMessage")(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() =>
                  accepted.set(`${input.sessionId}:${input.message.messageId}`, {
                    fingerprint: input.messageFingerprint!,
                    sequence: result.sequence,
                  }),
                ),
              ),
            ),
          queue: record("queue"),
          rewriteMessage: record("rewriteMessage"),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(ProjectWorkspace, {
          getProjectSession: (id: string) =>
            Effect.succeed(
              id === "chat" && chatArchived
                ? { ...sessions.chat, archived: true }
                : ((sessions[id] as ProjectSession) ?? null),
            ),
        } as unknown as ProjectWorkspace["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: (read: { target: { session_id: string } }) =>
              Effect.succeed({
                value: {
                  kind: "effective_execution_hold",
                  holds:
                    read.target.session_id === "paused"
                      ? [
                          {
                            scope: { kind: "space" },
                            actor: "alice",
                            revision: 1,
                            paused_at: "now",
                          },
                        ]
                      : [],
                },
              }),
          },
        } as unknown as CoreModules["Service"]),
        // Each attached Library File is read as the invoking Member, never with the host's authority.
        Effect.provideService(LibraryModule, {
          read: (_route: unknown, request: { read: { file_id: string } }) =>
            Effect.flatMap(HostInvocation, (proof) =>
              Effect.sync(() => {
                reads.push({ fileId: request.read.file_id, proof });
                return library[request.read.file_id]
                  ? {
                      ok: true,
                      value: {
                        value: {
                          kind: "file_presentation",
                          value: library[request.read.file_id],
                        },
                      },
                    }
                  : { ok: false, error: { code: "resource_not_found", message: "Missing" } };
              }),
            ),
        } as unknown as LibraryModule["Service"]),
        Effect.provideService(FileExportRuntime, {
          materialize: (_route: unknown, input: { fileId: string; version: number }) =>
            Effect.succeed(`/host/exports/${input.fileId}@${input.version}`),
        } as unknown as FileExportRuntime["Service"]),
        Effect.provideService(CodexGitProbe, gitProbe),
      );
      const host = { messages } as unknown as HeadlessHost["Service"];
      const relay = (operation: components["schemas"]["HostOperation"], input: unknown) =>
        executeHostCommand(host, {
          id: "call",
          credential: "alice-proof",
          call: { operation, input },
        });
      const message = { messageId: "m1", text: "Run the loop again" };
      const steerMessage = { ...message, messageId: "steer" };
      const queueMessage = { ...message, messageId: "queue" };

      yield* relay("session_message", { sessionId: "chat", message, delivery: "send" });
      yield* relay("session_message", {
        sessionId: "chat",
        message: steerMessage,
        delivery: "steer",
      });
      yield* relay("session_message", {
        sessionId: "chat",
        message: queueMessage,
        delivery: "queue",
      });
      yield* relay("session_queue", {
        sessionId: "chat",
        requestId: "r1",
        action: "reorder",
        orderedRunIds: ["a", "b"],
      });
      // Files any Device uploaded and the context it references travel with the same delivery.
      const context = { version: 1, records: [{ kind: "page", label: "Plan", payload: {} }] };
      const attached = {
        sessionId: "chat",
        message: {
          ...message,
          messageId: "with-files",
          fileRefs: [fileSource("photo"), fileSource("notes")],
          context,
        },
        delivery: "queue",
      };
      const original = yield* relay("session_message", attached);

      expect(calls).toEqual([
        {
          method: "sendMessage",
          input: {
            sessionId: "chat",
            message,
            mode: "auto",
            messageFingerprint: expect.any(String),
          },
          proof: "alice-proof",
        },
        {
          method: "sendMessage",
          input: {
            sessionId: "chat",
            message: steerMessage,
            mode: "steer",
            messageFingerprint: expect.any(String),
          },
          proof: "alice-proof",
        },
        {
          method: "sendMessage",
          input: {
            sessionId: "chat",
            message: queueMessage,
            mode: "queue",
            messageFingerprint: expect.any(String),
          },
          proof: "alice-proof",
        },
        {
          method: "queue",
          input: {
            sessionId: "chat",
            requestId: "r1",
            action: "reorder",
            orderedRunIds: ["a", "b"],
          },
          proof: "alice-proof",
        },
        {
          method: "sendMessage",
          input: {
            sessionId: "chat",
            message: { ...message, messageId: "with-files", context },
            mode: "queue",
            messageFingerprint: expect.any(String),
            resources: [
              {
                source: "/host/exports/photo@2",
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
              {
                source: "/host/exports/notes@1",
                name: "notes.md",
                mimeType: "text/markdown",
                sizeBytes: 9,
              },
            ],
          },
          proof: "alice-proof",
        },
      ]);
      expect(reads).toEqual([
        { fileId: "photo", proof: "alice-proof" },
        { fileId: "notes", proof: "alice-proof" },
      ]);

      const refused = yield* relay("session_message", {
        sessionId: "archived",
        message,
        delivery: "send",
      }).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(MemberMessageRefusal);
      expect(refused).toMatchObject({ message: "Restore this chat to continue it." });
      // A pause holds every Device's messages until the person resumes it.
      expect(
        yield* relay("session_message", { sessionId: "paused", message, delivery: "queue" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ message: "Resume work to send." });
      // An edit rewinds to the Member's own message and carries what they attached again.
      yield* relay("session_rewrite_message", {
        sessionId: "chat",
        requestId: "edit",
        runId: "run",
        message: { ...message, messageId: "m2", fileRefs: [fileSource("notes")] },
      });
      expect(calls.at(-1)).toEqual({
        method: "rewriteMessage",
        input: {
          sessionId: "chat",
          requestId: "edit",
          runId: "run",
          message: { ...message, messageId: "m2" },
          resources: [
            {
              source: "/host/exports/notes@1",
              name: "notes.md",
              mimeType: "text/markdown",
              sizeBytes: 9,
            },
          ],
        },
        proof: "alice-proof",
      });
      // A file the Member cannot read, or any image bytes or path, never reaches the Runtime.
      expect(
        yield* relay("session_message", {
          sessionId: "chat",
          message: { ...message, messageId: "missing-file", fileRefs: [fileSource("elsewhere")] },
          delivery: "send",
        }).pipe(Effect.flip),
      ).toMatchObject({ message: "This file is unavailable." });
      const rich = yield* relay("session_message", {
        sessionId: "chat",
        message: { ...message, images: [{ source: "/Users/alice/photo.png" }] },
        delivery: "send",
      }).pipe(Effect.exit);
      expect(rich._tag).toBe("Failure");
      chatArchived = true;
      delete library.photo;
      expect(yield* relay("session_message", attached)).toEqual(original);
      const changed = yield* relay("session_message", {
        ...attached,
        message: { ...attached.message, text: "A different prompt" },
      }).pipe(Effect.flip);
      expect(changed).toBeInstanceOf(MemberMessageRefusal);
      expect(changed).toMatchObject({
        message: "This message was already submitted with different content.",
      });
      expect(calls).toHaveLength(6);
      expect(reads.filter(({ fileId }) => fileId === "photo")).toHaveLength(1);
    }),
  );

  it.effect(
    "starts a Member's new chat where the host runs it, delivered once like the Inbox's",
    () =>
      Effect.gen(function* () {
        const launches: { input: Record<string, unknown>; proof: string | null }[] = [];
        const admitted = new Map<string, { sessionId: string; threadId: string }>();
        let paused = false;
        let heldProject: string | null = null;
        const messages = yield* make.pipe(
          Effect.provideService(AgentRuntimeApplication, {
            // The host's tasks directory for a chat without a Project, its checkout for a Project.
            executionWorkspace: (projectId: string | null) =>
              Effect.succeed(
                paused || projectId === "gone"
                  ? { available: false, reason: "Choose an active Project to run this task" }
                  : {
                      available: true,
                      workspaceRoot: projectId ? `/host/projects/${projectId}` : "/host/tasks",
                      sourceRoots: [],
                    },
              ),
            replayMessage: ({ launchId }: { launchId: string }) =>
              Effect.sync(() => admitted.get(launchId) ?? null),
            launch: (input: Record<string, unknown>) =>
              Effect.flatMap(HostInvocation, (proof) =>
                Effect.sync(() => {
                  launches.push({ input, proof });
                  const sessionId = input.sessionId as string;
                  const receipt = { sessionId, threadId: `thread:${sessionId}` };
                  admitted.set(input.launchId as string, receipt);
                  return receipt;
                }),
              ),
          } as unknown as AgentRuntimeApplication["Service"]),
          Effect.provideService(ProjectWorkspace, {} as unknown as ProjectWorkspace["Service"]),
          Effect.provideService(CoreModules, {
            workspace: {
              read: ({ after_key }: { after_key: string | null }) =>
                Effect.succeed({
                  value: {
                    kind: "execution_holds",
                    holds:
                      after_key === "space:"
                        ? paused
                          ? [{ scope: { kind: "space" } }]
                          : []
                        : heldProject
                          ? [{ scope: { kind: "project", project_id: heldProject } }]
                          : [],
                  },
                }),
            },
          } as unknown as CoreModules["Service"]),
          Effect.provideService(LibraryModule, {
            read: () =>
              Effect.succeed({
                ok: true,
                value: {
                  value: {
                    kind: "file_presentation",
                    value: {
                      default_name: "plan.md",
                      mime_type: "text/markdown",
                      byte_length: 4,
                      version: 1,
                    },
                  },
                },
              }),
          } as unknown as LibraryModule["Service"]),
          Effect.provideService(FileExportRuntime, {
            materialize: (_route: unknown, input: { fileId: string }) =>
              Effect.succeed(`/host/exports/${input.fileId}`),
          } as unknown as FileExportRuntime["Service"]),
          Effect.provideService(CodexGitProbe, gitProbe),
        );
        const host = { messages } as unknown as HeadlessHost["Service"];
        const relay = (input: unknown) =>
          executeHostCommand(host, {
            id: "call",
            credential: "bob-proof",
            call: { operation: "session_start", input },
          });
        const start = {
          sessionId: "draft",
          launchId: "launch",
          acceptedAt: 1,
          projectId: null,
          title: "Summarize the plan",
          modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
          interactionMode: "default",
          message: { messageId: "m1", text: "Summarize the plan", fileRefs: [fileSource("plan")] },
        };
        expect(yield* relay(start)).toEqual({
          sessionId: "draft",
          threadId: "thread:draft",
          projectId: null,
        });
        // The starter's proof creates the chat; their Library File is read as a private copy.
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatchObject({
          proof: "bob-proof",
          input: {
            sessionId: "draft",
            projectId: null,
            runInTarget: "localProject",
            message: { messageId: "m1", text: "Summarize the plan" },
            resources: [{ source: "/host/exports/plan", name: "plan.md" }],
          },
        });
        // A retry of the same start finds the chat already started rather than launching it again.
        paused = true;
        expect(yield* relay(start)).toEqual({
          sessionId: "draft",
          threadId: "thread:draft",
          projectId: null,
        });
        expect(
          yield* relay({ ...start, sessionId: "space-held", launchId: "space-held" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ message: "Resume work to start this chat." });
        paused = false;
        heldProject = "crew";
        expect(
          yield* relay({
            ...start,
            sessionId: "project-held",
            launchId: "project-held",
            projectId: "crew",
          }).pipe(Effect.flip),
        ).toMatchObject({ message: "Resume work to start this chat." });
        heldProject = null;
        expect(launches).toHaveLength(1);
        // A worktree starts from the branch the host's checkout of the Project is on.
        yield* relay({
          ...start,
          sessionId: "project-chat",
          launchId: "project-launch",
          projectId: "crew",
          runInTarget: "newWorktree",
        });
        expect(launches.at(-1)?.input).toMatchObject({
          projectId: "crew",
          runInTarget: "newWorktree",
          worktreeStartingState: { type: "branch", branchName: "main" },
        });
        // The host's refusal reads as a product sentence, before anything starts.
        const refused = yield* relay({
          ...start,
          sessionId: "gone",
          launchId: "gone",
          projectId: "gone",
        }).pipe(Effect.flip);
        expect(refused).toMatchObject({ message: "Choose an active Project to run this task" });
        expect(
          yield* relay({
            ...start,
            sessionId: "loose",
            launchId: "loose",
            runInTarget: "newWorktree",
          }).pipe(Effect.flip),
        ).toMatchObject({ message: "Choose a Project for this worktree." });
        expect(launches).toHaveLength(2);
      }),
  );
});
