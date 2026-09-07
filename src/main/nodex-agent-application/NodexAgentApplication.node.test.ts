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
    authorization: null,
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
    authorization: null,
    value: {
      kind: "database",
      value: {
        database: {
          database_id: "database:agent",
          library_id: identity.libraryId,
          name: "Tasks",
          lifecycle: "active",
          default_view_id: null,
          access_revision: 1,
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
    authorization: null,
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
    authorization: null,
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
        access: {
          read: "allowed",
          write: "consent_required",
          domains: ["document", "placement", "database"],
        },
        input: { include: { databases: true, markdownGuide: true } },
      });

      assert.strictEqual(envelope.metrics.mutationId, "call:agent");
      assert.isTrue(envelope.result.ok);
      if (!envelope.result.ok || envelope.result.tool !== "get_context") return;
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
            frozenAtMs: 1_785_491_085_000,
            readOnly: false,
            scope: "project",
            source: "project_turn",
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
        access: { read: "allowed", write: "unavailable", domains: [] },
        input: {},
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "NodexAgentApplicationError");
    if (error._tag === "NodexAgentApplicationError") {
      assert.strictEqual(error.operation, "nodexAgent.closed");
    }
  });
});
