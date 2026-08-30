import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectCreateInput } from "../shared/types";
import { getLogger } from "./logging/logger";

const DEFAULT_PROJECT_NAME = "New project";
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const logger = getLogger({ subsystem: "default-project-source" });

type CreateProject<Value, Error, Requirements> = (
  input: ProjectCreateInput,
) => Effect.Effect<Value, Error, Requirements>;

interface CreateProjectWithDefaultSourceOptions<Value, Error, Requirements> {
  projectsDirectory: string;
  createProject: CreateProject<Value, Error, Requirements>;
  createDirectory?: (path: string) => Effect.Effect<void, Error, Requirements>;
  pathExists?: (path: string) => Effect.Effect<boolean, Error, Requirements>;
  initializeRepository?: (path: string) => Effect.Effect<void, Error, Requirements>;
}

export class DefaultProjectSourceError extends Schema.TaggedError<DefaultProjectSourceError>()(
  "DefaultProjectSourceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A, Error, Requirements>(
  operation: string,
  effect: Effect.Effect<A, Error, Requirements>,
): Effect.Effect<A, DefaultProjectSourceError, Requirements> =>
  effect.pipe(Effect.mapError((cause) => new DefaultProjectSourceError({ operation, cause })));

function runGit(args: string[], cwd: string): Effect.Effect<void, Error> {
  return Effect.callback((resume, signal) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        signal,
        timeout: 5_000,
        windowsHide: true,
      },
      (error) => {
        if (error) {
          resume(Effect.fail(error));
          return;
        }
        resume(Effect.void);
      },
    );
  });
}

const defaultPathExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

const defaultCreateDirectory = (path: string): Effect.Effect<void, unknown> =>
  Effect.tryPromise(() => mkdir(path, { recursive: true })).pipe(Effect.asVoid);

const defaultInitializeRepository = (path: string): Effect.Effect<void, unknown> =>
  runGit(["--version"], path).pipe(Effect.andThen(runGit(["init"], path)));

export function sanitizeDefaultProjectDirectoryName(name: string): string {
  const sanitized = Array.from(basename(name).trim(), (character) => {
    const isControlCharacter = character.charCodeAt(0) < 32;
    return isControlCharacter || '<>:"/\\|?*'.includes(character) ? "_" : character;
  })
    .join("")
    .replace(/[ .]+$/g, "");

  if (!sanitized) return DEFAULT_PROJECT_NAME;
  if (WINDOWS_RESERVED_FILE_NAME.test(sanitized)) return `_${sanitized}`;
  return sanitized;
}

export const findAvailableDefaultProjectSource = <Error, Requirements>(
  projectsDirectory: string,
  directoryName: string,
  pathExists: (path: string) => Effect.Effect<boolean, Error, Requirements> = defaultPathExists,
): Effect.Effect<string, DefaultProjectSourceError, Requirements> =>
  Effect.gen(function* () {
    let suffix: number | null = null;
    while (true) {
      const candidateName = suffix === null ? directoryName : `${directoryName} ${suffix}`;
      const candidate = join(projectsDirectory, candidateName);
      if (!(yield* attempt("path-exists", pathExists(candidate)))) return candidate;
      suffix = suffix === null ? 2 : suffix + 1;
    }
  });

export const createProjectWithDefaultSource = <Value, Error, Requirements>(
  input: ProjectCreateInput,
  options: CreateProjectWithDefaultSourceOptions<Value, Error, Requirements>,
): Effect.Effect<Value, DefaultProjectSourceError, Requirements> =>
  Effect.gen(function* () {
    if ((input.sources?.length ?? 0) > 0) {
      return yield* attempt("create-project", options.createProject(input));
    }

    const directoryName = sanitizeDefaultProjectDirectoryName(input.name ?? "");
    const source = yield* findAvailableDefaultProjectSource(
      options.projectsDirectory,
      directoryName,
      options.pathExists,
    );
    yield* attempt("create-directory", (options.createDirectory ?? defaultCreateDirectory)(source));

    yield* attempt(
      "initialize-repository",
      (options.initializeRepository ?? defaultInitializeRepository)(source),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          logger.warn("Failed to initialize default Project source as a Git repository", {
            error,
            source,
          }),
        ),
      ),
    );

    return yield* attempt(
      "create-project",
      options.createProject({
        ...input,
        sources: [source],
      }),
    );
  });
