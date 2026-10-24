import {
  ServerProvider,
  AcpRegistryProbeResult,
  ProviderAuthMethod,
  type AcpRegistryProbeAuthMethod,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      binding: Schema.String,
      authenticated: Schema.Boolean,
      discovery: Schema.optionalKey(ServerProvider),
      methods: Schema.optionalKey(Schema.Array(ProviderAuthMethod)),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = Effect.fn("AcpRegistryConnectionState.hash")(function* (value: unknown) {
  const crypto = yield* Crypto.Crypto;
  const json = yield* encodeJson(value).pipe(Effect.orDie);
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(json)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

/** Own the last verified ACP discovery and sign-in confirmation across Runtime restarts. */
export const makeAcpRegistryConnectionState = Effect.fn("makeAcpRegistryConnectionState")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
    readonly settings: AcpRegistrySettings;
    readonly environment: ProviderInstanceEnvironment;
    readonly processEnvironment: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly version?: string | null;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.cacheDir, `acp-state-${yield* hash(input.instanceId)}.json`);
    const resolveExecutable = yield* SpawnExecutableResolution;
    const platform = yield* HostProcess.Platform;
    const executablePath = resolveExecutable(
      input.settings.commandPath,
      platform,
      input.processEnvironment,
    );
    const executable = yield* fs.realPath(executablePath ?? input.settings.commandPath).pipe(
      Effect.flatMap((resolved) =>
        fs.stat(resolved).pipe(
          Effect.map((info) => ({
            path: resolved,
            size: String(info.size),
            modifiedAt: Option.getOrUndefined(info.mtime)?.toISOString(),
          })),
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    // Cosmetic settings and model discovery can rebuild the driver without
    // changing the account. Credential overrides and profile paths cannot.
    const binding = yield* hash({
      source: input.settings.source,
      agentId: input.settings.agentId,
      commandPath: input.settings.commandPath,
      commandArgs: input.settings.commandArgs,
      distribution: input.settings.distribution,
      installationId: input.settings.installationId,
      authMethodId: input.settings.authMethodId,
      nativeStorageScope: input.settings.nativeStorageScope,
      credentialStorageScopes: input.settings.credentialStorageScopes,
      cwd: input.cwd,
      version: input.version,
      executable,
      // Hash the effective environment, including credentials, without storing
      // values. A changed launch recipe must not resurrect another inventory.
      environment: Object.entries(input.processEnvironment).toSorted(([a], [b]) =>
        a.localeCompare(b),
      ),
      overrides: [...input.environment].toSorted((a, b) => a.name.localeCompare(b.name)),
    });
    const saved = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeState),
      Effect.orElseSucceed(() => undefined),
    );
    const state = yield* Ref.make({
      authenticated: saved?.binding === binding && saved.authenticated,
      discovery: saved?.binding === binding ? saved.discovery : undefined,
      methods: saved?.binding === binding ? saved.methods : undefined,
    });
    const lock = yield* Semaphore.make(1);
    const secrets = input.environment
      .filter((entry) => entry.sensitive && entry.value.length > 0)
      .map((entry) => entry.value)
      .toSorted((a, b) => b.length - a.length);
    // These are Nodex identity/time fields or protocol discriminants, not
    // agent-authored text. A short credential must not corrupt their meaning.
    const structuralFields = new Set([
      "instanceId",
      "driver",
      "groupKey",
      "checkedAt",
      "type",
      "kind",
      "status",
      "category",
    ]);
    const redact = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, text: unknown) =>
          typeof text === "string" && !structuralFields.has(key)
            ? secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), text)
            : text,
        ),
      );
    const sanitize = (snapshot: ServerProvider): ServerProvider => {
      const { action: _action, ...auth } = snapshot.auth;
      // Login URLs are ephemeral. Mask any credential echoed in agent metadata
      // before it reaches either the visible snapshot or its on-disk cache.
      return Schema.decodeUnknownSync(ServerProvider)(redact({ ...snapshot, auth }));
    };
    const persist = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      yield* writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({ binding, ...current }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() => Effect.logWarning("Could not save ACP connection state.")),
        Effect.ignore,
      );
    });
    if (saved && saved.binding !== binding) yield* persist;
    return {
      redactProbe: (probe: AcpRegistryProbeResult): AcpRegistryProbeResult =>
        Schema.decodeUnknownSync(AcpRegistryProbeResult)(redact(probe)),
      redactSnapshot: (snapshot: ServerProvider): ServerProvider => {
        const safe = sanitize(snapshot);
        // Authorization actions are intentionally transient and must remain
        // usable in the current flow; persistence always excludes them.
        return snapshot.auth.action
          ? { ...safe, auth: { ...safe.auth, action: snapshot.auth.action } }
          : safe;
      },
      get: Ref.get(state).pipe(Effect.map((value) => value.authenticated)),
      set: (authenticated: boolean) =>
        lock.withPermit(
          Ref.update(state, (current) => ({
            ...current,
            authenticated,
            discovery: undefined,
          })).pipe(Effect.andThen(persist)),
        ),
      getDiscovery: Ref.get(state).pipe(Effect.map((value) => value.discovery)),
      getMethods: Ref.get(state).pipe(Effect.map((value) => value.methods)),
      setDiscovery: (
        snapshot: ServerProvider,
        methods?: ReadonlyArray<AcpRegistryProbeAuthMethod>,
      ) =>
        lock.withPermit(
          Ref.update(state, (current) => ({
            authenticated:
              snapshot.auth.status === "unauthenticated" ? false : current.authenticated,
            discovery: sanitize(snapshot),
            methods:
              methods?.map((method) =>
                Schema.decodeUnknownSync(ProviderAuthMethod)(
                  redact({
                    id: method.id,
                    name: method.name,
                    description: method.description,
                    type: method.type === "env_var" ? ("credentials" as const) : method.type,
                    ...(method.envVarNames ? { envVarNames: method.envVarNames } : {}),
                    ...(method.link ? { link: method.link } : {}),
                  }),
                ),
              ) ?? current.methods,
          })).pipe(Effect.andThen(persist)),
        ),
    };
  },
);
