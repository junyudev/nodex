import { describe, expect, test } from "vite-plus/test";

describe("main test runtime", () => {
  test("uses the pinned Electron and Node runtimes", () => {
    expect(process.versions.electron).toBe("44.2.0");
    expect(process.versions.node).toBe("24.20.0");
    expect(process.versions.modules).toBe("149");
  });
});
