import { describe, expect, test } from "vite-plus/test";
import { verifyNodeRuntime } from "./verify-node-runtime.mts";

const policy = { pinned: "24.22.1", engines: ">=24.22.1 <25" };

describe("host Node admission", () => {
  test.each(["24.22.1", "v24.22.1", "24.22.2", "24.23.0"])(
    "accepts compatible patched runtime %s",
    (actual) => expect(() => verifyNodeRuntime({ ...policy, actual })).not.toThrow(),
  );

  test.each(["24.15.0", "24.21.0", "24.22.0", "22.23.4", "25.0.0", "26.12.1"])(
    "rejects unsupported host runtime %s",
    (actual) => expect(() => verifyNodeRuntime({ ...policy, actual })).toThrow(/does not satisfy/u),
  );

  test.each(["24.22.1-rc.1", "24", "24.22", "24.022.1", "24.22.1+custom"])(
    "does not treat %s as a verified stable release",
    (actual) => expect(() => verifyNodeRuntime({ ...policy, actual })).toThrow(/exact Node/u),
  );

  test("requires CI to run the exact pin", () => {
    expect(() => verifyNodeRuntime({ ...policy, actual: "24.22.1", exact: true })).not.toThrow();
    expect(() => verifyNodeRuntime({ ...policy, actual: "24.23.0", exact: true })).toThrow(
      /does not satisfy/u,
    );
  });

  test("rejects drifting or missing engine declarations", () => {
    for (const engines of [">=24.15.0 <25", ">=24.22.1", undefined, {}]) {
      expect(() => verifyNodeRuntime({ ...policy, engines, actual: "24.22.1" })).toThrow(
        /engines.node/u,
      );
    }
  });

  test("does not certify an embedded Electron runtime as host Node", () => {
    expect(() => verifyNodeRuntime({ ...policy, actual: "24.22.1", electron: "44.4.4" })).toThrow(
      /audited separately/u,
    );
  });

  test("moves the supported floor with a future contributor pin", () => {
    const future = { pinned: "24.23.2", engines: ">=24.23.2 <25" };
    expect(() => verifyNodeRuntime({ ...future, actual: "24.23.2" })).not.toThrow();
    expect(() => verifyNodeRuntime({ ...future, actual: "24.22.1" })).toThrow();
  });
});
