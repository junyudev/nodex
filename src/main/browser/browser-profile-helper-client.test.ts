import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";

import {
  BrowserProfileHelperPlatform,
  resolveBrowserProfileHelperExecutable,
} from "./browser-profile-helper-client";
import * as BrowserProfileHelperNode from "../platform/node/BrowserProfileHelperNode";

describe("resolveBrowserProfileHelperExecutable", () => {
  test("resolves explicit, packaged, and development executables", () => {
    expect(
      resolveBrowserProfileHelperExecutable({
        environment: {
          NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "/opt/nodex/bin/profile-helper",
        },
        isPackaged: false,
        repositoryRoot: "/work/nodex",
        resourcesPath: "/electron/resources",
      }),
    ).toBe(path.normalize("/opt/nodex/bin/profile-helper"));
    expect(
      resolveBrowserProfileHelperExecutable({
        environment: {},
        isPackaged: true,
        repositoryRoot: "/work/nodex",
        resourcesPath: "/Applications/Nodex.app/Contents/Resources",
      }),
    ).toBe(
      path.join(
        "/Applications/Nodex.app/Contents/Resources",
        "bin",
        "nodex-browser-profile-helper",
      ),
    );
    expect(
      resolveBrowserProfileHelperExecutable({
        environment: {},
        isPackaged: false,
        repositoryRoot: "/work/nodex",
        resourcesPath: "/electron/resources",
      }),
    ).toBe(path.join("/work/nodex", "target/debug/nodex-browser-profile-helper"));
  });

  test("rejects a relative executable override", () => {
    expect(() =>
      resolveBrowserProfileHelperExecutable({
        environment: {
          NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "target/release/profile-helper",
        },
        isPackaged: false,
        repositoryRoot: "/work/nodex",
        resourcesPath: "/electron/resources",
      }),
    ).toThrow("NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE must be absolute");
  });
});

it.layer(BrowserProfileHelperNode.nodeLive)("Browser Profile helper runtime", (it) => {
  // The shipped Browser Profile helper is macOS-only; Windows child lifetime is covered by NodeChildProcessSpawner.
  it.effect.skipIf(process.platform === "win32")(
    "kills the scoped helper child when its Effect deadline expires",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-profile-helper-test-"))),
        (root) =>
          Effect.gen(function* () {
            const pidPath = path.join(root, "helper.pid");
            const executablePath = path.join(root, "helper.mjs");
            fs.writeFileSync(
              executablePath,
              `#!/usr/bin/env node
import fs from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.writeFileSync(request.profilePath, String(process.pid));
  setInterval(() => undefined, 1_000);
});
`,
              { mode: 0o700 },
            );
            const platform = yield* BrowserProfileHelperPlatform;
            const helper = platform.make({ executablePath, timeoutMs: 50 });
            const pending = yield* Effect.forkChild(
              helper.readProfile({
                source: "chrome",
                profilePath: pidPath,
                includeCookies: true,
                includePasswords: false,
              }),
              { startImmediately: true },
            );
            for (let attempt = 0; attempt < 600 && !fs.existsSync(pidPath); attempt += 1) {
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
            }
            assert.isTrue(fs.existsSync(pidPath));
            const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);
            yield* TestClock.adjust("50 millis");
            const error = yield* Fiber.join(pending).pipe(Effect.flip);
            assert.strictEqual(error.operation, "timeout");
            assert.throws(() => process.kill(pid, 0));
          }),
        (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
      ),
  );
});
