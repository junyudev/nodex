import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  isWorkspaceTextSearchQueryValid,
  parseWorkspaceTextSearchFileMask,
  type WorkspaceTextSearchEvent,
  type WorkspaceTextSearchRequest,
} from "../../shared/workspace-text-search";
import {
  escapeWorkspaceTextSearchGlob,
  parseWorkspaceTextSearchMatch,
  workspaceTextSearchPriorityPaths,
} from "../../shared/workspace-text-search-rg";
import {
  WorkspaceTextSearchPlatform,
  textSearchError,
  type WorkspaceTextSearchError,
  type WorkspaceTextSearchHost,
} from "../platform/node/WorkspaceTextSearchPlatform";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";

type Emit = (event: WorkspaceTextSearchEvent) => Effect.Effect<void>;
export class WorkspaceTextSearch extends Context.Service<
  WorkspaceTextSearch,
  {
    readonly search: (
      request: WorkspaceTextSearchRequest,
      emit: Emit,
    ) => Effect.Effect<void, WorkspaceTextSearchError>;
  }
>()("nodex/main/codex-application/WorkspaceTextSearch") {}

const IGNORED_DIRECTORIES = [
  ".git",
  ".gradle",
  ".idea",
  ".kotlin",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
];
const priorityPartitions = Effect.fnUntraced(function* (
  host: WorkspaceTextSearchHost,
  root: string,
  folders: readonly string[],
) {
  const priorities = workspaceTextSearchPriorityPaths(root, folders.slice(0, 20), host.platform);
  if (priorities.length === 0) return [[]];
  const ancestors = new Set([""]);
  for (const priority of priorities) {
    const segments = priority.split("/");
    for (let index = 1; index < segments.length; index += 1)
      ancestors.add(segments.slice(0, index).join("/"));
  }
  const paths = host.platform === "win32" ? path.win32 : path.posix;
  const rest = yield* Effect.forEach(
    [...ancestors],
    (ancestor) =>
      host
        .readDirectory(paths.resolve(root, ancestor))
        .pipe(
          Effect.map((entries) =>
            entries
              .map((name) => (ancestor ? `${ancestor}/${name}` : name))
              .filter(
                (entry) =>
                  !priorities.some(
                    (priority) => priority === entry || priority.startsWith(`${entry}/`),
                  ),
              ),
          ),
        ),
    { concurrency: 4 },
  ).pipe(
    Effect.map((entries) => entries.flat()),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (
    !rest?.length ||
    [rest, priorities].some(
      (entries) =>
        entries.reduce(
          (total, entry) => total + escapeWorkspaceTextSearchGlob(entry).length + 12,
          0,
        ) > 24_000,
    )
  )
    return [[]];
  return [rest, priorities];
});

/** Stream matching lines in root order, retaining original-root ignore semantics in both priority passes. */
export const searchWorkspaceTextOnHost = Effect.fn("WorkspaceTextSearch.searchOnHost")(function* (
  host: WorkspaceTextSearchHost,
  request: WorkspaceTextSearchRequest,
  emit: Emit,
) {
  if (!isWorkspaceTextSearchQueryValid(request.query))
    return yield* textSearchError(
      "invalid-query",
      "Enter a single-line search of up to 256 characters",
    );
  const mask = parseWorkspaceTextSearchFileMask(request.fileMask ?? "");
  if (!mask) return yield* textSearchError("invalid-file-mask", "Enter a valid file mask");
  const args = [
    "--json",
    "--line-buffered",
    "--no-config",
    "--fixed-strings",
    "--smart-case",
    "--hidden",
    "--no-follow",
    "--no-ignore-dot",
    "--max-filesize",
    "10M",
    ...[...mask.include, ...mask.exclude].flatMap((glob) => ["--glob", glob]),
    ...IGNORED_DIRECTORIES.flatMap((directory) => ["--iglob", `!**/${directory}/**`]),
  ];
  let count = 0;
  for (const root of [...new Set(request.roots)]) {
    const partitions = yield* priorityPartitions(host, root, request.priorityFolders ?? []);
    for (const excluded of partitions) {
      if (count >= 100) break;
      const result = yield* host.search(
        root,
        [
          ...args,
          ...excluded.flatMap((entry) => ["--glob", `!/${escapeWorkspaceTextSearchGlob(entry)}`]),
          "--",
          request.query,
          ".",
        ],
        (line) =>
          Effect.gen(function* () {
            if (count >= 100) return false;
            const match = parseWorkspaceTextSearchMatch(line, root, host.platform);
            if (!match) return true;
            count += 1;
            yield* emit({ requestId: request.requestId, type: "match", match });
            return count < 100;
          }),
      );
      if (count >= 100) break;
      if (result.code !== 0 && result.code !== 1)
        return yield* textSearchError(
          /error parsing glob/iu.test(result.stderr) ? "invalid-file-mask" : "search-failed",
          /error parsing glob/iu.test(result.stderr)
            ? "Enter a valid file mask"
            : "Could not search files",
        );
    }
    if (count >= 100) break;
  }
  yield* emit({ requestId: request.requestId, type: "done", limited: count >= 100 });
});

export const live = Layer.effect(
  WorkspaceTextSearch,
  Effect.gen(function* () {
    const platform = yield* WorkspaceTextSearchPlatform;
    const hosts = yield* ExecutionHostRuntime;
    return WorkspaceTextSearch.of({
      search: Effect.fn("WorkspaceTextSearch.search")(function* (request, emit) {
        // Validate before host activation or executable provisioning.
        if (!isWorkspaceTextSearchQueryValid(request.query))
          return yield* textSearchError(
            "invalid-query",
            "Enter a single-line search of up to 256 characters",
          );
        if (!parseWorkspaceTextSearchFileMask(request.fileMask ?? ""))
          return yield* textSearchError("invalid-file-mask", "Enter a valid file mask");
        if (request.hostId === "local")
          return yield* platform
            .open({ kind: "local", roots: request.roots })
            .pipe(Effect.flatMap((host) => searchWorkspaceTextOnHost(host, request, emit)));
        const settings = yield* hosts.settings.pipe(
          Effect.mapError((cause) =>
            textSearchError("unsupported-host", "Search host is unavailable", cause),
          ),
        );
        const config = settings.sshHosts.find(
          (candidate) => candidate.id === request.hostId && candidate.enabled,
        );
        if (!config)
          return yield* textSearchError("unsupported-host", "Search host is unavailable");
        const host = yield* hosts.get(request.hostId);
        const codexHome = host?.descriptor.codexHome ?? config.codexHome ?? "";
        const target = yield* platform.open({
          kind: "ssh",
          config,
          codexHome,
          roots: request.roots,
        });
        yield* searchWorkspaceTextOnHost(target, request, emit);
      }),
    });
  }),
);
