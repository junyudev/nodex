import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
  acquireIsolatedRunLease,
  publishIsolatedRunClaim,
  readIsolatedRunLeaseOwner,
  type IsolatedRunLease,
} from "./isolated-run-ownership";
import { connectOrStartCore } from "./core-launcher";
import { cleanupIsolatedCore } from "../../../scripts/isolated-run-supervisor";

const CORE_BINARY = requiredNativeExecutable("core-server");
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
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

      expect(existsSync(path.join(nodexHome, "run/core/core.sock"))).toBe(false);
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
      if (existsSync(path.join(nodexHome, "run/core/core.sock"))) {
        await launched.client.shutdown().catch(() => undefined);
        await waitUntil(
          () => !existsSync(path.join(nodexHome, "run/core/core.sock")),
          "Core socket remained during integration-test cleanup",
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
        () => !existsSync(path.join(nodexHome, "run/core/core.sock")),
        "Core socket remained during non-owner test cleanup",
      ).catch(() => undefined);
      lease.release();
      rmSync(nodexHome, { recursive: true, force: true });
    }
  });
});
