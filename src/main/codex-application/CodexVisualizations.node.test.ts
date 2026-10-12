/* oxlint-disable effecttsgo/strict-effect-provide -- Each test supplies the complete isolated application Layer at its managed entry point. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigTestLayer } from "../app/MainConfig";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2";
import {
  NodeVisualizationFiles,
  type NodeVisualizationRead,
} from "../platform/node/NodeVisualizationFiles";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexVisualizations, live } from "./CodexVisualizations";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";

const threadId = "0197f6e8-8c00-7000-8000-000000000000";
const primary = `/codex/visualizations/2025/07/11/${threadId}/plot.html`;
const fallback = `/workspaces/visualizations/2025/07/11/${threadId}/plot.html`;
const permission: SandboxPolicy = {
  type: "workspaceWrite",
  writableRoots: ["/writable"],
  networkAccess: false,
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
};
const canonical = () =>
  createCodexCanonicalHydratedConversationState(
    { ...buildAgentActivityV2CorpusThread([]), id: threadId, turns: [] },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace/source",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: permission,
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/writable"],
    },
  );

interface Fixture {
  readonly remote?: boolean;
  readonly resolvedHost?: string;
  readonly read?: (path: string) => NodeVisualizationRead;
  readonly remoteMissingPrimary?: boolean;
  readonly remoteSymlinkParent?: boolean;
  readonly retireDuringRead?: boolean;
  readonly disconnected?: boolean;
  readonly changeHostDuringRead?: boolean;
  readonly changeHostRootsDuringRead?: boolean;
}
function fixture(options: Fixture = {}) {
  const hostId = options.remote ? "ssh:test" : "local";
  const paths: string[] = [];
  const contextRequests: string[] = [];
  const state = canonical();
  let generation = 1;
  let resolvedHost = options.resolvedHost ?? hostId;
  let codexHome = "/codex";
  const owner = { readCanonicalState: () => state };
  const files = NodeVisualizationFiles.of({
    canonicalRoot: (root) => Effect.succeed(root),
    temporaryRoots: Effect.succeed(["/task-tmp"]),
    read: ({ path }) =>
      Effect.sync(() => {
        paths.push(path);
        if (options.retireDuringRead) generation += 1;
        if (options.changeHostDuringRead) resolvedHost = "ssh:other";
        if (options.changeHostRootsDuringRead) codexHome = "/replacement";
        return options.read?.(path) ?? { kind: "read", contents: "<html>chart</html>" };
      }),
  });
  const gateway = {
    connection: () =>
      Effect.sync(() =>
        options.disconnected ? { kind: "stopped", hostId } : { kind: "ready", hostId, generation },
      ),
    requestOnHost: (
      selected: string,
      method: string,
      params: { path: string },
      fence: { expectedHostId: string; expectedGeneration: number },
    ) =>
      Effect.suspend<unknown, CodexRuntimeError, never>(() => {
        assert.strictEqual(selected, hostId);
        assert.strictEqual(fence.expectedHostId, hostId);
        assert.strictEqual(fence.expectedGeneration, 1);
        paths.push(params.path);
        if (options.remoteMissingPrimary && params.path === primary)
          return Effect.fail(
            codexRuntimeError({
              operation: "request",
              reason: "request",
              retryable: false,
              cause: new Error("No such file or directory (os error 2)"),
            }),
          );
        if (method === "fs/getMetadata")
          return Effect.succeed({
            isFile: params.path.endsWith(".html"),
            isDirectory: !params.path.endsWith(".html"),
            isSymlink:
              options.remoteSymlinkParent && params.path.endsWith(`/2025/07/11/${threadId}`),
            createdAtMs: 0,
            modifiedAtMs: 0,
          });
        if (options.retireDuringRead) generation += 1;
        return Effect.succeed({
          dataBase64: Buffer.from("<html>remote</html>").toString("base64"),
        });
      }),
  } as unknown as CodexGateway["Service"];
  const context = CodexConversationContext.of({
    read: (requestedThread) =>
      Effect.sync(() => {
        contextRequests.push(requestedThread);
        return {
          threadId: requestedThread,
          rootThreadId: requestedThread,
          parentThreadId: null,
          projectId: null,
          cwd: "/workspace/source",
          writableRoots: ["/writable"],
        };
      }),
  });
  const hosts = {
    resolve: () =>
      Effect.succeed({
        descriptor: {
          hostId,
          kind: options.remote ? "ssh" : "local",
          codexHome,
          managedRoot: "/workspaces",
        },
      }),
  } as unknown as ExecutionHostRuntime["Service"];
  const dependencies = Layer.mergeAll(
    mainConfigTestLayer(),
    Layer.succeed(NodeVisualizationFiles, files),
    Layer.succeed(CodexGateway, gateway),
    Layer.succeed(CodexConversationContext, context),
    Layer.succeed(ExecutionHostRuntime, hosts),
    Layer.succeed(CodexThreadHostResolver, {
      resolve: () => Effect.succeed(resolvedHost),
    }),
    Layer.succeed(ConversationEntityMap, {
      current: () => owner,
    } as unknown as ConversationEntityMap["Service"]),
  );
  return { hostId, paths, contextRequests, layer: live.pipe(Layer.provide(dependencies)) };
}

it.effect("uses the UUID-derived source namespace and preserves configured home precedence", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.deepEqual(
      yield* service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
      { contents: "<html>chart</html>", path: primary },
    );
    assert.deepEqual(test.paths, [primary]);
    assert.deepEqual(test.contextRequests, []);
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not fall through to another file when the primary exceeds the byte limit", () => {
  const test = fixture({ read: () => ({ kind: "too-large" }) });
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.deepEqual(
      yield* service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
      { contents: null, path: null },
    );
    assert.deepEqual(test.paths, [primary]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("resolves normalized absolute HTML only inside the actual source Thread roots", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.strictEqual(
      (yield* service.read({
        hostId: test.hostId,
        sourceThreadId: threadId,
        file: "/workspace/source/plot.html",
      })).path,
      "/workspace/source/plot.html",
    );
    assert.strictEqual(
      (yield* service.read({
        hostId: test.hostId,
        sourceThreadId: threadId,
        file: "/writable/plot.html",
      })).path,
      "/writable/plot.html",
    );
    for (const file of [
      "/outside/plot.html",
      "/workspace/source/../plot.html",
      "/tmp/plot.html",
      "nested/plot.html",
      "Bad_Name.html",
    ])
      assert.isTrue(
        (yield* Effect.result(
          service.read({ hostId: test.hostId, sourceThreadId: threadId, file }),
        ))._tag === "Failure",
      );
    assert.isTrue(test.contextRequests.every((requested) => requested === threadId));
    assert.deepEqual(test.paths, ["/workspace/source/plot.html", "/writable/plot.html"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "rejects a mismatched native host and invalid source identities before filesystem reads",
  () => {
    const test = fixture({ resolvedHost: "ssh:other" });
    return Effect.gen(function* () {
      const service = yield* CodexVisualizations;
      assert.isTrue(
        (yield* Effect.result(
          service.read({ hostId: "local", sourceThreadId: threadId, file: "plot.html" }),
        ))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(
          service.read({ hostId: "local", sourceThreadId: "thread-test", file: "plot.html" }),
        ))._tag === "Failure",
      );
      assert.deepEqual(test.paths, []);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("retires the read result when its native host generation changes", () => {
  const test = fixture({ remote: true, retireDuringRead: true });
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.isTrue(
      (yield* Effect.result(
        service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
      ))._tag === "Failure",
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("restores saved local HTML independently of a disconnected app-server", () => {
  const test = fixture({ disconnected: true });
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.deepEqual(
      yield* service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
      { contents: "<html>chart</html>", path: primary },
    );
    assert.deepEqual(test.paths, [primary]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects remote HTML before IO when its app-server is disconnected", () => {
  const test = fixture({ remote: true, disconnected: true });
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.strictEqual(
      (yield* service
        .read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.deepEqual(test.paths, []);
  }).pipe(Effect.provide(test.layer));
});

for (const change of ["changeHostDuringRead", "changeHostRootsDuringRead"] as const) {
  it.effect(`retires local HTML when ${change}`, () => {
    const test = fixture({ disconnected: true, [change]: true });
    return Effect.gen(function* () {
      const service = yield* CodexVisualizations;
      assert.strictEqual(
        (yield* service
          .read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(test.paths, [primary]);
    }).pipe(Effect.provide(test.layer));
  });
}

it.effect(
  "recognizes the native RPC missing-file response and probes the configured workspace fallback",
  () => {
    const test = fixture({ remote: true, remoteMissingPrimary: true });
    return Effect.gen(function* () {
      const service = yield* CodexVisualizations;
      assert.deepEqual(
        yield* service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
        { contents: "<html>remote</html>", path: fallback },
      );
      assert.isTrue(test.paths.includes(primary));
      assert.isTrue(test.paths.includes(fallback));
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("rejects remote symlink parents before reading HTML contents", () => {
  const test = fixture({ remote: true, remoteSymlinkParent: true });
  return Effect.gen(function* () {
    const service = yield* CodexVisualizations;
    assert.isTrue(
      (yield* Effect.result(
        service.read({ hostId: test.hostId, sourceThreadId: threadId, file: "plot.html" }),
      ))._tag === "Failure",
    );
  }).pipe(Effect.provide(test.layer));
});
