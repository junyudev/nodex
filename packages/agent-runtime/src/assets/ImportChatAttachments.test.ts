// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createHash } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { importChatAttachments } from "./ImportChatAttachments.ts";
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "nodex-import-attachments-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "owns all bytes of a legal multi-image path import above the transport frame budget",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const sourceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-large-import-test-" });
      const digests: string[] = [];
      const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const attachments = [];
      for (const [index, value] of [0x51, 0xb4].entries()) {
        const bytes = new Uint8Array(9 * 1024 * 1024).fill(value);
        const source = NodePath.join(sourceRoot, String(index));
        yield* fs.writeFile(source, bytes, { mode: 0o400 });
        digests.push(digest(bytes));
        attachments.push({
          name: `Image ${index + 1}.png`,
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
          source,
        });
      }
      const input = {
        threadId: ThreadId.make("thread:large-images"),
        messageId: MessageId.make("message:large-images"),
        attachments,
      };
      assert.isAbove(
        attachments.reduce((total, item) => total + item.sizeBytes, 0),
        16 * 1024 * 1024,
      );
      assert.isBelow(Buffer.byteLength(JSON.stringify(input)), 16 * 1024 * 1024);
      const imported = yield* importChatAttachments(input);
      for (const attachment of attachments) yield* fs.remove(attachment.source);
      assert.lengthOf(imported, 2);
      for (const [index, attachment] of imported.entries()) {
        const copy = NodePath.join(config.attachmentsDir, attachmentRelativePath(attachment)!);
        assert.equal(attachment.type, "image");
        assert.equal(digest(yield* fs.readFile(copy)), digests[index]);
      }
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "imports authorized files and images durably, dedupes retries and refuses changed resources",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const source = NodePath.join(config.attachmentsDir, "source.txt");
      NodeFS.writeFileSync(source, "resource");
      const request = {
        threadId: ThreadId.make("thread:resources"),
        messageId: MessageId.make("message:resources"),
        attachments: [
          { name: "notes.txt", mimeType: "text/plain", sizeBytes: 8, source },
          {
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 3,
            source: "data:image/png;base64,AQID",
          },
        ],
      };
      const first = yield* importChatAttachments(request);
      const retry = yield* importChatAttachments(request);
      assert.deepEqual(first, retry);
      assert.deepEqual(
        first.map((item) => item.type),
        ["file", "image"],
      );
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(config.attachmentsDir, attachmentRelativePath(first[0]!)!),
          "utf8",
        ),
        "resource",
      );
      NodeFS.writeFileSync(source, "changed-size");
      assert.equal((yield* importChatAttachments(request).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* importChatAttachments({
          ...request,
          attachments: [
            {
              ...request.attachments[0]!,
              source: "/missing",
              sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
            },
          ],
        }).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
