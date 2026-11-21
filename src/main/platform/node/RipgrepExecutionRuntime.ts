import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ripgrepExecutableName,
  ripgrepRelease,
  ripgrepTarget,
} from "../../../shared/ripgrep-runtime-metadata.mjs";
import { MainConfig } from "../../app/MainConfig";
import { assertRipgrepBytes } from "./ripgrep-runtime-artifact.mjs";
import { readRuntimeInspectionCommand } from "./RuntimeArtifactVerification";

class RipgrepRuntimeError extends Schema.TaggedError<RipgrepRuntimeError>()("RipgrepRuntimeError", {
  cause: Schema.Defect(),
}) {}

export class RipgrepExecutionRuntime extends Context.Service<
  RipgrepExecutionRuntime,
  { readonly resolve: Effect.Effect<string, RipgrepRuntimeError> }
>()("nodex/main/platform/RipgrepExecutionRuntime") {}

export async function resolveRipgrepExecutable(
  config: Pick<
    MainConfig["Service"],
    "platform" | "arch" | "isPackaged" | "resourcesPath" | "projectRootPath"
  >,
  signal?: AbortSignal,
  release = ripgrepRelease,
): Promise<string> {
  const target = ripgrepTarget(config.platform, config.arch);
  if (!target) throw new Error("Unsupported ripgrep target");
  const directory = config.isPackaged
    ? path.join(config.resourcesPath, "ripgrep-runtime")
    : path.join(config.projectRootPath, ".generated/ripgrep-runtime", target);
  const executable = path.join(directory, ripgrepExecutableName(target));
  const binary = await lstat(executable);
  if (
    !(await lstat(directory)).isDirectory() ||
    !binary.isFile() ||
    (config.platform !== "win32" && (binary.mode & 0o111) === 0) ||
    binary.size > release.builds[target].binarySize + 128 * 1024
  )
    throw new Error("Standalone ripgrep is not a regular executable");
  assertRipgrepBytes(
    await readFile(executable, { signal }),
    target,
    config.isPackaged ? "signed" : "upstream",
    release,
  );
  if (config.isPackaged && config.platform === "darwin")
    await readRuntimeInspectionCommand(
      "/usr/bin/codesign",
      ["--verify", "--strict", executable],
      signal,
    );
  return executable;
}

export const live = Layer.effect(
  RipgrepExecutionRuntime,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const resolve = yield* Effect.cached(
      Effect.tryPromise({
        try: (signal) => resolveRipgrepExecutable(config, signal),
        catch: (cause) => new RipgrepRuntimeError({ cause }),
      }),
    );
    return RipgrepExecutionRuntime.of({ resolve });
  }),
);
