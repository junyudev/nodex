import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ripgrepExecutableName,
  ripgrepRelease,
  ripgrepTarget,
} from "../../../shared/ripgrep-runtime-metadata.mjs";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { searchWorkspaceTextOnHost } from "../../codex-application/WorkspaceTextSearch";
import type { WorkspaceTextSearchEvent } from "../../../shared/workspace-text-search";
import { RipgrepExecutionRuntime, resolveRipgrepExecutable } from "./RipgrepExecutionRuntime";
import { ripgrepSha256 } from "./ripgrep-runtime-artifact.mjs";
import { live, WorkspaceTextSearchPlatform } from "./WorkspaceTextSearchPlatform";

it.effect(
  "runs verified local text search without Codex and rejects changed executable bytes",
  () =>
    Effect.gen(function* () {
      const target = ripgrepTarget(process.platform, process.arch);
      if (!target) return yield* Effect.die("Test host lacks a ripgrep target");
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-ripgrep-runtime-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const config = {
        platform: process.platform,
        arch: process.arch,
        isPackaged: false,
        resourcesPath: path.join(root, "absent-bundle"),
        projectRootPath: root,
      };
      const directory = path.join(root, ".generated/ripgrep-runtime", target);
      const executable = path.join(directory, ripgrepExecutableName(target));
      const workspace = path.join(root, "workspace");
      const binary = yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true });
        await mkdir(workspace);
        const bytes = await readFile(rgPath);
        await writeFile(executable, bytes, { mode: 0o755 });
        await writeFile(path.join(workspace, "file.txt"), "needle\n");
        return bytes;
      });
      const release = {
        ...ripgrepRelease,
        builds: {
          ...ripgrepRelease.builds,
          [target]: {
            ...ripgrepRelease.builds[target],
            binarySize: binary.length,
            binarySha256: ripgrepSha256(binary),
          },
        },
      };
      const resolve = (signal?: AbortSignal) => resolveRipgrepExecutable(config, signal, release);
      const events: WorkspaceTextSearchEvent[] = [];
      yield* Effect.gen(function* () {
        const search = yield* WorkspaceTextSearchPlatform;
        const host = yield* search.open({ kind: "local", roots: [workspace] });
        yield* searchWorkspaceTextOnHost(
          host,
          { requestId: "verified-local", hostId: "local", roots: [workspace], query: "needle" },
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        );
      }).pipe(
        Effect.provide(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer(config),
                Layer.succeed(RipgrepExecutionRuntime, { resolve: Effect.promise(resolve) }),
              ),
            ),
          ),
        ),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "match",
          match: expect.objectContaining({ relativePath: "file.txt" }),
        }),
      );
      binary[binary.length - 1] = binary[binary.length - 1]! ^ 1;
      yield* Effect.promise(async () => {
        await writeFile(executable, binary);
        await expect(resolve()).rejects.toThrow("release lock");
      });
    }),
);
