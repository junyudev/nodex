import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
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

    Effect.provide(testLayer()),
