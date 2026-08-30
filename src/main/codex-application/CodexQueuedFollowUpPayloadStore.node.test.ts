import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { parseAssetSource } from "../../shared/assets";
import { createCodexQueuedFollowUp } from "../../shared/codex-queued-follow-up-state";
import { makeCodexQueuedFollowUpPayloadStore } from "./CodexQueuedFollowUpPayloadStore";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-queue-payload-"));
const assetsRoot = path.join(fixtureRoot, "assets");
fs.mkdirSync(assetsRoot, { recursive: true });

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

it.effect("freezes volatile prompt evidence and hydrates portable file attachments", () =>
  Effect.gen(function* () {
    const localFile = path.join(fixtureRoot, "notes.txt");
    fs.writeFileSync(localFile, "durable queue notes");
    const store = makeCodexQueuedFollowUpPayloadStore(assetsRoot);
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
    assert.match(frozen.promptInput.images?.[0]?.source ?? "", /^nodex:\/\/assets\//u);
    assert.match(frozen.promptInput.fileAttachments?.[0]?.fsPath ?? "", /^nodex:\/\/assets\//u);

    const frozenAgain = yield* store.freeze(row);
    assert.strictEqual(frozenAgain.payloadRef?.sha256, frozen.payloadRef?.sha256);

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

it.effect("rejects a manifest whose bytes no longer match its durable evidence", () =>
  Effect.gen(function* () {
    const store = makeCodexQueuedFollowUpPayloadStore(assetsRoot);
    const frozen = yield* store.freeze(
      createCodexQueuedFollowUp({
        followUpId: "follow-up-corrupt",
        clientUserMessageId: "client-corrupt",
        threadId: "thread-1",
        prompt: "Keep me intact",
        createdAtMs: 20,
      }),
    );
    const parsed = parseAssetSource(frozen.payloadRef?.assetUri ?? "");
    assert.isNotNull(parsed);
    fs.writeFileSync(path.join(assetsRoot, parsed!.fileName), "{}", "utf8");

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
