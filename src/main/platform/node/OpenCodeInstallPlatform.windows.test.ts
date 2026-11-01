import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { make } from "./OpenCodeInstallPlatform";

it.live.runIf(process.platform === "win32")(
  "probes a PATH cmd shim without login-shell discovery",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-opencode 汉字 "))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        writeFile(join(root, "opencode.cmd"), "@echo off\r\necho 2.0.0\r\n"),
      );
      const platform = yield* make(
        {
          homeDirectory: root,
          platform: "win32",
          arch: process.arch,
          environment: { Path: root, PATHEXT: ".EXE;.CMD", SystemRoot: process.env.SystemRoot },
        },
        Effect.die("Windows must not capture a login shell"),
      );
      expect(yield* platform.probe()).toEqual({
        binaryPath: join(root, "opencode.cmd"),
        version: "2.0.0",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
