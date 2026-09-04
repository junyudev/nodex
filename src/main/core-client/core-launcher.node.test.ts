import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
  connectOrStartCore,
  parseCoreStartupEventFrame,
  resolveCoreExecutable,
} from "./core-launcher";

const CORE_BINARY = requiredNativeExecutable("core-server");

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
        environment: { NODEX_CORE_EXECUTABLE: "/opt/nodex/bin/nodex-core" },
        isPackaged: false,
      }),
    ).toBe("/opt/nodex/bin/nodex-core");
    expect(
      resolveCoreExecutable({
        environment: {},
        appResourcesPath: "/Applications/Nodex.app/Contents/Resources",
        isPackaged: true,
      }),
    ).toBe("/Applications/Nodex.app/Contents/Resources/bin/nodex-core");
    expect(
      resolveCoreExecutable({
        isPackaged: false,
        repositoryRoot: "/work/nodex",
        environment: {},
      }),
    ).toBe("/work/nodex/target/debug/nodex-core");
    expect(() =>
      resolveCoreExecutable({
        environment: { NODEX_CORE_EXECUTABLE: "target/debug/nodex-core" },
        isPackaged: false,
      }),
    ).toThrow("NODEX_CORE_EXECUTABLE must be absolute");
  });

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
      const socketPath = path.join(nodexHome, "run/core/core.sock");
      await waitUntil(() => !existsSync(socketPath), "Core runtime socket remained after shutdown");
    } finally {
      if (first && existsSync(path.join(nodexHome, "run/core/core.sock"))) {
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
        const artifactSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
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
            () => !existsSync(path.join(directory, "run/core/core.sock")),
            "incumbent Core remained active after deadline-test shutdown",
          );
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")("aborts and awaits a pre-ready candidate", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-launcher-abort-"));
    const executable = path.join(directory, "hanging-core");
    const pidPath = path.join(directory, "candidate.pid");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'%s\' "$$" > "$NODEX_TEST_CANDIDATE_PID_PATH"\nwhile :; do sleep 1; done\n',
    );
    chmodSync(executable, 0o700);
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 50);

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
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(processExists(pid)).toBe(false);
    } finally {
      clearTimeout(abort);
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
        '#!/bin/sh\ntrap \'\' TERM\nprintf \'%s\' "$$" > "$NODEX_TEST_CANDIDATE_PID_PATH"\nsh -c \'trap "" TERM; printf "%s" "$$" > "$NODEX_TEST_DESCENDANT_PID_PATH"; while :; do sleep 1; done\' &\nwait\n',
      );
      chmodSync(executable, 0o700);

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
            startupTimeoutMs: 100,
          }),
        ).rejects.toThrow("Native Rust Core selection timed out");
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
