import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export class ServerEnvironmentIdPersistenceError extends Schema.TaggedError<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write", "initialize"]),
    environmentIdPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "initialize") {
      return `Server environment ID file is missing or empty after initialization at '${this.environmentIdPath}'.`;
    }
    return `Server environment ID ${this.operation} failed at '${this.environmentIdPath}'.`;
  }
}

export class ServerEnvironmentIdentity extends Context.Service<
  ServerEnvironmentIdentity,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  }
>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}

const makeIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "check",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "read",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = Effect.fn("ServerEnvironmentIdentity.persistEnvironmentId")(
    function* (value: string, mode: "create" | "recover") {
      const destinationPath =
        mode === "recover"
          ? `${serverConfig.environmentIdPath}.recovery`
          : serverConfig.environmentIdPath;
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory: serverConfig.stateDir,
        prefix: ".environment-id-",
      });
      yield* fileSystem.writeFileString(tempPath, `${value}\n`);
      // Publish the completed file without replacing an ID created by another process.
      yield* fileSystem.link(tempPath, destinationPath).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
      if (mode === "recover") {
        // Keep the recovery ID so delayed initializers also publish the same winner.
        yield* fileSystem.remove(tempPath);
        yield* fileSystem.copyFile(destinationPath, tempPath);
        yield* fileSystem.rename(tempPath, serverConfig.environmentIdPath);
      }
    },
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new ServerEnvironmentIdPersistenceError({
          operation: "write",
          environmentIdPath: serverConfig.environmentIdPath,
          cause,
        }),
    ),
  );

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* crypto.randomUUIDv4();
    yield* persistEnvironmentId(generated, "create");
    let winner = yield* readPersistedEnvironmentId;
    if (winner === null) {
      yield* persistEnvironmentId(generated, "recover");
      winner = yield* readPersistedEnvironmentId;
    }
    if (winner === null) {
      return yield* new ServerEnvironmentIdPersistenceError({
        operation: "initialize",
        environmentIdPath: serverConfig.environmentIdPath,
      });
    }
    return winner;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  return ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
});

export const layerIdentity = Layer.effect(ServerEnvironmentIdentity, makeIdentity);

