import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CODEX_MODEL_CATALOG_PAGE_SIZE,
  ComposerCatalog,
  live as composerCatalogLive,
} from "./ComposerCatalog";

const makeGateway = (
  requestLocal: CodexGateway["Service"]["requestLocal"],
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal,
    requestOnHost: (_hostId, method, params) => requestLocal(method, params),
    requestForThread: (_threadId, method, params) => requestLocal(method, params),
    notifyLocal: unsupported,
    connection: () => unsupported(),
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

it.effect("projects models, plugins, and skills through one composer interface", () =>
  Effect.gen(function* () {
    const experimentalRequests: unknown[] = [];
    const hookWrites: unknown[] = [];
    const modelRequests: unknown[] = [];
    const skillsRequests: unknown[] = [];
    const requestLocal = ((method: string, params: unknown) => {
      if (method === "model/list") {
        modelRequests.push(params);
        const cursor = (params as { readonly cursor?: string | null }).cursor ?? null;
        return Effect.succeed({
          data: [
            {
              id: cursor === null ? "model-a" : "model-b",
              model: cursor === null ? "model-a" : "model-b",
              displayName: cursor === null ? "Model A" : "Model B",
              description: "Agent model",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              defaultReasoningEffort: "medium",
              inputModalities: cursor === null ? ["text", "image"] : ["text", "audio"],
              multiAgentVersion: cursor === null ? "v2" : "disabled",
              serviceTiers:
                cursor === null
                  ? [{ id: "fast", name: "Fast", description: "Low-latency execution" }]
                  : [],
              defaultServiceTier: cursor === null ? "fast" : null,
              isDefault: cursor === null,
            },
          ],
          nextCursor: cursor === null ? "models:next" : null,
        });
      }
      if (method === "plugin/installed") {
        return Effect.succeed({
          marketplaces: [
            {
              name: "openai-bundled",
              path: null,
              interface: null,
              plugins: [
                {
                  id: "browser@openai-bundled",
                  name: "browser",
                  installed: true,
                  enabled: true,
                  availability: "AVAILABLE",
                  disabledReason: null,
                  installPolicy: null,
                  installPolicySource: null,
                  authPolicy: "ON_USE",
                  interface: {
                    displayName: "Browser",
                    shortDescription: "Control a browser",
                    defaultPrompt: [],
                    composerIcon: null,
                    composerIconUrl: null,
                    logo: null,
                    logoUrl: null,
                    logoDark: null,
                    logoUrlDark: null,
                    brandColor: null,
                  },
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
        });
      }
      if (method === "skills/list") {
        skillsRequests.push(params);
        return Effect.succeed({
          data: [
            {
              cwd: "/repo",
              errors: [],
              skills: [
                {
                  name: "PDF",
                  description: "Read PDFs",
                  shortDescription: "PDF tools",
                  path: "/skills/pdf/SKILL.md",
                  scope: "system",
                  enabled: true,
                },
              ],
            },
          ],
        });
      }
      if (method === "experimentalFeature/list") {
        experimentalRequests.push(params);
        const cursor = (params as { readonly cursor?: string | null }).cursor ?? null;
        return Effect.succeed({
          data: [
            {
              name: cursor === null ? "apps" : "memories",
              stage: "stable",
              displayName: null,
              description: null,
              announcement: null,
              enabled: true,
              defaultEnabled: true,
            },
          ],
          nextCursor: cursor === null ? "next-page" : null,
        });
      }
      if (method === "collaborationMode/list") {
        return Effect.succeed({
          data: [
            {
              name: "Default",
              mode: "default",
              model: "model-a",
              reasoning_effort: "medium",
            },
            { name: "Plan", mode: "plan", model: "model-a", reasoningEffort: null },
            { name: "Ignored", mode: "research", model: "model-a" },
          ],
        });
      }
      if (method === "hooks/list") return Effect.succeed({ data: [] });
      if (method === "config/batchWrite") {
        hookWrites.push(params);
        return Effect.succeed({});
      }
      throw new Error(`Unexpected request: ${method}`);
    }) as CodexGateway["Service"]["requestLocal"];
    const gateway = makeGateway(requestLocal);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      composerCatalogLive.pipe(Layer.provide(Layer.succeed(CodexGateway, gateway))),
      scope,
    );
    const catalog = Context.get(context, ComposerCatalog);

    const models = yield* catalog.listModels;
    assert.deepEqual(
      models.map((model) => model.id),
      ["model-a", "model-b"],
    );
    assert.strictEqual(models[0]?.defaultReasoningEffort, "medium");
    assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
    assert.strictEqual(models[0]?.multiAgentVersion, "v2");
    assert.deepEqual(models[0]?.serviceTiers, [
      { id: "fast", name: "Fast", description: "Low-latency execution" },
    ]);
    assert.strictEqual(models[0]?.defaultServiceTier, "fast");
    assert.deepEqual(models[1]?.inputModalities, ["text", "audio"]);
    assert.strictEqual(models[1]?.multiAgentVersion, "disabled");
    assert.deepEqual(models[1]?.serviceTiers, []);
    assert.strictEqual(models[1]?.defaultServiceTier, null);
    assert.deepEqual(modelRequests, [
      { cursor: null, limit: CODEX_MODEL_CATALOG_PAGE_SIZE },
      { cursor: "models:next", limit: CODEX_MODEL_CATALOG_PAGE_SIZE },
    ]);
    const features = yield* catalog.listExperimentalFeatures;
    assert.deepEqual(
      features.map((feature) => feature.name),
      ["apps", "memories"],
    );
    assert.strictEqual(experimentalRequests.length, 2);
    assert.strictEqual((experimentalRequests[0] as { readonly limit?: number }).limit, 100);
    assert.isFalse(Object.hasOwn(experimentalRequests[0] as object, "threadId"));
    assert.deepEqual(yield* catalog.listCollaborationModes, [
      {
        name: "Default",
        mode: "default",
        model: "model-a",
        reasoningEffort: "medium",
      },
      { name: "Plan", mode: "plan", model: "model-a", reasoningEffort: null },
    ]);
    const plugins = yield* catalog.listPlugins([" /repo ", "/repo"]);
    assert.strictEqual(plugins[0]?.id, "browser@openai-bundled");
    const skills = yield* catalog.listSkills(["/repo"]);
    assert.strictEqual(skills[0]?.path, "/skills/pdf/SKILL.md");
    yield* catalog.listSkills([]);
    assert.deepEqual(skillsRequests.slice(0, 2), [{ cwds: ["/repo"] }, {}]);
    assert.isFalse(Object.hasOwn(skillsRequests[1] as object, "cwds"));
    yield* catalog.activatePlugin({ id: "browser@openai-bundled", cwds: ["/repo"] });
    assert.deepEqual(yield* catalog.listHooks({ hostId: "default", cwds: ["/repo"] }), {
      data: [],
    });
    yield* catalog.updateHooksState({
      hostId: "default",
      patches: [{ key: "lint", enabled: true, trustedHash: "sha256:lint" }],
    });
    assert.deepEqual(hookWrites, [
      {
        edits: [
          {
            keyPath: "hooks.state",
            value: { lint: { enabled: true, trusted_hash: "sha256:lint" } },
            mergeStrategy: "upsert",
          },
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
    ]);
    const invalidHooks = yield* catalog
      .updateHooksState({
        hostId: "default",
        patches: [
          { key: "lint", enabled: true },
          { key: "lint", enabled: false },
        ],
      })
      .pipe(Effect.result);
    assert.strictEqual(invalidHooks._tag, "Failure");

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "fails instead of looping or returning a partial catalog when a model cursor repeats",
  () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const requestLocal = ((method: string, params: unknown) => {
        if (method !== "model/list") return Effect.die(new Error(`Unexpected request: ${method}`));
        requests.push(params);
        return Effect.succeed({
          data: [
            {
              id: `model-${requests.length}`,
              model: `model-${requests.length}`,
              displayName: `Model ${requests.length}`,
              description: "Agent model",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
              multiAgentVersion: "disabled",
              serviceTiers: [],
              defaultServiceTier: null,
              isDefault: requests.length === 1,
            },
          ],
          nextCursor: "models:repeated",
        });
      }) as CodexGateway["Service"]["requestLocal"];
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        composerCatalogLive.pipe(
          Layer.provide(Layer.succeed(CodexGateway, makeGateway(requestLocal))),
        ),
        scope,
      );
      const result = yield* Context.get(context, ComposerCatalog).listModels.pipe(Effect.result);

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(requests.length, 2);
      yield* Scope.close(scope, Exit.void);
    }),
);
