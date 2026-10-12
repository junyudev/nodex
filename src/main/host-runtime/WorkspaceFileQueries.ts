import { stat } from "node:fs/promises";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  WorkspaceFileBinaryReadResult,
  WorkspaceFileMetadata,
  WorkspaceFileMetadataInput,
  WorkspaceFileReadResult,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
  WorkspacePathsExistInput,
  WorkspacePathsExistResult,
} from "../../shared/types";
import type { FsGetMetadataResponse } from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  describeWorkspaceFileBytes,
  readWorkspaceFile,
  readWorkspaceFileBinary,
  readWorkspaceFileMetadata,
  toWorkspaceFileIpcError,
  WorkspaceFileUserError,
} from "../workspace-files-service";

export class WorkspaceFileQueryError extends Schema.TaggedError<WorkspaceFileQueryError>()(
  "WorkspaceFileQueryError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type QueryError = WorkspaceFileUserError | WorkspaceFileQueryError;
type RemoteReadError = QueryError | CodexRuntimeError;
type Query<A> = Effect.Effect<A, QueryError>;

export class WorkspaceFileQueries extends Context.Service<
  WorkspaceFileQueries,
  {
    readonly pathsExist: (input: WorkspacePathsExistInput) => Query<WorkspacePathsExistResult>;
    readonly metadata: (input: WorkspaceFileMetadataInput) => Query<WorkspaceFileMetadata>;
    readonly text: (input: WorkspaceFileTextReadInput) => Query<WorkspaceFileReadResult>;
    readonly binary: (input: WorkspaceFileRequest) => Query<WorkspaceFileBinaryReadResult>;
  }
>()("nodex/main/host-runtime/WorkspaceFileQueries") {}

const MAX_REMOTE_FILE_BYTES = 100 * 1024 * 1024;
const mapError = (operation: string, cause: unknown): QueryError => {
  const mapped = toWorkspaceFileIpcError(cause);
  return mapped instanceof WorkspaceFileUserError
    ? mapped
    : new WorkspaceFileQueryError({ operation, cause: mapped });
};
const local = <A>(operation: string, task: () => Promise<A>): Query<A> =>
  Effect.tryPromise({ try: task, catch: (cause) => mapError(operation, cause) });
const invalid = (message: string) => new WorkspaceFileUserError("invalid_path", message);

interface RemoteFileReader {
  readonly metadata: (filePath: string) => Effect.Effect<FsGetMetadataResponse, RemoteReadError>;
  readonly bytes: (filePath: string, maxBytes: number) => Effect.Effect<Buffer, RemoteReadError>;
}

/** Read-only host queries pin their native endpoint; remote paths never reach local Node IO. */
export const live: Layer.Layer<
  WorkspaceFileQueries,
  never,
  CodexGateway | CodexAppServerCapabilities
> = Layer.effect(
  WorkspaceFileQueries,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const capabilities = yield* CodexAppServerCapabilities;
    const remote = <A>(
      operation: string,
      hostId: string,
      task: (reader: RemoteFileReader) => Effect.Effect<A, RemoteReadError>,
    ): Query<A> =>
      Effect.gen(function* () {
        const connection = yield* gateway.connection(hostId);
        if (connection.kind !== "ready")
          return yield* Effect.fail(invalid("File host is unavailable"));
        const capability = yield* capabilities.forHost(hostId);
        if (!capability.sourceEpoch || connection.generation !== capability.generation)
          return yield* Effect.fail(invalid("File host changed before reading"));
        const fence = codexGatewayGenerationFence(capability);
        const validatePath = (value: string) =>
          Effect.try({
            try: () => {
              if (
                value.includes("\0") ||
                (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
              )
                throw invalid("Remote file path must be absolute");
              return value;
            },
            catch: (cause) => mapError(operation, cause),
          });
        const metadata = (filePath: string) =>
          validatePath(filePath).pipe(
            Effect.flatMap((target) =>
              gateway.requestOnHost(hostId, "fs/getMetadata", { path: target }, fence),
            ),
          );
        const bytes = (filePath: string, maxBytes: number) =>
          Effect.gen(function* () {
            const info = yield* metadata(filePath);
            if (!info.isFile) return yield* Effect.fail(invalid("Remote path is not a file"));
            const response = yield* gateway.requestOnHost(
              hostId,
              "fs/readFile",
              { path: filePath },
              fence,
            );
            const encoded = response.dataBase64;
            if (encoded.length > Math.ceil(maxBytes / 3) * 4)
              return yield* Effect.fail(
                new WorkspaceFileUserError("too_large", "Remote file exceeds the preview limit"),
              );
            const contents = Buffer.from(encoded, "base64");
            if (contents.toString("base64") !== encoded)
              return yield* Effect.fail(invalid("Invalid remote file contents"));
            if (contents.byteLength > maxBytes)
              return yield* Effect.fail(
                new WorkspaceFileUserError("too_large", "Remote file exceeds the preview limit"),
              );
            return contents;
          });
        const result = yield* task({ metadata, bytes });
        const nextConnection = yield* gateway.connection(hostId);
        if (
          nextConnection.kind !== "ready" ||
          nextConnection.generation !== capability.generation ||
          !(yield* capabilities.isCurrent(capability))
        )
          return yield* Effect.fail(invalid("File host changed while reading"));
        return result;
      }).pipe(Effect.mapError((cause) => mapError(operation, cause)));

    return WorkspaceFileQueries.of({
      pathsExist: (input) => {
        const hostId = input.hostId ?? "local";
        if (hostId === "local") {
          return Effect.all(
            input.paths.map((filePath) =>
              local("path-exists", async () =>
                path.isAbsolute(filePath) && (await stat(filePath).catch(() => null))
                  ? filePath
                  : null,
              ),
            ),
            { concurrency: 4 },
          ).pipe(
            Effect.map((paths) => ({
              existingPaths: paths.filter((value): value is string => value !== null),
            })),
          );
        }
        return remote("paths-exist", hostId, (reader) =>
          Effect.all(
            input.paths.map((filePath) =>
              reader.metadata(filePath).pipe(
                Effect.as(filePath),
                Effect.catch(() => Effect.succeed(null)),
              ),
            ),
            { concurrency: 4 },
          ).pipe(
            Effect.map((paths) => ({
              existingPaths: paths.filter((value): value is string => value !== null),
            })),
          ),
        );
      },
      metadata: (input) => {
        const hostId = input.hostId ?? "local";
        if (hostId === "local") return local("metadata", () => readWorkspaceFileMetadata(input));
        return remote("metadata", hostId, (reader) =>
          Effect.gen(function* () {
            const info = yield* reader.metadata(input.path);
            const result: WorkspaceFileMetadata = {
              isFile: info.isFile,
              createdAtMs: info.createdAtMs > 0 ? info.createdAtMs : null,
              mtimeMs: info.modifiedAtMs > 0 ? info.modifiedAtMs : null,
              sizeBytes: null,
            };
            if (!info.isFile || input.contentSampleByteLimit === undefined) return result;
            const contents = yield* reader
              .bytes(input.path, input.contentSampleMaxFileBytes ?? MAX_REMOTE_FILE_BYTES)
              .pipe(
                Effect.catch((cause) =>
                  cause instanceof WorkspaceFileUserError && cause.code === "too_large"
                    ? Effect.succeed(null)
                    : Effect.fail(cause),
                ),
              );
            if (contents === null) return result;
            return {
              ...result,
              sizeBytes: contents.byteLength,
              ...describeWorkspaceFileBytes(contents.subarray(0, input.contentSampleByteLimit)),
            };
          }),
        );
      },
      text: (input) => {
        const hostId = input.hostId ?? "local";
        if (hostId === "local") return local("text", () => readWorkspaceFile(input));
        return remote("text", hostId, (reader) =>
          reader
            .bytes(input.path, input.maxBytes)
            .pipe(Effect.map((contents) => ({ contents: contents.toString("utf8") }))),
        );
      },
      binary: (input) => {
        const hostId = input.hostId ?? "local";
        if (hostId === "local") return local("binary", () => readWorkspaceFileBinary(input));
        return remote("binary", hostId, (reader) =>
          reader.bytes(input.path, MAX_REMOTE_FILE_BYTES).pipe(
            Effect.map((contents) => ({
              contentsBase64: contents.toString("base64"),
              ...describeWorkspaceFileBytes(contents),
            })),
          ),
        );
      },
    });
  }),
);
