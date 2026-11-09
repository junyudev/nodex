import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  NodeId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";
import { keepViewedImage } from "./viewedImageCopy.ts";

// Long enough that the stored output's body is a picture's, not an identifier.
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(256, 7)]);
const now = DateTime.makeUnsafe("2026-11-08T00:00:00.000Z");
const read = (output: unknown, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({
    id: TurnItemId.make("turn-item:read"),
    threadId: ThreadId.make("thread:viewed"),
    runId: null,
    nodeId: NodeId.make("node:read"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: "Read /workspace/screens/rail.png",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "dynamic_tool",
    toolName: "Read",
    viewedImagePath: "/workspace/screens/rail.png",
    input: { file_path: "/workspace/screens/rail.png" },
    output,
  }) as OrchestrationV2TurnItem;
const structured = {
  type: "image",
  file: { base64: PNG.toString("base64"), type: "image/png", originalSize: PNG.length },
};

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "nodex-viewed-" });
  return {
    attachmentsDir,
    fileSystem,
    keep: keepViewedImage({ attachmentsDir, fileSystem, path }),
  };
});

it.effect("keeps the picture a read returned as the item's own attachment", () =>
  Effect.gen(function* () {
    const { attachmentsDir, fileSystem, keep } = yield* fixture;
    for (const output of [
      structured,
      [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
        },
      ],
    ]) {
      const kept = yield* keep(read(output));
      if (kept.type !== "dynamic_tool") throw new Error("Expected the read to stay a tool item");
      expect(kept.viewedImagePath).toBe("/workspace/screens/rail.png");
      const [copy] = kept.attachments ?? [];
      expect(copy).toMatchObject({ type: "image", name: "rail.png", mimeType: "image/png" });
      expect(copy?.sizeBytes).toBe(PNG.length);
      const stored = resolveAttachmentPath({ attachmentsDir, attachment: copy! })!;
      expect(Buffer.from(yield* fileSystem.readFile(stored))).toEqual(PNG);
      // The same read updated again keeps the one copy.
      expect(yield* keep(read(output))).toEqual(kept);
    }
    // A structured result's bytes still leave the stored output; the copy is what the chat shows.
    const stripped = stripUnservedToolOutputImageBytes(yield* keep(read(structured)));
    expect(JSON.stringify(stripped)).not.toContain(PNG.toString("base64"));
    expect(stripped.type === "dynamic_tool" && stripped.attachments).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves a read alone that did not return a picture it can keep", () =>
  Effect.gen(function* () {
    const { attachmentsDir, fileSystem, keep } = yield* fixture;
    const svg = { type: "image", file: { base64: "PHN2Zz4=", type: "image/svg+xml" } };
    for (const item of [
      read(structured, "running"),
      read(structured, "failed"),
      read("File does not exist"),
      read(svg),
      read({ type: "image", file: { type: "image/png", originalSize: 13675 } }),
    ])
      expect(yield* keep(item)).toBe(item);
    expect(yield* fileSystem.readDirectory(attachmentsDir)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a picture its provider named, from the file or the bytes it reported", () =>
  Effect.gen(function* () {
    const { attachmentsDir, fileSystem, keep } = yield* fixture;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "nodex-viewed-src-" });
    const viewedPath = `${workspace}/luna-star.png`;
    yield* fileSystem.writeFile(viewedPath, PNG);
    const step = (toolName: string) =>
      ({ ...read(undefined), toolName, viewedImagePath: viewedPath }) as OrchestrationV2TurnItem;
    for (const [item, source] of [
      [step("imageView"), { type: "file", path: viewedPath }],
      [
        step("imageGeneration"),
        {
          type: "data",
          name: "luna-star.png",
          mimeType: "image/png",
          base64: PNG.toString("base64"),
        },
      ],
    ] as const) {
      const kept = yield* keep(item, source);
      if (kept.type !== "dynamic_tool") throw new Error("Expected the step to stay a tool item");
      expect(kept.viewedImagePath).toBe(viewedPath);
      const [copy] = kept.attachments ?? [];
      expect(copy).toMatchObject({ type: "image", name: "luna-star.png", mimeType: "image/png" });
      const stored = resolveAttachmentPath({ attachmentsDir, attachment: copy! })!;
      expect(Buffer.from(yield* fileSystem.readFile(stored))).toEqual(PNG);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("names a picture whose file cannot be read as unavailable instead of previewing it", () =>
  Effect.gen(function* () {
    const { attachmentsDir, fileSystem, keep } = yield* fixture;
    const gone = "/workspace/screens/gone.png";
    const view = { ...read(undefined), toolName: "imageView", viewedImagePath: gone };
    const kept = yield* keep(view as OrchestrationV2TurnItem, { type: "file", path: gone });
    if (kept.type !== "dynamic_tool") throw new Error("Expected the step to stay a tool item");
    expect(kept.viewedImagePath).toBeUndefined();
    expect(kept.attachments).toBeUndefined();
    expect(kept.unavailableImages).toEqual([
      { name: "gone.png", sourcePath: gone, reason: "source_missing" },
    ]);
    expect(yield* fileSystem.readDirectory(attachmentsDir)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
