import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  acquireIsolatedRunLease,
  isolatedRunLeaseDirectory,
  markIsolatedRunClaimReady,
  publishIsolatedRunClaim,
  readIsolatedRunClaim,
  readIsolatedRunLeaseOwner,
  resolveIsolatedRunBootstrapAccess,
} from "./isolated-run-ownership";

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
    expect(
      lstatSync(path.join(isolatedRunLeaseDirectory(nodexHome), "host-claim.json")).mode & 0o777,
    ).toBe(0o600);
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
