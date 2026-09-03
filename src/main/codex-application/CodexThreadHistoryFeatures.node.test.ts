import { assert, it } from "@effect/vitest";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { make } from "./CodexThreadHistoryFeatures";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

const canonical = (historyMode: Thread["historyMode"]) =>
  createCodexCanonicalHydratedConversationState(
    {
      id: "thread-a",
      historyMode,
      turns: [],
    } as unknown as Thread,
    {
      model: "gpt-test",
      reasoningEffort: "high",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );

const conversations = (historyMode: Thread["historyMode"] | null) => {
  const entity =
    historyMode === null
      ? null
      : ({
          readCanonicalState: () => canonical(historyMode),
        } as unknown as ConversationEntityState);
  return ConversationEntityMap.of({
    current: () => entity,
  } as unknown as ConversationEntityMap["Service"]);
};

const capability = (userAgent: string): CodexAppServerCapabilitySnapshot =>
  createCodexAppServerCapabilitySnapshot({
    hostId: "host-a",
    generation: 7,
    sourceEpoch: "epoch-a",
    userAgent,
  });

const capabilities = (
  snapshot: CodexAppServerCapabilitySnapshot,
  current = true,
): CodexAppServerCapabilities["Service"] =>
  CodexAppServerCapabilities.of({
    forThread: () => Effect.succeed(snapshot),
    forHost: () => Effect.succeed(snapshot),
    isCurrent: () => Effect.succeed(current),
  });

const resolve = (
  historyMode: Thread["historyMode"] | null,
  snapshot: CodexAppServerCapabilitySnapshot,
  feature: "prompt-rail" | "persisted-search",
  current = true,
) =>
  make.pipe(
    Effect.provideService(ConversationEntityMap, conversations(historyMode)),
    Effect.provideService(CodexAppServerCapabilities, capabilities(snapshot, current)),
    Effect.flatMap((service) => service.resolve("thread-a", feature)),
  );

it.effect("proves paginated features from the concrete Thread and current host generation", () =>
  Effect.gen(function* () {
    const resolution = yield* resolve(
      "paginated",
      capability("codex-app-server/0.152.0"),
      "persisted-search",
    );

    assert.strictEqual(resolution.status, "available");
    if (resolution.status !== "available") return;
    assert.strictEqual(resolution.feature, "persisted-search");
    assert.strictEqual(resolution.historyMode, "paginated");
    assert.strictEqual(resolution.capability.hostId, "host-a");
    assert.strictEqual(resolution.capability.generation, 7);
  }),
);

it.effect("degrades a concrete legacy Thread without treating it as a runtime failure", () =>
  Effect.gen(function* () {
    const resolution = yield* resolve(
      "legacy",
      capability("codex-app-server/0.152.0"),
      "prompt-rail",
    );

    assert.deepStrictEqual(resolution, {
      status: "unavailable",
      feature: "prompt-rail",
      reason: "thread-history-legacy",
      threadId: "thread-a",
      hostId: "host-a",
      hostGeneration: 7,
      sourceEpoch: "epoch-a",
      appServerVersion: "0.152.0",
      historyMode: "legacy",
    });
  }),
);

it.effect("keeps an unversioned host fail-closed with an explicit unavailable reason", () =>
  Effect.gen(function* () {
    const resolution = yield* resolve(
      "paginated",
      capability("codex-app-server/0.0.0"),
      "prompt-rail",
    );

    assert.strictEqual(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.strictEqual(resolution.reason, "capability-unproven");
    assert.strictEqual(resolution.appServerVersion, "0.0.0");
  }),
);

it.effect("distinguishes a known older host from an unversioned capability source", () =>
  Effect.gen(function* () {
    const resolution = yield* resolve(
      "paginated",
      capability("codex-app-server/0.144.0"),
      "persisted-search",
    );

    assert.strictEqual(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.strictEqual(resolution.reason, "host-unsupported");
    assert.strictEqual(resolution.appServerVersion, "0.144.0");
  }),
);

it.effect("preserves capability transport failures as operational errors", () =>
  make.pipe(
    Effect.provideService(ConversationEntityMap, conversations("paginated")),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forThread: () => Effect.fail(new Error("endpoint unavailable") as never),
      } as unknown as CodexAppServerCapabilities["Service"]),
    ),
    Effect.flatMap((service) => service.resolve("thread-a", "prompt-rail")),
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => assert.strictEqual(failure.reason, "request-failed")),
    ),
  ),
);

it.effect("re-evaluates the concrete Thread history mode without a stale availability cache", () =>
  Effect.gen(function* () {
    let historyMode: Thread["historyMode"] = "legacy";
    const entity = {
      readCanonicalState: () => canonical(historyMode),
    } as unknown as ConversationEntityState;
    const service = yield* make.pipe(
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          current: () => entity,
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilities(capability("codex-app-server/0.152.0")),
      ),
    );

    const legacy = yield* service.resolve("thread-a", "prompt-rail");
    historyMode = "paginated";
    const paginated = yield* service.resolve("thread-a", "prompt-rail");

    assert.strictEqual(legacy.status, "unavailable");
    assert.strictEqual(paginated.status, "available");
  }),
);

it.effect("rejects a stale capability snapshot instead of caching a false downgrade", () =>
  Effect.gen(function* () {
    const failure = yield* resolve(
      "paginated",
      capability("codex-app-server/0.152.0"),
      "prompt-rail",
      false,
    ).pipe(Effect.flip);

    assert.strictEqual(failure.reason, "stale-generation");
  }),
);
