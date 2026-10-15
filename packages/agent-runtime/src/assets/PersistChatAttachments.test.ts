// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { persistChatAttachments } from "./PersistChatAttachments.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "nodex-persist-attachments-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "publishes one complete copy under concurrent retries, preserves native edits, and gives changed bytes another identity",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const request = {
        threadId: ThreadId.make("thread:atomic-images"),
        messageId: MessageId.make("message:atomic-images"),
        attachments: [
          {
            type: "image" as const,
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,AQID",
          },
        ],
      };
      const copies = yield* Effect.all(
        Array.from({ length: 8 }, () => persistChatAttachments(request)),
        { concurrency: "unbounded" },
      );
      expect(new Set(copies.map((copy) => copy[0]!.id)).size).toBe(1);
      const attachment = copies[0]![0]!;
      const file = NodePath.join(config.attachmentsDir, attachmentRelativePath(attachment)!);
      expect(NodeFS.readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
      expect(NodeFS.statSync(file).nlink).toBe(1);
      NodeFS.writeFileSync(file, new Uint8Array([9, 9, 9]));
      const retry = yield* persistChatAttachments(request);
      expect(retry[0]!.id).toBe(attachment.id);
      expect(NodeFS.readFileSync(file)).toEqual(Buffer.from([9, 9, 9]));
      const changed = yield* persistChatAttachments({
        ...request,
        attachments: [{ ...request.attachments[0]!, dataUrl: "data:image/png;base64,BAUG" }],
      });
      expect(changed[0]!.id).not.toBe(attachment.id);
      expect(
        NodeFS.readFileSync(
          NodePath.join(config.attachmentsDir, attachmentRelativePath(changed[0]!)!),
        ),
      ).toEqual(Buffer.from([4, 5, 6]));
      expect(NodeFS.readFileSync(file)).toEqual(Buffer.from([9, 9, 9]));
      expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);
