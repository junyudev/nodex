import { describe, expect, it } from "vite-plus/test";

import { cliArchiveTarCommand } from "./cliRelease.ts";

describe("provider archive extraction", () => {
  it("uses the native Windows archive extractor and PATH tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });
});
