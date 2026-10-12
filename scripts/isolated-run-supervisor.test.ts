import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import type { components } from "@nodex/core-protocol";
import { BROWSER_USE_PEER_AUTHORIZATION_ENV } from "../src/shared/browser-use-host-capability";
import {
  acquireIsolatedRunLease,
  markIsolatedRunClaimReady,
  publishIsolatedRunClaim,
  readIsolatedRunLeaseOwner,
} from "../src/main/core-client/isolated-run-ownership";
import {
  cleanupIsolatedCore,
  superviseIsolatedRun,
  type IsolatedCoreCleanupDependencies,
  type SupervisorSignalSource,
} from "./isolated-run-supervisor";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const createdHomes: string[] = [];

const runSupervisor = (input: Parameters<typeof superviseIsolatedRun>[0]) =>
  Effect.runPromise(superviseIsolatedRun(input));

const GENERATION: components["schemas"]["RuntimeGenerationIdentity"] = {
  artifact_sha256: "a".repeat(64),
  manifest_digest: "b".repeat(64),
  pid: 4242,
  profile_id: "profile:test",
  readiness_generation: 1,
  start_nonce: "c".repeat(32),
  store_epoch: "store:test",
};

const createNodexHome = (): string => {
  const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-supervisor-test-"));
  chmodSync(nodexHome, 0o700);
  createdHomes.push(nodexHome);
  return nodexHome;
};

const acquireLease = (nodexHome: string) =>
  acquireIsolatedRunLease({
    nodexHome,
    runId: RUN_A,
    supervisorPid: process.pid,
  });

const cleanupDependencies = (
  overrides: Partial<IsolatedCoreCleanupDependencies> = {},
): Partial<IsolatedCoreCleanupDependencies> => ({
  connectCore: vi.fn(async () => ({
    handshake: { generation: GENERATION },
    shutdown: vi.fn(async () => ({ status: "draining" as const })),
  })),
  delay: vi.fn(async () => undefined),
  inspectRuntimeEvidence: vi.fn<IsolatedCoreCleanupDependencies["inspectRuntimeEvidence"]>(
    () => "none",
  ),
  isPidAlive: vi.fn(() => false),
  now: vi.fn(() => 0),
  readRuntimeGeneration: vi.fn(() => GENERATION),
  ...overrides,
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly pid = 4321;
  readonly kill = vi.fn(() => true);

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const nodexHome of createdHomes.splice(0)) {
    rmSync(nodexHome, { force: true, recursive: true });
  }
});

describe("isolated run supervisor", () => {
  test("releases the lease when no Core runtime was started", async () => {
    const nodexHome = createNodexHome();
    const lease = acquireLease(nodexHome);

    await expect(
      cleanupIsolatedCore({
        lease,
        nodexHome,
        runId: RUN_A,
        dependencies: cleanupDependencies({
          readClaim: vi.fn(() => null),
        }),
      }),
    ).resolves.toEqual({
      status: "not_started",
      safeToDeleteRunRoot: true,
    });
    expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
  });

  test("retains an interrupted starting claim but releases a ready claim after Core disappears", async () => {
    const interruptedHome = createNodexHome();
    const interruptedLease = acquireLease(interruptedHome);
    publishIsolatedRunClaim({
      nodexHome: interruptedHome,
      runId: RUN_A,
      hostPid: process.pid,
    });

    await expect(
      cleanupIsolatedCore({
        lease: interruptedLease,
        nodexHome: interruptedHome,
        runId: RUN_A,
        dependencies: cleanupDependencies(),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      safeToDeleteRunRoot: false,
      reason: "Primary Electron startup did not reach confirmed Core readiness",
    });
    expect(readIsolatedRunLeaseOwner(interruptedHome)?.runId).toBe(RUN_A);
    interruptedLease.release();

    const stoppedHome = createNodexHome();
    const stoppedLease = acquireLease(stoppedHome);
    publishIsolatedRunClaim({
      nodexHome: stoppedHome,
      runId: RUN_A,
      hostPid: process.pid,
    });
    markIsolatedRunClaimReady({
      nodexHome: stoppedHome,
      runId: RUN_A,
    });

    await expect(
      cleanupIsolatedCore({
        lease: stoppedLease,
        nodexHome: stoppedHome,
        runId: RUN_A,
        dependencies: cleanupDependencies(),
      }),
    ).resolves.toEqual({
      status: "not_started",
      safeToDeleteRunRoot: true,
    });
    expect(readIsolatedRunLeaseOwner(stoppedHome)).toBeNull();
  });

  test("authenticates and drains only after a matching primary-host claim", async () => {
    const nodexHome = createNodexHome();
    const lease = acquireLease(nodexHome);
    publishIsolatedRunClaim({
      nodexHome,
      runId: RUN_A,
      hostPid: process.pid,
    });
    const inspectRuntimeEvidence = vi
      .fn()
      .mockReturnValueOnce("complete")
      .mockReturnValueOnce("none");
    const shutdown = vi.fn(async () => ({ status: "draining" as const }));
    const connectCore = vi.fn(async () => ({
      handshake: { generation: GENERATION },
      shutdown,
    }));

    await expect(
      cleanupIsolatedCore({
        lease,
        nodexHome,
        runId: RUN_A,
        dependencies: cleanupDependencies({
          connectCore,
          inspectRuntimeEvidence,
          isPidAlive: vi.fn(() => false),
        }),
      }),
    ).resolves.toEqual({
      status: "stopped",
      safeToDeleteRunRoot: true,
    });
    expect(connectCore).toHaveBeenCalledWith({
      nodexHome,
      clientKind: "native_cli",
      buildId: "nodex-isolated-run-supervisor",
      requestTimeoutMs: 5_000,
    });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
  });

  test("retains the lease when runtime evidence has no host claim", async () => {
    const nodexHome = createNodexHome();
    const lease = acquireLease(nodexHome);
    const connectCore = vi.fn();

    await expect(
      cleanupIsolatedCore({
        lease,
        nodexHome,
        runId: RUN_A,
        dependencies: cleanupDependencies({
          connectCore,
          inspectRuntimeEvidence: vi.fn<IsolatedCoreCleanupDependencies["inspectRuntimeEvidence"]>(
            () => "partial",
          ),
          readClaim: vi.fn(() => null),
        }),
      }),
    ).resolves.toMatchObject({
      status: "not_owner",
      safeToDeleteRunRoot: false,
    });
    expect(connectCore).not.toHaveBeenCalled();
    expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
    lease.release();
  });

  test("retains the lease when a replacement generation appears", async () => {
    const nodexHome = createNodexHome();
    const lease = acquireLease(nodexHome);
    publishIsolatedRunClaim({
      nodexHome,
      runId: RUN_A,
      hostPid: process.pid,
    });
    const replacement = { ...GENERATION, start_nonce: "d".repeat(32) };

    await expect(
      cleanupIsolatedCore({
        lease,
        nodexHome,
        runId: RUN_A,
        dependencies: cleanupDependencies({
          inspectRuntimeEvidence: vi.fn<IsolatedCoreCleanupDependencies["inspectRuntimeEvidence"]>(
            () => "complete",
          ),
          isPidAlive: vi.fn(() => true),
          readRuntimeGeneration: vi.fn(() => replacement),
        }),
      }),
    ).resolves.toMatchObject({
      status: "generation_changed",
      safeToDeleteRunRoot: false,
    });
    expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
    lease.release();
  });

  test("retains the lease when graceful shutdown times out", async () => {
    const nodexHome = createNodexHome();
    const lease = acquireLease(nodexHome);
    publishIsolatedRunClaim({
      nodexHome,
      runId: RUN_A,
      hostPid: process.pid,
    });
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(10);

    await expect(
      cleanupIsolatedCore({
        lease,
        nodexHome,
        runId: RUN_A,
        shutdownTimeoutMs: 5,
        dependencies: cleanupDependencies({
          inspectRuntimeEvidence: vi
            .fn()
            .mockReturnValueOnce("complete")
            .mockReturnValueOnce("partial"),
          isPidAlive: vi.fn(() => true),
          now,
        }),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      safeToDeleteRunRoot: false,
      reason: "Timed out waiting for isolated Core to exit",
    });
    expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
    lease.release();
  });

  test("acquires the lease before spawn and preserves the caller idle timeout", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;
    let observedOptions: SpawnOptions | undefined;
    const prepare = vi.fn(
      async (context: { readonly environment: NodeJS.ProcessEnv; readonly runId: string }) => {
        expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
        expect(context.runId).toBe(RUN_A);
        expect(context.environment.NODEX_INTERNAL_ISOLATED_RUN_ID).toBe(RUN_A);
      },
    );
    const spawnChild = vi.fn(
      (_command: string, _args: readonly string[], options: SpawnOptions) => {
        expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
        observedOptions = options;
        queueMicrotask(() => child.close(0));
        return child.asChildProcess();
      },
    );

    await expect(
      runSupervisor({
        environment: {
          [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "0",
          NODEX_CORE_IDLE_TIMEOUT_MS: "65432",
          NODEX_HOME: nodexHome,
        },
        nodexHome,
        repositoryRoot: path.resolve("."),
        command: { command: "pnpm", args: ["exec", "electron-vite", "dev"] },
        prepare,
        dependencies: {
          cleanupDependencies: cleanupDependencies({
            readClaim: vi.fn(() => null),
          }),
          delay: vi.fn(async () => undefined),
          forceExit: vi.fn(),
          generateRunId: () => RUN_A,
          isProcessGroupAlive: vi.fn(() => false),
          now: vi.fn(() => 0),
          signalSource,
          signalProcessGroup: vi.fn(),
          spawnChild,
        },
      }),
    ).resolves.toEqual({
      childExitCode: 0,
      cleanupStatus: "not_started",
      safeToDeleteRunRoot: true,
    });
    expect(spawnChild).toHaveBeenCalledWith(
      "pnpm",
      ["exec", "electron-vite", "dev"],
      expect.objectContaining({
        detached: true,
        shell: false,
        stdio: "inherit",
      }),
    );
    expect(observedOptions?.env).toMatchObject({
      [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "0",
      NODEX_CORE_IDLE_TIMEOUT_MS: "65432",
      NODEX_INTERNAL_ISOLATED_RUN_ID: RUN_A,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
  });

  test("preserves SIGINT status while allowing cleanup to finish", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;
    const signalProcessGroup = vi.fn();

    const resultPromise = runSupervisor({
      environment: { NODEX_HOME: nodexHome },
      nodexHome,
      repositoryRoot: path.resolve("."),
      command: { command: "pnpm", args: ["exec", "electron-vite", "dev"] },
      dependencies: {
        cleanupDependencies: cleanupDependencies({
          readClaim: vi.fn(() => null),
        }),
        delay: vi.fn(async () => undefined),
        forceExit: vi.fn(),
        generateRunId: () => RUN_A,
        isProcessGroupAlive: vi.fn(() => false),
        now: vi.fn(() => 0),
        signalSource,
        signalProcessGroup,
        spawnChild: () => {
          queueMicrotask(() => {
            (signalSource as unknown as EventEmitter).emit("SIGINT");
            // pnpm and terminal process groups can forward the same interrupt.
            (signalSource as unknown as EventEmitter).emit("SIGINT");
            child.close(0);
          });
          return child.asChildProcess();
        },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      childExitCode: 130,
      cleanupStatus: "not_started",
    });
    expect(signalProcessGroup).toHaveBeenCalledWith(4321, "SIGINT");
    expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
  });

  test("abandons cleanup and preserves the lease after a distinct second signal", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;
    const signalProcessGroup = vi.fn();
    const forceExit = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(500);

    const resultPromise = runSupervisor({
      environment: { NODEX_HOME: nodexHome },
      nodexHome,
      repositoryRoot: path.resolve("."),
      command: { command: "pnpm", args: ["exec", "electron-vite", "dev"] },
      dependencies: {
        cleanupDependencies: cleanupDependencies({
          readClaim: vi.fn(() => null),
        }),
        delay: vi.fn(async () => undefined),
        forceExit,
        generateRunId: () => RUN_A,
        isProcessGroupAlive: vi.fn(() => false),
        now,
        signalSource,
        signalProcessGroup,
        spawnChild: () => {
          queueMicrotask(() => {
            const emitter = signalSource as unknown as EventEmitter;
            emitter.emit("SIGINT");
            emitter.emit("SIGTERM");
            child.close(0);
          });
          return child.asChildProcess();
        },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      childExitCode: 130,
      safeToDeleteRunRoot: false,
    });
    expect(forceExit).toHaveBeenCalledWith(143);
    expect(signalProcessGroup).toHaveBeenCalledWith(4321, "SIGINT");
    expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
    expect((signalSource as unknown as EventEmitter).listenerCount("SIGINT")).toBe(0);
    expect((signalSource as unknown as EventEmitter).listenerCount("SIGTERM")).toBe(0);
  });

  test("terminates remaining application descendants after a normal child exit", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;
    const signalProcessGroup = vi.fn();
    const isProcessGroupAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    await expect(
      runSupervisor({
        environment: { NODEX_HOME: nodexHome },
        nodexHome,
        repositoryRoot: path.resolve("."),
        command: { command: "pnpm", args: ["exec", "electron-vite", "dev"] },
        dependencies: {
          cleanupDependencies: cleanupDependencies({
            readClaim: vi.fn(() => null),
          }),
          delay: vi.fn(async () => undefined),
          forceExit: vi.fn(),
          generateRunId: () => RUN_A,
          isProcessGroupAlive,
          now: vi.fn(() => 0),
          signalSource,
          signalProcessGroup,
          spawnChild: () => {
            queueMicrotask(() => child.close(0));
            return child.asChildProcess();
          },
        },
      }),
    ).resolves.toEqual({
      childExitCode: 0,
      cleanupStatus: "not_started",
      safeToDeleteRunRoot: true,
    });
    expect(signalProcessGroup).toHaveBeenCalledOnce();
    expect(signalProcessGroup).toHaveBeenCalledWith(4321, "SIGTERM");
  });

  test("retains the lease when the foreground process group cannot be terminated", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;
    const signalProcessGroup = vi.fn();
    let clock = 0;

    const resultPromise = runSupervisor({
      environment: { NODEX_HOME: nodexHome },
      nodexHome,
      repositoryRoot: path.resolve("."),
      command: { command: "pnpm", args: ["exec", "electron-vite", "dev"] },
      dependencies: {
        cleanupDependencies: cleanupDependencies({
          readClaim: vi.fn(() => null),
        }),
        delay: vi.fn(async () => undefined),
        forceExit: vi.fn(),
        generateRunId: () => RUN_A,
        isProcessGroupAlive: vi.fn(() => true),
        now: vi.fn(() => {
          const observed = clock;
          clock += 2_000;
          return observed;
        }),
        signalSource,
        signalProcessGroup,
        spawnChild: () => {
          queueMicrotask(() => {
            (signalSource as unknown as EventEmitter).emit("SIGINT");
            child.close(0);
          });
          return child.asChildProcess();
        },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      childExitCode: 130,
      cleanupStatus: "not_started",
      safeToDeleteRunRoot: false,
    });
    expect(signalProcessGroup.mock.calls).toEqual([
      [4321, "SIGINT"],
      [4321, "SIGTERM"],
      [4321, "SIGKILL"],
    ]);
    expect(readIsolatedRunLeaseOwner(nodexHome)?.runId).toBe(RUN_A);
  });

  test("retains a child failure while still performing no-Core cleanup", async () => {
    const nodexHome = createNodexHome();
    const child = new FakeChild();
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;

    await expect(
      runSupervisor({
        environment: { NODEX_HOME: nodexHome },
        nodexHome,
        repositoryRoot: path.resolve("."),
        command: { command: "pnpm", args: ["exec", "electron", "."] },
        dependencies: {
          cleanupDependencies: cleanupDependencies({
            readClaim: vi.fn(() => null),
          }),
          delay: vi.fn(async () => undefined),
          forceExit: vi.fn(),
          generateRunId: () => RUN_A,
          isProcessGroupAlive: vi.fn(() => false),
          now: vi.fn(() => 0),
          signalSource,
          signalProcessGroup: vi.fn(),
          spawnChild: () => {
            queueMicrotask(() => child.close(7));
            return child.asChildProcess();
          },
        },
      }),
    ).resolves.toMatchObject({
      childExitCode: 7,
      cleanupStatus: "not_started",
    });
    expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
  });

  test("releases signal listeners and leases across repeated lifecycles", async () => {
    const signalSource = new EventEmitter() as unknown as SupervisorSignalSource;

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const nodexHome = createNodexHome();
      const child = new FakeChild();
      await runSupervisor({
        environment: { NODEX_HOME: nodexHome },
        nodexHome,
        repositoryRoot: path.resolve("."),
        command: { command: "pnpm", args: ["exec", "electron", "."] },
        dependencies: {
          cleanupDependencies: cleanupDependencies({ readClaim: vi.fn(() => null) }),
          delay: vi.fn(async () => undefined),
          forceExit: vi.fn(),
          generateRunId: () => `${RUN_A.slice(0, -2)}${String(iteration).padStart(2, "0")}`,
          isProcessGroupAlive: vi.fn(() => false),
          now: vi.fn(() => iteration),
          signalSource,
          signalProcessGroup: vi.fn(),
          spawnChild: () => {
            queueMicrotask(() => child.close(0));
            return child.asChildProcess();
          },
        },
      });

      expect(readIsolatedRunLeaseOwner(nodexHome)).toBeNull();
      expect((signalSource as unknown as EventEmitter).listenerCount("SIGINT")).toBe(0);
      expect((signalSource as unknown as EventEmitter).listenerCount("SIGTERM")).toBe(0);
    }
  });
});
