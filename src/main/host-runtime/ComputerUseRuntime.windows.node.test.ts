/* @effect-diagnostics asyncFunction:off newPromise:off -- Node stream fixtures. */
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair, PassThrough, Writable } from "node:stream";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
} from "../../shared/browser-runtime-metadata";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "../browser-use/native-pipe-framing";
import { resolveBrowserRuntimeBundle } from "../codex/browser-runtime-bundle";
import {
  fixtureWindowsVerifier,
  writeWindowsBrowserRuntimeFixture,
} from "../codex/browser-runtime-windows-test-fixture";
import { windowsComputerUseReplEnvironment } from "../codex/computer-use-runtime-config";
import {
  makeWindowsComputerUseHostPlatform,
  resolveWindowsComputerUse,
} from "../platform/electron/WindowsComputerUseHostPlatform";
import {
  unsupportedWindowsDesktopTools,
  type WindowsPipeConnection,
  type WindowsProcessIdentity,
} from "../platform/node/WindowsDesktopTools";
import { ComputerUseRuntime, testLayer } from "./ComputerUseRuntime";

async function fixture<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nodex-cua-windows-"));
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const verifiedFixture = async (
  home: string,
  arch: "x64" | "arm64",
  minimumWindowsVersion?: string,
) => {
  const root = join(home, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifestPath = join(root, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const manifest = writeWindowsBrowserRuntimeFixture(root, arch);
  if (minimumWindowsVersion) {
    manifest.capabilities.computerUse.minimumWindowsVersion = minimumWindowsVersion;
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  const appServerIdentity = {
    entrypointSha256: "a".repeat(64),
    protocolSchemaFingerprint: "b".repeat(64),
    runtimeVersion: "0.166.0",
    sourceCommit: "c".repeat(40),
    targetArch: arch,
    targetPlatform: "win32" as const,
  };
  const bundle = await resolveBrowserRuntimeBundle({
    runtimeRoot: home,
    targetPlatform: "win32",
    targetArch: arch,
    appServerIdentity,
    windowsVerifier: fixtureWindowsVerifier(),
    testedPairs: [
      {
        appServer: appServerIdentity,
        browser: {
          browserPluginVersion: manifest.browserPlugin.version,
          manifestSha256: createHash("sha256")
            .update(await readFile(manifestPath))
            .digest("hex"),
          peerCliVersion: manifest.runtimeVersions.codexCli,
          targetArch: arch,
          targetPlatform: "win32",
        },
      },
    ],
  });
  if (bundle.status !== "available") throw new Error(bundle.message);
  return bundle;
};

test.each(["x64", "arm64"] as const)(
  "requires a verified %s closure and its Windows floor",
  (arch) =>
    fixture(async (root) => {
      const runtime = await verifiedFixture(root, arch);
      expect(
        resolveWindowsComputerUse(runtime, { architecture: arch, osRelease: "10.0.19041" }),
      ).toMatchObject({
        status: "available",
        serviceExecutablePath: join(runtime.bundle.rootPath, "bin", "service.exe"),
      });
      expect(
        resolveWindowsComputerUse(runtime, { architecture: arch, osRelease: "10.0.19040" }),
      ).toMatchObject({ reason: "windows-version-unsupported" });
      const older = await verifiedFixture(join(root, "older"), arch, "10.0.17763");
      expect(
        resolveWindowsComputerUse(older, { architecture: arch, osRelease: "10.0.19040" }),
      ).toMatchObject({ reason: "windows-version-unsupported" });
      const later = await verifiedFixture(join(root, "later"), arch, "10.0.22000");
      expect(
        resolveWindowsComputerUse(later, { architecture: arch, osRelease: "10.0.19045" }),
      ).toMatchObject({ reason: "windows-version-unsupported" });
      expect(
        resolveWindowsComputerUse(runtime, { architecture: "ia32", osRelease: "10.0.26100" }),
      ).toMatchObject({ reason: "architecture-unsupported" });
      expect(
        resolveWindowsComputerUse(
          { status: "unavailable", reason: "artifact-invalid", message: "Invalid DLL" },
          { architecture: arch, osRelease: "10.0.26100" },
        ),
      ).toMatchObject({ reason: "runtime-unavailable", message: "Invalid DLL" });
    }),
);

type HelperInput = {
  id: number;
  method: string;
  meta: Record<string, unknown>;
};
type Reply = { id: number | string; error?: { message: string }; result?: unknown };

it.live(
  "admits only the verified REPL and supervises the Windows helper across approvals, Escape, turns and disable",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-cua-windows-"))),
      (root) =>
        Effect.gen(function* () {
          const browserRuntime = yield* Effect.promise(() =>
            verifiedFixture(join(root, "bundle"), "x64"),
          );
          const bin = join(browserRuntime.bundle.rootPath, "bin");
          const connections = yield* Queue.unbounded<WindowsPipeConnection>();
          const processIdentities = new Map<number, WindowsProcessIdentity>();
          const sends: HelperInput[] = [];
          const held = yield* Queue.unbounded<void>();
          let helpers = 0;
          let liveJobs = 0;
          let listeners = 0;
          let escape = () => {};
          const host = makeWindowsComputerUseHostPlatform({
            tools: {
              ...unsupportedWindowsDesktopTools,
              processIdentity: (pid) => Effect.succeed(processIdentities.get(pid)!),
              listenPipe: () =>
                Effect.acquireRelease(
                  Effect.sync(() => ({
                    endpoint: `\\\\.\\pipe\\cua-fixture-${++listeners}`,
                    accept: Queue.take(connections),
                  })),
                  () => Effect.void,
                ),
              spawnInJob: (launch) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    helpers++;
                    liveJobs++;
                    expect(launch.args).toEqual(["--parent-pid", "42"]);
                    expect(launch.cwd).toBe(bin);
                    expect(launch.env).toEqual({
                      SYSTEMROOT: "C:\\Windows",
                      CODEX_HOME: join(root, "state"),
                    });
                    const output = new PassThrough();
                    let finish: (code: number) => void = () => {};
                    const exited = new Promise<number>((resolve) => {
                      finish = resolve;
                    });
                    escape = () => {
                      output.end();
                      finish(130);
                    };
                    let busy = false;
                    const input = new Writable({
                      write(chunk: Buffer, _encoding, callback) {
                        const frame = JSON.parse(chunk.toString()) as HelperInput;
                        sends.push(frame);
                        if (frame.method === "crash") {
                          output.end();
                          finish(7);
                        } else if (frame.method === "hold") {
                          busy = true;
                          Queue.offerUnsafe(held, undefined);
                        } else if (busy && frame.method === "end_turn") {
                          // A native operation can leave the helper unable to read its lifecycle command.
                        } else if (
                          frame.method === "get_app_state" &&
                          !frame.meta["x-oai-cua-approved-app"]
                        ) {
                          output.write(
                            `${JSON.stringify({
                              id: frame.id,
                              ok: false,
                              approvalRequest: {
                                app: "test:app",
                                displayName: "Test App",
                                riskLevel: "high",
                                allowPersistentApproval: false,
                              },
                            })}\n`,
                          );
                        } else {
                          output.write(
                            `${JSON.stringify({ id: frame.id, ok: true, result: frame.method })}\n`,
                          );
                        }
                        callback();
                      },
                    });
                    return {
                      identity: {
                        pid: 100 + helpers,
                        creationTime: "123456",
                        imagePath: launch.executable,
                      },
                      input,
                      output,
                      exited,
                      close() {
                        liveJobs--;
                        input.destroy();
                        output.end();
                        finish(0);
                      },
                    };
                  }),
                  (job) => Effect.sync(job.close),
                ),
            },
            architecture: "x64",
            osRelease: "10.0.26100",
            parentPid: 42,
            environment: { SystemRoot: "C:\\Windows", PATH: "untrusted" },
            runtimeStateHome: join(root, "state"),
            codexCliPath: null,
            canonicalPath: (file) => file,
          });
          let closureReady = false;
          const layer = testLayer(
            {
              get browserRuntime() {
                if (!closureReady)
                  throw new Error("Computer Use read the closure before readiness");
                return browserRuntime;
              },
              windows: {
                tools: unsupportedWindowsDesktopTools,
                environment: {},
                ready: Effect.sync(() => {
                  closureReady = true;
                }),
              },
              peerAuthorizationMode: "packaged",
              platform: "win32",
              runtimeStateHome: join(root, "state"),
            },
            host,
          );
          const scope = yield* Scope.make();
          const verify = Effect.gen(function* () {
            const service = Context.get(
              yield* Scope.provide(Layer.build(layer), scope),
              ComputerUseRuntime,
            );
            const windows = service.windows!;
            const admit = (pid: number, imagePath: string, creationTime = "123") => {
              const [client, stream] = duplexPair();
              const peer = { pid, imagePath, creationTime };
              processIdentities.set(pid, {
                ...peer,
                creationTime: pid === 8 ? "456" : creationTime,
              });
              Queue.offerUnsafe(connections, { peer, stream });
              return client;
            };
            expect(windowsComputerUseReplEnvironment(service.current())).toBeNull();
            const ready = yield* service.ensureReady;
            expect(windowsComputerUseReplEnvironment(ready)).toEqual({
              SKY_CUA_NATIVE_PIPE: "1",
              SKY_CUA_NATIVE_PIPE_DIRECTORY: "\\\\.\\pipe\\cua-fixture-1",
            });
            expect(helpers).toBe(0);
            for (const [pid, image] of [
              [7, join(root, "other", "node_repl.exe")],
              [8, browserRuntime.bundle.paths.nodeRepl],
              [10, join(bin, "service.exe")],
            ] as const) {
              const rejected = admit(pid, image);
              rejected.resume();
              yield* Effect.promise(() => once(rejected, "end"));
              rejected.destroy();
            }
            expect(helpers).toBe(0);

            const client = admit(9, browserRuntime.bundle.paths.nodeRepl);
            const decoder = new BrowserUseNativePipeFrameDecoder();
            const messages = yield* Queue.unbounded<Reply>();
            client.on("data", (chunk: Buffer) => {
              for (const message of decoder.push(chunk))
                Queue.offerUnsafe(messages, JSON.parse(message) as Reply);
            });
            const write = (body: object) =>
              client.write(
                encodeBrowserUseNativePipeFrame(JSON.stringify({ jsonrpc: "2.0", ...body })),
              );
            const read = Queue.take(messages).pipe(Effect.timeout("5 seconds"));
            const observe = (turnId: string, phase: "started" | "ended") =>
              windows.observeTurn({
                nativeThreadId: "thread",
                nativeTurnId: turnId,
                ...(phase === "started" ? { phase, sessionId: "fixture-session" } : { phase }),
              });
            const request = (id: number, method: string, turn = "one") =>
              write({
                id,
                method: "request",
                params: {
                  method,
                  codexTurnMetadata: {
                    session_id: "thread",
                    turn_id: turn,
                    "x-oai-cua-approved-app": "test:app",
                  },
                },
              });

            request(1, "list_apps");
            expect((yield* read).error?.message).toContain("turn has ended");
            expect(helpers).toBe(0);
            yield* observe("one", "started");
            request(2, "get_app_state");
            const elicitation = yield* read;
            expect(elicitation).toMatchObject({
              method: "requestComputerUseApproval",
              params: {
                meta: { riskLevel: "high", persist: ["session"], tool_params: { app: "test:app" } },
              },
            });
            expect(sends[0]?.meta).not.toHaveProperty("x-oai-cua-approved-app");
            write({ id: elicitation.id, result: { action: "decline", content: null } });
            expect((yield* read).error?.message).toContain("was not approved");
            request(3, "get_app_state");
            write({ id: (yield* read).id, result: { action: "accept", content: {} } });
            expect(yield* read).toMatchObject({ id: 3, result: "get_app_state" });
            expect(sends.at(-1)?.meta["x-oai-cua-approved-app"]).toBe("test:app");

            yield* observe("one", "ended");
            expect(sends.at(-1)).toMatchObject({ method: "end_turn", meta: { turn_id: "one" } });
            yield* observe("two", "started");
            request(4, "get_app_state", "two");
            expect(yield* read).toMatchObject({ method: "requestComputerUseApproval" });
            escape();
            expect((yield* read).error?.message).toContain("physical Escape key");
            expect(liveJobs).toBe(0);
            request(5, "list_apps", "two");
            expect((yield* read).error?.message).toContain("physical Escape key");
            expect(helpers).toBe(1);

            yield* observe("two", "ended");
            yield* observe("three", "started");
            request(6, "crash", "three");
            expect((yield* read).error?.message).toContain("exited (7)");
            request(7, "list_apps", "three");
            expect(yield* read).toMatchObject({ id: 7, result: "list_apps" });
            expect(helpers).toBe(3);
            request(8, "hold", "three");
            yield* Queue.take(held).pipe(Effect.timeout("5 seconds"));
            yield* observe("three", "ended");
            expect(yield* read).toMatchObject({
              id: 8,
              error: { message: expect.stringContaining("turn has ended") },
            });
            expect(liveJobs).toBe(0);
            yield* observe("four", "started");
            request(9, "list_apps", "four");
            expect(yield* read).toMatchObject({ id: 9, result: "list_apps" });
            expect(liveJobs).toBe(1);

            yield* windows.setEnabled(false);
            expect(liveJobs).toBe(0);
            expect(windowsComputerUseReplEnvironment(service.current())).toBeNull();
            expect(yield* service.ensureReady).toMatchObject({ reason: "disabled" });
            yield* windows.setEnabled(true);
            expect(windowsComputerUseReplEnvironment(yield* service.ensureReady)).not.toEqual(
              windowsComputerUseReplEnvironment(ready),
            );
            const replacement = admit(11, browserRuntime.bundle.paths.nodeRepl);
            replacement.on("data", (chunk: Buffer) => {
              for (const frame of newDecoder.push(chunk))
                Queue.offerUnsafe(messages, JSON.parse(frame) as Reply);
            });
            const newDecoder = new BrowserUseNativePipeFrameDecoder();
            replacement.write(
              encodeBrowserUseNativePipeFrame(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 10,
                  method: "request",
                  params: {
                    method: "list_apps",
                    codexTurnMetadata: { session_id: "thread", turn_id: "four" },
                  },
                }),
              ),
            );
            expect(yield* read).toMatchObject({ id: 10, result: "list_apps" });
            expect(liveJobs).toBe(1);
            client.destroy();
          });
          yield* verify.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
          expect(liveJobs).toBe(0);
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
);
