import { describe, expect, test, afterEach } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CoreAuthorityProcessExit,
  connectOrStartCore,
  parseCoreStartupEventFrame,
  processGroupPresent,
  resolveCoreExecutable,
} from "./core-launcher";
import {
  acquireIsolatedRunLease,
  isolatedRunLeaseDirectory,
  markIsolatedRunClaimReady,
  publishIsolatedRunClaim,
  readIsolatedRunClaim,
  readIsolatedRunLeaseOwner,
  resolveIsolatedRunBootstrapAccess,
  type IsolatedRunLease,
} from "./isolated-run-ownership";
import { cleanupIsolatedCore } from "../../../scripts/isolated-run-supervisor";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { CoreHttpError, CoreTransportError } from "./local-http";
import { runRemoteCoreEvents } from "./remote-events";
import type { CoreClientPort, CoreStreamCheckpoint, CoreRuntimeDescriptor } from "./types";
import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import { parseCoreRuntimeDescriptor } from "./runtime-descriptor";

describe("core-launcher", () => {
  const CORE_BINARY = requiredNativeExecutable("core-server");

  const waitUntil = async (
    predicate: () => boolean | Promise<boolean>,
    message: string,
  ): Promise<void> => {
    await expect.poll(predicate, { message }).toBe(true);
  };

  const processExists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };

  describe("native Core launcher", () => {
    test("parses only bounded versioned startup frames", () => {
      expect(
        parseCoreStartupEventFrame({
          startup_event_version: 1,
          event: { kind: "migration_started", from_version: 86, to_version: 88 },
        }),
      ).toEqual({ kind: "migration_started", fromVersion: 86, toVersion: 88 });
      expect(
        parseCoreStartupEventFrame({
          startup_event_version: 1,
          event: { kind: "migration_progress", completed: 25, total: 100 },
        }),
      ).toEqual({ kind: "migration_progress", completed: 25, total: 100 });
      expect(parseCoreStartupEventFrame({ selection_version: 1 })).toBeNull();
      expect(
        parseCoreStartupEventFrame({
          startup_event_version: 1,
          event: { kind: "migration_heartbeat" },
        }),
      ).toEqual({ kind: "migration_heartbeat" });
      expect(() =>
        parseCoreStartupEventFrame({
          startup_event_version: 2,
          event: { kind: "migration_started", from_version: 86, to_version: 88 },
        }),
      ).toThrow("version is unsupported");
      expect(() =>
        parseCoreStartupEventFrame({
          startup_event_version: 1,
          event: { kind: "invented" },
        }),
      ).toThrow("kind is unsupported");
      expect(() =>
        parseCoreStartupEventFrame({
          startup_event_version: 1,
          event: { kind: "migration_progress", completed: 2, total: 1 },
        }),
      ).toThrow("invalid migration progress");
    });

    test("resolves explicit, packaged, and development executables", () => {
      expect(
        resolveCoreExecutable({
          environment: { NODEX_CORE_EXECUTABLE: path.resolve("fixtures/nodex-core-override") },
          isPackaged: false,
        }),
      ).toBe(path.resolve("fixtures/nodex-core-override"));
      expect(
        resolveCoreExecutable({
          environment: {},
          appResourcesPath: path.resolve("fixtures/resources"),
          isPackaged: true,
        }),
      ).toBe(
        path.resolve(
          `fixtures/resources/bin/nodex-core${process.platform === "win32" ? ".exe" : ""}`,
        ),
      );
      expect(
        resolveCoreExecutable({
          isPackaged: false,
          repositoryRoot: path.resolve("fixtures/repository"),
          environment: {},
        }),
      ).toBe(
        path.resolve(
          `fixtures/repository/target/debug/nodex-core${process.platform === "win32" ? ".exe" : ""}`,
        ),
      );
      expect(() =>
        resolveCoreExecutable({
          environment: { NODEX_CORE_EXECUTABLE: "target/debug/nodex-core" },
          isPackaged: false,
        }),
      ).toThrow("NODEX_CORE_EXECUTABLE must be absolute");
    });

    // Copying and verifying the packaged executable shares I/O with native scenario workers.
    test("starts packaged Core using its logical manifest identity", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nodex-pkg-"));
      const resources = path.join(root, "resources");
      const nodexHome = path.join(root, "profile");
      mkdirSync(nodexHome, { mode: 0o700 });
      mkdirSync(path.join(nodexHome, "run"), { mode: 0o700 });
      const executable = resolveCoreExecutable({
        appResourcesPath: resources,
        environment: {},
        isPackaged: true,
      });
      mkdirSync(path.dirname(executable), { recursive: true });
      copyFileSync(CORE_BINARY, executable);
      const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
      writeFileSync(
        path.join(resources, "bin/rust-core-runtime.json"),
        JSON.stringify({ binaries: [{ name: "nodex-core", sourceSha256: digest }] }),
      );
      let launched: Awaited<ReturnType<typeof connectOrStartCore>> | undefined;
      let authorityExit: CoreAuthorityProcessExit | undefined;
      try {
        launched = await connectOrStartCore({
          appResourcesPath: resources,
          buildId: "packaged-core-launcher-test",
          environment: {},
          isPackaged: true,
          nodexHome,
          onAuthorityProcessExit: (event) => {
            authorityExit = event;
          },
        });
        expect(launched.executablePath).toBe(executable);
        expect(launched.client.handshake.generation.artifact_sha256).toBe(digest);
        await expect(launched.client.health()).resolves.toMatchObject({ status: "ready" });
      } finally {
        if (launched) {
          await launched.client.shutdown();
          const pid = launched.client.handshake.generation.pid;
          // Windows retains the copied executable until the child and its pipes close.
          await waitUntil(
            () => authorityExit !== undefined,
            "Packaged Core did not close after shutdown",
          );
          expect(authorityExit).toMatchObject({ processId: pid, code: 0, signal: null });
          expect(processExists(pid)).toBe(false);
        }
        // Child close is asserted above; NTFS may still be completing image deletion.
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 120_000);

    test("starts one detached Core and reuses the validated runtime", async () => {
      expect(existsSync(CORE_BINARY), "run vp run test:core-client").toBe(true);
      accessSync(CORE_BINARY, constants.X_OK);
      const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-"));
      const input = {
        buildId: "core-launcher-integration-test",
        connectionId: "desktop-host:core-launcher-integration-test",
        environment: { NODEX_CORE_EXECUTABLE: CORE_BINARY },
        isPackaged: false,
        nodexHome,
      } as const;
      let first: Awaited<ReturnType<typeof connectOrStartCore>> | null = null;
      const startupEvents: string[] = [];

      try {
        first = await connectOrStartCore({
          ...input,
          onStartupEvent: (event) => startupEvents.push(event.kind),
        });
        expect(first.startedProcessId).not.toBeNull();
        expect(startupEvents).toEqual(["candidate_checked", "store_ready"]);
        expect(first.timings.disposition).toBe("started");
        expect(first.client.handshake.generation.pid).toBe(first.startedProcessId);
        await expect(first.client.health()).resolves.toMatchObject({ status: "ready" });

        const reusedEvents: string[] = [];
        const reused = await connectOrStartCore({
          ...input,
          onStartupEvent: (event) => reusedEvents.push(event.kind),
        });
        expect(reused.startedProcessId).toBeNull();
        expect(reusedEvents).toEqual(["candidate_checked"]);
        expect(reused.timings.disposition).toBe("reused");
        expect(reused.client.handshake.generation.pid).toBe(first.client.handshake.generation.pid);
        await waitUntil(
          async () => (await reused.client.health()).metrics.active_clients === 1,
          "Core retained the short-lived selector probe after runtime reuse",
        );

        await first.client.shutdown();
        const socketPath = path.join(nodexHome, "run/core/core.json");
        await waitUntil(
          () => !existsSync(socketPath),
          "Core runtime descriptor remained after shutdown",
        );
      } finally {
        if (first && existsSync(path.join(nodexHome, "run/core/core.json"))) {
          await first.client.shutdown().catch(() => undefined);
        }
        rmSync(nodexHome, { recursive: true, force: true });
      }
    });

    test("includes Core stderr when startup exits", async () => {
      const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-failure-"));

      try {
        await expect(
          connectOrStartCore({
            buildId: "core-launcher-failure-test",
            environment: { NODEX_CORE_EXECUTABLE: process.execPath },
            isPackaged: false,
            nodexHome,
            startupTimeoutMs: 2_000,
          }),
        ).rejects.toThrow(/Native Rust Core exited before selection with code \d+: .*--home/s);
      } finally {
        rmSync(nodexHome, { recursive: true, force: true });
      }
    });

    test.runIf(process.platform !== "win32")(
      "starts a fresh handshake deadline after progress-extended selection",
      async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-deadline-"));
        const executable = path.join(directory, "progress-core");
        let incumbent: Awaited<ReturnType<typeof connectOrStartCore>> | null = null;
        try {
          incumbent = await connectOrStartCore({
            buildId: "core-launcher-deadline-incumbent",
            connectionId: "desktop-host:core-launcher-deadline-incumbent",
            environment: { NODEX_CORE_EXECUTABLE: CORE_BINARY },
            isPackaged: false,
            nodexHome: directory,
          });
          writeFileSync(
            executable,
            '#!/bin/sh\nfor value in 1 2 3; do printf \'%s\\n\' \'{"startup_event_version":1,"event":{"kind":"migration_heartbeat"}}\'; sleep 0.04; done\nprintf \'%s\\n\' "$NODEX_TEST_SELECTION"\nwhile :; do sleep 1; done\n',
          );
          chmodSync(executable, 0o700);
          const artifactSha256 = createHash("sha256")
            .update(readFileSync(executable))
            .digest("hex");
          const descriptor = JSON.parse(
            readFileSync(path.join(directory, "run/core/core.json"), "utf8"),
          ) as Record<string, unknown>;
          const artifact = descriptor.artifact as Record<string, unknown>;
          const selection = JSON.stringify({
            selection_version: 1,
            disposition: "started",
            reason: "started_no_incumbent",
            descriptor: {
              ...descriptor,
              artifact: { ...artifact, sha256: artifactSha256 },
            },
          });
          const startedAt = Date.now();

          await expect(
            connectOrStartCore({
              buildId: "core-launcher-deadline-candidate",
              connectionId: "desktop-host:core-launcher-deadline-candidate",
              environment: {
                NODEX_CORE_EXECUTABLE: executable,
                NODEX_TEST_SELECTION: selection,
              },
              isPackaged: false,
              nodexHome: directory,
              pollIntervalMs: 5,
              startupHardTimeoutMs: 5_000,
              startupTimeoutMs: 1_000,
            }),
          ).rejects.toThrow("did not become ready before the startup deadline");
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_050);
        } finally {
          if (incumbent) {
            await incumbent.client.shutdown().catch(() => undefined);
            await waitUntil(
              () => !existsSync(path.join(directory, "run/core/core.json")),
              "incumbent Core remained active after deadline-test shutdown",
            );
          }
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );

    test("keeps waiting on a candidate group whose last members are still exiting", () => {
      const answering =
        (code?: string) =>
        (pid: number): void => {
          expect(pid).toBe(-42);
          if (code) throw Object.assign(new Error(code), { code });
        };
      expect(processGroupPresent(42, answering())).toBe(true);
      // macOS reports a group whose members are exiting but not yet reaped as EPERM.
      expect(processGroupPresent(42, answering("EPERM"))).toBe(true);
      expect(processGroupPresent(42, answering("ESRCH"))).toBe(false);
      expect(() => processGroupPresent(42, answering("EINVAL"))).toThrow("EINVAL");
    });

    test.runIf(process.platform !== "win32")(
      "aborts and awaits a pre-ready candidate",
      async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-abort-"));
        const executable = path.join(directory, "hanging-core");
        const pidPath = path.join(directory, "candidate.pid");
        writeFileSync(
          executable,
          [
            "#!/bin/sh",
            'printf \'%s\' "$$" > "$NODEX_TEST_CANDIDATE_PID_PATH"',
            'printf \'%s\\n\' \'{"startup_event_version":1,"event":{"kind":"migration_heartbeat"}}\'',
            "while :; do sleep 1; done",
          ].join("\n"),
        );
        chmodSync(executable, 0o700);
        const controller = new AbortController();

        try {
          await expect(
            connectOrStartCore({
              buildId: "core-launcher-abort-test",
              environment: {
                NODEX_CORE_EXECUTABLE: executable,
                NODEX_TEST_CANDIDATE_PID_PATH: pidPath,
              },
              isPackaged: false,
              nodexHome: directory,
              signal: controller.signal,
              startupTimeoutMs: 2_000,
              onStartupEvent: (event) => {
                if (event.kind === "migration_heartbeat") controller.abort();
              },
            }),
          ).rejects.toMatchObject({ name: "AbortError" });
          const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
          expect(processExists(pid)).toBe(false);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );

    test.runIf(process.platform !== "win32")(
      "rejects a malformed versioned startup frame and releases its candidate",
      async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-frame-"));
        const executable = path.join(directory, "invalid-core");
        const pidPath = path.join(directory, "candidate.pid");
        writeFileSync(
          executable,
          '#!/bin/sh\nprintf \'%s\' "$$" > "$NODEX_TEST_CANDIDATE_PID_PATH"\nprintf \'%s\\n\' \'{"startup_event_version":1,"event":{"kind":"invented"}}\'\nwhile :; do sleep 1; done\n',
        );
        chmodSync(executable, 0o700);

        try {
          await expect(
            connectOrStartCore({
              buildId: "core-launcher-invalid-frame-test",
              environment: {
                NODEX_CORE_EXECUTABLE: executable,
                NODEX_TEST_CANDIDATE_PID_PATH: pidPath,
              },
              isPackaged: false,
              nodexHome: directory,
              startupTimeoutMs: 2_000,
            }),
          ).rejects.toThrow("selection result is invalid");
          const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
          expect(processExists(pid)).toBe(false);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );

    test.runIf(process.platform !== "win32")(
      "terminates a detached candidate group when selection times out",
      async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-timeout-"));
        const executable = path.join(directory, "hanging-core");
        const pidPath = path.join(directory, "candidate.pid");
        const descendantPidPath = path.join(directory, "descendant.pid");
        writeFileSync(
          executable,
          [
            "#!/bin/sh",
            "trap '' TERM",
            'printf \'%s\' "$$" > "$NODEX_TEST_CANDIDATE_PID_PATH"',
            'sh -c \'trap "" TERM; printf "%s" "$$" > "$NODEX_TEST_DESCENDANT_PID_PATH"; while :; do sleep 1; done\' &',
            'while [ ! -s "$NODEX_TEST_DESCENDANT_PID_PATH" ]; do sleep 0.01; done',
            'printf \'%s\\n\' \'{"startup_event_version":1,"event":{"kind":"migration_heartbeat"}}\'',
            "wait",
          ].join("\n"),
        );
        chmodSync(executable, 0o700);
        const startupEvents: string[] = [];

        try {
          await expect(
            connectOrStartCore({
              buildId: "core-launcher-timeout-test",
              environment: {
                NODEX_CORE_EXECUTABLE: executable,
                NODEX_TEST_CANDIDATE_PID_PATH: pidPath,
                NODEX_TEST_DESCENDANT_PID_PATH: descendantPidPath,
              },
              isPackaged: false,
              nodexHome: directory,
              // Both processes publish their PIDs before restarting this bounded inactivity window.
              startupTimeoutMs: 2_000,
              onStartupEvent: (event) => startupEvents.push(event.kind),
            }),
          ).rejects.toThrow("Native Rust Core selection timed out");
          expect(startupEvents).toEqual(["migration_heartbeat"]);
          const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
          const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(Number.isSafeInteger(pid)).toBe(true);
          expect(Number.isSafeInteger(descendantPid)).toBe(true);
          expect(processExists(pid)).toBe(false);
          expect(processExists(descendantPid)).toBe(false);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  });
});

describe("isolated-run-ownership", () => {
  const RUN_A = "11111111-1111-4111-8111-111111111111";
  const RUN_B = "22222222-2222-4222-8222-222222222222";
  const createdHomes: string[] = [];

  const createNodexHome = (): string => {
    const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-isolated-run-"));
    chmodSync(nodexHome, 0o700);
    createdHomes.push(nodexHome);
    return nodexHome;
  };

  afterEach(() => {
    for (const nodexHome of createdHomes.splice(0)) {
      rmSync(nodexHome, { force: true, recursive: true });
    }
  });

  describe("isolated run ownership", () => {
    test("acquires one private lease and releases only its fixed entries", () => {
      const nodexHome = createNodexHome();
      const lease = acquireIsolatedRunLease({
        nodexHome,
        runId: RUN_A,
        supervisorPid: process.pid,
        now: new Date("2026-07-28T00:00:00.000Z"),
      });

      expect(readIsolatedRunLeaseOwner(nodexHome)).toEqual(lease.owner);
      // Windows privacy is expressed by inherited user ACLs, not mode bits.
      if (process.platform !== "win32") {
        expect(lstatSync(isolatedRunLeaseDirectory(nodexHome)).mode & 0o777).toBe(0o700);
        expect(
          lstatSync(path.join(isolatedRunLeaseDirectory(nodexHome), "owner.json")).mode & 0o777,
        ).toBe(0o600);
      }
      expect(() =>
        acquireIsolatedRunLease({
          nodexHome,
          runId: RUN_B,
          supervisorPid: process.pid,
        }),
      ).toThrow("Another isolated run owns this Profile");

      lease.release();
      lease.release();
      expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
    });

    test("publishes one idempotent same-run primary host claim", () => {
      const nodexHome = createNodexHome();
      const lease = acquireIsolatedRunLease({
        nodexHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });

      const first = publishIsolatedRunClaim({
        nodexHome,
        runId: RUN_A,
        hostPid: 101,
        now: new Date("2026-07-28T00:00:00.000Z"),
      });
      const restartedHost = publishIsolatedRunClaim({
        nodexHome,
        runId: RUN_A,
        hostPid: 202,
        now: new Date("2026-07-28T00:01:00.000Z"),
      });

      expect(restartedHost).toEqual(first);
      expect(first).toMatchObject({ phase: "starting", readyAt: null });
      const ready = markIsolatedRunClaimReady({
        nodexHome,
        runId: RUN_A,
        now: new Date("2026-07-28T00:02:00.000Z"),
      });
      expect(ready).toMatchObject({
        phase: "ready",
        readyAt: "2026-07-28T00:02:00.000Z",
      });
      expect(
        markIsolatedRunClaimReady({
          nodexHome,
          runId: RUN_A,
          now: new Date("2026-07-28T00:03:00.000Z"),
        }),
      ).toEqual(ready);
      expect(
        publishIsolatedRunClaim({
          nodexHome,
          runId: RUN_A,
          hostPid: 303,
          now: new Date("2026-07-28T00:04:00.000Z"),
        }),
      ).toEqual(ready);
      expect(readIsolatedRunClaim(nodexHome)).toEqual(ready);
      if (process.platform !== "win32") {
        expect(
          lstatSync(path.join(isolatedRunLeaseDirectory(nodexHome), "host-claim.json")).mode &
            0o777,
        ).toBe(0o600);
      }
      expect(() =>
        publishIsolatedRunClaim({
          nodexHome,
          runId: RUN_B,
          hostPid: 303,
        }),
      ).toThrow("matching live lease");

      lease.release();
    });

    test("resolves ordinary, matching, missing, and foreign bootstrap ownership", () => {
      const nodexHome = createNodexHome();

      expect(
        resolveIsolatedRunBootstrapAccess({
          nodexHome,
          inheritedRunId: undefined,
        }),
      ).toEqual({ kind: "ordinary" });
      expect(() =>
        resolveIsolatedRunBootstrapAccess({
          nodexHome,
          inheritedRunId: RUN_A,
        }),
      ).toThrow("no matching supervisor lease");

      const lease = acquireIsolatedRunLease({
        nodexHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });

      expect(
        resolveIsolatedRunBootstrapAccess({
          nodexHome,
          inheritedRunId: RUN_A,
        }),
      ).toEqual({ kind: "supervised", runId: RUN_A });
      expect(() =>
        resolveIsolatedRunBootstrapAccess({
          nodexHome,
          inheritedRunId: undefined,
        }),
      ).toThrow("managed by an isolated-run supervisor");
      expect(() =>
        resolveIsolatedRunBootstrapAccess({
          nodexHome,
          inheritedRunId: RUN_B,
        }),
      ).toThrow("different isolated-run supervisor");

      lease.release();
    });

    test("rejects malformed, oversized, and unexpected lease entries", () => {
      const malformedHome = createNodexHome();
      const malformedLease = isolatedRunLeaseDirectory(malformedHome);
      mkdirSync(path.dirname(malformedLease), { mode: 0o700 });
      mkdirSync(malformedLease, { mode: 0o700 });
      writeFileSync(path.join(malformedLease, "owner.json"), "{}", { mode: 0o600 });
      expect(() => readIsolatedRunLeaseOwner(malformedHome)).toThrow("version is unsupported");

      const oversizedHome = createNodexHome();
      const oversizedLease = isolatedRunLeaseDirectory(oversizedHome);
      mkdirSync(path.dirname(oversizedLease), { mode: 0o700 });
      mkdirSync(oversizedLease, { mode: 0o700 });
      writeFileSync(path.join(oversizedLease, "owner.json"), "x".repeat(4_097), {
        mode: 0o600,
      });
      expect(() => readIsolatedRunLeaseOwner(oversizedHome)).toThrow("oversized");

      const unexpectedHome = createNodexHome();
      const lease = acquireIsolatedRunLease({
        nodexHome: unexpectedHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });
      writeFileSync(path.join(isolatedRunLeaseDirectory(unexpectedHome), "unexpected"), "", {
        mode: 0o600,
      });
      expect(() => lease.release()).toThrow("unexpected entry");
    });

    test("rejects symlinked lease metadata", () => {
      const symlinkHome = createNodexHome();
      const leaseDirectory = isolatedRunLeaseDirectory(symlinkHome);
      mkdirSync(path.dirname(leaseDirectory), { mode: 0o700 });
      mkdirSync(leaseDirectory, { mode: 0o700 });
      const external = path.join(symlinkHome, "external-owner.json");
      writeFileSync(external, "{}", { mode: 0o600 });
      symlinkSync(external, path.join(leaseDirectory, "owner.json"));
      expect(() => readIsolatedRunLeaseOwner(symlinkHome)).toThrow("symlink");
    });

    // POSIX permissions have no Windows chmod equivalent.
    test.skipIf(process.platform === "win32")("rejects non-private lease modes", () => {
      const modeHome = createNodexHome();
      const lease = acquireIsolatedRunLease({
        nodexHome: modeHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });
      chmodSync(path.join(isolatedRunLeaseDirectory(modeHome), "owner.json"), 0o644);
      expect(() => readIsolatedRunLeaseOwner(modeHome)).toThrow("mode 644; expected 600");
      expect(() => lease.release()).toThrow("mode 644; expected 600");
    });

    test("fails closed on a lease directory whose owner was never published", () => {
      const nodexHome = createNodexHome();
      const leaseDirectory = isolatedRunLeaseDirectory(nodexHome);
      mkdirSync(path.dirname(leaseDirectory), { mode: 0o700 });
      mkdirSync(leaseDirectory, { mode: 0o700 });

      expect(() =>
        acquireIsolatedRunLease({
          nodexHome,
          runId: RUN_A,
          supervisorPid: process.pid,
        }),
      ).toThrow("lease is incomplete");
    });

    test("rejects an owner file that changes shape through a foreign file type", () => {
      const nodexHome = createNodexHome();
      const leaseDirectory = isolatedRunLeaseDirectory(nodexHome);
      mkdirSync(path.dirname(leaseDirectory), { mode: 0o700 });
      mkdirSync(leaseDirectory, { mode: 0o700 });
      mkdirSync(path.join(leaseDirectory, "owner.json"), { mode: 0o700 });

      expect(() => readIsolatedRunLeaseOwner(nodexHome)).toThrow("must be a regular file");
    });
  });
});

describe("isolated-run-lifecycle", () => {
  const CORE_BINARY = requiredNativeExecutable("core-server");
  const RUN_A = "11111111-1111-4111-8111-111111111111";
  const RUN_B = "22222222-2222-4222-8222-222222222222";

  const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
    await expect.poll(predicate, { message }).toBe(true);
  };

  describe("isolated run Core lifecycle", () => {
    test("gracefully stops the authenticated generation before releasing the lease", async () => {
      expect(existsSync(CORE_BINARY), "run vp run test:core-client").toBe(true);
      accessSync(CORE_BINARY, constants.X_OK);
      const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-isolated-lifecycle-"));
      const launched = await connectOrStartCore({
        buildId: "isolated-run-lifecycle-integration",
        environment: { NODEX_CORE_EXECUTABLE: CORE_BINARY },
        isPackaged: false,
        nodexHome,
      });
      let lease: IsolatedRunLease | null = acquireIsolatedRunLease({
        nodexHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });

      try {
        publishIsolatedRunClaim({
          nodexHome,
          runId: RUN_A,
          hostPid: process.pid,
        });
        await expect(
          cleanupIsolatedCore({
            lease,
            nodexHome,
            runId: RUN_A,
          }),
        ).resolves.toEqual({
          status: "stopped",
          safeToDeleteRunRoot: true,
        });
        lease = null;

        expect(existsSync(path.join(nodexHome, "run/core/core.json"))).toBe(false);
        expect(existsSync(path.join(nodexHome, "run/core/core.auth"))).toBe(false);
        expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();

        const nextLease = acquireIsolatedRunLease({
          nodexHome,
          runId: RUN_B,
          supervisorPid: process.pid,
        });
        nextLease.release();
      } finally {
        if (existsSync(path.join(nodexHome, "run/core/core.json"))) {
          await launched.client.shutdown().catch(() => undefined);
          await waitUntil(
            () => !existsSync(path.join(nodexHome, "run/core/core.json")),
            "Core descriptor remained during integration-test cleanup",
          ).catch(() => undefined);
        }
        lease?.release();
        rmSync(nodexHome, { recursive: true, force: true });
      }
    });

    test("does not stop a Core when the leased run never became primary host", async () => {
      expect(existsSync(CORE_BINARY), "run vp run test:core-client").toBe(true);
      accessSync(CORE_BINARY, constants.X_OK);
      const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-isolated-non-owner-"));
      const launched = await connectOrStartCore({
        buildId: "isolated-run-non-owner-integration",
        environment: { NODEX_CORE_EXECUTABLE: CORE_BINARY },
        isPackaged: false,
        nodexHome,
      });
      const lease = acquireIsolatedRunLease({
        nodexHome,
        runId: RUN_A,
        supervisorPid: process.pid,
      });

      try {
        await expect(
          cleanupIsolatedCore({
            lease,
            nodexHome,
            runId: RUN_A,
          }),
        ).resolves.toMatchObject({
          status: "not_owner",
          safeToDeleteRunRoot: false,
        });
        await expect(launched.client.health()).resolves.toMatchObject({
          status: "ready",
        });
        expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
      } finally {
        await launched.client.shutdown().catch(() => undefined);
        await waitUntil(
          () => !existsSync(path.join(nodexHome, "run/core/core.json")),
          "Core descriptor remained during non-owner test cleanup",
        ).catch(() => undefined);
        lease.release();
        rmSync(nodexHome, { recursive: true, force: true });
      }
    });
  });
});

describe("remote-events", () => {
  const settle = (predicate: () => boolean) =>
    Effect.gen(function* () {
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Yield across the mocked remote reconnect fibers without advancing time.
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error("Remote stream did not settle"));
    });

  it.effect(
    "reconnect resumes the delivered cursor and closing the scope closes its active lease",
    () =>
      Effect.gen(function* () {
        const opened: number[] = [];
        let closeCount = 0;
        const client: Pick<CoreClientPort, "openEventStream"> = {
          openEventStream: async (after, _event, checkpoint) => {
            opened.push(after);
            if (opened.length === 1) {
              checkpoint({
                store_epoch: "epoch",
                generation: "core",
                scanned_through_seq: 7,
                oldest_available_seq: 1,
                resync_token: null,
              } as CoreStreamCheckpoint);
              return {
                done: Promise.reject(
                  new CoreTransportError("connection_lost", "response", null, null),
                ),
                close: () => {
                  closeCount += 1;
                },
              };
            }
            return {
              done: new Promise<void>(() => {}),
              close: () => {
                closeCount += 1;
              },
            };
          },
        };
        const fiber = yield* runRemoteCoreEvents({
          client,
          after: 3,
          onEvent: () => {},
          onCheckpoint: () => {},
          onResyncRequired: () => {},
        }).pipe(Effect.forkScoped);
        yield* settle(() => closeCount === 1);
        yield* TestClock.adjust("1 second");
        yield* settle(() => opened.length === 2);
        assert.deepEqual(opened, [3, 7]);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(closeCount, 2);
      }),
  );

  it.effect("membership refusal is terminal", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client: Pick<CoreClientPort, "openEventStream"> = {
        openEventStream: async () => {
          attempts += 1;
          throw new CoreHttpError(401, "Revoked");
        },
      };
      const result = yield* runRemoteCoreEvents({
        client,
        after: 0,
        onEvent: () => {},
        onCheckpoint: () => {},
        onResyncRequired: () => {},
      }).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(attempts, 1);
    }),
  );
});

describe("runtime-descriptor", () => {
  const descriptor = (endpoint: string): CoreRuntimeDescriptor => {
    const store = CORE_CLIENT_REQUIREMENTS.accepted_store_formats[0];
    const manifest: CoreRuntimeDescriptor["manifest"] = {
      manifest_version: 1,
      transport: CORE_CLIENT_REQUIREMENTS.transport,
      event_versions: {
        min: CORE_CLIENT_REQUIREMENTS.event_version,
        max: CORE_CLIENT_REQUIREMENTS.event_version,
      },
      modules: CORE_CLIENT_REQUIREMENTS.modules.map(({ module, contract_version }) => ({
        module,
        versions: { min: contract_version, max: contract_version },
      })),
      store: { readable: [store], migratable: [], current: store },
    };
    return {
      manifest,
      manifest_digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      artifact: { build_id: "test", sha256: "a".repeat(64) },
      actual_store_format: store,
      pid: 123,
      start_nonce: "b".repeat(32),
      endpoint,
      profile_id: "profile",
      store_epoch: "epoch",
      readiness_generation: 1,
    };
  };

  test("Unix descriptors require the exact managed local socket", () => {
    const endpoint = path.resolve("profile/run/core/core.sock");
    expect(parseCoreRuntimeDescriptor(descriptor(endpoint), endpoint, "darwin").endpoint).toBe(
      endpoint,
    );
    expect(() =>
      parseCoreRuntimeDescriptor(descriptor(path.resolve("foreign.sock")), endpoint, "darwin"),
    ).toThrow("fixed runtime socket");
  });

  test("Windows descriptors accept only a local random Core pipe", () => {
    const endpoint = String.raw`\\.\pipe\nodex-core-${"a".repeat(32)}`;
    expect(parseCoreRuntimeDescriptor(descriptor(endpoint), "unused", "win32").endpoint).toBe(
      endpoint,
    );
    for (const invalid of [
      endpoint.replace("\\\\.\\", "\\\\remote\\"),
      endpoint.toUpperCase(),
      `${endpoint}suffix`,
      endpoint.replace("nodex-core", "nodex-clone"),
      "C:\\profile\\core.sock",
    ]) {
      expect(() => parseCoreRuntimeDescriptor(descriptor(invalid), "unused", "win32")).toThrow(
        "invalid local pipe",
      );
    }
  });
});
