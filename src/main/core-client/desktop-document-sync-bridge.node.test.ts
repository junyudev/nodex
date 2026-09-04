import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { DocumentSyncClientTarget } from "../document-sync-transport";
import {
  DesktopDocumentSessionRuntime,
  desktopDocumentSessionRuntimeLive,
} from "./desktop-document-sync-bridge";
import { createFakeCoreHandshake, FakeCoreClient } from "./testing/fake-core-client";
import type { CoreGenerationClient } from "./core-generation-client";
import type { CoreClientPort, CoreDocumentEventSubscription } from "./types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { live as coreModulesLive } from "../core-runtime/CoreModules";
import { live as documentLiveRuntimeLive } from "../core-runtime/DocumentLiveRuntime";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";

const subscribeRequest = {
  documentId: "document:one",
  clientSessionId: "renderer:one",
} as const;

class FakeTarget implements DocumentSyncClientTarget {
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  readonly #destroyedListeners: Array<() => void> = [];
  #destroyed = false;

  constructor(readonly id: number) {}

  get destroyedListenerCount(): number {
    return this.#destroyedListeners.length;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, payload: args[0] });
  }

  once(event: "destroyed", listener: () => void): void {
    if (event === "destroyed") this.#destroyedListeners.push(listener);
  }

  removeListener(event: "destroyed", listener: () => void): void {
    if (event !== "destroyed") return;
    const index = this.#destroyedListeners.indexOf(listener);
    if (index >= 0) this.#destroyedListeners.splice(index, 1);
  }
}

class ControlledOpeningDocumentStreamClient extends FakeCoreClient {
  openings = 0;
  readonly openingStarted: Promise<void>;
  #resolveOpeningStarted: () => void = () => undefined;

  constructor() {
    super();
    this.openingStarted = new Promise<void>((resolve) => {
      this.#resolveOpeningStarted = resolve;
    });
  }

  override openDocumentEventStream(
    input: Parameters<CoreClientPort["openDocumentEventStream"]>[0],
  ): Promise<CoreDocumentEventSubscription> {
    this.openings += 1;
    this.#resolveOpeningStarted();
    return new Promise<CoreDocumentEventSubscription>((_resolve, reject) => {
      const signal = input.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

class TrackingDocumentStreamClient extends FakeCoreClient {
  activeSubscriptions = 0;

  override async openDocumentEventStream(
    ...args: Parameters<FakeCoreClient["openDocumentEventStream"]>
  ): Promise<CoreDocumentEventSubscription> {
    const subscription = await super.openDocumentEventStream(...args);
    this.activeSubscriptions += 1;
    let closed = false;
    return {
      ...subscription,
      close: () => {
        if (closed) return;
        closed = true;
        this.activeSubscriptions -= 1;
        subscription.close();
      },
    };
  }
}

const configureClient = (client: FakeCoreClient): CoreGenerationClient => {
  Object.assign(client, {
    handshake: createFakeCoreHandshake({
      connectionBinding: "binding:test",
      libraryId: "library:test",
      profileId: "profile:test",
      storeEpoch: "epoch:test",
    }),
    forProject: () => client,
  });
  return client as unknown as CoreGenerationClient;
};

const authorityFor = (client: CoreGenerationClient): CoreAuthority["Service"] =>
  CoreAuthority.of({
    identity: {
      libraryId: client.handshake.library_id,
      profileId: client.handshake.generation.profile_id,
      storeEpoch: client.handshake.store_epoch,
    },
  } as CoreAuthority["Service"]);

const acquireSession = Effect.fn("DesktopDocumentSessionRuntime.test.acquire")(function* (
  client: FakeCoreClient,
) {
  const scope = yield* Scope.make();
  const generationClient = configureClient(client);
  const authority = authorityFor(generationClient);
  const coreSession = CoreSessionAccess.of({
    use: (operation, run, options) =>
      Effect.tryPromise({
        try: (signal) =>
          run(
            options?.projectId ? generationClient.forProject(options.projectId) : generationClient,
            signal,
          ),
        catch: (cause) => classifyCoreOperationFailure(operation, cause),
      }),
    handshake: Effect.succeed(generationClient.handshake),
  });
  const coreSessionLayer = Layer.succeed(CoreSessionAccess, coreSession);
  const dependencies = Layer.mergeAll(
    Layer.succeed(CoreAuthority, authority),
    coreSessionLayer,
    coreModulesLive.pipe(Layer.provide(coreSessionLayer)),
    documentLiveRuntimeLive,
  );
  const context = yield* Layer.buildWithScope(
    desktopDocumentSessionRuntimeLive().pipe(Layer.provide(dependencies)),
    scope,
  );
  return {
    scope,
    session: Context.get(context, DesktopDocumentSessionRuntime),
  };
});

it.effect("releases an active subscription and its target listener with the owning Scope", () =>
  Effect.gen(function* () {
    const client = new TrackingDocumentStreamClient();
    const { scope, session } = yield* acquireSession(client);
    const target = new FakeTarget(1);

    const subscribed = yield* session.subscribe(
      { kind: "project", projectId: "project:one" },
      target,
      subscribeRequest,
    );
    assert.deepStrictEqual(subscribed, { ok: true, value: { subscribed: true } });
    assert.strictEqual(target.destroyedListenerCount, 1);
    assert.strictEqual(client.activeSubscriptions, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(target.destroyedListenerCount, 0);
    assert.strictEqual(client.activeSubscriptions, 0);

    const closedAdmission = yield* session.subscribe(
      { kind: "project", projectId: "project:one" },
      target,
      subscribeRequest,
    );
    assert.isFalse(closedAdmission.ok);
  }),
);

it.effect("admits a Document mutation only behind the exact live session", () =>
  Effect.gen(function* () {
    const client = new TrackingDocumentStreamClient();
    const { scope, session } = yield* acquireSession(client);
    const target = new FakeTarget(3);
    const access = { kind: "project", projectId: "project:one" } as const;
    const request = {
      ...subscribeRequest,
      storeEpoch: "epoch:test",
      generation: 1,
      updateId: "update:one",
      baseHeadSeq: 0,
      touchedBlockIds: [],
      update: new Uint8Array([1]),
    } as const;

    yield* session.subscribe(access, target, subscribeRequest);
    client.enqueueDocumentUpdateApply({
      documentId: request.documentId,
      storeEpoch: request.storeEpoch,
      generation: request.generation,
      updateId: request.updateId,
      committedSeq: 0,
      headSeq: 0,
      stateVector: new Uint8Array(),
      duplicate: false,
      status: "no_op",
      observed: { store_epoch: request.storeEpoch, commit_head: 0 },
    });

    assert.deepStrictEqual(yield* session.applyUpdate(access, target, request), {
      ok: true,
      value: {
        documentId: request.documentId,
        storeEpoch: request.storeEpoch,
        generation: request.generation,
        updateId: request.updateId,
        committedSeq: 0,
        headSeq: 0,
        stateVector: new Uint8Array(),
        duplicate: false,
        status: "no_op",
        observed: { store_epoch: request.storeEpoch, commit_head: 0 },
      },
    });

    yield* session.unsubscribe(access, target, subscribeRequest);
    assert.isFalse((yield* session.applyUpdate(access, target, request)).ok);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("starts a fresh bounded retry episode when preparing a legacy owner", () =>
  Effect.gen(function* () {
    const client = new FakeCoreClient();
    const { scope, session } = yield* acquireSession(client);

    const result = yield* session.prepareOwnedBlockDocument("project:one", "legacy-canvas-owner");

    assert.isFalse(result.ok);
    assert.strictEqual(client.documentApplies.length, 1);
    const applied = client.documentApplies[0];
    assert.deepStrictEqual(applied?.intent, {
      kind: "prepare_owner",
      owner_block_id: "legacy-canvas-owner",
    });
    const [namespace, version, issued, expires, scopeName, entropy] =
      applied?.operationId.split(":") ?? [];
    assert.strictEqual(namespace, "nodexop");
    assert.strictEqual(version, "v1");
    assert.strictEqual(scopeName, "document.prepare-project-owner");
    assert.isAbove(Number(issued), 0);
    assert.strictEqual(Number(expires) - Number(issued), 7 * 24 * 60 * 60 * 1_000);
    assert.isNotEmpty(entropy);
    assert.notInclude(applied?.operationId ?? "", "legacy-canvas-owner");

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("settles a pending reservation and its waiter when the owning Scope closes", () =>
  Effect.gen(function* () {
    const client = new ControlledOpeningDocumentStreamClient();
    const { scope, session } = yield* acquireSession(client);
    const target = new FakeTarget(2);
    const access = { kind: "project", projectId: "project:one" } as const;

    const opening = yield* Effect.forkChild(session.subscribe(access, target, subscribeRequest));
    yield* Effect.promise(() => client.openingStarted);
    const waiting = yield* Effect.forkChild(session.subscribe(access, target, subscribeRequest));
    yield* Effect.yieldNow;
    assert.strictEqual(client.openings, 1);
    assert.strictEqual(target.destroyedListenerCount, 1);

    yield* Scope.close(scope, Exit.void);
    const [openingResult, waitingResult] = yield* Effect.all([
      Fiber.join(opening),
      Fiber.join(waiting),
    ]);
    assert.isFalse(openingResult.ok);
    assert.isFalse(waitingResult.ok);
    assert.strictEqual(target.destroyedListenerCount, 0);
  }),
);
