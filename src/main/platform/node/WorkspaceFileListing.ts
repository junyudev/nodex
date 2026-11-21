import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { FILE_SEARCH_EXCLUDED_SEGMENTS } from "../../../shared/file-search";
import { escapeWorkspaceTextSearchGlob } from "../../../shared/workspace-text-search-rg";
import { runBoundedProcess } from "./BoundedProcess";
import * as NodeServices from "./NodeServices";

export class WorkspaceFileListingError extends Schema.TaggedError<WorkspaceFileListingError>()(
  "WorkspaceFileListingError",
  {
    message: Schema.String,
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
  /** Receives root-relative paths as ripgrep prints them; returning false stops the walk. */
  readonly onPaths: (paths: readonly string[]) => Effect.Effect<boolean>;
}

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
    ) => Effect.Effect<void, WorkspaceFileListingError>;
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

export const listingArguments = (
  request: Pick<WorkspaceFileListingRequest, "directory" | "excludedDirectories">,
): string[] => {
  const exclusions = request.excludedDirectories.map(
    (directory) => `!/${escapeWorkspaceTextSearchGlob(directory)}`,
  );
  const withinBudget =
    exclusions.reduce((total, glob) => total + glob.length + 8, 0) <= EXCLUSION_BUDGET;
  return [
    "--files",
    "--null",
    "--hidden",
    "--follow",
    "--no-config",
    ...SEGMENT_EXCLUSIONS,
    ...(withinBudget ? exclusions.flatMap((glob) => ["--glob", glob]) : []),
    ...(request.directory ? ["--", request.directory] : []),
  ];
};

const isMissing = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

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
      ) {
        const result = yield* runBoundedProcess(spawner, input.environment, {
          executable: input.executable,
          args: listingArguments(request),
          cwd: request.root,
          maxBytes: 32 * 1024 * 1024,
          timeoutMs: 30_000,
          onPaths: request.onPaths,
        }).pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceFileListingError({ message: error.message, cause: error.cause }),
          ),
        );
        // Unreadable entries and symlink loops end with code 2 after listing everything else.
        if (!result.stopped && result.code > 2)
          return yield* new WorkspaceFileListingError({
            message: "Could not list workspace files",
            cause: result.stderr,
          });
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
            new WorkspaceFileListingError({ message: "Could not inspect a workspace path", cause }),
        });
      return WorkspaceFileListing.of({ list, readDirectory, pathKind });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
