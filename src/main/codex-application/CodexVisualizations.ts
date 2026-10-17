import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodexVisualizationReadInput, CodexVisualizationReadResult } from "../../shared/types";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { areStructurallyEqual } from "../../shared/structural-equality";
import { resolveCodexThreadVisualizationDirectory } from "../codex/codex-dynamic-first-turn-context";
import {
  CodexGateway,
  CodexThreadHostResolver,
  codexGatewayGenerationFence,
} from "../codex-runtime/CodexGateway";
import { MainConfig } from "../app/MainConfig";
import { NodeVisualizationFiles } from "../platform/node/NodeVisualizationFiles";
import { CodexConversationContext } from "./CodexConversationContext";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export const CODEX_VISUALIZATION_MAX_BYTES = 5_000_000;
const readSchema = Schema.Struct({
  hostId: Schema.Trimmed.check(Schema.isMinLength(1)),
  sourceThreadId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.%:-]+$/)),
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  turnId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});

export class CodexVisualizationError extends Schema.TaggedError<CodexVisualizationError>()(
  "CodexVisualizationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class CodexVisualizations extends Context.Service<
  CodexVisualizations,
  {
    readonly read: (
      input: CodexVisualizationReadInput,
    ) => Effect.Effect<CodexVisualizationReadResult, CodexVisualizationError>;
  }
>()("nodex/main/codex-application/CodexVisualizations") {}

type Root = { readonly directory: string; readonly boundary: string };
const contains = (directory: string, target: string, api: typeof path): boolean => {
  const relative = api.relative(directory, target);
  return relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
};
const invalid = (operation: string) =>
  new CodexVisualizationError({
    operation,
    cause: new Error("Invalid visualization read request"),
  });
const missing = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  if (error instanceof Error && error.message === "No such file or directory (os error 2)")
    return true;
  return "cause" in error && error.cause !== error ? missing(error.cause) : false;
};

/** HTML reads derive their execution roots from the source Thread, never from the guest document. */
export const live: Layer.Layer<
  CodexVisualizations,
  never,
  | CodexConversationContext
  | ConversationEntityMap
  | CodexThreadHostResolver
  | CodexGateway
  | ExecutionHostRuntime
  | NodeVisualizationFiles
  | MainConfig
> = Layer.effect(
  CodexVisualizations,
  Effect.gen(function* () {
    const context = yield* CodexConversationContext;
    const conversations = yield* ConversationEntityMap;
    const hosts = yield* ExecutionHostRuntime;
    const resolver = yield* CodexThreadHostResolver;
    const gateway = yield* CodexGateway;
    const files = yield* NodeVisualizationFiles;
    const config = yield* MainConfig;
    const agents = yield* Effect.serviceOption(AgentRuntimeApplication);
    const readPermissions = (input: CodexVisualizationReadInput) => {
      const canonical = conversations.current(input.sourceThreadId)?.readCanonicalState();
      const params = input.turnId
        ? (canonical?.turnHistory?.history.entitiesByKey
            ? Object.values(canonical.turnHistory.history.entitiesByKey)
            : canonical?.turns
          )?.find((turn) => turn.turnId === input.turnId)?.params
        : undefined;
      return {
        policy:
          params?.sandboxPolicy ??
          canonical?.currentPermissions?.sandboxPolicy ??
          canonical?.hydrationContext?.latestThreadSettings?.sandboxPolicy,
        roots:
          params?.runtimeWorkspaceRoots ?? canonical?.currentPermissions?.runtimeWorkspaceRoots,
        cwd: params?.cwd ?? null,
      };
    };

    const read = Effect.fn("CodexVisualizations.read")(
      function* (raw: CodexVisualizationReadInput) {
        const input = yield* Schema.decodeUnknownEffect(readSchema)(raw).pipe(
          Effect.mapError((cause) => new CodexVisualizationError({ operation: "decode", cause })),
        );
        // An Agent chat keeps its replies' files in its Codex thread's folder, on this device.
        const agentSource =
          resolveCodexThreadVisualizationDirectory("/", input.sourceThreadId, path.posix) ===
            null && Option.isSome(agents)
            ? yield* agents.value.visualizationSource(input.sourceThreadId)
            : null;
        const readAgentSource = () =>
          Option.isSome(agents)
            ? agents.value.visualizationSource(input.sourceThreadId)
            : Effect.succeed(null);
        const dayDirectory = resolveCodexThreadVisualizationDirectory(
          "/",
          agentSource?.nativeThreadId ?? input.sourceThreadId,
          path.posix,
        );
        if (!dayDirectory) return yield* invalid("thread-identity");
        if (
          agentSource
            ? input.hostId !== "local"
            : (yield* resolver.resolve(input.sourceThreadId)) !== input.hostId
        )
          return yield* invalid("thread-host");
        const host = yield* hosts.resolve(input.hostId);
        const api =
          host.descriptor.kind === "ssh"
            ? path.posix
            : config.platform === "win32"
              ? path.win32
              : path.posix;
        const name = api.basename(input.file);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(name)) return yield* invalid("file-name");
        const absolute = api.isAbsolute(input.file);
        if (
          absolute
            ? api.normalize(input.file) !== input.file.replaceAll("/", api.sep)
            : input.file !== name
        )
          return yield* invalid("file-path");
        const local = host.descriptor.kind === "local";
        const connection = local ? null : yield* gateway.connection(input.hostId);
        if (connection && connection.kind !== "ready") return yield* invalid("host-lifetime");
        const fence = connection ? codexGatewayGenerationFence(connection) : null;
        const owner = agentSource ? null : conversations.current(input.sourceThreadId);
        const permission = agentSource
          ? { policy: undefined, roots: undefined, cwd: agentSource.cwd }
          : readPermissions(input);
        const workspace =
          absolute && !agentSource ? yield* context.read(input.sourceThreadId) : null;
        const day = path.posix.relative("/", dayDirectory);
        const bases: Root[] = [
          ...new Set([host.descriptor.codexHome, host.descriptor.managedRoot]),
        ].map((root) => ({ directory: api.join(root, ...day.split("/")), boundary: root }));
        const policy = permission.policy?.type === "workspaceWrite" ? permission.policy : null;
        const temporary =
          absolute && host.descriptor.kind === "local" && policy?.excludeTmpdirEnvVar === false
            ? yield* files.temporaryRoots
            : [];
        const roots: Root[] = absolute
          ? [
              ...bases,
              ...[
                ...(workspace?.cwd ? [workspace.cwd] : []),
                ...(permission.cwd ? [permission.cwd] : []),
                ...(workspace?.writableRoots ?? []),
                ...(permission.roots ?? []),
                ...(policy?.writableRoots ?? []),
                ...(policy?.excludeSlashTmp === false && api.sep === "/"
                  ? ["/tmp", "/private/tmp"]
                  : []),
                ...temporary,
              ].map((root) => ({ directory: root, boundary: root })),
            ]
          : bases;
        const canonicalRoot = (root: string) =>
          local ? files.canonicalRoot(root) : Effect.succeed(api.normalize(root));
        const candidates: Array<{ path: string; boundary: string }> = [];
        const admissibleRoots = roots.filter((root) => api.isAbsolute(root.directory));
        if (absolute)
          admissibleRoots.sort((left, right) => right.directory.length - left.directory.length);
        for (const root of admissibleRoots) {
          const boundary = yield* canonicalRoot(root.boundary);
          if (!boundary) continue;
          const directory = api.join(boundary, api.relative(root.boundary, root.directory));
          if (!absolute) {
            candidates.push({ path: api.join(directory, name), boundary });
            continue;
          }
          if (contains(root.directory, input.file, api)) {
            candidates.push({
              path: api.join(boundary, api.relative(root.boundary, input.file)),
              boundary,
            });
            break;
          }
          if (!contains(directory, input.file, api)) continue;
          candidates.push({ path: input.file, boundary });
          break;
        }
        if (candidates.length === 0) return yield* invalid("file-root");
        const readRemote = Effect.fn("CodexVisualizations.readRemote")(function* (candidate: {
          path: string;
          boundary: string;
        }) {
          if (!fence) return yield* invalid("host-lifetime");
          const parents: string[] = [];
          let parent = api.dirname(candidate.path);
          for (;;) {
            if (parents.length >= 64) return yield* invalid("file-depth");
            parents.push(parent);
            if (parent === candidate.boundary) break;
            const next = api.dirname(parent);
            if (next === parent) return yield* invalid("file-parent");
            parent = next;
          }
          const [file, ...directories] = yield* Effect.all(
            [candidate.path, ...parents].map((target) =>
              gateway.requestOnHost(input.hostId, "fs/getMetadata", { path: target }, fence),
            ),
            { concurrency: 4 },
          );
          if (
            !file?.isFile ||
            file.isSymlink ||
            directories.some((directory) => !directory.isDirectory || directory.isSymlink)
          )
            return yield* invalid("file-kind");
          const response = yield* gateway.requestOnHost(
            input.hostId,
            "fs/readFile",
            { path: candidate.path },
            fence,
          );
          const contents = Buffer.from(response.dataBase64, "base64");
          return contents.byteLength <= CODEX_VISUALIZATION_MAX_BYTES
            ? ({ kind: "read", contents: contents.toString("utf8") } as const)
            : ({ kind: "too-large" } as const);
        });
        for (const candidate of candidates) {
          const result = yield* local
            ? files.read({ ...candidate, maxBytes: CODEX_VISUALIZATION_MAX_BYTES })
            : readRemote(candidate).pipe(
                Effect.catch((error) =>
                  missing(error)
                    ? Effect.succeed({ kind: "missing" } as const)
                    : Effect.fail(error),
                ),
              );
          if (result.kind === "missing") continue;
          if (result.kind === "too-large") return { contents: null, path: null };
          const nextConnection = connection ? yield* gateway.connection(input.hostId) : null;
          const sourceCurrent = agentSource
            ? areStructurallyEqual(agentSource, yield* readAgentSource())
            : conversations.current(input.sourceThreadId) === owner &&
              areStructurallyEqual(permission, readPermissions(input)) &&
              (yield* resolver.resolve(input.sourceThreadId)) === input.hostId;
          if (
            (connection &&
              (nextConnection?.kind !== "ready" ||
                nextConnection.generation !== connection.generation)) ||
            !sourceCurrent ||
            !areStructurallyEqual(host.descriptor, (yield* hosts.resolve(input.hostId)).descriptor)
          )
            return yield* invalid("read-lifetime");
          if (
            workspace &&
            !areStructurallyEqual(workspace, yield* context.read(input.sourceThreadId))
          )
            return yield* invalid("workspace-lifetime");
          return { contents: result.contents, path: candidate.path };
        }
        return { contents: null, path: null };
      },
      Effect.mapError((cause) =>
        cause instanceof CodexVisualizationError
          ? cause
          : new CodexVisualizationError({ operation: "read", cause }),
      ),
    );
    return CodexVisualizations.of({ read });
  }),
);
