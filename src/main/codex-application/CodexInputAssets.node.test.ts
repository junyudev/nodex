import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { createHash } from "node:crypto";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { CoreClientPort } from "../core-client/types";
import type { CodexPreparedPrompt } from "../../shared/types";
import { createCodexQueuedFollowUp } from "../../shared/codex-queued-follow-up-state";
import { makeCodexInputAssets } from "./CodexInputAssets";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-queue-payload-"));
const assetsRoot = path.join(fixtureRoot, "assets");
fs.mkdirSync(assetsRoot, { recursive: true });

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function fixture() {
  const stagingRootPath = fs.mkdtempSync(path.join(fixtureRoot, "staging-"));
  const blobs = new Map<string, Buffer>();
  const retained: Array<Parameters<CoreClientPort["workspaceApply"]>[0]> = [];
  const handshake = createFakeCoreHandshake({
    profileId: "profile:test",
    libraryId: "library:test",
    storeEpoch: "epoch:test",
  });
  const client = Object.assign(new FakeCoreClient(), {
    handshake,
    prepareBlob: async (input: Parameters<CoreClientPort["prepareBlob"]>[0]) => {
      const hash = createHash("sha256").update(input.bytes).digest("hex");
      blobs.set(hash, Buffer.from(input.bytes));
      return {
        receipt_id: `${input.operationId}:${hash}`,
        blob_etag: hash,
        byte_length: input.bytes.byteLength,
        expires_at_unix_ms: 60_000,
      };
    },
    readThreadAssetBlob: async (input: Parameters<CoreClientPort["readThreadAssetBlob"]>[0]) => {
      const bytes = blobs.get(input.contentHash);
      if (!bytes || input.threadId !== "thread-1") throw new Error("Thread input is unavailable");
      return { bytes, mimeType: "application/octet-stream", etag: input.contentHash };
    },
    workspaceApply: async (input: Parameters<CoreClientPort["workspaceApply"]>[0]) => {
      retained.push(input);
      return {} as Awaited<ReturnType<CoreClientPort["workspaceApply"]>>;
    },
  }) as unknown as CoreGenerationClient;
  const sessions = CoreSessionAccess.of({
    handshake: Effect.succeed(handshake),
    use: (operation, run) =>
      Effect.tryPromise({
        try: (signal) => run(client, signal),
        catch: (cause) =>
          coreRuntimeError({ operation, cause, reason: "operation", retryable: false }),
      }),
  });
  return {
    stagingRootPath,
    blobs,
    retained,
    store: makeCodexInputAssets({
      stagingRootPath,
      sourceAssetsRootPath: assetsRoot,
      sessions,
    }),
  };
}

it.effect("freezes volatile prompt evidence and hydrates portable file attachments", () =>
  Effect.gen(function* () {
    const localFile = path.join(fixtureRoot, "notes.txt");
    fs.writeFileSync(localFile, "durable queue notes");
    const { store, stagingRootPath, blobs } = fixture();
    const row = createCodexQueuedFollowUp({
      followUpId: "follow-up-1",
      clientUserMessageId: "client-1",
      threadId: "thread-1",
      prompt: "Inspect the evidence",
      createdAtMs: 10,
      promptInput: {
        text: "Inspect the evidence",
        images: [{ source: "data:image/png;base64,cXVldWUtaW1hZ2U=" }],
        fileAttachments: [{ label: "notes.txt", path: localFile, fsPath: localFile }],
        agentConfigs: [
          {
            mode: "plan",
            provider: "openai",
            model: "gpt-5.6-sol",
            reasoning: "high",
            speed: "fast",
            permission: "auto",
          },
        ],
      },
    });

    const frozen = yield* store.freeze(row);
    assert.isNotNull(frozen.payloadRef);
    assert.strictEqual(frozen.promptInput.images?.[0]?.source, row.promptInput.images?.[0]?.source);
    assert.isTrue(path.isAbsolute(frozen.promptInput.fileAttachments?.[0]?.fsPath ?? ""));
    assert.strictEqual(blobs.size, 0, "freeze only stages local bytes");

    const frozenAgain = yield* store.freeze(row);
    assert.strictEqual(frozenAgain.payloadRef?.sha256, frozen.payloadRef?.sha256);

    const receipts = yield* store.publish("thread-1", "queue-commit", [frozen]);
    assert.strictEqual(receipts.length, 3, "manifest and both attachments are prepared together");
    fs.writeFileSync(localFile, "changed after capture");
    fs.rmSync(stagingRootPath, { recursive: true });
    const hydrated = yield* store.hydrate({
      followUpId: frozen.followUpId,
      clientUserMessageId: frozen.clientUserMessageId,
      threadId: frozen.threadId,
      createdAtMs: frozen.createdAtMs,
      pause: frozen.pause,
      payloadRef: frozen.payloadRef!,
    });
    assert.strictEqual(hydrated.prompt, row.prompt);
    assert.isTrue(path.isAbsolute(hydrated.promptInput.fileAttachments?.[0]?.fsPath ?? ""));
    assert.strictEqual(
      fs.readFileSync(hydrated.promptInput.fileAttachments?.[0]?.fsPath ?? "", "utf8"),
      "durable queue notes",
    );
    assert.deepStrictEqual(hydrated.promptInput.agentConfigs, row.promptInput.agentConfigs);
  }),
);

it.effect("rejects corrupted Core bytes even when a matching local cache exists", () =>
  Effect.gen(function* () {
    const { store, stagingRootPath, blobs } = fixture();
    const frozen = yield* store.freeze(
      createCodexQueuedFollowUp({
        followUpId: "follow-up-corrupt",
        clientUserMessageId: "client-corrupt",
        threadId: "thread-1",
        prompt: "Keep me intact",
        createdAtMs: 20,
      }),
    );
    yield* store.publish("thread-1", "queue-corrupt", [frozen]);
    assert.isTrue(fs.existsSync(stagingRootPath));
    blobs.set(frozen.payloadRef!.sha256, Buffer.from("{}"));

    const exit = yield* Effect.exit(
      store.hydrate({
        followUpId: frozen.followUpId,
        clientUserMessageId: frozen.clientUserMessageId,
        threadId: frozen.threadId,
        createdAtMs: frozen.createdAtMs,
        pause: frozen.pause,
        payloadRef: frozen.payloadRef!,
      }),
    );
    assert.isTrue(Exit.isFailure(exit));
  }),
);

const emptyPrepared = (): CodexPreparedPrompt => ({
  promptText: "Inspect inputs",
  inputItems: [],
  pendingInputItems: [],
  fileAttachments: [],
  addedFiles: [],
  pastedTextAttachments: [],
  commentAttachments: [],
  agentConfigs: [],
});

it.effect(
  "retains exact submitted media and managed files while preserving workspace file semantics",
  () =>
    Effect.gen(function* () {
      const { store, retained, blobs } = fixture();
      const imagePath = path.join(assetsRoot, "submitted.png");
      const managedFile = path.join(assetsRoot, "submitted.txt");
      const workspaceFile = path.join(fixtureRoot, "workspace.txt");
      fs.writeFileSync(imagePath, "captured image");
      fs.writeFileSync(managedFile, "captured text");
      const prepared = emptyPrepared();
      prepared.inputItems = [
        { type: "localImage", path: imagePath, detail: "high" },
        { type: "image", url: "data:audio/wav;base64,YXVkaW8=" },
      ];
      // A declared image cannot silently become audio.
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(store.retainPrepared("thread-1", "invalid-kind", prepared, true)),
        ),
      );
      prepared.inputItems[1] = { type: "audio", url: "data:audio/wav;base64,YXVkaW8=" };
      prepared.pendingInputItems = [{ type: "localImage", path: imagePath, detail: "low" }];
      prepared.fileAttachments = [
        { label: "submitted.txt", path: managedFile, fsPath: managedFile },
        { label: "workspace.txt", path: workspaceFile, fsPath: workspaceFile },
      ];
      const captured = yield* store.retainPrepared("thread-1", "message-1", prepared, true);
      assert.strictEqual(retained.length, 1);
      assert.strictEqual(retained[0]?.intent.kind, "retain_thread_assets");
      assert.strictEqual(blobs.size, 3);
      assert.deepStrictEqual(captured.inputItems[0], {
        type: "image",
        detail: "high",
        url: "data:image/png;base64,Y2FwdHVyZWQgaW1hZ2U=",
      });
      assert.deepStrictEqual(captured.pendingInputItems[0], {
        type: "image",
        detail: "low",
        url: "data:image/png;base64,Y2FwdHVyZWQgaW1hZ2U=",
      });
      assert.deepStrictEqual(captured.fileAttachments[1], prepared.fileAttachments[1]);
      fs.writeFileSync(managedFile, "changed source");
      assert.strictEqual(
        fs.readFileSync(captured.fileAttachments[0]!.fsPath, "utf8"),
        "captured text",
      );
      yield* store.retainPrepared("thread-1", "message-1", captured, true);
      assert.strictEqual(retained[1]?.operationId, retained[0]?.operationId);
      assert.deepStrictEqual(retained[1]?.intent, retained[0]?.intent);
    }),
);

it.effect("never probes a remote host's local media path", () =>
  Effect.gen(function* () {
    const { store, retained, blobs } = fixture();
    const prepared = emptyPrepared();
    prepared.inputItems = [
      { type: "localImage", path: "/remote-only/missing.png" },
      { type: "localAudio", path: "/remote-only/missing.wav" },
    ];
    const captured = yield* store.retainPrepared("thread-1", "remote-input", prepared, false);
    assert.deepStrictEqual(captured, prepared);
    assert.strictEqual(retained.length, 0);
    assert.strictEqual(blobs.size, 0);
  }),
);
