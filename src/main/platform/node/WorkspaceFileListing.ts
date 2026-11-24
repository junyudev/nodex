import { lstat, opendir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import {
  FILE_SEARCH_EXCLUDED_SEGMENTS,
  type FileSearchIncompleteReason,
} from "../../../shared/file-search";
import { escapeWorkspaceTextSearchGlob } from "../../../shared/workspace-text-search-rg";
import { runBoundedProcess } from "./BoundedProcess";
import * as NodeServices from "./NodeServices";

export class WorkspaceFileListingError extends Schema.TaggedError<WorkspaceFileListingError>()(
  "WorkspaceFileListingError",
  {
    message: Schema.String,
    reason: Schema.Literals(["missing", "unreadable", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface WorkspaceFileListingRequest {
  readonly root: string;
  /** Root-relative, `/`-separated directory to walk; empty walks the root. */
  readonly directory: string;
  /**
   * Root-relative directories the walk may skip. This only saves work: when the exclusions
   * do not fit one command line, the walk includes them.
   */
  readonly excludedDirectories: readonly string[];
  /** In-root directory links found by an earlier walk. */
  readonly knownAliases?: readonly string[];
  /** Receives filtered root-relative paths. Restarts can repeat paths; false stops the walk. */
  readonly onPaths: (paths: readonly string[]) => Effect.Effect<boolean>;
}

export type WorkspaceFileListingResult = { readonly aliases: readonly string[] } & (
  | { readonly kind: "completed" | "stopped" }
  | { readonly kind: "failed" | "cut-short"; readonly error: WorkspaceFileListingError }
);

export type WorkspacePathKind = "file" | "directory" | "other";

export interface WorkspaceDirectoryChild {
  readonly name: string;
  readonly kind: WorkspacePathKind;
}

/** Lists searchable workspace files with Nodex's pinned ripgrep and its ignore semantics. */
export class WorkspaceFileListing extends Context.Service<
  WorkspaceFileListing,
  {
    readonly list: (
      request: WorkspaceFileListingRequest,
    ) => Effect.Effect<WorkspaceFileListingResult>;
    /** Null means the directory no longer exists. Symbolic links report `other`. */
    readonly readDirectory: (
      directory: string,
    ) => Effect.Effect<readonly WorkspaceDirectoryChild[] | null, WorkspaceFileListingError>;
    /** What a path resolves to after following links, or null when nothing is there. */
    readonly pathKind: (
      path: string,
    ) => Effect.Effect<WorkspacePathKind | null, WorkspaceFileListingError>;
  }
>()("nodex/main/platform/WorkspaceFileListing") {}

// Windows command lines are limited to 32,767 characters.
const EXCLUSION_BUDGET = 24_000;

const SEGMENT_EXCLUSIONS = FILE_SEARCH_EXCLUDED_SEGMENTS.flatMap((segment) => [
  "--glob",
  `!${segment}`,
]);

const DIRECTORY_CHECK_CONCURRENCY = 16;
const MAX_ALIAS_RESTARTS = 4;
const LISTING_TIMEOUT_MS = 30_000;
const LISTING_MAX_BYTES = 32 * 1024 * 1024;

const exclusionGlob = (directory: string) => `!/${escapeWorkspaceTextSearchGlob(directory)}`;
const exclusionCost = (glob: string) => glob.length + 8;

const aliasGlobs = (aliases: ReadonlySet<string>): string[] => {
  const globs: string[] = [];
  let budget = EXCLUSION_BUDGET;
  for (const alias of aliases) {
    const glob = exclusionGlob(alias);
    const cost = exclusionCost(glob);
    if (cost > budget) continue;
    globs.push(glob);
    budget -= cost;
  }
  return globs;
};

const listingArguments = (request: WorkspaceFileListingRequest, aliases: readonly string[]) => {
  const exclusions = request.excludedDirectories.map(exclusionGlob);
  const withinBudget =
    [...aliases, ...exclusions].reduce((total, glob) => total + exclusionCost(glob), 0) <=
    EXCLUSION_BUDGET;
  return [
    "--files",
    "--null",
    "--hidden",
    "--follow",
    "--no-config",
    ...SEGMENT_EXCLUSIONS,
    ...aliases.flatMap((glob) => ["--glob", glob]),
    ...(withinBudget ? exclusions.flatMap((glob) => ["--glob", glob]) : []),
    ...(request.directory ? ["--", request.directory] : []),
  ];
};

const isMissing = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const directoryErrorReason = (cause: unknown): Exclude<FileSearchIncompleteReason, "too-large"> => {
  if (isMissing(cause)) return "missing";
  if (Predicate.hasProperty(cause, "code") && (cause.code === "EACCES" || cause.code === "EPERM"))
    return "unreadable";
  return "unavailable";
};

const inspectDirectory = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await realpath(directory);
      // Opening the folder checks traversal access, including macOS privacy restrictions.
      const handle = await opendir(resolved);
      await handle.close();
      return resolved;
    },
    catch: (cause) =>
      new WorkspaceFileListingError({
        message: "Could not open a workspace folder",
        reason: directoryErrorReason(cause),
        cause,
      }),
  });

const parentDirectory = (relative: string) =>
  relative.slice(0, Math.max(0, relative.lastIndexOf("/")));
const listedParent = (raw: string) =>
  parentDirectory(process.platform === "win32" ? raw.replaceAll("\\", "/") : raw);

const insideRoot = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function makeDirectoryFilter(root: string, realRoot: string, aliases: Set<string>) {
  const checked = new Map<string, Promise<boolean>>();
  const check = (directory: string): Promise<boolean> => {
    if (!directory) return Promise.resolve(true);
    const cached = checked.get(directory);
    if (cached) return cached;
    const pending = inspect(directory);
    checked.set(directory, pending);
    return pending;
  };
  const inspect = async (directory: string): Promise<boolean> => {
    if (!(await check(parentDirectory(directory)))) return false;
    const absolute = path.join(root, directory);
    try {
      const entry = await lstat(absolute);
      if (!entry.isSymbolicLink()) return entry.isDirectory();
      const target = await realpath(absolute);
      if (!(await stat(target)).isDirectory()) return false;
      if (!insideRoot(realRoot, target)) return true;
      aliases.add(directory);
      return false;
    } catch {
      // A directory may disappear or become inaccessible while ripgrep is walking it.
      return false;
    }
  };
  return (directory: string) => Effect.promise(() => check(directory));
}

export const layer = (input: {
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
}): Layer.Layer<WorkspaceFileListing> =>
  Layer.effect(
    WorkspaceFileListing,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const list = Effect.fn("WorkspaceFileListing.list")(function* (
        request: WorkspaceFileListingRequest,
      ): Effect.fn.Return<WorkspaceFileListingResult> {
        const opened = yield* Effect.result(inspectDirectory(request.root));
        if (opened._tag === "Failure")
          return { kind: "failed", aliases: request.knownAliases ?? [], error: opened.failure };
        const aliases = new Set<string>();
        const checkDirectory = makeDirectoryFilter(request.root, opened.success, aliases);
        // Recheck earlier aliases so replacing a link does not leave its new contents hidden.
        yield* Effect.forEach(request.knownAliases ?? [], checkDirectory, {
          concurrency: DIRECTORY_CHECK_CONCURRENCY,
          discard: true,
        });
        if (request.directory) {
          const target = yield* Effect.result(
            inspectDirectory(path.join(request.root, request.directory)),
          );
          if (target._tag === "Failure")
            return { kind: "failed", aliases: [...aliases], error: target.failure };
          if (!(yield* checkDirectory(request.directory)))
            return { kind: "completed", aliases: [...aliases] };
        }

        const deadline = (yield* Clock.currentTimeMillis) + LISTING_TIMEOUT_MS;
        let delivered = false;
        let stopped = false;
        for (let attempt = 0; ; attempt++) {
          const globs = aliasGlobs(aliases);
          const aliasCount = aliases.size;
          let restart = false;
          const result = yield* runBoundedProcess(spawner, input.environment, {
            executable: input.executable,
            args: listingArguments(request, globs),
            cwd: request.root,
            maxBytes: LISTING_MAX_BYTES,
            timeoutMs: Math.max(1, deadline - (yield* Clock.currentTimeMillis)),
            onPaths: Effect.fnUntraced(function* (paths: readonly string[]) {
              const parents = paths.map(listedParent);
              const rejected = new Set(
                yield* Effect.forEach(
                  new Set(parents),
                  Effect.fnUntraced(function* (directory: string) {
                    return (yield* checkDirectory(directory)) ? null : directory;
                  }),
                  { concurrency: DIRECTORY_CHECK_CONCURRENCY },
                ),
              );
              const files = paths.filter((_, index) => !rejected.has(parents[index]!));
              if (files.length > 0) {
                delivered = true;
                stopped = !(yield* request.onPaths(files));
              }
              restart =
                !stopped &&
                attempt < MAX_ALIAS_RESTARTS &&
                aliases.size > aliasCount &&
                aliasGlobs(aliases).length > globs.length;
              return !stopped && !restart;
            }),
          }).pipe(Effect.result);
          if (stopped) return { kind: "stopped", aliases: [...aliases] };
          if (restart && (yield* Clock.currentTimeMillis) < deadline) continue;
          if (!delivered && (result._tag === "Failure" || result.success.code >= 2)) {
            // The folder may have become inaccessible between opening it and starting ripgrep.
            const checked = yield* Effect.result(inspectDirectory(request.root));
            if (checked._tag === "Failure")
              return { kind: "failed", aliases: [...aliases], error: checked.failure };
          }
          // Unreadable entries and link loops end with code 2 after listing everything else.
          if (!restart && result._tag === "Success" && result.success.code <= 2)
            return { kind: "completed", aliases: [...aliases] };
          return {
            kind: delivered ? "cut-short" : "failed",
            aliases: [...aliases],
            error: new WorkspaceFileListingError({
              message: "Could not list all workspace files",
              reason: "unavailable",
              cause: result._tag === "Failure" ? result.failure : result.success.stderr,
            }),
          };
        }
      });
      const readDirectory = (directory: string) =>
        Effect.tryPromise({
          try: async (): Promise<readonly WorkspaceDirectoryChild[] | null> => {
            try {
              const entries = await readdir(path.resolve(directory), { withFileTypes: true });
              return entries.map((entry) => ({
                name: entry.name,
                kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
              }));
            } catch (cause) {
              if (isMissing(cause)) return null;
              throw cause;
            }
          },
          catch: (cause) =>
            new WorkspaceFileListingError({
              message: "Could not inspect a workspace folder",
              reason: directoryErrorReason(cause),
              cause,
            }),
        });
      const pathKind = (target: string) =>
        Effect.tryPromise({
          try: async (): Promise<WorkspacePathKind | null> => {
            try {
              const entry = await stat(target);
              return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
            } catch (cause) {
              if (isMissing(cause)) return null;
              if (Predicate.hasProperty(cause, "code") && cause.code === "ELOOP") return "other";
              throw cause;
            }
          },
          catch: (cause) =>
            new WorkspaceFileListingError({
              message: "Could not inspect a workspace path",
              reason: directoryErrorReason(cause),
              cause,
            }),
        });
      return WorkspaceFileListing.of({ list, readDirectory, pathKind });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
