import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import { NodexAgentResourceAccessError } from "../nodex-agent-application/NodexAgentResourceAccess";
import {
  NodexAgentAuthorizationRuntime,
  type AuthorizeNodexAgentAccessInput,
  testLayer,
} from "./NodexAgentAuthorizationRuntime";

const authority = {
  threadId: "thread-child",
  turnId: "turn-child",
  rootThreadId: "thread-root",
  actorProjectId: "project-1",
  libraryId: "library-1",
  storeEpoch: "store-1",
  frozenAtMs: 1_785_491_085_000,
  readOnly: false,
  scope: "project",
  source: "project_turn",
} satisfies FrozenNodexAgentTurnAuthority;

function authorizationInput(
  overrides: Partial<AuthorizeNodexAgentAccessInput> = {},
): AuthorizeNodexAgentAccessInput {
  const requirement = {
    intent: {
      target: { kind: "page" as const, pageId: "page-1" },
      action: "write" as const,
    },
    grant: {
      root: { kind: "page" as const, pageId: "page-1" },
      access: "read_write" as const,
    },
    reason: "grant_missing" as const,
    persistable: true,
  };
  return {
    threadId: authority.threadId,
    callId: "call-1",
    projectId: authority.actorProjectId,
    tool: "update_page",
    effect: "write",
    preview: {
      title: "Update Page",
      summary: "Append two Blocks.",
      details: [{ label: "Page", value: "page-1" }],
    },
    requirements: [requirement],
    inspectionAccess: {
      kind: "inspection",
      scope: "call",
      threadId: authority.threadId,
      turnId: authority.turnId,
      callId: "call-1",
      rootThreadId: authority.rootThreadId,
      actorProjectId: authority.actorProjectId,
      libraryId: authority.libraryId,
      storeEpoch: authority.storeEpoch,
      grants: [requirement.grant],
    },
    rootThreadId: authority.rootThreadId,
    authority,
    presentation: {
      clientId: "renderer-1",
      threadId: "thread-root",
      turnId: "turn-root",
    },
    ...overrides,
  };
}

type RendererRequest = RendererClientRuntime["Service"]["request"];

const makeRendererRequest = (
  operation: (
    targetClientId: string,
    method: string,
    params: unknown,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<unknown>,
): RendererRequest => operation as RendererRequest;

const buildRuntime = (input: {
  readonly rendererRequest: RendererRequest;
  readonly readStoreEpoch: () => string | null;
  readonly persistProjectGrants?: Parameters<typeof testLayer>[0]["persistProjectGrants"];
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      testLayer({
        rendererClients: { request: input.rendererRequest },
        readStoreEpoch: input.readStoreEpoch,
        sessionEpoch: "session-1",
        persistProjectGrants: input.persistProjectGrants ?? (() => Effect.void),
      }),
      scope,
    );
    return { runtime: Context.get(context, NodexAgentAuthorizationRuntime), scope };
  });

it.effect("owns task grants independently of the presenting renderer", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(42);
    const requests: Array<readonly unknown[]> = [];
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest((...args) =>
        Effect.sync(() => {
          requests.push(args);
          return { decision: "allow_task" };
        }),
      ),
      readStoreEpoch: () => "store-1",
    });

    const outcome = yield* runtime.authorize(authorizationInput());
    if (typeof outcome !== "object") return yield* Effect.die("Expected task authorization");
    assert.strictEqual(outcome.decision, "allow_task");
    assert.strictEqual(outcome.resourceAccess?.kind, "consent");
    assert.strictEqual(outcome.resourceAccess?.scope, "task");
    assert.deepEqual(outcome.resourceAccess?.grants, [
      {
        root: { kind: "page", pageId: "page-1" },
        access: "read_write",
      },
    ]);
    yield* runtime.extendTaskAccess(authority, [
      {
        root: { kind: "page", pageId: "page-created" },
        access: "read_write",
      },
    ]);
    assert.deepEqual((yield* runtime.getTaskAccess(authority))?.grants, [
      { root: { kind: "page", pageId: "page-1" }, access: "read_write" },
      { root: { kind: "page", pageId: "page-created" }, access: "read_write" },
    ]);
    assert.deepInclude(requests[0]?.[2], {
      threadId: "thread-root",
      turnId: "turn-root",
      itemId: "call-1",
      createdAt: 42,
    });
    yield* runtime.revokeRoot("thread-root");
    assert.isUndefined(yield* runtime.getTaskAccess(authority));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("persists only Project-approved persistable roots", () =>
  Effect.gen(function* () {
    const persisted: unknown[] = [];
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
      persistProjectGrants: (input) =>
        Effect.sync(() => {
          persisted.push(input);
        }),
    });

    assert.deepEqual(yield* runtime.authorize(authorizationInput()), {
      decision: "allow_project",
    });
    assert.strictEqual(persisted.length, 1);
    assert.deepInclude(persisted[0], {
      authority,
      grants: [
        {
          root: { kind: "page", pageId: "page-1" },
          access: "read_write",
        },
      ],
    });
    assert.match(
      Reflect.get(persisted[0] ?? {}, "operationId"),
      /^nodexop:v1:\d{13}:\d{13}:nodex-agent\.persist-grants:[0-9a-f-]{36}$/u,
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps non-persistable Library destinations call-local", () =>
  Effect.gen(function* () {
    let persisted = 0;
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
      persistProjectGrants: () => Effect.sync(() => void (persisted += 1)),
    });
    const libraryGrant = {
      root: { kind: "library" as const, libraryId: "library-1" },
      access: "read_write" as const,
      libraryActions: ["create_child" as const],
    };

    const outcome = yield* runtime.authorize(
      authorizationInput({
        tool: "create_pages",
        requirements: [
          {
            intent: {
              target: { kind: "library", libraryId: "library-1" },
              action: "create_child",
            },
            grant: libraryGrant,
            reason: "library_consent_required",
            persistable: false,
          },
        ],
        inspectionAccess: {
          ...authorizationInput().inspectionAccess,
          grants: [libraryGrant],
        },
      }),
    );
    if (typeof outcome !== "object") return yield* Effect.die("Expected Project authorization");
    assert.strictEqual(outcome.decision, "allow_project");
    assert.strictEqual(outcome.resourceAccess?.scope, "call");
    assert.isTrue(outcome.resourceAccess?.persistResultingPageGrants);
    assert.deepEqual(outcome.resourceAccess?.grants, [libraryGrant]);
    assert.strictEqual(persisted, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rechecks exact Turn authority before and after Project persistence", () =>
  Effect.gen(function* () {
    let checks = 0;
    let persists = 0;
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
      persistProjectGrants: () => Effect.sync(() => void (persists += 1)),
    });

    assert.strictEqual(
      yield* runtime.authorize(
        authorizationInput({
          isAuthorityCurrent: Effect.sync(() => {
            checks += 1;
            return checks === 1;
          }),
        }),
      ),
      "unavailable",
    );
    assert.strictEqual(persists, 1);
    assert.strictEqual(checks, 2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("never persists when exact Turn authority is already stale", () =>
  Effect.gen(function* () {
    let persists = 0;
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
      persistProjectGrants: () => Effect.sync(() => void (persists += 1)),
    });

    assert.strictEqual(
      yield* runtime.authorize(authorizationInput({ isAuthorityCurrent: Effect.succeed(false) })),
      "unavailable",
    );
    assert.strictEqual(persists, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails closed without stable store or presentation", () =>
  Effect.gen(function* () {
    let requests = 0;
    const missingStore = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() =>
        Effect.sync(() => {
          requests += 1;
          return { decision: "allow_project" };
        }),
      ),
      readStoreEpoch: () => null,
    });
    assert.strictEqual(yield* missingStore.runtime.authorize(authorizationInput()), "unavailable");
    assert.strictEqual(requests, 0);
    yield* Scope.close(missingStore.scope, Exit.void);

    const noPresentation = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
    });
    assert.strictEqual(
      yield* noPresentation.runtime.authorize(authorizationInput({ presentation: null })),
      "unavailable",
    );
    yield* Scope.close(noPresentation.scope, Exit.void);
  }),
);

it.effect("uses independent occurrences for concurrent renderer prompts", () =>
  Effect.gen(function* () {
    const firstResponse = yield* Deferred.make<unknown>();
    const secondResponse = yield* Deferred.make<unknown>();
    const requestIds: string[] = [];
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest((_clientId, _method, params) => {
        const request = params as { readonly itemId: string; readonly requestId: string };
        requestIds.push(request.requestId);
        return Deferred.await(request.itemId === "call-1" ? firstResponse : secondResponse);
      }),
      readStoreEpoch: () => "store-1",
    });
    const first = yield* Effect.forkChild(
      runtime.authorize(authorizationInput({ callId: "call-1" })),
    );
    const second = yield* Effect.forkChild(
      runtime.authorize(authorizationInput({ callId: "call-2" })),
    );
    yield* Effect.yieldNow;
    assert.strictEqual(requestIds.length, 2);
    assert.notStrictEqual(requestIds[0], requestIds[1]);
    yield* Deferred.succeed(firstResponse, { decision: "allow_once" });
    yield* Deferred.succeed(secondResponse, { decision: "deny" });
    assert.deepInclude(yield* Fiber.join(first), { decision: "allow_once" });
    assert.strictEqual(yield* Fiber.join(second), "deny");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fences renderer decisions that cross a Store epoch", () =>
  Effect.gen(function* () {
    let storeEpoch: string | null = "store-1";
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<unknown>();
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(response))),
      ),
      readStoreEpoch: () => storeEpoch,
    });
    const pending = yield* Effect.forkChild(runtime.authorize(authorizationInput()));
    yield* Deferred.await(requested);
    storeEpoch = "store-2";
    yield* Deferred.succeed(response, { decision: "allow_task" });

    assert.strictEqual(yield* Fiber.join(pending), "unavailable");
    assert.isUndefined(yield* runtime.getTaskAccess(authority));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fences late renderer decisions after its owning Scope closes", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<unknown>();
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Deferred.await(response)),
      readStoreEpoch: () => "store-1",
    });
    const pending = yield* Effect.forkChild(runtime.authorize(authorizationInput()));
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.succeed(response, { decision: "allow_task" });

    assert.strictEqual(yield* Fiber.join(pending), "unavailable");
    assert.isUndefined(yield* runtime.getTaskAccess(authority));
  }),
);

it.effect("fails closed when durable Project-grant publication fails", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* buildRuntime({
      rendererRequest: makeRendererRequest(() => Effect.succeed({ decision: "allow_project" })),
      readStoreEpoch: () => "store-1",
      persistProjectGrants: () =>
        Effect.fail(
          new NodexAgentResourceAccessError({
            operation: "persist",
            cause: new Error("Core unavailable"),
          }),
        ),
    });
    assert.strictEqual(yield* runtime.authorize(authorizationInput()), "unavailable");
    yield* Scope.close(scope, Exit.void);
  }),
);
