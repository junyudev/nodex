import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
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

it.effect("reads a chat's attachment for the Member asking, in ranges pinned to one version", () =>
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
    expect(yield* test.read({ attachmentId: "photo" })).toMatchObject({ mimeType: "image/jpeg" });
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
    expect(Buffer.concat([first, rest].map(({ base64 }) => Buffer.from(base64, "base64")))).toEqual(
      JPEG,
    );
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
    Effect.provide(testLayer()),
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
    expect(Buffer.concat([first, rest].map(({ base64 }) => Buffer.from(base64, "base64")))).toEqual(
      PNG,
    );
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
                    backendBinding: { kind: "codex" },
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
