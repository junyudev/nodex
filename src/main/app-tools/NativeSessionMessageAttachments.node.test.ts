import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ThreadItem, ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { make, nativeSessionAttachmentResource } from "./NativeSessionMessageAttachments";

it.effect("copies a remote Native attachment only from its verified item and original host", () =>
  Effect.gen(function* () {
    let reads = 0,
      exports = 0;
    const files: string[] = [];
    let downloads = 0;
    const original = Buffer.alloc(13 * 1024 * 1024, 65);
    const sha256 = createHash("sha256").update(original).digest("hex");
    const item: ThreadItem = {
      type: "userMessage",
      id: "item",
      clientId: null,
      content: [{ type: "mention", name: "report", path: "/remote/report.txt" }],
    };
    const entry: ThreadItemEntry = { item, turnId: "run", startedAtMs: null, completedAtMs: null };
    const owner = yield* make.pipe(
      Effect.provideService(CodexNativeThreadLookup, {
        resolve: () =>
          Effect.succeed({
            hostId: "remote",
            thread: { id: "native" },
            manager: { generation: 7, assertCurrent: () => {} },
          }),
      } as never),
      Effect.provideService(CodexGateway, {
        requestOnHost: (
          host: string,
          method: string,
          input: { path?: string; itemIds?: string[]; turnId?: string },
        ) =>
          Effect.sync(() => {
            assert.equal(host, "remote");
            assert.equal(method, "thread/items/read");
            assert.deepEqual(input.itemIds, ["item"]);
            assert.equal(input.turnId, "run");
            reads++;
            return { data: [entry] };
          }),
      } as never),
      Effect.provideService(ExecutionHostRuntime, {
        resolve: (hostId: string) => {
          assert.equal(hostId, "remote");
          return Effect.succeed({
            transfer: {
              describe: (sourcePath: string) =>
                Effect.sync(() => {
                  files.push(sourcePath);
                  return { path: sourcePath, sha256, size: original.length };
                }),
              download: (input: {
                source: { path: string; sha256: string; size: number };
                destinationPath: string;
              }) =>
                Effect.promise(async () => {
                  assert.equal(input.source.path, "/remote/report.txt");
                  downloads++;
                  await writeFile(input.destinationPath, original);
                  return { ...input.source, path: input.destinationPath };
                }),
            },
          });
        },
      } as never),
      Effect.provideService(TemporaryAssets, {
        saveUploadedResource: (resource: { bytes: Buffer; mimeType: string }) => {
          exports++;
          assert.isTrue(resource.bytes.equals(original));
          assert.equal(resource.mimeType, "text/plain");
          return Promise.resolve({ fileName: "retained.txt" });
        },
        resolveAssetPath: () => "/profile/cache/retained.txt",
      } as never),
    );
    const resource = yield* owner({
      hostId: "remote",
      threadId: "native",
      itemId: "item",
      runId: "run",
      attachmentId: "input:0",
    });
    assert.equal(reads, 2);
    assert.deepEqual(files, ["/remote/report.txt"]);
    assert.equal(downloads, 1, "Large files use the streaming owner instead of a Base64 RPC frame");
    assert.equal(exports, 1);
    assert.deepEqual(resource, {
      name: "report",
      mimeType: "text/plain",
      sizeBytes: original.length,
      source: "/profile/cache/retained.txt",
    });
    const invalid = yield* owner({
      hostId: "remote",
      threadId: "native",
      itemId: "item",
      runId: "run",
      attachmentId: "input:99",
    }).pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
    assert.equal(exports, 1, "An invalid reference never exports bytes");
  }),
);

it("maps only producer-owned Native attachment coordinates", () => {
  const item: ThreadItem = {
    type: "userMessage",
    id: "message",
    clientId: null,
    content: [
      { type: "text", text: "/private/file", text_elements: [] },
      { type: "localImage", path: "/image.png" },
      { type: "image", fileId: "provider-file" },
    ],
  };
  assert.isNull(nativeSessionAttachmentResource(item, "input:0"));
  assert.deepEqual(nativeSessionAttachmentResource(item, "input:1"), {
    name: "image.png",
    source: "/image.png",
  });
  assert.isNull(nativeSessionAttachmentResource(item, "input:2"));
  assert.isNull(nativeSessionAttachmentResource(item, "/arbitrary/path"));
  assert.deepEqual(
    nativeSessionAttachmentResource(
      {
        type: "imageGeneration",
        id: "generated",
        status: "completed",
        revisedPrompt: null,
        result: "AQID",
        failure: null,
      },
      "image",
    ),
    { name: "Generated image.png", source: "data:image/png;base64,AQID", mimeType: "image/png" },
  );
});
