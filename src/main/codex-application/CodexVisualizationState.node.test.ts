import { describe, afterAll } from "vite-plus/test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type CodexVisualizationStateIdentity,
  codexVisualizationStateAtomKey,
  codexVisualizationInteractionAtomKey,
} from "../../shared/codex-visualization-state";
import {
  codexVisualizationPassiveParts,
  type CodexVisualizationPassiveContext,
} from "../../shared/codex-visualization-passive-context";
import { ProfilePersistedAtoms } from "../local-store/ProfilePersistedAtoms";
import { PersistedAtomStore } from "../local-store/persisted-atoms";
import { codexClientThreadIdentityAtomKey } from "../codex/codex-client-thread-identity";
import { CodexVisualizationState, live } from "./CodexVisualizationState";
import { testLayer as mainConfigTestLayer } from "../app/MainConfig";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2";
import {
  NodeVisualizationFiles,
  type NodeVisualizationRead,
} from "../platform/node/NodeVisualizationFiles";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ExecutionHostRuntime, ExecutionHostRuntimeError } from "./ExecutionHostRuntime";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexVisualizations, live as liveCodexVisualizations } from "./CodexVisualizations";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import * as Context from "effect/Context";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { layer as scopedCallbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import { CodexAttachments, live as liveCodexAttachments } from "./CodexAttachments";
import { pathToFileURL } from "node:url";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { CoreClientPort } from "../core-client/types";
import type { CodexPreparedPrompt, CodexPromptInput } from "../../shared/types";
import { makeCodexInputAssets } from "./CodexInputAssets";

describe("CodexVisualizationState", () => {
  const identity = { hostId: "local", threadId: "display", path: "/plot.html" };
  const withStore = <E extends Error>(
    run: (
      store: PersistedAtomStore,
      file: string,
    ) => Effect.Effect<void, E, CodexVisualizationState>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-widget-state-"))),
      (directory) => {
        const file = join(directory, "atoms.json");
        const store = new PersistedAtomStore(file);
        return run(store, file).pipe(
          Effect.provide(live.pipe(Layer.provide(Layer.succeed(ProfilePersistedAtoms, store)))),
        );
      },
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
  const write = (
    owner: CodexVisualizationState["Service"],
    target: CodexVisualizationStateIdentity,
    count: number,
  ) =>
    owner.write(
      { identity: target, state: { count }, mutationId: `write-${count}` },
      "renderer-one",
    );
  const payloads = (context: CodexVisualizationPassiveContext | undefined) => {
    assert.isDefined(context);
    return codexVisualizationPassiveParts(context!);
  };
  const interaction = (
    store: PersistedAtomStore,
    target: CodexVisualizationStateIdentity,
    selected: number,
  ) =>
    store.update({
      key: codexVisualizationInteractionAtomKey(target),
      value: { [target.path]: { ...target, state: { modelContent: { selected } } } },
    });

  it.effect(
    "persists interaction context in the same Profile revision, leaves absent clears untouched and retains explicit clears",
    () =>
      withStore((store, file) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          const absent = yield* owner.writeInteraction(
            { identity, state: { modelContent: null }, mutationId: "absent-clear" },
            "renderer-one",
          );
          assert.isNull(absent.event);
          assert.strictEqual(store.readSnapshot().revision, 0);
          const context = {
            edits: [
              { target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] },
            ],
          };
          const confirmed = yield* owner.writeInteraction(
            { identity, state: { modelContent: context }, mutationId: "interaction" },
            "renderer-one",
          );
          assert.isTrue(confirmed.result.ok);
          assert.strictEqual(confirmed.event?.revision, 1);
          const reopened = new PersistedAtomStore(file);
          assert.deepEqual(reopened.readState()[codexVisualizationInteractionAtomKey(identity)], {
            [identity.path]: { ...identity, state: { modelContent: context } },
          });
          const invalid = yield* owner.writeInteraction(
            {
              identity,
              state: { modelContent: { body: "x".repeat(32_768) } },
              mutationId: "oversized",
            },
            "renderer-one",
          );
          assert.isFalse(invalid.result.ok);
          assert.strictEqual(store.readSnapshot().revision, 1);
          const cleared = yield* owner.writeInteraction(
            { identity, state: { modelContent: null }, mutationId: "clear" },
            "renderer-two",
          );
          assert.strictEqual(cleared.event?.revision, 2);
          assert.deepEqual(store.readState()[codexVisualizationInteractionAtomKey(identity)], {
            [identity.path]: { ...identity, state: { modelContent: null } },
          });
        }),
      ),
  );
  it.effect("an interaction write that cannot be saved is not acknowledged", () =>
    withStore((_store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* owner.writeInteraction(
          { identity, state: { modelContent: { selected: 1 } }, mutationId: "first" },
          "renderer-one",
        );
        rmSync(file);
        mkdirSync(file);
        const result = yield* owner.writeInteraction(
          { identity, state: { modelContent: { selected: 2 } }, mutationId: "failed" },
          "renderer-one",
        );
        assert.deepEqual(result, {
          result: { ok: false, code: "storage_unavailable", retryable: false },
          event: null,
        });
      }),
    ),
  );

  it.effect(
    "isolates display host/Thread/file and reloads confirmed state with a fresh Main owner",
    () =>
      withStore((_store, file) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          assert.strictEqual(yield* owner.read(identity), null);
          const targets = [
            identity,
            { ...identity, hostId: "ssh" },
            { ...identity, threadId: "other" },
            { ...identity, path: "/second.html" },
          ];
          for (const [index, target] of targets.entries()) yield* write(owner, target, index);
          for (const [index, target] of targets.entries())
            assert.deepEqual(yield* owner.read(target), {
              modelContent: null,
              privateContent: null,
              count: index,
            });
          const replacement = live.pipe(
            Layer.provide(Layer.succeed(ProfilePersistedAtoms, new PersistedAtomStore(file))),
          );
          assert.deepEqual(
            yield* Effect.flatMap(CodexVisualizationState, (next) => next.read(identity)).pipe(
              Effect.provide(replacement),
            ),
            { modelContent: null, privateContent: null, count: 0 },
          );
        }),
      ),
  );

  it.effect(
    "merges interleaved widget, client identity, and renderer atom writes in one cache and revision",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          yield* write(owner, identity, 1);
          store.update({
            key: codexClientThreadIdentityAtomKey("local", "native"),
            value: "client-alias",
          });
          store.update({ key: "neighbor", value: "Readable title" });
          store.commitMutation(
            { key: "draft", value: "Authored draft", mutationId: "renderer-draft" },
            "renderer-two",
          );
          const last = yield* write(owner, { ...identity, path: "/second.html" }, 2);
          assert.isTrue(last.result.ok);
          assert.strictEqual(store.readSnapshot().revision, 5);
          assert.strictEqual(store.readState().draft, "Authored draft");
          assert.strictEqual(
            store.readState()[codexClientThreadIdentityAtomKey("local", "native")],
            "client-alias",
          );
          assert.deepEqual(yield* owner.read(identity), {
            modelContent: null,
            privateContent: null,
            count: 1,
          });
          assert.strictEqual(store.readState().neighbor, "Readable title");
        }),
      ),
  );

  it.effect(
    "keeps the last 100 updated file identities per host/Thread without making reads touch order",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          for (let count = 0; count < 100; count++)
            yield* write(owner, { ...identity, path: `/file-${count}.html` }, count);
          const first = { ...identity, path: "/file-0.html" };
          const second = { ...identity, path: "/file-1.html" };
          yield* owner.read(second);
          yield* write(owner, first, 200);
          yield* write(owner, { ...identity, path: "/file-100.html" }, 100);
          assert.strictEqual(yield* owner.read(second), null);
          assert.deepEqual(yield* owner.read(first), {
            modelContent: null,
            privateContent: null,
            count: 200,
          });
          assert.strictEqual(
            Object.keys(store.readState()[codexVisualizationStateAtomKey(identity)] as object)
              .length,
            100,
          );
          const other = { ...identity, threadId: "other" };
          yield* write(owner, other, 300);
          assert.deepEqual(yield* owner.read(other), {
            modelContent: null,
            privateContent: null,
            count: 300,
          });
        }),
      ),
  );

  it.effect(
    "ignores malformed recovered entries and never acknowledges a failed or invalid write",
    () =>
      withStore((store, file) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          store.update({
            key: codexVisualizationStateAtomKey(identity),
            value: {
              "/plot.html": { ...identity, threadId: "forged", state: { count: 3 } },
              "/second.html": { ...identity, path: "/third.html", state: {} },
            },
          });
          assert.strictEqual(yield* owner.read(identity), null);
          assert.strictEqual(yield* owner.read({ ...identity, path: "/second.html" }), null);
          const before = store.readSnapshot();
          yield* Effect.promise(() => store.whenDurable());
          const invalid = yield* owner.write(
            { identity, state: { imageIds: ["image"] }, mutationId: "invalid" },
            "renderer",
          );
          assert.deepEqual(invalid, {
            event: null,
            result: { ok: false, code: "images_unsupported", retryable: false },
          });
          rmSync(file);
          // A directory at the atomic destination makes rename fail after writing the temp file.
          mkdirSync(file);
          assert.deepEqual(store.readSnapshot(), before);
          const failed = yield* write(owner, identity, 9);
          assert.deepEqual(failed, {
            event: null,
            result: { ok: false, code: "storage_unavailable", retryable: false },
          });
        }),
      ),
  );

  it.effect("collects current persisted model context without requiring a mounted widget", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* owner.write(
          {
            identity,
            state: { modelContent: { count: 1 }, privateContent: { token: "private" } },
            mutationId: "first",
          },
          "renderer-one",
        );
        interaction(store, identity, 2);
        const first = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
        assert.deepEqual(payloads(first), [
          { path: "/plot.html", state: { count: 1 } },
          { path: "/plot.html", interaction: { selected: 2 } },
        ]);
        assert.strictEqual(
          yield* owner.readPassiveContext({ hostId: "ssh", threadId: "display" }),
          undefined,
        );
        assert.strictEqual(
          yield* owner.readPassiveContext({ hostId: "local", threadId: "other" }),
          undefined,
        );
        const deduped = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" }, [
          { id: "/plot.html", untrusted: true, structuredContent: { selected: 2 } },
        ]);
        assert.deepEqual(payloads(deduped), [{ path: "/plot.html", state: { count: 1 } }]);
        assert.strictEqual(deduped?.key, first?.key);
        yield* owner.write(
          { identity, state: { modelContent: { count: 3 } }, mutationId: "next" },
          "renderer-one",
        );
        const next = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
        assert.notStrictEqual(next?.key, first?.key);
        assert.deepEqual(payloads(next)[0], { path: "/plot.html", state: { count: 3 } });
        assert.deepEqual(payloads(first)[0], { path: "/plot.html", state: { count: 1 } });
      }),
    ),
  );

  it.effect("uses one Profile snapshot when another state producer commits during collection", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* owner.write(
          { identity, state: { modelContent: { count: 1 } }, mutationId: "first" },
          "renderer-one",
        );
        interaction(store, identity, 1);
        const readState = store.readState.bind(store);
        let advance = true;
        store.readState = () => {
          const snapshot = readState();
          if (advance) {
            advance = false;
            interaction(store, identity, 2);
          }
          return snapshot;
        };

        const captured = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
        assert.deepEqual(payloads(captured), [
          { path: "/plot.html", state: { count: 1 } },
          { path: "/plot.html", interaction: { selected: 1 } },
        ]);
        const current = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
        assert.deepEqual(payloads(current)[1], {
          path: "/plot.html",
          interaction: { selected: 2 },
        });
        assert.notStrictEqual(captured?.key, current?.key);
      }),
    ),
  );

  it.effect("treats a failed Profile read as optional context absence", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        interaction(store, identity, 1);
        store.readState = () => {
          throw new Error("Profile unavailable");
        };
        assert.strictEqual(
          yield* owner.readPassiveContext({ hostId: "local", threadId: "display" }),
          undefined,
        );
      }),
    ),
  );

  it.effect(
    "clears both records for only the deleted host/Thread and leaves no atom inventory entries",
    () =>
      withStore((store, file) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          const otherHost = { ...identity, hostId: "ssh" };
          const otherThread = { ...identity, threadId: "other" };
          for (const target of [identity, otherHost, otherThread]) {
            yield* write(owner, target, 1);
            interaction(store, target, 2);
          }
          store.update({ key: "draft", value: "latest draft" });
          const before = store.readSnapshot();
          const scope = { hostId: "local", threadId: "display" };
          const events = yield* owner.clearThread(scope);
          assert.deepEqual(
            events.map(({ key, value, revision }) => ({ key, value, revision })),
            [
              {
                key: codexVisualizationStateAtomKey(scope),
                value: undefined,
                revision: before.revision + 1,
              },
              {
                key: codexVisualizationInteractionAtomKey(scope),
                value: undefined,
                revision: before.revision + 2,
              },
            ],
          );
          assert.strictEqual(events[0]?.mutationId, events[1]?.mutationId);
          assert.isTrue(events.every(({ originRendererId }) => originRendererId === null));
          assert.strictEqual(yield* owner.readPassiveContext(scope), undefined);
          assert.strictEqual(yield* owner.read(identity), null);
          assert.isFalse(Object.hasOwn(store.readState(), codexVisualizationStateAtomKey(scope)));
          assert.isFalse(
            Object.hasOwn(store.readState(), codexVisualizationInteractionAtomKey(scope)),
          );
          yield* Effect.promise(() => store.whenDurable());
          assert.deepEqual(new PersistedAtomStore(file).readState(), store.readState());
          assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), store.readState());
          assert.strictEqual(store.readState().draft, "latest draft");
          for (const target of [otherHost, otherThread]) {
            assert.deepEqual(
              payloads(
                yield* owner.readPassiveContext({
                  hostId: target.hostId,
                  threadId: target.threadId,
                }),
              ),
              [
                { path: "/plot.html", state: null },
                { path: "/plot.html", interaction: { selected: 2 } },
              ],
            );
          }
          assert.deepEqual(yield* owner.clearThread(scope), []);
          assert.strictEqual(store.readSnapshot().revision, before.revision + 2);
        }),
      ),
  );

  it.effect(
    "offers an Agent chat each change of its widget context once, until the Thread is cleared",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const owner = yield* CodexVisualizationState;
          const scope = { hostId: "local", threadId: "display" };
          yield* write(owner, identity, 1);
          const first = yield* owner.readUnsentPassiveContext(scope);
          assert.deepEqual(payloads(first), [{ path: "/plot.html", state: null }]);
          yield* owner.markPassiveContextSent(scope, first!.key);
          assert.strictEqual(yield* owner.readUnsentPassiveContext(scope), undefined);
          interaction(store, identity, 2);
          const changed = yield* owner.readUnsentPassiveContext(scope);
          assert.notStrictEqual(changed?.key, first?.key);
          yield* owner.markPassiveContextSent(scope, changed!.key);
          yield* owner.clearThread(scope);
          yield* write(owner, identity, 1);
          // A cleared Thread forgets what was sent with the state it held.
          assert.strictEqual((yield* owner.readUnsentPassiveContext(scope))?.key, first?.key);
        }),
      ),
  );
});

describe("CodexVisualizations", () => {
  const live = liveCodexVisualizations;
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
    readonly agentSources?: () => {
      readonly nativeThreadId: string;
      readonly cwd: string | null;
    } | null;
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
          options.disconnected
            ? { kind: "stopped", hostId }
            : { kind: "ready", hostId, generation },
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
      ...(options.agentSources
        ? [
            Layer.succeed(AgentRuntimeApplication, {
              visualizationSource: () => Effect.sync(() => options.agentSources!()),
            } as unknown as AgentRuntimeApplication["Service"]),
          ]
        : []),
    );
    return { hostId, paths, contextRequests, layer: live.pipe(Layer.provide(dependencies)) };
  }

  it.effect(
    "uses the UUID-derived source namespace and preserves configured home precedence",
    () => {
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
    },
  );

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

  it.effect(
    "reads an Agent chat's files from its Codex thread folder and its own workspace",
    () => {
      let reads = 0;
      const test = fixture({
        agentSources: () => {
          reads += 1;
          return { nativeThreadId: threadId, cwd: "/agent/workspace" };
        },
      });
      const agentThreadId = "nodex:thread:0123abcd";
      return Effect.gen(function* () {
        const service = yield* CodexVisualizations;
        assert.deepEqual(
          yield* service.read({
            hostId: "local",
            sourceThreadId: agentThreadId,
            file: "plot.html",
          }),
          { contents: "<html>chart</html>", path: primary },
        );
        assert.strictEqual(
          (yield* service.read({
            hostId: "local",
            sourceThreadId: agentThreadId,
            file: "/agent/workspace/plot.html",
          })).path,
          "/agent/workspace/plot.html",
        );
        for (const input of [
          { hostId: "local", file: "/workspace/source/plot.html" },
          { hostId: "ssh:test", file: "plot.html" },
        ])
          assert.isTrue(
            (yield* Effect.result(service.read({ ...input, sourceThreadId: agentThreadId })))
              ._tag === "Failure",
          );
        // The source is proven again after the read, as a native conversation's is.
        assert.isAbove(reads, 2);
        assert.deepEqual(test.contextRequests, []);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("refuses an Agent chat's file when its Codex thread changes during the read", () => {
    let reads = 0;
    const test = fixture({
      agentSources: () => {
        reads += 1;
        return reads === 1 ? { nativeThreadId: threadId, cwd: "/agent/workspace" } : null;
      },
    });
    return Effect.gen(function* () {
      const service = yield* CodexVisualizations;
      const result = yield* Effect.result(
        service.read({
          hostId: "local",
          sourceThreadId: "nodex:thread:0123abcd",
          file: "plot.html",
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(test.paths, [primary]);
    }).pipe(Effect.provide(test.layer));
  });
});

describe("CodexAttachments", () => {
  const live = liveCodexAttachments;
  const emptyRegistry = Buffer.from(
    JSON.stringify({
      attachmentPaths: [],
      pendingRemovalPaths: [],
      textExcerptsByPath: {},
    }),
    "utf8",
  ).toString("base64");

  it.effect(
    "routes owned attachments through their selected host and preserves resource bytes on retries",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          readonly hostId: string;
          readonly method: string;
          readonly path: string;
        }> = [];
        const files = new Map<string, string>();
        const remoteCodexHome = "/remote/home/.codex";
        const remoteHostId = "ssh:test";

        const requestOnHost = (hostId: string, method: string, params: unknown) =>
          Effect.sync(() => {
            const input = params as {
              readonly path: string;
              readonly dataBase64?: string;
              readonly recursive?: boolean;
              readonly sourcePath?: string;
              readonly destinationPath?: string;
            };
            requests.push({ hostId, method, path: input.path ?? input.destinationPath ?? "" });
            if (method === "fs/copy") {
              const source = files.get(input.sourcePath!);
              if (!source) throw new Error("Source is missing");
              files.set(input.destinationPath!, source);
              return {};
            }
            if (method === "fs/createDirectory") return {};
            if (method === "fs/writeFile") {
              files.set(input.path, input.dataBase64 ?? "");
              return {};
            }
            if (method === "fs/readFile") {
              const dataBase64 =
                files.get(input.path) ??
                (input.path.endsWith("/pasted-text-attachments.json") ? emptyRegistry : undefined);
              if (dataBase64 === undefined) throw new Error(`ENOENT: ${input.path}`);
              return { dataBase64 };
            }
            if (method === "fs/remove") {
              if (input.recursive) {
                for (const filePath of files.keys()) {
                  if (filePath === input.path || filePath.startsWith(`${input.path}/`)) {
                    files.delete(filePath);
                  }
                }
              } else {
                files.delete(input.path);
              }
              return {};
            }
            throw new Error(`Unexpected request ${method}`);
          });

        const gateway = CodexGateway.of({
          localHostId: "local",
          events: Stream.empty,
          requestOnHost,
        } as unknown as CodexGateway["Service"]);
        let uploads = 0;
        const executionHosts = ExecutionHostRuntime.of({
          resolve: (hostId: string) =>
            Effect.succeed({
              descriptor: {
                hostId,
                displayName: hostId,
                kind: hostId === "local" ? "local" : "ssh",
                nodexHome: hostId === "local" ? "/local/.nodex" : "/remote/home/.nodex",
                codexHome: hostId === "local" ? "/local/.codex" : remoteCodexHome,
                managedRoot: "/worktrees",
                handoffStagingRoot: "/handoffs",
                repositoryRoots: [],
                capabilities: [],
                supportsFileTransfer: true,
              },
              transfer: {
                describe: (sourcePath: string) =>
                  Effect.gen(function* () {
                    const value = files.get(sourcePath);
                    if (value === undefined)
                      return yield* new ExecutionHostRuntimeError({
                        operation: "describe",
                        cause: new Error(`ENOENT: ${sourcePath}`),
                      });
                    const bytes = Buffer.from(value, "base64");
                    return {
                      path: sourcePath,
                      size: bytes.byteLength,
                      sha256: createHash("sha256").update(bytes).digest("hex"),
                    };
                  }),
                upload: (input: {
                  localPath: string;
                  operationId: string;
                  fileName: string;
                  sha256: string;
                  size: number;
                }) =>
                  Effect.promise(async () => {
                    const bytes = await readFile(input.localPath);
                    assert.equal(bytes.byteLength, input.size);
                    assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256);
                    const target = `/staging/${input.operationId}/${input.fileName}`;
                    files.set(target, bytes.toString("base64"));
                    uploads += 1;
                    return { path: target, size: input.size, sha256: input.sha256 };
                  }),
                cleanup: (operationId: string) =>
                  Effect.sync(() => {
                    for (const target of files.keys())
                      if (target.startsWith(`/staging/${operationId}/`)) files.delete(target);
                  }),
              },
              request: () => Effect.die("unused"),
            }),
        } as unknown as ExecutionHostRuntime["Service"]);
        const dependencies = Layer.mergeAll(
          Layer.succeed(CodexGateway, gateway),
          Layer.succeed(ExecutionHostRuntime, executionHosts),
          scopedCallbackRuntimeLayer,
        );
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(live.pipe(Layer.provide(dependencies)), scope);
        const attachments = Context.get(context, CodexAttachments);

        const pasted = yield* attachments.createPastedText({
          text: "source text",
          hostId: remoteHostId,
        });
        assert.strictEqual(pasted.hostId, remoteHostId);
        assert.strictEqual(pasted.file.hostId, remoteHostId);
        assert.isTrue(pasted.file.fsPath.startsWith(`${remoteCodexHome}/attachments/`));
        assert.strictEqual(yield* attachments.readPastedText(pasted.file), "source text");

        const goal = yield* attachments.materializeGoal(remoteHostId, {
          objective: "Ship the change",
          pastedTextAttachments: [pasted],
          imageAttachments: [],
        });
        assert.isTrue(goal.objective.includes(`${remoteCodexHome}/attachments/`));
        assert.isTrue(
          goal.attachmentDirectory?.startsWith(`${remoteCodexHome}/attachments/`) ?? false,
        );

        const longGoal = yield* attachments.materializeGoal(remoteHostId, {
          objective: "x".repeat(4001),
          pastedTextAttachments: [],
          imageAttachments: [],
        });
        assert.strictEqual(
          yield* attachments.readEditableObjective(remoteHostId, longGoal.objective),
          "x".repeat(4001),
        );

        yield* attachments.cleanupMaterializedGoal(remoteHostId, goal.attachmentDirectory);
        yield* attachments.cleanupMaterializedGoal(remoteHostId, longGoal.attachmentDirectory);
        yield* attachments.removePastedText(pasted.file);

        // A normal file exceeds the JSON RPC frame: bytes must use the host's streaming transfer.
        const local = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), "nodex-resource-test-")),
        );
        try {
          const localPath = path.join(local, "report.txt");
          const bytes = Buffer.alloc(17 * 1024 * 1024, 65);
          yield* Effect.promise(() => writeFile(localPath, bytes));
          const resources = [
            {
              name: "report.txt",
              mimeType: "text/plain",
              sizeBytes: bytes.byteLength,
              source: localPath,
            },
            {
              name: "picture.png",
              mimeType: "image/png",
              sizeBytes: 3,
              source: "data:image/png;base64,YWJj",
            },
          ];
          const prepared = yield* attachments.materializeResources(remoteHostId, resources);
          const file = prepared.fileAttachments![0]!;
          assert.equal(file.hostId, remoteHostId);
          assert.isTrue(file.fsPath.startsWith(`${remoteCodexHome}/attachments/resources/`));
          assert.notEqual(file.fsPath, localPath);
          assert.equal(files.get(file.fsPath), bytes.toString("base64"));
          assert.equal(files.get(prepared.images![0]!.source), "YWJj");
          assert.deepEqual(
            yield* attachments.materializeResources(remoteHostId, resources),
            prepared,
          );
          assert.equal(
            uploads,
            2,
            "Same resources reuse their immutable destination without uploading again",
          );
          assert.equal(
            [...files.keys()].filter((entry) => entry.startsWith("/staging/")).length,
            0,
          );

          yield* Effect.promise(() => writeFile(localPath, Buffer.alloc(bytes.length, 66)));
          const changed = yield* attachments.materializeResources(remoteHostId, [resources[0]!]);
          assert.notEqual(changed.fileAttachments![0]!.fsPath, file.fsPath);
          assert.equal(
            files.get(file.fsPath),
            bytes.toString("base64"),
            "New content cannot overwrite queued bytes",
          );
          files.set(file.fsPath, Buffer.from("external change").toString("base64"));
          yield* Effect.promise(() => writeFile(localPath, bytes));
          assert.isTrue(
            (yield* attachments
              .materializeResources(remoteHostId, [resources[0]!])
              .pipe(Effect.result))._tag === "Failure",
          );
          assert.equal(files.get(file.fsPath), Buffer.from("external change").toString("base64"));
        } finally {
          yield* Effect.promise(() => rm(local, { recursive: true, force: true }));
        }

        assert.isTrue(requests.length > 0);
        assert.isTrue(requests.every((request) => request.hostId === remoteHostId));
        assert.isTrue(requests.some((request) => request.method === "fs/createDirectory"));
        assert.isTrue(requests.some((request) => request.method === "fs/writeFile"));
        assert.isTrue(requests.some((request) => request.method === "fs/readFile"));
        assert.isTrue(requests.some((request) => request.method === "fs/remove"));

        yield* Scope.close(scope, Exit.void);
      }),
  );
});

describe("CodexInputAssets", () => {
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

  it.effect(
    "retains captured queue attachments directly under their thread without a payload manifest",
    () =>
      Effect.gen(function* () {
        const localFile = path.join(fixtureRoot, "notes.txt");
        fs.writeFileSync(localFile, "captured notes");
        const { store, blobs, retained } = fixture();
        const captured = yield* store.retainCaptured(
          "thread-1",
          "message-1",
          {
            text: "Inspect",
            images: [{ source: "data:image/png;base64,cXVldWUtaW1hZ2U=" }],
            fileAttachments: [{ label: "notes", path: localFile, fsPath: localFile }],
          },
          true,
        );
        assert.strictEqual(captured.text, "Inspect");
        assert.strictEqual(retained[0]?.intent.kind, "retain_thread_assets");
        assert.strictEqual(blobs.size, 2);
        assert.deepEqual([...blobs.values()].map((bytes) => bytes.toString("utf8")).sort(), [
          "captured notes",
          "queue-image",
        ]);
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

  it.effect("captures inline queue images without reading remote absolute paths or file URLs", () =>
    Effect.gen(function* () {
      const { store, retained, blobs } = fixture();
      const collidingPath = path.join(fixtureRoot, "remote-image.png");
      fs.writeFileSync(collidingPath, "private local bytes");
      const input: CodexPromptInput = {
        text: "Inspect",
        images: [
          { source: collidingPath, caption: "Remote image" },
          { source: pathToFileURL(collidingPath).href },
          { source: path.join(fixtureRoot, "remote-only.png") },
          { source: "data:image/png;base64,cXVldWUtaW1hZ2U=" },
        ],
        fileAttachments: [{ label: "remote image", path: collidingPath, fsPath: collidingPath }],
      };
      const captured = yield* store.retainCaptured("thread-1", "remote-queue", input, false);
      assert.deepStrictEqual(captured.images?.slice(0, 3), [
        { source: collidingPath, caption: "Remote image" },
        { source: collidingPath },
        { source: path.join(fixtureRoot, "remote-only.png") },
      ]);
      assert.deepStrictEqual(captured.fileAttachments, input.fileAttachments);
      assert.match(captured.images![3]!.source, /^nodex:\/\/assets\//u);
      assert.strictEqual(retained.length, 1);
      assert.deepStrictEqual(
        [...blobs.values()].map((bytes) => bytes.toString("utf8")),
        ["queue-image"],
      );
    }),
  );

  it.effect("retains hosted image identity without creating a local Blob", () =>
    Effect.gen(function* () {
      const { store, retained, blobs } = fixture();
      const prepared = emptyPrepared();
      prepared.inputItems = [{ type: "image", fileId: "file-123", detail: "original" }];
      const captured = yield* store.retainPrepared("thread-1", "hosted-input", prepared, true);
      assert.deepStrictEqual(captured, prepared);
      const prompt = yield* store.retainCaptured(
        "thread-1",
        "hosted-queue",
        {
          text: "Inspect",
          images: [{ source: "file-service://file-123" }],
        },
        true,
      );
      assert.deepStrictEqual(prompt.images, [{ source: "file-service://file-123" }]);
      assert.strictEqual(retained.length, 0);
      assert.strictEqual(blobs.size, 0);
    }),
  );
});
