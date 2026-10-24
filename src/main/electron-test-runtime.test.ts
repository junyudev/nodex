import { describe, expect, test } from "vite-plus/test";
import packageJson from "../../package.json";

describe("main test runtime", () => {
  test("uses the pinned Electron and Node runtimes", () => {
    expect(process.versions.electron).toBe(packageJson.devDependencies.electron);
    expect(process.versions.node).toBe("24.22.0");
    expect(process.versions.modules).toBe("149");
  });
});
