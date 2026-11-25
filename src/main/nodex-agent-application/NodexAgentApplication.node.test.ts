import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { live as coreModulesLive } from "../core-runtime/CoreModules";
import { live as databaseModuleLive } from "../database-application/DatabaseModule";
import { live, NodexAgentApplication } from "./NodexAgentApplication";
import {
  CreatePagesV3InputSchema,
  CreatePagesV6OutputSchema,
  NODEX_APP_TOOLSET_REVISION,
  type NodexAgentCreatePagesCommand,
} from "../../shared/nodex-agent-tools";
import { SetPagePropertiesV6InputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { executeNodexAgentV3Tool } from "./NodexAgentDynamicExecution";
import {
  buildNodexAgentDynamicToolSpecs,
  layer,
  selectNodexAgentDynamicToolSpecs,
  NodexAgentDynamicTools,
  type NodexAgentDynamicToolCallContext,
} from "./NodexAgentDynamicTools";

describe("NodexAgentApplication", () => {
  const identity = {
    profileId: "profile:agent",
    libraryId: "library:agent",
    storeEpoch: "epoch:agent",
  } as const;
  const projectId = "project:agent";

  const enqueueAgentContext = (client: FakeCoreClient): void => {
    const commitHead = 9;
    client.enqueueWorkspaceRead({
      contract_version: 1,
      store_epoch: identity.storeEpoch,
      commit_head: commitHead,

      value: {
        kind: "project",
        project: {
          id: projectId,
          library_id: identity.libraryId,
          database_id: "database:agent",
          lifecycle: "active",
          binding_revision: 3,
          name: "Agent Project",
          description: "",
          appearance: { color: "blue", marker: { kind: "emoji", emoji: "📘" } },
          sources: [],
          primary_workspace_root: null,
          pinned: false,
          pinned_order: null,
          created_at: "2026-08-23T00:00:00.000Z",
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      },
    });
    client.enqueueDatabaseRead({
      contract_version: 4,
      store_epoch: identity.storeEpoch,
      commit_head: commitHead,

      value: {
        kind: "database",
        value: {
          database: {
            database_id: "database:agent",
            library_id: identity.libraryId,
            name: "Tasks",
            lifecycle: "active",
            default_view_id: null,
            metadata_revision: 1,
            created_at: "2026-08-23T00:00:00.000Z",
            updated_at: "2026-08-23T00:00:00.000Z",
          },
        },
      },
    });
    client.enqueueDatabaseRead({
      contract_version: 4,
      store_epoch: identity.storeEpoch,
      commit_head: commitHead,

      value: {
        kind: "data_source_window",
        data_sources: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: commitHead },
        },
      },
    });
    client.enqueueDatabaseRead({
      contract_version: 4,
      store_epoch: identity.storeEpoch,
      commit_head: commitHead,

      value: {
        kind: "view_descriptor_window",
        views: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: commitHead },
        },
      },
    });
  };

  const applicationLayerFor = (
    client: CoreGenerationClient,
    handshake: CoreGenerationClient["handshake"],
    projectScopes: Array<string | null | undefined> = [],
    sessionAccess?: CoreSessionAccess["Service"],
  ) => {
    const access =
      sessionAccess ??
      CoreSessionAccess.of({
        use: (_operation, run, options) =>
          Effect.promise((signal) => {
            projectScopes.push(options?.projectId);
            return run(client, signal);
          }),
        handshake: Effect.succeed(handshake),
      });
    const authority = CoreAuthority.of({ identity } as CoreAuthority["Service"]);
    const authorityLayer = Layer.succeed(CoreAuthority, authority);
    const accessLayer = Layer.succeed(CoreSessionAccess, access);
    const coreDependencies = Layer.merge(authorityLayer, accessLayer);
    return live.pipe(
      Layer.provide(
        Layer.mergeAll(
          coreDependencies,
          coreModulesLive.pipe(Layer.provide(accessLayer)),
          databaseModuleLive.pipe(Layer.provide(coreDependencies)),
        ),
      ),
    );
  };

  it.effect("projects Agent context from the canonical Project and Database authorities", () => {
    const client = new FakeCoreClient();
    enqueueAgentContext(client);
    const handshake = createFakeCoreHandshake(identity);
    const generationClient = Object.assign(client, {
      handshake,
      forProject: () => generationClient,
      health: () =>
        Promise.resolve({
          pid: 1,
          start_nonce: handshake.generation.start_nonce,
          status: "ready" as const,
        }),
      shutdown: () => Promise.resolve({ status: "draining" as const }),
    }) as unknown as CoreGenerationClient;
    const projectScopes: Array<string | null | undefined> = [];
    const applicationLayer = applicationLayerFor(generationClient, handshake, projectScopes);

    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(applicationLayer);
        const application = Context.get(context, NodexAgentApplication);
        const envelope = yield* application.read({
          tool: "get_context",
          callId: "call:agent",
          projectId,

          input: { include: { databases: true, markdownGuide: true } },
        });

        assert.strictEqual(envelope.metrics.mutationId, "call:agent");
        assert.isTrue(envelope.result.ok);
        if (!envelope.result.ok || envelope.result.tool !== "get_context") return;
        assert.strictEqual(envelope.result.output.data.libraryId, identity.libraryId);
        assert.deepEqual(
          envelope.result.output.data.project && {
            ...envelope.result.output.data.project,
            projectId: String(envelope.result.output.data.project.projectId),
            boundDatabaseId: String(envelope.result.output.data.project.boundDatabaseId),
          },
          {
            projectId,
            name: "Agent Project",
            lifecycle: "active",
            libraryId: identity.libraryId,
            boundDatabaseId: "database:agent",
          },
        );
        assert.deepEqual(
          envelope.result.output.data.databases?.map((database) => ({
            ...database,
            databaseId: String(database.databaseId),
          })),
          [
            {
              databaseId: "database:agent",
              name: "Tasks",
              isBound: true,
              dataSources: [],
              views: [],
            },
          ],
        );
        assert.strictEqual(envelope.result.output.data.markdownGuide?.format, "markdown");
        assert.deepEqual(projectScopes, [projectId, projectId]);
        assert.deepEqual(client.workspaceReads, [{ kind: "project", project_id: projectId }]);
        assert.deepEqual(
          client.databaseReads.map(({ kind }) => kind),
          ["database", "data_source_window", "view_descriptor_window"],
        );

        const unmatched = yield* application.apply({
          kind: "document_mutation",
          request: {
            mutationId: "mutation:missing",
            projectId,
            storeEpoch: identity.storeEpoch,
            clientSessionId: "nodex-agent:thread:agent",
            threadId: "thread:agent",
            callId: "call:missing",
            documentId: "document:agent",
            generation: 1,
            expectedHeadSeq: 1,
          },
        });
        assert.strictEqual(unmatched.kind, "document_mutation");
        assert.isFalse(unmatched.value.ok);
        if (!unmatched.value.ok) {
          assert.strictEqual(unmatched.value.error.code, "mutation_id_collision");
        }
      }),
    );
  });

  it.effect("carries interruption to the in-flight Core request", () => {
    const client = new FakeCoreClient();
    const handshake = createFakeCoreHandshake(identity);
    let observedSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const generationClient = Object.assign(client, {
      handshake,
      forProject: () => generationClient,
      health: () =>
        Promise.resolve({
          pid: 1,
          start_nonce: handshake.generation.start_nonce,
          status: "ready" as const,
        }),
      shutdown: () => Promise.resolve({ status: "draining" as const }),
      libraryRead: (_read: unknown, options?: { readonly signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        notifyStarted?.();
        return new Promise<never>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        });
      },
    }) as unknown as CoreGenerationClient;
    const applicationLayer = applicationLayerFor(generationClient, handshake);

    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(applicationLayer);
        const application = Context.get(context, NodexAgentApplication);
        const fiber = yield* application
          .read({
            tool: "search",
            callId: "call:interrupt",
            projectId,
            authority: {
              threadId: "thread:agent",
              turnId: "turn:agent",
              rootThreadId: "thread:agent",
              actorProjectId: projectId,
              libraryId: identity.libraryId,
              storeEpoch: identity.storeEpoch,
              admittedAtMs: 1_785_491_085_000,
            },
            input: { query: "interruption" },
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => started);
        yield* Fiber.interrupt(fiber);

        assert.isDefined(observedSignal);
        assert.isTrue(observedSignal?.aborted);
      }),
    );
  });

  it.effect("serializes one mutation identity without blocking independent mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = new FakeCoreClient();
        const handshake = createFakeCoreHandshake(identity);
        const generationClient = Object.assign(client, {
          handshake,
          forProject: () => generationClient,
          health: () =>
            Promise.resolve({
              pid: 1,
              start_nonce: handshake.generation.start_nonce,
              status: "ready" as const,
            }),
          shutdown: () => Promise.resolve({ status: "draining" as const }),
        }) as unknown as CoreGenerationClient;
        let entered = 0;
        let active = 0;
        let maximumActive = 0;
        let expectedEntries = 1;
        let allEntered = yield* Deferred.make<void>();
        let release = yield* Deferred.make<void>();
        const sessionAccess = CoreSessionAccess.of({
          handshake: Effect.succeed(handshake),
          use: (_operation, run) =>
            Effect.gen(function* () {
              entered += 1;
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              if (entered === expectedEntries) yield* Deferred.succeed(allEntered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.promise((signal) => run(generationClient, signal));
            }).pipe(Effect.ensuring(Effect.sync(() => (active -= 1)))),
        });
        const context = yield* Layer.build(
          applicationLayerFor(generationClient, handshake, [], sessionAccess),
        );
        const application = Context.get(context, NodexAgentApplication);
        const command = (mutationId: string) =>
          application.apply({
            kind: "document_mutation",
            request: {
              mutationId,
              projectId,
              storeEpoch: identity.storeEpoch,
              clientSessionId: "nodex-agent:thread:lane",
              threadId: "thread:lane",
              callId: "call:lane",
              documentId: "document:lane",
              generation: 1,
              expectedHeadSeq: 1,
            },
          });

        const sameFirst = yield* command("mutation:same").pipe(Effect.forkChild);
        yield* Deferred.await(allEntered);
        const sameSecond = yield* command("mutation:same").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(entered, 1);
        assert.strictEqual(maximumActive, 1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(sameFirst);
        yield* Fiber.join(sameSecond);
        assert.strictEqual(maximumActive, 1);

        entered = 0;
        active = 0;
        maximumActive = 0;
        expectedEntries = 2;
        allEntered = yield* Deferred.make<void>();
        release = yield* Deferred.make<void>();
        const independentFirst = yield* command("mutation:first").pipe(Effect.forkChild);
        const independentSecond = yield* command("mutation:second").pipe(Effect.forkChild);
        yield* Deferred.await(allEntered);
        assert.strictEqual(maximumActive, 2);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(independentFirst);
        yield* Fiber.join(independentSecond);
      }),
    ),
  );

  it.effect(
    "describes the current Library without reading a default Project or content bodies",
    () => {
      const handshake = createFakeCoreHandshake(identity);
      const client = new FakeCoreClient() as unknown as CoreGenerationClient;
      const sessionAccess = CoreSessionAccess.of({
        use: () => Effect.die("Projectless context must not read Core content"),
        handshake: Effect.succeed(handshake),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            applicationLayerFor(client, handshake, [], sessionAccess),
          );
          const application = Context.get(context, NodexAgentApplication);
          const envelope = yield* application.read({
            tool: "get_context",
            projectId: null,
            input: { include: { databases: true } },
          });
          assert.deepEqual(envelope.result, {
            ok: true,
            tool: "get_context",
            output: { data: { libraryId: identity.libraryId, project: null } },
          });
        }),
      );
    },
  );

  it.effect("rejects operations after its application scope closes", () => {
    const client = new FakeCoreClient();
    const handshake = createFakeCoreHandshake(identity);
    const generationClient = Object.assign(client, {
      handshake,
      forProject: () => generationClient,
      health: () =>
        Promise.resolve({
          pid: 1,
          start_nonce: handshake.generation.start_nonce,
          status: "ready" as const,
        }),
      shutdown: () => Promise.resolve({ status: "draining" as const }),
    }) as unknown as CoreGenerationClient;

    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        applicationLayerFor(generationClient, handshake),
        scope,
      );
      const application = Context.get(context, NodexAgentApplication);
      yield* Scope.close(scope, Exit.void);

      const error = yield* application
        .read({
          tool: "get_context",
          projectId: null,

          input: {},
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NodexAgentApplicationError");
      if (error._tag === "NodexAgentApplicationError") {
        assert.strictEqual(error.operation, "nodexAgent.closed");
      }
    });
  });
});

describe("NodexAgentDynamicTools", () => {
  it.effect("prepares a Page once and commits through the canonical application", () =>
    Effect.gen(function* () {
      const input = CreatePagesV3InputSchema.parse({
        destination: { kind: "library" },
        pages: [{ title: "Launch", markdown: "## Milestones" }],
      });
      const output = CreatePagesV6OutputSchema.parse({
        data: {
          pages: [
            {
              pageId: "created",
              pageKey: null,
              location: { kind: "library", libraryId: "library" },
              bodyBlocksCreated: 1,
            },
          ],
          created: 1,
        },
      });
      const trace: string[] = [];
      const command = {
        threadId: "thread",
        callId: "call",
        projectId: "project",
        requestHash: "hash",
        mutationId: "mutation",
        storeEpoch: "epoch",
        input,
        destination: { kind: "library" },
        pages: [],
      } as unknown as NodexAgentCreatePagesCommand;
      const unexpected = () => Effect.die("Unexpected operation");
      const app = NodexAgentApplication.of({
        read: unexpected,
        readPageObservation: unexpected,
        completePageUpdate: unexpected,
        prepare: () =>
          Effect.sync(() => {
            trace.push("prepare");
            return {
              kind: "create_pages",
              value: {
                result: {
                  ok: true,
                  value: { kind: "prepared", command, documentHeads: [], previews: [] },
                },
              },
            } as never;
          }),
        apply: () =>
          Effect.sync(() => {
            trace.push("apply");
            return { kind: "create_pages", value: { ok: true, value: { output } } } as never;
          }),
      });
      const result = yield* executeNodexAgentV3Tool("create_pages", input, {
        threadId: "thread",
        callId: "call",
        operationId: "operation",
        authority: {
          threadId: "thread",
          turnId: "turn",
          rootThreadId: "thread",
          actorProjectId: "project",
          libraryId: "library",
          storeEpoch: "epoch",
          admittedAtMs: 1,
        },
      }).pipe(Effect.provideService(NodexAgentApplication, app));
      assert.deepEqual(result, output);
      assert.deepEqual(trace, ["prepare", "apply"]);
    }),
  );

  it.effect(
    "publishes and enforces the current Nodex tool catalog at the protocol boundary",
    () => {
      const application = NodexAgentApplication.of({
        readPageObservation: () => Effect.die("unexpected Page observation"),
        read: () => Effect.die("catalog validation must not enter the application"),
        completePageUpdate: () => Effect.die("catalog validation must not enter the application"),
        prepare: () => Effect.die("catalog validation must not enter the application"),
        apply: () => Effect.die("catalog validation must not enter the application"),
      });
      const policy: NodexAgentDynamicToolCallContext = {
        toolsetRevision: NODEX_APP_TOOLSET_REVISION,
        authority: null,
      };
      const parseFailure = (response: {
        readonly contentItems: readonly { readonly type: string; readonly text?: string }[];
      }) => {
        const item = response.contentItems[0];
        return JSON.parse(item?.type === "inputText" ? (item.text ?? "null") : "null") as {
          readonly error?: {
            readonly code?: string;
            readonly message?: string;
            readonly recovery?: string;
            readonly retryable?: boolean;
          };
        };
      };

      return Effect.scoped(
        Effect.gen(function* () {
          const [catalog] = buildNodexAgentDynamicToolSpecs();
          assert.strictEqual(catalog?.type, "namespace");
          if (!catalog || catalog.type !== "namespace") return;
          assert.deepEqual(
            catalog.tools.map((tool) => tool.name),
            [
              "advanced_update_page",
              "create_pages",
              "duplicate_page",
              "fetch",
              "get_context",
              "move_pages",
              "query_data_source",
              "query_database_view",
              "search",
              "set_page_properties",
              "update_page",
            ],
          );

          const context = yield* Layer.build(
            layer(true).pipe(Layer.provide(Layer.succeed(NodexAgentApplication, application))),
          );
          const tools = Context.get(context, NodexAgentDynamicTools);
          const stale = yield* tools.execute(
            {
              threadId: "thread:stale",
              turnId: "turn:stale",
              callId: "call:stale",
              namespace: "nodex_app",
              tool: "get_context",
              arguments: {},
            },
            { ...policy, toolsetRevision: null },
          );
          assert.isFalse(stale.success);
          assert.deepEqual(parseFailure(stale).error, {
            code: "tool_catalog_stale",
            message: "This task was not launched with the Nodex agent-tool catalog",
            retryable: false,
            recovery: "start_new_task",
          });

          const invalid = yield* tools.execute(
            {
              threadId: "thread:current",
              turnId: "turn:current",
              callId: "call:invalid",
              namespace: "nodex_app",
              tool: "fetch",
              arguments: {},
            },
            policy,
          );
          assert.isFalse(invalid.success);
          assert.strictEqual(parseFailure(invalid).error?.code, "invalid_arguments");
        }),
      );
    },
  );

  it.effect(
    "rejects restored catalog calls while disabled before reading or authorizing content",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const unexpected = () =>
            Effect.die("disabled tools must not touch application or authorization");
          const application = NodexAgentApplication.of({
            readPageObservation: () => Effect.die("unexpected Page observation"),
            read: unexpected,
            prepare: unexpected,
            apply: unexpected,
            completePageUpdate: unexpected,
          });
          const context = yield* Layer.build(
            layer(false).pipe(Layer.provide(Layer.succeed(NodexAgentApplication, application))),
          );
          const tools = Context.get(context, NodexAgentDynamicTools);
          assert.deepEqual(selectNodexAgentDynamicToolSpecs(false), []);
          assert.deepEqual(
            selectNodexAgentDynamicToolSpecs(true),
            buildNodexAgentDynamicToolSpecs(),
          );
          const result = yield* tools.execute(
            {
              threadId: "historical",
              turnId: "turn",
              callId: "call",
              namespace: "nodex_app",
              tool: "create_pages",
              arguments: {},
            },
            {
              toolsetRevision: NODEX_APP_TOOLSET_REVISION,
              authority: null,
            },
          );
          assert.isFalse(result.success);
          const content = result.contentItems[0];
          assert.strictEqual(content?.type, "inputText");
          if (content?.type !== "inputText") return;
          assert.deepEqual(JSON.parse(content.text), {
            error: {
              code: "tool_catalog_stale",
              message: "Nodex dynamic tools are disabled in this instance.",
              retryable: false,
              recovery: "none",
              details: { domainCode: "NODEX_DYNAMIC_TOOLS_DISABLED" },
            },
          });
        }),
      ),
  );

  it.effect("dispatches one atomic batch of Page Property updates", () =>
    Effect.gen(function* () {
      const updates = [
        { pageIds: ["NODEX-4", "NODEX-8"], values: [{ propertyId: "Status", value: "Done" }] },
      ];
      const unexpected = () => Effect.die("unexpected operation");
      const output = {
        data: {
          pages: [
            {
              pageId: "page",
              pageKey: "NODEX-4",
              dataSourceId: "source",
              membershipRevision: 1,
              values: [{ propertyId: "status", before: "plan", after: "done", valueRevision: 4 }],
            },
          ],
        },
      };
      const app = NodexAgentApplication.of({
        read: unexpected,
        readPageObservation: unexpected,
        completePageUpdate: unexpected,
        prepare: unexpected,
        apply: (command) =>
          Effect.sync(() => {
            assert.equal(command.kind, "set_page_properties");
            if (command.kind !== "set_page_properties") throw new Error("wrong command");
            assert.deepEqual(command.input, SetPagePropertiesV6InputSchema.parse({ updates }));
            return { kind: command.kind, value: { ok: true as const, output } } as never;
          }),
      });
      const result = yield* executeNodexAgentV3Tool(
        "set_page_properties",
        { updates },
        {
          threadId: "thread",
          callId: "call",
          operationId: "operation",
          authority: {
            threadId: "thread",
            turnId: "turn",
            rootThreadId: "thread",
            actorProjectId: "project",
            libraryId: "library",
            storeEpoch: "epoch",
            admittedAtMs: 1,
          },
        },
      ).pipe(Effect.provideService(NodexAgentApplication, app));
      assert.deepEqual(result, output);
    }),
  );
});
