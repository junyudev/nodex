import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import {
  JoinSpaceInputSchema,
  SpaceRequestSchema,
  parseSpaceInvite,
  type JoinSpaceInput,
  type SpaceAvailability,
  type SpaceConnectionSummary,
} from "../../shared/space-connection";
import { enrollRemoteCore } from "../core-client/remote-http";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import {
  SpaceConnectionStorage,
  type SpaceCredential,
  type SpaceStorageError,
} from "./SpaceConnectionStorage";
import * as RemoteSpaceAuthority from "./RemoteSpaceAuthority";

export class SpaceConnectionError extends Schema.TaggedError<SpaceConnectionError>()(
  "SpaceConnectionError",
  {
    message: Schema.String,
  },
) {}

export type SpaceAuthorityServices = CoreAuthority | CoreSessionAccess;

export class SpaceConnectionRegistry extends Context.Service<
  SpaceConnectionRegistry,
  {
    readonly personalSpaceId: string;
    readonly summaries: SubscriptionRef.SubscriptionRef<readonly SpaceConnectionSummary[]>;
    /** Rereads a Space's name from its Core, such as after an Owner renames it. */
    readonly refreshName: (spaceId: string) => Effect.Effect<void>;
    readonly connection: (
      spaceId: string,
    ) => Effect.Effect<
      Context.Context<SpaceAuthorityServices>,
      CoreRuntimeError | SpaceConnectionError
    >;
    readonly join: (
      input: JoinSpaceInput,
    ) => Effect.Effect<SpaceConnectionSummary, SpaceConnectionError | SpaceStorageError>;
    readonly leave: (
      spaceId: string,
    ) => Effect.Effect<void, SpaceConnectionError | SpaceStorageError>;
    readonly validateRequest: (
      input: unknown,
      expectedSpaceId: string,
    ) => Effect.Effect<
      { readonly spaceId: string; readonly args: readonly unknown[] },
      SpaceConnectionError
    >;
  }
>()("nodex/main/space-connections/SpaceConnectionRegistry") {}

export const make = Effect.fn("SpaceConnectionRegistry.make")(function* (input: {
  readonly buildId: string;
  readonly remote?: (
    credential: SpaceCredential,
    observe: (availability: SpaceAvailability, name?: string) => Effect.Effect<void>,
  ) => Layer.Layer<SpaceAuthorityServices, CoreRuntimeError>;
  readonly enroll?: typeof enrollRemoteCore;
}) {
  const personal = yield* Effect.context<SpaceAuthorityServices>();
  const authority = yield* CoreAuthority;
  // Core owns the Space's name, so the switcher, Settings, Device links and phones agree.
  const readName = (access: CoreSessionAccess["Service"]) =>
    access
      .use("space.name", (client, signal) => {
        if (!client.spaceInfo) throw new Error("Space identity is unavailable");
        return client.spaceInfo({ signal });
      })
      .pipe(
        Effect.map((info) => info.space_name),
        Effect.catch(() =>
          Effect.logWarning("The Space name could not be read").pipe(Effect.as(undefined)),
        ),
      );
  const storage = yield* SpaceConnectionStorage;
  const personalSpaceId = authority.identity.libraryId;
  const saved = yield* storage.load.pipe(
    Effect.catch(() =>
      Effect.logWarning("Private Space credentials could not be loaded").pipe(
        Effect.as({ credentials: [], unavailableSpaceIds: [] }),
      ),
    ),
  );
  const unavailable = new Set(saved.unavailableSpaceIds.filter((id) => id !== personalSpaceId));
  const credentials = new Map(
    saved.credentials
      .filter((credential) => credential.spaceId !== personalSpaceId)
      .map((credential) => [credential.spaceId, credential]),
  );
  const summaries = yield* SubscriptionRef.make<readonly SpaceConnectionSummary[]>([
    {
      spaceId: personalSpaceId,
      kind: "personal",
      name: (yield* readName(Context.get(personal, CoreSessionAccess))) ?? "Space",
      memberId: null,
      availability: "ready",
    },
    ...[...unavailable].map((spaceId): SpaceConnectionSummary => ({
      spaceId,
      kind: "team",
      name: "Space",
      memberId: null,
      availability: "unavailable",
    })),
    ...[...credentials.values()].map((credential): SpaceConnectionSummary => ({
      spaceId: credential.spaceId,
      kind: "team",
      name: credential.name,
      memberId: credential.memberId,
      availability: "reconnecting",
    })),
  ]);
  const writes = yield* Semaphore.make(1);
  const persistName = (spaceId: string, name: string) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const previous = credentials.get(spaceId);
        if (!previous || previous.name === name) return;
        const credential = { ...previous, name };
        credentials.set(spaceId, credential);
        yield* storage
          .save(credential)
          .pipe(
            Effect.catch(() => Effect.logWarning("Could not persist the refreshed Space name")),
          );
      }),
    );
  const observe = (spaceId: string) => (availability: SpaceAvailability, name?: string) =>
    Effect.gen(function* () {
      if (availability === "ready" && name !== undefined) yield* persistName(spaceId, name);
      yield* SubscriptionRef.update(summaries, (entries) =>
        entries.map((entry) =>
          entry.spaceId === spaceId
            ? {
                ...entry,
                availability,
                ...(name !== undefined ? { name } : {}),
              }
            : entry,
        ),
      );
    });

  const connections = yield* LayerMap.make(
    (
      spaceId: string,
    ): Layer.Layer<SpaceAuthorityServices, CoreRuntimeError | SpaceConnectionError> => {
      if (spaceId === personalSpaceId) return Layer.succeedContext(personal);
      const credential = credentials.get(spaceId);
      if (!credential)
        return Layer.effectContext(
          Effect.fail(new SpaceConnectionError({ message: "Unknown Space" })),
        );
      const remote =
        input.remote?.(credential, observe(spaceId)) ??
        RemoteSpaceAuthority.live({
          credential,
          buildId: input.buildId,
          observe: observe(spaceId),
        });
      return remote.pipe(
        Layer.tapError((error) =>
          observe(spaceId)(RemoteSpaceAuthority.remoteFailureAvailability(error.cause)).pipe(
            // An infinite idle lifetime must not retain a retryable failed acquisition.
            Effect.andThen(error.retryable ? connections.invalidate(spaceId) : Effect.void),
          ),
        ),
      );
    },
    { idleTimeToLive: Infinity },
  );
  const connection = (spaceId: string) => {
    if (!spaceId || (spaceId !== personalSpaceId && !credentials.has(spaceId)))
      return Effect.fail(
        new SpaceConnectionError({ message: spaceId ? "Unknown Space" : "A Space is required" }),
      );
    return Effect.scoped(connections.contextEffect(spaceId));
  };
  const refreshName = (spaceId: string) =>
    Effect.gen(function* () {
      const name = yield* readName(Context.get(yield* connection(spaceId), CoreSessionAccess));
      if (name === undefined) return;
      yield* persistName(spaceId, name);
      yield* SubscriptionRef.update(summaries, (entries) =>
        entries.map((entry) => (entry.spaceId === spaceId ? { ...entry, name } : entry)),
      );
    }).pipe(Effect.catch(() => Effect.void));
  yield* SubscriptionRef.changes(authority.state).pipe(
    Stream.runForEach((state) =>
      state.kind === "ready"
        ? observe(personalSpaceId)("ready").pipe(Effect.andThen(refreshName(personalSpaceId)))
        : observe(personalSpaceId)(state.kind === "recovering" ? "reconnecting" : "unavailable"),
    ),
    Effect.forkScoped,
  );
  const join = Effect.fn("SpaceConnectionRegistry.join")(function* (raw: JoinSpaceInput) {
    const parsed = yield* Effect.try({
      try: () => {
        const value = JoinSpaceInputSchema.parse(raw);
        return { ...value, endpoint: parseSpaceInvite(value.inviteUrl) };
      },
        new SpaceConnectionError({
        }),
    });
    const enrolled = yield* Effect.tryPromise({
      try: (signal) =>
        (input.enroll ?? enrollRemoteCore)(
          { url: parsed.endpoint.url, fingerprint: parsed.fingerprint },
          { code: parsed.code, display_name: parsed.displayName, device_label: parsed.deviceLabel },
          signal,
        ),
        new SpaceConnectionError({
        }),
    });
    if (
      enrolled.space_id === personalSpaceId ||
      credentials.has(enrolled.space_id) ||
      unavailable.has(enrolled.space_id)
    )
      return yield* new SpaceConnectionError({ message: "This Space is already connected" });
    const credential: SpaceCredential = {
      spaceId: enrolled.space_id,
      memberId: enrolled.member_id,
      deviceId: enrolled.device_id,
      deviceCredential: enrolled.device_credential,
      url: parsed.endpoint.url,
      fingerprint: parsed.fingerprint,
      name: enrolled.space_name,
    };
    yield* storage.save(credential);
    credentials.set(credential.spaceId, credential);
    const summary: SpaceConnectionSummary = {
      spaceId: credential.spaceId,
      memberId: credential.memberId,
      kind: "team",
      name: credential.name,
      availability: "reconnecting",
    };
    yield* SubscriptionRef.update(summaries, (entries) => [...entries, summary]);
    return summary;
  });
  return SpaceConnectionRegistry.of({
    personalSpaceId,
    summaries,
    refreshName,
    connection,
    join: (raw) => writes.withPermits(1)(join(raw)),
    leave: (spaceId) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          if (spaceId === personalSpaceId)
            return yield* new SpaceConnectionError({
              message: "The personal Space cannot be left",
            });
          if (!credentials.has(spaceId) && !unavailable.has(spaceId))
            return yield* new SpaceConnectionError({ message: "Unknown Space" });
          yield* storage.remove(spaceId);
          credentials.delete(spaceId);
          unavailable.delete(spaceId);
          yield* connections.invalidate(spaceId);
          yield* SubscriptionRef.update(summaries, (entries) =>
            entries.filter((entry) => entry.spaceId !== spaceId),
          );
        }),
      ),
    validateRequest: (raw, expectedSpaceId) =>
      Effect.try({
        try: () => {
          const request = SpaceRequestSchema.parse(raw);
          if (request.spaceId !== expectedSpaceId) throw new Error("A command cannot cross Spaces");
          if (request.spaceId !== personalSpaceId && !credentials.has(request.spaceId))
            throw new Error("Unknown Space");
          return request;
        },
        catch: () =>
          new SpaceConnectionError({ message: "A known Space is required for this command" }),
      }),
  });
});

export const live = (input: Parameters<typeof make>[0]) =>
  Layer.effect(SpaceConnectionRegistry, make(input));
