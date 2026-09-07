import { expect, test } from "vite-plus/test";
import { validateWorkspaceArchiveEntries } from "./materialize-workspace-runtime";

test("rejects archive members that can escape or ambiguously address the staging root", () => {
  expect(() =>
    validateWorkspaceArchiveEntries(["python/bin/python3.13", "python/lib/"]),
  ).not.toThrow();
  for (const member of [
    "/etc/file",
    "../file",
    "python/../../file",
    "python\\file",
    "python//file",
    "python/./file",
  ]) {
    expect(() => validateWorkspaceArchiveEntries([member])).toThrow(
      "Invalid workspace archive path",
    );
  }
});
