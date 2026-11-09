import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModuleResponseError } from "../core-client/core-client";
import { RemoteAccessWithdrawnError } from "../core-client/remote-http";
import { CoreHttpError, CoreTransportError } from "../core-client/local-http";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { components } from "@nodex/core-protocol";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { make } from "./SpaceConnectionRegistry";
import { SpaceConnectionStorage, type SpaceCredential } from "./SpaceConnectionStorage";
import * as RemoteSpaceAuthority from "./RemoteSpaceAuthority";

const personalId = "cbdacdad-48ea-4c7c-b2f8-928431855288";
const teamId = "library-435bed62c16b4fe982083e8d9b1c4561";
const credential: SpaceCredential = {
  spaceId: teamId,
  memberId: "alice",
  deviceId: "desktop",
  name: "Team",
  url: "https://team.example",
  fingerprint: "a".repeat(64),
  deviceCredential: "private-device-credential",
};

const clientFor = (spaceId: string, spaceName = "Team"): CoreGenerationClient => {
  const client = Object.assign(new FakeCoreClient(), {
    spaceName,
    handshake: createFakeCoreHandshake({
      libraryId: spaceId,
      profileId: `profile-${spaceId}`,
      storeEpoch: "epoch",
    }),
    forProject: () => client,
    health: () =>
      Promise.resolve({
        status: "ready" as const,
        pid: 1,
        start_nonce: "fake-core-start",
      } as Awaited<ReturnType<CoreGenerationClient["health"]>>),
    shutdown: () => Promise.resolve({ status: "draining" as const }),
  });
  return client;
};

  let personalName = "Personal";
  const client = Object.assign(clientFor(personalId), {
    spaceInfo: () =>
      Promise.resolve({ space_name: personalName } as components["schemas"]["RemoteCoreInfo"]),
  });
  let releases = 0;
  let revoked = false;
  let connects = 0;
  let disconnectNext = false;
  let spaceName = "Team";
  const persisted: SpaceCredential[] = [];
  const state = yield* SubscriptionRef.make<
    import("../core-runtime/CoreAuthority").CoreAuthorityState
  >({ kind: "ready", generation: "local" });
  const local = Context.make(
    CoreAuthority,
    CoreAuthority.of({
      identity: { libraryId: personalId, profileId: "personal", storeEpoch: "epoch" },
      initialLaunch: null,
      state,
      retry: Effect.void,
      requestRelaunch: Effect.void,
      failApplication: () => Effect.succeed(true),
    }),
  ).pipe(
    Context.add(
      CoreSessionAccess,
      CoreSessionAccess.of({
        handshake: Effect.succeed(client.handshake),
        use: (_name, run) => Effect.promise((signal) => run(client, signal)),
      }),
    ),
  );
  const storage = SpaceConnectionStorage.of({
    load: Effect.succeed({ credentials: saved, unavailableSpaceIds: [] }),
    save: (credential) =>
      Effect.sync(() => {
        persisted.push(credential);
      }),
    remove: () => Effect.void,
  });
  const registry = yield* make({
    buildId: "test",
    remote: (saved, observe) =>
      RemoteSpaceAuthority.live({
        credential: saved,
        buildId: "test",
        observe,
        connect: async () => {
          connects += 1;
          if (disconnectNext) {
            disconnectNext = false;
            throw new CoreTransportError("unreachable", "connect", "ECONNREFUSED", null);
          }
          if (revoked) throw new RemoteAccessWithdrawnError(new CoreHttpError(401, "Revoked"));
          return Object.assign(clientFor(saved.spaceId, spaceName), {
            spaceInfo: () =>
              Promise.resolve({ space_name: spaceName } as components["schemas"]["RemoteCoreInfo"]),
          });
        },
      }).pipe(
        Layer.tap(() =>
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              releases += 1;
            }),
          ),
        ),
      ),
  }).pipe(Effect.provideService(SpaceConnectionStorage, storage), Effect.provideContext(local));
  return {
    registry,
    persisted,
    renameHost: (name: string) => {
      spaceName = name;
    },
    renamePersonal: (name: string) => {
      personalName = name;
    },
    revoke: () => {
      revoked = true;
    },
    releases: () => releases,
    connects: () => connects,
    disconnectNext: () => {
      disconnectNext = true;
    },
  };
});

it.effect("the personal Space shows Core's name and follows its rename", () =>
  Effect.gen(function* () {
    const { registry, renamePersonal } = yield* fixture([]);
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[0]?.name, "Personal");
    renamePersonal("Jun's Space");
    yield* registry.refreshName(personalId);
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[0]?.name, "Jun's Space");
  }).pipe(Effect.scoped),
);

it.effect("retries a team that was unavailable during initial connection", () =>
  Effect.gen(function* () {
    const { registry, disconnectNext, connects } = yield* fixture();
    disconnectNext();
    assert.strictEqual((yield* Effect.result(registry.connection(teamId)))._tag, "Failure");
    assert.strictEqual(
      (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
      "reconnecting",
    );
    const remote = yield* registry.connection(teamId);
    assert.strictEqual(
      (yield* Context.get(remote, CoreSessionAccess).handshake).library_id,
      teamId,
    );
    assert.strictEqual(connects(), 2);
    assert.deepStrictEqual(
      (yield* SubscriptionRef.get(registry.summaries)).map((space) => space.availability),
      ["ready", "ready"],
    );
  }),
);

it.effect(
  "routes identical resource IDs through the selected Space and rejects missing or unknown coordinates",
  () =>
    Effect.gen(function* () {
      const { registry } = yield* fixture();
      for (const spaceId of [personalId, teamId]) {
        const request = yield* registry.validateRequest({ spaceId, args: ["same-page"] }, spaceId);
        const context = yield* registry.connection(request.spaceId);
        const observed = yield* Context.get(context, CoreSessionAccess).use(
          "test",
          async (client) => client.handshake.library_id,
        );
        assert.strictEqual(observed, spaceId);
      }
      for (const raw of [{ args: [] }, { spaceId: "", args: [] }, { spaceId: "unknown", args: [] }])
        assert.strictEqual(
          (yield* Effect.result(registry.validateRequest(raw, personalId)))._tag,
          "Failure",
        );
      assert.strictEqual((yield* Effect.result(registry.connection("unknown")))._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.result(registry.validateRequest({ spaceId: teamId, args: [] }, personalId)))
          ._tag,
        "Failure",
      );
    }),
);

it.effect(
  "revocation fences only the team connection and leaving closes its scope without stopping personal",
  () =>
    Effect.gen(function* () {
      const { registry, revoke, releases } = yield* fixture();
      const remote = yield* registry.connection(teamId);
      const access = Context.get(remote, CoreSessionAccess);
      revoke();
      const rejected = yield* Effect.result(
        access.use("test", async () => {
          throw new RemoteAccessWithdrawnError(new CoreHttpError(401, "Revoked"));
        }),
      );
      assert.strictEqual(rejected._tag, "Failure");
      assert.strictEqual(
        (yield* SubscriptionRef.get(registry.summaries)).find((entry) => entry.spaceId === teamId)
          ?.availability,
        "access-revoked",
      );
      const personal = yield* registry.connection(personalId);
      assert.strictEqual(
        (yield* Context.get(personal, CoreSessionAccess).handshake).library_id,
        personalId,
      );
      yield* registry.leave(teamId);
      assert.strictEqual(releases(), 1);
      assert.strictEqual(
        (yield* Effect.result(access.use("late-command", async () => "should not run")))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Context.get(personal, CoreSessionAccess).handshake).library_id,
        personalId,
      );
    }),
);

it.effect("retains a personal connection when a remote Space fails to connect", () =>
  Effect.gen(function* () {
    const { registry, revoke } = yield* fixture();
    revoke();
    assert.strictEqual((yield* Effect.result(registry.connection(teamId)))._tag, "Failure");
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[0]?.availability, "ready");
    const personal = yield* registry.connection(personalId);
    assert.strictEqual(
      (yield* Context.get(personal, CoreSessionAccess).handshake).library_id,
      personalId,
    );
  }),
);

it.effect("a capacity refusal retains the current session instead of reconnecting", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    assert.strictEqual(
      (yield* Effect.result(
        access.use("busy", async () => {
          throw new CoreHttpError(429, "Capacity");
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(connects(), 1);
    assert.strictEqual(
      (yield* SubscriptionRef.get(registry.summaries)).find((space) => space.spaceId === teamId)
        ?.availability,
      "ready",
    );
    assert.strictEqual(
      yield* access.use("next-read", async (client) => client.handshake.library_id),
      teamId,
    );
  }),
);

it.effect("isolates two team connections even when one loses its credential", () =>
  Effect.gen(function* () {
    const otherId = "library-another-team";
    const { registry } = yield* fixture([
      credential,
      { ...credential, spaceId: otherId, deviceId: "second-device" },
    ]);
    const first = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    const second = Context.get(yield* registry.connection(otherId), CoreSessionAccess);
    yield* Effect.result(
      first.use("withdrawn", async () => {
        throw new RemoteAccessWithdrawnError(new CoreHttpError(401, "Revoked"));
      }),
    );
    assert.strictEqual(
      yield* second.use("read", async (client) => client.handshake.library_id),
      otherId,
    );
    const spaces = yield* SubscriptionRef.get(registry.summaries);
    assert.deepStrictEqual(
      spaces.map((space) => space.availability),
      ["ready", "access-revoked", "ready"],
    );
  }),
);

it.effect("a canceled request retains its healthy remote session", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    yield* Effect.result(
      access.use("canceled-read", async () => {
        throw new CoreTransportError("aborted", "response", "ABORT_ERR", null);
      }),
    );
    assert.strictEqual(connects(), 1);
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[1]?.availability, "ready");
  }),
);

it.effect("concurrent losses of one connection share a replacement session", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    const original = yield* access.use("selected-client", async (client) => client);
    const read = access.use("lost-read", async (client) => {
      if (client === original)
        throw new CoreTransportError("connection_lost", "response", "ECONNRESET", null);
      return client.handshake.library_id;
    });
    assert.deepEqual(yield* Effect.all([read, read], { concurrency: "unbounded" }), [
      teamId,
      teamId,
    ]);
    assert.strictEqual(connects(), 2);
  }),
);

it.effect(
  "revocation during reconnection fences late failures without another session attempt",
  () =>
    Effect.gen(function* () {
      const { registry, connects, revoke } = yield* fixture();
      const context = yield* registry.connection(teamId);
      const access = Context.get(context, CoreSessionAccess);
      revoke();
      yield* Effect.result(
        access.use("lost-read", async () => {
          throw new CoreTransportError("connection_lost", "response", "ECONNRESET", null);
        }),
      );
      assert.strictEqual(
        (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
        "access-revoked",
      );
      yield* Context.get(context, CoreAuthority).failApplication(
        coreRuntimeError({ operation: "late-events", reason: "transport-loss", retryable: true }),
      );
      assert.strictEqual(
        (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
        "access-revoked",
      );
      const body = () => {
        throw new Error("A revoked connection must not be reused");
      };
      assert.strictEqual((yield* Effect.result(access.use("late-read", body)))._tag, "Failure");
      assert.strictEqual(connects(), 2);
      assert.strictEqual(
        (yield* SubscriptionRef.get(registry.summaries))[0]?.availability,
        "ready",
      );
    }),
);

it.effect("revocation on a recovered request fences the replacement immediately", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    let attempts = 0;
    yield* Effect.result(
      access.use("recovered-read", async () => {
        if (attempts++ === 0)
          throw new CoreTransportError("connection_lost", "response", "ECONNRESET", null);
        throw new RemoteAccessWithdrawnError(new CoreHttpError(401, "Revoked"));
      }),
    );
    assert.strictEqual(connects(), 2);
    assert.strictEqual(
      (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
      "access-revoked",
    );
  }),
);
          throw new CoreHttpError(
            401,
            "connection has not completed a compatible Core handshake",
            undefined,
            {
              code: "unauthorized",
              message: "Renew",
              retryable: false,
              recovery: { kind: "renew_remote_session" },
            },
          );

it.effect(
  "reconnection replaces the cached Space name from its host and persists it with the same credential",
  () =>
    Effect.gen(function* () {
      const { registry, renameHost, persisted, connects } = yield* fixture();
      const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
      const before = yield* access.use("before-rename", async (client) => client);
      renameHost("Platform");
      yield* access.use("after-rename", async (client) => {
        if (client === before)
          throw new CoreTransportError("connection_lost", "response", "ECONNRESET", null);
        return client.handshake.library_id;
      });
      assert.strictEqual(connects(), 2);
      assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[1]?.name, "Platform");
      assert.deepEqual(persisted, [{ ...credential, name: "Platform" }]);
    }),
);

it.effect("a connected team Space follows its host's rename without reconnecting", () =>
  Effect.gen(function* () {
    const { registry, renameHost, persisted, connects } = yield* fixture();
    yield* registry.connection(teamId);
    renameHost("Platform");
    yield* registry.refreshName(teamId);
    assert.strictEqual(connects(), 1);
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[1]?.name, "Platform");
    assert.deepEqual(persisted, [{ ...credential, name: "Platform" }]);
  }),
);

it.effect("operation refusals do not fence an active Member's connection", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const connection = yield* registry.connection(teamId);
    const access = Context.get(connection, CoreSessionAccess);
    for (const status of [401, 403, 409, 429]) {
      assert.strictEqual(
        yield* Context.get(connection, CoreAuthority).failApplication(
          coreRuntimeError({
            operation: "stream-admission",
            reason: "operation",
            retryable: false,
            cause: new CoreHttpError(status, "Operation refused"),
          }),
        ),
        false,
      );
      yield* Effect.result(
        access.use("refused-answer", async () => {
          throw new CoreHttpError(status, "This execution request belongs to another Member");
        }),
      );
      assert.strictEqual(
        (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
        "ready",
      );
      assert.strictEqual(
        yield* access.use("inbox-read", async (client) => client.handshake.library_id),
        teamId,
      );
    }
    assert.strictEqual(
      yield* Context.get(connection, CoreAuthority).failApplication(
        coreRuntimeError({
          operation: "stale-fence",
          reason: "delivery",
          retryable: false,
          cause: new CoreModuleResponseError({
            code: "stale_store_epoch",
            message: "Another Store epoch",
            retryable: false,
            recovery: { kind: "current_store_epoch", store_epoch: "different" },
          }),
        }),
      ),
      false,
    );
    assert.strictEqual(
      yield* access.use("read-after-fence", async (client) => client.handshake.library_id),
      teamId,
    );
    assert.strictEqual(connects(), 1);
  }),
);

it.effect("a healthy original session clears reconnecting after an unsuccessful replacement", () =>
  Effect.gen(function* () {
    const { registry, disconnectNext, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    disconnectNext();
    yield* Effect.result(
      access.use("offline", async () => {
        throw new CoreTransportError("connection_lost", "open", "ECONNRESET", null);
      }),
    );
    assert.strictEqual(
      (yield* SubscriptionRef.get(registry.summaries))[1]?.availability,
      "reconnecting",
    );
    assert.strictEqual(
      yield* access.use("recovered-stream", async (client) => client.handshake.library_id),
      teamId,
    );
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[1]?.availability, "ready");
    assert.strictEqual(connects(), 2);
  }),
);

it.effect("a writer-expired session renews once and replays the same mutation identity", () =>
  Effect.gen(function* () {
    const { registry, connects } = yield* fixture();
    const access = Context.get(yield* registry.connection(teamId), CoreSessionAccess);
    const before = yield* access.use("selected", async (client) => client);
    const attempts: string[] = [];
    const operationId = "same-queued-operation";
    const result = yield* access.use("queued-write", async (client) => {
      attempts.push(operationId);
      if (client === before)
        throw new CoreModuleResponseError({
          code: "unauthorized",
          message: "Session expired at writer",
          retryable: true,
          recovery: { kind: "renew_remote_session" },
        });
      return { operationId, value: "committed" };
    });
    assert.deepStrictEqual(result, { operationId, value: "committed" });
    assert.deepStrictEqual(attempts, [operationId, operationId]);
    assert.strictEqual(connects(), 2);
    assert.strictEqual((yield* SubscriptionRef.get(registry.summaries))[1]?.availability, "ready");
  }),
);
